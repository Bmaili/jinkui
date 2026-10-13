#!/usr/bin/env bash
# 没有安卓 SDK 时的编译检查：用桩类（stubs/）编译本工程全部原生代码，能发现语法、类型、方法名的错误。
# 桩类只模拟了用到的接口，最终以 GitHub Actions 的真实打包为准。
# 用法：bash e2e/native/compile.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
if javac -nowarn -encoding UTF-8 -Xlint:none -d "$OUT" $(find "$HERE/stubs" -name '*.java') $(find "$ROOT/android/app/src/main/java" -name '*.java') 2> "$OUT/err.txt"; then
  echo "原生代码编译通过"
else
  grep -v -E 'JAVA_TOOL|^Note:' "$OUT/err.txt"
  exit 1
fi
