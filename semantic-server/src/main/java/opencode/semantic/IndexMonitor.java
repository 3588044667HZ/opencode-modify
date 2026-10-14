package opencode.semantic;

import com.google.gson.JsonObject;
import com.intellij.openapi.project.DumbService;
import com.intellij.openapi.project.Project;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 索引/智能模式监视器。
 * 平台没有公开"精确索引百分比"的 API（DumbService 只有 isDumb 布尔量），
 * 因此 progress 采用阶段近似：dumb 期间按已耗时做渐近估算，ready 时为 1.0。
 */
final class IndexMonitor {
  private static final double INDEXING_CAP = 0.9;
  private static final double ESTIMATED_INDEX_MILLIS = 45_000.0;
  private static final int SMART_TICKS_TO_READY = 10; // 连续 5s(10 tick) 非 dumb 才 ready：躲过扫描与索引之间的间隙

  private final AtomicBoolean running = new AtomicBoolean(true);
  private volatile Project project;
  private volatile JsonRpcServer server;
  private volatile boolean ready;
  private volatile String phase = "starting";
  private volatile double progress = 0.02;
  private volatile long dumbSince = -1;
  private volatile int smartTicks;
  private double lastPushedProgress = -1;
  private String lastPushedPhase = null;
  private boolean lastPushedIndexing = true;

  void start() {
    Thread thread = new Thread(this::loop, "semantic-index-monitor");
    thread.setDaemon(true);
    thread.start();
  }

  void attachServer(JsonRpcServer server) {
    this.server = server;
  }

  void setProject(Project project) {
    this.project = project;
  }

  Project getProject() {
    return project;
  }

  boolean isIndexing() {
    return !ready;
  }

  /** ping 返回体：{indexing, progress, phase?, current?, eta?}。 */
  JsonObject snapshot() {
    JsonObject result = new JsonObject();
    result.addProperty("indexing", !ready);
    result.addProperty("progress", rounded(progress));
    result.addProperty("phase", phase);
    if (!ready) {
      double eta = etaSeconds();
      if (eta >= 0) result.addProperty("eta", eta);
    }
    return result;
  }

  /** -32000 错误的 data 字段。 */
  JsonObject errorData() {
    JsonObject data = new JsonObject();
    data.addProperty("progress", rounded(progress));
    return data;
  }

  /** notifications/indexing 的 params：冻结协议为 {phase, progress, current?, eta?}，不含 indexing。 */
  JsonObject notificationParams() {
    JsonObject result = new JsonObject();
    result.addProperty("phase", phase);
    result.addProperty("progress", rounded(progress));
    if (!ready) {
      double eta = etaSeconds();
      if (eta >= 0) result.addProperty("eta", eta);
    }
    return result;
  }

  private void loop() {
    while (running.get()) {
      try {
        tick();
        Thread.sleep(500);
      } catch (InterruptedException e) {
        return;
      } catch (Throwable t) {
        Log.error("index monitor tick failed", t);
      }
    }
  }

  private void tick() {
    Project current = project;
    long now = System.currentTimeMillis();
    if (current == null) {
      dumbSince = -1;
      smartTicks = 0;
      ready = false;
      phase = "starting";
      progress = 0.02;
    } else {
      boolean dumb;
      try {
        dumb = DumbService.isDumb(current);
      } catch (Throwable t) {
        dumb = false;
      }
      if (dumb) {
        if (dumbSince < 0) dumbSince = now;
        smartTicks = 0;
        if (ready) {
          ready = false;
          Log.info("semantic engine busy (dumb mode)");
        }
        phase = "indexing";
        progress = ramp(now - dumbSince);
      } else if (ready) {
        phase = "ready";
        progress = 1.0;
      } else {
        // 小项目的索引可能发生在项目打开内部（dumb 采样不到），因此打开后未 ready 的
        // 这段时间仍按 "indexing" 报告，直到连续数个 tick 保持 smart 才认为 ready
        if (dumbSince < 0) dumbSince = now;
        smartTicks++;
        if (smartTicks >= SMART_TICKS_TO_READY) {
          ready = true;
          phase = "ready";
          progress = 1.0;
          Log.info("semantic engine ready");
        } else {
          phase = "indexing";
          progress = ramp(now - dumbSince);
        }
      }
    }
    pushIfChanged(!ready);
  }

  /** dumb 模式下按已耗时渐近估算进度（平台无公开的精确百分比 API）。 */
  private static double ramp(long elapsedMillis) {
    return Math.min(INDEXING_CAP, 0.2 + 0.7 * (1 - Math.exp(-elapsedMillis / 40_000.0)));
  }

  private void pushIfChanged(boolean indexing) {
    JsonRpcServer currentServer = server;
    if (currentServer == null) return;
    boolean changed =
        indexing != lastPushedIndexing
            || !phase.equals(lastPushedPhase)
            || Math.abs(progress - lastPushedProgress) >= 0.01;
    if (!changed) return;
    lastPushedIndexing = indexing;
    lastPushedPhase = phase;
    lastPushedProgress = progress;
    currentServer.broadcast("notifications/indexing", notificationParams());
  }

  private double etaSeconds() {
    if (dumbSince < 0) return 15;
    long elapsed = System.currentTimeMillis() - dumbSince;
    double remaining = Math.max(5_000.0, ESTIMATED_INDEX_MILLIS - elapsed);
    return Math.round(remaining / 1000.0);
  }

  private static double rounded(double value) {
    return Math.round(value * 1000.0) / 1000.0;
  }
}
