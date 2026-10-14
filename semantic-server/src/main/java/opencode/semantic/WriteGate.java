package opencode.semantic;

import com.google.gson.JsonObject;

/**
 * 写路径共享门：edit_transaction 启动恢复失败（坏 journal、重放失败）时置为只读。
 * edit_batch / edit_transaction 入口检查本门，命中返回 RPC -32018（写操作被拒，等待人工介入）；
 * 读路径（read_view / blast_radius / project_map / verify_test）不受影响。
 * 只读状态只在进程内生效，重启守护会重新尝试恢复。
 */
final class WriteGate {
  private static volatile String readOnlyReason;
  private static volatile String journalPath;

  private WriteGate() {}

  /** 标记只读并保留原因与 journal 路径（供 -32018 的 error.data 与日志）。 */
  static void markReadOnly(String reason, String journal) {
    readOnlyReason = reason;
    journalPath = journal;
    Log.error(
        "write gate: read-only mode enabled ("
            + reason
            + ")"
            + (journal == null ? "" : " journal=" + journal),
        null);
  }

  static boolean isReadOnly() {
    return readOnlyReason != null;
  }

  static String reason() {
    return readOnlyReason;
  }

  static JsonObject errorData() {
    JsonObject data = new JsonObject();
    if (journalPath != null) data.addProperty("journal", journalPath);
    if (readOnlyReason != null) data.addProperty("reason", readOnlyReason);
    return data;
  }
}
