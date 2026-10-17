package opencode.semantic;

import java.io.IOException;
import java.net.URISyntaxException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 可执行入口，支持冻结接口的 CLI 形式：
 *   java -Djava.awt.headless=true -jar semantic-server.jar <project_path> <locator_path> [--idle-seconds N]
 *
 * 平台无法从单个插件 jar 内部引导，因此 Launcher 负责：
 *   1. 定位本机 JetBrains IDE，优先级（冻结）：
 *      SEMANTIC_IDE_HOME > IDEA_HOME > IDEA_DIR > SEMANTIC_IDE(路径) > SEMANTIC_IDE(选择器) > 自动发现。
 *      发现源：Windows 卸载表注册项、Toolbox apps + scripts 垫片、常见安装目录
 *      （C:\Program Files\JetBrains\* 等）、macOS /Applications、Linux Toolbox。
 *      每个候选都必须通过 product-info.json（productCode/buildNumber）+ lib 校验；
 *      只回答"装在哪"，不读取任何授权状态。
 *   2. 把自身作为插件安装到按项目 + 发行版隔离的 sandbox：
 *      ~/.opencode-semantic/sandbox-<sha1-10(canonical project)>-<productCode><platformMajor>
 *      （如 -IU262 / -PY261，避免不同平台版本混用 system 缓存）；SEMANTIC_SANDBOX 覆盖优先。
 *   3. 用该 IDE 自带 JBR 拉起 com.intellij.idea.Main semantic-server <project> <locator>。
 */
public final class Launcher {
  private static final String ENV_IDE = "SEMANTIC_IDE";
  private static final String ENV_IDE_HOME = "SEMANTIC_IDE_HOME";
  private static final String ENV_SANDBOX = "SEMANTIC_SANDBOX";
  private static final String ENV_SANDBOX_PATH = "SEMANTIC_SANDBOX_PATH";

  private static final Pattern PRODUCT_CODE = Pattern.compile("\"productCode\"\\s*:\\s*\"([^\"]+)\"");
  private static final Pattern BUILD_NUMBER = Pattern.compile("\"buildNumber\"\\s*:\\s*\"([^\"]+)\"");
  private static final Pattern PRODUCT_VERSION = Pattern.compile("\"version\"\\s*:\\s*\"([^\"]+)\"");
  private static final Pattern PRODUCT_NAME = Pattern.compile("\"name\"\\s*:\\s*\"([^\"]+)\"");
  private static final Pattern DATA_DIRECTORY_NAME = Pattern.compile("\"dataDirectoryName\"\\s*:\\s*\"([^\"]+)\"");
  private static final Pattern PLATFORM_MAJOR = Pattern.compile("^(\\d+)");
  private static final Pattern REG_DISPLAY_NAME = Pattern.compile("^DisplayName\\s+REG_SZ\\s+(.*)$");
  private static final Pattern REG_INSTALL_LOCATION = Pattern.compile("^InstallLocation\\s+REG_SZ\\s+(.*)$");
  private static final Pattern DISPLAY_NAME_PRODUCT =
      Pattern.compile(
          "^(?:JetBrains )?(?:IntelliJ IDEA|PyCharm|WebStorm|CLion|GoLand|DataGrip|PhpStorm|RubyMine|Rider|Android Studio)");
  private static final Pattern WINDOWS_PATH = Pattern.compile("[A-Za-z]:\\\\[^\"'\\r\\n]+");

  /** SEMANTIC_IDE 选择器 → 产品码偏好序（冻结）。 */
  private static final Map<String, List<String>> SELECTORS =
      Map.ofEntries(
          Map.entry("idea", List.of("IU", "IC")),
          Map.entry("pycharm", List.of("PY", "PC")),
          Map.entry("webstorm", List.of("WS")),
          Map.entry("clion", List.of("CL")),
          Map.entry("goland", List.of("GO")),
          Map.entry("phpstorm", List.of("PS")),
          Map.entry("datagrip", List.of("DG")),
          Map.entry("rider", List.of("RD")),
          Map.entry("rubymine", List.of("RM")));

  /** 自动选择全局偏好序（JS/TS/HTML: IU>WS；Python: PY>PC；Java: IU）。 */
  private static final List<String> PREFERENCE =
      List.of("IU", "PY", "WS", "PC", "IC", "CL", "GO", "PS", "DG", "RD", "RM");

  /** 信号语言类别（固定顺序，保证日志与决策确定性）。 */
  private static final List<String> SIGNAL_LANGUAGES = List.of("java", "python", "javascript", "html");
  /** tier-1 标准布局根：命中任一 → java（有界搜索时跳过隐藏与排除目录）。 */
  private static final List<String> SIGNAL_LAYOUTS = List.of("src/main/java", "src/test/java", "src/main/kotlin");
  /** tier-1/tier-2 扫描共用的排除默认目录（与守护侧 Exclusions.DEFAULTS 一致；此处不复用其类，避免拉 gson 依赖）。 */
  private static final Set<String> SIGNAL_EXCLUDED_DIRS =
      Set.of("venv", "node_modules", "build", "out", "target", "__pycache__", "dist");
  private static final int SIGNAL_ENTRY_CAP = 5000;
  private static final int SIGNAL_DEPTH_CAP = 4;

  private Launcher() {}

  public static void main(String[] args) throws IOException, InterruptedException, URISyntaxException {
    List<String> argv = new ArrayList<>(List.of(args));
    if (argv.isEmpty()) {
      System.err.println("usage: java -jar semantic-server.jar <project_path> <locator_path> [--idle-seconds N]");
      System.err.println("IDE: " + ENV_IDE_HOME + " > IDEA_HOME > IDEA_DIR > " + ENV_IDE + " (path|selector) > auto");
      System.exit(2);
    }

    Path project = Path.of(argv.get(0)).toAbsolutePath().normalize();
    Candidate ide = selectIde(project);
    Path ideaDir = ide.home();

    Path javaExe = ideaDir.resolve("jbr/bin/java.exe");
    if (!Files.isExecutable(javaExe)) javaExe = ideaDir.resolve("jbr/bin/java");
    if (!Files.isExecutable(javaExe)) {
      System.err.println("[semantic-launcher] ERROR: no JBR found at " + ideaDir.resolve("jbr"));
      System.exit(2);
    }

    Path defaultSandbox = defaultSandbox(project, ide);
    String override = blankToNull(System.getenv(ENV_SANDBOX));
    Path sandbox = override == null ? defaultSandbox : Path.of(override).toAbsolutePath().normalize();
    System.err.println(
        "[semantic-launcher] sandbox="
            + sandbox
            + (override == null ? "" : " (" + ENV_SANDBOX + " override; default=" + defaultSandbox + ")"));

    Path pluginLib = sandbox.resolve("plugins/semantic-server/lib");
    Files.createDirectories(pluginLib);
    Path self = Path.of(Launcher.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    Path installed = pluginLib.resolve("semantic-server.jar");
    if (!Files.exists(installed) || Files.size(installed) != Files.size(self)) {
      Files.copy(self, installed, StandardCopyOption.REPLACE_EXISTING);
    }
    ensureJdkTable(sandbox);

    List<String> command = new ArrayList<>();
    command.add(javaExe.toString());
    command.add("-Djava.awt.headless=true");
    command.add("-Didea.home.path=" + ideaDir);
    command.add("-Didea.config.path=" + sandbox.resolve("config"));
    command.add("-Didea.system.path=" + sandbox.resolve("system"));
    command.add("-Didea.plugins.path=" + sandbox.resolve("plugins"));
    command.add("-Didea.log.path=" + sandbox.resolve("log"));
    command.add("-Didea.vendor.name=JetBrains");
    command.add("-Didea.paths.selector=" + pathsSelector(ide));
    command.add("-Dintellij.platform.runtime.repository.path=" + ideaDir.resolve("modules/module-descriptors.dat"));
    command.add("-Xbootclasspath/a:" + ideaDir.resolve("lib/nio-fs.jar"));
    command.add("-Djava.system.class.loader=com.intellij.util.lang.PathClassLoader");
    command.add("-Djava.nio.file.spi.DefaultFileSystemProvider=com.intellij.platform.core.nio.fs.MultiRoutingFileSystemProvider");
    command.add("-Djna.boot.library.path=" + ideaDir.resolve("lib/jna/amd64"));
    command.add("-Djna.nosys=true");
    command.add("-Djna.noclasspath=true");
    command.add("-Dpty4j.preferred.native.folder=" + ideaDir.resolve("lib/pty4j"));
    command.add("-XX:+IgnoreUnrecognizedVMOptions");
    command.add("-Xmx2048m");
    command.add("--enable-native-access=ALL-UNNAMED");
    for (String opens :
        List.of(
            "java.base/java.io", "java.base/java.lang", "java.base/java.lang.ref", "java.base/java.lang.reflect",
            "java.base/java.net", "java.base/java.nio", "java.base/java.nio.charset", "java.base/java.text",
            "java.base/java.time", "java.base/java.util", "java.base/java.util.concurrent",
            "java.base/java.util.concurrent.atomic", "java.base/java.util.concurrent.locks", "java.base/jdk.internal.ref",
            "java.base/jdk.internal.vm", "java.base/sun.net.dns", "java.base/sun.nio", "java.base/sun.nio.ch",
            "java.base/sun.nio.fs", "java.base/sun.security.ssl", "java.base/sun.security.util",
            "java.desktop/com.sun.java.swing", "java.desktop/java.awt", "java.desktop/java.awt.dnd.peer",
            "java.desktop/java.awt.event", "java.desktop/java.awt.font", "java.desktop/java.awt.image",
            "java.desktop/java.awt.peer", "java.desktop/javax.swing", "java.desktop/javax.swing.plaf.basic",
            "java.desktop/javax.swing.text", "java.desktop/javax.swing.text.html", "java.desktop/javax.swing.text.html.parser",
            "java.desktop/sun.awt", "java.desktop/sun.awt.datatransfer", "java.desktop/sun.awt.image",
            "java.desktop/sun.awt.windows", "java.desktop/sun.font", "java.desktop/sun.java2d", "java.desktop/sun.swing",
            "java.desktop/sun.swing.text", "java.management/sun.management", "jdk.attach/sun.tools.attach",
            "jdk.compiler/com.sun.tools.javac.api", "jdk.internal.jvmstat/sun.jvmstat.monitor", "jdk.jdi/com.sun.tools.jdi")) {
      command.add("--add-opens=" + opens + "=ALL-UNNAMED");
    }
    command.add("-cp");
    command.add(ideaDir.resolve("lib").toString() + "/*");
    command.add("com.intellij.idea.Main");
    command.add("semantic-server");
    command.addAll(argv);

    System.err.println("[semantic-launcher] " + ideaDir.resolve("jbr") + " -> semantic-server " + argv);
    ProcessBuilder builder = new ProcessBuilder(command);
    builder.inheritIO();
    // 子进程据此定位 exclusions.json（与平台 sandbox 同目录）
    builder.environment().put(ENV_SANDBOX_PATH, sandbox.toString());
    Process process = builder.start();
    System.exit(process.waitFor());
  }

  // ---- IDE 选择（冻结优先级；所有候选经 product-info.json + lib 校验） ----

  private static Candidate selectIde(Path project) {
    for (String env : List.of(ENV_IDE_HOME, "IDEA_HOME", "IDEA_DIR")) {
      String value = blankToNull(System.getenv(env));
      if (value == null) continue;
      Candidate candidate = readCandidate(Path.of(value), env);
      if (candidate == null) fail("invalid IDE path from " + env + " (need product-info.json + lib): " + value);
      System.err.println("[semantic-launcher] selected: " + candidate.label() + " reason=explicit path (" + env + ")");
      return candidate;
    }

    String ideValue = blankToNull(System.getenv(ENV_IDE));
    if (ideValue != null && isPathLike(ideValue)) {
      Candidate candidate = readCandidate(Path.of(ideValue), ENV_IDE);
      if (candidate == null) fail("invalid IDE path from " + ENV_IDE + ": " + ideValue);
      System.err.println("[semantic-launcher] selected: " + candidate.label() + " reason=" + ENV_IDE + " path");
      return candidate;
    }

    List<Candidate> candidates = discover();
    if (candidates.isEmpty()) {
      fail("no JetBrains IDE found (registry/toolbox/common paths); install one or set " + ENV_IDE_HOME);
    }
    logCandidates(candidates);

    if (ideValue != null && !ideValue.equalsIgnoreCase("auto")) {
      List<String> codes = SELECTORS.get(ideValue.toLowerCase(Locale.ROOT));
      if (codes == null) {
        fail("unknown " + ENV_IDE + " value '" + ideValue + "'; valid: auto|" + String.join("|", SELECTORS.keySet()) + "|path");
      }
      Candidate candidate = selectByCodes(candidates, codes);
      if (candidate == null) {
        fail("requested IDE '" + ideValue + "' (" + String.join("/", codes) + ") not found; candidates:\n" + candidateLines(candidates));
      }
      System.err.println("[semantic-launcher] selected: " + candidate.label() + " reason=" + ENV_IDE + "=" + ideValue);
      return candidate;
    }

    Candidate candidate = selectAuto(candidates, project);
    System.err.println("[semantic-launcher] selected: " + candidate.label() + " reason=auto");
    return candidate;
  }

  /** 显式选择器：产品码匹配，按选择器给出的偏好序取第一个。 */
  private static Candidate selectByCodes(List<Candidate> candidates, List<String> codes) {
    for (String code : codes) {
      for (Candidate candidate : candidates) {
        if (candidate.productCode().equalsIgnoreCase(code)) return candidate;
      }
    }
    return null;
  }

  /** 自动选择：tier-1 决定性信号优先 → 否则 tier-2 文件计数取主导语言 → 发行版能力（plugins/ 目录）→ 覆盖数 + 偏好序。 */
  private static Candidate selectAuto(List<Candidate> candidates, Path project) {
    ProjectSignals signals = scanProjectSignals(project);
    boolean decisive = !signals.tier1().isEmpty();
    List<String> needed =
        decisive ? orderedLanguages(signals.tier1().keySet()) : dominantLanguages(signals.counts());
    Candidate best = null;
    for (Candidate candidate : candidates) {
      if (best == null) {
        best = candidate;
        continue;
      }
      int score = coverage(candidate, needed);
      int bestScore = coverage(best, needed);
      if (score > bestScore || (score == bestScore && rank(candidate) < rank(best))) best = candidate;
    }
    int score = coverage(best, needed);
    String reason = decisive ? "tier-1 evidence" : needed.isEmpty() ? "no signals (preference order)" : "dominant counts";
    System.err.println(
        "[semantic-launcher] auto: tier1="
            + tier1Log(signals.tier1())
            + " counts="
            + signals.counts()
            + " needed="
            + needed
            + " -> "
            + best.productCode()
            + " covers "
            + score
            + "/"
            + needed.size()
            + " (reason="
            + reason
            + ")");
    if (score < needed.size()) {
      System.err.println(
          "[semantic-launcher] WARN: no single distribution covers all detected languages; using preference order (set semantic.ide to override)");
    }
    return best;
  }

  /** 项目信号证据：tier-1 决定性命中（语言 → 证据文件/目录集合）+ tier-2 扩展名计数（语言 → 文件数）。 */
  private record ProjectSignals(Map<String, Set<String>> tier1, Map<String, Integer> counts) {}

  /** 分层信号扫描（有界：跳过隐藏与排除默认目录，深度 ≤4，条目上限 5000）：
   *  tier-1 命中标准布局根 / `JAVA_MODULE` iml / 构建清单文件；tier-2 按扩展名计数补充证据。 */
  private static ProjectSignals scanProjectSignals(Path root) {
    Map<String, Set<String>> tier1 = new TreeMap<>();
    Map<String, Integer> counts = new TreeMap<>();
    scanModuleIml(root, tier1);
    Deque<Path> dirs = new ArrayDeque<>();
    Deque<Integer> depths = new ArrayDeque<>();
    dirs.add(root);
    depths.add(0);
    int entries = 0;
    while (!dirs.isEmpty() && entries < SIGNAL_ENTRY_CAP) {
      Path dir = dirs.poll();
      int depth = depths.poll();
      for (String layout : SIGNAL_LAYOUTS) {
        Path layoutRoot = dir.resolve(layout);
        if (Files.isDirectory(layoutRoot)) addTier1(tier1, "java", relative(root, layoutRoot));
      }
      try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
        for (Path entry : stream) {
          if (entries >= SIGNAL_ENTRY_CAP) break;
          entries++;
          String name = entry.getFileName().toString();
          if (name.startsWith(".")) continue;
          if (Files.isDirectory(entry)) {
            if (depth < SIGNAL_DEPTH_CAP && !SIGNAL_EXCLUDED_DIRS.contains(name.toLowerCase(Locale.ROOT))) {
              dirs.add(entry);
              depths.add(depth + 1);
            }
            continue;
          }
          String lower = name.toLowerCase(Locale.ROOT);
          countExtension(counts, lower);
          String language = tier1Marker(lower);
          if (language != null) addTier1(tier1, language, relative(root, entry));
        }
      } catch (IOException ignored) {
        // 不可读目录跳过
      }
    }
    return new ProjectSignals(tier1, counts);
  }

  /** 根 `*.iml` 与 `.idea/*.iml`：模块类型 JAVA_MODULE → java（不可读按无信号处理）。 */
  private static void scanModuleIml(Path root, Map<String, Set<String>> tier1) {
    List<Path> candidates = new ArrayList<>();
    for (Path dir : List.of(root, root.resolve(".idea"))) {
      try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir, "*.iml")) {
        for (Path entry : stream) {
          if (Files.isRegularFile(entry)) candidates.add(entry);
        }
      } catch (IOException ignored) {
        // 目录不存在/不可读
      }
    }
    for (Path iml : candidates) {
      try {
        if (Files.readString(iml, StandardCharsets.UTF_8).contains("JAVA_MODULE")) {
          addTier1(tier1, "java", relative(root, iml));
        }
      } catch (IOException ignored) {
        // 不可读 iml 跳过
      }
    }
  }

  /** tier-1 决定性标记文件（构建/模块清单）；`*.html` 不在此列（弱信号，不单独决定）。 */
  private static String tier1Marker(String name) {
    if (name.equals("pom.xml") || name.startsWith("build.gradle") || name.startsWith("settings.gradle")) return "java";
    if (name.equals("pyproject.toml") || name.equals("setup.py")
        || (name.startsWith("requirements") && name.endsWith(".txt"))) {
      return "python";
    }
    if (name.equals("package.json") || name.equals("tsconfig.json")) return "javascript";
    return null;
  }

  private static void countExtension(Map<String, Integer> counts, String name) {
    String language;
    if (name.endsWith(".java")) language = "java";
    else if (name.endsWith(".py")) language = "python";
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) language = "typescript";
    else if (name.endsWith(".js") || name.endsWith(".jsx")) language = "javascript";
    else if (name.endsWith(".html") || name.endsWith(".htm")) language = "html";
    else return;
    counts.merge(language, 1, Integer::sum);
  }

  private static void addTier1(Map<String, Set<String>> tier1, String language, String evidence) {
    tier1.computeIfAbsent(language, key -> new TreeSet<>()).add(evidence);
  }

  /** 语言类别固定顺序过滤（用于日志与决策的确定性）。 */
  private static List<String> orderedLanguages(Set<String> languages) {
    List<String> ordered = new ArrayList<>();
    for (String language : SIGNAL_LANGUAGES) {
      if (languages.contains(language)) ordered.add(language);
    }
    return ordered;
  }

  /** tier-2 回退：按合并计数取主导语言（.ts/.tsx 并入 javascript；平票按类别顺序全部纳入）。 */
  private static List<String> dominantLanguages(Map<String, Integer> counts) {
    int java = counts.getOrDefault("java", 0);
    int python = counts.getOrDefault("python", 0);
    int javascript = counts.getOrDefault("typescript", 0) + counts.getOrDefault("javascript", 0);
    int html = counts.getOrDefault("html", 0);
    int max = Math.max(Math.max(java, python), Math.max(javascript, html));
    if (max == 0) return List.of();
    List<String> dominant = new ArrayList<>();
    if (java == max) dominant.add("java");
    if (python == max) dominant.add("python");
    if (javascript == max) dominant.add("javascript");
    if (html == max) dominant.add("html");
    return dominant;
  }

  /** 日志用 tier-1 摘要：每语言最多列 3 条证据，其余折叠计数。 */
  private static String tier1Log(Map<String, Set<String>> tier1) {
    if (tier1.isEmpty()) return "[]";
    StringBuilder builder = new StringBuilder("[");
    boolean first = true;
    for (Map.Entry<String, Set<String>> entry : tier1.entrySet()) {
      if (!first) builder.append(", ");
      first = false;
      List<String> evidence = new ArrayList<>(entry.getValue());
      builder.append(entry.getKey()).append(": ");
      builder.append(String.join(", ", evidence.subList(0, Math.min(3, evidence.size()))));
      if (evidence.size() > 3) builder.append(" (+").append(evidence.size() - 3).append(" more)");
    }
    return builder.append(']').toString();
  }

  private static String relative(Path root, Path path) {
    if (path.equals(root)) return ".";
    return root.relativize(path).toString().replace('\\', '/');
  }

  private static int coverage(Candidate candidate, List<String> needed) {
    int covered = 0;
    for (String language : needed) {
      if (supports(candidate, language)) covered++;
    }
    return covered;
  }

  private static boolean supports(Candidate candidate, String language) {
    switch (language) {
      case "java":
        return hasPluginDir(candidate, "java", false);
      case "python":
        return hasPluginDir(candidate, "python", true);
      case "javascript":
        return hasPluginDir(candidate, "javascript-plugin", false);
      case "html":
        return hasPluginDir(candidate, "html-tools", false) || hasPluginDir(candidate, "javascript-plugin", false);
      default:
        return true;
    }
  }

  private static boolean hasPluginDir(Candidate candidate, String name, boolean allowPrefix) {
    Path plugins = candidate.home().resolve("plugins");
    if (!Files.isDirectory(plugins)) return false;
    try (DirectoryStream<Path> stream = Files.newDirectoryStream(plugins)) {
      for (Path entry : stream) {
        String entryName = entry.getFileName().toString().toLowerCase(Locale.ROOT);
        if (entryName.equals(name) || (allowPrefix && entryName.startsWith(name))) return true;
      }
    } catch (IOException ignored) {
      return false;
    }
    return false;
  }

  private static int rank(Candidate candidate) {
    int index = PREFERENCE.indexOf(candidate.productCode());
    return index < 0 ? PREFERENCE.size() : index;
  }

  // ---- 多源发现 ----

  private static List<Candidate> discover() {
    List<Raw> raw = new ArrayList<>();
    if (isWindows()) {
      raw.addAll(fromRegistry());
      raw.addAll(fromToolbox());
      raw.addAll(fromWindowsCommon());
    } else if (isMac()) {
      raw.addAll(fromMacApplications());
    } else {
      raw.addAll(fromLinuxToolbox());
    }
    Map<String, Candidate> unique = new LinkedHashMap<>();
    for (Raw entry : raw) {
      Candidate candidate = readCandidate(entry.path(), entry.source());
      if (candidate == null) continue;
      unique.putIfAbsent(canonicalKey(candidate.home()), candidate);
    }
    return new ArrayList<>(unique.values());
  }

  /** Windows 卸载表（HKLM + HKCU Uninstall）：DisplayName 匹配产品族 → InstallLocation。本机实测的主可靠源。 */
  private static List<Raw> fromRegistry() {
    List<Raw> found = new ArrayList<>();
    for (String hive :
        List.of(
            "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
            "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall")) {
      String output = runCommand(List.of("reg", "query", hive, "/s"));
      if (output == null) continue;
      parseUninstallBlocks(output, found);
    }
    return found;
  }

  private static void parseUninstallBlocks(String output, List<Raw> found) {
    String displayName = null;
    String installLocation = null;
    for (String line : output.split("\\R")) {
      String trimmed = line.trim();
      if (trimmed.startsWith("HKEY_")) {
        addRegistryCandidate(displayName, installLocation, found);
        displayName = null;
        installLocation = null;
        continue;
      }
      if (displayName == null) {
        Matcher matcher = REG_DISPLAY_NAME.matcher(trimmed);
        if (matcher.matches()) displayName = matcher.group(1).trim();
      }
      if (installLocation == null) {
        Matcher matcher = REG_INSTALL_LOCATION.matcher(trimmed);
        if (matcher.matches()) installLocation = matcher.group(1).trim();
      }
    }
    addRegistryCandidate(displayName, installLocation, found);
  }

  private static void addRegistryCandidate(String displayName, String installLocation, List<Raw> found) {
    if (displayName == null || installLocation == null || installLocation.isBlank()) return;
    if (!DISPLAY_NAME_PRODUCT.matcher(displayName).find()) return;
    found.add(new Raw(Path.of(installLocation), "registry"));
  }

  /** Toolbox：%LOCALAPPDATA%\JetBrains\Toolbox\apps\*\*\ 与 scripts\*.cmd 垫片（垫片只作路径提示）。 */
  private static List<Raw> fromToolbox() {
    List<Raw> found = new ArrayList<>();
    String localAppData = System.getenv("LOCALAPPDATA");
    if (localAppData == null) return found;
    Path toolbox = Path.of(localAppData, "JetBrains", "Toolbox");
    scanToolboxApps(toolbox.resolve("apps"), found);
    Path scripts = toolbox.resolve("scripts");
    if (Files.isDirectory(scripts)) {
      try (DirectoryStream<Path> stream = Files.newDirectoryStream(scripts, "*.cmd")) {
        for (Path shim : stream) {
          for (Path path : pathsFromShim(shim)) found.add(new Raw(path, "toolbox-shim"));
        }
      } catch (IOException ignored) {
        // 垫片只是提示，失败不影响主发现
      }
    }
    return found;
  }

  private static void scanToolboxApps(Path apps, List<Raw> found) {
    if (!Files.isDirectory(apps)) return;
    for (Path product : children(apps)) {
      for (Path channel : children(product)) {
        for (Path build : children(channel)) {
          if (Files.isRegularFile(build.resolve("product-info.json")) && Files.isDirectory(build.resolve("lib"))) {
            found.add(new Raw(build, "toolbox"));
          }
        }
      }
    }
  }

  private static List<Path> pathsFromShim(Path shim) {
    List<Path> paths = new ArrayList<>();
    try {
      Matcher matcher = WINDOWS_PATH.matcher(Files.readString(shim, consoleCharset()));
      while (matcher.find()) {
        String raw = matcher.group().trim();
        if (raw.contains("%")) continue;
        Path path = Path.of(raw);
        // 垫片常指向 <home>\bin\xxx.exe：把自身与最多两层父目录都作为候选（后续统一校验）
        for (int i = 0; i < 3 && path != null; i++, path = path.getParent()) {
          if (!paths.contains(path)) paths.add(path);
        }
      }
    } catch (Throwable ignored) {
      // 垫片只是提示
    }
    return paths;
  }

  private static List<Raw> fromWindowsCommon() {
    List<Raw> found = new ArrayList<>();
    for (String base : new String[] {System.getenv("ProgramFiles"), System.getenv("ProgramW6432")}) {
      if (base == null || base.isBlank()) continue;
      for (Path child : children(Path.of(base, "JetBrains"))) found.add(new Raw(child, "common-path"));
    }
    String localAppData = System.getenv("LOCALAPPDATA");
    if (localAppData != null) {
      for (Path child : children(Path.of(localAppData, "Programs", "JetBrains"))) found.add(new Raw(child, "common-path"));
    }
    return found;
  }

  private static List<Raw> fromMacApplications() {
    List<Raw> found = new ArrayList<>();
    String userHome = System.getProperty("user.home");
    for (Path root : userHome == null ? List.of(Path.of("/Applications")) : List.of(Path.of("/Applications"), Path.of(userHome, "Applications"))) {
      for (Path app : children(root)) {
        if (app.getFileName().toString().endsWith(".app")) found.add(new Raw(app, "applications"));
      }
    }
    return found;
  }

  private static List<Raw> fromLinuxToolbox() {
    List<Raw> found = new ArrayList<>();
    String userHome = System.getProperty("user.home");
    if (userHome == null) return found;
    scanToolboxApps(Path.of(userHome, ".local", "share", "JetBrains", "Toolbox", "apps"), found);
    return found;
  }

  /** 候选校验：product-info.json 可读且含 productCode/buildNumber，且 <dir>/lib 存在；.app 自动下探 Contents。 */
  private static Candidate readCandidate(Path dir, String source) {
    Path home = bundleHome(dir);
    if (home == null) {
      System.err.println("[semantic-launcher] reject " + dir + " (" + source + "): not an IDE home (product-info.json + lib)");
      return null;
    }
    try {
      String text = Files.readString(home.resolve("product-info.json"), StandardCharsets.UTF_8);
      Matcher codeMatcher = PRODUCT_CODE.matcher(text);
      Matcher buildMatcher = BUILD_NUMBER.matcher(text);
      if (!codeMatcher.find() || !buildMatcher.find()) {
        System.err.println("[semantic-launcher] reject " + dir + " (" + source + "): product-info.json missing productCode/buildNumber");
        return null;
      }
      return new Candidate(
          home,
          codeMatcher.group(1),
          buildMatcher.group(1),
          firstGroup(PRODUCT_VERSION, text),
          firstGroup(PRODUCT_NAME, text),
          firstGroup(DATA_DIRECTORY_NAME, text),
          source);
    } catch (IOException e) {
      System.err.println("[semantic-launcher] reject " + dir + " (" + source + "): product-info.json unreadable");
      return null;
    }
  }

  private static Path bundleHome(Path dir) {
    if (isProductHome(dir)) return dir;
    String name = dir.getFileName() == null ? "" : dir.getFileName().toString();
    if (name.endsWith(".app")) {
      Path contents = dir.resolve("Contents");
      if (isProductHome(contents)) return contents;
    }
    return null;
  }

  private static boolean isProductHome(Path dir) {
    return Files.isRegularFile(dir.resolve("product-info.json")) && Files.isDirectory(dir.resolve("lib"));
  }

  private static String firstGroup(Pattern pattern, String text) {
    Matcher matcher = pattern.matcher(text);
    return matcher.find() ? matcher.group(1) : null;
  }

  private static void logCandidates(List<Candidate> candidates) {
    System.err.println("[semantic-launcher] discovered " + candidates.size() + " candidate(s):");
    for (Candidate candidate : candidates) {
      System.err.println("[semantic-launcher]   - " + candidate.label());
    }
  }

  private static String candidateLines(List<Candidate> candidates) {
    StringBuilder builder = new StringBuilder();
    for (Candidate candidate : candidates) builder.append("  - ").append(candidate.label()).append('\n');
    return builder.toString().stripTrailing();
  }

  // ---- 通用工具 ----

  private static Path defaultSandbox(Path project, Candidate ide) {
    return Path.of(
        System.getProperty("user.home"),
        ".opencode-semantic",
        "sandbox-" + projectHash(project.toString()) + "-" + ide.sandboxSuffix());
  }

  /** exclusions.json 所在沙箱：优先 SEMANTIC_SANDBOX_PATH（Launcher 注入）；
   *  缺省仅剩 dev 直启场景（不经 Launcher），沿用旧命名 sandbox-<projectHash>（无产品后缀，仅作开发回退）。 */
  static Path exclusionsSandbox(String project) {
    String override = System.getenv(ENV_SANDBOX_PATH);
    if (override != null && !override.isBlank()) return Path.of(override).toAbsolutePath().normalize();
    return Path.of(System.getProperty("user.home"), ".opencode-semantic", "sandbox-" + projectHash(project));
  }

  /** 每个项目一个沙箱目录：SHA-1(canonical project path) 的前 10 个十六进制字符。
   *  canonical = toAbsolutePath().normalize()；Windows 下统一小写，保证盘符/大小写写法不同仍命中同一沙箱。 */
  static String projectHash(String project) {
    String canonical = Path.of(project).toAbsolutePath().normalize().toString();
    if (isWindows()) {
      canonical = canonical.toLowerCase(Locale.ROOT);
    }
    try {
      byte[] digest = MessageDigest.getInstance("SHA-1").digest(canonical.getBytes(StandardCharsets.UTF_8));
      StringBuilder hex = new StringBuilder(10);
      for (int i = 0; i < 5; i++) hex.append(String.format("%02x", digest[i] & 0xff));
      return hex.toString();
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-1 is unavailable", e);
    }
  }

  /** sample-project 的 .idea/misc.xml 引用 semantic-jdk，首次运行生成 jdk.table.xml。
   *  classPath 必须写具体 jrt roots（每个 jmod 一个），否则 headless 下 java.lang.* 无法解析。
   *  JDK 按 SEMANTIC_JDK_HOME > JAVA_HOME > 常见目录发现；无 jmods 时跳过（插件打开项目后会经 API 指派）。 */
  private static void ensureJdkTable(Path sandbox) throws IOException {
    Path jdkTable = sandbox.resolve("config/options/jdk.table.xml");
    if (Files.exists(jdkTable)) return;
    Path jdkDir = JdkDiscovery.home();
    if (jdkDir == null) {
      System.err.println(
          "[semantic-launcher] no JDK found (SEMANTIC_JDK_HOME/JAVA_HOME/common dirs); jdk.table.xml not generated");
      return;
    }
    if (!Files.isDirectory(jdkDir.resolve("jmods"))) {
      System.err.println("[semantic-launcher] JDK " + jdkDir + " has no jmods; jdk.table.xml not generated (plugin will assign the SDK after project open)");
      return;
    }
    Files.createDirectories(jdkTable.getParent());

    String version = JdkDiscovery.javaMajor(jdkDir);
    StringBuilder classPath = new StringBuilder();
    Path jmods = jdkDir.resolve("jmods");
    try (var stream = Files.list(jmods)) {
      for (Path jmod : stream.filter(p -> p.getFileName().toString().endsWith(".jmod")).sorted().toList()) {
        String name = jmod.getFileName().toString().replaceAll("\\.jmod$", "");
        classPath
            .append("            <root type=\"jrt\" url=\"jrt://")
            .append(jdkDir)
            .append("!/")
            .append(name)
            .append("\" />\n");
      }
    }

    Files.writeString(
        jdkTable,
        "<application>\n"
            + "  <component name=\"ProjectJdkTable\">\n"
            + "    <jdk version=\"2\">\n"
            + "      <name value=\"semantic-jdk\" />\n"
            + "      <type value=\"JavaSDK\" />\n"
            + "      <version value=\"java version &quot;"
            + (version == null ? "21" : version)
            + "&quot;\" />\n"
            + "      <homePath value=\""
            + jdkDir
            + "\" />\n"
            + "      <roots>\n"
            + "        <annotationsPath><root type=\"composite\" /></annotationsPath>\n"
            + "        <classPath>\n"
            + "          <root type=\"composite\">\n"
            + classPath
            + "          </root>\n"
            + "        </classPath>\n"
            + "        <javadocPath><root type=\"composite\" /></javadocPath>\n"
            + "        <sourcePath><root type=\"composite\" /></sourcePath>\n"
            + "      </roots>\n"
            + "      <additional />\n"
            + "    </jdk>\n"
            + "  </component>\n"
            + "</application>\n");
  }

  private static String pathsSelector(Candidate ide) {
    if (ide.dataDirectoryName() != null && !ide.dataDirectoryName().isBlank()) return ide.dataDirectoryName();
    String name = ide.name() == null ? "IntelliJIdea" : ide.name().replace(" ", "");
    return name + (ide.version() == null ? "" : ide.version());
  }

  private static String runCommand(List<String> command) {
    Path output = null;
    try {
      output = Files.createTempFile("semantic-reg", ".txt");
      Process process = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(output.toFile()).start();
      if (!process.waitFor(15, TimeUnit.SECONDS)) {
        process.destroyForcibly();
        return null;
      }
      return Files.readString(output, consoleCharset());
    } catch (Throwable t) {
      return null;
    } finally {
      if (output != null) {
        try {
          Files.deleteIfExists(output);
        } catch (IOException ignored) {
          // 临时文件清理失败无碍
        }
      }
    }
  }

  /** reg.exe 重定向输出使用系统 ANSI/OEM 代码页；sun.jnu.encoding 在 Windows 上即是该代码页。 */
  private static Charset consoleCharset() {
    try {
      return Charset.forName(System.getProperty("sun.jnu.encoding", "UTF-8"));
    } catch (Throwable t) {
      return Charset.defaultCharset();
    }
  }

  private static List<Path> children(Path parent) {
    if (!Files.isDirectory(parent)) return List.of();
    List<Path> result = new ArrayList<>();
    try (DirectoryStream<Path> stream = Files.newDirectoryStream(parent)) {
      for (Path entry : stream) {
        if (Files.isDirectory(entry)) result.add(entry);
      }
    } catch (IOException e) {
      return List.of();
    }
    result.sort(Comparator.comparing((Path path) -> path.getFileName().toString(), String.CASE_INSENSITIVE_ORDER));
    return result;
  }

  private static String canonicalKey(Path path) {
    Path normalized = path.toAbsolutePath().normalize();
    try {
      normalized = normalized.toRealPath();
    } catch (IOException ignored) {
      // 保存原始规范化路径
    }
    String key = normalized.toString();
    return isWindows() ? key.toLowerCase(Locale.ROOT) : key;
  }

  private static boolean isWindows() {
    return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
  }

  private static boolean isMac() {
    return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("mac");
  }

  private static boolean isPathLike(String value) {
    return value.indexOf('/') >= 0 || value.indexOf('\\') >= 0;
  }

  private static String blankToNull(String value) {
    return value == null || value.isBlank() ? null : value.trim();
  }

  private static void fail(String message) {
    System.err.println("[semantic-launcher] ERROR: " + message);
    System.exit(2);
  }

  private record Raw(Path path, String source) {}

  private record Candidate(
      Path home, String productCode, String buildNumber, String version, String name, String dataDirectoryName, String source) {
    String platformMajor() {
      Matcher matcher = PLATFORM_MAJOR.matcher(buildNumber);
      return matcher.find() ? matcher.group(1) : "0";
    }

    String sandboxSuffix() {
      return productCode + platformMajor();
    }

    String label() {
      return productCode + " " + buildNumber + " @ " + home + " via " + source;
    }
  }
}
