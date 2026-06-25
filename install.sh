#!/bin/bash
# 一键安装所有依赖

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "📦 安装依赖中..."

# 安装 shared
echo "安装 shared..."
cd shared && npm install && cd ..

# 安装各 Bot
for bot in bots/*/; do
  bot_name=$(basename "$bot")
  if [ "$bot_name" != "template" ]; then
    echo "安装 $bot_name..."
    cd "$bot" && npm install && cd ../..
  fi
done

echo ""
echo "✅ 依赖安装完成！"