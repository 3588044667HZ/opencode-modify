package opencode.semantic;

import com.intellij.ide.plugins.PluginMainDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.ide.plugins.PluginSet;
import com.intellij.openapi.application.ApplicationInfo;
import com.intellij.openapi.extensions.PluginId;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;
import java.util.zip.ZipFile;

/**
 * 发行版健康探测：用户本机安装的 JetBrains IDE 可能不完整（例如 content module 的
 * 实现 jar 整体缺失），平台会在模块类型懒初始化时抛 ClassNotFoundException，级联到索引中断
 * 与全请求失败。探测只在项目打开时执行一次，用插件 jar 内的类文件条目做存在性检查
 * （不经 Class.forName：插件类加载器隔离会让跨插件类即使存在也解析失败，产生误报）。
 * 只报告发行版自身是否完整；不做任何下载/修复动作（License Boundary）。
 */
final class DistHealth {
  /** PyCharm 家族 content module 的标记类：实现 jar 缺失时的首选证据。 */
  private static final String PYTHON_IMPL_CLASS = "com.intellij.pycharm.community.ide.impl.PyProjectScopeBuilder";
  private static final String PYTHON_IMPL_RESOURCE =
      "com/intellij/pycharm/community/ide/impl/PyProjectScopeBuilder.class";
  /** Python PSI 入口：python-ce 插件缺失/被裁剪时的补充证据。 */
  private static final String PYTHON_PSI_CLASS = "com.jetbrains.python.psi.PyFile";
  private static final String PYTHON_PSI_RESOURCE = "com/jetbrains/python/psi/PyFile.class";
  /** content module intellij.pycharm.community.ide.impl 的父插件（descriptor 日志可证）。 */
  private static final String PYCHARM_SHARED_PLUGIN = "intellij.pycharm.community.customization.shared";
  private static final String PYTHON_CORE_PLUGIN = "PythonCore";
  static final String REINSTALL_HINT = "reinstall or repair the IDE installation";
  private static final int JAR_SCAN_CAP = 2000;

  private static volatile boolean probed;
  /** 非空表示发行版存在不完整语言支持，如 "python support incomplete (missing X)"；null = 健康。 */
  private static volatile String incompleteSupport;

  private DistHealth() {}

  /** 项目打开后调用一次：PyCharm 家族校验 Python 支持；Java 能力发行版沿用 JavaSupport 探测并记日志。 */
  static synchronized void probe() {
    if (probed) return;
    probed = true;
    try {
      String productCode = productCode();
      if ("PY".equalsIgnoreCase(productCode) || "PC".equalsIgnoreCase(productCode)) {
        List<String> missing = new ArrayList<>();
        if (!classFilePresent(PYCHARM_SHARED_PLUGIN, PYTHON_IMPL_RESOURCE)) missing.add(PYTHON_IMPL_CLASS);
        if (!classFilePresent(PYTHON_CORE_PLUGIN, PYTHON_PSI_RESOURCE)) missing.add(PYTHON_PSI_CLASS);
        if (missing.isEmpty()) {
          Log.info("dist health: python support complete (productCode=" + productCode + ")");
        } else {
          incompleteSupport = "python support incomplete (missing " + String.join(", ", missing) + ")";
          Log.warn("dist health: " + incompleteSupport + "; " + REINSTALL_HINT);
        }
        return;
      }
      Log.info(
          "dist health: productCode=" + (productCode == null ? "?" : productCode)
              + " java support=" + JavaSupport.available() + " python support=n/a");
    } catch (Throwable t) {
      Log.warn("dist health: probe failed: " + t);
    }
  }

  /** 错误信息追加段：`; <problem>; reinstall or repair...`；健康时为空串。 */
  static String supportHint() {
    String problem = incompleteSupport;
    if (problem == null) return "";
    return "; " + problem + "; " + REINSTALL_HINT;
  }

  /** 是否存在不完整的 Python 支持（用于 Python 符号解析失败时追加修复提示）。 */
  static boolean pythonIncomplete() {
    String problem = incompleteSupport;
    return problem != null && problem.startsWith("python support incomplete");
  }

  /** 类文件存在性：先扫插件自身目录（快路径），未命中再对 IDE plugins 有界全扫兜底（防打包布局差异误报）。 */
  private static boolean classFilePresent(String pluginId, String classResource) {
    try {
      PluginSet pluginSet = PluginManagerCore.getPluginSet();
      if (pluginSet == null) return true; // 无法判定时按健康处理（不误报）
      PluginMainDescriptor plugin = pluginSet.findInstalledPlugin(PluginId.getId(pluginId));
      if (plugin == null) return false; // 插件本体缺失
      Path pluginPath = plugin.getPluginPath();
      if (pluginPath != null && jarContains(pluginPath, classResource)) return true;
      Path home = ideHome();
      return home == null || jarContains(home.resolve("plugins"), classResource);
    } catch (Throwable t) {
      Log.warn("dist health: class presence probe failed (" + pluginId + "): " + t);
      return true;
    }
  }

  /** 有界扫描目录下所有 jar 的条目表（不解压内容），命中类文件即返回。 */
  private static boolean jarContains(Path root, String classResource) {
    if (!Files.isDirectory(root)) return false;
    List<Path> jars;
    try (Stream<Path> stream = Files.walk(root, 6)) {
      jars =
          stream
              .filter(path -> path.getFileName().toString().endsWith(".jar"))
              .sorted(Comparator.comparing(Path::toString))
              .toList();
    } catch (IOException e) {
      return false;
    }
    int scanned = 0;
    for (Path jar : jars) {
      if (scanned++ >= JAR_SCAN_CAP) break;
      try (ZipFile zip = new ZipFile(jar.toFile())) {
        if (zip.getEntry(classResource) != null) return true;
      } catch (IOException ignored) {
        // 损坏的 jar 跳过
      }
    }
    return false;
  }

  private static Path ideHome() {
    String home = System.getProperty("idea.home.path");
    if (home == null || home.isBlank()) return null;
    Path path = Path.of(home);
    return Files.isDirectory(path) ? path : null;
  }

  private static String productCode() {
    return ApplicationInfo.getInstance().getBuild().getProductCode();
  }
}
