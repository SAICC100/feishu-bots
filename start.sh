#!/bin/bash
# 启动所有小说创作 Bot

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🦞 小说创作团队启动中..."

# 先杀掉所有旧的 bot 进程
pkill -f "opencode-feishu-bots/bots" 2>/dev/null && sleep 1

# 读取 .env 文件
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# 设置 PATH
export PATH="/Users/saicc/.local/bin:$PATH"
# 增加 Node.js undici 的 header 超时（默认 300s，MCP fetch 可能更慢）
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=512"
export UV_THREADPOOL_SIZE=128

# 直接启动每个 Bot
launch_bot() {
  local bot=$1
  local name=$2
  local prefix=$3
  local port=$4

  echo "启动 $name (端口 $port)..."
  cd "$SCRIPT_DIR/bots/$bot"
  PORT=$port nohup ./node_modules/.bin/tsx src/server-ws.ts > "$SCRIPT_DIR/logs/$bot.log" 2>&1 &
}

launch_bot editor "主编" EDITOR 3001
launch_bot researcher "资料员" RESEARCHER 3002
launch_bot analyst "分析师" ANALYST 3003
launch_bot writer "主笔" WRITER 3004
launch_bot jokester "段子手" JOKESTER 3005
launch_bot proofreader "校对" PROOFREADER 3006
launch_bot worldbuilder "设定师" WORLDBUILDER 3007

sleep 10

echo ""
echo "✅ 所有 Bot 已启动！"
echo ""
echo "各 Bot 日志位置："
for bot in editor researcher analyst writer jokester proofreader worldbuilder; do
  echo "  - $bot: $SCRIPT_DIR/logs/$bot.log"
done
echo ""
echo "查看日志: tail -f logs/<bot>.log"

ps aux | grep "server-ws" | grep -v grep | wc -l