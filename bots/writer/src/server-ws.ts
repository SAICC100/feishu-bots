/**
 * 飞书长连接 Bot 服务器
 * 使用飞书官方 SDK 的 WSClient + OpenCode SDK
 * 支持 [QUESTION:主编] 交互确认协议
 * 支持多小说目录：主编 dispatch 时通过 NOVEL_DIR:路径 传入小说目录
 */
import * as lark from "@larksuiteoapi/node-sdk";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { config, TRIGGER_KEYWORDS } from "./config.js";
import {
  extractTextFromContent, buildReplyWithMention, sendReplyWithMention,
  sendMentionMessage, fetchChatHistory, formatChatHistory,
  parseQuestionTags, extractAnswerId,
} from "../../../shared/dist/dispatch.js";
import {
  extractTaskId, queryTask, queryTaskChain, initTaskStore,
  generateQuestionId, storeQuestion, storeAnswer,
} from "../../../shared/dist/task-store.js";
import {
  loadBotState, saveBotState, formatStateSummary,
  recordTaskStart, recordTaskComplete, recordChapterCompleted,
  recordQuestionAsked, recordQuestionAnswered, recordOpenCodeSession,
  setCurrentStep, type BotState,
} from "../../../shared/dist/bot-state.js";
import { patchConsoleTimestamp } from "../../../shared/dist/index.js";

const SESSION_TIMEOUT = 10 * 60 * 1000;
const MAX_QUESTION_ROUNDS = 5;
const QUESTION_TIMEOUT = 30 * 60 * 1000;
// 默认小说目录（未指定时使用）
const DEFAULT_NOVEL_DIR = process.env.NOVEL_DIR || "/tmp/novels/default";

interface Session {
  id: string;
  client: any;
  lastAccess: number;
  novelDir: string;
}

interface QuestionState {
  questionId: string;
  taskId: string;
  chatId: string;
  messageId: string;
  session: Session;
  timer: NodeJS.Timeout;
  round: number;
}

const sessions = new Map<string, Session>();
const processedEvents = new Set<string>();
const questionStates = new Map<string, QuestionState>();

let editorOpenId: string = process.env.EDITOR_OPEN_ID || "";

const client = new lark.Client({
  appId: config.appId,
  appSecret: config.appSecret,
});

const OPENCODE_API = process.env.OPENCODE_API || "http://localhost:8080";
let opencodeClient: ReturnType<typeof createOpencodeClient> | null = null;
let myOpenId: string = "";

// ============ 从消息中提取小说目录 ============

/**
 * 从文本中提取 NOVEL_DIR:路径 格式的目录参数
 * 格式：NOVEL_DIR:/path/to/novel
 * 提取后从文本中去掉这个标记
 * 注意：可能在【任务ID:...】之后，所以不要求在开头
 */
function extractNovelDir(text: string): { novelDir: string; cleanedText: string } {
  const match = text.match(/NOVEL_DIR:(\S+)/);
  if (match) {
    const novelDir = match[1];
    const cleanedText = text.replace(/NOVEL_DIR:\S+\s*/, "");
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
    // 如果目录变了，更新 session 的 novelDir
    if (existing.novelDir !== novelDir) {
      console.log(`📂 Session ${chatId} 切换小说目录: ${existing.novelDir} -> ${novelDir}`);
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

async function sendToOpencode(session: Session, message: string, botState: BotState | null = null, retries = 2): Promise<string> {
  const [providerID, modelID] = (config.model || "").split("/");
  // 把 bot 状态摘要注入 system prompt，让模型知道当前进度
  const stateSummary = botState ? formatStateSummary(botState) : "";
  const fullSystemPrompt = stateSummary
    ? `${config.systemPrompt}\n\n${stateSummary}`
    : config.systemPrompt;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 注入 NOVEL_DIR 到 env，skill 内可作为 process.env.NOVEL_DIR 访问
      const requestBody: any = {
        parts: [{ type: "text", text: message }],
        system: fullSystemPrompt,
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

// ============ 提问协议处理 ============

function handleQuestionTimeout(questionId: string): void {
  const state = questionStates.get(questionId);
  if (!state) return;
  console.log(`⏰ 提问超时: ${questionId}，自动继续`);
  questionStates.delete(questionId);

  const continuePrompt = `主编暂未回复，请按默认方案继续执行。不要再提问，直接输出结果。`;
  const botState = loadBotState(config.name, state.session.novelDir, state.chatId);
  recordQuestionAnswered(botState, state.questionId);

  sendToOpencode(state.session, continuePrompt, botState)
    .then(async (response) => {
      const { questions } = parseQuestionTags(response);
      if (questions.length > 0 && state.round < MAX_QUESTION_ROUNDS) {
        await handleQuestions(response, state.taskId, state.chatId, state.messageId, state.session, state.round);
      } else {
        if (state.taskId) {
          recordTaskComplete(botState, state.taskId, "completed");
        }
        await sendFinalReply(state.chatId, state.messageId, state.taskId, response, undefined);
      }
    })
    .catch((err) => {
      console.error(`❌ 超时后继续执行失败:`, err);
    });
}

async function handleQuestions(
  response: string,
  taskId: string,
  chatId: string,
  messageId: string,
  session: Session,
  round: number,
): Promise<void> {
  const { displayText, questions } = parseQuestionTags(response);

  if (questions.length === 0) {
    await sendFinalReply(chatId, messageId, taskId, displayText, undefined);
    return;
  }

  if (round >= MAX_QUESTION_ROUNDS) {
    console.log(`⚠️ 已达最大提问轮次 (${MAX_QUESTION_ROUNDS})，自动继续`);
    const continuePrompt = `已达到最大提问次数，请按默认方案继续执行，不要再提问。`;
    const botState = loadBotState(config.name, session.novelDir, chatId);
    const continueResponse = await sendToOpencode(session, continuePrompt, botState);
    if (taskId) {
      recordTaskComplete(botState, taskId, "completed");
    }
    await sendFinalReply(chatId, messageId, taskId, continueResponse, undefined);
    return;
  }

  const q = questions[0];
  const questionId = generateQuestionId();

  console.log(`❓ 提问: target=${q.targetBot} id=${questionId} round=${round + 1}/${MAX_QUESTION_ROUNDS}`);
  console.log(`❓ 内容: ${q.content.substring(0, 200)}${q.content.length > 200 ? '...' : ''}`);

  if (taskId) {
    storeQuestion(taskId, questionId, q.content);
  }

  const timer = setTimeout(() => handleQuestionTimeout(questionId), QUESTION_TIMEOUT);
  questionStates.set(questionId, {
    questionId,
    taskId,
    chatId,
    messageId,
    session,
    timer,
    round: round + 1,
  });

  session.lastAccess = Date.now();

  const questionText = `【提问:${questionId}】${q.content}`;
  if (editorOpenId) {
    await sendMentionMessage(client, chatId, questionText, [
      { name: "主编", openId: editorOpenId },
    ]);
  } else {
    await sendMentionMessage(client, chatId, questionText, []);
  }

  console.log(`📤 已向主编发送提问: ${questionId}`);
}

async function handleAnswerReceived(questionId: string, answer: string): Promise<void> {
  const state = questionStates.get(questionId);
  if (!state) {
    console.warn(`⚠️ 未找到提问状态: ${questionId}`);
    return;
  }

  clearTimeout(state.timer);
  questionStates.delete(questionId);
  storeAnswer(questionId, answer);
  console.log(`📩 收到主编回答: ${questionId} round=${state.round}/${MAX_QUESTION_ROUNDS}`);

  const answerPrompt = `主编回复：${answer}\n\n请继续执行。`;
  state.session.lastAccess = Date.now();

  // 更新 bot 状态：这条提问已回答
  const botState = loadBotState(config.name, state.session.novelDir, state.chatId);
  recordQuestionAnswered(botState, questionId);

  try {
    const response = await sendToOpencode(state.session, answerPrompt, botState);
    const { questions } = parseQuestionTags(response);
    if (questions.length > 0) {
      await handleQuestions(response, state.taskId, state.chatId, state.messageId, state.session, state.round);
    } else {
      if (state.taskId) {
        recordTaskComplete(botState, state.taskId, "completed");
      }
      await sendFinalReply(state.chatId, state.messageId, state.taskId, response, undefined);
    }
  } catch (err) {
    console.error(`❌ 处理回答后继续执行失败:`, err);
  }
}

async function sendFinalReply(
  chatId: string,
  messageId: string,
  taskId: string | null,
  response: string,
  mentions: any,
): Promise<void> {
  let finalResponse = response;
  if (taskId) {
    finalResponse = `【任务ID:${taskId}】${response}`;
  }

  const { content: replyContent, msgType: replyMsgType, needMention } = buildReplyWithMention(
    mentions, myOpenId, config.name, finalResponse,
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

  if (editorOpenId) {
    console.log(`📋 主编 open_id: ${editorOpenId}`);
  } else {
    console.log(`⚠️ 未设置 EDITOR_OPEN_ID，将从 mentions 中学习`);
  }

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

        // 学习主编 open_id
        if (!editorOpenId && senderOpenId && senderOpenId !== myOpenId) {
          const isMentioned = myOpenId
            ? message.mentions?.some((m: any) => m.id?.open_id === myOpenId) ?? false
            : message.mentions?.some((m: any) => m.mentioned_type === "bot") ?? false;
          if (isMentioned) {
            editorOpenId = senderOpenId;
            console.log(`📋 学习到主编 open_id: ${editorOpenId}`);
          }
        }

        // 检查是否是主编回答
        const answerId = extractAnswerId(text);
        if (answerId) {
          console.log(`📩 检测到回答: ${answerId}`);
          const answerText = text.replace(/【回答:Q\d{14}】\s*/, "").trim();
          await handleAnswerReceived(answerId, answerText);
          return;
        }

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

          // 通过任务 ID 查询上游数据（截断每个结果，防止 prompt 过长）
          const taskId = extractTaskId(cleanedText);
          if (taskId) {
            const chain = queryTaskChain(taskId);
            const upstreamParts: string[] = [];
            for (const record of chain) {
              if (record.status === "completed" && record.result) {
                const MAX_RESULT_LEN = 2000;
                let result = record.result;
                if (result.length > MAX_RESULT_LEN) {
                  result = result.substring(0, MAX_RESULT_LEN) + `\n...[已截断，完整内容见 ${novelDir}/.tasks/${record.taskId}.txt]`;
                }
                upstreamParts.push(`### 上游任务 [${record.taskId}] ${record.fromBot} -> ${record.toBot}\n任务：${record.task}\n结果：\n${result}`);
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
          recordOpenCodeSession(loadBotState(config.name, novelDir, chatId), session.id);

          // 加载 bot 状态（项目记忆），注入到 prompt
          const botState = loadBotState(config.name, novelDir, chatId);
          if (taskId) {
            recordTaskStart(botState, taskId, "editor", cleanedText);
          }
          console.log(`🧠 [writer] 状态恢复: 章节=${botState.currentChapter} 已完成=${botState.chaptersCompleted.length}`);

          const response = await sendToOpencode(session, prompt, botState);

          const { displayText, questions } = parseQuestionTags(response);
          if (questions.length > 0) {
            const questionId = generateQuestionId();
            const q = questions[0];
            recordQuestionAsked(botState, questionId, taskId || "", q.content);
            await handleQuestions(response, taskId || "", chatId, messageId, session, 0);
          } else {
            // 检测回复里是否提到完成了某章
            const chapterMatch = displayText.match(/第(\d+)章[_\s：:]?(.+?)(?:\.md|完成|已写)/);
            if (chapterMatch) {
              const chapterNum = parseInt(chapterMatch[1]);
              const chapterName = chapterMatch[2].trim().substring(0, 50);
              const filename = `第${String(chapterNum).padStart(2, '0')}章_${chapterName}.md`;
              recordChapterCompleted(botState, filename);
              console.log(`📖 [writer] 记录章节完成: ${filename}`);
            }
            if (taskId) {
              recordTaskComplete(botState, taskId, "completed");
            }
            await sendFinalReply(chatId, messageId, taskId, displayText, message.mentions as any);
          }
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
