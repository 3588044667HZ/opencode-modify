package opencode.semantic;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.project.DumbService;
import com.intellij.openapi.project.IndexNotReadyException;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectUtil;
import com.intellij.openapi.util.TextRange;
import com.intellij.openapi.util.ThrowableComputable;
import com.intellij.openapi.vfs.VFileProperty;
import com.intellij.openapi.vfs.VfsUtil;
import com.intellij.openapi.vfs.VfsUtilCore;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.JavaPsiFacade;
import com.intellij.psi.PsiClass;
import com.intellij.psi.PsiCodeBlock;
import com.intellij.psi.PsiCompiledElement;
import com.intellij.psi.PsiDocumentManager;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiField;
import com.intellij.psi.PsiFile;
import com.intellij.psi.PsiManager;
import com.intellij.psi.PsiMethod;
import com.intellij.psi.PsiModifier;
import com.intellij.psi.PsiNameIdentifierOwner;
import com.intellij.psi.PsiNamedElement;
import com.intellij.psi.PsiParameter;
import com.intellij.psi.PsiRecursiveElementWalkingVisitor;
import com.intellij.psi.PsiReference;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.psi.search.PsiSearchHelper;
import com.intellij.psi.search.PsiShortNamesCache;
import com.intellij.psi.search.SearchScope;
import com.intellij.psi.search.UsageSearchContext;
import com.intellij.psi.search.searches.ReferencesSearch;
import com.intellij.psi.util.PsiModificationTracker;
import com.intellij.psi.util.PsiTreeUtil;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Predicate;

/**
 * blast_radius：符号级影响面聚合（定义解析 + 引用分类 + 入口点 + 受影响测试 + callees + 风险评级）。
 * 结果缓存按 symbol|scope 维度，用 PsiModificationTracker 的 modificationCount 作失效基准。
 */
final class BlastRadiusService {
  private static final int CALLERS_LIMIT = 20;
  private static final int CALLEES_LIMIT = 50;
  private static final int ENTRY_LIMIT = 10;
  /** 单次查询时间预算：累计超时后停止 level2 入口追踪并吞掉剩余 callees。 */
  private static final long TIME_BUDGET_NANOS = 1_500_000_000L;
  private static final int CACHE_LIMIT = 100;

  private static final Map<String, CachedResult> CACHE =
      Collections.synchronizedMap(
          new LinkedHashMap<>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, CachedResult> eldest) {
              return size() > CACHE_LIMIT;
            }
          });

  private static final class CachedResult {
    final long modificationCount;
    final JsonObject result;

    CachedResult(long modificationCount, JsonObject result) {
      this.modificationCount = modificationCount;
      this.result = result;
    }
  }

  JsonObject blastRadius(Project project, String basePath, JsonObject params)
      throws JsonRpcServer.RpcException {
    String symbol = requireString(params, "symbol");
    String scope = readScope(params);

    // scope 目前只识别 file:<项目相对路径>；其它前缀按 spec 忽略（全项目搜索）
    VirtualFile scopeFile = resolveScopeFile(basePath, scope);

    long modificationCount = PsiModificationTracker.getInstance(project).getModificationCount();
    String cacheKey = symbol + "|" + (scope == null ? "" : scope);
    CachedResult cached = CACHE.get(cacheKey);
    if (cached != null
        && cached.modificationCount == modificationCount
        && !DumbService.isDumb(project)) {
      Log.info(
          "blast_radius cache hit symbol=" + symbol + " scope=" + displayScope(scope)
              + " modCount=" + modificationCount);
      return cached.result;
    }

    try {
      JsonObject result =
          ReadAction.computeBlocking(
              (ThrowableComputable<JsonObject, JsonRpcServer.RpcException>)
                  () -> compute(project, scopeFile, symbol));
      CACHE.put(cacheKey, new CachedResult(modificationCount, result));
      Log.info(
          "blast_radius cache miss (computed) symbol=" + symbol + " scope=" + displayScope(scope)
              + " modCount=" + modificationCount);
      return result;
    } catch (JsonRpcServer.RpcException e) {
      throw e;
    } catch (IndexNotReadyException e) {
      // 读过程中进入 dumb 模式的竞态：按协议返回 indexing，客户端稍后重试
      throw new JsonRpcServer.RpcException(-32000, "indexing", null);
    } catch (Throwable t) {
      Log.error("blast_radius failed", t);
      throw new JsonRpcServer.RpcException(-32603, "internal error", null);
    }
  }

  /** file: 前缀的文件 scope；文件不存在按协议返回 -32001。 */
  private static VirtualFile resolveScopeFile(String basePath, String scope)
      throws JsonRpcServer.RpcException {
    if (scope == null || !scope.startsWith("file:")) return null;
    Path path = ReadViewService.resolvePath(basePath, scope.substring("file:".length()));
    VirtualFile virtualFile = VfsUtil.findFileByIoFile(path.toFile(), true);
    if (virtualFile == null || !virtualFile.isValid()) {
      throw new JsonRpcServer.RpcException(-32001, "file not found", null);
    }
    return virtualFile;
  }

  private JsonObject compute(Project project, VirtualFile scopeFile, String symbol)
      throws JsonRpcServer.RpcException {
    long deadlineNanos = System.nanoTime() + TIME_BUDGET_NANOS;

    SearchScope searchScope =
        scopeFile != null
            ? GlobalSearchScope.fileScope(project, scopeFile)
            : GlobalSearchScope.projectScope(project);

    PsiElement definition = resolveDefinition(project, symbol, scopeFile);
    if (definition == null || !definition.isValid()) {
      String hint = DistHealth.pythonIncomplete() ? DistHealth.supportHint() : "";
      throw new JsonRpcServer.RpcException(-32002, "symbol not found" + hint, null);
    }
    PsiFile definitionFile = definition.getContainingFile();
    if (definitionFile == null || definitionFile.getVirtualFile() == null) {
      throw new JsonRpcServer.RpcException(-32603, "internal error", null);
    }
    String definitionPath = ReadViewService.displayPath(definitionFile.getVirtualFile(), project);
    Integer definitionLine = lineOf(project, definitionFile, definition);
    if (definitionLine == null) {
      throw new JsonRpcServer.RpcException(-32603, "internal error", null);
    }
    // 定义解析（尤其索引损坏时的文件扫描）可能耗时：引用/callees/入口从此刻重新计时，
    // 避免预算被解析阶段耗尽而返回空结果。
    deadlineNanos = System.nanoTime() + TIME_BUDGET_NANOS;

    List<Caller> callers = new ArrayList<>();
    Set<String> callerKeys = new LinkedHashSet<>();
    boolean jsDefinition = JavaScriptSupport.isJsElement(definition);
    if (jsDefinition) {
      // 硬约束：JS/TS 不调用 ReferencesSearch/resolve（会触发 TypeScript 语言服务并阻塞）
      collectJsCallers(project, definition, scopeFile, deadlineNanos, callers, callerKeys);
    } else {
      try {
        for (PsiReference reference : ReferencesSearch.search(definition, searchScope).findAll()) {
          Caller caller = describeReference(project, reference);
          if (caller == null) continue;
          // 按调用点去重（不按文件合并），保留行号
          if (callerKeys.add(caller.file + "|" + caller.line + "|" + caller.context)) {
            callers.add(caller);
          }
        }
      } catch (IndexNotReadyException e) {
        throw e;
      } catch (Throwable t) {
        Log.warn("references search failed: " + t);
      }
    }
    // 词/引用索引在裸目录或未配置解释器的 Python 项目下可能为空：退化为有界文件扫描
    if (callers.isEmpty() && ReadViewService.isPythonElement(definition)) {
      for (PsiReference reference :
          scanPythonReferences(project, definition, scopeFile, deadlineNanos, 500)) {
        Caller caller = describeReference(project, reference);
        if (caller == null) continue;
        if (callerKeys.add(caller.file + "|" + caller.line + "|" + caller.context)) {
          callers.add(caller);
        }
      }
      // 无解释器时 Python 引用无法 resolve（类型推断缺失）：再退化为名称级匹配
      if (callers.isEmpty() && definition instanceof PsiNamedElement named) {
        String definitionName = named.getName();
        if (definitionName != null) {
          for (PsiElement occurrence :
              scanPythonNameOccurrences(project, definitionName, scopeFile, deadlineNanos, 500)) {
            Caller caller = describeElement(project, occurrence);
            if (caller == null) continue;
            if (callerKeys.add(caller.file + "|" + caller.line + "|" + caller.context)) {
              callers.add(caller);
            }
          }
        }
      }
      if (!callers.isEmpty()) {
        Log.info("python reference index miss; fallback scan found " + callers.size() + " callers");
      }
    }
    callers.sort(
        Comparator.comparingInt((Caller caller) -> caller.test ? 1 : 0)
            .thenComparing(caller -> caller.file)
            .thenComparingInt(caller -> caller.line));

    int callersTotal = callers.size();
    boolean truncated = callersTotal > CALLERS_LIMIT;
    List<Caller> returnedCallers =
        truncated ? new ArrayList<>(callers.subList(0, CALLERS_LIMIT)) : callers;

    List<Callee> callees = collectCallees(project, definition, deadlineNanos);

    Set<String> affectedFiles = new TreeSet<>();
    affectedFiles.add(definitionPath);
    for (Caller caller : callers) {
      if (!caller.test) affectedFiles.add(caller.file);
    }

    List<Caller> testCallers = new ArrayList<>();
    Set<String> testKeys = new LinkedHashSet<>();
    for (Caller caller : callers) {
      if (!caller.test) continue;
      if (testKeys.add(caller.file + "|" + caller.line)) testCallers.add(caller);
    }
    testCallers.sort(
        Comparator.comparing((Caller caller) -> caller.file)
            .thenComparingInt(caller -> caller.line));

    Set<String> jsEntryFiles =
        jsDefinition ? resolveJsEntryFiles(project, deadlineNanos) : Set.of();
    List<EntryPoint> entryPoints =
        collectEntryPoints(
            project, callers, searchScope, scopeFile, deadlineNanos, jsEntryFiles);

    boolean hasPublicApiUsage = callers.stream().anyMatch(caller -> caller.publicApi);
    long productionCallers = callers.stream().filter(caller -> !caller.test).count();
    String risk = hasPublicApiUsage ? "high" : productionCallers == 0 ? "low" : "medium";

    JsonObject result = new JsonObject();
    result.addProperty("symbol", symbol);

    JsonObject definitionJson = new JsonObject();
    definitionJson.addProperty("file", definitionPath);
    definitionJson.addProperty("line", definitionLine);
    definitionJson.addProperty("kind", kindOf(definition));
    result.add("definition", definitionJson);

    JsonArray callersJson = new JsonArray();
    for (Caller caller : returnedCallers) callersJson.add(caller.toJson());
    result.add("callers", callersJson);

    JsonArray calleesJson = new JsonArray();
    for (Callee callee : callees) calleesJson.add(callee.toJson());
    result.add("callees", calleesJson);

    JsonArray affectedJson = new JsonArray();
    for (String file : affectedFiles) affectedJson.add(file);
    result.add("affected_files", affectedJson);

    JsonArray entriesJson = new JsonArray();
    for (EntryPoint entryPoint : entryPoints) entriesJson.add(entryPoint.toJson());
    result.add("entry_points", entriesJson);

    JsonArray testsJson = new JsonArray();
    for (Caller caller : testCallers) {
      JsonObject test = new JsonObject();
      test.addProperty("file", caller.file);
      test.addProperty("line", caller.line);
      test.addProperty("name", caller.context);
      testsJson.add(test);
    }
    result.add("tests_affected", testsJson);

    JsonObject summary = new JsonObject();
    summary.addProperty("callers_count", returnedCallers.size());
    if (truncated) summary.addProperty("callers_total", callersTotal);
    summary.addProperty("callees_count", callees.size());
    summary.addProperty("files_count", affectedFiles.size());
    summary.addProperty("has_public_api_usage", hasPublicApiUsage);
    summary.addProperty("risk", risk);
    result.add("summary", summary);

    return result;
  }

  // ---- 定义解析（短名 / Class#method） ----

  private static PsiElement resolveDefinition(
      Project project, String symbol, VirtualFile scopeFile) {
    String language = scopeLanguage(project, scopeFile);
    boolean javaSupport = JavaSupport.available();
    boolean pythonSupport = PythonSupport.available();
    boolean jsSupport = JavaScriptSupport.available();

    // scope 指定文件时优先该文件语言（混合仓库避免同名 Java/Python 符号抢先）
    if (JavaScriptSupport.isJsLanguage(language) && jsSupport) {
      PsiElement found = resolveJsSafe(project, symbol);
      if (found != null) return found;
    }
    if ("Python".equals(language) && pythonSupport) {
      PsiElement found = resolvePythonSafe(project, symbol);
      if (found != null) return found;
    }
    if (javaSupport) {
      PsiElement found = resolveJavaSafe(project, symbol);
      if (found != null) return found;
    }
    if (pythonSupport) {
      PsiElement found = resolvePythonSafe(project, symbol);
      if (found != null) return found;
    }
    if (jsSupport) {
      PsiElement found = resolveJsSafe(project, symbol);
      if (found != null) return found;
    }
    return null;
  }

  private static String scopeLanguage(Project project, VirtualFile scopeFile) {
    if (scopeFile == null) return null;
    try {
      PsiFile psiFile = PsiManager.getInstance(project).findFile(scopeFile);
      return psiFile == null ? null : psiFile.getLanguage().getID();
    } catch (Throwable t) {
      return null;
    }
  }

  private static PsiElement resolvePythonSafe(Project project, String symbol) {
    try {
      return resolvePythonDefinition(project, symbol);
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (Throwable t) {
      Log.warn("python symbol resolution failed: " + t);
      return null;
    }
  }

  private static PsiElement resolveJavaSafe(Project project, String symbol) {
    try {
      return resolveJavaDefinition(project, symbol);
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (Throwable t) {
      // Java 索引/插件损坏（如缺失 stub builder）只影响 Java 路径，继续尝试其他语言
      Log.warn("java symbol resolution failed: " + t);
      return null;
    }
  }

  private static PsiElement resolveJsSafe(Project project, String symbol) {
    try {
      return resolveJsDefinition(project, symbol);
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (Throwable t) {
      Log.warn("javascript symbol resolution failed: " + t);
      return null;
    }
  }

  private static PsiElement resolveJavaDefinition(Project project, String symbol) {
    int hash = symbol.indexOf('#');
    if (hash > 0) {
      String className = symbol.substring(0, hash);
      String memberName = symbol.substring(hash + 1);
      PsiClass owner = findClass(project, className);
      if (owner != null && memberName.isEmpty()) return owner;
      if (owner != null) {
        PsiMethod[] methods = owner.findMethodsByName(memberName, false);
        if (methods.length > 0) return firstByLocation(methods);
        PsiField field = owner.findFieldByName(memberName, false);
        if (field != null) return field;
        PsiClass inner = owner.findInnerClassByName(memberName, false);
        if (inner != null) return inner;
      }
    }

    PsiClass exactClass = findClass(project, symbol);
    if (exactClass != null) return exactClass;

    PsiShortNamesCache shortNames = PsiShortNamesCache.getInstance(project);
    PsiMethod[] methods = shortNames.getMethodsByName(symbol, GlobalSearchScope.projectScope(project));
    if (methods.length > 0) return firstByLocation(methods);
    PsiField[] fields = shortNames.getFieldsByName(symbol, GlobalSearchScope.projectScope(project));
    if (fields.length > 0) return firstByLocation(fields);
    return null;
  }

  private static PsiClass findClass(Project project, String name) {
    try {
      PsiClass found =
          JavaPsiFacade.getInstance(project).findClass(name, GlobalSearchScope.allScope(project));
      if (found != null) return found;
    } catch (IndexNotReadyException e) {
      throw e; // 索引未就绪交给上层映射为可重试的 -32000
    } catch (Throwable t) {
      Log.warn("findClass failed: " + t);
    }
    try {
      PsiClass[] classes =
          PsiShortNamesCache.getInstance(project)
              .getClassesByName(name, GlobalSearchScope.projectScope(project));
      if (classes.length > 0) return firstByLocation(classes);
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (Throwable t) {
      Log.warn("short name class lookup failed: " + t);
    }
    return null;
  }

  private static <T extends PsiElement> T firstByLocation(T[] candidates) {
    return Arrays.stream(candidates)
        .filter(candidate -> candidate != null && candidate.isValid())
        .min(
            Comparator.comparing(BlastRadiusService::filePathOf)
                .thenComparingInt(
                    candidate -> {
                      TextRange range = candidate.getTextRange();
                      return range == null ? 0 : range.getStartOffset();
                    }))
        .orElse(null);
  }

  // ---- Python 定义解析（词索引 + 项目内声明过滤） ----

  /**
   * Python 符号：`name` / `Class.name` / `module.name`（末段为名称，`.` 与 `#` 均可作分隔）。
   * 用平台的词索引找同名声明，再用 qualifier 过滤类名/模块路径；不引用 python 插件类。
   */
  private static PsiElement resolvePythonDefinition(Project project, String symbol) {
    int separator = Math.max(symbol.lastIndexOf('#'), symbol.lastIndexOf('.'));
    String qualifier = separator > 0 ? symbol.substring(0, separator) : null;
    String name = separator > 0 ? symbol.substring(separator + 1) : symbol;
    if (name.isEmpty()) return null;

    List<PsiElement> foundDefinitions = new ArrayList<>();
    try {
      PsiSearchHelper.getInstance(project)
          .processElementsWithWord(
              (element, offset) -> {
                PsiElement definition = pythonDefinitionAt(element, name);
                if (definition != null && !foundDefinitions.contains(definition)) {
                  foundDefinitions.add(definition);
                }
                return foundDefinitions.size() < 200;
              },
              GlobalSearchScope.projectScope(project),
              name,
              UsageSearchContext.IN_CODE,
              true);
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (Throwable t) {
      Log.warn("python word index failed, falling back to file scan: " + t);
    }
    if (foundDefinitions.isEmpty()) {
      // 词索引在部分 Python 项目/沙箱下不覆盖声明（无解释器配置或未加入索引的目录）：
      // 退化为项目内 .py 有界扫描，保证定义解析可用（上限 5000 文件 / 50 个候选）。
      collectPythonDefinitions(project, name, foundDefinitions);
      if (!foundDefinitions.isEmpty()) {
        Log.info("python symbol word index miss; file scan found " + foundDefinitions.size());
      }
    }
    if (foundDefinitions.isEmpty()) return null;

    List<PsiElement> definitions = foundDefinitions;
    if (qualifier != null) {
      List<PsiElement> matched =
          foundDefinitions.stream()
              .filter(definition -> pythonQualifierMatches(project, definition, qualifier))
              .toList();
      if (!matched.isEmpty()) definitions = new ArrayList<>(matched);
    }
    definitions.sort(
        Comparator.comparing((PsiElement definition) -> isTestPath(filePathOf(definition)) ? 1 : 0)
            .thenComparing(BlastRadiusService::filePathOf)
            .thenComparingInt(
                definition -> {
                  TextRange range = definition.getTextRange();
                  return range == null ? 0 : range.getStartOffset();
                }));
    return definitions.get(0);
  }

  private static void collectPythonDefinitions(
      Project project, String name, List<PsiElement> found) {
    VirtualFile baseDir = ProjectUtil.guessProjectDir(project);
    if (baseDir == null) return;
    PsiManager psiManager = PsiManager.getInstance(project);
    int[] visited = {0};
    walkSourceFiles(
        psiManager,
        baseDir,
        "",
        visited,
        fileName -> fileName.endsWith(".py"),
        psiFile -> {
          findPythonDefinitionsInFile(psiFile, name, found);
          return found.size() < 50;
        });
  }

  private static void walkSourceFiles(
      PsiManager psiManager,
      VirtualFile dir,
      String relative,
      int[] visited,
      Predicate<String> fileFilter,
      SourceFileAction action) {
    walkSourceFileRefs(
        dir,
        relative,
        visited,
        fileFilter,
        file -> {
          try {
            PsiFile psiFile = psiManager.findFile(file);
            return psiFile == null || action.visit(psiFile);
          } catch (Throwable t) {
            Log.warn("source file scan failed (" + file.getPath() + "): " + t);
            return true;
          }
        });
  }

  private static void walkSourceFileRefs(
      VirtualFile dir,
      String relative,
      int[] visited,
      Predicate<String> fileFilter,
      SourceFileRefAction action) {
    for (VirtualFile child : dir.getChildren()) {
      if (visited[0] >= 5000) return;
      if (child.isDirectory()) {
        if (child.getName().startsWith(".") || child.is(VFileProperty.SYMLINK)) continue;
        String childRelative =
            relative.isEmpty() ? child.getName() : relative + "/" + child.getName();
        if (Exclusions.excludesDir(childRelative, child.getName())) continue;
        walkSourceFileRefs(child, childRelative, visited, fileFilter, action);
        continue;
      }
      if (!fileFilter.test(child.getName())) continue;
      visited[0]++;
      try {
        if (!action.visit(child)) return;
      } catch (Throwable t) {
        Log.warn("source file scan failed (" + child.getPath() + "): " + t);
      }
    }
  }

  private interface SourceFileAction {
    boolean visit(PsiFile file);
  }

  private interface SourceFileRefAction {
    boolean visit(VirtualFile file);
  }

  /** 文本级预筛选：索引损坏时避免对每个 JS/TS 文件都构建 PSI。 */
  private static boolean contentsContainWord(VirtualFile file, String name) {
    try {
      return VfsUtilCore.loadText(file).contains(name);
    } catch (Throwable t) {
      return false;
    }
  }

  /** 词索引不可用（裸目录/未配置解释器）时的引用兜底：有界扫描项目 .py 文件。 */
  private static List<PsiReference> scanPythonReferences(
      Project project, PsiElement target, VirtualFile scopeFile, long deadlineNanos, int limit) {
    PsiManager psiManager = PsiManager.getInstance(project);
    List<PsiReference> found = new ArrayList<>();
    SourceFileAction action =
        psiFile -> {
          collectPythonReferencesInFile(psiFile, target, deadlineNanos, limit, found);
          return found.size() < limit && System.nanoTime() < deadlineNanos;
        };
    if (scopeFile != null) {
      if (!scopeFile.getName().endsWith(".py")) return found;
      PsiFile psiFile = psiManager.findFile(scopeFile);
      if (psiFile != null) action.visit(psiFile);
      return found;
    }
    VirtualFile baseDir = ProjectUtil.guessProjectDir(project);
    if (baseDir != null) {
      walkSourceFiles(
          psiManager, baseDir, "", new int[] {0}, fileName -> fileName.endsWith(".py"), action);
    }
    return found;
  }

  private static void collectPythonReferencesInFile(
      PsiFile psiFile,
      PsiElement target,
      long deadlineNanos,
      int limit,
      List<PsiReference> found) {
    psiFile.accept(
        new PsiRecursiveElementWalkingVisitor() {
          @Override
          public void visitElement(PsiElement element) {
            if (found.size() >= limit || System.nanoTime() > deadlineNanos) {
              stopWalking();
              return;
            }
            PsiReference reference = element.getReference();
            if (reference != null) {
              try {
                if (reference.resolve() == target) found.add(reference);
              } catch (Throwable ignored) {
                // 逐元素 resolve 失败按未命中处理
              }
            }
            super.visitElement(element);
          }
        });
  }

  /** 无解释器/索引时的名称级兜底：精确标识符文本匹配，跳过声明名本身。 */
  private static List<PsiElement> scanPythonNameOccurrences(
      Project project, String name, VirtualFile scopeFile, long deadlineNanos, int limit) {
    PsiManager psiManager = PsiManager.getInstance(project);
    List<PsiElement> found = new ArrayList<>();
    SourceFileAction action =
        psiFile -> {
          collectPythonNameOccurrencesInFile(psiFile, name, deadlineNanos, limit, found);
          return found.size() < limit && System.nanoTime() < deadlineNanos;
        };
    if (scopeFile != null) {
      if (!scopeFile.getName().endsWith(".py")) return found;
      PsiFile psiFile = psiManager.findFile(scopeFile);
      if (psiFile != null) action.visit(psiFile);
      return found;
    }
    VirtualFile baseDir = ProjectUtil.guessProjectDir(project);
    if (baseDir != null) {
      walkSourceFiles(
          psiManager, baseDir, "", new int[] {0}, fileName -> fileName.endsWith(".py"), action);
    }
    return found;
  }

  private static void collectPythonNameOccurrencesInFile(
      PsiFile psiFile,
      String name,
      long deadlineNanos,
      int limit,
      List<PsiElement> found) {
    psiFile.accept(
        new PsiRecursiveElementWalkingVisitor() {
          @Override
          public void visitElement(PsiElement element) {
            if (found.size() >= limit || System.nanoTime() > deadlineNanos) {
              stopWalking();
              return;
            }
            if (name.equals(element.getText())
                && !(element.getParent() instanceof PsiNameIdentifierOwner owner
                    && owner.getNameIdentifier() == element)
                && !found.contains(element)) {
              found.add(element);
            }
            super.visitElement(element);
          }
        });
  }

  private static void findPythonDefinitionsInFile(
      PsiFile psiFile, String name, List<PsiElement> found) {
    psiFile.accept(
        new PsiRecursiveElementWalkingVisitor() {
          @Override
          public void visitElement(PsiElement element) {
            if (found.size() >= 50) {
              stopWalking();
              return;
            }
            if (element instanceof PsiNameIdentifierOwner owner
                && name.equals(owner.getName())
                && ReadViewService.pythonSymbolKind(element) >= 0
                && owner.getNameIdentifier() != null
                && !found.contains(element)) {
              found.add(element);
            }
            super.visitElement(element);
          }
        });
  }

  /** 词出现点 → 同名的 Python 声明（名称标识符必须覆盖该出现点，避免把同名外层函数当定义）。 */
  private static PsiElement pythonDefinitionAt(PsiElement occurrence, String name) {
    TextRange occurrenceRange;
    try {
      occurrenceRange = occurrence.getTextRange();
    } catch (Throwable t) {
      return null;
    }
    if (occurrenceRange == null) return null;
    for (PsiElement current = occurrence;
        current != null && !(current instanceof PsiFile);
        current = current.getParent()) {
      if (!(current instanceof PsiNameIdentifierOwner owner)) continue;
      if (ReadViewService.pythonSymbolKind(current) < 0) continue;
      if (!name.equals(owner.getName())) continue;
      PsiElement identifier = owner.getNameIdentifier();
      if (identifier == null) continue;
      TextRange identifierRange = identifier.getTextRange();
      if (identifierRange == null) continue;
      if (identifierRange.contains(occurrenceRange.getStartOffset())) return current;
    }
    return null;
  }

  /** qualifier 与类名/模块点分路径的后缀匹配（`Class`、`module.Class`、`src.module.Class` 均可）。 */
  private static boolean pythonQualifierMatches(
      Project project, PsiElement definition, String qualifier) {
    PsiElement ownerClass = pythonEnclosingClass(definition);
    if (ownerClass instanceof PsiNamedElement named) {
      String className = named.getName();
      if (className != null && suffixMatches(className, qualifier)) return true;
    }
    PsiFile file = definition.getContainingFile();
    if (file == null || file.getVirtualFile() == null) return false;
    String path = ReadViewService.displayPath(file.getVirtualFile(), project);
    if (!path.endsWith(".py")) return false;
    String dotted = path.substring(0, path.length() - 3).replace('/', '.');
    if (dotted.startsWith("src.")) dotted = dotted.substring(4);
    return suffixMatches(dotted, qualifier);
  }

  private static boolean suffixMatches(String candidate, String value) {
    return value.equals(candidate)
        || value.endsWith("." + candidate)
        || candidate.endsWith("." + value);
  }

  private static PsiElement pythonEnclosingClass(PsiElement element) {
    for (PsiElement current = element.getParent();
        current != null && !(current instanceof PsiFile);
        current = current.getParent()) {
      if (ReadViewService.pythonSymbolKind(current) == 0) return current;
    }
    return null;
  }

  // ---- JS/TS 定义解析（语法级：词索引 + 有界扫描，绝不调用 resolve） ----

  private static PsiElement resolveJsDefinition(Project project, String symbol) {
    int separator = Math.max(symbol.lastIndexOf('#'), symbol.lastIndexOf('.'));
    String qualifier = separator > 0 ? symbol.substring(0, separator) : null;
    String name = separator > 0 ? symbol.substring(separator + 1) : symbol;
    if (name.isEmpty()) return null;

    List<PsiElement> foundDefinitions = new ArrayList<>();
    try {
      PsiSearchHelper.getInstance(project)
          .processElementsWithWord(
              (element, offset) -> {
                PsiElement definition = jsDefinitionAt(element, offset, name);
                if (definition != null && !foundDefinitions.contains(definition)) {
                  foundDefinitions.add(definition);
                }
                return foundDefinitions.size() < 200;
              },
              GlobalSearchScope.projectScope(project),
              name,
              UsageSearchContext.IN_CODE,
              true);
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (Throwable t) {
      Log.warn("javascript word index failed, falling back to file scan: " + t);
    }
    if (foundDefinitions.isEmpty()) {
      collectJsDefinitions(project, name, foundDefinitions);
      if (!foundDefinitions.isEmpty()) {
        Log.info("javascript symbol word index miss; file scan found " + foundDefinitions.size());
      }
    }
    if (foundDefinitions.isEmpty()) return null;

    List<PsiElement> definitions = foundDefinitions;
    if (qualifier != null) {
      List<PsiElement> matched =
          foundDefinitions.stream()
              .filter(definition -> jsQualifierMatches(project, definition, qualifier))
              .toList();
      if (!matched.isEmpty()) definitions = new ArrayList<>(matched);
    }
    definitions.sort(
        Comparator.comparing((PsiElement definition) -> isTestPath(filePathOf(definition)) ? 1 : 0)
            .thenComparing(BlastRadiusService::filePathOf)
            .thenComparingInt(
                definition -> {
                  TextRange range = definition.getTextRange();
                  return range == null ? 0 : range.getStartOffset();
                }));
    return definitions.get(0);
  }

  private static PsiElement jsDefinitionAt(PsiElement occurrence, int offset, String name) {
    TextRange occurrenceRange;
    try {
      occurrenceRange = occurrence.getTextRange();
    } catch (Throwable t) {
      return null;
    }
    if (occurrenceRange == null) return null;
    for (PsiElement current = occurrence;
        current != null && !(current instanceof PsiFile);
        current = current.getParent()) {
      if (!(current instanceof PsiNameIdentifierOwner owner)) continue;
      if (JavaScriptSupport.symbolKind(current) < 0) continue;
      if (!name.equals(owner.getName())) continue;
      PsiElement identifier = owner.getNameIdentifier();
      if (identifier == null) continue;
      TextRange identifierRange = identifier.getTextRange();
      if (identifierRange == null) continue;
      if (identifierRange.contains(occurrenceRange.getStartOffset() + offset)) return current;
    }
    return null;
  }

  private static boolean jsQualifierMatches(
      Project project, PsiElement definition, String qualifier) {
    PsiElement ownerClass = jsEnclosingClass(definition);
    if (ownerClass instanceof PsiNamedElement named) {
      String className = named.getName();
      if (className != null && suffixMatches(className, qualifier)) return true;
    }
    PsiFile file = definition.getContainingFile();
    if (file == null || file.getVirtualFile() == null) return false;
    String path = ReadViewService.displayPath(file.getVirtualFile(), project);
    int dot = path.lastIndexOf('.');
    String dotted = (dot > 0 ? path.substring(0, dot) : path).replace('/', '.');
    return suffixMatches(dotted, qualifier);
  }

  private static PsiElement jsEnclosingClass(PsiElement element) {
    for (PsiElement current = element.getParent();
        current != null && !(current instanceof PsiFile);
        current = current.getParent()) {
      if (JavaScriptSupport.symbolKind(current) == 0) return current;
    }
    return null;
  }

  private static void collectJsDefinitions(Project project, String name, List<PsiElement> found) {
    VirtualFile baseDir = ProjectUtil.guessProjectDir(project);
    if (baseDir == null) return;
    PsiManager psiManager = PsiManager.getInstance(project);
    walkSourceFileRefs(
        baseDir,
        "",
        new int[] {0},
        JavaScriptSupport::isJsFile,
        file -> {
          if (!contentsContainWord(file, name)) return true;
          try {
            PsiFile psiFile = psiManager.findFile(file);
            if (psiFile != null) findJsDefinitionsInFile(psiFile, name, found);
          } catch (Throwable t) {
            Log.warn("javascript definition scan failed (" + file.getPath() + "): " + t);
          }
          return found.size() < 10;
        });
  }

  private static void findJsDefinitionsInFile(
      PsiFile psiFile, String name, List<PsiElement> found) {
    psiFile.accept(
        new PsiRecursiveElementWalkingVisitor() {
          @Override
          public void visitElement(PsiElement element) {
            if (found.size() >= 50) {
              stopWalking();
              return;
            }
            if (element instanceof PsiNameIdentifierOwner owner
                && name.equals(owner.getName())
                && JavaScriptSupport.symbolKind(element) >= 0
                && owner.getNameIdentifier() != null
                && !found.contains(element)) {
              found.add(element);
            }
            super.visitElement(element);
          }
        });
  }

  /** callees 用的轻量声明查找：只用词索引，不做文件扫描，受调用点上限约束。 */
  private static List<PsiElement> findJsDefinitionsByName(
      Project project, String name, int limit) {
    List<PsiElement> found = new ArrayList<>();
    try {
      PsiSearchHelper.getInstance(project)
          .processElementsWithWord(
              (element, offset) -> {
                PsiElement definition = jsDefinitionAt(element, offset, name);
                if (definition != null && !found.contains(definition)) found.add(definition);
                return found.size() < limit;
              },
              GlobalSearchScope.projectScope(project),
              name,
              UsageSearchContext.IN_CODE,
              true);
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (Throwable t) {
      Log.warn("javascript callee word lookup failed (" + name + "): " + t);
    }
    return found;
  }

  private static void collectJsCallers(
      Project project,
      PsiElement definition,
      VirtualFile scopeFile,
      long deadlineNanos,
      List<Caller> callers,
      Set<String> callerKeys) {
    if (!(definition instanceof PsiNamedElement named)) return;
    String name = named.getName();
    if (name == null || name.isEmpty()) return;
    for (PsiElement occurrence : findJsOccurrences(project, name, scopeFile, deadlineNanos, 1000)) {
      Caller caller = describeElement(project, occurrence);
      if (caller == null) continue;
      if (callerKeys.add(caller.file + "|" + caller.line + "|" + caller.context)) {
        callers.add(caller);
      }
    }
  }

  /** 名称级出现点：词索引优先，索引为空时扫描 JS/TS 文件；排除声明名本身。 */
  private static List<PsiElement> findJsOccurrences(
      Project project, String name, VirtualFile scopeFile, long deadlineNanos, int limit) {
    List<PsiElement> found = new ArrayList<>();
    SearchScope scope =
        scopeFile != null
            ? GlobalSearchScope.fileScope(project, scopeFile)
            : GlobalSearchScope.projectScope(project);
    try {
      PsiSearchHelper.getInstance(project)
          .processElementsWithWord(
              (element, offset) -> {
                if (found.size() >= limit || System.nanoTime() > deadlineNanos) return false;
                PsiElement leaf = element;
                try {
                  int local =
                      Math.max(0, Math.min(offset, Math.max(0, element.getTextLength() - 1)));
                  PsiElement at = element.findElementAt(local);
                  if (at != null) leaf = at;
                } catch (Throwable ignored) {
                  // 取叶子失败时退回整个元素
                }
                if (isJsOccurrence(leaf, name) && !found.contains(leaf)) found.add(leaf);
                return true;
              },
              scope,
              name,
              UsageSearchContext.IN_CODE,
              true);
    } catch (IndexNotReadyException e) {
      throw e;
    } catch (Throwable t) {
      Log.warn("javascript occurrence index failed, falling back to file scan: " + t);
    }
    if (!found.isEmpty()) return found;

    if (scopeFile != null) {
      if (!JavaScriptSupport.isJsFile(scopeFile.getName())) return found;
      PsiFile psiFile = PsiManager.getInstance(project).findFile(scopeFile);
      if (psiFile != null) {
        collectJsNameOccurrencesInFile(psiFile, name, deadlineNanos, limit, found);
      }
      return found;
    }
    VirtualFile baseDir = ProjectUtil.guessProjectDir(project);
    if (baseDir == null) return found;
    PsiManager psiManager = PsiManager.getInstance(project);
    walkSourceFileRefs(
        baseDir,
        "",
        new int[] {0},
        JavaScriptSupport::isJsFile,
        file -> {
          if (!contentsContainWord(file, name)) return true;
          try {
            PsiFile psiFile = psiManager.findFile(file);
            if (psiFile != null) {
              collectJsNameOccurrencesInFile(psiFile, name, deadlineNanos, limit, found);
            }
          } catch (Throwable t) {
            Log.warn("javascript occurrence scan failed (" + file.getPath() + "): " + t);
          }
          return found.size() < limit && System.nanoTime() < deadlineNanos;
        });
    return found;
  }

  private static boolean isJsOccurrence(PsiElement leaf, String name) {
    if (leaf == null || !name.equals(leaf.getText())) return false;
    if (leaf.getParent() instanceof PsiNameIdentifierOwner owner
        && owner.getNameIdentifier() == leaf) {
      return false;
    }
    PsiFile file = leaf.getContainingFile();
    return file != null && isJsPsi(leaf, file);
  }

  private static void collectJsNameOccurrencesInFile(
      PsiFile psiFile,
      String name,
      long deadlineNanos,
      int limit,
      List<PsiElement> found) {
    psiFile.accept(
        new PsiRecursiveElementWalkingVisitor() {
          @Override
          public void visitElement(PsiElement element) {
            if (found.size() >= limit || System.nanoTime() > deadlineNanos) {
              stopWalking();
              return;
            }
            if (isJsOccurrence(element, name) && !found.contains(element)) found.add(element);
            super.visitElement(element);
          }
        });
  }

  // ---- JS/TS callees（语法级：标识符名 + 词索引声明查找，不 resolve） ----

  private static List<Callee> collectJsCallees(
      Project project, PsiElement definition, long deadlineNanos) {
    PsiElement definitionOwnerClass = jsEnclosingClass(definition);
    Set<String> localNames = new HashSet<>();
    definition.accept(
        new PsiRecursiveElementWalkingVisitor() {
          @Override
          public void visitElement(PsiElement element) {
            if (element != definition && JavaScriptSupport.symbolKind(element) >= 0
                && element instanceof PsiNamedElement named
                && named.getName() != null) {
              localNames.add(named.getName());
            }
            super.visitElement(element);
          }
        });

    Set<String> candidateNames = new LinkedHashSet<>();
    definition.accept(
        new PsiRecursiveElementWalkingVisitor() {
          @Override
          public void visitElement(PsiElement element) {
            if (candidateNames.size() >= 30 || System.nanoTime() > deadlineNanos) {
              stopWalking();
              return;
            }
            if (element.getReference() != null) {
              String text = element.getText();
              if (text != null) {
                int dot = text.lastIndexOf('.');
                if (dot >= 0) text = text.substring(dot + 1);
                if (text.matches("[A-Za-z_$][A-Za-z0-9_$]*")
                    && !localNames.contains(text)) {
                  candidateNames.add(text);
                }
              }
            }
            super.visitElement(element);
          }
        });

    Map<String, Callee> unique = new LinkedHashMap<>();
    for (String candidate : candidateNames) {
      if (System.nanoTime() > deadlineNanos || unique.size() >= CALLEES_LIMIT) break;
      for (PsiElement target : findJsDefinitionsByName(project, candidate, 5)) {
        if (target == definition || !target.isValid()) continue;
        PsiFile targetFile = target.getContainingFile();
        if (targetFile == null || targetFile.getVirtualFile() == null) continue;
        if (!insideProject(project, targetFile)) continue;
        if (!(target instanceof PsiNamedElement named)) continue;
        String targetName = named.getName();
        if (targetName == null || targetName.isEmpty()) continue;
        String symbol = targetName;
        int kind = JavaScriptSupport.symbolKind(target);
        if (kind == 1 || kind == 2) {
          PsiElement targetOwnerClass = jsEnclosingClass(target);
          if (targetOwnerClass != null
              && targetOwnerClass != definitionOwnerClass
              && targetOwnerClass instanceof PsiNamedElement ownerNamed
              && ownerNamed.getName() != null) {
            symbol = ownerNamed.getName() + "." + targetName;
          }
        }
        Integer line = lineOf(project, targetFile, target);
        if (line == null) continue;
        String file = ReadViewService.displayPath(targetFile.getVirtualFile(), project);
        unique.putIfAbsent(symbol + "|" + file + "|" + line, new Callee(symbol, file, line));
        break;
      }
    }
    List<Callee> callees = new ArrayList<>(unique.values());
    callees.sort(
        Comparator.comparing((Callee callee) -> callee.file)
            .thenComparingInt(callee -> callee.line)
            .thenComparing(callee -> callee.symbol));
    if (callees.size() > CALLEES_LIMIT) {
      callees = new ArrayList<>(callees.subList(0, CALLEES_LIMIT));
    }
    return callees;
  }

  // ---- JS/TS 入口文件（package.json main/bin） ----

  private static Set<String> resolveJsEntryFiles(Project project, long deadlineNanos) {
    VirtualFile baseDir = ProjectUtil.guessProjectDir(project);
    if (baseDir == null) return Set.of();
    List<VirtualFile> manifests = new ArrayList<>();
    collectPackageJsonFiles(baseDir, "", manifests, new int[] {0}, deadlineNanos);
    Set<String> entryFiles = new HashSet<>();
    Path rootPath = Path.of(baseDir.getPath());
    for (VirtualFile manifest : manifests) {
      String text;
      try {
        text = VfsUtilCore.loadText(manifest);
      } catch (IOException e) {
        continue;
      }
      JsonObject json;
      try {
        json = JsonParser.parseString(text).getAsJsonObject();
      } catch (Throwable t) {
        continue;
      }
      JsonElement main = json.get("main");
      if (main != null && main.isJsonPrimitive() && main.getAsJsonPrimitive().isString()) {
        addEntryFile(
            entryFiles, rootPath, manifest.getParent().getPath(), main.getAsString());
      }
      JsonElement bin = json.get("bin");
      if (bin != null && bin.isJsonPrimitive() && bin.getAsJsonPrimitive().isString()) {
        addEntryFile(
            entryFiles, rootPath, manifest.getParent().getPath(), bin.getAsString());
      } else if (bin != null && bin.isJsonObject()) {
        for (Map.Entry<String, JsonElement> item : bin.getAsJsonObject().entrySet()) {
          if (item.getValue().isJsonPrimitive()
              && item.getValue().getAsJsonPrimitive().isString()) {
            addEntryFile(
                entryFiles,
                rootPath,
                manifest.getParent().getPath(),
                item.getValue().getAsString());
          }
        }
      }
    }
    return entryFiles;
  }

  private static void collectPackageJsonFiles(
      VirtualFile dir,
      String relative,
      List<VirtualFile> manifests,
      int[] visited,
      long deadlineNanos) {
    if (manifests.size() >= 200 || System.nanoTime() > deadlineNanos) return;
    for (VirtualFile child : dir.getChildren()) {
      if (visited[0] >= 5000 || System.nanoTime() > deadlineNanos) return;
      if (child.isDirectory()) {
        if (child.getName().startsWith(".") || child.is(VFileProperty.SYMLINK)) continue;
        String childRelative =
            relative.isEmpty() ? child.getName() : relative + "/" + child.getName();
        if (Exclusions.excludesDir(childRelative, child.getName())) continue;
        collectPackageJsonFiles(child, childRelative, manifests, visited, deadlineNanos);
        continue;
      }
      visited[0]++;
      if ("package.json".equals(child.getName())) manifests.add(child);
    }
  }

  private static void addEntryFile(
      Set<String> entryFiles, Path rootPath, String manifestDir, String specifier) {
    try {
      Path candidate = Path.of(manifestDir).resolve(specifier).normalize();
      if (!candidate.startsWith(rootPath)) return;
      for (String resolved : candidateVariants(candidate)) {
        if (!Files.isRegularFile(Path.of(resolved))) continue;
        String relative = rootPath.relativize(Path.of(resolved)).toString().replace('\\', '/');
        entryFiles.add(relative);
        return;
      }
    } catch (Throwable ignored) {
      // 非法 main/bin 路径（URL/协议）忽略
    }
  }

  private static List<String> candidateVariants(Path path) {
    List<String> candidates = new ArrayList<>();
    String text = path.toString();
    candidates.add(text);
    for (String extension : List.of(".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")) {
      candidates.add(text + extension);
    }
    for (String extension : List.of(".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")) {
      candidates.add(path.resolve("index" + extension).toString());
    }
    return candidates;
  }

  private static String filePathOf(PsiElement element) {
    PsiFile file = element.getContainingFile();
    if (file == null || file.getVirtualFile() == null) return "";
    return file.getVirtualFile().getPath();
  }

  private static String kindOf(PsiElement definition) {
    if (JavaSupport.available()) {
      if (definition instanceof PsiMethod) return "method";
      if (definition instanceof PsiClass) return "class";
      if (definition instanceof PsiField) return "field";
      if (definition instanceof PsiParameter) return "parameter";
    }
    if (JavaScriptSupport.isJsElement(definition)) {
      return switch (JavaScriptSupport.symbolKind(definition)) {
        case 0 -> "class";
        case 1 -> "method";
        case 2 -> "field";
        case 3 -> "parameter";
        default -> "unknown";
      };
    }
    return switch (ReadViewService.pythonSymbolKind(definition)) {
      case 0 -> "class";
      case 1 -> "method";
      case 2 -> "field";
      default -> "unknown";
    };
  }

  // ---- 引用分类 ----

  private static final class Caller {
    final String file;
    final int line;
    final String context;
    final boolean test;
    final boolean publicApi;
    final PsiElement contextElement;

    Caller(String file, int line, String context, boolean test, boolean publicApi, PsiElement contextElement) {
      this.file = file;
      this.line = line;
      this.context = context;
      this.test = test;
      this.publicApi = publicApi;
      this.contextElement = contextElement;
    }

    JsonObject toJson() {
      JsonObject json = new JsonObject();
      json.addProperty("file", file);
      json.addProperty("line", line);
      json.addProperty("context", context);
      json.addProperty("is_test", test);
      return json;
    }
  }

  private static Caller describeReference(Project project, PsiReference reference) {
    PsiElement element;
    try {
      element = reference.getElement();
    } catch (Throwable t) {
      return null;
    }
    return describeElement(project, element);
  }

  private static Caller describeElement(Project project, PsiElement element) {
    if (element == null || !element.isValid()) return null;
    PsiFile file = element.getContainingFile();
    if (file == null || file.getVirtualFile() == null) return null;
    Integer line = lineOf(project, file, element);
    if (line == null) return null;
    String path = ReadViewService.displayPath(file.getVirtualFile(), project);

    if (isPythonPsi(element, file)) {
      PsiElement contextElement = pythonContext(element);
      String context = fileStem(file);
      boolean publicApi = false;
      if (contextElement instanceof PsiNamedElement named) {
        context = safeName(named, file);
        String name = named.getName();
        publicApi = name != null && !name.startsWith("_") && !isTestPath(path)
            && ReadViewService.pythonSymbolKind(contextElement) >= 0;
      } else if (insideMainGuard(element)) {
        context = "main";
      }
      return new Caller(path, line, context, isTestPath(path), publicApi, contextElement);
    }

    if (isJsPsi(element, file)) {
      PsiElement contextElement = jsContext(element);
      String context = fileStem(file);
      boolean publicApi = false;
      if (contextElement instanceof PsiNamedElement named) {
        context = safeName(named, file);
        String name = named.getName();
        publicApi = name != null && !name.startsWith("_") && !isTestPath(path)
            && JavaScriptSupport.symbolKind(contextElement) >= 0;
      }
      return new Caller(path, line, context, isTestPath(path), publicApi, contextElement);
    }

    PsiMethod contextMethod = PsiTreeUtil.getParentOfType(element, PsiMethod.class, true);
    PsiClass contextClass =
        contextMethod == null ? PsiTreeUtil.getParentOfType(element, PsiClass.class, true) : null;
    String context =
        contextMethod != null
            ? safeName(contextMethod, file)
            : contextClass != null ? safeName(contextClass, file) : fileStem(file);
    boolean publicApi =
        contextMethod != null
            ? contextMethod.hasModifierProperty(PsiModifier.PUBLIC)
            : contextClass != null && contextClass.hasModifierProperty(PsiModifier.PUBLIC);
    return new Caller(path, line, context, isTestPath(path), publicApi, contextMethod);
  }

  private static boolean isPythonPsi(PsiElement element, PsiFile file) {
    if (ReadViewService.isPythonElement(element)) return true;
    try {
      return "Python".equals(file.getLanguage().getID());
    } catch (Throwable t) {
      return false;
    }
  }

  private static boolean isJsPsi(PsiElement element, PsiFile file) {
    if (JavaScriptSupport.isJsElement(element)) return true;
    if (file != null && JavaScriptSupport.isJsFile(file.getName())) return true;
    try {
      return JavaScriptSupport.isJsLanguage(file.getLanguage().getID());
    } catch (Throwable t) {
      return false;
    }
  }

  private static PsiElement jsContext(PsiElement element) {
    for (PsiElement current = element.getParent();
        current != null && !(current instanceof PsiFile);
        current = current.getParent()) {
      int kind = JavaScriptSupport.symbolKind(current);
      if (kind == 1 || kind == 0) return current;
    }
    return null;
  }

  private static PsiElement pythonContext(PsiElement element) {
    for (PsiElement current = element.getParent();
        current != null && !(current instanceof PsiFile);
        current = current.getParent()) {
      int kind = ReadViewService.pythonSymbolKind(current);
      if (kind == 1 || kind == 0) return current;
    }
    return null;
  }

  private static boolean insideMainGuard(PsiElement element) {
    for (PsiElement current = element.getParent();
        current != null && !(current instanceof PsiFile);
        current = current.getParent()) {
      if (!current.getClass().getSimpleName().contains("PyIfStatement")) continue;
      String text = current.getText();
      if (text.contains("__name__") && text.contains("__main__")) return true;
    }
    return false;
  }

  // ---- 入口点（一层/两层可达） ----

  private static final class EntryPoint {
    final String file;
    final int line;
    final String context;

    EntryPoint(String file, int line, String context) {
      this.file = file;
      this.line = line;
      this.context = context;
    }

    JsonObject toJson() {
      JsonObject json = new JsonObject();
      json.addProperty("file", file);
      json.addProperty("line", line);
      json.addProperty("context", context);
      json.addProperty("reason", "reached_from_main");
      return json;
    }
  }

  private static List<EntryPoint> collectEntryPoints(
      Project project,
      List<Caller> callers,
      SearchScope searchScope,
      VirtualFile scopeFile,
      long deadlineNanos,
      Set<String> jsEntryFiles) {
    Map<String, EntryPoint> unique = new LinkedHashMap<>();

    // level1：caller 的 context 本身就是 main
    for (Caller caller : callers) {
      if ("main".equals(caller.context)) {
        unique.putIfAbsent(
            caller.file + "|" + caller.line, new EntryPoint(caller.file, caller.line, caller.context));
      }
    }
    for (Caller caller : callers) {
      if (!jsEntryFiles.contains(caller.file)) continue;
      unique.putIfAbsent(
          caller.file + "|" + caller.line, new EntryPoint(caller.file, caller.line, caller.context));
    }

    // level2：对每个非测试 context 方法搜索一次引用，使用点 context 为 main 即为入口
    Set<PsiElement> visited = new LinkedHashSet<>();
    for (Caller caller : callers) {
      if (caller.test || caller.contextElement == null) continue;
      // JS/TS 禁止 ReferencesSearch（TS 语言服务可能阻塞）；callers 已由名称扫描覆盖
      if (JavaScriptSupport.isJsElement(caller.contextElement)) continue;
      if (System.nanoTime() > deadlineNanos) break;
      if (!visited.add(caller.contextElement)) continue;
      List<PsiReference> references = new ArrayList<>();
      try {
        for (PsiReference reference : ReferencesSearch.search(caller.contextElement, searchScope).findAll()) {
          if (System.nanoTime() > deadlineNanos) break;
          references.add(reference);
        }
      } catch (Throwable t) {
        Log.warn("entry point search failed: " + t);
      }
      if (references.isEmpty() && ReadViewService.isPythonElement(caller.contextElement)) {
        references =
            scanPythonReferences(project, caller.contextElement, scopeFile, deadlineNanos, 200);
      }
      for (PsiReference reference : references) {
        Caller usage = describeReference(project, reference);
        if (usage == null || !"main".equals(usage.context)) continue;
        unique.putIfAbsent(
            usage.file + "|" + usage.line, new EntryPoint(usage.file, usage.line, usage.context));
      }
      if (references.isEmpty()
          && ReadViewService.isPythonElement(caller.contextElement)
          && caller.contextElement instanceof PsiNamedElement named
          && named.getName() != null) {
        for (PsiElement occurrence :
            scanPythonNameOccurrences(project, named.getName(), scopeFile, deadlineNanos, 200)) {
          Caller usage = describeElement(project, occurrence);
          if (usage == null || !"main".equals(usage.context)) continue;
          unique.putIfAbsent(
              usage.file + "|" + usage.line, new EntryPoint(usage.file, usage.line, usage.context));
        }
      }
    }

    List<EntryPoint> entries = new ArrayList<>(unique.values());
    entries.sort(
        Comparator.comparing((EntryPoint entry) -> entry.file)
            .thenComparingInt(entry -> entry.line));
    if (entries.size() > ENTRY_LIMIT) entries = new ArrayList<>(entries.subList(0, ENTRY_LIMIT));
    return entries;
  }

  // ---- callees（定义体内可解析到项目源码的引用目标） ----

  private static final class Callee {
    final String symbol;
    final String file;
    final int line;

    Callee(String symbol, String file, int line) {
      this.symbol = symbol;
      this.file = file;
      this.line = line;
    }

    JsonObject toJson() {
      JsonObject json = new JsonObject();
      json.addProperty("symbol", symbol);
      json.addProperty("file", file);
      json.addProperty("line", line);
      return json;
    }
  }

  private static List<Callee> collectCallees(Project project, PsiElement definition, long deadlineNanos) {
    if (JavaScriptSupport.isJsElement(definition)) {
      return collectJsCallees(project, definition, deadlineNanos);
    }
    if (ReadViewService.isPythonElement(definition)) {
      return collectPythonCallees(project, definition, deadlineNanos);
    }
    if (!(definition instanceof PsiMethod method)) return List.of();
    PsiCodeBlock body = method.getBody();
    if (body == null) return List.of();
    PsiClass definitionClass = PsiTreeUtil.getParentOfType(method, PsiClass.class, false);

    Map<String, Callee> unique = new LinkedHashMap<>();
    try {
      body.accept(
          new PsiRecursiveElementWalkingVisitor() {
            @Override
            public void visitElement(PsiElement element) {
              if (System.nanoTime() > deadlineNanos) {
                stopWalking();
                return;
              }
              addCallee(project, definitionClass, element, unique);
              super.visitElement(element);
            }
          });
    } catch (Throwable t) {
      Log.warn("callees collection failed: " + t);
    }

    List<Callee> callees = new ArrayList<>(unique.values());
    callees.sort(
        Comparator.comparing((Callee callee) -> callee.file)
            .thenComparingInt(callee -> callee.line)
            .thenComparing(callee -> callee.symbol));
    if (callees.size() > CALLEES_LIMIT) {
      callees = new ArrayList<>(callees.subList(0, CALLEES_LIMIT));
    }
    return callees;
  }

  private static void addCallee(
      Project project, PsiClass definitionClass, PsiElement element, Map<String, Callee> unique) {
    PsiReference reference = element.getReference();
    if (reference == null) return;
    PsiElement target;
    try {
      target = reference.resolve();
    } catch (Throwable t) {
      return;
    }
    if (target == null || target == element || !target.isValid()) return;
    if (!(target instanceof PsiMethod || target instanceof PsiField || target instanceof PsiClass)) return;
    if (target instanceof PsiCompiledElement) return; // JDK/库的 .class 不进入 callees
    PsiFile targetFile = target.getContainingFile();
    if (targetFile == null || targetFile.getVirtualFile() == null) return;
    if (!(target instanceof PsiNamedElement named)) return;
    String name = named.getName();
    if (name == null) return;

    String symbol;
    if (target instanceof PsiClass) {
      symbol = name;
    } else {
      PsiClass targetClass = PsiTreeUtil.getParentOfType(target, PsiClass.class, false);
      if (targetClass != null && definitionClass != null && !targetClass.equals(definitionClass)) {
        String prefix = targetClass.getName();
        symbol = prefix == null ? name : prefix + "." + name;
      } else {
        symbol = name;
      }
    }

    Integer line = lineOf(project, targetFile, target);
    if (line == null) return;
    String file = ReadViewService.displayPath(targetFile.getVirtualFile(), project);
    unique.putIfAbsent(symbol + "|" + file + "|" + line, new Callee(symbol, file, line));
  }

  // ---- callees（Python：定义体内 resolve 到项目内的声明） ----

  private static List<Callee> collectPythonCallees(
      Project project, PsiElement definition, long deadlineNanos) {
    PsiElement definitionOwnerClass = pythonEnclosingClass(definition);
    Map<String, Callee> unique = new LinkedHashMap<>();
    try {
      definition.accept(
          new PsiRecursiveElementWalkingVisitor() {
            @Override
            public void visitElement(PsiElement element) {
              if (System.nanoTime() > deadlineNanos) {
                stopWalking();
                return;
              }
              addPythonCallee(project, definition, definitionOwnerClass, element, unique);
              super.visitElement(element);
            }
          });
    } catch (Throwable t) {
      Log.warn("python callees collection failed: " + t);
    }

    List<Callee> callees = new ArrayList<>(unique.values());
    callees.sort(
        Comparator.comparing((Callee callee) -> callee.file)
            .thenComparingInt(callee -> callee.line)
            .thenComparing(callee -> callee.symbol));
    if (callees.size() > CALLEES_LIMIT) {
      callees = new ArrayList<>(callees.subList(0, CALLEES_LIMIT));
    }
    return callees;
  }

  private static void addPythonCallee(
      Project project,
      PsiElement definition,
      PsiElement definitionOwnerClass,
      PsiElement element,
      Map<String, Callee> unique) {
    PsiReference reference = element.getReference();
    if (reference == null) return;
    PsiElement target;
    try {
      target = reference.resolve();
    } catch (Throwable t) {
      return;
    }
    if (target == null || target == element || target == definition || !target.isValid()) return;
    int kind = ReadViewService.pythonSymbolKind(target);
    if (kind < 0) return;
    if (!(target instanceof PsiNamedElement named)) return;
    PsiFile targetFile = target.getContainingFile();
    if (targetFile == null || targetFile.getVirtualFile() == null) return;
    // typeshed/stdlib/第三方库目标对项目阅读无意义，只保留项目内声明
    if (!insideProject(project, targetFile)) return;
    String name = named.getName();
    if (name == null || name.isEmpty()) return;

    String symbol = name;
    if (kind != 0) {
      PsiElement targetOwnerClass = pythonEnclosingClass(target);
      if (targetOwnerClass != null
          && targetOwnerClass != definitionOwnerClass
          && targetOwnerClass instanceof PsiNamedElement ownerNamed) {
        String ownerName = ownerNamed.getName();
        if (ownerName != null && !ownerName.isEmpty()) symbol = ownerName + "." + name;
      }
    }

    Integer line = lineOf(project, targetFile, target);
    if (line == null) return;
    String file = ReadViewService.displayPath(targetFile.getVirtualFile(), project);
    unique.putIfAbsent(symbol + "|" + file + "|" + line, new Callee(symbol, file, line));
  }

  private static boolean insideProject(Project project, PsiFile file) {
    VirtualFile baseDir = ProjectUtil.guessProjectDir(project);
    if (baseDir == null) return true;
    String base = baseDir.getPath();
    String path = file.getVirtualFile().getPath();
    return path.equals(base) || path.startsWith(base + "/");
  }

  // ---- 工具 ----

  private static Integer lineOf(Project project, PsiFile file, PsiElement element) {
    TextRange range = element.getTextRange();
    if (range == null) return null;
    Document document = PsiDocumentManager.getInstance(project).getDocument(file);
    if (document == null) return null;
    int offset = Math.max(0, Math.min(range.getStartOffset(), document.getTextLength()));
    return document.getLineNumber(offset) + 1;
  }

  private static String safeName(PsiNamedElement element, PsiFile fallbackFile) {
    String name = element.getName();
    return name == null || name.isEmpty() ? fileStem(fallbackFile) : name;
  }

  private static String fileStem(PsiFile file) {
    String name = file.getName();
    int dot = name.lastIndexOf('.');
    return dot > 0 ? name.substring(0, dot) : name;
  }

  private static boolean isTestPath(String path) {
    String lower = path.toLowerCase(Locale.ROOT);
    return lower.contains("test") || lower.contains("spec") || lower.contains("__tests__");
  }

  private static String displayScope(String scope) {
    return scope == null ? "-" : scope;
  }

  private static String requireString(JsonObject params, String name) throws JsonRpcServer.RpcException {
    JsonElement element = params.get(name);
    if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
      throw new JsonRpcServer.RpcException(-32602, "invalid params: missing " + name, null);
    }
    return element.getAsString();
  }

  /** scope 非字符串时按冻结协议返回 -32603；缺失视为全项目。 */
  private static String readScope(JsonObject params) throws JsonRpcServer.RpcException {
    JsonElement element = params.get("scope");
    if (element == null) return null;
    if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
      throw new JsonRpcServer.RpcException(-32603, "internal error", null);
    }
    return element.getAsString();
  }
}
