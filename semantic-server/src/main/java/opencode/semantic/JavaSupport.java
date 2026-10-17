package opencode.semantic;

import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.WriteAction;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.module.ModuleManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.projectRoots.JavaSdk;
import com.intellij.openapi.projectRoots.ProjectJdkTable;
import com.intellij.openapi.projectRoots.Sdk;
import com.intellij.openapi.roots.ContentEntry;
import com.intellij.openapi.roots.ModifiableRootModel;
import com.intellij.openapi.roots.ModuleRootManager;
import com.intellij.openapi.roots.ProjectRootManager;
import com.intellij.openapi.vfs.VfsUtil;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Locale;

/**
 * Java 能力：探测 + 项目 SDK 指派 + Java source root 补齐。plugin.xml 里 com.intellij.modules.java
 * 已改为 optional，无 Java 模块的发行版（PyCharm/WebStorm）下 available() 为 false，所有 Java 专有路径
 * 跳过并降级。
 */
final class JavaSupport {
  private static final String SDK_NAME = "semantic-jdk";
  /** content root 下寻找布局根的深度上限：只访问 content root 与其一层子目录
   *  （`<module>/src/main/java` 相对 content root 为 4 层，恰在界内）。 */
  private static final int SOURCE_ROOT_WALK_DEPTH = 1;
  private static final int SOURCE_ROOT_VISIT_CAP = 50;
  private static Boolean available;

  private JavaSupport() {}

  /** 以 java 插件标记类做能力探测，结果缓存一次；探测失败返回 false。 */
  static synchronized boolean available() {
    if (available == null) {
      try {
        Class.forName("com.intellij.psi.JavaPsiFacade", false, JavaSupport.class.getClassLoader());
        available = true;
      } catch (Throwable t) {
        available = false;
      }
    }
    return available;
  }

  /** 项目缺 SDK 且发行版具备 Java 能力时，发现 JDK → 复用/创建 semantic-jdk → setProjectSdk。
   *  EDT + WriteAction 内执行，任何失败仅告警（不阻塞守护启动）。 */
  static void assignProjectSdk(Project project) {
    if (!available()) {
      Log.info("java support unavailable; skip project SDK assignment");
      return;
    }
    try {
      if (ProjectRootManager.getInstance(project).getProjectSdk() != null) return;
      Path jdkHome = JdkDiscovery.home();
      if (jdkHome == null) {
        Log.warn("no JDK found (SEMANTIC_JDK_HOME/JAVA_HOME/common dirs); skip project SDK assignment");
        return;
      }
      boolean isJre =
          !Files.isRegularFile(jdkHome.resolve("bin/javac")) && !Files.isRegularFile(jdkHome.resolve("bin/javac.exe"));
      Application application = ApplicationManager.getApplication();
      Runnable assign =
          () ->
              WriteAction.run(
                  () -> {
                    ProjectJdkTable table = ProjectJdkTable.getInstance();
                    // Launcher 或上次指派写入的 jdk.table.xml 条目会被 findJdk 直接复用
                    Sdk jdk = table.findJdk(SDK_NAME);
                    if (jdk == null) {
                      jdk = JavaSdk.getInstance().createJdk(SDK_NAME, jdkHome.toString(), isJre);
                      table.addJdk(jdk);
                    }
                    ProjectRootManager.getInstance(project).setProjectSdk(jdk);
                  });
      if (application.isDispatchThread()) assign.run();
      else application.invokeAndWait(assign);
      Log.info("project SDK assigned: " + SDK_NAME + " -> " + jdkHome);
    } catch (Throwable t) {
      Log.warn("failed to assign project SDK: " + t);
    }
  }

  /** 补齐 Java source root：SDK 指派是必要而非充分条件——PsiShortNamesCache 只遍历 Java source
   *  root，仓库根 `WEB_MODULE` iml 与裸目录默认模块都没有 source root，项目类因此仍不可解析。
   *  逐模块 content entry：已有 source root 的不动；否则在 content root 下（有界：深度 ≤4、
   *  跳过隐藏与排除默认目录、最多访问 50 个目录）找 `src/main/java` / `src/test/java` 并添加；
   *  都没有但存在 `.java` 文件时把 content root 本身加为 source root（覆盖裸 A.java/B.java 目录）。
   *  不做模块类型转换；EDT + WriteAction，幂等，失败仅告警。 */
  static void ensureJavaSourceRoots(Project project, Path projectPath) {
    if (!available()) {
      Log.info("java support unavailable; skip java source root setup");
      return;
    }
    try {
      Application application = ApplicationManager.getApplication();
      Runnable ensure =
          () ->
              WriteAction.run(
                  () -> {
                    ModuleManager moduleManager = ModuleManager.getInstance(project);
                    Module[] modules = moduleManager.getModules();
                    Log.info("java source root pass: modules=" + modules.length + " project=" + projectPath);
                    if (modules.length == 0) {
                      // 裸目录项目：headless 打开目录时平台不会建模块（module-less shell），
                      // 先落盘 JAVA_MODULE iml（含 content root/布局根）再 loadModule，
                      // PsiShortNamesCache 才有 Java source root 可遍历
                      createProjectModule(moduleManager, projectPath);
                    }
                    for (Module module : moduleManager.getModules()) {
                      ensureModuleSourceRoots(module);
                    }
                  });
      if (application.isDispatchThread()) ensure.run();
      else application.invokeAndWait(ensure);
      Log.info("java source roots ensured for " + projectPath);
    } catch (Throwable t) {
      Log.warn("failed to ensure java source roots: " + t);
    }
  }

  /** 为无模块项目落盘 JAVA_MODULE iml（`<project>/.idea/<name>.iml`，`$MODULE_DIR$` = 项目根）
   *  并 loadModule。内容形状对齐 sample-project：content root + 扫描到的布局根 sourceFolder
   *  （无布局根但有 `.java` 文件时把 content root 本身作为 sourceFolder）。
   *  仅当平台未创建任何模块且项目确有 Java 证据时调用；失败仅告警。 */
  private static void createProjectModule(ModuleManager moduleManager, Path projectPath) {
    JavaRootScan scan = scanJavaRoots(projectPath);
    if (scan.layoutRoots().isEmpty() && !scan.hasJavaFile()) {
      Log.info("no java evidence under " + projectPath + "; skip module creation");
      return;
    }
    String name = projectPath.getFileName() == null ? "project" : projectPath.getFileName().toString();
    Path ideaDir = projectPath.resolve(".idea");
    Path moduleFile = ideaDir.resolve(name + ".iml");
    try {
      if (!Files.exists(moduleFile)) {
        Files.createDirectories(ideaDir);
        Files.writeString(moduleFile, moduleFileXml(projectPath, scan), StandardCharsets.UTF_8);
      }
      Module module = moduleManager.loadModule(moduleFile);
      if (module == null) {
        Log.warn("failed to load module from " + moduleFile);
        return;
      }
      Log.info("java module loaded: " + module.getName() + " (" + moduleFile + ")");
    } catch (Throwable t) {
      Log.warn("failed to create module for " + projectPath + ": " + t);
    }
  }

  private static String moduleFileXml(Path projectPath, JavaRootScan scan) {
    StringBuilder sources = new StringBuilder();
    if (scan.layoutRoots().isEmpty()) {
      sources.append("      <sourceFolder url=\"file://$MODULE_DIR$\" isTestSource=\"false\" />\n");
    } else {
      for (Path layoutRoot : scan.layoutRoots()) {
        String relative = projectPath.relativize(layoutRoot).toString().replace('\\', '/');
        sources
            .append("      <sourceFolder url=\"file://$MODULE_DIR$/")
            .append(relative)
            .append("\" isTestSource=\"")
            .append(isTestLayoutRoot(layoutRoot))
            .append("\" />\n");
      }
    }
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        + "<module type=\"JAVA_MODULE\" version=\"4\">\n"
        + "  <component name=\"NewModuleRootManager\" inherit-compiler-output=\"true\">\n"
        + "    <exclude-output />\n"
        + "    <content url=\"file://$MODULE_DIR$\">\n"
        + sources
        + "    </content>\n"
        + "    <orderEntry type=\"inheritedJdk\" />\n"
        + "    <orderEntry type=\"sourceFolder\" forTests=\"false\" />\n"
        + "  </component>\n"
        + "</module>\n";
  }

  private static void ensureModuleSourceRoots(Module module) {
    ModifiableRootModel model = ModuleRootManager.getInstance(module).getModifiableModel();
    boolean committed = false;
    try {
      boolean dirty = false;
      for (ContentEntry entry : model.getContentEntries()) {
        VirtualFile root = entry.getFile();
        if (root == null) continue;
        // 已有 source root（如 sample-project 已提交 src/main/java）：不触碰既有配置
        if (entry.getSourceFolders().length > 0) {
          Log.info("java source root check: " + root.getPath() + " already has "
              + entry.getSourceFolders().length + " source root(s); left untouched");
          continue;
        }
        Path contentRoot = Path.of(root.getPath());
        JavaRootScan scan = scanJavaRoots(contentRoot);
        if (scan.layoutRoots().isEmpty()) {
          if (scan.hasJavaFile()) {
            entry.addSourceFolder(root, false);
            dirty = true;
            Log.info("java source root added: " + root.getPath() + " (bare content root, module " + module.getName() + ")");
          }
          continue;
        }
        for (Path layoutRoot : scan.layoutRoots()) {
          VirtualFile dir = VfsUtil.findFileByIoFile(layoutRoot.toFile(), true);
          if (dir == null) continue;
          entry.addSourceFolder(dir, isTestLayoutRoot(layoutRoot));
          dirty = true;
          Log.info("java source root added: " + dir.getPath() + " (module " + module.getName() + ")");
        }
      }
      if (dirty) {
        model.commit();
        committed = true;
      }
    } finally {
      if (!committed) {
        try {
          model.dispose();
        } catch (Throwable ignored) {
        }
      }
    }
  }

  /** content root 有界扫描结果：找到的布局根（src/main|test/java）+ 是否出现 `.java` 文件。 */
  private record JavaRootScan(List<Path> layoutRoots, boolean hasJavaFile) {}

  /** 有界扫描：最多访问 {@link #SOURCE_ROOT_VISIT_CAP} 个目录，只访问 content root 与其一层子目录
   *  （布局根相对 content root ≤4 层）；跳过 `.` 隐藏目录与排除默认目录（Exclusions.DEFAULTS）。 */
  private static JavaRootScan scanJavaRoots(Path contentRoot) {
    List<Path> layoutRoots = new ArrayList<>();
    boolean hasJavaFile = false;
    Deque<Path> dirs = new ArrayDeque<>();
    Deque<Integer> depths = new ArrayDeque<>();
    dirs.add(contentRoot);
    depths.add(0);
    int visited = 0;
    while (!dirs.isEmpty() && visited < SOURCE_ROOT_VISIT_CAP) {
      Path dir = dirs.poll();
      int depth = depths.poll();
      visited++;
      Path mainRoot = dir.resolve("src/main/java");
      Path testRoot = dir.resolve("src/test/java");
      if (Files.isDirectory(mainRoot)) layoutRoots.add(mainRoot);
      if (Files.isDirectory(testRoot)) layoutRoots.add(testRoot);
      try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
        for (Path entry : stream) {
          String name = entry.getFileName().toString();
          if (name.startsWith(".")) continue;
          if (Files.isDirectory(entry)) {
            if (depth < SOURCE_ROOT_WALK_DEPTH && !Exclusions.DEFAULTS.contains(name.toLowerCase(Locale.ROOT))) {
              dirs.add(entry);
              depths.add(depth + 1);
            }
            continue;
          }
          if (!hasJavaFile && name.toLowerCase(Locale.ROOT).endsWith(".java")) hasJavaFile = true;
        }
      } catch (IOException ignored) {
        // 不可读目录跳过
      }
    }
    return new JavaRootScan(layoutRoots, hasJavaFile);
  }

  private static boolean isTestLayoutRoot(Path layoutRoot) {
    return layoutRoot.toString().replace('\\', '/').endsWith("src/test/java");
  }
}
