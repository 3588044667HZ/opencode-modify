package opencode.semantic;

import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.lang.Language;
import com.intellij.openapi.extensions.PluginId;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiNameIdentifierOwner;

import java.util.Locale;

/**
 * JS/TS 能力探测：平台注册 JavaScript/TypeScript 语言即可用；262 的语言可能按需注册，
 * 回退到 JavaScript 插件安装状态（禁用不算）。不引用 JS 插件类，保持编译期解耦。
 */
final class JavaScriptSupport {
  private static Boolean available;

  private JavaScriptSupport() {}

  static synchronized boolean available() {
    if (available == null) {
      try {
        Language javascript = Language.findLanguageByID("JavaScript");
        Language typescript = Language.findLanguageByID("TypeScript");
        boolean found = javascript != null || typescript != null;
        if (!found) {
          for (Language candidate : Language.getRegisteredLanguages()) {
            String id = candidate.getID();
            if ("JavaScript".equals(id) || "TypeScript".equals(id)) {
              found = true;
              break;
            }
          }
        }
        if (!found) {
          found =
              !PluginManagerCore.isDisabled(PluginId.getId("JavaScript"))
                  && PluginManagerCore.isPluginInstalled(PluginId.getId("JavaScript"));
        }
        available = found;
        Log.info(
            "javascript support probe: javascript="
                + (javascript == null ? "null" : javascript.getID())
                + " typescript="
                + (typescript == null ? "null" : typescript.getID())
                + " available="
                + found);
      } catch (Throwable t) {
        available = false;
        Log.warn("javascript support probe failed: " + t);
      }
    }
    return available;
  }

  /** JS/TS 源文件扩展名（不含声明文件 .d.ts：它们不承载项目实现入口/依赖源）。 */
  static boolean isJsFile(String path) {
    String lower = path.toLowerCase(Locale.ROOT);
    if (lower.endsWith(".d.ts")) return false;
    return lower.endsWith(".js")
        || lower.endsWith(".jsx")
        || lower.endsWith(".ts")
        || lower.endsWith(".tsx")
        || lower.endsWith(".mjs")
        || lower.endsWith(".cjs");
  }

  /** 语言 ID 是否属于 JS/TS（用于 PSI 分派）。 */
  static boolean isJsLanguage(String languageId) {
    return "JavaScript".equals(languageId) || "TypeScript".equals(languageId);
  }

  /** JS/TS PSI 元素判定（实现类名口径，不加载 JS 插件类）。 */
  static boolean isJsElement(PsiElement element) {
    return element != null && element.getClass().getName().startsWith("com.intellij.lang.javascript");
  }

  /** 0=class, 1=function/method, 2=variable/property/field, 3=parameter；-1=非符号。 */
  static int symbolKind(PsiElement element) {
    if (!(element instanceof PsiNameIdentifierOwner owner) || owner.getNameIdentifier() == null) return -1;
    if (!isJsElement(element)) return -1;
    String simple = element.getClass().getSimpleName();
    if (simple.contains("Class") || simple.contains("Interface")) return 0;
    if (simple.contains("Function") || simple.contains("Method")) return 1;
    if (simple.contains("Parameter")) return 3;
    if (simple.contains("Variable")
        || simple.contains("Property")
        || simple.contains("Field")
        || simple.contains("Enum")) {
      return 2;
    }
    return -1;
  }
}
