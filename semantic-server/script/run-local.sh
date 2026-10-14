#!/usr/bin/env bash
# 启动 IntelliJ 无头语义守护（镜像 bin/idea.bat 的 classpath / 系统属性方案）
# 用法: script/run-local.sh [project_path] [socket_path] [--idle-seconds N]
# 默认: sample-project + .tmp/semantic.sock + 1800s
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IDEA_DIR="${IDEA_DIR:-D:/IntelliJ IDEA 2026.2.0.1}"
SANDBOX="${SEMANTIC_SANDBOX:-$ROOT/.sandbox}"

ARGS=("$@")
PROJECT="${ARGS[0]:-$ROOT/sample-project}"
SOCKET="${ARGS[1]:-$ROOT/.tmp/semantic.sock}"
IDLE=1800
i=2
while [ "$i" -lt "${#ARGS[@]}" ]; do
  case "${ARGS[$i]}" in
    --idle-seconds)
      IDLE="${ARGS[$((i + 1))]:-1800}"
      i=$((i + 2))
      ;;
    --idle-seconds=*)
      IDLE="${ARGS[$i]#*=}"
      i=$((i + 1))
      ;;
    *)
      i=$((i + 1))
      ;;
  esac
done

JAVA="$IDEA_DIR/jbr/bin/java.exe"
if [ ! -x "$JAVA" ]; then
  echo "ERROR: $JAVA not found; set IDEA_DIR" >&2
  exit 1
fi

mkdir -p "$SANDBOX/config" "$SANDBOX/system" "$SANDBOX/plugins" "$SANDBOX/log" "$(dirname "$SOCKET")"

# sample-project 的 .idea/misc.xml 引用名为 semantic-jdk 的项目 SDK；
# 首次运行时在 sandbox config 生成 jdk.table.xml（classPath 需要具体 jrt roots，
# 否则 headless 下 java.lang.* 无法解析）。改过项目模型后需删除 <sandbox>/system 清缓存。
JDK_HOME_FOR_PROJECT="${SEMANTIC_JDK_HOME:-D:/jdk25}"
JDK_TABLE="$SANDBOX/config/options/jdk.table.xml"
if [ ! -f "$JDK_TABLE" ] && [ -d "$JDK_HOME_FOR_PROJECT" ]; then
  mkdir -p "$(dirname "$JDK_TABLE")"
  {
    printf '<application>\n  <component name="ProjectJdkTable">\n    <jdk version="2">\n'
    printf '      <name value="semantic-jdk" />\n      <type value="JavaSDK" />\n'
    printf '      <version value="java version &quot;25&quot;" />\n      <homePath value="%s" />\n      <roots>\n' "$JDK_HOME_FOR_PROJECT"
    printf '        <annotationsPath><root type="composite" /></annotationsPath>\n        <classPath>\n          <root type="composite">\n'
    if [ -d "$JDK_HOME_FOR_PROJECT/jmods" ]; then
      for jmod in "$JDK_HOME_FOR_PROJECT"/jmods/*.jmod; do
        name="$(basename "$jmod" .jmod)"
        printf '            <root type="jrt" url="jrt://%s!/%s" />\n' "$JDK_HOME_FOR_PROJECT" "$name"
      done
    fi
    printf '          </root>\n        </classPath>\n        <javadocPath><root type="composite" /></javadocPath>\n        <sourcePath><root type="composite" /></sourcePath>\n      </roots>\n      <additional />\n    </jdk>\n  </component>\n</application>\n'
  } > "$JDK_TABLE"
  echo "[run-local] created $JDK_TABLE (home=$JDK_HOME_FOR_PROJECT)"
fi

echo "[run-local] project=$PROJECT"
echo "[run-local] socket=$SOCKET idle=${IDLE}s sandbox=$SANDBOX"

"$JAVA" \
  -Djava.awt.headless=true \
  "-Didea.home.path=$IDEA_DIR" \
  "-Didea.config.path=$SANDBOX/config" \
  "-Didea.system.path=$SANDBOX/system" \
  "-Didea.plugins.path=$SANDBOX/plugins" \
  "-Didea.log.path=$SANDBOX/log" \
  -Didea.vendor.name=JetBrains \
  -Didea.paths.selector=IntelliJIdea2026.2 \
  "-Dintellij.platform.runtime.repository.path=$IDEA_DIR/modules/module-descriptors.dat" \
  "-Xbootclasspath/a:$IDEA_DIR/lib/nio-fs.jar" \
  -Djava.system.class.loader=com.intellij.util.lang.PathClassLoader \
  -Djava.nio.file.spi.DefaultFileSystemProvider=com.intellij.platform.core.nio.fs.MultiRoutingFileSystemProvider \
  "-Djna.boot.library.path=$IDEA_DIR/lib/jna/amd64" \
  -Djna.nosys=true \
  -Djna.noclasspath=true \
  "-Dpty4j.preferred.native.folder=$IDEA_DIR/lib/pty4j" \
  -XX:+IgnoreUnrecognizedVMOptions \
  -Xmx2048m \
  --enable-native-access=ALL-UNNAMED \
  --add-opens=java.base/java.io=ALL-UNNAMED \
  --add-opens=java.base/java.lang=ALL-UNNAMED \
  --add-opens=java.base/java.lang.ref=ALL-UNNAMED \
  --add-opens=java.base/java.lang.reflect=ALL-UNNAMED \
  --add-opens=java.base/java.net=ALL-UNNAMED \
  --add-opens=java.base/java.nio=ALL-UNNAMED \
  --add-opens=java.base/java.nio.charset=ALL-UNNAMED \
  --add-opens=java.base/java.text=ALL-UNNAMED \
  --add-opens=java.base/java.time=ALL-UNNAMED \
  --add-opens=java.base/java.util=ALL-UNNAMED \
  --add-opens=java.base/java.util.concurrent=ALL-UNNAMED \
  --add-opens=java.base/java.util.concurrent.atomic=ALL-UNNAMED \
  --add-opens=java.base/java.util.concurrent.locks=ALL-UNNAMED \
  --add-opens=java.base/jdk.internal.ref=ALL-UNNAMED \
  --add-opens=java.base/jdk.internal.vm=ALL-UNNAMED \
  --add-opens=java.base/sun.net.dns=ALL-UNNAMED \
  --add-opens=java.base/sun.nio=ALL-UNNAMED \
  --add-opens=java.base/sun.nio.ch=ALL-UNNAMED \
  --add-opens=java.base/sun.nio.fs=ALL-UNNAMED \
  --add-opens=java.base/sun.security.ssl=ALL-UNNAMED \
  --add-opens=java.base/sun.security.util=ALL-UNNAMED \
  --add-opens=java.desktop/com.sun.java.swing=ALL-UNNAMED \
  --add-opens=java.desktop/java.awt=ALL-UNNAMED \
  --add-opens=java.desktop/java.awt.dnd.peer=ALL-UNNAMED \
  --add-opens=java.desktop/java.awt.event=ALL-UNNAMED \
  --add-opens=java.desktop/java.awt.font=ALL-UNNAMED \
  --add-opens=java.desktop/java.awt.image=ALL-UNNAMED \
  --add-opens=java.desktop/java.awt.peer=ALL-UNNAMED \
  --add-opens=java.desktop/javax.swing=ALL-UNNAMED \
  --add-opens=java.desktop/javax.swing.plaf.basic=ALL-UNNAMED \
  --add-opens=java.desktop/javax.swing.text=ALL-UNNAMED \
  --add-opens=java.desktop/javax.swing.text.html=ALL-UNNAMED \
  --add-opens=java.desktop/javax.swing.text.html.parser=ALL-UNNAMED \
  --add-opens=java.desktop/sun.awt=ALL-UNNAMED \
  --add-opens=java.desktop/sun.awt.datatransfer=ALL-UNNAMED \
  --add-opens=java.desktop/sun.awt.image=ALL-UNNAMED \
  --add-opens=java.desktop/sun.awt.windows=ALL-UNNAMED \
  --add-opens=java.desktop/sun.font=ALL-UNNAMED \
  --add-opens=java.desktop/sun.java2d=ALL-UNNAMED \
  --add-opens=java.desktop/sun.swing=ALL-UNNAMED \
  --add-opens=java.desktop/sun.swing.text=ALL-UNNAMED \
  --add-opens=java.management/sun.management=ALL-UNNAMED \
  --add-opens=jdk.attach/sun.tools.attach=ALL-UNNAMED \
  --add-opens=jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED \
  --add-opens=jdk.internal.jvmstat/sun.jvmstat.monitor=ALL-UNNAMED \
  --add-opens=jdk.jdi/com.sun.tools.jdi=ALL-UNNAMED \
  -cp "$IDEA_DIR/lib/*" \
  com.intellij.idea.Main semantic-server "$PROJECT" "$SOCKET" --idle-seconds "$IDLE"
