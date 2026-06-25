/**
 * 飞书长连接 Bot 服务器
 * 使用飞书官方 SDK 的 WSClient + OpenCode SDK
 * 支持多小说目录：主编 dispatch 时通过 NOVEL_DIR:路径 传入小说目录
 */
import * as lark from "@larksuiteoapi/node-sdk";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { config, TRIGGER_KEYWORDS } from "./config.js";
import {
  extractTextFromContent, buildReplyWithMention, sendReplyWithMention,
  fetchChatHistory, formatChatHistory,
} from "../../../shared/dist/dispatch.js";
import {
  extractTaskId, queryTask, queryTaskChain, initTaskStore,
} from "../../../shared/dist/task-store.js";
import { patchConsoleTimestamp } from "../../../shared/dist/index.js";

const SESSION_TIMEOUT = 10 * 60 * 1000;
const DEFAULT_NOVEL_DIR = process.env.NOVEL_DIR || "/tmp/novels/default";

interface Session {
  id: string;
  client: any;
  lastAccess: number;
  novelDir: string;
}

const sessions = new Map<string, Session>();
const processedEvents = new Set<string>();

const client = new lark.Client({
  appId: config.appId,
  appSecret: config.appSecret,
});

const OPENCODE_API = process.env.OPENCODE_API || "http://localhost:8080";
let opencodeClient: ReturnType<typeof createOpencodeClient> | null = null;
let myOpenId: string = "";

// ============ 从消息中提取小说目录 ============

function extractNovelDir(text: string): { novelDir: string; cleanedText: string } {
  const match = text.match(/^NOVEL_DIR:(\S+)\s*/);
  if (match) {
    const novelDir = match[1];
    const cleanedText = text.substring(match[0].length);
    console.log(`📂 检测到小说目录: ${novelDir}`);
    return { novelDir, cleanedText };
  }
  return { novelDir: DEFAULT_NOVEL_DIR, cleanedText: text };
}

// ============ Session 管理 ============

async function getOrCreateSession(chatId: string, novelDir: string): Promise<Session> {
  const now = Date.now();
  const existing = sessions.get(chatId);
  if (existing && now - existing.lastAccess < SESSION_TIMEOUT) {
    if (existing.novelDir !== novelDir) {
      existing.novelDir = novelDir;
    }
    existing.lastAccess = now;
    return existing;
  }
  const result = await opencodeClient!.session.create({
    body: { title: `${config.name} - ${chatId}` },
  });
  if (result.error) throw new Error(JSON.stringify(result.error));
  const session: Session = {
    id: result.data.id,
    client: opencodeClient!,
    lastAccess: now,
    novelDir,
  };
  sessions.set(chatId, session);
  return session;
}

// ============ OpenCode 调用 ============

async function sendToOpencode(session: Session, message: string, retries = 2): Promise<string> {
  const [providerID, modelID] = (config.model || "").split("/");
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const requestBody: any = {
        parts: [{ type: "text", text: message }],
        system: config.systemPrompt,
        ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
        ...(config.tools ? { tools: config.tools } : {}),
        env: { NOVEL_DIR: session.novelDir },
      };
      console.log(`📤 [OpenCode] session=${session.id} novelDir=${session.novelDir} tools=${JSON.stringify(config.tools || {})} prompt=${message.substring(0, 150)}${message.length > 150 ? '...' : ''}`);

      const result = await session.client.session.prompt({
        path: { id: session.id },
        body: requestBody,
      });

      if (result.error) throw new Error(JSON.stringify(result.error));

      const data = result.data as any;
      const textParts = (data.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text) || [];
      const toolParts = (data.parts || []).filter((p: any) => p.type === "tool-invocation") || [];
      console.log(`📥 [OpenCode 响应] textParts=${textParts.length} toolParts=${toolParts.length}`);

      return (
        textParts.join("\n") ||
        data.info?.content ||
        "我收到了消息但没有回复。"
      );
    } catch (error: any) {
      const isTimeout =
        error?.cause?.code === "UND_ERR_HEADERS_TIMEOUT" ||
        error?.message?.includes("Timeout") ||
        error?.cause?.message?.includes("Timeout");
      if (isTimeout && attempt < retries) {
        console.log(`⏳ OpenCode 请求超时，重试 ${attempt + 1}/${retries}...`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw error;
    }
  }
  throw new Error("OpenCode 请求重试耗尽");
}

// ============ 主循环 ============

async function main() {
  patchConsoleTimestamp();
  console.log(`📚 ${config.name} Bot 启动中...`);
  if (!config.appId || !config.appSecret) {
    console.error(`❌ 请设置环境变量`);
    process.exit(1);
  }
  initTaskStore();
  console.log(`🔧 连接 OpenCode: ${OPENCODE_API}`);
  opencodeClient = createOpencodeClient({ baseUrl: OPENCODE_API });
  console.log("✅ OpenCode 已就绪");

  try {
    const tokenResp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    });
    const tokenData = await tokenResp.json() as any;
    if (tokenData.tenant_access_token) {
      const botResp = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
        headers: { "Authorization": `Bearer ${tokenData.tenant_access_token}` },
      });
      const botData = await botResp.json() as any;
      if (botData.bot?.open_id) {
        myOpenId = botData.bot.open_id;
        console.log(`📋 当前 Bot open_id: ${myOpenId}`);
      }
    }
  } catch (e) {
    console.warn("⚠️ 获取 Bot open_id 失败", e);
  }

  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: lark.LoggerLevel.debug,
  });

  wsClient.start({
    eventDispatcher: new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        const eventId = data.event_id;
        const msgId = data.message.message_id;
        const dedupKey = eventId || msgId;
        if (processedEvents.has(dedupKey)) {
          console.log(`⏭️ 重复事件，跳过: ${dedupKey}`);
          return;
        }
        processedEvents.add(dedupKey);
        setTimeout(() => processedEvents.delete(dedupKey), 5 * 60 * 1000);

        const message = data.message;
        const msgTime = parseInt(message.create_time || "0");
        if (Date.now() - msgTime > 10 * 60 * 1000) {
          console.log(`⏭️ 过期消息，跳过`);
          return;
        }

        const senderOpenId = (data.sender as any)?.sender_id?.open_id || "";
        const chatId = message.chat_id;
        const messageId = message.message_id;
        const chatType = message.chat_type;
        const msgType = message.msg_type || "text";
        const text = extractTextFromContent(message.content, msgType);

        const isMentioned = myOpenId
          ? message.mentions?.some((m: any) => m.id?.open_id === myOpenId) ?? false
          : message.mentions?.some((m: any) => m.mentioned_type === "bot") ?? false;
        const shouldRespond = chatType === "p2p" || isMentioned || TRIGGER_KEYWORDS.some(kw => text.includes(kw));
        if (!shouldRespond) return;

        console.log(`📨 收到消息 (${chatType}): ${text.substring(0, 100)}...`);

        try {
          // 提取小说目录
          const { novelDir, cleanedText } = extractNovelDir(text);
          let prompt = cleanedText;

          // 通过任务 ID 查询上游数据
          const taskId = extractTaskId(cleanedText);
          if (taskId) {
            const chain = queryTaskChain(taskId);
            const upstreamParts: string[] = [];
            for (const record of chain) {
              if (record.status === "completed" && record.result) {
                upstreamParts.push(`### 上游任务 [${record.taskId}] ${record.fromBot} -> ${record.toBot}\n任务：${record.task}\n结果：\n${record.result}`);
              }
            }
            if (upstreamParts.length > 0) {
              prompt = `以下是与本任务相关的上游数据：\n\n${upstreamParts.join("\n\n---\n\n")}\n\n---\n\n当前任务：${cleanedText}`;
            }
          }

          // 群聊历史上下文
          if (chatType === "group" || chatType === "p2p") {
            const history = await fetchChatHistory(client, chatId, 5);
            const historyStr = formatChatHistory(history, config.name);
            if (historyStr) {
              prompt = `${historyStr}\n\n---\n\n${prompt}`;
            }
          }

          const session = await getOrCreateSession(chatId, novelDir);
          const response = await sendToOpencode(session, prompt);

          // 回复时携带任务 ID
          let finalResponse = response;
          if (taskId) {
            finalResponse = `【任务ID:${taskId}】${response}`;
          }
          const { content: replyContent, msgType: replyMsgType, needMention } = buildReplyWithMention(
            message.mentions as any, myOpenId, config.name, finalResponse,
          );
          if (needMention) {
            await sendReplyWithMention(client, chatId, replyContent, replyMsgType);
          } else {
            await client.im.message.reply({
              path: { message_id: messageId },
              data: {
                msg_type: "text",
                content: JSON.stringify({ text: finalResponse }),
              },
            });
          }
          console.log("✅ 已回复消息");
        } catch (error) {
          console.error("❌ 处理消息失败:", error);
          await client.im.message.reply({
            path: { message_id: messageId },
            data: {
              msg_type: "text",
              content: JSON.stringify({ text: `抱歉，处理你的消息时遇到了问题` }),
            },
          });
        }
      },
    }),
  });

  console.log(`✅ ${config.name} 启动成功，等待消息...`);
}

main().catch(console.error);
