package opencode.semantic;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * verify_test：把命令原样透传给 shell，捕获合并输出，薄解析常见测试框架。
 *
 * 冻结协议：参数非法（缺/空 command、负 timeout_ms 等）RPC -32603；cwd 命中保护列表
 * RPC -32013（先于存在性判断）；cwd 不存在 RPC -32001。其余情况均为 RPC 成功响应，
 * 字段：command / exit_code / duration_ms / summary / failures / output_head / output_tail /
 * parsed / framework（+ timeout、total_failures 按需出现）。
 * 只读执行：不写任何项目文件（测试进程自身产生的缓存目录除外）。
 */
final class VerifyTestService {
  private static final long DEFAULT_TIMEOUT_MS = 300_000L;
  /** output_head / output_tail 各保留 100 行；总行数 <= 100 时 tail 为空串。 */
  private static final int OUTPUT_LINES = 100;
  private static final int MAX_FAILURES = 20;
  /** 捕获上限（行）：极长输出只保留末尾，保证解析用的 footer/失败列表仍在。 */
  private static final int MAX_CAPTURE_LINES = 50_000;

  JsonObject verifyTest(String basePath, JsonObject params) throws JsonRpcServer.RpcException {
    String command = requireCommand(params);
    JsonObject options = readOptions(params);
    long timeoutMs = readTimeout(options);
    Map<String, String> env = readEnv(options);
    Path cwd = resolveCwd(basePath, options);
    return execute(command, cwd, timeoutMs, env);
  }

  // ---- 参数 ----

  private static String requireCommand(JsonObject params) throws JsonRpcServer.RpcException {
    JsonElement element = params.get("command");
    if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
      throw invalidParams("command");
    }
    String command = element.getAsString();
    if (command.isBlank()) throw invalidParams("command");
    return command;
  }

  private static JsonObject readOptions(JsonObject params) throws JsonRpcServer.RpcException {
    JsonElement element = params.get("options");
    if (element == null) return new JsonObject();
    if (!element.isJsonObject()) throw invalidParams("options");
    return element.getAsJsonObject();
  }

  private static long readTimeout(JsonObject options) throws JsonRpcServer.RpcException {
    JsonElement element = options.get("timeout_ms");
    if (element == null) return DEFAULT_TIMEOUT_MS;
    if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber()) {
      throw invalidParams("options.timeout_ms");
    }
    double value = element.getAsDouble();
    if (!Double.isFinite(value) || value < 0 || value != Math.floor(value) || value > Long.MAX_VALUE) {
      throw invalidParams("options.timeout_ms");
    }
    return (long) value;
  }

  private static Map<String, String> readEnv(JsonObject options) throws JsonRpcServer.RpcException {
    JsonElement element = options.get("env");
    if (element == null) return Map.of();
    if (!element.isJsonObject()) throw invalidParams("options.env");
    Map<String, String> env = new LinkedHashMap<>();
    for (Map.Entry<String, JsonElement> entry : element.getAsJsonObject().entrySet()) {
      JsonElement value = entry.getValue();
      if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
        throw invalidParams("options.env." + entry.getKey());
      }
      env.put(entry.getKey(), value.getAsString());
    }
    return env;
  }

  /** cwd 缺省项目根；保护检查先于存在性（与 edit_batch 同一套保护段/后缀）。 */
  private static Path resolveCwd(String basePath, JsonObject options) throws JsonRpcServer.RpcException {
    JsonElement element = options.get("cwd");
    if (element != null && (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString())) {
      throw invalidParams("options.cwd");
    }
    String raw = element == null ? "" : element.getAsString();
    Path base = Paths.get(basePath).toAbsolutePath().normalize();
    Path resolved;
    if (raw.isBlank()) {
      resolved = base;
    } else {
      Path candidate = Paths.get(raw);
      resolved = (candidate.isAbsolute() ? candidate : base.resolve(candidate)).normalize();
    }
    String reason = EditBatchService.protectReason(basePath, resolved);
    if (reason != null) {
      Log.info("verify_test rejected cwd=" + raw + " code=-32013 (protected '" + reason + "')");
      JsonObject data = new JsonObject();
      data.addProperty("cwd", raw);
      data.addProperty("reason", reason);
      throw new JsonRpcServer.RpcException(-32013, "cwd protected", data);
    }
    if (!Files.isDirectory(resolved)) {
      Log.info("verify_test rejected cwd=" + resolved + " code=-32001 (not a directory)");
      throw new JsonRpcServer.RpcException(-32001, "cwd not found", null);
    }
    return resolved;
  }

  private static JsonRpcServer.RpcException invalidParams(String name) {
    return new JsonRpcServer.RpcException(-32603, "invalid params: " + name, null);
  }

  // ---- 执行 ----

  private JsonObject execute(String command, Path cwd, long timeoutMs, Map<String, String> env)
      throws JsonRpcServer.RpcException {
    Shell shell = shellCommand(command);
    Log.info("verify_test command=" + command + " cwd=" + cwd + " timeout=" + timeoutMs
        + "ms shell=" + shell.argv.get(0) + (shell.stdinScript ? " (-s stdin)" : " (-c)"));
    ProcessBuilder builder = new ProcessBuilder(shell.argv);
    builder.directory(cwd.toFile());
    builder.redirectErrorStream(true);
    if (!env.isEmpty()) builder.environment().putAll(env);

    long startedAt = System.nanoTime();
    Process process;
    try {
      process = builder.start();
    } catch (IOException e) {
      Log.error("verify_test failed to start shell " + shell.argv.get(0), e);
      throw new JsonRpcServer.RpcException(-32603, "internal error", null);
    }
    try (OutputStream stdin = process.getOutputStream()) {
      if (shell.stdinScript) stdin.write(command.getBytes(StandardCharsets.UTF_8));
    } catch (IOException ignored) {
      // shell 提前退出时写 stdin 失败，交给 exit_code/输出体现
    }

    Captured captured = new Captured();
    Thread reader =
        new Thread(() -> captured.read(process.getInputStream()), "semantic-verify-test-output");
    reader.setDaemon(true);
    reader.start();

    boolean timedOut = false;
    try {
      // timeout_ms=0 视为不限时；waitFor 的 0 毫秒语义是“立即返回 false”，不能直接下传
      if (timeoutMs > 0) {
        if (!process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
          timedOut = true;
          killTree(process);
        }
      } else {
        process.waitFor();
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      timedOut = true;
      killTree(process);
    }
    try {
      reader.join(2000);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }

    long durationMs = (System.nanoTime() - startedAt) / 1_000_000L;
    List<String> lines = captured.lines();
    Log.info("verify_test done exit=" + (timedOut ? -1 : process.exitValue()) + " duration="
        + durationMs + "ms lines=" + lines.size() + " timeout=" + timedOut);
    return result(command, timedOut ? -1 : process.exitValue(), lines, durationMs, timedOut);
  }

  /**
   * SEMANTIC_SHELL 可覆盖（按 -c 传命令）；Windows 优先 Git bash、找不到降级 cmd；POSIX 用 /bin/sh。
   * Windows 的 Git bash 走 `-s` 由 stdin 送脚本：JVM 经 Windows 命令行把含内嵌双引号的
   * `-c` 参数交给 msys2 时引号会被吞掉（最小 Java 程序可复现），stdin 传字节则与命令原文一致。
   */
  private static final class Shell {
    final List<String> argv;
    final boolean stdinScript;

    Shell(List<String> argv, boolean stdinScript) {
      this.argv = argv;
      this.stdinScript = stdinScript;
    }
  }

  private static Shell shellCommand(String command) {
    String override = System.getenv("SEMANTIC_SHELL");
    if (override != null && !override.isBlank()) {
      return new Shell(List.of(override, "-c", command), false);
    }
    if (File.separatorChar == '\\') {
      Path bash = findWindowsBash();
      if (bash != null) return new Shell(List.of(bash.toString(), "-s"), true);
      return new Shell(List.of("cmd.exe", "/d", "/s", "/c", command), false);
    }
    return new Shell(List.of("/bin/sh", "-c", command), false);
  }

  private static Path findWindowsBash() {
    List<String> candidates = new ArrayList<>();
    for (String dir :
        new String[] {
          System.getenv("ProgramFiles"),
          System.getenv("ProgramFiles(x86)"),
          System.getenv("ProgramW6432"),
          System.getenv("LOCALAPPDATA") == null
              ? null
              : System.getenv("LOCALAPPDATA") + "\\Programs"
        }) {
      if (dir == null || dir.isBlank()) continue;
      candidates.add(dir + "\\Git\\bin\\bash.exe");
      candidates.add(dir + "\\Git\\usr\\bin\\bash.exe");
    }
    String path = System.getenv("PATH");
    if (path != null) {
      for (String entry : path.split(";")) {
        if (entry.isBlank()) continue;
        candidates.add(entry + "\\bash.exe");
      }
    }
    for (String candidate : candidates) {
      try {
        Path file = Paths.get(candidate);
        if (Files.isRegularFile(file)) return file;
      } catch (RuntimeException ignored) {
        // 非法 PATH 项直接跳过
      }
    }
    return null;
  }

  /** 杀进程树：先后代再根，等待回收，避免 shell 被杀后子进程残留。 */
  private static void killTree(Process process) {
    process.descendants().forEach(ProcessHandle::destroyForcibly);
    process.destroyForcibly();
    try {
      process.waitFor(5, TimeUnit.SECONDS);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
  }

  /** stdout+stderr 合并读取；超上限时丢弃最旧的行（footer/失败列表在末尾，优先保留）。 */
  private static final class Captured {
    private final ArrayDeque<String> lines = new ArrayDeque<>();

    void read(InputStream stream) {
      try (BufferedReader reader =
          new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
        String line;
        while ((line = reader.readLine()) != null) {
          synchronized (this) {
            lines.addLast(line);
            if (lines.size() > MAX_CAPTURE_LINES) lines.pollFirst();
          }
        }
      } catch (IOException ignored) {
        // 进程被杀或管道提前关闭属正常路径
      }
    }

    synchronized List<String> lines() {
      List<String> result = new ArrayList<>(lines);
      while (!result.isEmpty() && result.get(result.size() - 1).isEmpty()) {
        result.remove(result.size() - 1);
      }
      return result;
    }
  }

  // ---- 结果 ----

  private static JsonObject result(
      String command, int exitCode, List<String> lines, long durationMs, boolean timedOut) {
    Parsed parsed = timedOut ? null : parse(lines);
    JsonObject result = new JsonObject();
    result.addProperty("command", command);
    result.addProperty("exit_code", exitCode);
    result.addProperty("duration_ms", durationMs);
    if (parsed == null) {
      result.add("summary", JsonNull.INSTANCE);
      result.add("failures", new JsonArray());
    } else {
      result.add(
          "summary",
          parsed.counts ? summary(parsed.passed, parsed.failed, parsed.skipped) : JsonNull.INSTANCE);
      JsonArray failures = new JsonArray();
      for (int i = 0; i < Math.min(parsed.failures.size(), MAX_FAILURES); i++) {
        failures.add(parsed.failures.get(i));
      }
      result.add("failures", failures);
    }
    String[] output = outputWindow(lines);
    result.addProperty("output_head", output[0]);
    result.addProperty("output_tail", output[1]);
    result.addProperty("parsed", parsed != null);
    if (parsed == null) result.add("framework", JsonNull.INSTANCE);
    else result.addProperty("framework", parsed.framework);
    if (timedOut) result.addProperty("timeout", true);
    if (parsed != null && parsed.failures.size() > MAX_FAILURES) {
      result.addProperty("total_failures", parsed.failures.size());
    }
    return result;
  }

  /** 总行 <= 100：head=全文、tail=""；否则 head=前 100 行、tail=后 100 行（中段省略）。 */
  private static String[] outputWindow(List<String> lines) {
    if (lines.size() <= OUTPUT_LINES) {
      return new String[] {String.join("\n", lines), ""};
    }
    String head = String.join("\n", lines.subList(0, OUTPUT_LINES));
    String tail = String.join("\n", lines.subList(lines.size() - OUTPUT_LINES, lines.size()));
    return new String[] {head, tail};
  }

  private static JsonObject summary(int passed, int failed, int skipped) {
    JsonObject summary = new JsonObject();
    summary.addProperty("passed", passed);
    summary.addProperty("failed", failed);
    summary.addProperty("skipped", skipped);
    summary.addProperty("total", passed + failed + skipped);
    return summary;
  }

  // ---- 薄解析（顺序：pytest → jest/vitest → go → cargo → mocha，命中即停） ----

  private static final class Parsed {
    final String framework;
    /** false = 该框架拿不到可靠计数（go），summary 返回 null（parsed 仍 true）。 */
    final boolean counts;
    final int passed;
    final int failed;
    final int skipped;
    final List<JsonObject> failures = new ArrayList<>();

    Parsed(String framework, boolean counts, int passed, int failed, int skipped) {
      this.framework = framework;
      this.counts = counts;
      this.passed = passed;
      this.failed = failed;
      this.skipped = skipped;
    }
  }

  private static Parsed parse(List<String> lines) {
    Parsed parsed = parsePytest(lines);
    if (parsed != null) return parsed;
    parsed = parseJest(lines);
    if (parsed != null) return parsed;
    parsed = parseGo(lines);
    if (parsed != null) return parsed;
    parsed = parseCargo(lines);
    if (parsed != null) return parsed;
    return parseMocha(lines);
  }

  private static final Pattern PYTEST_FOOTER =
      Pattern.compile("^=+.*\\b(?:passed|failed|errors?|skipped|xfailed|xpassed|no tests ran)\\b.*=+$");
  private static final Pattern PYTEST_COUNT =
      Pattern.compile("(\\d+) (passed|failed|errors?|skipped|xfailed|xpassed)");
  private static final Pattern PYTEST_ITEM = Pattern.compile("^(?:FAILED|ERROR) (.+?)(?: - (.*))?$");
  private static final Pattern PYTEST_BLOCK = Pattern.compile("^_{3,} (.+?) _{3,}$");
  private static final Pattern PYTEST_LOCATION = Pattern.compile("^(.+):(\\d+): (.+)$");

  private static Parsed parsePytest(List<String> lines) {
    String footer = null;
    for (String line : lines) {
      if (PYTEST_FOOTER.matcher(line).matches()) footer = line;
    }
    if (footer == null) return null;

    int passed = 0;
    int failed = 0;
    int skipped = 0;
    Matcher counts = PYTEST_COUNT.matcher(footer);
    while (counts.find()) {
      int value = Integer.parseInt(counts.group(1));
      String kind = counts.group(2);
      if (kind.startsWith("passed") || kind.startsWith("xpassed")) passed += value;
      else if (kind.startsWith("xfailed") || kind.startsWith("skipped")) skipped += value;
      else failed += value; // failed / error(s)
    }

    // 失败块头 "____ test_bad ____"，块内最后一条 "path:line: message" 关联该测试
    Map<String, String[]> tracebacks = new HashMap<>();
    String block = null;
    for (String line : lines) {
      Matcher header = PYTEST_BLOCK.matcher(line);
      if (header.matches()) {
        block = lastSegment(header.group(1));
        continue;
      }
      if (block == null) continue;
      Matcher location = PYTEST_LOCATION.matcher(line);
      if (location.matches()) {
        tracebacks.put(block, new String[] {location.group(1), location.group(2), location.group(3)});
      }
    }

    Parsed parsed = new Parsed("pytest", true, passed, failed, skipped);
    for (String line : lines) {
      Matcher item = PYTEST_ITEM.matcher(line);
      if (!item.matches()) continue;
      String test = item.group(1).trim();
      JsonObject failure = new JsonObject();
      failure.addProperty("test", test);
      int separator = test.indexOf("::");
      if (separator > 0) failure.addProperty("file", test.substring(0, separator));
      String[] traceback = tracebacks.get(lastSegment(test));
      if (traceback != null) {
        if (!failure.has("file")) failure.addProperty("file", traceback[0].replace('\\', '/'));
        failure.addProperty("line", Integer.parseInt(traceback[1]));
      }
      String message = item.group(2);
      if (message == null || message.isBlank()) message = traceback == null ? null : traceback[2];
      if (message != null && !message.isBlank()) failure.addProperty("message", message);
      parsed.failures.add(failure);
    }
    return parsed;
  }

  private static final Pattern JEST_SUMMARY =
      Pattern.compile("^Tests:?\\s+.*\\d+\\s+(?:passed|failed|skipped|todo|pending|total).*$");
  private static final Pattern JEST_COUNT =
      Pattern.compile("(\\d+)\\s+(passed|failed|skipped|todo|pending)");
  private static final Pattern JEST_FAILURE = Pattern.compile("^\\s*[✕×]\\s+(.+)$");

  private static Parsed parseJest(List<String> lines) {
    String footer = null;
    for (String line : lines) {
      if (JEST_SUMMARY.matcher(line).matches()) footer = line;
    }
    if (footer == null) return null;
    int passed = 0;
    int failed = 0;
    int skipped = 0;
    Matcher counts = JEST_COUNT.matcher(footer);
    while (counts.find()) {
      int value = Integer.parseInt(counts.group(1));
      switch (counts.group(2)) {
        case "passed" -> passed += value;
        case "failed" -> failed += value;
        default -> skipped += value;
      }
    }
    Parsed parsed = new Parsed(footer.startsWith("Tests:") ? "jest" : "vitest", true, passed, failed, skipped);
    for (String line : lines) {
      Matcher failure = JEST_FAILURE.matcher(line);
      if (!failure.matches()) continue;
      JsonObject entry = new JsonObject();
      entry.addProperty("test", failure.group(1).trim());
      parsed.failures.add(entry);
    }
    return parsed;
  }

  private static final Pattern GO_FAILURE = Pattern.compile("^--- FAIL: (\\S+)");
  private static final Pattern GO_RESULT = Pattern.compile("^(?:ok|FAIL)\\s+\\S+.*");

  private static Parsed parseGo(List<String> lines) {
    boolean detected = false;
    Parsed parsed = new Parsed("go", false, 0, 0, 0);
    for (String line : lines) {
      if (line.startsWith("--- FAIL: ")) {
        detected = true;
        Matcher failure = GO_FAILURE.matcher(line);
        if (failure.find()) {
          JsonObject entry = new JsonObject();
          entry.addProperty("test", failure.group(1));
          parsed.failures.add(entry);
        }
      } else if (GO_RESULT.matcher(line).matches()) {
        detected = true;
      }
    }
    return detected ? parsed : null;
  }

  private static final Pattern CARGO_RESULT =
      Pattern.compile("^test result: (?:ok|FAILED)\\.\\s*(\\d+) passed;\\s*(\\d+) failed;\\s*(\\d+) ignored");
  private static final Pattern CARGO_FAILURE = Pattern.compile("^test (\\S+) \\.\\.\\. FAILED$");

  private static Parsed parseCargo(List<String> lines) {
    boolean detected = false;
    int passed = 0;
    int failed = 0;
    int ignored = 0;
    List<JsonObject> failures = new ArrayList<>();
    for (String line : lines) {
      Matcher result = CARGO_RESULT.matcher(line);
      if (result.find()) {
        detected = true;
        passed += Integer.parseInt(result.group(1));
        failed += Integer.parseInt(result.group(2));
        ignored += Integer.parseInt(result.group(3));
        continue;
      }
      Matcher failure = CARGO_FAILURE.matcher(line);
      if (failure.matches()) {
        detected = true;
        JsonObject entry = new JsonObject();
        entry.addProperty("test", failure.group(1));
        failures.add(entry);
      }
    }
    if (!detected) return null;
    Parsed parsed = new Parsed("cargo", true, passed, failed, ignored);
    parsed.failures.addAll(failures);
    return parsed;
  }

  private static final Pattern MOCHA_COUNT =
      Pattern.compile("^\\s*(\\d+) (passing|failing|pending)\\b");
  private static final Pattern MOCHA_FAILURE = Pattern.compile("^\\s*\\d+\\) (.+)$");

  private static Parsed parseMocha(List<String> lines) {
    boolean detected = false;
    int passed = 0;
    int failed = 0;
    int pending = 0;
    List<JsonObject> failures = new ArrayList<>();
    for (String line : lines) {
      Matcher count = MOCHA_COUNT.matcher(line);
      if (count.find()) {
        detected = true;
        int value = Integer.parseInt(count.group(1));
        switch (count.group(2)) {
          case "passing" -> passed += value;
          case "failing" -> failed += value;
          default -> pending += value;
        }
        continue;
      }
      Matcher failure = MOCHA_FAILURE.matcher(line);
      if (failure.matches()) {
        JsonObject entry = new JsonObject();
        entry.addProperty("test", failure.group(1).trim());
        failures.add(entry);
      }
    }
    if (!detected) return null;
    Parsed parsed = new Parsed("mocha", true, passed, failed, pending);
    parsed.failures.addAll(failures);
    return parsed;
  }

  /** 取 :: 之后的末段、再取 . 之后的末段（类方法头 TestClass.test 与 node id 对齐）。 */
  private static String lastSegment(String name) {
    String segment = name.trim();
    int scope = segment.lastIndexOf("::");
    if (scope >= 0) segment = segment.substring(scope + 2);
    int dot = segment.lastIndexOf('.');
    if (dot >= 0) segment = segment.substring(dot + 1);
    return segment.trim();
  }
}
