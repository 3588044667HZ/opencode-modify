#!/usr/bin/env bash
# Gradle 构建（依赖已固化在 semantic-server/.gradle-home，默认 --offline 不触网）
# 用法: script/gradle-build.sh [task...]          默认 task: buildPlugin
#       GRADLE_ONLINE=1 script/gradle-build.sh    仅首次拉取依赖时需要联网
# 环境:
#   GRADLE_JAVA_HOME  运行 Gradle 的 JVM（Gradle 8.5 不能跑在 Java 25 上；缺省在
#                     SEMANTIC_JDK_HOME/JAVA_HOME/常见目录/IDE 自带 JBR 中发现 Java 8–21）
#   GRADLE_BIN        gradle 可执行文件（缺省 PATH，再回退 ~/.gradle/wrapper/dists 下已解压的发行）
#   SEMANTIC_IDE_HOME / SEMANTIC_JDK_HOME  由本脚本发现后导出给 build.gradle.kts（fork javac 编译）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=resolve-env.sh
source "$SCRIPT_DIR/resolve-env.sh"

semantic_java_major() {
  local candidate="$1" java_bin version
  if [ -x "$candidate/bin/java.exe" ]; then
    java_bin="$candidate/bin/java.exe"
  elif [ -x "$candidate/bin/java" ]; then
    java_bin="$candidate/bin/java"
  else
    return 1
  fi
  version="$("$java_bin" -version 2>&1 | sed -n 's/.*version "\([0-9][0-9]*\)[."].*/\1/p')"
  if [ -z "$version" ]; then return 1; fi
  if [ "$version" = "1" ]; then
    version="$("$java_bin" -version 2>&1 | sed -n 's/.*version "1\.\([0-9][0-9]*\).*/\1/p')"
  fi
  printf '%s\n' "$version"
}

# Java-capable IDE（编译 classpath 需要 plugins/java）导出给 build.gradle.kts
if ! IDEA_DIR="$(semantic_resolve_idea_dir --require-java)"; then
  echo "ERROR: no Java-capable IntelliJ IDE found; set SEMANTIC_IDE_HOME / IDEA_HOME" >&2
  exit 1
fi
export SEMANTIC_IDE_HOME="$IDEA_DIR"

# 编译 JDK（fork javac）；缺失时 build.gradle.kts 回退当前 Gradle JVM
RESOLVED_JDK="$(semantic_resolve_jdk_home --require-javac)" || RESOLVED_JDK=""
if [ -n "$RESOLVED_JDK" ]; then export SEMANTIC_JDK_HOME="$RESOLVED_JDK"; fi

# Gradle 运行 JVM：必须 ≤21（Gradle 8.5 限制）；候选含 IDE/Android Studio 自带 JBR
GRADLE_JAVA_HOME="${GRADLE_JAVA_HOME:-}"
if [ -z "$GRADLE_JAVA_HOME" ]; then
  while IFS= read -r candidate; do
    major="$(semantic_java_major "$candidate" 2>/dev/null || true)"
    if [ -n "$major" ] && [ "$major" -ge 8 ] && [ "$major" -le 21 ]; then
      GRADLE_JAVA_HOME="$candidate"
      break
    fi
  done < <(semantic_jdk_candidates; semantic_ide_jbr_candidates)
fi
if [ -z "$GRADLE_JAVA_HOME" ]; then
  echo "ERROR: no Java 8-21 found to run Gradle 8.5; set GRADLE_JAVA_HOME" >&2
  exit 1
fi
echo "[gradle-build] ide=$IDEA_DIR gradle-java=$GRADLE_JAVA_HOME" >&2

PROJECT_DIR="$ROOT"
GRADLE_HOME_DIR="$ROOT/.gradle-home"
if command -v cygpath >/dev/null 2>&1; then
  GRADLE_JAVA_HOME="$(cygpath -w "$GRADLE_JAVA_HOME")"
  PROJECT_DIR="$(cygpath -m "$PROJECT_DIR")"
  GRADLE_HOME_DIR="$(cygpath -m "$GRADLE_HOME_DIR")"
fi
export JAVA_HOME="$GRADLE_JAVA_HOME"

GRADLE_BIN="${GRADLE_BIN:-}"
if [ -z "$GRADLE_BIN" ]; then GRADLE_BIN="$(command -v gradle || true)"; fi
if [ -z "$GRADLE_BIN" ]; then
  GRADLE_BIN="$(find "$HOME/.gradle/wrapper/dists" -maxdepth 5 -type f \( -name gradle.bat -o -name gradle \) -path '*/bin/*' 2>/dev/null | sort -r | sed -n '1p' || true)"
fi
if [ -z "$GRADLE_BIN" ]; then
  echo "ERROR: gradle not found; set GRADLE_BIN to a gradle/gradle.bat" >&2
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
