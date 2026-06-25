/**
 * 飞书小说创作 Bot 模板
 * 复制此文件到新目录，修改配置即可创建新 Bot
 */

import express from "express";
import crypto from "crypto";
import { BotConfig, getTenantAccessToken, replyMessage } from "../shared/src/index.js";

// ============ Bot 配置区 ============
// 👇 在这里修改 Bot 的配置

const config: BotConfig = {
  name: "主编",           // Bot 名字（用于日志）
  appId: process.env.APP_ID || "",
  appSecret: process.env.APP_SECRET || "",
  botName: "主编",        // Bot 在飞书群里显示的名字
  systemPrompt: `你是小说创作团队的主编，负责统筹整个创作流程。

## 你的职责
1. **任务分配**：根据用户需求，分配合适的工作给团队成员
2. **进度跟踪**：跟进各个环节的完成情况
3. **质量把控**：对最终作品进行审核和把关
4. **协调沟通**：确保团队协作顺畅

## 团队成员
- @资料员 - 负责收集素材和背景资料
- @分析师 - 负责分析素材和情节设计
- @主笔 - 负责主要写作任务
- @段子手 - 负责金句和对话创作
- @校对 - 负责错别字和语法检查
- @设定师 - 负责世界观和人物设定

## 工作方式
当用户给你一个写作任务时：
1. 分析任务需求
2. 制定创作计划
3. 依次调度团队成员完成各环节
4. 整合最终作品

## 沟通风格
- 专业、有条理
- 喜欢用 Markdown 格式化输出
- 会明确指出问题和改进建议
- 对作品质量有追求`,
  model: "weibo-aigc/gpt-4.1",  // 使用的模型
};

// 触发关键词（消息包含这些词时会响应）
const TRIGGER_KEYWORDS = ["主编", "大家", "所有人"];

// OpenCode API 地址
const OPENCODE_API = process.env.OPENCODE_API || "http://localhost:8080";

// Session 超时时间（毫秒）
const SESSION_TIMEOUT = 30 * 60 * 1000;

// ===================================

interface Session {
  id: string;
  lastAccess: number;
}

const sessions = new Map<string, Session>();

async function createSession(title: string): Promise<string> {
  const response = await fetch(`${OPENCODE_API}/api/session/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      system: config.systemPrompt,
      model: config.model,
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }

  return data.data.id;
}

async function getOrCreateSession(chatId: string, userId?: string): Promise<string> {
  const sessionKey = `${chatId}-${userId || "default"}`;
  const now = Date.now();

  let session = sessions.get(sessionKey);
  if (session && now - session.lastAccess < SESSION_TIMEOUT) {
    return session.id;
  }

  // 创建新 session
  const sessionId = await createSession(`${config.name} - ${sessionKey}`);
  sessions.set(sessionKey, { id: sessionId, lastAccess: now });
  return sessionId;
}

async function sendToOpencode(sessionId: string, message: string): Promise<string> {
  const response = await fetch(`${OPENCODE_API}/api/session/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      message,
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }

  // 提取文本回复
  const result = data.data;
  const responseText =
    result.info?.content ||
    result.parts
      ?.filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n") ||
    "我收到了消息但没有回复。";

  return responseText;
}

async function main() {
  console.log(`📚 ${config.name} Bot 启动中...`);

  if (!config.appId || !config.appSecret) {
    console.error("❌ 请设置 APP_ID 和 APP_SECRET 环境变量");
    process.exit(1);
  }

  // 获取 access token
  const accessToken = await getTenantAccessToken(config.appId, config.appSecret);
  console.log("✅ 已获取 access token");

  // 创建 Express 服务
  const app = express();
  app.use(express.json());

  // 飞书事件回调
  app.post("/webhook", async (req, res) => {
    const body = req.body;

    // 验证签名
    const timestamp = req.headers["x-lark-timestamp"] as string;
    const signature = req.headers["x-lark-signature"] as string;

    if (timestamp && signature) {
      const isValid = verifyFeishuSignature(body, timestamp, signature, config.appSecret);
      if (!isValid) {
        console.error("❌ 签名验证失败");
        return res.status(401).send("Unauthorized");
      }
    }

    // 处理消息事件
    if (body.event && body.event.message) {
      const message = body.event.message;
      const chatId = message.chat_id;
      const chatType = message.chat_type;
      const messageId = message.message_id;
      const content = JSON.parse(message.content);
      const text = content.text || "";

      // 判断是否被 @：飞书只推送 @ 了当前 Bot 的事件，mentions 中有 bot 类型即被 @
      const isMentioned = message.mentions?.some(
        (m: any) => m.mentioned_type === "bot"
      ) ?? false;

      // 私聊直接响应；群聊需要被 @ 或命中关键词
      const shouldRespond = chatType === "p2p" || isMentioned || TRIGGER_KEYWORDS.some(keyword => text.includes(keyword));

      if (shouldRespond) {
        console.log(`📨 收到消息: ${text}`);

        try {
          // 获取或创建 session
          const sessionId = await getOrCreateSession(chatId);
          sessions.get(`${chatId}-default`)!.lastAccess = Date.now();

          // 发送到 OpenCode
          const response = await sendToOpencode(sessionId, text);

          // 回复消息
          await replyMessage(accessToken, messageId, response);
          console.log("✅ 已回复消息");
        } catch (error) {
          console.error("❌ 处理消息失败:", error);
          await replyMessage(accessToken, messageId, `抱歉，处理你的消息时遇到了问题: ${error}`);
        }
      }
    }

    res.status(200).json({ code: 0, msg: "ok" });
  });

  // 健康检查
  app.get("/health", (_, res) => {
    res.json({ status: "ok", bot: config.name });
  });

  // Session 管理
  app.post("/session/clear", (req, res) => {
    const { chatId, userId } = req.body;
    const sessionKey = `${chatId}-${userId || "default"}`;
    sessions.delete(sessionKey);
    res.json({ success: true });
  });

  const port = parseInt(process.env.PORT || "3001");
  app.listen(port, () => {
    console.log(`🚀 ${config.name} Bot 运行在 http://localhost:${port}`);
  });
}

function verifyFeishuSignature(body: any, timestamp: string, signature: string, secret: string): boolean {
  const str = timestamp + JSON.stringify(body) + secret;
  const hash = crypto.createHash("sha256").update(str).digest("hex");
  return hash === signature;
}

main().catch(console.error);