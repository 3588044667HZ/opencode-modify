package opencode.semantic;

import com.google.gson.JsonElement;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.nio.file.Paths;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

/**
 * 目录排除规则：内置 defaults ∪ 环境变量 OPENCODE_SEMANTIC_EXCLUDE（JSON 字符串数组），
 * 进程启动时解析一次，守护生命周期内固定。
 *
 * 匹配语义（冻结契约）：
 * - 不含 '/' 且不含 glob 元字符（* ? [ {）的条目：匹配任意同名目录（Windows 大小写不敏感）；
 * - 其余条目：按项目相对目录路径（'/' 分隔）做 java.nio.file.PathMatcher "glob:" 匹配，
 *   支持 **；Windows 下模式与相对路径都先转小写；
 * - 只匹配目录，从不匹配文件。
 */
final class Exclusions {
  static final Set<String> DEFAULTS =
      Set.of("venv", "node_modules", "build", "out", "target", "__pycache__", "dist");

  private static final boolean WINDOWS =
      System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
  private static final List<String> ACTIVE;
  private static final List<String> NAME_PATTERNS = new ArrayList<>();
  private static final List<PathMatcher> GLOB_PATTERNS = new ArrayList<>();

  static {
    TreeSet<String> union = new TreeSet<>(DEFAULTS);
    union.addAll(configPatterns());
    ACTIVE = List.copyOf(union);
    for (String pattern : ACTIVE) {
      if (isGlob(pattern)) {
        String normalized = WINDOWS ? pattern.toLowerCase(Locale.ROOT) : pattern;
        GLOB_PATTERNS.add(FileSystems.getDefault().getPathMatcher("glob:" + normalized));
      } else {
        NAME_PATTERNS.add(pattern);
      }
    }
  }

  private Exclusions() {}

  /** 生效规则（defaults ∪ 配置），升序去重。 */
  static List<String> active() {
    return ACTIVE;
  }

  /** relativePath 为目录的项目相对路径（'/' 分隔），name 为目录名。 */
  static boolean excludesDir(String relativePath, String name) {
    for (String pattern : NAME_PATTERNS) {
      if (WINDOWS ? pattern.equalsIgnoreCase(name) : pattern.equals(name)) return true;
    }
    if (GLOB_PATTERNS.isEmpty()) return false;
    Path candidate = Paths.get(WINDOWS ? relativePath.toLowerCase(Locale.ROOT) : relativePath);
    for (PathMatcher matcher : GLOB_PATTERNS) {
      if (matcher.matches(candidate)) return true;
    }
    return false;
  }

  /** 枚举 root 下所有命中排除规则的目录（绝对规范化路径，升序）。
   *  跳过 '.' 开头的隐藏名与目录符号链接；命中目录不再下钻；只返回目录。 */
  static List<Path> matchingDirs(Path root) {
    List<Path> matches = new ArrayList<>();
    collect(root.toAbsolutePath().normalize(), "", matches);
    matches.sort(Comparator.naturalOrder());
    return matches;
  }

  private static void collect(Path dir, String relative, List<Path> matches) {
    try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
      for (Path entry : stream) {
        String name = entry.getFileName().toString();
        if (name.startsWith(".")) continue;
        BasicFileAttributes attrs;
        try {
          attrs = Files.readAttributes(entry, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (IOException e) {
          continue;
        }
        // NOFOLLOW 下符号链接不是 directory：跳过目录符号链接
        if (!attrs.isDirectory()) continue;
        String childRelative = relative.isEmpty() ? name : relative + "/" + name;
        if (excludesDir(childRelative, name)) {
          matches.add(entry.toAbsolutePath().normalize());
          continue;
        }
        collect(entry, childRelative, matches);
      }
    } catch (IOException e) {
      Log.warn("exclusions scan failed at " + dir + ": " + e);
    }
  }

  /** 条目含 '/' 或 glob 元字符（* ? [ {）则按 glob 匹配相对路径，否则按目录名匹配。 */
  private static boolean isGlob(String pattern) {
    if (pattern.indexOf('/') >= 0) return true;
    for (int i = 0; i < pattern.length(); i++) {
      if ("*?[{".indexOf(pattern.charAt(i)) >= 0) return true;
    }
    return false;
  }

  /** OPENCODE_SEMANTIC_EXCLUDE：JSON 数组；非法/缺失时仅内置 defaults 生效。 */
  private static List<String> configPatterns() {
    String raw = System.getenv("OPENCODE_SEMANTIC_EXCLUDE");
    if (raw == null || raw.isBlank()) return List.of();
    List<String> patterns = new ArrayList<>();
    try {
      JsonElement parsed = JsonParser.parseString(raw);
      if (!parsed.isJsonArray()) throw new IllegalArgumentException("not a JSON array");
      for (JsonElement element : parsed.getAsJsonArray()) {
        if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) continue;
        String pattern = element.getAsString().trim();
        if (!pattern.isEmpty()) patterns.add(pattern);
      }
    } catch (Throwable t) {
      Log.warn("invalid OPENCODE_SEMANTIC_EXCLUDE ignored: " + t.getMessage());
      return List.of();
    }
    return patterns;
  }
}
