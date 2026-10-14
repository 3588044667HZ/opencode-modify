package opencode.semantic;

import java.time.LocalTime;
import java.time.format.DateTimeFormatter;

/** 简单日志：同时输出到 stderr 与平台日志，便于命令行与 sandbox 日志排查。 */
final class Log {
  private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm:ss.SSS");

  private Log() {}

  static void info(String message) {
    System.err.println("[semantic " + LocalTime.now().format(TIME) + "] " + message);
  }

  static void warn(String message) {
    System.err.println("[semantic " + LocalTime.now().format(TIME) + "] WARN " + message);
  }

  static void error(String message, Throwable t) {
    System.err.println("[semantic " + LocalTime.now().format(TIME) + "] ERROR " + message);
    if (t != null) t.printStackTrace(System.err);
  }
}
