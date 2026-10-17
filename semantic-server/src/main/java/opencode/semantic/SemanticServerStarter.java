package opencode.semantic;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.ide.trustedProjects.TrustedProjects;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModernApplicationStarter;
import com.intellij.openapi.application.WriteAction;
import com.intellij.openapi.module.Module;
import com.intellij.openapi.module.ModuleManager;
import com.intellij.openapi.project.DumbService;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;
import com.intellij.openapi.roots.ContentEntry;
import com.intellij.openapi.roots.ModifiableRootModel;
import com.intellij.openapi.roots.ModuleRootEvent;
import com.intellij.openapi.roots.ModuleRootListener;
import com.intellij.openapi.roots.ModuleRootManager;
import com.intellij.openapi.vfs.VfsUtil;
import com.intellij.openapi.vfs.VfsUtilCore;
import com.intellij.openapi.vfs.VirtualFile;
import kotlin.Unit;
import kotlin.coroutines.Continuation;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * 命令名 semantic-server（appStarter EP id）。
 * 用法: java -Djava.awt.headless=true -jar semantic-server.jar <project_path> <locator_path> [--idle-seconds N]
 * 平台启动方式: com.intellij.idea.Main semantic-server <project> <locator> --idle-seconds N
 *
 * 继承 ModernApplicationStarter：其 start() 在非 EDT 上下文中执行（requiredModality=NOT_IN_EDT），
 * 因此可以安全地在此线程长时间等待；classic ApplicationStarter.main 会在 EDT 上执行，阻塞会导致平台挂死。
 */
public final class SemanticServerStarter extends ModernApplicationStarter {
  private static final long DEFAULT_IDLE_SECONDS = 1800;

  @Override
  public boolean isHeadless() {
    return true;
  }

  @Override
  public Object start(List<String> args, Continuation<? super Unit> continuation) {
    List<String> argv = new ArrayList<>(args);
    if (!argv.isEmpty() && "semantic-server".equals(argv.get(0))) argv.remove(0);

    String projectArg = null;
    String locatorArg = null;
    Long idleSecondsArg = null;
    for (int i = 0; i < argv.size(); i++) {
      String arg = argv.get(i);
      try {
        if ("--idle-seconds".equals(arg) && i + 1 < argv.size()) {
          idleSecondsArg = parseIdleSeconds(argv.get(++i));
        } else if (arg.startsWith("--idle-seconds=")) {
          idleSecondsArg = parseIdleSeconds(arg.substring("--idle-seconds=".length()));
        } else if (projectArg == null) {
          projectArg = arg;
        } else if (locatorArg == null) {
          locatorArg = arg;
        }
      } catch (IllegalArgumentException e) {
        Log.error(e.getMessage(), null);
        Runtime.getRuntime().halt(2);
      }
    }

    if (projectArg == null || locatorArg == null) {
      Log.error("usage: semantic-server <project_path> <locator_path> [--idle-seconds N]", null);
      Runtime.getRuntime().halt(2);
    }

    // --idle-seconds 优先；缺省时回退 OPENCODE_SEMANTIC_IDLE_TIMEOUT_MS（毫秒，向上取整到秒）
    long idleSeconds = idleSecondsArg != null ? idleSecondsArg : idleSecondsFromEnv();

    Path projectPath = Path.of(projectArg).toAbsolutePath().normalize();
    if (!Files.isDirectory(projectPath)) {
      Log.error("project path is not a directory: " + projectPath, null);
      Runtime.getRuntime().halt(2);
    }
    Path locatorPath = Path.of(locatorArg).toAbsolutePath().normalize();
    Path locatorParent = locatorPath.getParent();
    if (locatorParent == null || !Files.isDirectory(locatorParent)) {
      Log.error("locator directory does not exist: " + locatorParent, null);
      Runtime.getRuntime().halt(2);
    }

    Log.info("starting semantic-server project=" + projectPath + " locator=" + locatorPath
        + " idle=" + idleSeconds + "s");

    // 启动恢复：先重放/清理 edit_transaction 的 journal，失败则置只读（-32018），守护照常启动。
    // 必须在 RPC server 开始服务写请求之前完成。
    EditTransactionService.recoverJournals(projectPath);

    IndexMonitor monitor = new IndexMonitor();
    // 语言能力探测：project_map/blast_radius 在 Java/Python/JS-TS 能力任一可用时开放；
    // 三者都不可用时返回明确错误，不实例化语言专有路径。
    boolean javaSupport = JavaSupport.available();
    boolean pythonSupport = PythonSupport.available();
    boolean javascriptSupport = JavaScriptSupport.available();
    // read_view 是语言无关聚合：Java/Python 专有解析在服务内部按语言降级
    ReadViewService readViewService = new ReadViewService();
    BlastRadiusService blastRadiusService = new BlastRadiusService();
    EditBatchService editBatchService = new EditBatchService();
    EditTransactionService editTransactionService = new EditTransactionService();
    VerifyTestService verifyTestService = new VerifyTestService();
    ProjectMapService projectMapService = new ProjectMapService();

    JsonRpcServer[] serverRef = new JsonRpcServer[1];
    JsonRpcServer.Handler handler =
        (client, method, params) -> {
          switch (method) {
            case "ping":
              return monitor.snapshot();
            case "subscribe": {
              client.subscribe();
              JsonRpcServer server = serverRef[0];
              if (server != null) {
                server.sendNotification(client, "notifications/indexing", monitor.notificationParams());
              }
              return ok();
            }
            case "read_view": {
              Project project = monitor.getProject();
              // monitor.isIndexing() 覆盖扫描/索引之间的间隙（DumbService 采样不到该窗口），
              // 避免在后台写操作进行时进入读动作而长时间等待
              if (project == null || monitor.isIndexing() || DumbService.isDumb(project)) {
                throw new JsonRpcServer.RpcException(-32000, "indexing", monitor.errorData());
              }
              return readViewService.readView(project, projectPath.toString(), params);
            }
            case "blast_radius": {
              requireSemanticSupport(javaSupport, pythonSupport, javascriptSupport);
              Project project = monitor.getProject();
              if (project == null || monitor.isIndexing() || DumbService.isDumb(project)) {
                throw new JsonRpcServer.RpcException(-32000, "indexing", monitor.errorData());
              }
              return blastRadiusService.blastRadius(project, projectPath.toString(), params);
            }
            case "edit_batch": {
              Project project = monitor.getProject();
              if (project == null || monitor.isIndexing() || DumbService.isDumb(project)) {
                throw new JsonRpcServer.RpcException(-32000, "indexing", monitor.errorData());
              }
              return editBatchService.editBatch(project, projectPath.toString(), params);
            }
            case "edit_transaction": {
              Project project = monitor.getProject();
              if (project == null || monitor.isIndexing() || DumbService.isDumb(project)) {
                throw new JsonRpcServer.RpcException(-32000, "indexing", monitor.errorData());
              }
              return editTransactionService.editTransaction(project, projectPath.toString(), params);
            }
            case "verify_test": {
              Project project = monitor.getProject();
              if (project == null || monitor.isIndexing() || DumbService.isDumb(project)) {
                throw new JsonRpcServer.RpcException(-32000, "indexing", monitor.errorData());
              }
              return verifyTestService.verifyTest(projectPath.toString(), params);
            }
            case "project_map": {
              requireSemanticSupport(javaSupport, pythonSupport, javascriptSupport);
              Project project = monitor.getProject();
              if (project == null || monitor.isIndexing() || DumbService.isDumb(project)) {
                throw new JsonRpcServer.RpcException(-32000, "indexing", monitor.errorData());
              }
              return projectMapService.projectMap(project, projectPath.toString(), params);
            }
            case "shutdown": {
              JsonRpcServer server = serverRef[0];
              new Thread(
                      () -> {
                        try {
                          Thread.sleep(200);
                        } catch (InterruptedException ignored) {
                          Thread.currentThread().interrupt();
                        }
                        if (server != null) server.requestStop();
                      },
                      "semantic-shutdown")
                  .start();
              return ok();
            }
            default:
              throw new JsonRpcServer.RpcException(-32601, "method not found", null);
          }
        };

    JsonRpcServer server = new JsonRpcServer(locatorPath, handler, idleSeconds * 1000L);
    serverRef[0] = server;
    try {
      server.start();
    } catch (IOException e) {
      Log.error("failed to start rpc server (locator " + locatorPath + ")", e);
      Runtime.getRuntime().halt(2);
      return Unit.INSTANCE;
    }
    monitor.attachServer(server);
    monitor.start();

    Runtime.getRuntime().addShutdownHook(new Thread(server::requestStop, "semantic-shutdown-hook"));

    Thread projectOpener = new Thread(() -> openProject(projectPath, monitor), "semantic-project-opener");
    projectOpener.setDaemon(true);
    projectOpener.start();

    try {
      server.awaitStop();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      server.requestStop();
    }

    Project project = monitor.getProject();
    if (project != null) {
      try {
        Application application = ApplicationManager.getApplication();
        if (application != null) {
          application.invokeAndWait(() -> ProjectManager.getInstance().closeAndDispose(project));
        }
      } catch (Throwable t) {
        Log.warn("failed to close project: " + t);
      }
    }
    Log.info("semantic-server stopped");
    exitApplication();
    return Unit.INSTANCE;
  }

  private static JsonObject ok() {
    JsonObject result = new JsonObject();
    result.addProperty("ok", true);
    return result;
  }

  /** 语义工具在无任何受支持语言能力（Java/Python/JS-TS）的发行版上返回明确错误；
   *  发行版存在不完整语言支持时附加 "reinstall or repair" 提示（DistHealth）。 */
  private static void requireSemanticSupport(
      boolean javaSupport, boolean pythonSupport, boolean javascriptSupport)
      throws JsonRpcServer.RpcException {
    if (!javaSupport && !pythonSupport && !javascriptSupport) {
      throw new JsonRpcServer.RpcException(
          -32603,
          "java/python/javascript support unavailable in this IDE distribution"
              + DistHealth.supportHint(),
          null);
    }
  }

  private static void openProject(Path projectPath, IndexMonitor monitor) {
    try {
      try {
        TrustedProjects.setProjectTrusted(projectPath, true);
      } catch (Throwable t) {
        Log.warn("could not pre-trust project: " + t);
      }
      Project project = ProjectManager.getInstance().loadAndOpenProject(projectPath.toString());
      if (project == null) {
        Log.error("failed to open project " + projectPath, null);
        return;
      }
      monitor.setProject(project);
      applyExclusions(project, projectPath);
      // 裸目录项目没有 .idea/misc.xml：缺 SDK 时按发现顺序指派 semantic-jdk（无 Java 能力或失败仅告警）
      JavaSupport.assignProjectSdk(project);
      // SDK 必要但不充分：仓库根 WEB_MODULE iml / 裸目录默认模块没有 Java source root，
      // PsiShortNamesCache 遍历不到，项目类仍不可解析——在 SDK 指派的同一步补齐 source root
      JavaSupport.ensureJavaSourceRoots(project, projectPath);
      // 发行版完整性探测（一次性）：不完整的 IDE 安装（实现 jar 缺失）会让分析节降级，
      // 这里落一条明确日志，错误信息可据此附 reinstall 提示
      DistHealth.probe();
      Log.info("project opened: " + project.getName() + " (" + project.getBasePath() + ")");
    } catch (Throwable t) {
      Log.error("failed to open project " + projectPath, t);
    }
  }

  // ---- 目录排除（内置 defaults ∪ OPENCODE_SEMANTIC_EXCLUDE） ----

  /** 项目模型排除对账：上次应用的相对路径 − 本次匹配 = stale（仍存在则移除）；本次匹配幂等新增；
   *  实际生效的列表写回 <sandbox>/exclusions.json。模型修改在 EDT + WriteAction 内，失败仅记日志。 */
  private static void applyExclusions(Project project, Path projectPath) {
    try {
      Path stateFile = Launcher.exclusionsSandbox(projectPath.toString()).resolve("exclusions.json");
      Set<String> previous = new TreeSet<>(readApplied(stateFile));
      List<String> current =
          Exclusions.matchingDirs(projectPath).stream()
              .map(path -> projectPath.relativize(path).toString().replace('\\', '/'))
              .toList();
      Set<String> stale = new TreeSet<>(previous);
      stale.removeAll(current);
      if (current.isEmpty() && stale.isEmpty()) {
        Log.info("exclusions: no matched directories (patterns=" + Exclusions.active() + ")");
        return;
      }
      Set<String> applied = new TreeSet<>();
      Application application = ApplicationManager.getApplication();
      Runnable reconcile =
          () -> WriteAction.run(() -> reconcileModel(project, projectPath, current, stale, applied));
      if (application.isDispatchThread()) reconcile.run();
      else application.invokeAndWait(reconcile);

      writeApplied(stateFile, applied);
      Log.info("exclusions applied: " + applied + (stale.isEmpty() ? "" : " (stale: " + stale + ")"));

      // 热启动时平台会在项目打开后异步把 iml 项目状态同步进 workspace model，可能覆盖本次修改；
      // 监听模块根变化，发现遗漏/残留时幂等重放（自身 commit 触发的复核不会再次写入）。
      project
          .getMessageBus()
          .connect(project)
          .subscribe(
              ModuleRootListener.TOPIC,
              new ModuleRootListener() {
                @Override
                public void rootsChanged(ModuleRootEvent event) {
                  Application app = ApplicationManager.getApplication();
                  if (app == null) return;
                  Runnable verify =
                      () -> {
                        Set<String> before = new TreeSet<>(applied);
                        try {
                          reconcile.run();
                          if (!applied.equals(before)) writeApplied(stateFile, applied);
                        } catch (Throwable t) {
                          Log.warn("failed to re-apply directory exclusions: " + t);
                        }
                      };
                  if (app.isDispatchThread()) verify.run();
                  else app.invokeLater(verify);
                }
              });
    } catch (Throwable t) {
      Log.warn("failed to apply directory exclusions: " + t);
    }
  }

  /** 一次幂等对账：content root 下命中的目录补排除、stale 移除；仅在确有变化时 commit 模型。 */
  private static void reconcileModel(
      Project project, Path projectPath, List<String> current, Set<String> stale, Set<String> applied) {
    Map<String, VirtualFile> resolved = new HashMap<>();
    for (String relative : current) resolved.put(relative, resolveDir(projectPath, relative));
    for (String relative : stale) resolved.put(relative, resolveDir(projectPath, relative));
    for (Module module : ModuleManager.getInstance(project).getModules()) {
      ModifiableRootModel model = ModuleRootManager.getInstance(module).getModifiableModel();
      boolean committed = false;
      try {
        boolean dirty = false;
        for (ContentEntry entry : model.getContentEntries()) {
          VirtualFile root = entry.getFile();
          if (root == null) continue;
          for (String relative : current) {
            VirtualFile dir = resolved.get(relative);
            if (dir == null || !VfsUtilCore.isAncestor(root, dir, true)) continue;
            if (!entry.getExcludeFolderUrls().contains(dir.getUrl())) {
              entry.addExcludeFolder(dir);
              dirty = true;
            }
            applied.add(relative);
          }
          for (String relative : stale) {
            VirtualFile dir = resolved.get(relative);
            if (dir == null || !VfsUtilCore.isAncestor(root, dir, true)) continue;
            if (entry.removeExcludeFolder(dir.getUrl())) dirty = true;
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
  }

  private static VirtualFile resolveDir(Path projectPath, String relative) {
    return VfsUtil.findFileByIoFile(projectPath.resolve(relative).toFile(), true);
  }

  private static List<String> readApplied(Path stateFile) {
    if (!Files.isRegularFile(stateFile)) return List.of();
    try {
      JsonElement parsed = JsonParser.parseString(Files.readString(stateFile, StandardCharsets.UTF_8));
      if (!parsed.isJsonArray()) throw new IllegalArgumentException("not a JSON array");
      List<String> applied = new ArrayList<>();
      for (JsonElement element : parsed.getAsJsonArray()) {
        if (element.isJsonPrimitive() && element.getAsJsonPrimitive().isString()) applied.add(element.getAsString());
      }
      return applied;
    } catch (Throwable t) {
      Log.warn("failed to read " + stateFile + " (treating as empty): " + t);
      return List.of();
    }
  }

  private static void writeApplied(Path stateFile, Set<String> applied) {
    try {
      JsonArray array = new JsonArray();
      for (String relative : applied) array.add(relative);
      Files.createDirectories(stateFile.getParent());
      Files.writeString(stateFile, array.toString(), StandardCharsets.UTF_8);
    } catch (Throwable t) {
      Log.warn("failed to write " + stateFile + ": " + t);
    }
  }

  /** --idle-seconds 缺省时读 OPENCODE_SEMANTIC_IDLE_TIMEOUT_MS（毫秒，ceil 到秒）；非法值回退默认。 */
  private static long idleSecondsFromEnv() {
    String raw = System.getenv("OPENCODE_SEMANTIC_IDLE_TIMEOUT_MS");
    if (raw == null || raw.isBlank()) return DEFAULT_IDLE_SECONDS;
    try {
      long millis = Long.parseLong(raw.trim());
      if (millis < 0) throw new NumberFormatException(raw);
      return Math.ceilDiv(millis, 1000L);
    } catch (NumberFormatException e) {
      Log.warn("invalid OPENCODE_SEMANTIC_IDLE_TIMEOUT_MS (using " + DEFAULT_IDLE_SECONDS + "s): " + raw);
      return DEFAULT_IDLE_SECONDS;
    }
  }

  private static long parseIdleSeconds(String value) {
    try {
      long parsed = Long.parseLong(value);
      if (parsed < 0) throw new NumberFormatException(value);
      return parsed;
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException("invalid --idle-seconds value: " + value);
    }
  }

  /** start() 返回后平台不会自动退出，需显式 exit；另有 5s 强制兜底防止进程残留。 */
  private static void exitApplication() {
    Application application = ApplicationManager.getApplication();
    if (application != null) {
      try {
        application.exit();
      } catch (Throwable t) {
        Log.warn("application.exit failed: " + t);
      }
    }
    Thread killer =
        new Thread(
            () -> {
              try {
                Thread.sleep(5000);
              } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
              }
              Runtime.getRuntime().halt(0);
            },
            "semantic-force-exit");
    killer.setDaemon(true);
    killer.start();
  }
}
