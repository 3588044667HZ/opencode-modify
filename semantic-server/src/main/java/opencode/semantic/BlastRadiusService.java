package opencode.semantic;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.project.DumbService;
import com.intellij.openapi.project.IndexNotReadyException;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.TextRange;
import com.intellij.openapi.util.ThrowableComputable;
import com.intellij.openapi.vfs.VfsUtil;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.JavaPsiFacade;
import com.intellij.psi.PsiClass;
import com.intellij.psi.PsiCodeBlock;
import com.intellij.psi.PsiCompiledElement;
import com.intellij.psi.PsiDocumentManager;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiField;
import com.intellij.psi.PsiFile;
import com.intellij.psi.PsiMethod;
import com.intellij.psi.PsiModifier;
import com.intellij.psi.PsiNamedElement;
import com.intellij.psi.PsiParameter;
import com.intellij.psi.PsiRecursiveElementWalkingVisitor;
import com.intellij.psi.PsiReference;
import com.intellij.psi.search.GlobalSearchScope;
import com.intellij.psi.search.PsiShortNamesCache;
import com.intellij.psi.search.SearchScope;
import com.intellij.psi.search.searches.ReferencesSearch;
import com.intellij.psi.util.PsiModificationTracker;
import com.intellij.psi.util.PsiTreeUtil;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

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

    PsiElement definition = resolveDefinition(project, symbol);
    if (definition == null || !definition.isValid()) {
      throw new JsonRpcServer.RpcException(-32002, "symbol not found", null);
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

    List<Caller> callers = new ArrayList<>();
    Set<String> callerKeys = new LinkedHashSet<>();
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

    List<EntryPoint> entryPoints = collectEntryPoints(project, callers, searchScope, deadlineNanos);

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

  private static PsiElement resolveDefinition(Project project, String symbol) {
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

  private static String filePathOf(PsiElement element) {
    PsiFile file = element.getContainingFile();
    if (file == null || file.getVirtualFile() == null) return "";
    return file.getVirtualFile().getPath();
  }

  private static String kindOf(PsiElement definition) {
    if (definition instanceof PsiMethod) return "method";
    if (definition instanceof PsiClass) return "class";
    if (definition instanceof PsiField) return "field";
    if (definition instanceof PsiParameter) return "parameter";
    return "unknown";
  }

  // ---- 引用分类 ----

  private static final class Caller {
    final String file;
    final int line;
    final String context;
    final boolean test;
    final boolean publicApi;
    final PsiMethod contextMethod;

    Caller(String file, int line, String context, boolean test, boolean publicApi, PsiMethod contextMethod) {
      this.file = file;
      this.line = line;
      this.context = context;
      this.test = test;
      this.publicApi = publicApi;
      this.contextMethod = contextMethod;
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
    if (element == null || !element.isValid()) return null;
    PsiFile file = element.getContainingFile();
    if (file == null || file.getVirtualFile() == null) return null;
    Integer line = lineOf(project, file, element);
    if (line == null) return null;
    String path = ReadViewService.displayPath(file.getVirtualFile(), project);

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
      Project project, List<Caller> callers, SearchScope searchScope, long deadlineNanos) {
    Map<String, EntryPoint> unique = new LinkedHashMap<>();

    // level1：caller 的 context 本身就是 main
    for (Caller caller : callers) {
      if ("main".equals(caller.context)) {
        unique.putIfAbsent(
            caller.file + "|" + caller.line, new EntryPoint(caller.file, caller.line, caller.context));
      }
    }

    // level2：对每个非测试 context 方法搜索一次引用，使用点 context 为 main 即为入口
    Set<PsiMethod> visited = new LinkedHashSet<>();
    for (Caller caller : callers) {
      if (caller.test || caller.contextMethod == null) continue;
      if (System.nanoTime() > deadlineNanos) break;
      if (!visited.add(caller.contextMethod)) continue;
      try {
        for (PsiReference reference : ReferencesSearch.search(caller.contextMethod, searchScope).findAll()) {
          if (System.nanoTime() > deadlineNanos) break;
          Caller usage = describeReference(project, reference);
          if (usage == null || !"main".equals(usage.context)) continue;
          unique.putIfAbsent(
              usage.file + "|" + usage.line, new EntryPoint(usage.file, usage.line, usage.context));
        }
      } catch (Throwable t) {
        Log.warn("entry point search failed: " + t);
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
