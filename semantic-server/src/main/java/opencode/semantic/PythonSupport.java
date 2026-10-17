package opencode.semantic;

import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.lang.Language;
import com.intellij.openapi.extensions.PluginId;

/**
 * Python 能力探测：平台注册了 Python 语言即视为可用。不引用 python 插件类，
 * 与 JavaSupport 一样保持编译期解耦（plugin.xml 只依赖 platform 与 optional java）。
 * 安装不完整导致的 PSI 异常由各调用点按步骤降级，不在此处做修复/下载。
 */
final class PythonSupport {
  private static Boolean available;

  private PythonSupport() {}

  static synchronized boolean available() {
    if (available == null) {
      try {
        Language language = Language.findLanguageByID("Python");
        boolean found = language != null;
        if (!found) {
          for (Language candidate : Language.getRegisteredLanguages()) {
            if ("Python".equals(candidate.getID())
                || candidate.getClass().getName().startsWith("com.jetbrains.python")) {
              found = true;
              break;
            }
          }
        }
        if (!found) {
          // PyCharm 262 的 Python 语言可能按需注册：退回到插件安装状态（禁用不算）
          found =
              !PluginManagerCore.isDisabled(PluginId.getId("PythonCore"))
                  && (PluginManagerCore.isPluginInstalled(PluginId.getId("PythonCore"))
                      || PluginManagerCore.isPluginInstalled(PluginId.getId("Pythonid")));
        }
        available = found;
        Log.info(
            "python support probe: language="
                + (language == null ? "null" : language.getID())
                + " available="
                + found);
      } catch (Throwable t) {
        available = false;
        Log.warn("python support probe failed: " + t);
      }
    }
    return available;
  }
}
