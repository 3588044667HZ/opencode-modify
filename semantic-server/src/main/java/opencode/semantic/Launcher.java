package opencode.semantic;

import java.io.IOException;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;

/**
 * 可执行入口，支持冻结接口的 CLI 形式：
 *   java -Djava.awt.headless=true -jar semantic-server.jar <project_path> <socket_path> [--idle-seconds N]
 *
 * 平台无法从单个插件 jar 内部引导，因此 Launcher 负责：
 *   1. 定位本地 IDEA（环境变量 IDEA_HOME / IDEA_DIR，默认 D:/IntelliJ IDEA 2026.2.0.1）
 *   2. 把自身作为插件安装到 sandbox（默认 ~/.opencode-semantic/sandbox，可用 SEMANTIC_SANDBOX 覆盖）
 *   3. 用 IDEA 自带 JBR 以 run-local.sh 相同的 VM 参数拉起 com.intellij.idea.Main semantic-server ...
 */
public final class Launcher {
  private Launcher() {}

  public static void main(String[] args) throws IOException, InterruptedException, URISyntaxException {
    List<String> argv = new ArrayList<>(List.of(args));
    if (argv.isEmpty()) {
      System.err.println("usage: java -jar semantic-server.jar <project_path> <socket_path> [--idle-seconds N]");
      System.exit(2);
    }

    Path ideaDir = resolveIdeaDir();
    if (ideaDir == null) {
      System.err.println("ERROR: cannot locate IntelliJ IDEA; set IDEA_HOME (e.g. D:/IntelliJ IDEA 2026.2.0.1)");
      System.exit(2);
    }
    Path javaExe = ideaDir.resolve("jbr/bin/java.exe");
    if (!Files.isExecutable(javaExe)) javaExe = ideaDir.resolve("jbr/bin/java");
    if (!Files.isExecutable(javaExe)) {
      System.err.println("ERROR: no JBR found at " + ideaDir.resolve("jbr"));
      System.exit(2);
    }

    Path sandbox = resolveSandbox();
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
    command.add("-Didea.paths.selector=IntelliJIdea2026.2");
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
    Process process = builder.start();
    System.exit(process.waitFor());
  }

  private static Path resolveIdeaDir() {
    for (String candidate :
        new String[] {
          System.getenv("IDEA_HOME"), System.getenv("IDEA_DIR"), "D:/IntelliJ IDEA 2026.2.0.1"
        }) {
      if (candidate == null || candidate.isBlank()) continue;
      Path path = Path.of(candidate);
      if (Files.isDirectory(path.resolve("lib")) && Files.isDirectory(path.resolve("jbr"))) return path;
    }
    return null;
  }

  private static Path resolveSandbox() {
    String override = System.getenv("SEMANTIC_SANDBOX");
    if (override != null && !override.isBlank()) return Path.of(override).toAbsolutePath().normalize();
    return Path.of(System.getProperty("user.home"), ".opencode-semantic", "sandbox");
  }

  /** sample-project 的 .idea/misc.xml 引用 semantic-jdk，首次运行生成 jdk.table.xml。
   *  classPath 必须写具体 jrt roots（每个 jmod 一个），否则 headless 下 java.lang.* 无法解析。 */
  private static void ensureJdkTable(Path sandbox) throws IOException {
    Path jdkTable = sandbox.resolve("config/options/jdk.table.xml");
    if (Files.exists(jdkTable)) return;
    String jdkHome = System.getenv("SEMANTIC_JDK_HOME");
    if (jdkHome == null || jdkHome.isBlank()) jdkHome = "D:/jdk25";
    Path jdkDir = Path.of(jdkHome);
    if (!Files.isDirectory(jdkDir)) return;
    Files.createDirectories(jdkTable.getParent());

    StringBuilder classPath = new StringBuilder();
    Path jmods = jdkDir.resolve("jmods");
    if (Files.isDirectory(jmods)) {
      try (var stream = Files.list(jmods)) {
        for (Path jmod : stream.filter(p -> p.getFileName().toString().endsWith(".jmod")).sorted().toList()) {
          String name = jmod.getFileName().toString().replaceAll("\\.jmod$", "");
          classPath
              .append("            <root type=\"jrt\" url=\"jrt://")
              .append(jdkHome)
              .append("!/")
              .append(name)
              .append("\" />\n");
        }
      }
    }

    Files.writeString(
        jdkTable,
        "<application>\n"
            + "  <component name=\"ProjectJdkTable\">\n"
            + "    <jdk version=\"2\">\n"
            + "      <name value=\"semantic-jdk\" />\n"
            + "      <type value=\"JavaSDK\" />\n"
            + "      <version value=\"java version &quot;25&quot;\" />\n"
            + "      <homePath value=\""
            + jdkHome
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
}
