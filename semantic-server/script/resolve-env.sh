#!/usr/bin/env bash
# 共享环境解析（由 build-local.sh / run-local.sh / gradle-build.sh source）：
#   semantic_resolve_idea_dir [--require-java]   IDE 安装目录（环境变量覆盖 > 本机发现）
#   semantic_resolve_jdk_home [--require-javac]  JDK home（SEMANTIC_JDK_HOME > JAVA_HOME > 常见目录）
#   semantic_jdk_candidates                      JDK 候选列表（含通用安装位置）
#   semantic_ide_jbr_candidates                  IDE/Android Studio 自带 JBR 候选（Gradle JVM 回退用）
# 发现只回答"装在哪"，不读取授权状态；所有位置均为通用路径（C:\Program Files\Java\* 等），不含个人目录。
# 环境变量优先级与 Launcher 一致：SEMANTIC_IDE_HOME > IDEA_HOME > IDEA_DIR。

semantic_env_idea_dir() {
  local candidate
  for candidate in "${SEMANTIC_IDE_HOME:-}" "${IDEA_HOME:-}" "${IDEA_DIR:-}"; do
    if [ -n "$candidate" ] && [ -d "$candidate/lib" ] && [ -f "$candidate/product-info.json" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

semantic_product_rank() {
  case "$1" in
    IU) echo 0 ;; IC) echo 1 ;; PY) echo 2 ;; PC) echo 3 ;; WS) echo 4 ;;
    CL) echo 5 ;; GO) echo 6 ;; PS) echo 7 ;; DG) echo 8 ;; RD) echo 9 ;; RM) echo 10 ;;
    *) echo 99 ;;
  esac
}

# Windows 卸载表（HKLM + HKCU Uninstall）：DisplayName 匹配产品族 → InstallLocation
semantic_registry_idea_dirs() {
  command -v reg >/dev/null 2>&1 || return 0
  local hive line display="" install=""
  for hive in 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' 'HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; do
    MSYS_NO_PATHCONV=1 reg query "$hive" /s 2>/dev/null | while IFS= read -r line; do
      line="${line%$'\r'}" # reg 输出为 CRLF
      case "$line" in
        HKEY_*) display=""; install="" ;;
        *DisplayName*REG_SZ*) display="${line#*REG_SZ}" ;;
        *InstallLocation*REG_SZ*) install="${line#*REG_SZ}" ;;
      esac
      if [ -n "$display" ] && [ -n "$install" ]; then
        display="${display#"${display%%[![:space:]]*}"}"
        install="${install#"${install%%[![:space:]]*}"}"
        case "$display" in
          "IntelliJ IDEA"*|"PyCharm"*|"WebStorm"*|"CLion"*|"GoLand"*|"DataGrip"*|"PhpStorm"*|"RubyMine"*|"Rider"*|"JetBrains Rider"*|"Android Studio"*)
            if [ -d "$install/lib" ] && [ -f "$install/product-info.json" ]; then
              printf '%s\n' "$install"
            fi
            ;;
        esac
        display=""; install=""
      fi
    done
  done
}

# Toolbox apps/*/*/* 与常见安装目录（JetBrains Toolbox 布局 / macOS .app）
semantic_toolbox_and_common_idea_dirs() {
  local dirs=() dir entry
  if [ -n "${LOCALAPPDATA:-}" ]; then
    dirs+=("$LOCALAPPDATA/JetBrains/Toolbox/apps" "$LOCALAPPDATA/Programs/JetBrains")
  fi
  if [ -n "${ProgramFiles:-}" ]; then dirs+=("$ProgramFiles/JetBrains"); fi
  if [ -n "${ProgramW6432:-}" ]; then dirs+=("$ProgramW6432/JetBrains"); fi
  dirs+=("$HOME/.local/share/JetBrains/Toolbox/apps" "/Applications")
  for dir in "${dirs[@]}"; do
    [ -d "$dir" ] || continue
    for entry in "$dir"/* "$dir"/*/* "$dir"/*/*/*; do
      [ -d "$entry" ] || continue
      if [ -f "$entry/product-info.json" ] && [ -d "$entry/lib" ]; then
        printf '%s\n' "$entry"
      elif [ -f "$entry/Contents/product-info.json" ] && [ -d "$entry/Contents/lib" ]; then
        printf '%s\n' "$entry/Contents"
      fi
    done
  done
}

# Android Studio 安装目录（Gradle 自带 JBR 的通用回退源；注册表 DisplayIcon 反推）
semantic_android_studio_dirs() {
  if [ -n "${ProgramFiles:-}" ] && [ -d "$ProgramFiles/Android Studio" ]; then
    printf '%s\n' "$ProgramFiles/Android Studio"
  fi
  if [ -n "${ProgramW6432:-}" ] && [ -d "$ProgramW6432/Android Studio" ]; then
    printf '%s\n' "$ProgramW6432/Android Studio"
  fi
  if [ -d "/Applications/Android Studio.app/Contents" ]; then
    printf '%s\n' "/Applications/Android Studio.app/Contents"
  fi
  command -v reg >/dev/null 2>&1 || return 0
  local icon
  icon="$(MSYS_NO_PATHCONV=1 reg query 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Android Studio' /v DisplayIcon 2>/dev/null | sed -n 's/.*REG_SZ[[:space:]]*//p' | sed 's/[\\/]bin[\\/]studio\.exe$//' || true)"
  if [ -n "$icon" ] && [ -d "$icon" ]; then printf '%s\n' "$icon"; fi
}

# 解析 IDE 安装目录；--require-java 时要求发行版带 plugins/java（编译需要）
semantic_resolve_idea_dir() {
  local require_java=0
  if [ "${1:-}" = "--require-java" ]; then require_java=1; fi
  if semantic_env_idea_dir; then return 0; fi
  local candidate code resolved
  resolved="$(
    {
      semantic_registry_idea_dirs
      semantic_toolbox_and_common_idea_dirs
    } | while IFS= read -r candidate; do
      [ -f "$candidate/product-info.json" ] || continue
      if [ "$require_java" = "1" ] && [ ! -d "$candidate/plugins/java" ]; then continue; fi
      code="$(sed -n 's/.*"productCode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$candidate/product-info.json" 2>/dev/null | sed -n '1p' || true)"
      printf '%s %s\n' "$(semantic_product_rank "$code")" "$candidate"
    done | sort -n -k1,1 | sed -n '1s/^[0-9]\{1,\} //p'
  )"
  if [ -z "$resolved" ]; then return 1; fi
  printf '%s\n' "$resolved"
}

# JDK 候选：SEMANTIC_JDK_HOME > JAVA_HOME > 通用安装目录（新版本优先）
semantic_jdk_candidates() {
  local candidate home
  for candidate in "${SEMANTIC_JDK_HOME:-}" "${JAVA_HOME:-}"; do
    if [ -n "$candidate" ]; then printf '%s\n' "$candidate"; fi
  done
  local bases=()
  if [ -n "${ProgramFiles:-}" ]; then
    bases+=("$ProgramFiles/Java" "$ProgramFiles/Eclipse Adoptium" "$ProgramFiles/Microsoft")
  fi
  if [ -n "${ProgramW6432:-}" ]; then bases+=("$ProgramW6432/Java" "$ProgramW6432/Eclipse Adoptium"); fi
  if [ -n "${LOCALAPPDATA:-}" ]; then bases+=("$LOCALAPPDATA/Programs/Eclipse Adoptium"); fi
  bases+=("$HOME/.jdks" "/usr/lib/jvm")
  for home in "${bases[@]}"; do
    [ -d "$home" ] || continue
    while IFS= read -r candidate; do
      if [ -d "$candidate" ]; then printf '%s\n' "$candidate"; fi
    done < <(find "$home" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -r)
  done
  while IFS= read -r candidate; do
    if [ -d "$candidate" ]; then printf '%s\n' "$candidate"; fi
  done < <(find "/Library/Java/JavaVirtualMachines" -mindepth 3 -maxdepth 3 -type d -name Home 2>/dev/null | sort -r)
}

semantic_resolve_jdk_home() {
  local require_javac=0
  if [ "${1:-}" = "--require-javac" ]; then require_javac=1; fi
  local candidate
  while IFS= read -r candidate; do
    if [ ! -x "$candidate/bin/java.exe" ] && [ ! -x "$candidate/bin/java" ]; then continue; fi
    if [ ! -f "$candidate/release" ]; then continue; fi
    if [ "$require_javac" = "1" ] && [ ! -x "$candidate/bin/javac.exe" ] && [ ! -x "$candidate/bin/javac" ]; then continue; fi
    printf '%s\n' "$candidate"
    return 0
  done < <(semantic_jdk_candidates)
  return 1
}

# IDE / Android Studio 自带 JBR（供 Gradle 运行 JVM 回退；版本是否适用由调用方判断）
semantic_ide_jbr_candidates() {
  local dir
  {
    semantic_registry_idea_dirs
    semantic_toolbox_and_common_idea_dirs
    semantic_android_studio_dirs
  } | while IFS= read -r dir; do
    if [ -x "$dir/jbr/bin/java.exe" ] || [ -x "$dir/jbr/bin/java" ]; then printf '%s\n' "$dir/jbr"; fi
  done
}
