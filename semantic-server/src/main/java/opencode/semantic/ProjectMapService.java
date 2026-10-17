package opencode.semantic;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.TextRange;
import com.intellij.openapi.util.ThrowableComputable;
import com.intellij.openapi.vfs.VFileProperty;
import com.intellij.openapi.vfs.VfsUtil;
import com.intellij.openapi.vfs.VfsUtilCore;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.psi.PsiAnnotation;
import com.intellij.psi.PsiArrayType;
import com.intellij.psi.PsiDocumentManager;
import com.intellij.psi.PsiElement;
import com.intellij.psi.PsiFile;
import com.intellij.psi.PsiImportList;
import com.intellij.psi.PsiImportStatement;
import com.intellij.psi.PsiImportStatementBase;
import com.intellij.psi.PsiImportStaticStatement;
import com.intellij.psi.PsiJavaFile;
import com.intellij.psi.PsiManager;
import com.intellij.psi.PsiMethod;
import com.intellij.psi.PsiModifier;
import com.intellij.psi.PsiNamedElement;
import com.intellij.psi.PsiParameter;
import com.intellij.psi.PsiRecursiveElementWalkingVisitor;
import com.intellij.psi.PsiType;
import com.intellij.psi.PsiTypes;
import com.intellij.psi.util.PsiTreeUtil;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.regex.Pattern;

/**
 * project_map：项目级只读地图（structure / dependencies / hot）。
 *
 * 项目级缓存 + ReentrantReadWriteLock：首次查询启动后台构建线程并立即返回
 * {building:true, progress:0}（数组为空、project 计数为 0），构建中后续查询返回进度，
 * 完成后返回不带 building 的缓存结果。失效规则：
 * - VFS 文件新增/删除/移动（等价于任一已扫描目录的目录项集合变化）→ 全量失效；
 * - 文件内容修改 → 仅 dependencies 失效（structure/hot 保留缓存）；
 * - 模型文件（*.iml 或 .idea/ 下 *.xml）内容修改 → 视同结构变化，全量失效（引擎依赖项目模型）。
 * 无头沙箱禁用了原生文件监听（Native file watcher is disabled），因此每次 ready 查询用
 * 磁盘指纹（目录项集合 + 文件 mtime）做被动失效检测，命中时同步刷新变更文件再重建依赖。
 * scope（module:<name或path>）不缓存；无前缀/未知前缀忽略。
 */
final class ProjectMapService {
  private static final int MODULE_LIMIT = 20;
  private static final int MODULE_FILES_LIMIT = 200;

  /** 路由注解 simple name（忽略大小写）：JAX-RS @GET/@POST/... 与 @Path、Spring @RequestMapping。 */
  private static final Set<String> ROUTE_ANNOTATIONS =
      Set.of("get", "post", "put", "delete", "patch", "requestmapping", "path");

  /** Python 路由装饰器（FastAPI/Flask/aiohttp 风格）：`@app.get(...)` / `@router.route(...)`。 */
  private static final Pattern PY_ROUTE_DECORATOR =
      Pattern.compile("\\.\\s*(get|post|put|delete|patch|route|websocket|api_route|add_api_route)\\s*\\(");

  /** JS/TS 路由调用（Express/Koa/Fastify 风格）与 NestJS 装饰器。 */
  private static final Pattern JS_ROUTE_CALL =
      Pattern.compile(
          "(?:^|[^\\w$])(?:app|router|server|fastify)\\.\\s*(get|post|put|delete|patch|route|all|use)\\s*\\(\\s*[\"'`]");
  private static final Pattern JS_ROUTE_DECORATOR =
      Pattern.compile("^@\\s*(Get|Post|Put|Delete|Patch)\\s*\\(");
  /** 路由调用的具名 handler 参数：`app.get("/x", handler)`。 */
  private static final Pattern JS_ROUTE_HANDLER =
      Pattern.compile(",\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*[,)]");
  private static final List<String> JS_EXTENSIONS =
      List.of(".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs");
  private static final int JS_CONFIG_SCAN_DEPTH = 8;
  private static final Pattern JS_IMPORT_FROM =
      Pattern.compile("\\bfrom\\s*[\"']([^\"']+)[\"']");
  private static final Pattern JS_IMPORT_SIDE_EFFECT =
      Pattern.compile("^\\s*import\\s*[\"']([^\"']+)[\"']");
  private static final Pattern JS_REQUIRE =
      Pattern.compile("\\brequire\\s*\\(\\s*[\"']([^\"']+)[\"']\\s*\\)");
  private static final Pattern JS_DYNAMIC_IMPORT =
      Pattern.compile("\\bimport\\s*\\(\\s*[\"']([^\"']+)[\"']\\s*\\)");

  private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
  private final Set<String> pendingContentFiles = new HashSet<>();

  private String cachedRoot;
  private Snapshot ready;
  private JsonObject structureView;
  private JsonObject depsView;
  private JsonObject hotView;
  private boolean depsDirty;
  private boolean building;
  private volatile double progress;

  JsonObject projectMap(Project project, String basePath, JsonObject params)
      throws JsonRpcServer.RpcException {
    String view = readView(params);
    String scope = readScope(params);
    String root = Paths.get(basePath).toAbsolutePath().normalize().toString();

    lock.writeLock().lock();
    try {
      if (cachedRoot == null || !cachedRoot.equals(root)) resetFor(root);
      if (!building) revalidate(root);

      if (ready == null) {
        if (!building) startFullBuild(project, root);
        return buildingResult(view, root);
      }

      if ("dependencies".equals(view)) {
        if (depsView == null || depsDirty) {
          if (!building) startDepsBuild(project, root);
          return buildingResult(view, root);
        }
        Log.info("project_map cache hit view=dependencies" + scopeLog(scope));
        return depsForScope(scope);
      }

      if ("hot".equals(view)) {
        Log.info("project_map cache hit view=hot" + scopeLog(scope));
        return hotView;
      }

      Log.info("project_map cache hit view=structure" + scopeLog(scope));
      return structureForScope(scope);
    } finally {
      lock.writeLock().unlock();
    }
  }

  // ---- 参数与错误 ----

  private static String readView(JsonObject params) throws JsonRpcServer.RpcException {
    JsonElement element = params.get("view");
    if (element == null) return "structure";
    if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) throw invalidView();
    String view = element.getAsString();
    if (!"structure".equals(view) && !"dependencies".equals(view) && !"hot".equals(view)) {
      throw invalidView();
    }
    return view;
  }

  private static JsonRpcServer.RpcException invalidView() {
    return new JsonRpcServer.RpcException(-32603, "invalid params: view", null);
  }

  /** scope 必须是字符串（类型错 -32603）；缺失视为无 scope；只识别 module: 前缀。 */
  private static String readScope(JsonObject params) throws JsonRpcServer.RpcException {
    JsonElement element = params.get("scope");
    if (element == null) return null;
    if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
      throw new JsonRpcServer.RpcException(-32603, "invalid params: scope", null);
    }
    String scope = element.getAsString();
    return scope.startsWith("module:") ? scope.substring("module:".length()) : null;
  }

  private static String scopeLog(String scope) {
    return " scope=" + (scope == null ? "-" : scope);
  }

  // ---- 缓存状态 ----

  private void resetFor(String root) {
    cachedRoot = root;
    ready = null;
    structureView = null;
    depsView = null;
    hotView = null;
    depsDirty = false;
    building = false;
    progress = 0;
    pendingContentFiles.clear();
  }

  private void invalidateAll() {
    ready = null;
    structureView = null;
    depsView = null;
    hotView = null;
    depsDirty = false;
    pendingContentFiles.clear();
  }

  private void startFullBuild(Project project, String root) {
    invalidateAll();
    building = true;
    progress = 0;
    Log.info("project_map cache miss (full build); building...");
    Thread thread = new Thread(() -> fullBuild(project, root), "semantic-project-map-build");
    thread.setDaemon(true);
    thread.start();
  }

  private void startDepsBuild(Project project, String root) {
    building = true;
    progress = 0;
    Log.info("project_map cache miss (dependencies rebuild); building...");
    Snapshot base = ready;
    List<String> changed = new ArrayList<>(pendingContentFiles);
    Thread thread =
        new Thread(() -> depsBuild(project, root, base, changed), "semantic-project-map-deps");
    thread.setDaemon(true);
    thread.start();
  }

  private void fullBuild(Project project, String root) {
    long started = System.nanoTime();
    try {
      refreshTree(root);
      progress = 0.1;
      // 全量扫描与依赖计算都在 ReadAction 内（PSI/VFS 只读）
      Snapshot snapshot =
          ReadAction.computeBlocking(
              (ThrowableComputable<Snapshot, RuntimeException>) () -> scan(project, root));
      progress = 0.9;
      JsonObject structure = structureJson(snapshot, root);
      JsonObject dependencies = dependenciesJson(snapshot, root);
      JsonObject hot = hotJson(snapshot, root);

      lock.writeLock().lock();
      try {
        ready = snapshot;
        structureView = structure;
        depsView = dependencies;
        hotView = hot;
        depsDirty = false;
        pendingContentFiles.clear();
        building = false;
        progress = 1;
      } finally {
        lock.writeLock().unlock();
      }
      Log.info(
          "project_map build done in " + millis(started) + "ms modules=" + snapshot.index.modules.size()
              + " files=" + snapshot.index.totalFiles + " deps=" + snapshot.dependencies.size()
              + " cycles=" + snapshot.cycles.size());
    } catch (Throwable t) {
      Log.error("project_map build failed", t);
      lock.writeLock().lock();
      try {
        building = false;
        progress = 0;
      } finally {
        lock.writeLock().unlock();
      }
    }
  }

  private void depsBuild(Project project, String root, Snapshot base, List<String> changed) {
    long started = System.nanoTime();
    try {
      refreshFiles(root, changed);
      progress = 0.2;
      DepsResult result =
          ReadAction.computeBlocking(
              (ThrowableComputable<DepsResult, RuntimeException>)
                  () -> computeDeps(project, root, base.index));
      Snapshot updated = base.withDependencies(result.dependencies, result.cycles);
      JsonObject dependencies = dependenciesJson(updated, root);

      lock.writeLock().lock();
      try {
        ready = updated;
        depsView = dependencies;
        depsDirty = false;
        pendingContentFiles.clear();
        building = false;
        progress = 1;
      } finally {
        lock.writeLock().unlock();
      }
      Log.info(
          "project_map dependencies rebuild done in " + millis(started) + "ms deps="
              + result.dependencies.size() + " cycles=" + result.cycles.size());
    } catch (Throwable t) {
      Log.error("project_map dependencies rebuild failed", t);
      lock.writeLock().lock();
      try {
        building = false;
        progress = 0;
      } finally {
        lock.writeLock().unlock();
      }
    }
  }

  // ---- 失效检测（无原生监听：目录项集合 + 文件 mtime 指纹） ----

  private void revalidate(String root) {
    Snapshot snapshot = ready;
    if (snapshot == null) return;
    Fingerprint fingerprint = snapshot.fingerprint;

    for (Map.Entry<String, List<String>> entry : fingerprint.dirEntries.entrySet()) {
      List<String> now = relevantEntries(Paths.get(root, entry.getKey()), entry.getKey());
      if (now == null || !now.equals(entry.getValue())) {
        Log.info(
            "project_map invalidated (structure changed at "
                + (entry.getKey().isEmpty() ? "." : entry.getKey()) + ")");
        invalidateAll();
        return;
      }
    }

    List<String> changed = new ArrayList<>();
    for (Map.Entry<String, Long> entry : fingerprint.fileMtimes.entrySet()) {
      long now = mtime(Paths.get(root, entry.getKey()));
      if (now != entry.getValue()) {
        changed.add(entry.getKey());
        fingerprint.fileMtimes.put(entry.getKey(), now);
      }
    }
    if (changed.isEmpty()) return;
    List<String> models = changed.stream().filter(ProjectMapService::isModelFile).toList();
    if (!models.isEmpty()) {
      // 引擎依赖 .idea/*.iml 项目模型：模型内容变化视同结构变化
      Log.info("project_map invalidated (model changed: " + String.join(", ", models) + ")");
      invalidateAll();
      return;
    }
    depsDirty = true;
    pendingContentFiles.addAll(changed);
    Log.info("project_map dependencies dirty (content changed: " + changed.size() + " files)");
  }

  /** 项目模型文件：任意 *.iml，或 .idea/ 目录下的 *.xml（内容变化视同结构变化）。 */
  private static boolean isModelFile(String relativePath) {
    String name = lastSegment(relativePath);
    if (name.endsWith(".iml")) return true;
    return name.endsWith(".xml")
        && (relativePath.startsWith(".idea/") || relativePath.contains("/.idea/"));
  }

  /** 目录的“相关目录项”集合：非隐藏、非排除目录的项（与扫描时的记录口径一致）。 */
  private static List<String> relevantEntries(Path dir, String relative) {
    List<String> entries = new ArrayList<>();
    try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
      for (Path entry : stream) {
        String name = entry.getFileName().toString();
        if (name.startsWith(".")) continue;
        if (Files.isSymbolicLink(entry) && Files.isDirectory(entry)) continue;
        String childRelative = relative.isEmpty() ? name : relative + "/" + name;
        if (Files.isDirectory(entry) && Exclusions.excludesDir(childRelative, name)) continue;
        entries.add(name);
      }
    } catch (IOException e) {
      return null;
    }
    entries.sort(Comparator.naturalOrder());
    return entries;
  }

  private static long mtime(Path path) {
    try {
      return Files.getLastModifiedTime(path).toMillis();
    } catch (IOException e) {
      return -1L;
    }
  }

  private static void refreshTree(String root) {
    VirtualFile rootDir = VfsUtil.findFileByIoFile(Paths.get(root).toFile(), true);
    if (rootDir != null) rootDir.refresh(false, true);
  }

  private static void refreshFiles(String root, List<String> relativePaths) {
    for (String relative : relativePaths) {
      VirtualFile file = VfsUtil.findFileByIoFile(Paths.get(root, relative).toFile(), true);
      if (file != null) file.refresh(false, false);
    }
  }

  // ---- 扫描（structure + entry + dependencies 一次完成） ----

  private static Snapshot scan(Project project, String root) {
    Path rootPath = Paths.get(root);
    VirtualFile rootDir = VfsUtil.findFileByIoFile(rootPath.toFile(), true);
    if (rootDir == null) throw new IllegalStateException("project root not found: " + root);

    ScanState state = new ScanState();
    walk(rootPath, rootDir, "", true, state);
    state.modules.sort(Comparator.comparing(module -> module.path));
    state.rootFiles.sort(Comparator.naturalOrder());

    Index index = buildIndex(project, state);
    DepsResult deps = computeDeps(project, root, index);
    return new Snapshot(index, state.fingerprint, deps.dependencies, deps.cycles);
  }

  private static final class ScanState {
    final List<ModuleInfo> modules = new ArrayList<>();
    final List<String> rootFiles = new ArrayList<>();
    final List<FileRef> javaFiles = new ArrayList<>();
    final List<FileRef> pythonFiles = new ArrayList<>();
    final List<FileRef> jsFiles = new ArrayList<>();
    final List<FileRef> jsonManifests = new ArrayList<>();
    final Map<String, FileRef> jsFileIndex = new HashMap<>();
    final Fingerprint fingerprint = new Fingerprint();
  }

  private static final class FileEntry {
    final String name;
    final VirtualFile file;

    FileEntry(String name, VirtualFile file) {
      this.name = name;
      this.file = file;
    }
  }

  private static final class FileRef {
    final VirtualFile file;
    final String path; // 项目相对，'/' 分隔
    final String modulePath; // 模块文件：模块 path；根文件：null

    FileRef(VirtualFile file, String path, String modulePath) {
      this.file = file;
      this.path = path;
      this.modulePath = modulePath;
    }
  }

  /** 目录约定模块划分：直接含文件的非根目录即模块（文件=直接子文件，不递归）。 */
  private static void walk(
      Path rootPath, VirtualFile dir, String relative, boolean isRoot, ScanState state) {
    List<String> entries = new ArrayList<>();
    List<FileEntry> files = new ArrayList<>();
    List<VirtualFile> subdirs = new ArrayList<>();
    for (VirtualFile child : dir.getChildren()) {
      String name = child.getName();
      if (name.startsWith(".")) {
        // 隐藏目录不参与模块划分，但 .idea 下的 *.xml 是项目模型：只记录 mtime 供失效检测
        if (isRoot && ".idea".equals(name) && child.isDirectory()) {
          for (VirtualFile modelFile : child.getChildren()) {
            if (modelFile.isDirectory() || !modelFile.getName().endsWith(".xml")) continue;
            String modelPath = ".idea/" + modelFile.getName();
            state.fingerprint.fileMtimes.put(modelPath, mtime(rootPath.resolve(modelPath)));
          }
        }
        continue;
      }
      if (child.isDirectory()) {
        String childRelative = relative.isEmpty() ? name : relative + "/" + name;
        if (child.is(VFileProperty.SYMLINK) || Exclusions.excludesDir(childRelative, name)) continue;
        entries.add(name);
        subdirs.add(child);
      } else {
        entries.add(name);
        files.add(new FileEntry(name, child));
      }
    }
    entries.sort(Comparator.naturalOrder());
    files.sort(Comparator.comparing(entry -> entry.name));
    state.fingerprint.dirs.add(relative);
    state.fingerprint.dirEntries.put(relative, entries);

    if (isRoot) {
      for (FileEntry file : files) {
        state.rootFiles.add(file.name);
        state.fingerprint.fileMtimes.put(file.name, mtime(rootPath.resolve(file.name)));
        if (file.name.endsWith(".java")) state.javaFiles.add(new FileRef(file.file, file.name, null));
        if (file.name.endsWith(".py")) state.pythonFiles.add(new FileRef(file.file, file.name, null));
        if (JavaScriptSupport.isJsFile(file.name)) {
          FileRef ref = new FileRef(file.file, file.name, null);
          state.jsFiles.add(ref);
          state.jsFileIndex.put(file.name, ref);
        }
        if ("package.json".equals(file.name)) {
          state.jsonManifests.add(new FileRef(file.file, file.name, null));
        }
      }
    } else if (!files.isEmpty()) {
      ModuleInfo module = new ModuleInfo(lastSegment(relative), relative);
      for (FileEntry file : files) {
        String path = relative + "/" + file.name;
        module.fileNames.add(file.name);
        module.filePaths.add(path);
        state.fingerprint.fileMtimes.put(path, mtime(rootPath.resolve(path)));
        if (file.name.endsWith(".java")) state.javaFiles.add(new FileRef(file.file, path, relative));
        if (file.name.endsWith(".py")) state.pythonFiles.add(new FileRef(file.file, path, relative));
        if (JavaScriptSupport.isJsFile(file.name)) {
          FileRef ref = new FileRef(file.file, path, relative);
          state.jsFiles.add(ref);
          state.jsFileIndex.put(path, ref);
        }
        if ("package.json".equals(file.name)) {
          state.jsonManifests.add(new FileRef(file.file, path, relative));
        }
      }
      state.modules.add(module);
    }

    for (VirtualFile subdir : subdirs) {
      String childRelative = relative.isEmpty() ? subdir.getName() : relative + "/" + subdir.getName();
      walk(rootPath, subdir, childRelative, false, state);
    }
  }

  private static String lastSegment(String path) {
    int slash = path.lastIndexOf('/');
    return slash < 0 ? path : path.substring(slash + 1);
  }

  private static Index buildIndex(Project project, ScanState state) {
    PsiManager psiManager = PsiManager.getInstance(project);
    Map<String, EntryPoint> entries = new HashMap<>();
    if (JavaSupport.available()) {
      for (FileRef ref : state.javaFiles) {
        try {
          PsiFile psiFile = psiManager.findFile(ref.file);
          if (!(psiFile instanceof PsiJavaFile javaFile)) continue;
          collectEntries(project, javaFile, ref.path, entries);
        } catch (Throwable t) {
          // Java 索引可能在本轮构建期间再次进入 dumb：跳过该文件，不拖垮整张地图
          Log.info("project_map java entry scan skipped (" + ref.path + "): " + t);
        }
      }
    }
    if (PythonSupport.available()) {
      for (FileRef ref : state.pythonFiles) {
        try {
          PsiFile psiFile = psiManager.findFile(ref.file);
          if (psiFile == null) continue;
          collectPythonEntries(project, psiFile, ref.path, entries);
        } catch (Throwable t) {
          // 安装不完整/语言服务异常：该文件不贡献入口，不影响 Java 路径与其他文件
          Log.warn("project_map python entry scan failed (" + ref.path + "): " + t);
        }
      }
    }
    if (JavaScriptSupport.available()) {
      for (FileRef manifest : state.jsonManifests) {
        try {
          collectPackageEntries(manifest, state.jsFileIndex, entries);
        } catch (Throwable t) {
          Log.warn("project_map package.json scan failed (" + manifest.path + "): " + t);
        }
      }
      for (FileRef ref : state.jsFiles) {
        try {
          PsiFile psiFile = psiManager.findFile(ref.file);
          if (psiFile == null) continue;
          collectJsEntries(project, psiFile, ref.path, entries);
        } catch (Throwable t) {
          Log.warn("project_map js entry scan failed (" + ref.path + "): " + t);
        }
      }
    }
    List<EntryPoint> entryPoints = new ArrayList<>(entries.values());
    entryPoints.sort(
        Comparator.comparing((EntryPoint entry) -> entry.file)
            .thenComparingInt(entry -> entry.line)
            .thenComparing(entry -> entry.symbol)
            .thenComparing(entry -> entry.kind));

    Set<String> entryModules = new HashSet<>();
    for (EntryPoint entry : entryPoints) {
      String modulePath = parentDirectory(entry.file);
      if (modulePath != null) entryModules.add(modulePath);
    }

    int totalFiles = state.rootFiles.size();
    for (ModuleInfo module : state.modules) totalFiles += module.fileNames.size();
    return new Index(state.modules, state.rootFiles, entryPoints, entryModules, totalFiles);
  }

  private static String parentDirectory(String path) {
    int slash = path.lastIndexOf('/');
    return slash < 0 ? null : path.substring(0, slash);
  }

  // ---- 入口点（main / 路由注解） ----

  private static void collectEntries(
      Project project, PsiJavaFile javaFile, String path, Map<String, EntryPoint> entries) {
    for (PsiMethod method : PsiTreeUtil.findChildrenOfType(javaFile, PsiMethod.class)) {
      Integer line = methodLine(project, javaFile, method);
      if (line == null) continue;
      String name = method.getName();
      if (isMain(method)) putEntry(entries, path, line, name, "main");
      if (hasRouteAnnotation(method)) putEntry(entries, path, line, name, "route");
    }
  }

  /** Python 入口：模块级 main / __main__ 守卫内调用的模块级函数 / 路由装饰器函数。 */
  private static void collectPythonEntries(
      Project project, PsiFile psiFile, String path, Map<String, EntryPoint> entries) {
    List<PythonFunction> functions = new ArrayList<>();
    String[] guardText = new String[1];
    psiFile.accept(
        new PsiRecursiveElementWalkingVisitor() {
          @Override
          public void visitElement(PsiElement element) {
            String simple = element.getClass().getSimpleName();
            if (guardText[0] == null && simple.contains("PyIfStatement") && isMainGuard(element)) {
              guardText[0] = element.getText();
            }
            if (ReadViewService.pythonSymbolKind(element) == 1 && element instanceof PsiNamedElement named) {
              String name = named.getName();
              if (name != null) {
                functions.add(
                    new PythonFunction(
                        element, name, isTopLevelPython(psiFile, element), decoratorText(element)));
              }
            }
            super.visitElement(element);
          }
        });

    for (PythonFunction function : functions) {
      Integer line = elementLine(project, psiFile, function.element);
      if (line == null) continue;
      if (function.topLevel
          && ("main".equals(function.name)
              || (guardText[0] != null && callsName(guardText[0], function.name)))) {
        putEntry(entries, path, line, function.name, "main");
      }
      if (function.decorators != null
          && PY_ROUTE_DECORATOR.matcher(function.decorators).find()) {
        putEntry(entries, path, line, function.name, "route");
      }
    }
  }

  private static final class PythonFunction {
    final PsiElement element;
    final String name;
    final boolean topLevel;
    final String decorators;

    PythonFunction(
        PsiElement element, String name, boolean topLevel, String decorators) {
      this.element = element;
      this.name = name;
      this.topLevel = topLevel;
      this.decorators = decorators;
    }
  }

  /** 顶层判定：定义与文件之间没有类/函数声明（嵌套函数与类方法不算模块入口）。 */
  private static boolean isTopLevelPython(PsiFile file, PsiElement element) {
    PsiElement parent = element.getParent();
    while (parent != null && parent != file) {
      if (ReadViewService.pythonSymbolKind(parent) >= 0) return false;
      parent = parent.getParent();
    }
    return parent == file;
  }

  /** 装饰器文本：先取函数子节点，再回看前置兄弟（不同平台版本挂载位置不同）。 */
  private static String decoratorText(PsiElement element) {
    StringBuilder text = new StringBuilder();
    for (PsiElement child : element.getChildren()) {
      if (child.getClass().getSimpleName().contains("PyDecorator")) {
        text.append(child.getText()).append('\n');
      }
    }
    PsiElement sibling = element.getPrevSibling();
    while (sibling != null && text.length() == 0) {
      String simple = sibling.getClass().getSimpleName();
      if (simple.contains("PyDecorator")) {
        text.insert(0, sibling.getText() + "\n");
        break;
      }
      if (!sibling.getText().isBlank()) break;
      sibling = sibling.getPrevSibling();
    }
    return text.length() == 0 ? null : text.toString();
  }

  private static boolean isMainGuard(PsiElement element) {
    String text = element.getText();
    return text.contains("__name__") && text.contains("__main__");
  }

  /** 守卫块内是否调用了该函数（允许空白）；转义名称避免正则元字符。 */
  private static boolean callsName(String guardText, String name) {
    return Pattern.compile("\\b" + Pattern.quote(name) + "\\s*\\(").matcher(guardText).find();
  }

  // ---- JS/TS 入口（package.json main/bin、路由调用/装饰器、顶层 main） ----

  private static void collectPackageEntries(
      FileRef manifest,
      Map<String, FileRef> jsFileIndex,
      Map<String, EntryPoint> entries) {
    String text;
    try {
      text = VfsUtilCore.loadText(manifest.file);
    } catch (IOException e) {
      Log.warn("package.json read failed (" + manifest.path + "): " + e);
      return;
    }
    JsonObject packageJson = JsonParser.parseString(text).getAsJsonObject();
    String packageName =
        packageJson.has("name") && packageJson.get("name").isJsonPrimitive()
            ? packageJson.get("name").getAsString()
            : null;
    JsonElement main = packageJson.get("main");
    if (main != null && main.isJsonPrimitive() && main.getAsJsonPrimitive().isString()) {
      putManifestEntry(
          entries,
          jsFileIndex,
          manifest.path,
          main.getAsString(),
          packageName == null ? "main" : packageName,
          "main");
    }
    JsonElement bin = packageJson.get("bin");
    if (bin == null) return;
    if (bin.isJsonPrimitive() && bin.getAsJsonPrimitive().isString()) {
      putManifestEntry(
          entries, jsFileIndex, manifest.path, bin.getAsString(), packageName == null ? "bin" : packageName, "bin");
      return;
    }
    if (!bin.isJsonObject()) return;
    for (Map.Entry<String, JsonElement> item : bin.getAsJsonObject().entrySet()) {
      if (!item.getValue().isJsonPrimitive() || !item.getValue().getAsJsonPrimitive().isString()) {
        continue;
      }
      putManifestEntry(
          entries, jsFileIndex, manifest.path, item.getValue().getAsString(), item.getKey(), "bin");
    }
  }

  private static void putManifestEntry(
      Map<String, EntryPoint> entries,
      Map<String, FileRef> jsFileIndex,
      String manifestPath,
      String specifier,
      String symbol,
      String kind) {
    // package.json 的 main/bin 通常写 "src/index.js"（无 ./ 前缀）：按清单目录相对路径处理
    String value =
        specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")
            ? specifier
            : "./" + specifier;
    FileRef target = resolveJsFile(jsFileIndex, manifestPath, value);
    if (target == null) return;
    putEntry(entries, target.path, 1, symbol, kind);
  }

  private static void collectJsEntries(
      Project project, PsiFile psiFile, String path, Map<String, EntryPoint> entries) {
    psiFile.accept(
        new PsiRecursiveElementWalkingVisitor() {
          @Override
          public void visitElement(PsiElement element) {
            String simple = element.getClass().getSimpleName();
            if (simple.contains("CallExpression")) {
              String text = element.getText();
              if (text != null && JS_ROUTE_CALL.matcher(text).find()) {
                addRouteEntry(project, psiFile, path, element, text, entries);
              }
            } else if (simple.contains("Decorator")) {
              String text = element.getText() == null ? "" : element.getText().trim();
              if (JS_ROUTE_DECORATOR.matcher(text).find()) {
                Integer line = elementLine(project, psiFile, element);
                if (line != null) {
                  putEntry(entries, path, line, jsContextName(element, psiFile), "route");
                }
              }
            }
            if (JavaScriptSupport.symbolKind(element) == 1
                && element instanceof PsiNamedElement named
                && "main".equals(named.getName())
                && isTopLevelJs(psiFile, element)) {
              Integer line = elementLine(project, psiFile, element);
              if (line != null) putEntry(entries, path, line, named.getName(), "main");
            }
            super.visitElement(element);
          }
        });
  }

  private static void addRouteEntry(
      Project project,
      PsiFile psiFile,
      String path,
      PsiElement element,
      String text,
      Map<String, EntryPoint> entries) {
    Integer line = elementLine(project, psiFile, element);
    if (line == null) return;
    PsiElement context = jsContext(element);
    String symbol =
        context instanceof PsiNamedElement named && named.getName() != null
            ? named.getName()
            : routeHandlerSymbol(text);
    putEntry(entries, path, line, symbol, "route");
  }

  private static String routeHandlerSymbol(String callText) {
    java.util.regex.Matcher matcher = JS_ROUTE_HANDLER.matcher(callText);
    return matcher.find() ? matcher.group(1) : routeSymbol(callText);
  }

  private static String routeSymbol(String callText) {
    java.util.regex.Matcher matcher = JS_ROUTE_CALL.matcher(callText);
    if (!matcher.find()) return "route";
    return matcher.group().replaceAll("[^\\w.$]", "");
  }

  private static String jsContextName(PsiElement element, PsiFile file) {
    PsiElement context = jsContext(element);
    if (context instanceof PsiNamedElement named && named.getName() != null) return named.getName();
    return fileStemName(file);
  }

  private static PsiElement jsContext(PsiElement element) {
    for (PsiElement current = element.getParent();
        current != null && !(current instanceof PsiFile);
        current = current.getParent()) {
      if (JavaScriptSupport.symbolKind(current) == 1) return current;
    }
    return null;
  }

  private static String fileStemName(PsiFile file) {
    String name = file.getName();
    int dot = name.lastIndexOf('.');
    return dot > 0 ? name.substring(0, dot) : name;
  }

  private static boolean isTopLevelJs(PsiFile file, PsiElement element) {
    for (PsiElement current = element.getParent();
        current != null && current != file;
        current = current.getParent()) {
      if (JavaScriptSupport.symbolKind(current) >= 0) return false;
    }
    return true;
  }

  private static FileRef resolveJsFile(
      Map<String, FileRef> jsFileIndex, String sourcePath, String specifier) {
    String cleaned = specifier.trim();
    int query = cleaned.indexOf('?');
    if (query >= 0) cleaned = cleaned.substring(0, query);
    int hash = cleaned.indexOf('#');
    if (hash >= 0) cleaned = cleaned.substring(0, hash);
    if (cleaned.isEmpty()) return null;
    String relative;
    if (cleaned.startsWith("./") || cleaned.startsWith("../")) {
      String dir = parentDirectory(sourcePath);
      relative = normalizeRelative((dir == null ? "" : dir + "/") + cleaned);
    } else if (cleaned.startsWith("/")) {
      relative = normalizeRelative(cleaned.substring(1));
    } else {
      return null; // 裸包名/别名由 tsconfig 解析器处理（依赖），入口只接受项目路径
    }
    if (relative == null) return null;
    FileRef direct = jsFileIndex.get(relative);
    if (direct != null) return direct;
    for (String extension : JS_EXTENSIONS) {
      FileRef candidate = jsFileIndex.get(relative + extension);
      if (candidate != null) return candidate;
    }
    for (String extension : JS_EXTENSIONS) {
      FileRef candidate = jsFileIndex.get(relative + "/index" + extension);
      if (candidate != null) return candidate;
    }
    return null;
  }

  private static String normalizeRelative(String value) {
    String[] parts = value.replace('\\', '/').split("/");
    Deque<String> stack = new ArrayDeque<>();
    for (String part : parts) {
      if (part.isEmpty() || ".".equals(part)) continue;
      if ("..".equals(part)) {
        if (stack.isEmpty()) return null;
        stack.removeLast();
      } else {
        stack.addLast(part);
      }
    }
    return String.join("/", stack);
  }

  private static void putEntry(
      Map<String, EntryPoint> entries, String file, int line, String symbol, String kind) {
    String key = file + "|" + line + "|" + symbol + "|" + kind;
    entries.putIfAbsent(key, new EntryPoint(file, line, symbol, kind));
  }

  private static boolean isMain(PsiMethod method) {
    if (!"main".equals(method.getName())) return false;
    if (!method.hasModifierProperty(PsiModifier.PUBLIC)
        || !method.hasModifierProperty(PsiModifier.STATIC)) {
      return false;
    }
    if (!PsiTypes.voidType().equals(method.getReturnType())) return false;
    PsiParameter[] parameters = method.getParameterList().getParameters();
    if (parameters.length != 1) return false;
    PsiType type = parameters[0].getType();
    if (!(type instanceof PsiArrayType array)) return false;
    // 只按书写文本判断，避免 canonical text 触发索引 resolve（构建期可能与 dumb 模式竞态）
    String component = array.getComponentType().getPresentableText();
    return "String".equals(component) || "java.lang.String".equals(component);
  }

  private static boolean hasRouteAnnotation(PsiMethod method) {
    for (PsiAnnotation annotation : method.getAnnotations()) {
      String qualified = annotation.getQualifiedName();
      if (qualified == null) continue;
      int dot = qualified.lastIndexOf('.');
      String simple = (dot < 0 ? qualified : qualified.substring(dot + 1)).toLowerCase(Locale.ROOT);
      if (ROUTE_ANNOTATIONS.contains(simple)) return true;
    }
    return false;
  }

  private static Integer methodLine(Project project, PsiFile file, PsiMethod method) {
    return elementLine(project, file, method);
  }

  private static Integer elementLine(
      Project project, PsiFile file, PsiElement element) {
    TextRange range = element.getTextRange();
    if (range == null) return null;
    Document document = PsiDocumentManager.getInstance(project).getDocument(file);
    if (document != null) {
      int offset = Math.max(0, Math.min(range.getStartOffset(), document.getTextLength()));
      return document.getLineNumber(offset) + 1;
    }
    String text = file.getText();
    int offset = Math.max(0, Math.min(range.getStartOffset(), text.length()));
    int line = 1;
    for (int i = 0; i < offset; i++) {
      if (text.charAt(i) == '\n') line++;
    }
    return line;
  }

  // ---- 依赖（PsiImportStatement 归并到模块级 + Tarjan SCC） ----

  private static final class DepsResult {
    final List<Dependency> dependencies;
    final List<List<String>> cycles;

    DepsResult(List<Dependency> dependencies, List<List<String>> cycles) {
      this.dependencies = dependencies;
      this.cycles = cycles;
    }
  }

  private static DepsResult computeDeps(Project project, String root, Index index) {
    Map<String, Map<String, Integer>> counts = new TreeMap<>();
    if (JavaSupport.available()) collectJavaDeps(project, root, index, counts);
    if (PythonSupport.available()) collectPythonDeps(project, root, index, counts);
    if (JavaScriptSupport.available()) collectJsDeps(project, root, index, counts);
    return new DepsResult(flattenDependencies(counts), findCycles(counts));
  }

  private static void collectJavaDeps(
      Project project, String root, Index index, Map<String, Map<String, Integer>> counts) {
    PsiManager psiManager = PsiManager.getInstance(project);
    Map<String, Set<String>> packageOwners = new TreeMap<>();
    List<ModuleJavaFile> files = new ArrayList<>();
    for (ModuleInfo module : index.modules) {
      for (String path : module.filePaths) {
        if (!path.endsWith(".java")) continue;
        try {
          VirtualFile virtualFile =
              VfsUtil.findFileByIoFile(Paths.get(root).resolve(path).toFile(), true);
          if (virtualFile == null) continue;
          PsiFile psiFile = psiManager.findFile(virtualFile);
          if (!(psiFile instanceof PsiJavaFile javaFile)) continue;
          files.add(new ModuleJavaFile(module.path, javaFile));
          String packageName = javaFile.getPackageName();
          if (!packageName.isEmpty()) {
            packageOwners.computeIfAbsent(packageName, key -> new TreeSet<>()).add(module.path);
          }
        } catch (Throwable t) {
          Log.info("project_map java dependency scan skipped (" + path + "): " + t);
        }
      }
    }

    for (ModuleJavaFile file : files) {
      try {
        PsiImportList importList = file.javaFile.getImportList();
        if (importList == null) continue;
        for (PsiImportStatementBase statement : importList.getAllImportStatements()) {
          String target = importTarget(statement);
          if (target == null) continue;
          Set<String> owners = longestPackageOwners(target, packageOwners);
          if (owners == null) continue;
          for (String owner : owners) {
            if (owner.equals(file.modulePath)) continue; // from≠to
            counts
                .computeIfAbsent(file.modulePath, key -> new TreeMap<>())
                .merge(owner, 1, Integer::sum); // 同一文件多行同一目标计多
          }
        }
      } catch (Throwable t) {
        Log.info("project_map java dependency import skipped (" + file.modulePath + "): " + t);
      }
    }
  }

  // ---- Python 依赖（import/from-import 归并到模块级） ----

  private static void collectPythonDeps(
      Project project, String root, Index index, Map<String, Map<String, Integer>> counts) {
    PsiManager psiManager = PsiManager.getInstance(project);
    Map<String, Set<String>> moduleOwners = new TreeMap<>();
    for (ModuleInfo module : index.modules) {
      registerDotted(moduleOwners, module.path.replace('/', '.'), module.path);
    }

    List<ModulePythonFile> files = new ArrayList<>();
    for (ModuleInfo module : index.modules) {
      for (String path : module.filePaths) {
        if (!path.endsWith(".py")) continue;
        VirtualFile virtualFile =
            VfsUtil.findFileByIoFile(Paths.get(root).resolve(path).toFile(), true);
        if (virtualFile == null) continue;
        try {
          PsiFile psiFile = psiManager.findFile(virtualFile);
          if (psiFile == null) continue;
          files.add(new ModulePythonFile(module.path, path, psiFile));
          registerDotted(
              moduleOwners, path.substring(0, path.length() - 3).replace('/', '.'), module.path);
        } catch (Throwable t) {
          // 安装不完整时该文件不贡献依赖（不影响其他文件）
          Log.warn("project_map python import scan failed (" + path + "): " + t);
        }
      }
    }

    for (ModulePythonFile file : files) {
      try {
        file.psiFile.accept(
            new PsiRecursiveElementWalkingVisitor() {
              @Override
              public void visitElement(PsiElement element) {
                String simple = element.getClass().getSimpleName();
                if (simple.startsWith("PyImportStatement")
                    || simple.startsWith("PyFromImportStatement")) {
                  applyPythonImport(
                      element.getText(), file.relativePath, file.modulePath, moduleOwners, counts);
                }
                super.visitElement(element);
              }
            });
      } catch (Throwable t) {
        Log.warn("project_map python import walk failed (" + file.relativePath + "): " + t);
      }
    }
  }

  private static final class ModulePythonFile {
    final String modulePath;
    final String relativePath;
    final PsiFile psiFile;

    ModulePythonFile(String modulePath, String relativePath, PsiFile psiFile) {
      this.modulePath = modulePath;
      this.relativePath = relativePath;
      this.psiFile = psiFile;
    }
  }

  /** 项目内点分模块名 → 模块 path；`src/` 源根布局同时登记去掉前缀的写法。 */
  private static void registerDotted(
      Map<String, Set<String>> owners, String dotted, String modulePath) {
    if (dotted.isEmpty()) return;
    owners.computeIfAbsent(dotted, key -> new TreeSet<>()).add(modulePath);
    if (dotted.startsWith("src.")) {
      owners.computeIfAbsent(dotted.substring(4), key -> new TreeSet<>()).add(modulePath);
    }
  }

  /** 一条 import 语句按目标模块归并；同一语句内同一模块只计 1，from≠to。 */
  private static void applyPythonImport(
      String rawText,
      String relativePath,
      String modulePath,
      Map<String, Set<String>> owners,
      Map<String, Map<String, Integer>> counts) {
    List<String> targets = pythonImportTargets(rawText, relativePath);
    if (targets.isEmpty()) return;
    Set<String> resolved = new TreeSet<>();
    for (String target : targets) {
      Set<String> found = longestDottedOwners(target, owners);
      if (found != null) resolved.addAll(found);
    }
    resolved.remove(modulePath);
    for (String owner : resolved) {
      counts
          .computeIfAbsent(modulePath, key -> new TreeMap<>())
          .merge(owner, 1, Integer::sum);
    }
  }

  /** 解析 `import a.b` / `from a.b import c`（含相对点号、括号展开与 `as` 别名）。 */
  private static List<String> pythonImportTargets(String rawText, String relativePath) {
    String text =
        rawText.replace('\r', ' ').replace('\n', ' ').replace('\\', ' ').replace('\t', ' ');
    text = text.replace('(', ' ').replace(')', ' ').replaceAll("\\s+", " ").trim();
    List<String> targets = new ArrayList<>();
    if (text.startsWith("import ")) {
      for (String part : text.substring("import ".length()).split(",")) {
        String name = withoutAlias(part);
        if (!name.isEmpty()) targets.add(name);
      }
      return targets;
    }
    if (!text.startsWith("from ")) return targets;
    int importIndex = text.indexOf(" import ");
    if (importIndex < 0) return targets;
    String module = text.substring("from ".length(), importIndex).trim();
    String imported = text.substring(importIndex + " import ".length()).trim();
    List<String> names = new ArrayList<>();
    for (String part : imported.split(",")) {
      String name = withoutAlias(part);
      if (!name.isEmpty() && !"*".equals(name)) names.add(name);
    }
    if (module.startsWith(".")) {
      addRelativePythonTargets(module, names, relativePath, targets);
      return targets;
    }
    if (!module.isEmpty()) {
      targets.add(module);
      for (String name : names) targets.add(module + "." + name);
    }
    return targets;
  }

  private static String withoutAlias(String part) {
    String value = part.trim();
    int alias = value.indexOf(" as ");
    if (alias >= 0) value = value.substring(0, alias).trim();
    return value.replaceAll("\\s+", "");
  }

  /** 相对导入：`.`=当前包，`..`=父包；同时生成 src/ 与去 src/ 两种候选。 */
  private static void addRelativePythonTargets(
      String module, List<String> names, String relativePath, List<String> targets) {
    int dots = 0;
    while (dots < module.length() && module.charAt(dots) == '.') dots++;
    String rest = module.substring(dots).trim();
    String dir = parentDirectory(relativePath);
    if (dir == null) return;
    String[] parts = dir.split("/");
    int keep = parts.length - (dots - 1);
    if (keep < 0) return;
    String base = String.join(".", Arrays.copyOfRange(parts, 0, keep));
    Set<String> bases = new LinkedHashSet<>();
    bases.add(base);
    if (base.startsWith("src.")) bases.add(base.substring(4));
    for (String candidate : bases) {
      String target = rest.isEmpty() ? candidate : candidate + "." + rest;
      if (candidate.isEmpty() || target.isEmpty()) continue;
      targets.add(target);
      for (String name : names) targets.add(target + "." + name);
    }
  }

  /** 最长匹配的项目模块前缀 → 属主模块集合；未命中（stdlib/第三方）返回 null。 */
  private static Set<String> longestDottedOwners(
      String qualifiedName, Map<String, Set<String>> owners) {
    String[] parts = qualifiedName.split("\\.");
    for (int cut = parts.length; cut >= 1; cut--) {
      String candidate = String.join(".", Arrays.copyOfRange(parts, 0, cut));
      Set<String> found = owners.get(candidate);
      if (found != null) return found;
    }
    return null;
  }

  // ---- JS/TS 依赖（import/export/require + 相对路径/tsconfig paths） ----

  private static void collectJsDeps(
      Project project, String root, Index index, Map<String, Map<String, Integer>> counts) {
    PsiManager psiManager = PsiManager.getInstance(project);
    Path rootPath = Paths.get(root).toAbsolutePath().normalize();
    Map<String, String> fileOwners = new HashMap<>();
    for (ModuleInfo module : index.modules) {
      for (String path : module.filePaths) {
        if (JavaScriptSupport.isJsFile(path)) fileOwners.put(path, module.path);
      }
    }
    Map<String, JsConfig> configs = new HashMap<>();

    for (ModuleInfo module : index.modules) {
      for (String path : module.filePaths) {
        if (!JavaScriptSupport.isJsFile(path)) continue;
        VirtualFile virtualFile =
            VfsUtil.findFileByIoFile(rootPath.resolve(path).toFile(), true);
        if (virtualFile == null) continue;
        try {
          PsiFile psiFile = psiManager.findFile(virtualFile);
          if (psiFile == null) continue;
          Set<String> owners = new TreeSet<>();
          for (String specifier : jsImportSpecifiers(psiFile)) {
            String owner =
                resolveJsSpecifierOwner(rootPath, path, specifier, fileOwners, configs);
            if (owner != null) owners.add(owner);
          }
          owners.remove(module.path);
          if (owners.isEmpty()) continue;
          Map<String, Integer> row =
              counts.computeIfAbsent(module.path, key -> new TreeMap<>());
          for (String owner : owners) row.merge(owner, 1, Integer::sum);
        } catch (Throwable t) {
          Log.warn("project_map js import scan failed (" + path + "): " + t);
        }
      }
    }
  }

  private static Set<String> jsImportSpecifiers(PsiFile psiFile) {
    Set<String> specifiers = new LinkedHashSet<>();
    psiFile.accept(
        new PsiRecursiveElementWalkingVisitor() {
          @Override
          public void visitElement(PsiElement element) {
            String simple = element.getClass().getSimpleName();
            if (simple.contains("Import")
                || simple.contains("Export")
                || simple.contains("CallExpression")) {
              String text = element.getText();
              if (text != null) {
                if (simple.contains("Import") || simple.contains("Export")) {
                  addSpecifiers(JS_IMPORT_FROM, text, specifiers);
                  addSpecifiers(JS_IMPORT_SIDE_EFFECT, text, specifiers);
                }
                if (simple.contains("CallExpression")) {
                  addSpecifiers(JS_REQUIRE, text, specifiers);
                  addSpecifiers(JS_DYNAMIC_IMPORT, text, specifiers);
                }
              }
            }
            super.visitElement(element);
          }
        });
    return specifiers;
  }

  private static void addSpecifiers(
      Pattern pattern, String text, Set<String> specifiers) {
    java.util.regex.Matcher matcher = pattern.matcher(text);
    while (matcher.find()) {
      String value = matcher.group(1);
      if (value != null && !value.isEmpty()) specifiers.add(value.trim());
    }
  }

  private static String resolveJsSpecifierOwner(
      Path rootPath,
      String sourcePath,
      String rawSpecifier,
      Map<String, String> fileOwners,
      Map<String, JsConfig> configs) {
    String cleaned = rawSpecifier.trim();
    int query = cleaned.indexOf('?');
    if (query >= 0) cleaned = cleaned.substring(0, query);
    int hash = cleaned.indexOf('#');
    if (hash >= 0) cleaned = cleaned.substring(0, hash);
    if (cleaned.isEmpty()) return null;

    String relative = null;
    if (cleaned.startsWith("./") || cleaned.startsWith("../")) {
      String dir = parentDirectory(sourcePath);
      relative = normalizeRelative((dir == null ? "" : dir + "/") + cleaned);
    } else if (cleaned.startsWith("/")) {
      relative = normalizeRelative(cleaned.substring(1));
    } else {
      try {
        JsConfig config = findJsConfig(rootPath, sourcePath, configs);
        if (config != null) {
          String aliasOwner = resolveJsAlias(config, rootPath, cleaned, fileOwners);
          if (aliasOwner != null) return aliasOwner;
          Path baseCandidate = config.baseUrl.resolve(cleaned).normalize();
          if (baseCandidate.startsWith(rootPath)) {
            String owner =
                ownerOfRelative(
                    rootPath.relativize(baseCandidate).toString().replace('\\', '/'), fileOwners);
            if (owner != null) return owner;
          }
        }
      } catch (Throwable ignored) {
        // 非法路径（node:fs / bun:test / URL 等）：按外部依赖忽略
        return null;
      }
      // 裸协议/imports map 不是项目路径
      if (cleaned.contains(":") || cleaned.startsWith("#")) return null;
      relative = normalizeRelative(cleaned);
    }
    if (relative == null) return null;
    return ownerOfRelative(relative, fileOwners);
  }

  private static String ownerOfRelative(
      String relative, Map<String, String> fileOwners) {
    String direct = fileOwners.get(relative);
    if (direct != null) return direct;
    for (String extension : JS_EXTENSIONS) {
      if (!relative.endsWith(extension)) continue;
      String stem = relative.substring(0, relative.length() - extension.length());
      for (String replacement : JS_EXTENSIONS) {
        String owner = fileOwners.get(stem + replacement);
        if (owner != null) return owner;
      }
    }
    for (String extension : JS_EXTENSIONS) {
      String owner = fileOwners.get(relative + extension);
      if (owner != null) return owner;
    }
    for (String extension : JS_EXTENSIONS) {
      String owner = fileOwners.get(relative + "/index" + extension);
      if (owner != null) return owner;
    }
    return null;
  }

  private static final class JsConfig {
    final Path baseUrl;
    final List<JsPathAlias> aliases;

    JsConfig(Path baseUrl, List<JsPathAlias> aliases) {
      this.baseUrl = baseUrl;
      this.aliases = aliases;
    }
  }

  private static final class JsPathAlias {
    final String pattern;
    final List<String> targets;

    JsPathAlias(String pattern, List<String> targets) {
      this.pattern = pattern;
      this.targets = targets;
    }

    /** 匹配成功返回 `*` 捕获段（无 `*` 返回空串），不匹配返回 null。 */
    String match(String specifier) {
      int star = pattern.indexOf('*');
      if (star < 0) return pattern.equals(specifier) ? "" : null;
      String prefix = pattern.substring(0, star);
      String suffix = pattern.substring(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
      if (specifier.length() < prefix.length() + suffix.length()) return null;
      return specifier.substring(prefix.length(), specifier.length() - suffix.length());
    }
  }

  private static JsConfig findJsConfig(
      Path rootPath, String sourcePath, Map<String, JsConfig> configs) {
    String dir = parentDirectory(sourcePath);
    Path current = dir == null ? rootPath : rootPath.resolve(dir).normalize();
    for (int depth = 0;
        current != null && current.startsWith(rootPath) && depth < JS_CONFIG_SCAN_DEPTH;
        depth++, current = current.getParent()) {
      String key = current.toString();
      if (!configs.containsKey(key)) {
        JsConfig parsed = readJsConfig(current.resolve("tsconfig.json"));
        if (parsed == null) parsed = readJsConfig(current.resolve("jsconfig.json"));
        configs.put(key, parsed);
      }
      JsConfig found = configs.get(key);
      if (found != null) return found;
      if (current.equals(rootPath)) break;
    }
    return null;
  }

  /** 读取 compilerOptions.baseUrl / paths（不处理 extends；单个 `*` 模式）。 */
  private static JsConfig readJsConfig(Path file) {
    if (!Files.isRegularFile(file)) return null;
    try {
      JsonObject json = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
      JsonElement optionsElement = json.get("compilerOptions");
      JsonObject options =
          optionsElement != null && optionsElement.isJsonObject()
              ? optionsElement.getAsJsonObject()
              : new JsonObject();
      Path configDir = file.getParent();
      Path baseUrl = configDir;
      JsonElement baseUrlElement = options.get("baseUrl");
      if (baseUrlElement != null
          && baseUrlElement.isJsonPrimitive()
          && baseUrlElement.getAsJsonPrimitive().isString()) {
        baseUrl = configDir.resolve(baseUrlElement.getAsString()).normalize();
      }
      List<JsPathAlias> aliases = new ArrayList<>();
      JsonElement pathsElement = options.get("paths");
      if (pathsElement != null && pathsElement.isJsonObject()) {
        for (Map.Entry<String, JsonElement> entry : pathsElement.getAsJsonObject().entrySet()) {
          if (!entry.getValue().isJsonArray()) continue;
          List<String> targets = new ArrayList<>();
          for (JsonElement target : entry.getValue().getAsJsonArray()) {
            if (target.isJsonPrimitive() && target.getAsJsonPrimitive().isString()) {
              targets.add(target.getAsString());
            }
          }
          if (!targets.isEmpty()) aliases.add(new JsPathAlias(entry.getKey(), targets));
        }
      }
      // 更具体的模式优先（前缀越长越优先；无通配符按整串长度）
      aliases.sort(
          Comparator.comparingInt(
                  (JsPathAlias alias) -> {
                    int star = alias.pattern.indexOf('*');
                    return star < 0 ? alias.pattern.length() : star;
                  })
              .reversed());
      return new JsConfig(baseUrl, aliases);
    } catch (Throwable t) {
      Log.warn("tsconfig parse failed (" + file + "): " + t);
      return null;
    }
  }

  private static String resolveJsAlias(
      JsConfig config, Path rootPath, String specifier, Map<String, String> fileOwners) {
    for (JsPathAlias alias : config.aliases) {
      String star = alias.match(specifier);
      if (star == null) continue;
      for (String target : alias.targets) {
        String expanded = target.replace("*", star);
        try {
          Path candidate = config.baseUrl.resolve(expanded).normalize();
          if (!candidate.startsWith(rootPath)) continue;
          String owner =
              ownerOfRelative(
                  rootPath.relativize(candidate).toString().replace('\\', '/'), fileOwners);
          if (owner != null) return owner;
        } catch (Throwable ignored) {
          // 非法 alias 目标跳过
        }
      }
    }
    return null;
  }

  private static final class ModuleJavaFile {
    final String modulePath;
    final PsiJavaFile javaFile;

    ModuleJavaFile(String modulePath, PsiJavaFile javaFile) {
      this.modulePath = modulePath;
      this.javaFile = javaFile;
    }
  }

  /** import 目标限定名（去掉 on-demand 的 `.*`）；Java 9 module import 不算类依赖。 */
  private static String importTarget(PsiImportStatementBase statement) {
    String name;
    if (statement instanceof PsiImportStaticStatement staticStatement) {
      name = staticStatement.getQualifiedName();
    } else if (statement instanceof PsiImportStatement importStatement) {
      name = importStatement.getQualifiedName();
    } else {
      return null;
    }
    if (name == null) return null;
    String trimmed = name.trim();
    if (trimmed.endsWith(".*")) trimmed = trimmed.substring(0, trimmed.length() - 2);
    return trimmed.isEmpty() ? null : trimmed;
  }

  /** 最长匹配的项目包前缀 → 属主模块集合；未命中（JDK/外部）返回 null。 */
  private static Set<String> longestPackageOwners(
      String qualifiedName, Map<String, Set<String>> packageOwners) {
    String[] parts = qualifiedName.split("\\.");
    for (int cut = parts.length; cut >= 1; cut--) {
      String candidate = String.join(".", Arrays.copyOfRange(parts, 0, cut));
      Set<String> owners = packageOwners.get(candidate);
      if (owners != null) return owners;
    }
    return null;
  }

  private static List<Dependency> flattenDependencies(Map<String, Map<String, Integer>> counts) {
    List<Dependency> dependencies = new ArrayList<>();
    for (Map.Entry<String, Map<String, Integer>> from : counts.entrySet()) {
      for (Map.Entry<String, Integer> to : from.getValue().entrySet()) {
        dependencies.add(new Dependency(from.getKey(), to.getKey(), to.getValue()));
      }
    }
    return dependencies;
  }

  /** Tarjan SCC（迭代版，避免深图递归栈溢出）；只返回 size>1 的强连通分量，成员按 path 升序。 */
  private static List<List<String>> findCycles(Map<String, Map<String, Integer>> counts) {
    Set<String> nodeSet = new TreeSet<>();
    for (Map.Entry<String, Map<String, Integer>> entry : counts.entrySet()) {
      if (entry.getValue().isEmpty()) continue;
      nodeSet.add(entry.getKey());
      nodeSet.addAll(entry.getValue().keySet());
    }
    if (nodeSet.isEmpty()) return List.of();

    List<String> nodes = new ArrayList<>(nodeSet);
    Map<String, Integer> position = new HashMap<>();
    for (int i = 0; i < nodes.size(); i++) position.put(nodes.get(i), i);
    List<List<Integer>> adjacency = new ArrayList<>();
    for (String node : nodes) {
      List<Integer> targets = new ArrayList<>();
      for (String target : counts.getOrDefault(node, Map.of()).keySet()) {
        targets.add(position.get(target));
      }
      targets.sort(Comparator.naturalOrder());
      adjacency.add(targets);
    }

    int count = nodes.size();
    int[] index = new int[count];
    int[] low = new int[count];
    boolean[] onStack = new boolean[count];
    Arrays.fill(index, -1);
    Deque<Integer> stack = new ArrayDeque<>();
    Deque<int[]> frames = new ArrayDeque<>(); // [node, 下一个待访问邻接下标]
    List<List<String>> cycles = new ArrayList<>();
    int next = 0;

    for (int start = 0; start < count; start++) {
      if (index[start] != -1) continue;
      index[start] = low[start] = next++;
      stack.push(start);
      onStack[start] = true;
      frames.push(new int[] {start, 0});
      while (!frames.isEmpty()) {
        int[] frame = frames.peek();
        int node = frame[0];
        List<Integer> targets = adjacency.get(node);
        if (frame[1] < targets.size()) {
          int target = targets.get(frame[1]++);
          if (index[target] == -1) {
            index[target] = low[target] = next++;
            stack.push(target);
            onStack[target] = true;
            frames.push(new int[] {target, 0});
          } else if (onStack[target]) {
            low[node] = Math.min(low[node], index[target]);
          }
        } else {
          frames.pop();
          if (!frames.isEmpty()) {
            int parent = frames.peek()[0];
            low[parent] = Math.min(low[parent], low[node]);
          }
          if (low[node] == index[node]) {
            List<String> component = new ArrayList<>();
            int member;
            do {
              member = stack.pop();
              onStack[member] = false;
              component.add(nodes.get(member));
            } while (member != node);
            if (component.size() > 1) {
              component.sort(Comparator.naturalOrder());
              cycles.add(component);
            }
          }
        }
      }
    }
    cycles.sort(Comparator.comparing(cycle -> String.join("\u0000", cycle)));
    return cycles;
  }

  // ---- 视图组装（冻结协议：严格字段，三形均可附 building/progress） ----

  private JsonObject buildingResult(String view, String root) {
    JsonObject result = new JsonObject();
    result.addProperty("building", true);
    result.addProperty("progress", rounded(progress));
    if ("dependencies".equals(view)) {
      result.add("project", projectJson(root, 0, null));
      result.add("dependencies", new JsonArray());
      result.add("cycles", new JsonArray());
      return result;
    }
    if ("hot".equals(view)) {
      result.add("project", projectJson(root, 0, null));
      result.add("hot_files", new JsonArray());
      result.add("hot_modules", new JsonArray());
      return result;
    }
    result.add("project", projectJson(root, 0, 0));
    result.add("modules", new JsonArray());
    result.add("entry_points", new JsonArray());
    result.add("root_files", new JsonArray());
    return result;
  }

  private static JsonObject structureJson(Snapshot snapshot, String root) {
    Index index = snapshot.index;
    JsonObject result = new JsonObject();
    result.add("project", projectJson(root, index.totalFiles, index.modules.size()));
    JsonArray modules = new JsonArray();
    int shown = 0;
    for (ModuleInfo module : index.modules) {
      if (shown++ >= MODULE_LIMIT) break;
      modules.add(moduleJson(module, index));
    }
    result.add("modules", modules);
    JsonArray entryPoints = new JsonArray();
    for (EntryPoint entry : index.entryPoints) entryPoints.add(entry.toJson());
    result.add("entry_points", entryPoints);
    JsonArray rootFiles = new JsonArray();
    for (String file : index.rootFiles) rootFiles.add(file);
    result.add("root_files", rootFiles);
    return result;
  }

  private static JsonObject moduleJson(ModuleInfo module, Index index) {
    JsonObject json = new JsonObject();
    json.addProperty("name", module.name);
    json.addProperty("path", module.path);
    JsonArray files = new JsonArray();
    int limit = Math.min(module.fileNames.size(), MODULE_FILES_LIMIT);
    for (int i = 0; i < limit; i++) files.add(module.fileNames.get(i));
    json.add("files", files);
    json.addProperty("is_entry", index.entryModules.contains(module.path));
    json.addProperty("hot", false);
    return json;
  }

  private static JsonObject dependenciesJson(Snapshot snapshot, String root) {
    JsonObject result = new JsonObject();
    result.add("project", projectJson(root, snapshot.index.totalFiles, null));
    JsonArray dependencies = new JsonArray();
    for (Dependency dependency : snapshot.dependencies) dependencies.add(dependency.toJson());
    result.add("dependencies", dependencies);
    JsonArray cycles = new JsonArray();
    for (List<String> cycle : snapshot.cycles) {
      JsonArray cycleJson = new JsonArray();
      for (String member : cycle) cycleJson.add(member);
      cycles.add(cycleJson);
    }
    result.add("cycles", cycles);
    return result;
  }

  private static JsonObject hotJson(Snapshot snapshot, String root) {
    JsonObject result = new JsonObject();
    result.add("project", projectJson(root, snapshot.index.totalFiles, null));
    result.add("hot_files", new JsonArray());
    result.add("hot_modules", new JsonArray());
    return result;
  }

  private static JsonObject projectJson(String root, int totalFiles, Integer totalModules) {
    JsonObject project = new JsonObject();
    project.addProperty("root", root);
    project.addProperty("total_files", totalFiles);
    if (totalModules != null) project.addProperty("total_modules", totalModules);
    return project;
  }

  // ---- scope 过滤（不缓存） ----

  private JsonObject structureForScope(String scope) {
    if (scope == null) return structureView;
    ModuleInfo target = findModule(scope);
    JsonObject result = new JsonObject();
    result.add("project", structureView.getAsJsonObject("project"));
    JsonArray modules = new JsonArray();
    JsonArray entryPoints = new JsonArray();
    JsonArray rootFiles = new JsonArray();
    if (target != null) {
      modules.add(moduleJson(target, ready.index));
      for (EntryPoint entry : ready.index.entryPoints) {
        if (target.path.equals(parentDirectory(entry.file))) entryPoints.add(entry.toJson());
      }
    }
    result.add("modules", modules);
    result.add("entry_points", entryPoints);
    result.add("root_files", rootFiles);
    return result;
  }

  private JsonObject depsForScope(String scope) {
    if (scope == null) return depsView;
    ModuleInfo target = findModule(scope);
    JsonObject result = new JsonObject();
    result.add("project", depsView.getAsJsonObject("project"));
    JsonArray dependencies = new JsonArray();
    if (target != null) {
      for (Dependency dependency : ready.dependencies) {
        if (dependency.from.equals(target.path) || dependency.to.equals(target.path)) {
          dependencies.add(dependency.toJson());
        }
      }
    }
    result.add("dependencies", dependencies);
    result.add("cycles", depsView.getAsJsonArray("cycles"));
    return result;
  }

  /** scope 值先按模块 path 精确匹配，再按 name 匹配（升序首个）。 */
  private ModuleInfo findModule(String value) {
    for (ModuleInfo module : ready.index.modules) {
      if (module.path.equals(value)) return module;
    }
    for (ModuleInfo module : ready.index.modules) {
      if (module.name.equals(value)) return module;
    }
    return null;
  }

  // ---- 数据结构 ----

  private static final class ModuleInfo {
    final String name;
    final String path;
    final List<String> fileNames = new ArrayList<>();
    final List<String> filePaths = new ArrayList<>();

    ModuleInfo(String name, String path) {
      this.name = name;
      this.path = path;
    }
  }

  private static final class EntryPoint {
    final String file;
    final int line;
    final String symbol;
    final String kind;

    EntryPoint(String file, int line, String symbol, String kind) {
      this.file = file;
      this.line = line;
      this.symbol = symbol;
      this.kind = kind;
    }

    JsonObject toJson() {
      JsonObject json = new JsonObject();
      json.addProperty("file", file);
      json.addProperty("line", line);
      json.addProperty("symbol", symbol);
      json.addProperty("kind", kind);
      return json;
    }
  }

  private static final class Dependency {
    final String from;
    final String to;
    final int count;

    Dependency(String from, String to, int count) {
      this.from = from;
      this.to = to;
      this.count = count;
    }

    JsonObject toJson() {
      JsonObject json = new JsonObject();
      json.addProperty("from", from);
      json.addProperty("to", to);
      json.addProperty("count", count);
      return json;
    }
  }

  private static final class Index {
    final List<ModuleInfo> modules;
    final List<String> rootFiles;
    final List<EntryPoint> entryPoints;
    final Set<String> entryModules;
    final int totalFiles;

    Index(
        List<ModuleInfo> modules,
        List<String> rootFiles,
        List<EntryPoint> entryPoints,
        Set<String> entryModules,
        int totalFiles) {
      this.modules = modules;
      this.rootFiles = rootFiles;
      this.entryPoints = entryPoints;
      this.entryModules = entryModules;
      this.totalFiles = totalFiles;
    }
  }

  private static final class Snapshot {
    final Index index;
    final Fingerprint fingerprint;
    final List<Dependency> dependencies;
    final List<List<String>> cycles;

    Snapshot(
        Index index,
        Fingerprint fingerprint,
        List<Dependency> dependencies,
        List<List<String>> cycles) {
      this.index = index;
      this.fingerprint = fingerprint;
      this.dependencies = dependencies;
      this.cycles = cycles;
    }

    Snapshot withDependencies(List<Dependency> dependencies, List<List<String>> cycles) {
      return new Snapshot(index, fingerprint, dependencies, cycles);
    }
  }

  private static final class Fingerprint {
    final List<String> dirs = new ArrayList<>();
    final Map<String, List<String>> dirEntries = new HashMap<>();
    final Map<String, Long> fileMtimes = new HashMap<>();
  }

  private static double rounded(double value) {
    return Math.round(value * 1000.0) / 1000.0;
  }

  private static long millis(long startedNanos) {
    return (System.nanoTime() - startedNanos) / 1_000_000L;
  }
}
