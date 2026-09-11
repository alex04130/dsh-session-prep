#!/usr/bin/env bash
# 一键整理会话记录（拷贝 + 改写），不碰正在用的 ~/.dsh。
# 重启升级前跑一次；看 $OUT/会话清单.md 和 $OUT/重启升级.md。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
OUT="${1:-$HOME_DIR/tmp-session-prep}"
NODE="${NODE:-node}"

echo "源: $HOME_DIR"
echo "出: $OUT"
echo "不会写源目录。"
exec "$NODE" "$ROOT/bin/dsh-session-prep.mjs" prepare --home "$HOME_DIR" --out "$OUT" --fresh
