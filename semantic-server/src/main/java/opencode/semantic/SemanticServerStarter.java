package opencode.semantic;

import com.google.gson.JsonObject;
import com.intellij.ide.trustedProjects.TrustedProjects;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModernApplicationStarter;
import com.intellij.openapi.project.DumbService;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;
import kotlin.Unit;
import kotlin.coroutines.Continuation;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 命令名 semantic-server（appStarter EP id）。
 * 用法: java -Djava.awt.headless=true -jar semantic-server.jar <project_path> <socket_path> [--idle-seconds N]
 * 平台启动方式: com.intellij.idea.Main semantic-server <project> <socket> --idle-seconds N
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
    String socketArg = null;
    long idleSeconds = DEFAULT_IDLE_SECONDS;
    for (int i = 0; i < argv.size(); i++) {
      String arg = argv.get(i);
      try {
        if ("--idle-seconds".equals(arg) && i + 1 < argv.size()) {
          idleSeconds = parseIdleSeconds(argv.get(++i));
        } else if (arg.startsWith("--idle-seconds=")) {
          idleSeconds = parseIdleSeconds(arg.substring("--idle-seconds=".length()));
        } else if (projectArg == null) {
          projectArg = arg;
        } else if (socketArg == null) {
          socketArg = arg;
        }
      } catch (IllegalArgumentException e) {
        Log.error(e.getMessage(), null);
        Runtime.getRuntime().halt(2);
      }
    }

    if (projectArg == null || socketArg == null) {
      Log.error("usage: semantic-server <project_path> <socket_path> [--idle-seconds N]", null);
      Runtime.getRuntime().halt(2);
    }

    Path projectPath = Path.of(projectArg).toAbsolutePath().normalize();
    if (!Files.isDirectory(projectPath)) {
      Log.error("project path is not a directory: " + projectPath, null);
      Runtime.getRuntime().halt(2);
    }
    Path socketPath = Path.of(socketArg);
    if (!socketPath.isAbsolute()) socketPath = socketPath.toAbsolutePath();
    socketPath = socketPath.normalize();
    if (socketPath.toString().length() > 100) {
      Log.warn("socket path is long (" + socketPath + "); AF_UNIX on Windows limits paths to ~108 chars");
    }

    Log.info("starting semantic-server project=" + projectPath + " socket=" + socketPath
        + " idle=" + idleSeconds + "s");

    IndexMonitor monitor = new IndexMonitor();
    ReadViewService readViewService = new ReadViewService();

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

    JsonRpcServer server = new JsonRpcServer(socketPath, handler, idleSeconds * 1000L);
    serverRef[0] = server;
    try {
      server.start();
    } catch (IOException e) {
      Log.error("failed to bind unix socket " + socketPath, e);
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
      Log.info("project opened: " + project.getName() + " (" + project.getBasePath() + ")");
    } catch (Throwable t) {
      Log.error("failed to open project " + projectPath, t);
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
