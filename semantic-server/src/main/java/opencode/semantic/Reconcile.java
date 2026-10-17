package opencode.semantic;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 上下文对账（D3/D4）共享基础设施：
 *
 * - 已服务视图 LRU 缓存：key = 规范化绝对路径 + "@" + version，值 = 该版本的渲染源文本；
 *   仅内存、不落盘、不参与一致性保证（有界：16 条 / 8MB，超出按 LRU 淘汰）；
 * - 行级有界 delta：公共前后缀裁剪 + LCS 动态规划；上下文每侧 ≤3 行、总行数 ≤60，
 *   超出预算返回 null，由调用侧降级为 full；
 * - D3 行工具：行起始偏移表与行号/行文本换算（口径与 read_view 一致，结尾换行产生的
 *   空"假行"不计入）。
 */
final class Reconcile {
  /** hunk 上下文行数（变更块每侧）。 */
  private static final int CONTEXT_LINES = 3;
  /** delta 渲染总行数上限（含上下文行）。 */
  private static final int MAX_DELTA_LINES = 60;
  /** LCS DP 单元格上限（≈8MB int）；去公共前后缀后仍超限 → 降级 full。 */
  private static final int MAX_DIFF_CELLS = 2_000_000;

  private static final int MAX_CACHE_ENTRIES = 16;
  private static final long MAX_CACHE_BYTES = 8L * 1024 * 1024;

  /** accessOrder=true 的 LRU；所有访问经 synchronized 方法。 */
  private static final LinkedHashMap<String, String> CACHE = new LinkedHashMap<>(16, 0.75f, true);
  private static long cacheBytes;

  private static final int OP_CONTEXT = 0;
  private static final int OP_REMOVED = 1;
  private static final int OP_ADDED = 2;

  private Reconcile() {}

  // ---- 已服务视图缓存 ----

  /** 记录某版本的全文；key 与写路径（EditBatchService.canonicalKey）同口径。 */
  static synchronized void remember(Path path, String version, String text) {
    if (version == null || text == null) return;
    String previous = CACHE.put(cacheKey(path, version), text);
    cacheBytes += approxBytes(text);
    if (previous != null) cacheBytes -= approxBytes(previous);
    // 超出条数或字节上限时按 LRU 逐出（accessOrder 下最老者在前）
    Iterator<Map.Entry<String, String>> iterator = CACHE.entrySet().iterator();
    while ((CACHE.size() > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) && iterator.hasNext()) {
      Map.Entry<String, String> eldest = iterator.next();
      iterator.remove();
      cacheBytes -= approxBytes(eldest.getValue());
    }
  }

  /** 取某版本全文；未命中（含条目已被 LRU 淘汰）返回 null。 */
  static synchronized String served(Path path, String version) {
    if (version == null) return null;
    return CACHE.get(cacheKey(path, version));
  }

  private static String cacheKey(Path path, String version) {
    return path.toAbsolutePath().normalize() + "@" + version;
  }

  private static long approxBytes(String text) {
    return 2L * text.length() + 48L;
  }

  // ---- 降级形状 ----

  static JsonObject fullMode() {
    JsonObject reconciliation = new JsonObject();
    reconciliation.addProperty("mode", "full");
    return reconciliation;
  }

  static JsonObject fullMode(String currentVersion) {
    JsonObject reconciliation = fullMode();
    reconciliation.addProperty("current_version", currentVersion);
    return reconciliation;
  }

  /** 编辑侧 VERSION_MISMATCH：命中调用者版本且在预算内 → 有界 delta（附 current_version）；否则 full。 */
  static JsonObject mismatch(Path path, String baseVersion, String currentText, String currentVersion) {
    String oldText = served(path, baseVersion);
    if (oldText != null) {
      JsonObject delta = delta(oldText, currentText, baseVersion, currentVersion);
      if (delta != null) {
        delta.addProperty("current_version", currentVersion);
        return delta;
      }
    }
    return fullMode(currentVersion);
  }

  // ---- 行级 delta ----

  /** 有界 delta；超过行数/计算预算返回 null（调用侧降级 full）。 */
  static JsonObject delta(String oldText, String newText, String fromVersion, String toVersion) {
    List<String> a = displayLines(oldText);
    List<String> b = displayLines(newText);
    int prefix = 0;
    while (prefix < a.size() && prefix < b.size() && a.get(prefix).equals(b.get(prefix))) prefix++;
    int suffix = 0;
    while (suffix < a.size() - prefix
        && suffix < b.size() - prefix
        && a.get(a.size() - 1 - suffix).equals(b.get(b.size() - 1 - suffix))) suffix++;
    int middleA = a.size() - prefix - suffix;
    int middleB = b.size() - prefix - suffix;
    if ((long) (middleA + 1) * (middleB + 1) > MAX_DIFF_CELLS) return null;

    List<Op> ops = new ArrayList<>();
    for (int index = 0; index < prefix; index++) {
      ops.add(Op.context(index + 1, index + 1, a.get(index)));
    }
    ops.addAll(middleOps(a, b, prefix, middleA, middleB));
    for (int index = 0; index < suffix; index++) {
      int oldLine = a.size() - suffix + index + 1;
      int newLine = b.size() - suffix + index + 1;
      ops.add(Op.context(oldLine, newLine, a.get(oldLine - 1)));
    }

    JsonArray hunks = hunks(ops);
    if (hunks == null) return null;
    JsonObject reconciliation = new JsonObject();
    reconciliation.addProperty("mode", "delta");
    reconciliation.addProperty("from_version", fromVersion);
    reconciliation.addProperty("to_version", toVersion);
    reconciliation.add("hunks", hunks);
    return reconciliation;
  }

  /** 去前缀/后缀中间段的编辑脚本（LCS DP 回溯；大小已由调用方按单元格上限校验）。 */
  private static List<Op> middleOps(
      List<String> a, List<String> b, int prefix, int middleA, int middleB) {
    List<Op> ops = new ArrayList<>();
    if (middleA == 0 && middleB == 0) return ops;
    int width = middleB + 1;
    int[] dp = new int[(middleA + 1) * width];
    for (int i = 1; i <= middleA; i++) {
      for (int j = 1; j <= middleB; j++) {
        dp[i * width + j] =
            a.get(prefix + i - 1).equals(b.get(prefix + j - 1))
                ? dp[(i - 1) * width + j - 1] + 1
                : Math.max(dp[(i - 1) * width + j], dp[i * width + j - 1]);
      }
    }
    int i = middleA;
    int j = middleB;
    while (i > 0 && j > 0) {
      if (a.get(prefix + i - 1).equals(b.get(prefix + j - 1))) {
        ops.add(Op.context(prefix + i, prefix + j, a.get(prefix + i - 1)));
        i--;
        j--;
      } else if (dp[(i - 1) * width + j] >= dp[i * width + j - 1]) {
        ops.add(Op.removed(prefix + i, a.get(prefix + i - 1)));
        i--;
      } else {
        ops.add(Op.added(prefix + j, b.get(prefix + j - 1)));
        j--;
      }
    }
    while (i > 0) {
      ops.add(Op.removed(prefix + i, a.get(prefix + i - 1)));
      i--;
    }
    while (j > 0) {
      ops.add(Op.added(prefix + j, b.get(prefix + j - 1)));
      j--;
    }
    Collections.reverse(ops);
    return ops;
  }

  /** 变更块分组为 hunk（间隔 ≤2×上下文 的相邻块合并）；总行数超限返回 null。 */
  private static JsonArray hunks(List<Op> ops) {
    List<int[]> ranges = new ArrayList<>();
    int first = -1;
    int last = -1;
    for (int index = 0; index < ops.size(); index++) {
      if (ops.get(index).type == OP_CONTEXT) continue;
      if (first < 0) {
        first = index;
        last = index;
        continue;
      }
      if (index - last - 1 <= 2 * CONTEXT_LINES) {
        last = index;
        continue;
      }
      ranges.add(range(ops.size(), first, last));
      first = index;
      last = index;
    }
    if (first >= 0) ranges.add(range(ops.size(), first, last));

    int total = 0;
    for (int[] range : ranges) total += range[1] - range[0] + 1;
    if (total > MAX_DELTA_LINES) return null;

    JsonArray hunks = new JsonArray();
    for (int[] range : ranges) {
      JsonArray lines = new JsonArray();
      for (int index = range[0]; index <= range[1]; index++) {
        Op op = ops.get(index);
        JsonObject line = new JsonObject();
        line.addProperty(
            "op", op.type == OP_CONTEXT ? "context" : op.type == OP_REMOVED ? "removed" : "added");
        if (op.oldLine > 0) line.addProperty("old_line", op.oldLine);
        if (op.newLine > 0) line.addProperty("new_line", op.newLine);
        line.addProperty("text", op.text);
        lines.add(line);
      }
      JsonObject hunk = new JsonObject();
      hunk.add("lines", lines);
      hunks.add(hunk);
    }
    return hunks;
  }

  private static int[] range(int size, int first, int last) {
    return new int[] {
      Math.max(0, first - CONTEXT_LINES), Math.min(size - 1, last + CONTEXT_LINES)
    };
  }

  private static final class Op {
    final int type;
    final int oldLine;
    final int newLine;
    final String text;

    private Op(int type, int oldLine, int newLine, String text) {
      this.type = type;
      this.oldLine = oldLine;
      this.newLine = newLine;
      this.text = text;
    }

    static Op context(int oldLine, int newLine, String text) {
      return new Op(OP_CONTEXT, oldLine, newLine, text);
    }

    static Op removed(int oldLine, String text) {
      return new Op(OP_REMOVED, oldLine, 0, text);
    }

    static Op added(int newLine, String text) {
      return new Op(OP_ADDED, 0, newLine, text);
    }
  }

  // ---- 行工具（D3/D4 共用；口径与 read_view 一致） ----

  /** 与 read_view 一致：结尾换行产生的空"假行"不计入。 */
  static List<String> displayLines(String text) {
    List<String> lines = new ArrayList<>();
    int start = 0;
    for (int index = 0; index < text.length(); index++) {
      if (text.charAt(index) == '\n') {
        lines.add(text.substring(start, index));
        start = index + 1;
      }
    }
    if (start < text.length()) lines.add(text.substring(start));
    return lines;
  }

  /** 行起始偏移表（起于 0；结尾换行后的空行不计）；长度即总行数。 */
  static int[] lineStarts(String text) {
    List<Integer> starts = new ArrayList<>();
    starts.add(0);
    for (int index = 0; index < text.length(); index++) {
      if (text.charAt(index) == '\n' && index + 1 < text.length()) starts.add(index + 1);
    }
    int[] result = new int[starts.size()];
    for (int index = 0; index < result.length; index++) result[index] = starts.get(index);
    return result;
  }

  /** 1-based 行号（offset 处字符所在行），上限为行数（等价 EditBatchService.lineAt 的钳制口径）。 */
  static int lineOf(int[] starts, int offset) {
    int low = 0;
    int high = starts.length - 1;
    while (low < high) {
      int middle = (low + high + 1) >>> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }

  /** 1-based 行的文本（不含换行符；行尾 CR 亦剔除）。 */
  static String lineText(String text, int[] starts, int line) {
    int from = starts[line - 1];
    int to = line < starts.length ? starts[line] - 1 : text.length();
    if (to > from && text.charAt(to - 1) == '\r') to--;
    return text.substring(from, to);
  }
}
