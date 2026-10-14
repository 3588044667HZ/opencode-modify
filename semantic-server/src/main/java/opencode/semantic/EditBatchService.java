package opencode.semantic;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.project.IndexNotReadyException;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.ThrowableComputable;
import com.intellij.openapi.vfs.VfsUtil;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.PsiDocumentManager;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * edit_batch：单文件多区域原子编辑（写路径基础设施首次落地）。
 *
 * 冻结协议处理顺序：参数校验（RPC -32603，含 options.lock_timeout_ms ≥ 1）→ 路径保护（-32013，
 * 先于存在性）→ 存在性（RPC -32001）→ 规范化绝对路径后获取文件互斥锁（公平队列，超时
 * lock_timeout_ms，缺省 30s；超时 -32017）→ 锁内：读内容+当前版本 → 版本戳校验（-32012）
 * → 纯度校验（-32014）→ 锚点唯一（-32010/-32011）→ 重叠拒绝（-32016）→ 从后往前内存应用
 * → 诊断 before 计数 → 原子写（同目录 <file>.tmp + fsync + ATOMIC_MOVE）→ VFS refresh +
 * Document 重载 → 诊断 after/增量与 line_changes → finally 释放锁。
 * 读内容与版本校验必须在锁内，否则校验与写入之间存在窗口期。
 * -32010..-32017 仍返回 JSON-RPC 成功响应，result.applied=false。
 */
final class EditBatchService {
  private static final int ANCHOR_NOT_FOUND = -32010;
  private static final int ANCHOR_NOT_UNIQUE = -32011;
  private static final int VERSION_MISMATCH = -32012;
  private static final int PATH_PROTECTED = -32013;
  private static final int CONTENT_IMPURE = -32014;
  private static final int WRITE_FAILED = -32015;
  private static final int CHANGE_CONFLICT = -32016;
  private static final int LOCK_TIMEOUT = -32017;
  private static final int JOURNAL_RECOVERY_FAILED = -32018;

  /** options.lock_timeout_ms 缺省值（spec：edit_batch 通常 <100ms，30s 意味着异常）。 */
  private static final long DEFAULT_LOCK_TIMEOUT_MS = 30_000L;

  /** 锁等待超过该时长记 WARN，便于诊断写者卡住/系统负载异常。 */
  private static final long LOCK_WAIT_WARN_MS = 1_000L;

  /** 文件锁表：key 为规范化绝对路径；锁保留在 map 中（避免频繁创建），进程退出即消失。edit_batch 与 edit_transaction 共享。 */
  static final ConcurrentHashMap<String, ReentrantLock> FILE_LOCKS = new ConcurrentHashMap<>();

  /**
   * 写路径执行门：无头环境下多个 manual highlight（ExternalToolPass 空等外部注解任务）与
   * VFS 写意图会形成平台锁环，每个等待者要空等 60s 超时才返回（线程 dump 实证）；因此把
   * 平台重段（读内容后的校验/写/refresh/诊断）在进程内串行执行。文件锁及其锁内校验语义
   * 不变（同文件仍按 FIFO 串行、权威版本校验仍在锁内）；此门只是规避平台并发缺陷。
   */
  static final ReentrantLock EXECUTION_GATE = new ReentrantLock(true);

  /** 与 resolvePath 同口径的锁 key（绝对路径规范化）；两个写服务共享同一文件锁命名空间。 */
  static String canonicalKey(Path path) {
    return path.toAbsolutePath().normalize().toString();
  }

  /** 取（或创建）某文件的公平互斥锁。 */
  static ReentrantLock fileLock(Path path) {
    return FILE_LOCKS.computeIfAbsent(canonicalKey(path), key -> new ReentrantLock(true));
  }

  /** spec 原文 hint（-32017 专属）。 */
  private static final String HINT_LOCK_TIMEOUT =
      "文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本";

  /** 保护段：任一路径段命中即拒绝（相对项目根计算，项目名本身不参与）。 */
  private static final Set<String> PROTECTED_SEGMENTS =
      Set.of(
          ".venv", "venv", "env", "node_modules", ".git",
          "dist", "build", "target", "out",
          "__pycache__", ".pytest_cache", ".mypy_cache");
  private static final List<String> PROTECTED_SUFFIXES = List.of(".lock", ".min.js", ".min.css");

  /** 源文件纯度：渲染层元语（[err: ...] / → def@... / L42 [...] / pos: L42）。 */
  private static final Pattern IMPURE_PATTERN = Pattern.compile("\\[err:|→ def@|L\\d+ \\[|pos: L\\d+");

  /** spec 原文 hint（-32011 专属）。 */
  private static final String HINT_ANCHOR_NOT_UNIQUE =
      "提供更多上下文使锚点唯一，或调用 map() 获取直接操作工具";

  JsonObject editBatch(Project project, String basePath, JsonObject params)
      throws JsonRpcServer.RpcException {
    // ⓪ 只读门（journal 恢复失败后写路径全部拒绝，读路径不受影响）
    if (WriteGate.isReadOnly()) {
      throw new JsonRpcServer.RpcException(
          JOURNAL_RECOVERY_FAILED, "journal recovery failed", WriteGate.errorData());
    }
    // ① 参数校验（缺失/类型错/空 changes/空 oldString/非法 options 一律 RPC -32603）
    String file = requireString(params, "file");
    String baseVersion = requireString(params, "baseVersion");
    List<Change> changes = readChanges(params);
    long lockTimeoutMs = readLockTimeoutMs(params);

    // ② 路径保护先于存在性检查
    Path path = ReadViewService.resolvePath(basePath, file);
    if (protectReason(basePath, path) != null) {
      Log.info("edit_batch rejected file=" + file + " code=" + PATH_PROTECTED + " (protected path)");
      JsonObject detail = new JsonObject();
      detail.addProperty("path", file);
      return failure(file, changes.size(), PATH_PROTECTED, "PATH_PROTECTED", detail,
          "保护路径默认禁止写入，如需修改请手工处理");
    }

    // ③ 文件不存在
    VirtualFile virtualFile = VfsUtil.findFileByIoFile(path.toFile(), true);
    if (virtualFile == null || !virtualFile.isValid()) {
      throw new JsonRpcServer.RpcException(-32001, "file not found", null);
    }

    // ④ 文件级互斥锁：key 与 resolvePath 同口径规范化（./x、x、反斜杠归一），公平队列 FIFO。
    // 锁只保护写路径后半段；读路径（read_view 等）不加锁。
    ReentrantLock lock = fileLock(path);
    if (lock.isLocked()) {
      Log.warn("edit_batch lock contended file=" + file + " waiting up to " + lockTimeoutMs + "ms");
    }
    long waitStarted = System.nanoTime();
    boolean acquired = false;
    try {
      acquired = lock.tryLock(lockTimeoutMs, TimeUnit.MILLISECONDS);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
    long waitedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - waitStarted);
    if (!acquired) {
      Log.warn("edit_batch rejected file=" + file + " code=" + LOCK_TIMEOUT
          + " waited_ms=" + waitedMs);
      JsonObject detail = new JsonObject();
      detail.addProperty("file", file);
      detail.addProperty("waited_ms", waitedMs);
      return failure(file, changes.size(), LOCK_TIMEOUT, "LOCK_TIMEOUT", detail, HINT_LOCK_TIMEOUT);
    }
    if (waitedMs > LOCK_WAIT_WARN_MS) {
      Log.warn("edit_batch lock acquired file=" + file + " waited_ms=" + waitedMs);
    }

    try {
      // ⑤ 锁内执行：读内容+版本 → 校验 → 应用 → 原子写 → refresh → 新版本+诊断
      EXECUTION_GATE.lock();
      try {
        return execute(project, path, virtualFile, file, changes, baseVersion);
      } finally {
        EXECUTION_GATE.unlock();
      }
    } catch (JsonRpcServer.RpcException e) {
      throw e;
    } catch (IndexNotReadyException e) {
      // 读过程中进入 dumb 模式的竞态：按协议返回 indexing，客户端稍后重试
      throw new JsonRpcServer.RpcException(-32000, "indexing", null);
    } catch (Throwable t) {
      Log.error("edit_batch failed", t);
      throw new JsonRpcServer.RpcException(-32603, "internal error", null);
    } finally {
      lock.unlock();
    }
  }

  private JsonObject execute(
      Project project, Path path, VirtualFile virtualFile, String file,
      List<Change> changes, String baseVersion)
      throws JsonRpcServer.RpcException {
    // ⑤ 读内容 + 当前版本（读前按 mtime 差异刷新 VFS，避免拿到陈旧 stamp；必须在锁内）
    refreshIfStale(virtualFile);
    String content = readContent(path);
    syncDocument(project, virtualFile, content);
    String oldVersion = ReadViewService.versionOf(virtualFile);

    // ⑥ 版本戳校验（锁内）
    if (!baseVersion.equals(oldVersion)) {
      Log.info("edit_batch rejected file=" + file + " code=" + VERSION_MISMATCH);
      JsonObject detail = new JsonObject();
      detail.addProperty("current_version", oldVersion);
      detail.addProperty("content", content);
      return failure(file, changes.size(), VERSION_MISMATCH, "VERSION_MISMATCH", detail,
          "文件已变化：用返回的 current_version 与 content 重新读取后再提交");
    }

    // ⑦ 纯度校验
    for (Change change : changes) {
      String marker = impureMarker(change.newString);
      if (marker != null) {
        Log.info("edit_batch rejected file=" + file + " code=" + CONTENT_IMPURE
            + " change=" + change.index);
        JsonObject detail = new JsonObject();
        detail.addProperty("change_index", change.index);
        detail.addProperty("marker", marker);
        return failure(file, changes.size(), CONTENT_IMPURE, "CONTENT_IMPURE", detail,
            "newString 含渲染层元语标记，请使用源文件原文");
      }
    }

    // ⑧ 锚点必须恰好出现一次
    for (Change change : changes) {
      List<Integer> matches = matchOffsets(content, change.oldString);
      if (matches.isEmpty()) {
        Log.info("edit_batch rejected file=" + file + " code=" + ANCHOR_NOT_FOUND
            + " change=" + change.index);
        JsonObject detail = new JsonObject();
        detail.addProperty("change_index", change.index);
        detail.addProperty("oldString", change.oldString);
        return failure(file, changes.size(), ANCHOR_NOT_FOUND, "ANCHOR_NOT_FOUND", detail,
            "锚点未找到：确认内容未被修改，或重新调用 read_view 获取最新版本后重试");
      }
      if (matches.size() > 1) {
        Log.info("edit_batch rejected file=" + file + " code=" + ANCHOR_NOT_UNIQUE
            + " change=" + change.index + " matches=" + matches.size());
        JsonObject detail = new JsonObject();
        detail.addProperty("change_index", change.index);
        detail.addProperty("oldString", change.oldString);
        detail.addProperty("match_count", matches.size());
        JsonArray locations = new JsonArray();
        for (int offset : matches) locations.add(lineAt(content, offset));
        detail.add("locations", locations);
        return failure(file, changes.size(), ANCHOR_NOT_UNIQUE, "ANCHOR_NOT_UNIQUE", detail,
            HINT_ANCHOR_NOT_UNIQUE);
      }
      change.start = matches.get(0);
      change.end = change.start + change.oldString.length();
    }

    // ⑨ 重叠检测（两个锚点区间相交即拒绝）
    for (int i = 0; i < changes.size(); i++) {
      for (int j = i + 1; j < changes.size(); j++) {
        Change earlier = changes.get(i);
        Change later = changes.get(j);
        if (earlier.start < later.end && later.start < earlier.end) {
          Log.info("edit_batch rejected file=" + file + " code=" + CHANGE_CONFLICT
              + " change=" + later.index + " conflict_with=" + earlier.index);
          JsonObject detail = new JsonObject();
          detail.addProperty("change_index", later.index);
          detail.addProperty("conflict_with_index", earlier.index);
          return failure(file, changes.size(), CHANGE_CONFLICT, "CHANGE_CONFLICT", detail,
              "两个 change 的锚点区间重叠，请合并为一个 change 或调整锚点范围");
        }
      }
    }

    // ⑩ 从后往前内存应用 + ⑪ 诊断 before 计数（此时盘上仍是旧内容）
    String newContent = applyChanges(content, changes);
    int[] before = ReadAction.computeBlocking(
        (ThrowableComputable<int[], RuntimeException>)
            () -> ReadViewService.diagnosticCounts(project, virtualFile));

    // ⑫ 原子写
    try {
      atomicWrite(path, newContent);
    } catch (IOException e) {
      Log.warn("edit_batch write failed: " + e);
      JsonObject detail = new JsonObject();
      detail.addProperty("reason", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
      return failure(file, changes.size(), WRITE_FAILED, "WRITE_FAILED", detail,
          "磁盘写入失败：检查文件权限、磁盘空间或文件占用后重试");
    }

    // ⑬ VFS refresh + Document 重载 + 新版本
    virtualFile.refresh(false, false);
    syncDocument(project, virtualFile, newContent);
    String newVersion = ReadViewService.versionOf(virtualFile);

    // ⑭ 诊断 after 与增量、line_changes
    int[] after = ReadAction.computeBlocking(
        (ThrowableComputable<int[], RuntimeException>)
            () -> ReadViewService.diagnosticCounts(project, virtualFile));
    Log.info("edit_batch applied file=" + file + " changes=" + changes.size()
        + " version=" + oldVersion + "->" + newVersion
        + " diagnostics=" + before[0] + "/" + before[1] + "->" + after[0] + "/" + after[1]);

    return success(file, changes.size(), oldVersion, newVersion, before, after, lineChanges(newContent, changes));
  }

  // ---- 参数 ----

  static final class Change {
    final int index;
    final String oldString;
    final String newString;
    int start = -1;
    int end = -1;
    int newStart = -1;

    Change(int index, String oldString, String newString) {
      this.index = index;
      this.oldString = oldString;
      this.newString = newString;
    }
  }

  static List<Change> readChanges(JsonObject params) throws JsonRpcServer.RpcException {
    JsonElement element = params.get("changes");
    if (element == null || !element.isJsonArray()) throw invalidParams("changes");
    JsonArray array = element.getAsJsonArray();
    if (array.isEmpty()) throw invalidParams("changes");
    List<Change> changes = new ArrayList<>();
    for (int i = 0; i < array.size(); i++) {
      JsonElement item = array.get(i);
      if (item == null || !item.isJsonObject()) throw invalidParams("changes[" + i + "]");
      JsonObject object = item.getAsJsonObject();
      String oldString = requireString(object, "oldString");
      if (oldString.isEmpty()) throw invalidParams("changes[" + i + "].oldString");
      String newString = requireString(object, "newString");
      JsonElement description = object.get("description");
      if (description != null
          && (!description.isJsonPrimitive() || !description.getAsJsonPrimitive().isString())) {
        throw invalidParams("changes[" + i + "].description");
      }
      changes.add(new Change(i, oldString, newString));
    }
    return changes;
  }

  /** options 可选；缺失取缺省 30s；出现时必须是 ≥1 的有限数值，否则 -32603。edit_batch 与 edit_transaction 共用。 */
  static long readLockTimeoutMs(JsonObject params) throws JsonRpcServer.RpcException {
    JsonElement options = params.get("options");
    if (options == null || options.isJsonNull()) return DEFAULT_LOCK_TIMEOUT_MS;
    if (!options.isJsonObject()) throw invalidParams("options");
    JsonElement element = options.getAsJsonObject().get("lock_timeout_ms");
    if (element == null || element.isJsonNull()) return DEFAULT_LOCK_TIMEOUT_MS;
    if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber()) {
      throw invalidParams("options.lock_timeout_ms");
    }
    double value = element.getAsDouble();
    if (!Double.isFinite(value) || value < 1) throw invalidParams("options.lock_timeout_ms");
    // 超大数值截到 long 上限，避免转换溢出
    return (long) Math.min(value, (double) Long.MAX_VALUE);
  }

  static String requireString(JsonObject params, String name) throws JsonRpcServer.RpcException {
    JsonElement element = params.get(name);
    if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
      throw invalidParams(name);
    }
    return element.getAsString();
  }

  static JsonRpcServer.RpcException invalidParams(String name) {
    return new JsonRpcServer.RpcException(-32603, "invalid params: " + name, null);
  }

  // ---- 路径保护 ----

  /** 包级共享（verify_test 的 cwd 复用同一套保护段/后缀）；返回命中的段或后缀，未命中 null。 */
  static String protectReason(String basePath, Path path) {
    Path relative = path;
    if (basePath != null) {
      Path root = Paths.get(basePath).toAbsolutePath().normalize();
      if (path.startsWith(root)) relative = root.relativize(path);
    }
    for (Path segment : relative) {
      if (PROTECTED_SEGMENTS.contains(segment.toString())) return segment.toString();
    }
    Path name = path.getFileName();
    if (name != null) {
      for (String suffix : PROTECTED_SUFFIXES) {
        if (name.toString().endsWith(suffix)) return suffix;
      }
    }
    return null;
  }

  // ---- 内容与匹配 ----

  /** 返回 newString 中命中的第一个渲染层元语，未命中 null（edit_batch/edit_transaction 共用）。 */
  static String impureMarker(String newString) {
    Matcher matcher = IMPURE_PATTERN.matcher(newString);
    return matcher.find() ? matcher.group() : null;
  }

  static String readContent(Path path) throws JsonRpcServer.RpcException {
    try {
      return Files.readString(path, StandardCharsets.UTF_8);
    } catch (IOException e) {
      Log.warn("edit_batch read failed: " + e);
      throw new JsonRpcServer.RpcException(-32603, "internal error", null);
    }
  }

  /** 非重叠匹配的全部起点（锚点唯一性判定用）。 */
  static List<Integer> matchOffsets(String content, String oldString) {
    List<Integer> offsets = new ArrayList<>();
    int from = 0;
    for (;;) {
      int index = content.indexOf(oldString, from);
      if (index < 0) return offsets;
      offsets.add(index);
      from = index + oldString.length();
    }
  }

  /** 从后往前替换：低偏移的替换不会影响已处理的高偏移下标。 */
  static String applyChanges(String content, List<Change> changes) {
    List<Change> sorted = new ArrayList<>(changes);
    sorted.sort(Comparator.comparingInt((Change change) -> change.start).reversed());
    StringBuilder builder = new StringBuilder(content);
    for (Change change : sorted) {
      builder.replace(change.start, change.end, change.newString);
    }
    return builder.toString();
  }

  // ---- 原子写与同步 ----

  /** 同目录 <file>.tmp 路径（edit_batch 原子写 / edit_transaction 预写阶段共用）。 */
  static Path tmpPath(Path path) {
    return path.resolveSibling(path.getFileName().toString() + ".tmp");
  }

  /** 写 <file>.tmp 并 fsync（不 rename）；edit_transaction 先全量写 tmp、写 journal 后再统一 rename。 */
  static void writeTmp(Path path, String content) throws IOException {
    try (FileChannel channel =
        FileChannel.open(
            tmpPath(path),
            StandardOpenOption.CREATE,
            StandardOpenOption.WRITE,
            StandardOpenOption.TRUNCATE_EXISTING)) {
      channel.write(ByteBuffer.wrap(content.getBytes(StandardCharsets.UTF_8)));
      channel.force(true);
    }
  }

  private static void atomicWrite(Path path, String content) throws IOException {
    Path tmp = tmpPath(path);
    try {
      writeTmp(path, content);
      Files.move(tmp, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    } finally {
      // 失败路径清理临时文件，避免 .tmp 残留（成功 move 后它已不存在）
      try {
        Files.deleteIfExists(tmp);
      } catch (IOException ignored) {
        // 清理失败不覆盖原始异常
      }
    }
  }

  /** 与 read_view 相同的被动一致性策略：仅在 mtime 与 VFS 时间戳不一致时刷新。 */
  static void refreshIfStale(VirtualFile virtualFile) {
    try {
      long mtime = Files.getLastModifiedTime(Paths.get(virtualFile.getPath())).toMillis();
      if (virtualFile.getTimeStamp() != mtime) virtualFile.refresh(false, false);
    } catch (IOException e) {
      virtualFile.refresh(false, false);
    }
  }

  /**
   * 让 Document/PSI 与磁盘内容一致：在 EDT 上按需重载文档并提交。
   * 原子写绕过了平台保存路径，Document 缓存不会自动感知新内容。
   */
  static void syncDocument(Project project, VirtualFile virtualFile, String diskContent) {
    ApplicationManager.getApplication()
        .invokeAndWait(
            () -> {
              FileDocumentManager fileDocumentManager = FileDocumentManager.getInstance();
              Document document = fileDocumentManager.getDocument(virtualFile);
              if (document != null && !diskContent.equals(document.getText())) {
                fileDocumentManager.reloadFromDisk(document, project);
              }
              PsiDocumentManager.getInstance(project).commitAllDocuments();
            });
  }

  // ---- line_changes ----

  static JsonArray lineChanges(String newContent, List<Change> changes) {
    // 先按原坐标排序，累计前面替换的长度差得到每个 change 在新内容中的起点
    List<Change> byStart = new ArrayList<>(changes);
    byStart.sort(Comparator.comparingInt((Change change) -> change.start));
    int delta = 0;
    for (Change change : byStart) {
      change.newStart = change.start + delta;
      delta += change.newString.length() - change.oldString.length();
    }

    List<JsonObject> entries = new ArrayList<>();
    for (Change change : changes) {
      if (change.newString.isEmpty()) {
        entries.add(lineChange(lineAt(newContent, change.newStart), "deleted"));
        continue;
      }
      int oldLines = countLines(change.oldString);
      int newLines = countLines(change.newString);
      String action = newLines > oldLines ? "inserted" : "modified";
      int startLine = lineAt(newContent, change.newStart);
      for (int i = 0; i < newLines; i++) {
        entries.add(lineChange(Math.min(startLine + i, totalLines(newContent)), action));
      }
    }
    entries.sort(Comparator.comparingInt(entry -> entry.get("line").getAsInt()));
    JsonArray result = new JsonArray();
    for (JsonObject entry : entries) result.add(entry);
    return result;
  }

  private static JsonObject lineChange(int line, String action) {
    JsonObject entry = new JsonObject();
    entry.addProperty("line", line);
    entry.addProperty("action", action);
    return entry;
  }

  static int lineAt(String content, int offset) {
    int line = 1;
    int limit = Math.min(Math.max(offset, 0), content.length());
    for (int i = 0; i < limit; i++) {
      if (content.charAt(i) == '\n') line++;
    }
    return Math.min(line, totalLines(content));
  }

  private static int countLines(String text) {
    if (text.isEmpty()) return 0;
    int lines = 1;
    for (int i = 0; i < text.length(); i++) {
      if (text.charAt(i) == '\n') lines++;
    }
    return lines;
  }

  /** 与 read_view 一致：结尾换行产生的空行不计入总行数。 */
  private static int totalLines(String text) {
    int lines = countLines(text);
    if (lines == 0) return 1;
    if (text.charAt(text.length() - 1) == '\n') lines--;
    return Math.max(lines, 1);
  }

  // ---- 结果 ----

  private static JsonObject success(
      String file, int applied, String oldVersion, String newVersion,
      int[] before, int[] after, JsonArray lineChanges) {
    JsonObject result = new JsonObject();
    result.addProperty("file", file);
    result.addProperty("applied", true);
    result.addProperty("changes_applied", applied);
    result.addProperty("changes_total", applied);
    result.addProperty("old_version", oldVersion);
    result.addProperty("new_version", newVersion);
    result.add("diagnostics_delta", counts(after[0] - before[0], after[1] - before[1]));
    result.add("diagnostics_after", counts(after[0], after[1]));
    result.add("line_changes", lineChanges);
    return result;
  }

  private static JsonObject failure(
      String file, int changesTotal, int code, String message, JsonObject detail, String hint) {
    JsonObject error = new JsonObject();
    error.addProperty("code", code);
    error.addProperty("message", message);
    if (detail != null) error.add("detail", detail);
    if (hint != null) error.addProperty("hint", hint);
    JsonObject result = new JsonObject();
    result.addProperty("applied", false);
    result.addProperty("file", file);
    result.addProperty("changes_total", changesTotal);
    result.add("error", error);
    return result;
  }

  private static JsonObject counts(int errors, int warnings) {
    JsonObject counts = new JsonObject();
    counts.addProperty("errors", errors);
    counts.addProperty("warnings", warnings);
    return counts;
  }
}
