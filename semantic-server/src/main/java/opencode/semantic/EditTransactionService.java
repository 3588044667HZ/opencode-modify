package opencode.semantic;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.project.IndexNotReadyException;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.ThrowableComputable;
import com.intellij.openapi.vfs.VfsUtil;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.stream.Stream;

/**
 * edit_transaction：跨文件原子编辑（多文件锁 + 全量预检 + journal/rename + 启动恢复 + 只读门）。
 *
 * 冻结协议处理顺序：参数校验（RPC -32603，含文件数 ≤10、options.lock_timeout_ms ≥1）→ 同一规范
 * 路径重复（-32019）→ 路径保护/项目根约束（-32013，先于存在性）→ 文件不存在（RPC -32001）→
 * 按规范化路径字典序排序 → 按序获取文件锁（公平 FIFO，每把独立等待 lock_timeout_ms，超时
 * -32017 并释放已持有）→ 全部 baseVersion 校验（-32012）→ 全部 newString 纯度（-32014）→
 * 逐文件锚点（-32010/-32011）+ 同文件重叠（-32016）→ 内存应用 → 写阶段（每文件 <file>.tmp
 * + fsync → journal → 依次 rename → 删 journal）→ 重算版本/诊断 → 逆序释放锁。
 * 写入阶段之前任何失败都是零副作用；锁内校验与写入之间无窗口期（复用 edit_batch 的锁表、
 * 路径保护、纯度、锚点、应用与 line_changes 计算，避免两套实现产生差异）。
 */
final class EditTransactionService {
  private static final int ANCHOR_NOT_FOUND = -32010;
  private static final int ANCHOR_NOT_UNIQUE = -32011;
  private static final int VERSION_MISMATCH = -32012;
  private static final int PATH_PROTECTED = -32013;
  private static final int CONTENT_IMPURE = -32014;
  private static final int WRITE_FAILED = -32015;
  private static final int CHANGE_CONFLICT = -32016;
  private static final int LOCK_TIMEOUT = -32017;
  private static final int JOURNAL_RECOVERY_FAILED = -32018;
  private static final int DUPLICATE_FILE = -32019;

  /** spec 约束：事务最多 10 个文件，超过按参数错误 RPC -32603 拒绝。 */
  private static final int MAX_FILES = 10;

  /** journal 目录（项目根相对，被 gitignore）。 */
  private static final String JOURNAL_DIR = ".opencode/txn-journal";

  /** 单把锁等待超过该时长记 WARN。 */
  private static final long LOCK_WAIT_WARN_MS = 1_000L;

  /** spec 原文 hint（-32011 专属）。 */
  private static final String HINT_ANCHOR_NOT_UNIQUE =
      "提供更多上下文使锚点唯一，或调用 fallback_option_direct 获取直接操作工具";

  private static final String HINT_ANCHOR_NOT_FOUND =
      "锚点未找到：确认内容未被修改，或重新调用 read_view 获取最新版本后重试";
  private static final String HINT_VERSION_MISMATCH =
      "文件已变化：用返回的 current_version 与 content 重新读取后再提交";
  private static final String HINT_PATH_PROTECTED =
      "保护路径默认禁止写入，如需修改请手工处理";
  private static final String HINT_CONTENT_IMPURE =
      "newString 含渲染层元语标记，请使用源文件原文";
  private static final String HINT_CHANGE_CONFLICT =
      "两个 change 的锚点区间重叠，请合并为一个 change 或调整锚点范围";
  private static final String HINT_LOCK_TIMEOUT =
      "文件正被其他写者占用。可稍后重试，或先 read_view 获取最新版本";
  private static final String HINT_DUPLICATE_FILE =
      "同一文件在 changes 里出现多次：请合并为单个条目";
  private static final String HINT_WRITE_FAILED =
      "磁盘写入失败：检查文件权限、磁盘空间或文件占用后重试";

  JsonObject editTransaction(Project project, String basePath, JsonObject params)
      throws JsonRpcServer.RpcException {
    // ⓪ 只读门（journal 恢复失败后写路径全部拒绝，读路径不受影响）
    if (WriteGate.isReadOnly()) {
      throw new JsonRpcServer.RpcException(
          JOURNAL_RECOVERY_FAILED, "journal recovery failed", WriteGate.errorData());
    }

    // ① 参数校验（空 changes / 某文件空 changes / 类型错 / 文件数 >10 → RPC -32603）
    List<FileChange> files = readFileChanges(basePath, params);
    long lockTimeoutMs = EditBatchService.readLockTimeoutMs(params);

    // ② 同一规范路径重复 → -32019
    Map<String, FileChange> seen = new HashMap<>();
    for (FileChange fileChange : files) {
      if (seen.putIfAbsent(fileChange.key, fileChange) != null) {
        Log.info("edit_transaction rejected file=" + fileChange.requestFile
            + " code=" + DUPLICATE_FILE);
        JsonObject detail = new JsonObject();
        detail.addProperty("file", fileChange.requestFile);
        return failure(DUPLICATE_FILE, "DUPLICATE_FILE", detail, HINT_DUPLICATE_FILE);
      }
    }

    // ③ 路径保护 + 项目根约束（先于存在性；journal 需项目相对路径，故拒绝根外文件）
    Path projectRoot = Paths.get(basePath).toAbsolutePath().normalize();
    for (FileChange fileChange : files) {
      boolean outside = !fileChange.path.startsWith(projectRoot);
      if (outside || EditBatchService.protectReason(basePath, fileChange.path) != null) {
        Log.info("edit_transaction rejected file=" + fileChange.requestFile
            + " code=" + PATH_PROTECTED + (outside ? " (outside project)" : " (protected path)"));
        JsonObject detail = new JsonObject();
        detail.addProperty("file", fileChange.requestFile);
        return failure(PATH_PROTECTED, "PATH_PROTECTED", detail, HINT_PATH_PROTECTED);
      }
    }

    // ④ 文件不存在 → RPC -32001（此时所有文件都已通过保护检查）
    for (FileChange fileChange : files) {
      VirtualFile virtualFile = VfsUtil.findFileByIoFile(fileChange.path.toFile(), true);
      if (virtualFile == null || !virtualFile.isValid()) {
        throw new JsonRpcServer.RpcException(-32001, "file not found", null);
      }
      fileChange.virtualFile = virtualFile;
    }

    // ⑤ 按规范化路径字典序排序（保证全局一致的加锁顺序，避免死锁）
    List<FileChange> sorted = new ArrayList<>(files);
    sorted.sort(Comparator.comparing(fileChange -> fileChange.key));

    // ⑥ 按序获取文件锁；每把独立等待 lock_timeout_ms，超时释放已持有
    List<ReentrantLock> held = new ArrayList<>();
    try {
      for (FileChange fileChange : sorted) {
        ReentrantLock lock = EditBatchService.fileLock(fileChange.path);
        if (lock.isLocked()) {
          Log.warn("edit_transaction lock contended file=" + fileChange.requestFile
              + " waiting up to " + lockTimeoutMs + "ms");
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
          Log.warn("edit_transaction rejected file=" + fileChange.requestFile
              + " code=" + LOCK_TIMEOUT + " waited_ms=" + waitedMs);
          JsonObject detail = new JsonObject();
          detail.addProperty("file", fileChange.requestFile);
          detail.addProperty("waited_ms", waitedMs);
          return failure(LOCK_TIMEOUT, "LOCK_TIMEOUT", detail, HINT_LOCK_TIMEOUT);
        }
        if (waitedMs > LOCK_WAIT_WARN_MS) {
          Log.warn("edit_transaction lock acquired file=" + fileChange.requestFile
              + " waited_ms=" + waitedMs);
        }
        held.add(lock);
      }

      // ⑦ 锁内 + 平台写路径执行门内：全量预检 → 写阶段
      EditBatchService.EXECUTION_GATE.lock();
      try {
        return execute(project, projectRoot, sorted);
      } finally {
        EditBatchService.EXECUTION_GATE.unlock();
      }
    } catch (JsonRpcServer.RpcException e) {
      throw e;
    } catch (IndexNotReadyException e) {
      // 读过程中进入 dumb 模式的竞态：按协议返回 indexing，客户端稍后重试
      throw new JsonRpcServer.RpcException(-32000, "indexing", null);
    } catch (Throwable t) {
      Log.error("edit_transaction failed", t);
      throw new JsonRpcServer.RpcException(-32603, "internal error", null);
    } finally {
      // ⑮ 逆序释放所有已持有的锁
      for (int i = held.size() - 1; i >= 0; i--) held.get(i).unlock();
    }
  }

  private JsonObject execute(Project project, Path projectRoot, List<FileChange> sorted)
      throws JsonRpcServer.RpcException {
    // ⑦ 读内容 + 当前版本（全部在锁内；先按 mtime 差异 refresh VFS）
    for (FileChange fileChange : sorted) {
      EditBatchService.refreshIfStale(fileChange.virtualFile);
      String content = EditBatchService.readContent(fileChange.path);
      EditBatchService.syncDocument(project, fileChange.virtualFile, content);
      String currentVersion = ReadViewService.versionOf(fileChange.virtualFile);
      if (!fileChange.baseVersion.equals(currentVersion)) {
        Log.info("edit_transaction rejected file=" + fileChange.requestFile
            + " code=" + VERSION_MISMATCH);
        JsonObject detail = new JsonObject();
        detail.addProperty("file", fileChange.requestFile);
        detail.addProperty("current_version", currentVersion);
        detail.addProperty("content", content);
        return failure(VERSION_MISMATCH, "VERSION_MISMATCH", detail, HINT_VERSION_MISMATCH);
      }
      fileChange.content = content;
    }

    // ⑧ 全部 newString 纯度校验
    for (FileChange fileChange : sorted) {
      for (int i = 0; i < fileChange.changes.size(); i++) {
        String marker = EditBatchService.impureMarker(fileChange.changes.get(i).newString);
        if (marker != null) {
          Log.info("edit_transaction rejected file=" + fileChange.requestFile
              + " code=" + CONTENT_IMPURE + " change=" + i);
          JsonObject detail = new JsonObject();
          detail.addProperty("file", fileChange.requestFile);
          detail.addProperty("change_index", i);
          detail.addProperty("changes_total", fileChange.changes.size());
          detail.addProperty("marker", marker);
          return failure(CONTENT_IMPURE, "CONTENT_IMPURE", detail, HINT_CONTENT_IMPURE);
        }
      }
    }

    // ⑨ 逐文件锚点（0 → -32010，多 → -32011）+ 同文件重叠（-32016）
    for (FileChange fileChange : sorted) {
      for (EditBatchService.Change change : fileChange.changes) {
        List<Integer> matches = EditBatchService.matchOffsets(fileChange.content, change.oldString);
        if (matches.isEmpty()) {
          Log.info("edit_transaction rejected file=" + fileChange.requestFile
              + " code=" + ANCHOR_NOT_FOUND + " change=" + change.index);
          JsonObject detail = new JsonObject();
          detail.addProperty("file", fileChange.requestFile);
          detail.addProperty("change_index", change.index);
          detail.addProperty("changes_total", fileChange.changes.size());
          detail.addProperty("oldString", change.oldString);
          return failure(ANCHOR_NOT_FOUND, "ANCHOR_NOT_FOUND", detail, HINT_ANCHOR_NOT_FOUND);
        }
        if (matches.size() > 1) {
          Log.info("edit_transaction rejected file=" + fileChange.requestFile
              + " code=" + ANCHOR_NOT_UNIQUE + " change=" + change.index
              + " matches=" + matches.size());
          JsonObject detail = new JsonObject();
          detail.addProperty("file", fileChange.requestFile);
          detail.addProperty("change_index", change.index);
          detail.addProperty("changes_total", fileChange.changes.size());
          detail.addProperty("oldString", change.oldString);
          detail.addProperty("match_count", matches.size());
          JsonArray locations = new JsonArray();
          for (int offset : matches) locations.add(EditBatchService.lineAt(fileChange.content, offset));
          detail.add("locations", locations);
          return failure(ANCHOR_NOT_UNIQUE, "ANCHOR_NOT_UNIQUE", detail, HINT_ANCHOR_NOT_UNIQUE);
        }
        change.start = matches.get(0);
        change.end = change.start + change.oldString.length();
      }
      for (int i = 0; i < fileChange.changes.size(); i++) {
        for (int j = i + 1; j < fileChange.changes.size(); j++) {
          EditBatchService.Change earlier = fileChange.changes.get(i);
          EditBatchService.Change later = fileChange.changes.get(j);
          if (earlier.start < later.end && later.start < earlier.end) {
            Log.info("edit_transaction rejected file=" + fileChange.requestFile
                + " code=" + CHANGE_CONFLICT + " change=" + later.index
                + " conflict_with=" + earlier.index);
            JsonObject detail = new JsonObject();
            detail.addProperty("file", fileChange.requestFile);
            detail.addProperty("change_index", later.index);
            detail.addProperty("changes_total", fileChange.changes.size());
            detail.addProperty("conflict_with_index", earlier.index);
            return failure(CHANGE_CONFLICT, "CHANGE_CONFLICT", detail, HINT_CHANGE_CONFLICT);
          }
        }
      }
    }

    // ⑩ 内存中应用（任一文件失败整体拒绝；此时仍无任何磁盘副作用）
    for (FileChange fileChange : sorted) {
      fileChange.newContent = EditBatchService.applyChanges(fileChange.content, fileChange.changes);
    }

    // ⑪ 诊断 before 计数（写阶段之前、盘上仍是旧内容）
    for (FileChange fileChange : sorted) {
      fileChange.before = ReadAction.computeBlocking(
          (ThrowableComputable<int[], RuntimeException>)
              () -> ReadViewService.diagnosticCounts(project, fileChange.virtualFile));
    }

    // ⑫ 写阶段：每文件 <file>.tmp + fsync → journal → 依次 rename → 删 journal
    Path journalDir = projectRoot.resolve(JOURNAL_DIR);
    Path journalPath = journalDir.resolve(UUID.randomUUID() + ".json");
    try {
      Files.createDirectories(journalDir);
      for (FileChange fileChange : sorted) {
        EditBatchService.writeTmp(fileChange.path, fileChange.newContent);
      }
      writeJournal(journalPath, journalJson(projectRoot, sorted));
    } catch (IOException e) {
      Log.warn("edit_transaction write failed before journal: " + e);
      for (FileChange fileChange : sorted) {
        try {
          Files.deleteIfExists(EditBatchService.tmpPath(fileChange.path));
        } catch (IOException ignored) {
          // 清理失败不覆盖原始异常
        }
      }
      try {
        Files.deleteIfExists(journalPath);
      } catch (IOException ignored) {
        // 同上
      }
      return writeFailure(null, e);
    }

    // journal 已落盘：此后为提交方向。逐个 rename（已 rename 的目标在恢复时跳过，见重放幂等）
    String failedFile = null;
    String failedReason = null;
    for (FileChange fileChange : sorted) {
      try {
        Files.move(
            EditBatchService.tmpPath(fileChange.path),
            fileChange.path,
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING);
      } catch (IOException e) {
        if (failedFile == null) {
          failedFile = fileChange.requestFile;
          failedReason = reason(e);
        }
      }
    }
    if (failedFile != null) {
      // 保留 journal：下次启动恢复续传剩余 rename（幂等）；本次返回失败
      Log.warn("edit_transaction rename failed file=" + failedFile + " reason=" + failedReason
          + " (journal kept for recovery: " + journalPath + ")");
      return writeFailure(failedFile, failedReason);
    }
    try {
      Files.deleteIfExists(journalPath);
    } catch (IOException e) {
      // 事务已全部提交；journal 残留会在下次启动幂等重放后清理
      Log.warn("edit_transaction journal cleanup failed: " + e);
    }

    // ⑬ VFS refresh + Document 重载 + 新版本
    for (FileChange fileChange : sorted) {
      fileChange.virtualFile.refresh(false, false);
      EditBatchService.syncDocument(project, fileChange.virtualFile, fileChange.newContent);
      fileChange.newVersion = ReadViewService.versionOf(fileChange.virtualFile);
    }

    // ⑭ 诊断 after 与增量、line_changes
    for (FileChange fileChange : sorted) {
      fileChange.after = ReadAction.computeBlocking(
          (ThrowableComputable<int[], RuntimeException>)
              () -> ReadViewService.diagnosticCounts(project, fileChange.virtualFile));
    }
    Log.info("edit_transaction applied files=" + sorted.size()
        + " changes=" + sorted.stream().mapToInt(fileChange -> fileChange.changes.size()).sum());

    return success(sorted);
  }

  // ---- 参数 ----

  private static final class FileChange {
    final String requestFile;
    final Path path;
    final String key;
    final String baseVersion;
    final List<EditBatchService.Change> changes;
    VirtualFile virtualFile;
    String content;
    String newContent;
    String newVersion;
    int[] before;
    int[] after;

    FileChange(
        String basePath, String requestFile, String baseVersion, List<EditBatchService.Change> changes) {
      this.requestFile = requestFile;
      this.path = ReadViewService.resolvePath(basePath, requestFile);
      this.key = EditBatchService.canonicalKey(path);
      this.baseVersion = baseVersion;
      this.changes = changes;
    }
  }

  private static List<FileChange> readFileChanges(String basePath, JsonObject params)
      throws JsonRpcServer.RpcException {
    JsonElement element = params.get("changes");
    if (element == null || !element.isJsonArray()) throw EditBatchService.invalidParams("changes");
    JsonArray array = element.getAsJsonArray();
    if (array.isEmpty()) throw EditBatchService.invalidParams("changes");
    if (array.size() > MAX_FILES) {
      throw EditBatchService.invalidParams("changes: at most " + MAX_FILES + " files");
    }
    List<FileChange> files = new ArrayList<>();
    for (int i = 0; i < array.size(); i++) {
      JsonElement item = array.get(i);
      if (item == null || !item.isJsonObject()) {
        throw EditBatchService.invalidParams("changes[" + i + "]");
      }
      JsonObject object = item.getAsJsonObject();
      String file = EditBatchService.requireString(object, "file");
      if (file.isEmpty()) throw EditBatchService.invalidParams("changes[" + i + "].file");
      String baseVersion = EditBatchService.requireString(object, "baseVersion");
      // 每个文件条目内的 changes 复用 edit_batch 的参数校验（空数组/空 oldString/类型错 → -32603）
      List<EditBatchService.Change> changes = EditBatchService.readChanges(object);
      files.add(new FileChange(basePath, file, baseVersion, changes));
    }
    return files;
  }

  // ---- journal 与写阶段 ----

  private static String journalJson(Path projectRoot, List<FileChange> files) {
    JsonObject journal = new JsonObject();
    journal.addProperty("started_at", Instant.now().toString());
    JsonArray entries = new JsonArray();
    for (FileChange fileChange : files) {
      JsonObject entry = new JsonObject();
      entry.addProperty("tmp", projectRelative(projectRoot, EditBatchService.tmpPath(fileChange.path)));
      entry.addProperty("target", projectRelative(projectRoot, fileChange.path));
      entries.add(entry);
    }
    journal.add("files", entries);
    return journal.toString();
  }

  private static String projectRelative(Path projectRoot, Path path) {
    return projectRoot.relativize(path).toString().replace('\\', '/');
  }

  private static void writeJournal(Path journalPath, String json) throws IOException {
    try (FileChannel channel =
        FileChannel.open(
            journalPath,
            StandardOpenOption.CREATE,
            StandardOpenOption.WRITE,
            StandardOpenOption.TRUNCATE_EXISTING)) {
      channel.write(ByteBuffer.wrap(json.getBytes(StandardCharsets.UTF_8)));
      channel.force(true);
    }
  }

  private static JsonObject writeFailure(String file, IOException e) {
    return writeFailure(file, reason(e));
  }

  private static JsonObject writeFailure(String file, String reason) {
    JsonObject detail = new JsonObject();
    if (file != null) detail.addProperty("file", file);
    detail.addProperty("reason", reason);
    return failure(WRITE_FAILED, "WRITE_FAILED", detail, HINT_WRITE_FAILED);
  }

  private static String reason(IOException e) {
    return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
  }

  // ---- 结果 ----

  private static JsonObject success(List<FileChange> sorted) {
    int changesTotal =
        sorted.stream().mapToInt(fileChange -> fileChange.changes.size()).sum();
    JsonObject result = new JsonObject();
    result.addProperty("applied", true);
    result.addProperty("files_changed", sorted.size());
    result.addProperty("changes_applied", changesTotal);
    result.addProperty("changes_total", changesTotal);
    JsonArray files = new JsonArray();
    JsonObject delta = new JsonObject();
    JsonObject after = new JsonObject();
    for (FileChange fileChange : sorted) {
      JsonObject file = new JsonObject();
      file.addProperty("file", fileChange.requestFile);
      file.addProperty("old_version", fileChange.baseVersion);
      file.addProperty("new_version", fileChange.newVersion);
      file.addProperty("changes_applied", fileChange.changes.size());
      file.add("line_changes", EditBatchService.lineChanges(fileChange.newContent, fileChange.changes));
      files.add(file);
      delta.add(
          fileChange.requestFile,
          counts(
              fileChange.after[0] - fileChange.before[0],
              fileChange.after[1] - fileChange.before[1]));
      after.add(fileChange.requestFile, counts(fileChange.after[0], fileChange.after[1]));
    }
    result.add("files", files);
    result.add("diagnostics_delta", delta);
    result.add("diagnostics_after", after);
    return result;
  }

  private static JsonObject failure(int code, String message, JsonObject detail, String hint) {
    JsonObject error = new JsonObject();
    error.addProperty("code", code);
    error.addProperty("message", message);
    if (detail != null) error.add("detail", detail);
    if (hint != null) error.addProperty("hint", hint);
    JsonObject result = new JsonObject();
    result.addProperty("applied", false);
    result.add("error", error);
    return result;
  }

  private static JsonObject counts(int errors, int warnings) {
    JsonObject counts = new JsonObject();
    counts.addProperty("errors", errors);
    counts.addProperty("warnings", warnings);
    return counts;
  }

  // ---- 启动恢复 ----

  /**
   * 启动时扫描 <project>/.opencode/txn-journal/：
   * 全部 tmp 在 → 重放全部 rename；部分 tmp 在（缺失 tmp 的目标已存在）→ 续传剩余；
   * 清单 tmp 缺失且目标未更新（fsync 前中断）→ 清理残留 tmp + journal。
   * 重放幂等：目标已存在则跳过（按 tmp 是否还在判断）。
   * 恢复异常 → 保留 journal + WriteGate 置只读（人工介入），守护继续启动。
   */
  static void recoverJournals(Path projectRoot) {
    Path journalDir = projectRoot.resolve(JOURNAL_DIR);
    if (!Files.isDirectory(journalDir)) return;
    List<Path> journals;
    try (Stream<Path> stream = Files.list(journalDir)) {
      journals =
          stream
              .filter(path -> path.getFileName().toString().endsWith(".json"))
              .sorted()
              .toList();
    } catch (IOException e) {
      WriteGate.markReadOnly("journal directory unreadable: " + reason(e), journalDir.toString());
      return;
    }
    for (Path journal : journals) {
      try {
        recoverOne(projectRoot, journal);
      } catch (IOException | RuntimeException e) {
        WriteGate.markReadOnly(
            "journal recovery failed: "
                + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()),
            journal.toString());
      }
    }
  }

  private static void recoverOne(Path projectRoot, Path journal) throws IOException {
    JsonObject json;
    try {
      json = JsonParser.parseString(Files.readString(journal, StandardCharsets.UTF_8)).getAsJsonObject();
    } catch (RuntimeException e) {
      throw new IOException("invalid journal JSON", e);
    }
    JsonElement filesElement = json.get("files");
    if (filesElement == null || !filesElement.isJsonArray() || filesElement.getAsJsonArray().isEmpty()) {
      throw new IOException("journal missing files[]");
    }
    List<Path[]> entries = new ArrayList<>();
    for (JsonElement element : filesElement.getAsJsonArray()) {
      if (!element.isJsonObject()) throw new IOException("journal entry is not an object");
      JsonObject entry = element.getAsJsonObject();
      entries.add(
          new Path[] {
            resolveJournalPath(projectRoot, entry.get("tmp")),
            resolveJournalPath(projectRoot, entry.get("target"))
          });
    }
    boolean tmpMissing = entries.stream().anyMatch(entry -> !Files.exists(entry[0]));
    if (tmpMissing) {
      boolean resumable =
          entries.stream()
              .filter(entry -> !Files.exists(entry[0]))
              .allMatch(entry -> Files.exists(entry[1]));
      if (!resumable) {
        // tmp 缺失且目标未更新：中断发生在 fsync 前，清理残留 tmp + journal
        for (Path[] entry : entries) Files.deleteIfExists(entry[0]);
        Files.deleteIfExists(journal);
        Log.info("edit_transaction recovery: cleaned incomplete journal " + journal.getFileName());
        return;
      }
    }
    int replayed = 0;
    for (Path[] entry : entries) {
      if (Files.exists(entry[0])) {
        Files.move(entry[0], entry[1], StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        replayed++;
      }
    }
    Files.deleteIfExists(journal);
    Log.info("edit_transaction recovery: replayed journal " + journal.getFileName()
        + " renames=" + replayed);
  }

  private static Path resolveJournalPath(Path projectRoot, JsonElement element) throws IOException {
    if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
      throw new IOException("journal path missing");
    }
    String value = element.getAsString();
    if (value.isEmpty()) throw new IOException("journal path empty");
    Path resolved = projectRoot.resolve(value).normalize();
    if (!resolved.startsWith(projectRoot)) {
      throw new IOException("journal path escapes project: " + value);
    }
    return resolved;
  }
}
