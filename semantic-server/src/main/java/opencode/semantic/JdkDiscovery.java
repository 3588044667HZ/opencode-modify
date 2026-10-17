package opencode.semantic;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 本机 JDK 发现（只回答"装在哪"）：SEMANTIC_JDK_HOME > JAVA_HOME > 常见安装目录。
 * 常见目录均为通用位置（C:\Program Files\Java\* 等），不含任何个人路径。
 * 供 Launcher（生成 jdk.table.xml）与 JavaSupport（项目 SDK 指派）共用。
 */
final class JdkDiscovery {
  private static final Pattern JAVA_VERSION = Pattern.compile("JAVA_VERSION=\"([^\"]+)\"");

  private JdkDiscovery() {}

  /** 首个可用 JDK home；未找到返回 null。 */
  static Path home() {
    for (String raw : new String[] {System.getenv("SEMANTIC_JDK_HOME"), System.getenv("JAVA_HOME")}) {
      if (raw == null || raw.isBlank()) continue;
      Path candidate = Path.of(raw.trim());
      if (isJdkHome(candidate)) return candidate.toAbsolutePath().normalize();
    }
    for (Path candidate : commonHomes()) {
      if (isJdkHome(candidate)) return candidate.toAbsolutePath().normalize();
    }
    return null;
  }

  /** JDK home 判定：<home>/bin/java 存在且 release 文件可读（JDK 9+ 与 8u 之后都带 release）。 */
  static boolean isJdkHome(Path home) {
    return javaExecutable(home) != null && Files.isRegularFile(home.resolve("release"));
  }

  static Path javaExecutable(Path home) {
    for (String relative : new String[] {"bin/java.exe", "bin/java"}) {
      Path candidate = home.resolve(relative);
      if (Files.isRegularFile(candidate)) return candidate;
    }
    return null;
  }

  /** release 里的主版本号（"25.0.3"→"25"，"1.8.0_402"→"8"）；不可读时 null。 */
  static String javaMajor(Path home) {
    try {
      String release = Files.readString(home.resolve("release"), StandardCharsets.UTF_8);
      Matcher matcher = JAVA_VERSION.matcher(release);
      if (!matcher.find()) return null;
      String version = matcher.group(1);
      if (version.startsWith("1.")) version = version.substring(2);
      int dot = version.indexOf('.');
      String major = dot < 0 ? version : version.substring(0, dot);
      return major.isBlank() ? null : major;
    } catch (IOException e) {
      return null;
    }
  }

  private static List<Path> commonHomes() {
    List<Path> homes = new ArrayList<>();
    String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    String userHome = System.getProperty("user.home");
    if (os.contains("win")) {
      String programFiles = firstNonBlank(System.getenv("ProgramFiles"), System.getenv("ProgramW6432"));
      if (programFiles != null) {
        Path base = Path.of(programFiles);
        homes.addAll(children(base.resolve("Java"), null));
        homes.addAll(children(base.resolve("Eclipse Adoptium"), null));
        homes.addAll(children(base.resolve("Microsoft"), name -> name.toLowerCase(Locale.ROOT).startsWith("jdk")));
        homes.addAll(children(base.resolve("Zulu"), null));
      }
      String localAppData = System.getenv("LOCALAPPDATA");
      if (localAppData != null) homes.addAll(children(Path.of(localAppData, "Programs", "Eclipse Adoptium"), null));
      if (userHome != null) homes.addAll(children(Path.of(userHome, ".jdks"), null));
    } else if (os.contains("mac")) {
      for (Path bundle : children(Path.of("/Library/Java/JavaVirtualMachines"), null)) {
        homes.add(bundle.resolve("Contents/Home"));
      }
      if (userHome != null) homes.addAll(children(Path.of(userHome, ".jdks"), null));
    } else {
      homes.addAll(children(Path.of("/usr/lib/jvm"), null));
      if (userHome != null) homes.addAll(children(Path.of(userHome, ".jdks"), null));
    }
    return homes;
  }

  /** 子目录按名称倒序（新版本优先）；filter 为 null 时不过滤。 */
  private static List<Path> children(Path parent, Predicate<String> filter) {
    if (!Files.isDirectory(parent)) return List.of();
    List<Path> result = new ArrayList<>();
    try (DirectoryStream<Path> stream = Files.newDirectoryStream(parent)) {
      for (Path entry : stream) {
        if (!Files.isDirectory(entry)) continue;
        String name = entry.getFileName().toString();
        if (filter != null && !filter.test(name)) continue;
        result.add(entry);
      }
    } catch (IOException e) {
      return List.of();
    }
    result.sort(Comparator.comparing((Path path) -> path.getFileName().toString()).reversed());
    return result;
  }

  private static String firstNonBlank(String... values) {
    for (String value : values) {
      if (value != null && !value.isBlank()) return value;
    }
    return null;
  }
}
