package opencode.semantic;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer;
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl;
import com.intellij.codeInsight.daemon.impl.DaemonProgressIndicator;
import com.intellij.codeInsight.daemon.impl.HighlightInfo;
import com.intellij.lang.annotation.HighlightSeverity;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.colors.EditorColorsManager;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.progress.ProcessCanceledException;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.DumbService;
import com.intellij.openapi.project.IndexNotReadyException;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectUtil;
import com.intellij.openapi.util.ProperTextRange;
import com.intellij.openapi.util.TextRange;
import com.intellij.openapi.util.ThrowableComputable;
import com.intellij.openapi.vfs.VfsUtil;
import com.intellij.openapi.vfs.VfsUtilCore;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.JavaPsiFacade;
import com.intellij.psi.PsiClass;
import com.intellij.psi.PsiCompiledElement;
import com.intellij.psi.PsiDocumentManager;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiField;
import com.intellij.psi.PsiFile;
import com.intellij.psi.PsiManager;
import com.intellij.psi.PsiMethod;
import com.intellij.psi.PsiNameIdentifierOwner;
import com.intellij.psi.PsiNamedElement;
import com.intellij.psi.PsiRecursiveElementWalkingVisitor;
import com.intellij.psi.PsiReference;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.psi.search.PsiShortNamesCache;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * read_view 聚合：PSI 内容/符号结构 + VFS modificationStamp 版本戳 +
 * 引用 resolve 锚点 + DaemonCodeAnalyzer 诊断（headless 下为 best-effort）。
 */
final class ReadViewService {
  /** 单次返回的行窗口大小（view 语义未在 spec 中细化，MVP 固定 80 行）。 */
  static final int CHUNK_LINES = 80;

  JsonObject readView(Project project, String basePath, JsonObject params) throws JsonRpcServer.RpcException {
    String file = requireString(params, "file");
    String view = optionalString(params, "view", "entry");
    Integer line = readPositionLine(params);
    String symbol = optionalString(params, "symbol", null);
    String knownVersion = optionalString(params, "known_version", null);

    Path path = resolvePath(basePath, file);
    VirtualFile virtualFile = VfsUtil.findFileByIoFile(path.toFile(), true);
    if (virtualFile == null || !virtualFile.isValid()) {
      throw new JsonRpcServer.RpcException(-32001, "file not found", null);
    }
    // 平台侧不主动监听文件系统变化（spec：不做文件系统主动监听）。
    // 仅当磁盘 mtime 与 VFS timeStamp 不一致时才 refresh（避免稳态读触发写意图而长时间等待）。
    try {
      long mtime = Files.getLastModifiedTime(Paths.get(virtualFile.getPath())).toMillis();
      if (virtualFile.getTimeStamp() != mtime) virtualFile.refresh(false, false);
    } catch (IOException e) {
      virtualFile.refresh(false, false);
    }
    if (DumbService.isDumb(project)) {
      throw new JsonRpcServer.RpcException(-32000, "indexing", null);
    }

    try {
      return ReadAction.computeBlocking(
          (ThrowableComputable<JsonObject, JsonRpcServer.RpcException>)
              () -> buildResult(project, virtualFile, view, line, symbol, knownVersion));
    } catch (JsonRpcServer.RpcException e) {
      throw e;
    } catch (IndexNotReadyException e) {
      // 读过程中进入 dumb 模式的竞态：按协议返回 indexing，客户端稍后重试
      throw new JsonRpcServer.RpcException(-32000, "indexing", null);
    } catch (Throwable t) {
      Log.error("read_view failed", t);
      // 发行版不完整时给出可操作的修复提示（仅 Python 文件受影响）
      String hint = isPythonFile(file) ? DistHealth.supportHint() : "";
      throw new JsonRpcServer.RpcException(-32603, "internal error" + hint, null);
    }
  }

  private JsonObject buildResult(
      Project project, VirtualFile virtualFile, String view, Integer line, String symbol,
      String knownVersion)
      throws JsonRpcServer.RpcException {
    // 每个分析子步骤独立降级：发行版不完整（如 content module 实现 jar 缺失）时抛出的
    // ClassNotFoundException 等只让对应节缺失并记入 warnings，不得让整个请求失败。
    Set<String> warnings = new LinkedHashSet<>();
    PsiFile psiFile = findPsiFile(project, virtualFile, warnings);
    Document document = psiFile == null ? null : documentOf(project, psiFile, warnings);

    PsiElement definition = null;
    if (psiFile != null && "definition".equals(view) && symbol != null && !symbol.isEmpty()) {
      try {
        definition = resolveSymbol(project, psiFile, symbol);
      } catch (Throwable t) {
        noteAnalysisFailure(warnings, t);
        definition = null;
      }
      if (definition != null && document != null) {
        try {
          if (definition.isValid()
              && definition.getContainingFile() != null
              && definition.getContainingFile().getVirtualFile() != null) {
            PsiFile definitionPsi = definition.getContainingFile();
            Document definitionDocument = PsiDocumentManager.getInstance(project).getDocument(definitionPsi);
            if (definitionDocument != null) {
              psiFile = definitionPsi;
              virtualFile = definitionPsi.getVirtualFile();
              document = definitionDocument;
            }
          }
        } catch (Throwable t) {
          noteAnalysisFailure(warnings, t);
        }
      }
    }

    String version = versionOf(virtualFile);
    String fullText = null;
    if (document != null) {
      try {
        fullText = document.getText();
      } catch (Throwable t) {
        noteAnalysisFailure(warnings, t);
        document = null; // PSI 文本不可用：退化为 VFS 文本视图（内容/版本仍返回）
      }
    }
    if (fullText == null) fullText = loadText(virtualFile, warnings);
    LineSource lines = document != null ? LineSource.ofDocument(document) : LineSource.ofText(fullText);
    Path servedPath = Paths.get(virtualFile.getPath());

    // D4 读时对账：known_version 相等 → 微响应；不等 → 有界 delta；缓存未命中/超限 → full + reconciliation
    if (knownVersion != null) {
      if (knownVersion.equals(version)) {
        JsonObject unchanged = new JsonObject();
        unchanged.addProperty("unchanged", true);
        unchanged.addProperty("version", version);
        return unchanged;
      }
      String servedText = Reconcile.served(servedPath, knownVersion);
      Reconcile.remember(servedPath, version, fullText);
      if (servedText != null) {
        JsonObject reconciliation = Reconcile.delta(servedText, fullText, knownVersion, version);
        if (reconciliation != null) {
          JsonObject delta = new JsonObject();
          delta.addProperty("file", displayPath(virtualFile, project));
          delta.addProperty("version", version);
          delta.add("reconciliation", reconciliation);
          return delta;
        }
      }
      JsonObject full =
          buildFullResult(project, psiFile, document, virtualFile, definition, view, line, symbol, version, lines, warnings);
      full.add("reconciliation", Reconcile.fullMode());
      return full;
    }

    JsonObject full =
        buildFullResult(project, psiFile, document, virtualFile, definition, view, line, symbol, version, lines, warnings);
    Reconcile.remember(servedPath, version, fullText);
    return full;
  }

  /** 完整视图渲染（既有 read_view 响应形状）；D4 只在外层附加 reconciliation 字段。
   *  分析节（符号/诊断/锚点）独立降级：失败省略该节并写入 warnings，内容/位置/覆盖/版本始终返回。 */
  private JsonObject buildFullResult(
      Project project, PsiFile psiFile, Document document, VirtualFile virtualFile,
      PsiElement definition, String view, Integer line, String symbol, String version,
      LineSource lines, Set<String> warnings)
      throws JsonRpcServer.RpcException {
    int totalLines = lines.totalLines();
    List<Symbol> symbols =
        psiFile == null || document == null
            ? List.of()
            : safeStep(warnings, List.of(), () -> collectSymbols(psiFile, document, warnings));
    int startLine = computeStartLine(view, definition, document, line, totalLines);
    int endLine = Math.min(totalLines, startLine + CHUNK_LINES - 1);

    List<Diagnostic> diagnostics =
        psiFile == null || document == null
            ? List.of()
            : safeStep(warnings, List.of(), () -> collectDiagnostics(project, psiFile, document, warnings));
    Map<Integer, JsonObject> anchors = new LinkedHashMap<>();
    if (psiFile != null && document != null && analysisSupported(psiFile, warnings)) {
      try {
        collectAnchors(project, psiFile, document, startLine, endLine, anchors, warnings);
      } catch (Throwable t) {
        noteAnalysisFailure(warnings, t);
      }
    }

    JsonObject result = new JsonObject();
    result.addProperty("file", displayPath(virtualFile, project));
    result.addProperty("version", version);

    JsonObject size = new JsonObject();
    size.addProperty("lines", totalLines);
    size.addProperty("symbols", symbols.size());
    result.add("size", size);

    JsonObject status = new JsonObject();
    boolean modified = safeStep(warnings, false, () -> FileDocumentManager.getInstance().isFileModified(virtualFile));
    status.addProperty("modified", modified);
    status.addProperty(
        "errors", diagnostics.stream().filter(d -> "error".equals(d.severity)).count());
    result.add("status", status);

    JsonObject position = new JsonObject();
    int currentLine = line != null ? clamp(line, 1, totalLines) : startLine;
    position.addProperty("current", currentLine);
    position.addProperty("total", totalLines);
    position.addProperty(
        "in_symbol", symbolAt(symbols, currentLine, psiFile != null ? psiFile.getName() : virtualFile.getName()));
    position.addProperty(
        "remaining_symbols", symbols.stream().filter(s -> s.startLine > endLine).count());
    result.add("position", position);

    JsonArray content = new JsonArray();
    Map<Integer, Diagnostic> diagnosticsByLine = new HashMap<>();
    for (Diagnostic diagnostic : diagnostics) {
      diagnosticsByLine.putIfAbsent(diagnostic.line, diagnostic);
    }
    for (int current = startLine; current <= endLine; current++) {
      JsonObject lineObject = new JsonObject();
      lineObject.addProperty("line", current);
      lineObject.addProperty("text", lines.textOfLine(current));
      Diagnostic diagnostic = diagnosticsByLine.get(current);
      if (diagnostic != null) lineObject.add("diagnostic", diagnostic.toInlineJson());
      JsonObject anchor = anchors.get(current);
      if (anchor != null) lineObject.add("anchor", anchor);
      content.add(lineObject);
    }
    result.add("content", content);

    JsonObject coverage = new JsonObject();
    JsonArray readRanges = new JsonArray();
    readRanges.add(range(startLine, endLine));
    coverage.add("read", readRanges);
    JsonArray unreadRanges = new JsonArray();
    if (startLine > 1) unreadRanges.add(range(1, startLine - 1));
    if (endLine < totalLines) unreadRanges.add(range(endLine + 1, totalLines));
    coverage.add("unread", unreadRanges);
    result.add("coverage", coverage);

    JsonArray diagnosticsJson = new JsonArray();
    for (Diagnostic diagnostic : diagnostics) diagnosticsJson.add(diagnostic.toJson());
    result.add("diagnostics", diagnosticsJson);

    if (!warnings.isEmpty()) {
      JsonArray warningsJson = new JsonArray();
      for (String warning : warnings) warningsJson.add(warning);
      result.add("warnings", warningsJson);
    }

    return result;
  }

  private static JsonArray range(int from, int to) {
    JsonArray range = new JsonArray();
    range.add(from);
    range.add(to);
    return range;
  }

  private static int computeStartLine(
      String view, PsiElement definition, Document document, Integer line, int totalLines) {
    if (definition != null && document != null && definition.getTextRange() != null) {
      int offset = clamp(definition.getTextRange().getStartOffset(), 0, document.getTextLength());
      return document.getLineNumber(offset) + 1;
    }
    if (line != null) return clamp(line, 1, totalLines);
    if ("entry".equals(view)) return 1;
    return 1; // sequential / continue 无 position 时从头开始（状态在 OC，服务端无状态）
  }

  /** 行文本来源：优先 PSI Document（行语义含末尾假行剔除）；PSI 不可用时退化为 VFS 文本。 */
  private static final class LineSource {
    private final Document document;
    private final String[] lines;
    private final int totalLines;

    private LineSource(Document document, String[] lines, int totalLines) {
      this.document = document;
      this.lines = lines;
      this.totalLines = totalLines;
    }

    static LineSource ofDocument(Document document) {
      int total = document.getLineCount();
      // 文件以换行结尾时 IntelliJ Document 末行是空的"假行"；协议按实际文件行数（split 语义）计数，不含它
      if (total > 1 && document.getLineStartOffset(total - 1) >= document.getTextLength()) total--;
      return new LineSource(document, null, total);
    }

    static LineSource ofText(String text) {
      String[] split = text.split("\\r?\\n", -1);
      int total = split.length;
      if (total > 1 && split[total - 1].isEmpty()) total--;
      return new LineSource(null, split, total);
    }

    int totalLines() {
      return totalLines;
    }

    String textOfLine(int line) {
      if (document == null) return lines[line - 1];
      int start = document.getLineStartOffset(line - 1);
      int end = document.getLineEndOffset(line - 1);
      return document.getText(new TextRange(start, end));
    }
  }

  // ---- 符号结构（PSI 声明） ----

  private static final class Symbol {
    final String name;
    final int startLine;
    final int endLine;
    final int kind; // 0=class, 1=method, 2=field

    Symbol(String name, int startLine, int endLine, int kind) {
      this.name = name;
      this.startLine = startLine;
      this.endLine = endLine;
      this.kind = kind;
    }
  }

  private static List<Symbol> collectSymbols(PsiFile psiFile, Document document, Set<String> warnings) {
    List<Symbol> symbols = new ArrayList<>();
    try {
      psiFile.accept(
          new PsiRecursiveElementWalkingVisitor() {
            @Override
            public void visitElement(PsiElement element) {
              if (element instanceof PsiNamedElement) {
                int kind = symbolKind(element);
                String name = ((PsiNamedElement) element).getName();
                TextRange range = element.getTextRange();
                if (kind >= 0 && name != null && range != null) {
                  try {
                    int startLine = document.getLineNumber(range.getStartOffset()) + 1;
                    int endLine = document.getLineNumber(range.getEndOffset()) + 1;
                    symbols.add(new Symbol(name, startLine, endLine, kind));
                  } catch (RuntimeException ignored) {
                    // 越界文本范围（并发修改）时跳过
                  }
                }
              }
              super.visitElement(element);
            }
          });
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (ProcessCanceledException ignored) {
      // 取消（项目释放等）：按空符号处理
    } catch (Throwable t) {
      addWarning(warnings, t);
      Log.warn("collectSymbols failed: " + t);
    }
    symbols.sort(Comparator.comparingInt(s -> s.startLine));
    return symbols;
  }

  /** 0=class, 1=method, 2=field；Java PSI 类仅在具备 Java 能力的发行版可用（PyCharm/WebStorm 下按 Python 路径）。 */
  private static int symbolKind(PsiElement element) {
    if (JavaSupport.available()) {
      if (element instanceof PsiClass) return 0;
      if (element instanceof PsiMethod) return 1;
      if (element instanceof PsiField) return 2;
    }
    return pythonSymbolKind(element);
  }

  /** Python 符号（PyFunction/PyClass/模块级赋值目标）：按实现类名判定，避免编译期依赖 python PSI 包。
   *  project_map/blast_radius 的 Python 路径复用同一判定。 */
  static int pythonSymbolKind(PsiElement element) {
    if (!(element instanceof PsiNameIdentifierOwner owner) || owner.getNameIdentifier() == null) return -1;
    String className = element.getClass().getName();
    if (!className.startsWith("com.jetbrains.python")) return -1;
    if (className.contains("PyClass")) return 0;
    if (className.contains("PyFunction")) return 1;
    if (className.contains("PyTargetExpression")) return 2;
    return -1;
  }

  /** Python PSI 元素判定（实现类名口径，不加载 python 插件类）。 */
  static boolean isPythonElement(PsiElement element) {
    return element != null && element.getClass().getName().startsWith("com.jetbrains.python");
  }

  private static String symbolAt(List<Symbol> symbols, int line, String fallbackName) {
    Symbol best = null;
    for (Symbol symbol : symbols) {
      if (symbol.startLine <= line && line <= symbol.endLine) {
        if (best == null
            || symbol.kind < best.kind
            || (symbol.kind == best.kind && symbol.endLine - symbol.startLine < best.endLine - best.startLine)) {
          best = symbol;
        }
      }
    }
    if (best != null) return best.name;
    int dot = fallbackName.lastIndexOf('.');
    return dot > 0 ? fallbackName.substring(0, dot) : fallbackName;
  }

  // ---- 诊断（DaemonCodeAnalyzer，headless best-effort） ----

  private static final class Diagnostic {
    final int line;
    final String severity;
    final String message;

    Diagnostic(int line, String severity, String message) {
      this.line = line;
      this.severity = severity;
      this.message = message;
    }

    JsonObject toJson() {
      JsonObject json = new JsonObject();
      json.addProperty("line", line);
      json.addProperty("severity", severity);
      json.addProperty("message", message);
      return json;
    }

    /** content 行内联诊断：冻结协议只含 severity/message（行号由外层 content.line 表达）。 */
    JsonObject toInlineJson() {
      JsonObject json = new JsonObject();
      json.addProperty("severity", severity);
      json.addProperty("message", message);
      return json;
    }
  }

  private static List<Diagnostic> collectDiagnostics(
      Project project, PsiFile psiFile, Document document, Set<String> warnings) {
    List<HighlightInfo> highlights = new ArrayList<>();
    try {
      highlights.addAll(DaemonCodeAnalyzerImpl.getHighlights(document, HighlightSeverity.INFORMATION, project));
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (ProcessCanceledException ignored) {
      // 取消：按无诊断缓存处理
    } catch (Throwable t) {
      addWarning(warnings, t);
      Log.warn("getHighlights failed: " + t);
    }
    // headless 下没有编辑器时 daemon 不会常驻跑；best-effort 手动跑一次 main passes 并按版本戳缓存，
    // 避免每次 read_view 都重跑高亮 pass（会与后台写操作竞争导致长时间等待）。
    // 仅 Java/Python 执行：JS/TS 的检查会经语言服务做 resolve，见 analysisSupported 的说明。
    if (highlights.isEmpty() && analysisSupported(psiFile, warnings) && diagnosticCacheable(psiFile, document)) {
      highlights.addAll(manualHighlights(project, psiFile, document, warnings));
    }

    Map<String, Diagnostic> unique = new LinkedHashMap<>();
    for (HighlightInfo info : highlights) {
      if (info == null || info.getSeverity() == null || info.getDescription() == null) continue;
      if (info.getSeverity() == HighlightSeverity.TEXT_ATTRIBUTES) continue;
      int startOffset = info.getStartOffset();
      if (startOffset < 0 || startOffset > document.getTextLength()) continue;
      int line = document.getLineNumber(startOffset) + 1;
      String severity = severityName(info.getSeverity());
      if (severity == null) continue;
      Diagnostic diagnostic = new Diagnostic(line, severity, info.getDescription());
      unique.putIfAbsent(line + "|" + severity + "|" + diagnostic.message, diagnostic);
    }
    List<Diagnostic> result = new ArrayList<>(unique.values());
    result.sort(Comparator.comparingInt(d -> d.line));
    return result;
  }

  /** edit_batch 用：当前文件的诊断计数 [errors, warnings]（复用 collectDiagnostics 与手动高亮缓存）。 */
  static int[] diagnosticCounts(Project project, VirtualFile virtualFile) {
    PsiFile psiFile = PsiManager.getInstance(project).findFile(virtualFile);
    if (psiFile == null) return new int[] {0, 0};
    Document document = PsiDocumentManager.getInstance(project).getDocument(psiFile);
    if (document == null) return new int[] {0, 0};
    int errors = 0;
    int warnings = 0;
    for (Diagnostic diagnostic : collectDiagnostics(project, psiFile, document, new LinkedHashSet<>())) {
      if ("error".equals(diagnostic.severity)) errors++;
      else if ("warning".equals(diagnostic.severity)) warnings++;
    }
    return new int[] {errors, warnings};
  }

  private static final Map<String, List<HighlightInfo>> MANUAL_HIGHLIGHT_CACHE = new ConcurrentHashMap<>();

  private static boolean diagnosticCacheable(PsiFile psiFile, Document document) {
    Project project = psiFile.getProject();
    return !DumbService.isDumb(project);
  }

  /**
   * 手动高亮与锚点 resolve 仅对 Java 与 Python 执行：
   * - JS/TS 的 reference.resolve 与检查经 TypeScript 语言服务（跨进程）完成，headless 冷启动时
   *   可阻塞数十秒，且解析期间持有读许可——EDT 上的 TS 库刷新写动作与后续 read_view 读动作会
   *   整队等待（线程 dump 证据：解析栈停在 TypeScriptServiceEvaluationSupportBase.executeCommand，
   *   AWT-EventQueue-0 停在 TypeScriptLibraryProviderImpl.reloadLibraries 的写升级）。
   * - Python 的 resolve/检查在本进程 PSI 内完成（PyCharm 实测无语言服务阻塞），W4 起放开，
   *   并同样受锚点 2s 预算约束。
   * 其余语言按 spec 降级：锚点不可用、诊断仅取 daemon 缓存（不触发分析）。
   */
  private static boolean analysisSupported(PsiFile psiFile, Set<String> warnings) {
    try {
      String language = psiFile.getLanguage().getID();
      return "JAVA".equals(language) || "Python".equals(language);
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (ProcessCanceledException ignored) {
      return false;
    } catch (Throwable t) {
      addWarning(warnings, t);
      return false;
    }
  }

  /** runMainPasses 要求 DaemonProgressIndicator 上下文；262 平台还要求 additional highlighting session（261 无此 API，直接回退）。 */
  private static List<HighlightInfo> manualHighlights(
      Project project, PsiFile psiFile, Document document, Set<String> warnings) {
    VirtualFile virtualFile = psiFile.getVirtualFile();
    String key =
        (virtualFile == null ? psiFile.getName() : virtualFile.getPath() + "@" + virtualFile.getModificationStamp());
    List<HighlightInfo> cached = MANUAL_HIGHLIGHT_CACHE.get(key);
    if (cached != null) return cached;

    List<HighlightInfo> passes = new ArrayList<>();
    try {
      if (DaemonCodeAnalyzer.getInstance(project) instanceof DaemonCodeAnalyzerImpl daemon) {
        DaemonProgressIndicator indicator = new DaemonProgressIndicator();
        indicator.start();
        try {
          ProgressManager.getInstance()
              .runProcess(
                  () -> {
                    try {
                      daemon.runInsideAdditionalHighlightingSession(
                          psiFile,
                          EditorColorsManager.getInstance().getGlobalScheme(),
                          new ProperTextRange(0, document.getTextLength()),
                          true,
                          session -> runMainPassesSafely(daemon, psiFile, document, indicator, passes, warnings));
                    } catch (NoSuchMethodError missingSession) {
                      // 261 平台（PyCharm 2026.1）无 additional highlighting session API：走旧版重载
                      runInsideHighlightingSessionFallback(psiFile, document, indicator, passes, daemon, warnings);
                    }
                  },
                  indicator);
        } finally {
          indicator.stop();
        }
      }
    } catch (ProcessCanceledException canceled) {
      // 项目释放等取消：放弃本次诊断（best-effort 降级）
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (Throwable t) {
      addWarning(warnings, t);
      Log.warn("highlighting session failed: " + t);
    }
    if (MANUAL_HIGHLIGHT_CACHE.size() > 200) MANUAL_HIGHLIGHT_CACHE.clear();
    MANUAL_HIGHLIGHT_CACHE.put(key, passes);
    return passes;
  }

  /**
   * 261 回退：HighlightingSessionImpl.runInsideHighlightingSession 在 261 带 CodeInsightContext 参数
   * （262 无此重载且为包内 API），编译期不可见，按参数个数反射分派。
   */
  private static void runInsideHighlightingSessionFallback(
      PsiFile psiFile,
      Document document,
      DaemonProgressIndicator indicator,
      List<HighlightInfo> passes,
      DaemonCodeAnalyzerImpl daemon,
      Set<String> warnings) {
    try {
      Class<?> sessionImpl = Class.forName("com.intellij.codeInsight.daemon.impl.HighlightingSessionImpl");
      java.lang.reflect.Method target = null;
      for (java.lang.reflect.Method method : sessionImpl.getMethods()) {
        if ("runInsideHighlightingSession".equals(method.getName()) && method.getParameterCount() >= 5) {
          target = method;
          break;
        }
      }
      if (target == null) {
        Log.warn("no runInsideHighlightingSession overload found; manual highlights skipped");
        return;
      }
      java.util.function.Consumer<Object> consumer =
          session -> runMainPassesSafely(daemon, psiFile, document, indicator, passes, warnings);
      ProperTextRange range = new ProperTextRange(0, document.getTextLength());
      Object colorsScheme = EditorColorsManager.getInstance().getGlobalScheme();
      Object[] args =
          target.getParameterCount() == 6
              ? new Object[] {psiFile, codeInsightContext(psiFile), colorsScheme, range, true, consumer}
              : new Object[] {psiFile, colorsScheme, range, true, consumer};
      target.invoke(null, args);
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (Throwable t) {
      addWarning(warnings, t);
      Log.warn("highlighting session fallback failed: " + t);
    }
  }

  /** CodeInsightContextUtil.getCodeInsightContext(PsiFile)（261/262 core 均有；反射避免编译期版本差异）。 */
  private static Object codeInsightContext(PsiFile psiFile) throws ReflectiveOperationException {
    Class<?> util = Class.forName("com.intellij.codeInsight.multiverse.CodeInsightContextUtil");
    java.lang.reflect.Method method = util.getMethod("getCodeInsightContext", PsiFile.class);
    return method.invoke(null, psiFile);
  }

  private static void runMainPassesSafely(
      DaemonCodeAnalyzerImpl daemon,
      PsiFile psiFile,
      Document document,
      DaemonProgressIndicator indicator,
      List<HighlightInfo> passes,
      Set<String> warnings) {
    try {
      List<HighlightInfo> result = daemon.runMainPasses(psiFile, document, indicator);
      if (result != null) passes.addAll(result);
    } catch (ProcessCanceledException canceled) {
      // 项目释放等取消：放弃本次诊断（best-effort 降级）
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (Throwable t) {
      addWarning(warnings, t);
      Log.warn("runMainPasses failed: " + t);
    }
  }

  private static String severityName(HighlightSeverity severity) {
    String name = severity.getName();
    if (name == null) return null;
    return switch (name) {
      case "ERROR" -> "error";
      case "WARNING", "WEAK WARNING", "WEAK_WARNING", "GENERIC_SERVER_ERROR_OR_WARNING" -> "warning";
      default -> null;
    };
  }

  // ---- 锚点（PSI reference resolve） ----

  /**
   * 锚点解析预算（Java 与 Python 路径）：逐元素检查 deadline，超预算后停止解析并保留已收集的锚点
   * （协议不变，缺少 anchor 字段即按不可用处理）。JS/TS 不解析锚点，见 analysisSupported。
   */
  private static final long ANCHOR_BUDGET_MILLIS = 2_000;

  private static void collectAnchors(
      Project project, PsiFile psiFile, Document document, int startLine, int endLine,
      Map<Integer, JsonObject> anchors, Set<String> warnings) {
    // 每行取第一个可 resolve 的引用；跨文件锚点优先（与 spec 样例一致）
    Set<Integer> crossFileLines = new HashSet<>();
    long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(ANCHOR_BUDGET_MILLIS);
    try {
      psiFile.accept(
          new PsiRecursiveElementWalkingVisitor() {
            @Override
            public void visitElement(PsiElement element) {
              if (System.nanoTime() > deadlineNanos) {
                stopWalking();
                return;
              }
              // Java PSI 的引用通常挂在 PsiJavaCodeReferenceElement / PsiReferenceExpression 等父节点上，
              // 叶子标识符的 getReference() 多为 null，因此对每个元素都尝试。
              if (element.getTextLength() > 0) {
                int line;
                try {
                  line = document.getLineNumber(element.getTextRange().getStartOffset()) + 1;
                } catch (RuntimeException e) {
                  line = -1;
                }
                if (line >= startLine && line <= endLine && !crossFileLines.contains(line)) {
                  Anchor anchor = resolveAnchor(project, psiFile, element);
                  if (anchor != null) {
                    JsonObject existing = anchors.get(line);
                    if (anchor.crossFile || existing == null) {
                      anchors.put(line, anchor.json);
                      if (anchor.crossFile) crossFileLines.add(line);
                    }
                  }
                }
              }
              super.visitElement(element);
            }
          });
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (ProcessCanceledException ignored) {
      // 取消：保留已收集锚点
    } catch (Throwable t) {
      addWarning(warnings, t);
      Log.warn("collectAnchors failed: " + t);
    }
  }

  private static final class Anchor {
    final JsonObject json;
    final boolean crossFile;

    Anchor(JsonObject json, boolean crossFile) {
      this.json = json;
      this.crossFile = crossFile;
    }
  }

  private static Anchor resolveAnchor(Project project, PsiFile psiFile, PsiElement element) {
    PsiReference reference = element.getReference();
    if (reference == null) return null;
    PsiElement resolved;
    try {
      resolved = reference.resolve();
    } catch (Throwable t) {
      return null;
    }
    if (resolved == null || resolved == element || !resolved.isValid()) return null;
    if (resolved instanceof PsiCompiledElement) return null; // 跳过 JDK/库的 .class 锚点
    PsiFile resolvedFile = resolved.getContainingFile();
    if (resolvedFile == null || resolvedFile.getVirtualFile() == null) return null;
    VirtualFile baseDir = ProjectUtil.guessProjectDir(project);
    if (baseDir != null) {
      String base = baseDir.getPath();
      String resolvedPath = resolvedFile.getVirtualFile().getPath();
      // 项目外目标（SDK/库/stub，如 Python typeshed）不产出锚点：绝对路径对项目阅读无意义
      if (!resolvedPath.equals(base) && !resolvedPath.startsWith(base + "/")) return null;
    }
    TextRange range = resolved.getTextRange();
    if (range == null) return null;
    Document resolvedDocument = PsiDocumentManager.getInstance(project).getDocument(resolvedFile);
    if (resolvedDocument == null) return null;
    int offset = clamp(range.getStartOffset(), 0, resolvedDocument.getTextLength());
    int line = resolvedDocument.getLineNumber(offset) + 1;

    JsonObject anchor = new JsonObject();
    anchor.addProperty("symbol", element.getText());
    anchor.addProperty("location", displayPath(resolvedFile.getVirtualFile(), project) + ":" + line);
    return new Anchor(anchor, resolvedFile != psiFile);
  }

  // ---- definition 符号解析 ----

  private static PsiElement resolveSymbol(Project project, PsiFile contextFile, String symbol) {
    // Java 解析（JavaPsiFacade/PsiShortNamesCache 属于 java 插件，仅在具备 Java 能力的发行版可用）
    if (JavaSupport.available()) {
      PsiElement java = resolveJavaSymbol(project, contextFile, symbol);
      if (java != null) return java;
    }
    // 语言无关兜底（如 Python）：文件内同名声明 → 文件内可解析引用（import 的符号落到跨文件定义）
    return resolveByPsi(contextFile, symbol);
  }

  private static PsiElement resolveJavaSymbol(Project project, PsiFile contextFile, String symbol) {
    try {
      PsiClass found = JavaPsiFacade.getInstance(project).findClass(symbol, GlobalSearchScope.allScope(project));
      if (found != null) return found;
    } catch (Throwable t) {
      Log.warn("findClass failed: " + t);
    }
    try {
      PsiClass[] classes =
          PsiShortNamesCache.getInstance(project)
              .getClassesByName(symbol, GlobalSearchScope.projectScope(project));
      if (classes.length > 0) return classes[0];
    } catch (Throwable t) {
      Log.warn("short names lookup failed: " + t);
    }
    int hash = symbol.indexOf('#');
    if (hash > 0) {
      String className = symbol.substring(0, hash);
      String memberName = symbol.substring(hash + 1);
      try {
        PsiClass owner = JavaPsiFacade.getInstance(project).findClass(className, GlobalSearchScope.allScope(project));
        if (owner == null) {
          PsiClass[] classes =
              PsiShortNamesCache.getInstance(project)
                  .getClassesByName(className, GlobalSearchScope.projectScope(project));
          if (classes.length > 0) owner = classes[0];
        }
        if (owner != null) {
          for (PsiMethod method : owner.findMethodsByName(memberName, false)) return method;
          PsiField field = owner.findFieldByName(memberName, false);
          if (field != null) return field;
        }
      } catch (Throwable t) {
        Log.warn("member lookup failed: " + t);
      }
    }
    // Java 兜底：当前文件内同名声明
    PsiElement[] result = new PsiElement[1];
    try {
      contextFile.accept(
          new PsiRecursiveElementWalkingVisitor() {
            @Override
            public void visitElement(PsiElement element) {
              if (result[0] == null
                  && element instanceof PsiNamedElement named
                  && symbol.equals(named.getName())
                  && (element instanceof PsiClass || element instanceof PsiMethod || element instanceof PsiField)) {
                result[0] = element;
              }
              super.visitElement(element);
            }
          });
    } catch (RuntimeException ignored) {
      // ignore
    }
    return result[0];
  }

  /** 语言无关符号解析：文件内声明优先；其次文件内同名引用 resolve（跨文件锚点同语义）。 */
  private static PsiElement resolveByPsi(PsiFile contextFile, String symbol) {
    PsiElement[] declaration = new PsiElement[1];
    PsiElement[] resolvedReference = new PsiElement[1];
    try {
      contextFile.accept(
          new PsiRecursiveElementWalkingVisitor() {
            @Override
            public void visitElement(PsiElement element) {
              if (declaration[0] == null
                  && element instanceof PsiNamedElement named
                  && symbol.equals(named.getName())
                  && symbolKind(element) >= 0) {
                declaration[0] = element;
              }
              if (resolvedReference[0] == null
                  && element.getTextLength() == symbol.length()
                  && symbol.equals(element.getText())) {
                try {
                  PsiReference reference = element.getReference();
                  if (reference != null) {
                    PsiElement resolved = reference.resolve();
                    if (resolved != null && resolved != element && resolved.isValid()) resolvedReference[0] = resolved;
                  }
                } catch (Throwable ignored) {
                  // 逐元素 resolve 失败按未命中处理
                }
              }
              super.visitElement(element);
            }
          });
    } catch (RuntimeException ignored) {
      // ignore
    }
    return declaration[0] != null ? declaration[0] : resolvedReference[0];
  }

  // ---- 降级与警告（发行版不完整等场景：只降级不失败） ----

  /** warnings 上限：去重后仍可能有多种异常，保持载荷有界。 */
  private static final int MAX_WARNINGS = 8;

  private static PsiFile findPsiFile(Project project, VirtualFile virtualFile, Set<String> warnings) {
    try {
      return PsiManager.getInstance(project).findFile(virtualFile);
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (ProcessCanceledException ignored) {
      return null;
    } catch (Throwable t) {
      addWarning(warnings, t);
      return null;
    }
  }

  private static Document documentOf(Project project, PsiFile psiFile, Set<String> warnings) {
    try {
      return PsiDocumentManager.getInstance(project).getDocument(psiFile);
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (ProcessCanceledException ignored) {
      return null;
    } catch (Throwable t) {
      addWarning(warnings, t);
      return null;
    }
  }

  /** PSI 不可用时的文本兜底：VFS 读取失败再退回磁盘读取，保证内容节尽量返回。 */
  private static String loadText(VirtualFile virtualFile, Set<String> warnings) {
    try {
      return VfsUtilCore.loadText(virtualFile);
    } catch (Throwable t) {
      addWarning(warnings, t);
    }
    try {
      return Files.readString(Paths.get(virtualFile.getPath()));
    } catch (IOException e) {
      addWarning(warnings, e);
      return "";
    }
  }

  /** 子步骤共同失败语义：进入 dumb 模式按 indexing 上报；取消静默；其余记 warning。 */
  private static void noteAnalysisFailure(Set<String> warnings, Throwable t) throws JsonRpcServer.RpcException {
    if (t instanceof IndexNotReadyException) {
      throw new JsonRpcServer.RpcException(-32000, "indexing", null);
    }
    if (t instanceof ProcessCanceledException) return;
    addWarning(warnings, t);
  }

  private static void addWarning(Set<String> warnings, Throwable t) {
    if (warnings.size() < MAX_WARNINGS) warnings.add(analysisWarning(t));
  }

  /** 有界、去重的降级警告：`analysis unavailable: <exception class>`；异常链含 CNF 时附缺失类名。 */
  private static String analysisWarning(Throwable t) {
    String label = t.getClass().getSimpleName();
    if (label.isEmpty()) label = t.getClass().getName();
    String missing = firstToken(missingClassName(t));
    return "analysis unavailable: " + label + (missing == null || missing.isEmpty() ? "" : ": " + missing);
  }

  /** 平台常把 ClassNotFoundException 包在 RuntimeException 里，沿 cause 链找（防自引用循环）。 */
  private static String missingClassName(Throwable t) {
    int depth = 0;
    for (Throwable current = t; current != null && depth < 10; current = current.getCause(), depth++) {
      if (current instanceof ClassNotFoundException found) return found.getMessage();
      if (current.getCause() == current) break;
    }
    return null;
  }

  private static String firstToken(String value) {
    if (value == null) return null;
    int space = value.indexOf(' ');
    String token = space < 0 ? value : value.substring(0, space);
    return token.length() > 160 ? token.substring(0, 160) : token;
  }

  private static boolean isPythonFile(String file) {
    String lower = file.toLowerCase(java.util.Locale.ROOT);
    return lower.endsWith(".py") || lower.endsWith(".pyi");
  }

  /** 单步降级：失败省略该节并记 warning（IndexNotReadyException 仍按 indexing 上报）。 */
  private static <T> T safeStep(Set<String> warnings, T fallback, Supplier<T> step) throws JsonRpcServer.RpcException {
    try {
      return step.get();
    } catch (Throwable t) {
      noteAnalysisFailure(warnings, t);
      return fallback;
    }
  }

  // ---- 工具 ----

  static Path resolvePath(String basePath, String file) {
    Path path = Paths.get(file);
    if (!path.isAbsolute() && basePath != null) {
      path = Paths.get(basePath).resolve(file);
    }
    return path.normalize();
  }

  /**
   * 版本戳：优先 VFS modificationStamp（spec 要求）；本机新 VFS 上初始值可能为 0，
   * 此时退化为文件系统 mtime，保证文件修改后版本戳变化。
   */
  static String versionOf(VirtualFile virtualFile) {
    long stamp = virtualFile.getModificationStamp();
    if (stamp > 0) return Long.toHexString(stamp);
    try {
      return Long.toHexString(Files.getLastModifiedTime(Paths.get(virtualFile.getPath())).toMillis());
    } catch (IOException e) {
      return Long.toHexString(virtualFile.getTimeStamp());
    }
  }

  static String displayPath(VirtualFile virtualFile, Project project) {
    String path = virtualFile.getPath();
    VirtualFile baseDir = ProjectUtil.guessProjectDir(project);
    if (baseDir != null) {
      String base = baseDir.getPath();
      if (path.startsWith(base + "/")) return path.substring(base.length() + 1);
    }
    return path;
  }

  private static String requireString(JsonObject params, String name) throws JsonRpcServer.RpcException {
    JsonElement element = params.get(name);
    if (element == null || !element.isJsonPrimitive()) {
      throw new JsonRpcServer.RpcException(-32602, "invalid params: missing " + name, null);
    }
    return element.getAsString();
  }

  private static String optionalString(JsonObject params, String name, String fallback) {
    JsonElement element = params.get(name);
    if (element == null || !element.isJsonPrimitive()) return fallback;
    return element.getAsString();
  }

  private static Integer readPositionLine(JsonObject params) {
    JsonElement position = params.get("position");
    if (position == null || !position.isJsonObject()) return null;
    JsonElement line = position.getAsJsonObject().get("line");
    if (line == null || !line.isJsonPrimitive()) return null;
    return line.getAsInt();
  }

  private static int clamp(int value, int min, int max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }
}
