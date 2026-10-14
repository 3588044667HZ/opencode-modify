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
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.project.DumbService;
import com.intellij.openapi.project.IndexNotReadyException;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectUtil;
import com.intellij.openapi.util.ProperTextRange;
import com.intellij.openapi.util.TextRange;
import com.intellij.openapi.util.ThrowableComputable;
import com.intellij.openapi.vfs.VfsUtil;
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
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

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
              () -> buildResult(project, basePath, virtualFile, view, line, symbol));
    } catch (JsonRpcServer.RpcException e) {
      throw e;
    } catch (IndexNotReadyException e) {
      // 读过程中进入 dumb 模式的竞态：按协议返回 indexing，客户端稍后重试
      throw new JsonRpcServer.RpcException(-32000, "indexing", null);
    } catch (Throwable t) {
      Log.error("read_view failed", t);
      throw new JsonRpcServer.RpcException(-32603, "internal error", null);
    }
  }

  private JsonObject buildResult(
      Project project, String basePath, VirtualFile virtualFile, String view, Integer line, String symbol)
      throws JsonRpcServer.RpcException {
    PsiFile psiFile = PsiManager.getInstance(project).findFile(virtualFile);
    if (psiFile == null) throw new JsonRpcServer.RpcException(-32603, "internal error", null);
    Document document = PsiDocumentManager.getInstance(project).getDocument(psiFile);
    if (document == null) throw new JsonRpcServer.RpcException(-32603, "internal error", null);

    PsiElement definition = null;
    if ("definition".equals(view) && symbol != null && !symbol.isEmpty()) {
      definition = resolveSymbol(project, psiFile, symbol);
      if (definition != null
          && definition.isValid()
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
    }

    int totalLines = document.getLineCount();
    // 文件以换行结尾时 IntelliJ Document 末行是空的"假行"；协议按实际文件行数（split 语义）计数，不含它
    if (totalLines > 1 && document.getLineStartOffset(totalLines - 1) >= document.getTextLength()) {
      totalLines--;
    }
    List<Symbol> symbols = collectSymbols(psiFile, document);
    int startLine = computeStartLine(view, definition, document, line, totalLines);
    int endLine = Math.min(totalLines, startLine + CHUNK_LINES - 1);

    List<Diagnostic> diagnostics = collectDiagnostics(project, psiFile, document);
    Map<Integer, JsonObject> anchors = new LinkedHashMap<>();
    collectAnchors(project, psiFile, document, startLine, endLine, anchors);

    JsonObject result = new JsonObject();
    result.addProperty("file", displayPath(virtualFile, project));
    result.addProperty("version", versionOf(virtualFile));

    JsonObject size = new JsonObject();
    size.addProperty("lines", totalLines);
    size.addProperty("symbols", symbols.size());
    result.add("size", size);

    JsonObject status = new JsonObject();
    boolean modified = FileDocumentManager.getInstance().isFileModified(virtualFile);
    status.addProperty("modified", modified);
    status.addProperty(
        "errors", diagnostics.stream().filter(d -> "error".equals(d.severity)).count());
    result.add("status", status);

    JsonObject position = new JsonObject();
    int currentLine = line != null ? clamp(line, 1, totalLines) : startLine;
    position.addProperty("current", currentLine);
    position.addProperty("total", totalLines);
    position.addProperty("in_symbol", symbolAt(symbols, currentLine, psiFile));
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
      lineObject.addProperty("text", textOfLine(document, current));
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
    if (definition != null && definition.getTextRange() != null) {
      int offset = clamp(definition.getTextRange().getStartOffset(), 0, document.getTextLength());
      return document.getLineNumber(offset) + 1;
    }
    if (line != null) return clamp(line, 1, totalLines);
    if ("entry".equals(view)) return 1;
    return 1; // sequential / continue 无 position 时从头开始（状态在 OC，服务端无状态）
  }

  private static String textOfLine(Document document, int line) {
    int start = document.getLineStartOffset(line - 1);
    int end = document.getLineEndOffset(line - 1);
    return document.getText(new TextRange(start, end));
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

  private static List<Symbol> collectSymbols(PsiFile psiFile, Document document) {
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
    } catch (RuntimeException t) {
      Log.warn("collectSymbols failed: " + t);
    }
    symbols.sort(Comparator.comparingInt(s -> s.startLine));
    return symbols;
  }

  private static int symbolKind(PsiElement element) {
    if (element instanceof PsiClass) return 0;
    if (element instanceof PsiMethod) return 1;
    if (element instanceof PsiField) return 2;
    return -1;
  }

  private static String symbolAt(List<Symbol> symbols, int line, PsiFile psiFile) {
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
    String name = psiFile.getName();
    int dot = name.lastIndexOf('.');
    return dot > 0 ? name.substring(0, dot) : name;
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

  private static List<Diagnostic> collectDiagnostics(Project project, PsiFile psiFile, Document document) {
    List<HighlightInfo> highlights = new ArrayList<>();
    try {
      highlights.addAll(DaemonCodeAnalyzerImpl.getHighlights(document, HighlightSeverity.INFORMATION, project));
    } catch (Throwable t) {
      Log.warn("getHighlights failed: " + t);
    }
    // headless 下没有编辑器时 daemon 不会常驻跑；best-effort 手动跑一次 main passes 并按版本戳缓存，
    // 避免每次 read_view 都重跑高亮 pass（会与后台写操作竞争导致长时间等待）。
    if (highlights.isEmpty() && diagnosticCacheable(psiFile, document)) {
      highlights.addAll(manualHighlights(project, psiFile, document));
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

  private static final Map<String, List<HighlightInfo>> MANUAL_HIGHLIGHT_CACHE = new ConcurrentHashMap<>();

  private static boolean diagnosticCacheable(PsiFile psiFile, Document document) {
    Project project = psiFile.getProject();
    return !DumbService.isDumb(project);
  }

  /** runMainPasses 要求 DaemonProgressIndicator 上下文与 additional highlighting session。 */
  private static List<HighlightInfo> manualHighlights(Project project, PsiFile psiFile, Document document) {
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
                  () ->
                      daemon.runInsideAdditionalHighlightingSession(
                          psiFile,
                          EditorColorsManager.getInstance().getGlobalScheme(),
                          new ProperTextRange(0, document.getTextLength()),
                          true,
                          session -> {
                            try {
                              List<HighlightInfo> result = daemon.runMainPasses(psiFile, document, indicator);
                              if (result != null) passes.addAll(result);
                            } catch (Throwable t) {
                              Log.warn("runMainPasses failed: " + t);
                            }
                          }),
                  indicator);
        } finally {
          indicator.stop();
        }
      }
    } catch (Throwable t) {
      Log.warn("highlighting session failed: " + t);
    }
    if (MANUAL_HIGHLIGHT_CACHE.size() > 200) MANUAL_HIGHLIGHT_CACHE.clear();
    MANUAL_HIGHLIGHT_CACHE.put(key, passes);
    return passes;
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

  private static void collectAnchors(
      Project project, PsiFile psiFile, Document document, int startLine, int endLine, Map<Integer, JsonObject> anchors) {
    // 每行取第一个可 resolve 的引用；跨文件锚点优先（与 spec 样例一致）
    Set<Integer> crossFileLines = new HashSet<>();
    try {
      psiFile.accept(
          new PsiRecursiveElementWalkingVisitor() {
            @Override
            public void visitElement(PsiElement element) {
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
    } catch (RuntimeException t) {
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
    // 最后的兜底：当前文件内同名声明
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
  private static String versionOf(VirtualFile virtualFile) {
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
