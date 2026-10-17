#!/usr/bin/env bash
# 本地构建（不需要 Gradle / 网络）：
#   1. 用本地 IDEA 的平台 jar 做 classpath，javac 编译 Java 源码
#   2. 把 META-INF/plugin.xml 一起打进 semantic-server.jar
#   3. 安装到 .sandbox/plugins/semantic-server/lib 供 run-local.sh 启动
# IDE 与 JDK 解析：SEMANTIC_IDE_HOME/IDEA_HOME/IDEA_DIR 覆盖，其次注册表/Toolbox/常见路径发现；
# JDK：TOOL_JAVA_HOME > SEMANTIC_JDK_HOME > JAVA_HOME > 常见目录 > PATH javac（见 script/resolve-env.sh）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=resolve-env.sh
source "$SCRIPT_DIR/resolve-env.sh"

if [ -n "${TOOL_JAVA_HOME:-}" ] && { [ -x "$TOOL_JAVA_HOME/bin/javac.exe" ] || [ -x "$TOOL_JAVA_HOME/bin/javac" ]; }; then
  TOOL_HOME="$TOOL_JAVA_HOME"
elif TOOL_HOME="$(semantic_resolve_jdk_home --require-javac)"; then
  :
elif command -v javac >/dev/null 2>&1; then
  TOOL_HOME="$(dirname "$(dirname "$(command -v javac)")")"
else
  echo "ERROR: no javac found; set TOOL_JAVA_HOME / SEMANTIC_JDK_HOME / JAVA_HOME" >&2
  exit 1
fi

if ! IDEA_DIR="$(semantic_resolve_idea_dir --require-java)"; then
  echo "ERROR: no Java-capable IntelliJ IDE found; set SEMANTIC_IDE_HOME / IDEA_HOME / IDEA_DIR" >&2
  exit 1
fi

JAVAC="$TOOL_HOME/bin/javac.exe"
[ -x "$JAVAC" ] || JAVAC="$TOOL_HOME/bin/javac"
JAR="$TOOL_HOME/bin/jar.exe"
[ -x "$JAR" ] || JAR="$TOOL_HOME/bin/jar"

CP="$IDEA_DIR/lib/*;$IDEA_DIR/plugins/java/lib/*;$IDEA_DIR/plugins/java/lib/modules/*"

OUT="$ROOT/build-local"
rm -rf "$OUT/classes"
mkdir -p "$OUT/classes"

# sources.txt 必须是相对路径（Windows javac 不识别 MSYS 的 /e/... 形式）
(cd "$ROOT" && find src/main/java -name '*.java' | sort > "$OUT/sources.txt")

echo "[build-local] idea: $IDEA_DIR"
echo "[build-local] javac: $JAVAC"
(cd "$ROOT" && "$JAVAC" --release 21 -encoding UTF-8 -cp "$CP" -d "$OUT/classes" "@$OUT/sources.txt")

printf 'Manifest-Version: 1.0\nMain-Class: opencode.semantic.Launcher\n' > "$OUT/MANIFEST.MF"

"$JAR" --create --file "$OUT/semantic-server.jar" \
  --manifest "$OUT/MANIFEST.MF" \
  -C "$OUT/classes" . \
  -C "$ROOT/src/main/resources" META-INF

PLUGIN_LIB="$ROOT/.sandbox/plugins/semantic-server/lib"
mkdir -p "$PLUGIN_LIB"
cp "$OUT/semantic-server.jar" "$PLUGIN_LIB/semantic-server.jar"

echo "[build-local] OK: $OUT/semantic-server.jar"
echo "[build-local] installed: $PLUGIN_LIB/semantic-server.jar"
