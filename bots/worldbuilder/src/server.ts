/**
 * Bot 启动入口
 */
import express from "express";
import crypto from "crypto";
import { getTenantAccessToken, replyMessage } from "../shared/src/index.js";
import { config, TRIGGER_KEYWORDS } from "./config.js";

const OPENCODE_API = process.env.OPENCODE_API || "http://localhost:8080";
const SESSION_TIMEOUT = 30 * 60 * 1000;

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

  const result = data.data;
  return (
    result.info?.content ||
    result.parts
      ?.filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n") ||
    "我收到了消息但没有回复。"
  );
}

async function main() {
  console.log(`📚 ${config.name} Bot 启动中...`);

  if (!config.appId || !config.appSecret) {
    console.error(`❌ 请设置 ${config.name.toUpperCase().replace(" ", "_")}_APP_ID 和 ${config.name.toUpperCase().replace(" ", "_")}_APP_SECRET 环境变量`);
    process.exit(1);
  }

  const accessToken = await getTenantAccessToken(config.appId, config.appSecret);
  console.log("✅ 已获取 access token");

  const app = express();
  app.use(express.json());

  app.post("/webhook", async (req, res) => {
    const body = req.body;

    const timestamp = req.headers["x-lark-timestamp"] as string;
    const signature = req.headers["x-lark-signature"] as string;

    if (timestamp && signature) {
      const isValid = verifySignature(body, timestamp, signature, config.appSecret);
      if (!isValid) {
        console.error("❌ 签名验证失败");
        return res.status(401).send("Unauthorized");
      }
    }

    if (body.event && body.event.message) {
      const message = body.event.message;
      const chatId = message.chat_id;
      const messageId = message.message_id;
      const content = JSON.parse(message.content);
      const text = content.text || "";

      const shouldRespond = TRIGGER_KEYWORDS.some(keyword => text.includes(keyword));

      if (shouldRespond) {
        console.log(`📨 收到消息: ${text}`);

        try {
          const sessionId = await getOrCreateSession(chatId);
          const sessionEntry = sessions.get(`${chatId}-default`);
          if (sessionEntry) sessionEntry.lastAccess = Date.now();

          const response = await sendToOpencode(sessionId, text);
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

  app.get("/health", (_, res) => {
    res.json({ status: "ok", bot: config.name });
  });

  app.post("/session/clear", (req, res) => {
    const { chatId, userId } = req.body;
    sessions.delete(`${chatId}-${userId || "default"}`);
    res.json({ success: true });
  });

  const port = parseInt(process.env.PORT || "3001");
  app.listen(port, () => {
    console.log(`🚀 ${config.name} Bot 运行在 http://localhost:${port}`);
  });
}

function verifySignature(body: any, timestamp: string, signature: string, secret: string): boolean {
  const str = timestamp + JSON.stringify(body) + secret;
  const hash = crypto.createHash("sha256").update(str).digest("hex");
  return hash === signature;
}

main().catch(console.error);