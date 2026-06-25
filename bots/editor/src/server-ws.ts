/**
 * 主编 Bot 服务器
 * 主编收到 @ 消息后，通过群聊 @ 调度团队成员
 * 支持多轮协作：主编观察团队成员回复，继续调度或综合结果
 * 使用 task-store 持久化任务数据，下游 Bot 通过任务 ID 获取上游产出
 */
import * as lark from "@larksuiteoapi/node-sdk";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { config, TRIGGER_KEYWORDS } from "./config.js";
import {
  BotRegistry,
  BOT_APPID_ENV_MAP,
  sendMentionMessage,
  parseDispatchTags,
  extractTextFromContent,
  fetchChatHistory,
  formatChatHistory,
  type DispatchInstruction,
} from "../../../shared/dist/dispatch.js";
import {
  initTaskStore,
  generateTaskId,
  storeTask,
  storeResult,
  queryTask,
  queryTaskChain,
  pruneOldTasks,
  extractTaskId,
} from "../../../shared/dist/task-store.js";
import { patchConsoleTimestamp } from "../../../shared/dist/index.js";

const SESSION_TIMEOUT = 10 * 60 * 1000;
const AGGREGATION_TIMEOUT = 10 * 60 * 1000;
const MAX_DISPATCH_ROUNDS = 20;

interface Session {
  id: string;
  lastAccess: number;
}

interface PendingDispatch {
  chatId: string;
  botOpenId: string;
  botName: string;
  task: string;
  taskId: string;
  dispatchedAt: number;
}

interface AggregationState {
  chatId: string;
  sessionId: string;
  messageId: string;
  expectedBotNames: string[];
  collectedReplies: { botName: string; text: string; taskId: string }[];
  timer: NodeJS.Timeout;
}

const sessions = new Map<string, Session>();
const processedEvents = new Set<string>();
const registry = new BotRegistry();
const pendingDispatches = new Map<string, PendingDispatch[]>();
const aggregationStates = new Map<string, AggregationState>();
const dispatchRounds = new Map<string, number>();

const client = new lark.Client({
  appId: config.appId,
  appSecret: config.appSecret,
});

const OPENCODE_API = process.env.OPENCODE_API || "http://localhost:8080";
let opencodeClient: ReturnType<typeof createOpencodeClient> | null = null;
let myOpenId: string = "";

async function getOrCreateSession(chatId: string): Promise<string> {
  const now = Date.now();
  let session = sessions.get(chatId);
  if (session && now - session.lastAccess < SESSION_TIMEOUT) {
    session.lastAccess = now;
    return session.id;
  }

  const result = await opencodeClient!.session.create({
    body: { title: `${config.name} - ${chatId}` },
  });

  if (result.error) throw new Error(JSON.stringify(result.error));
  sessions.set(chatId, { id: result.data.id, lastAccess: now });
  return result.data.id;
}

async function sendToOpencode(sessionId: string, message: string, retries = 2): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const requestBody = {
        parts: [{ type: "text", text: message }],
        system: config.systemPrompt,
        model: { providerID: "weibo-aigc", modelID: "gpt-4.1" },
        ...(config.tools ? { tools: config.tools } : {}),
      };
      console.log(`📤 [OpenCode 请求] sessionId=${sessionId} model=weibo-aigc/gpt-4.1 tools=${JSON.stringify(config.tools || {})} prompt=${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`);

      const result = await opencodeClient!.session.prompt({
        path: { id: sessionId },
        body: requestBody,
      });

      if (result.error) throw new Error(JSON.stringify(result.error));

      const data = result.data as any;
      const textParts = data.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text) || [];
      const toolParts = data.parts?.filter((p: any) => p.type === "tool-invocation") || [];
      console.log(`📥 [OpenCode 响应] textParts=${textParts.length} toolParts=${toolParts.length} content=${textParts.join("\n").substring(0, 200)}${textParts.join("\n").length > 200 ? '...' : ''}`);

      const text =
        textParts.join("\n") ||
        data.info?.content ||
        "我收到了消息但没有回复。";
      return text;
    } catch (error: any) {
      const isTimeout = error?.cause?.code === "UND_ERR_HEADERS_TIMEOUT" ||
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

async function replyToMessage(messageId: string, text: string): Promise<void> {
  await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

// ============ 调度执行 ============

async function executeDispatches(
  chatId: string,
  messageId: string,
  sessionId: string,
  instructions: DispatchInstruction[],
  parentTaskId: string | null = null
): Promise<void> {
  const expectedBotNames: string[] = [];

  for (const inst of instructions) {
    const openId = registry.getOpenId(inst.botName);
    if (openId) {
      // 始终自动生成 taskId，LLM 提供的 taskId 视为引用的上游任务 ID
      const taskId = generateTaskId();
      // 如果 LLM 引用了某个任务 ID 且没有显式 parentTaskId，用引用的 ID 作为 parent
      const effectiveParentId = parentTaskId || inst.taskId || null;

      storeTask({
        taskId,
        chatId,
        parentTaskId: effectiveParentId,
        fromBot: config.name,
        toBot: inst.botName,
        task: inst.task,
        timestamp: Date.now(),
      });

      const taskText = `【任务ID:${taskId}】${inst.task}`;
      console.log(`🔧 调度 ${inst.botName} [${taskId}]: ${inst.task}`);
      await sendMentionMessage(client, chatId, taskText, [{ name: inst.botName, openId }]);

      const list = pendingDispatches.get(chatId) || [];
      list.push({
        chatId,
        botOpenId: openId,
        botName: inst.botName,
        task: inst.task,
        taskId,
        dispatchedAt: Date.now(),
      });
      pendingDispatches.set(chatId, list);
      expectedBotNames.push(inst.botName);
    } else {
      console.warn(`⚠️ 未找到 ${inst.botName} 的 open_id，跳过调度`);
      await replyToMessage(messageId, `⚠️ 无法调度 ${inst.botName}：尚未获取到其 open_id。`);
    }
  }

  if (expectedBotNames.length > 0) {
    startAggregation(chatId, sessionId, messageId, expectedBotNames);
  }
}

// ============ 回复聚合 ============

function startAggregation(
  chatId: string,
  sessionId: string,
  messageId: string,
  expectedBotNames: string[]
): void {
  const existing = aggregationStates.get(chatId);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    console.log(`⏰ 聚合超时 (${chatId})，处理已收集的回复`);
    feedCollectedRepliesToSession(chatId);
  }, AGGREGATION_TIMEOUT);

  aggregationStates.set(chatId, {
    chatId,
    sessionId,
    messageId,
    expectedBotNames,
    collectedReplies: [],
    timer,
  });

  console.log(`⏳ 等待 ${expectedBotNames.join(", ")} 的回复 (超时 ${AGGREGATION_TIMEOUT / 1000}s)`);
}

async function feedCollectedRepliesToSession(chatId: string): Promise<void> {
  const state = aggregationStates.get(chatId);
  if (!state) return;
  aggregationStates.delete(chatId);
  clearTimeout(state.timer);

  const { collectedReplies, expectedBotNames, sessionId, messageId } = state;
  pendingDispatches.delete(chatId);

  if (collectedReplies.length === 0) {
    console.log(`📭 没有收到任何团队成员的回复`);
    await replyToMessage(messageId, "团队成员暂未回复，请稍后再试。");
    return;
  }

  // 存储所有回复结果到 task-store
  for (const reply of collectedReplies) {
    storeResult(reply.taskId, reply.text);
  }

  const repliedNames = new Set(collectedReplies.map((r) => r.botName));
  const timedOut = expectedBotNames.filter((n) => !repliedNames.has(n));

  let replySummary = collectedReplies
    .map((r) => `## ${r.botName} 的回复 [任务ID:${r.taskId}]\n${r.text}`)
    .join("\n\n---\n\n");

  if (timedOut.length > 0) {
    replySummary += `\n\n---\n\n⚠️ 以下成员未在规定时间内回复：${timedOut.join("、")}`;
  }

  const prompt = `团队成员已回复，以下是收集到的结果：\n\n${replySummary}\n\n请根据以上回复，决定下一步行动：综合结果回复用户、继续调度其他成员、或者结束协作。如果需要继续调度其他成员并让它读取上游数据，请使用格式 [DISPATCH:成员名:任务ID]任务描述[/DISPATCH] 引用相关任务ID。`;

  const rounds = (dispatchRounds.get(chatId) || 0) + 1;
  if (rounds > MAX_DISPATCH_ROUNDS) {
    console.log(`🛑 协作轮次已达上限 (${rounds})，强制综合回复`);
    dispatchRounds.delete(chatId);
    const forcePrompt = `团队成员已回复，以下是收集到的结果：\n\n${replySummary}\n\n协作轮次已达上限，请直接综合现有结果回复用户，不要再调度。`;
    try {
      sessions.get(chatId)!.lastAccess = Date.now();
      const response = await sendToOpencode(sessionId, forcePrompt);
      const { displayText } = parseDispatchTags(response);
      if (displayText) {
        await replyToMessage(messageId, displayText);
      }
    } catch (error) {
      console.error("❌ 强制综合回复失败:", error);
    }
    return;
  }
  dispatchRounds.set(chatId, rounds);

  console.log(`📥 收到 ${collectedReplies.length}/${expectedBotNames.length} 回复，送入 LLM (第 ${rounds} 轮)`);

  try {
    sessions.get(chatId)!.lastAccess = Date.now();
    const response = await sendToOpencode(sessionId, prompt);
    const { displayText, instructions } = parseDispatchTags(response);

    if (displayText) {
      await replyToMessage(messageId, displayText);
    }

    if (instructions.length > 0) {
      // 使用第一个回复的任务 ID 作为后续调度的 parentTaskId
      const parentTaskId = collectedReplies[0]?.taskId || null;
      await executeDispatches(chatId, messageId, sessionId, instructions, parentTaskId);
    } else {
      dispatchRounds.delete(chatId);
    }

    console.log("✅ 多轮协作处理完成");
  } catch (error) {
    console.error("❌ 处理团队回复失败:", error);
    await replyToMessage(messageId, `抱歉，处理团队回复时遇到了问题`);
  }
}

/**
 * 通过消息中的 mentions 识别发送者是否为团队成员
 */
function identifyBotFromMentions(
  mentions: any[] | undefined,
): string | undefined {
  if (!mentions) return undefined;
  for (const m of mentions) {
    if (m.mentioned_type === "bot" && m.name) {
      const botName = registry.getBotNameByMentionName(m.name);
      if (botName && botName !== config.name) return botName;
    }
  }
  return undefined;
}

// ============ 主逻辑 ============

async function main() {
  patchConsoleTimestamp();
  console.log(`📚 ${config.name} Bot 启动中...`);

  if (!config.appId || !config.appSecret) {
    console.error("❌ 请设置环境变量");
    process.exit(1);
  }

  registry.loadFromEnv();

  // 初始化任务存储
  initTaskStore();
  pruneOldTasks();

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
    console.warn("⚠️ 获取 Bot open_id 失败，将仅依赖关键词触发", e);
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
          console.log(`⏭️ 重复事件，跳过: eventId=${eventId}, msgId=${msgId}`);
          return;
        }
        const senderType = data.sender?.sender_type || "";
        const senderOpenId = (data.sender?.sender_id as any)?.open_id || "";
        const senderAppId = (data.sender?.sender_id as any)?.app_id || (data.header as any)?.app_id || "";
        console.log(`🔍 事件: eventId=${eventId}, msgId=${msgId}, sender=${senderType}/${senderOpenId}, appId=${senderAppId}`);
        processedEvents.add(dedupKey);
        setTimeout(() => processedEvents.delete(dedupKey), 5 * 60 * 1000);

        const message = data.message;

        if (senderType === "bot" || senderType === "app") {
          console.log(`🔍 Bot sender detail: ${JSON.stringify(data.sender)}`);
          console.log(`🔍 Mentions: ${JSON.stringify(message.mentions)}`);
        }
        const msgTime = parseInt(message.create_time || "0");
        if (Date.now() - msgTime > 10 * 60 * 1000) {
          console.log(`⏭️ 过期消息，跳过`);
          return;
        }

        // 忽略自己发出的消息
        if (senderOpenId === myOpenId) {
          return;
        }

        // 从 mentions 中学习 bot open_id
        registry.learnFromMentions(message.mentions as any);

        const chatId = message.chat_id;
        const messageId = message.message_id;
        const chatType = message.chat_type;
        const msgType = message.msg_type || "text";
        const contentStr = message.content;

        // 提取纯文本（支持纯文本和富文本消息）
        const text = extractTextFromContent(contentStr, msgType);

        // ---- 处理团队成员（Bot）回复 ----
        const isBotSender = senderType === "bot" || senderType === "app";

        if (isBotSender) {
          let botName = identifyBotFromMentions(message.mentions as any);

          if (!botName) {
            botName = registry.getBotNameByOpenId(senderOpenId);
            if (botName) {
              console.log(`🔍 通过 sender open_id 识别: ${senderOpenId} -> ${botName}`);
            }
          }

          if (!botName) {
            const pending = pendingDispatches.get(chatId) || [];
            if (senderAppId) {
              for (const [name, envVar] of Object.entries(BOT_APPID_ENV_MAP)) {
                const appId = process.env[envVar];
                if (appId && appId === senderAppId) {
                  botName = name;
                  console.log(`🔍 通过 sender app_id 识别: ${senderAppId} -> ${botName}`);
                  registry.learnSenderId(chatId, senderOpenId, botName);
                  break;
                }
              }
            }
            if (!botName && pending.length === 1) {
              botName = pending[0].botName;
              console.log(`🔍 通过 pending dispatch 推断: ${botName}`);
              registry.learnSenderId(chatId, senderOpenId, botName);
            }
          }

          // 第四层：通过回复中的任务 ID 反查 task-store 识别 bot
          if (!botName) {
            const taskId = extractTaskId(text);
            if (taskId) {
              const taskRecord = queryTask(taskId);
              if (taskRecord) {
                botName = taskRecord.toBot;
                console.log(`🔍 通过任务 ID 识别: ${taskId} -> ${botName}`);
                registry.learnSenderId(chatId, senderOpenId, botName);
              }
            }
          }

          console.log(`🤖 收到 Bot 消息: senderOpenId=${senderOpenId}, botName=${botName || "未知"}, text=${text.substring(0, 30)}...`);

          if (!botName) {
            console.log(`🤖 非团队成员 Bot，忽略`);
            return;
          }

          // 查找匹配的 pending dispatch
          const pending = pendingDispatches.get(chatId) || [];
          let matchedDispatch = pending.find((p) => p.botName === botName);

          // 如果没有 pending dispatch（可能是聚合超时后被清除了），从任务 ID 查找
          if (!matchedDispatch) {
            const taskId = extractTaskId(text);
            if (taskId) {
              const taskRecord = queryTask(taskId);
              if (taskRecord && taskRecord.toBot === botName) {
                matchedDispatch = {
                  chatId,
                  botOpenId: senderOpenId,
                  botName,
                  task: taskRecord.task,
                  taskId,
                  dispatchedAt: taskRecord.timestamp,
                };
                console.log(`🔍 聚合已超时，通过任务 ID 重建 dispatch: ${taskId} -> ${botName}`);
              }
            }
          }

          if (!matchedDispatch) {
            console.log(`🤖 无 pending dispatch，忽略 (chatId=${chatId}, pending=${pending.map(p => p.botName).join(",")})`);
            return;
          }

          console.log(`📨 收到 ${botName} 的回复 [${matchedDispatch.taskId}]: ${text.substring(0, 50)}...`);

          // 存储结果到 task-store
          storeResult(matchedDispatch.taskId, text);

          const state = aggregationStates.get(chatId);
          if (state) {
            state.collectedReplies.push({ botName, text, taskId: matchedDispatch.taskId });

            const allReceived = state.expectedBotNames.every((name) =>
              state.collectedReplies.some((r) => r.botName === name)
            );

            if (allReceived) {
              console.log(`✅ 所有团队成员已回复，立即处理`);
              feedCollectedRepliesToSession(chatId);
            }
          } else {
            // 聚合已超时，迟到的回复——直接送入 LLM session 处理
            console.log(`⏰ 聚合已超时，处理迟到的回复: ${botName} [${matchedDispatch.taskId}]`);
            try {
              const sessionId = await getOrCreateSession(chatId);
              sessions.get(chatId)!.lastAccess = Date.now();
              const latePrompt = `团队成员 ${botName} 迟到回复了（之前超时未回），以下是回复内容：\n\n## ${botName} 的回复 [任务ID:${matchedDispatch.taskId}]\n${text}\n\n请根据以上回复，决定下一步行动：综合结果回复用户、继续调度其他成员、或者结束协作。`;
              const response = await sendToOpencode(sessionId, latePrompt);
              const { displayText, instructions } = parseDispatchTags(response);
              if (displayText) {
                await replyToMessage(messageId, displayText);
              }
              if (instructions.length > 0) {
                await executeDispatches(chatId, messageId, sessionId, instructions, matchedDispatch.taskId);
              }
            } catch (error) {
              console.error("❌ 处理迟到回复失败:", error);
            }
          }
          return;
        }

        // ---- 处理人类用户消息 ----

        dispatchRounds.delete(chatId);

        const isMentioned = myOpenId
          ? message.mentions?.some((m: any) => m.id?.open_id === myOpenId) ?? false
          : message.mentions?.some((m: any) => m.mentioned_type === "bot") ?? false;

        const shouldRespond = chatType === "p2p" || isMentioned || TRIGGER_KEYWORDS.some((kw) => text.includes(kw));
        if (!shouldRespond) return;
        console.log(`📨 收到消息 (${chatType}): ${text}`);

        try {
          let prompt = text;
          if (chatType === "group" || chatType === "p2p") {
            const history = await fetchChatHistory(client, chatId, 5);
            const historyStr = formatChatHistory(history, config.name);
            if (historyStr) {
              prompt = `${historyStr}\n\n---\n\n当前消息：${text}`;
            }
          }

          const sessionId = await getOrCreateSession(chatId);
          sessions.get(chatId)!.lastAccess = Date.now();
          const response = await sendToOpencode(sessionId, prompt);

          const { displayText, instructions } = parseDispatchTags(response);

          if (displayText) {
            await replyToMessage(messageId, displayText);
          }

          if (instructions.length > 0) {
            await executeDispatches(chatId, messageId, sessionId, instructions);
          }

          console.log("✅ 处理完成");
        } catch (error) {
          console.error("❌ 处理消息失败:", error);
          await replyToMessage(messageId, `抱歉，处理消息时遇到了问题`);
        }
      },
    }),
  });

  console.log(`✅ ${config.name} 启动成功，等待消息...`);
}

main().catch(console.error);
