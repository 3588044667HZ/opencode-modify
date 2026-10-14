#!/usr/bin/env bash
# Gradle 构建（依赖已固化在 semantic-server/.gradle-home，默认 --offline 不触网）
# 用法: script/gradle-build.sh [task...]          默认 task: buildPlugin
#       GRADLE_ONLINE=1 script/gradle-build.sh    仅首次拉取依赖时需要联网
# 环境: JAVA_HOME  默认 D:/Android Studio/jbr（Gradle 8.5 自身需 Java 21）
#       GRADLE_BIN 默认本机 gradle-8.5 分发，可覆盖
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 注意：本机全局 JAVA_HOME 指向 JDK 25，而 Gradle 8.5 不能运行在 Java 25 上；
# 这里固定用 JBR 21 跑 Gradle（需要时用 GRADLE_JAVA_HOME 覆盖），编译本身由
# build.gradle.kts fork D:/jdk25 的 javac 完成。
GRADLE_JAVA_HOME="${GRADLE_JAVA_HOME:-D:/Android Studio/jbr}"
PROJECT_DIR="$ROOT"
GRADLE_HOME_DIR="$ROOT/.gradle-home"
if command -v cygpath >/dev/null 2>&1; then
  GRADLE_JAVA_HOME="$(cygpath -w "$GRADLE_JAVA_HOME")"
  PROJECT_DIR="$(cygpath -m "$PROJECT_DIR")"
  GRADLE_HOME_DIR="$(cygpath -m "$GRADLE_HOME_DIR")"
fi
export JAVA_HOME="$GRADLE_JAVA_HOME"

GRADLE_BIN="${GRADLE_BIN:-/c/Users/Administrator/.gradle/wrapper/dists/gradle-8.5-bin/5t9huq95ubn472n8rpzujfbqh/gradle-8.5/bin/gradle.bat}"
if [ ! -e "$GRADLE_BIN" ]; then
  GRADLE_BIN="$(command -v gradle || true)"
fi
if [ -z "$GRADLE_BIN" ] || [ ! -e "$GRADLE_BIN" ]; then
  echo "ERROR: gradle not found; set GRADLE_BIN" >&2
  exit 1
fi

MODE=(--offline)
if [ "${GRADLE_ONLINE:-0}" = "1" ]; then
  MODE=()
  echo "[gradle-build] online mode (bootstrap only)" >&2
fi

TASKS=("$@")
if [ "${#TASKS[@]}" -eq 0 ]; then
  TASKS=(buildPlugin)
fi

exec "$GRADLE_BIN" -g "$GRADLE_HOME_DIR" "${MODE[@]}" --project-dir "$PROJECT_DIR" "${TASKS[@]}" --console=plain --no-daemon
