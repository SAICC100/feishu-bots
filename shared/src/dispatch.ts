/**
 * 群聊调度模块
 * 主编通过 @ 消息在群里调度其他 Bot
 *
 * 关键：飞书 @ 人使用富文本（post）消息的 at 元素，
 * 而非纯文本消息的 <at> 标签。post 格式更可靠，飞书原生支持。
 */
import * as lark from "@larksuiteoapi/node-sdk";

// ============ Bot Open ID 注册表 ============

const BOT_OPENID_ENV_MAP: Record<string, string> = {
  "资料员": "RESEARCHER_OPEN_ID",
  "分析师": "ANALYST_OPEN_ID",
  "主笔": "WRITER_OPEN_ID",
  "段子手": "JOKESTER_OPEN_ID",
  "校对": "PROOFREADER_OPEN_ID",
  "设定师": "WORLDBUILDER_OPEN_ID",
};

export const BOT_APPID_ENV_MAP: Record<string, string> = {
  "资料员": "RESEARCHER_APP_ID",
  "分析师": "ANALYST_APP_ID",
  "主笔": "WRITER_APP_ID",
  "段子手": "JOKESTER_APP_ID",
  "校对": "PROOFREADER_APP_ID",
  "设定师": "WORLDBUILDER_APP_ID",
};

export class BotRegistry {
  private registry: Map<string, string> = new Map();
  private openIdToName: Map<string, string> = new Map();

  loadFromEnv(): void {
    for (const [name, envVar] of Object.entries(BOT_OPENID_ENV_MAP)) {
      const openId = process.env[envVar];
      if (openId) {
        this.registry.set(name, openId);
        this.openIdToName.set(openId, name);
        console.log(`📋 已加载 ${name} 的 open_id: ${openId}`);
      }
    }
  }

  learnFromMentions(
    mentions?: Array<{
      name?: string;
      id?: { open_id?: string };
      key?: string;
      mentioned_type?: string;
    }>,
  ): void {
    if (!mentions) return;
    for (const m of mentions) {
      if (m.mentioned_type === "bot" && m.id?.open_id) {
        const openId = m.id.open_id;
        if (this.openIdToName.has(openId)) {
          const botName = this.openIdToName.get(openId)!;
          if (this.registry.get(botName) !== openId) {
            this.registry.set(botName, openId);
            console.log(`📋 更新 ${botName} 的 open_id: ${openId}`);
          }
          continue;
        }
        const mentionName = m.name || "";
        for (const [botName, envVar] of Object.entries(BOT_APPID_ENV_MAP)) {
          const prefix = envVar.replace("_APP_ID", "");
          if (mentionName.toUpperCase().includes(prefix) && !this.registry.has(botName)) {
            this.registry.set(botName, openId);
            this.openIdToName.set(openId, botName);
            console.log(`📋 学习到 ${botName} 的 open_id: ${openId} (from mention name=${mentionName})`);
            break;
          }
        }
      }
    }
  }

  getOpenId(botName: string): string | undefined {
    return this.registry.get(botName);
  }

  has(botName: string): boolean {
    return this.registry.has(botName);
  }

  getBotNameByOpenId(openId: string): string | undefined {
    return this.openIdToName.get(openId);
  }

  /** 通过 mention 的 name 字段匹配团队成员
   * 飞书 mentions name 是应用英文名（如 RESEARCHER_APP, EDITOR_APP），
   * 也可能是中文 bot 名（如 "资料员"）
   */
  getBotNameByMentionName(mentionName: string): string | undefined {
    // 先尝试中文名匹配
    for (const botName of this.registry.keys()) {
      if (mentionName.includes(botName)) {
        return botName;
      }
    }
    // 再尝试英文名前缀匹配（如 RESEARCHER_APP -> 资料员）
    for (const [botName, envVar] of Object.entries(BOT_APPID_ENV_MAP)) {
      const prefix = envVar.replace("_APP_ID", "");
      if (mentionName.toUpperCase().includes(prefix)) {
        return botName;
      }
    }
    return undefined;
  }

  /** 学习 bot 的事件 sender open_id 映射
   * 飞书事件中 bot 的 sender open_id 与 .env 注册的不同，
   * 需要在运行时从实际事件中学习
   */
  learnSenderId(_chatId: string, senderOpenId: string, botName: string): void {
    if (!this.openIdToName.has(senderOpenId)) {
      this.openIdToName.set(senderOpenId, botName);
      this.registry.set(botName, senderOpenId);
      console.log(`📋 学习到 ${botName} 的 sender open_id: ${senderOpenId}`);
    }
  }
}

// ============ 富文本（post）消息 @ 人 ============

/**
 * 构建富文本消息内容，包含 at 元素 @ 指定用户
 * 返回可直接序列化的 post 消息 content 对象
 */
function buildPostContent(
  text: string,
  atTargets: Array<{ openId: string; name?: string }>,
): Record<string, any> {
  const contentLine: any[] = [];

  // 先放 at 元素
  for (const target of atTargets) {
    contentLine.push({ tag: "at", user_id: target.openId });
    contentLine.push({ tag: "text", text: " " });
  }

  // 再放正文
  contentLine.push({ tag: "text", text });

  return {
    zh_cn: {
      title: "",
      content: [contentLine],
    },
  };
}

/**
 * Bot 回复消息时，如果消息来自其他 Bot 的调度（被 @），
 * 需要在回复中 @ 回调度者，这样调度者才能收到事件通知。
 * 同时 @ 自己，让调度者能从 mentions 中识别发送者身份。
 *
 * 使用富文本（post）消息的 at 元素来 @ 人，
 * 这是飞书官方推荐的方式，比纯文本的 <at> 标签更可靠。
 *
 * message.reply 接口同样支持 post 消息类型。
 */
export function buildReplyWithMention(
  mentions: Array<{ key?: string; id?: string; id_type?: string; name?: string; open_id?: string }> | undefined,
  myOpenId: string,
  myName: string,
  responseText: string,
  senderOpenId?: string,
): {
  content: string;
  msgType: string;
  needMention: boolean;
} {
  const atTargets: Array<{ openId: string; name?: string }> = [];

  if (mentions) {
    for (const m of mentions) {
      // m.id 可能是 string 或 {open_id, union_id, user_id} 对象
      const mOpenId = typeof m.id === "object" && m.id !== null
        ? (m.id as any).open_id || ""
        : m.id || m.open_id || "";
      if (mOpenId && mOpenId !== myOpenId) {
        atTargets.push({ openId: mOpenId, name: m.name });
      }
    }
  }

  // 如果 mentions 里没有其他人（只有自己被 @），则 @ 回消息发送者
  if (atTargets.length === 0 && senderOpenId && senderOpenId !== myOpenId) {
    atTargets.push({ openId: senderOpenId });
  }

  const needMention = atTargets.length > 0;

  if (needMention) {
    // @ 回调度者（不 @ 自己，主编通过 sender 识别发送者）
    const postContent = buildPostContent(responseText, atTargets);
    return {
      content: JSON.stringify(postContent),
      msgType: "post",
      needMention: true,
    };
  }

  return {
    content: JSON.stringify({ text: responseText }),
    msgType: "text",
    needMention: false,
  };
}

/**
 * 用 message.create 发送带 @ 的富文本回复消息到群聊
 */
export async function sendReplyWithMention(
  client: lark.Client,
  chatId: string,
  content: string,
  msgType: string,
): Promise<void> {
  console.log(`📤 发送富文本回复: chatId=${chatId}, msgType=${msgType}`);
  await client.im.message.create({
    data: {
      receive_id: chatId,
      msg_type: msgType as any,
      content,
    } as any,
    params: {
      receive_id_type: "chat_id",
    },
  });
}

// ============ 发送带 @ 的群消息（主编调度用） ============

export async function sendMentionMessage(
  client: lark.Client,
  chatId: string,
  text: string,
  mentionTargets: Array<{ name: string; openId: string }>
): Promise<void> {
  const postContent = buildPostContent(text, mentionTargets);

  console.log(`📤 发送 @ 消息: chatId=${chatId}, targets=${mentionTargets.map(t => t.name).join(",")}`);

  try {
    const result = await client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: "post",
        content: JSON.stringify(postContent),
      } as any,
      params: {
        receive_id_type: "chat_id",
      },
    });
    console.log(`📤 发送结果: code=${result.code}, msg=${result.msg}`);
  } catch (e: any) {
    console.error(`📤 发送 @ 消息失败:`, e?.message || e);
    throw e;
  }
}

// ============ 清理消息文本中的 @ 占位符 ============

/**
 * 清理飞书消息文本中的 @ 占位符
 * 纯文本消息：@_user_N 占位符
 * 富文本消息：需要从 content 结构中提取纯文本
 */
export function cleanMentionPlaceholders(text: string): string {
  return text
    .replace(/@_user_\d+\s?/g, "")
    .replace(/<at\s+user_id="[^"]*">[^<]*<\/at>\s?/g, "")
    .trim();
}

/**
 * 从消息内容中提取纯文本
 * 同时处理纯文本和富文本（post）消息格式
 *
 * 注意：飞书 WSClient 推送的事件中 msg_type 可能不准确
 * （post 消息可能被标记为 text），因此需要根据内容结构判断
 */
export function extractTextFromContent(
  contentStr: string,
  msgType: string,
): string {
  let parsed: any;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    // content 不是合法 JSON（如合并消息、系统消息等），直接返回原文
    return cleanMentionPlaceholders(contentStr);
  }

  // 优先根据内容结构判断是否为 post 消息
  // 飞书事件中 msg_type 可能不准，但 content 结构不会骗人
  // 注意：发送时 content 包含 zh_cn/en_us 外层，但事件推送时没有语言包裹
  const langBody = parsed.zh_cn || parsed.en_us;
  const isPost = Array.isArray(langBody?.content) || Array.isArray(parsed.content);

  if (msgType === "post" || isPost) {
    const body = langBody || parsed;
    const lines: string[] = [];
    if (body?.content && Array.isArray(body.content)) {
      for (const line of body.content) {
        if (Array.isArray(line)) {
          const lineText = line
            .filter((el: any) => el.tag === "text")
            .map((el: any) => el.text || "")
            .join("");
          if (lineText.trim()) lines.push(lineText.trim());
        }
      }
    }
    return lines.join("\n").trim();
  }

  // 纯文本消息
  return cleanMentionPlaceholders(parsed.text || "");
}

// ============ 拉取群聊历史消息 ============

export interface ChatMessage {
  senderType: string;
  senderName: string;
  text: string;
  createTime: string;
}

/**
 * 拉取群聊最近的聊天记录
 * 返回格式化的消息列表，供拼接到 prompt 中
 */
export async function fetchChatHistory(
  client: lark.Client,
  chatId: string,
  count: number = 20,
): Promise<ChatMessage[]> {
  try {
    const result = await client.im.message.list({
      params: {
        container_id_type: "chat",
        container_id: chatId,
        page_size: count,
      },
    });

    if (result.code !== 0) {
      console.warn(`⚠️ 拉取聊天记录失败: code=${result.code}, msg=${result.msg}`);
      return [];
    }

    const items = (result.data as any)?.items || [];
    const messages: ChatMessage[] = [];

    for (const msg of items) {
      const msgType = msg.msg_type || "text";
      const contentStr = msg.body?.content || "";
      if (!contentStr) {
        console.log(`📋 跳过空内容消息: msgType=${msgType}, msgId=${msg.message_id}`);
        continue;
      }

      const text = extractTextFromContent(contentStr, msgType);
      if (!text) {
        console.log(`📋 跳过无文本消息: msgType=${msgType}, content=${contentStr.substring(0, 100)}`);
        continue;
      }

      const senderType = msg.sender?.sender_type?.role || msg.sender?.type || "";
      const senderId = msg.sender?.sender_id || {};

      // 尝试从 sender 信息获取名称
      let senderName = senderId.name || "";
      if (!senderName && senderId.open_id) {
        senderName = senderId.open_id.substring(0, 8);
      }
      if (!senderName) {
        senderName = senderType === "bot" ? "Bot" : "用户";
      }

      console.log(`📋 消息: [${senderName}] (${senderType}) msgType=${msgType} text="${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);

      messages.push({
        senderType,
        senderName,
        text,
        createTime: msg.create_time || "",
      });
    }

    // 按时间正序排列（API 返回的是倒序）
    messages.reverse();

    console.log(`📋 拉取到 ${messages.length} 条聊天记录 (API返回 ${items.length} 条原始消息)`);
    return messages;
  } catch (e: any) {
    console.warn(`⚠️ 拉取聊天记录异常: ${e?.message || e}`);
    return [];
  }
}

/**
 * 将聊天记录格式化为 prompt 文本
 */
export function formatChatHistory(
  messages: ChatMessage[],
  myName: string,
): string {
  if (messages.length === 0) return "";

  const lines = messages.map((m) => {
    const label = m.senderType === "bot" ? `[${m.senderName}]` : `[${m.senderName}]`;
    return `${label}: ${m.text}`;
  });

  return `以下是群里最近的聊天记录：\n${lines.join("\n")}`;
}

// ============ 解析提问标签 ============

export interface QuestionTag {
  targetBot: string;
  questionId: string;
  content: string;
}

export function parseQuestionTags(
  response: string
): { displayText: string; questions: QuestionTag[] } {
  const questions: QuestionTag[] = [];
  const regex = /\[QUESTION:(.+?):(Q\d{14})\]([\s\S]*?)\[\/QUESTION\]/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(response)) !== null) {
    questions.push({
      targetBot: match[1].trim(),
      questionId: match[2],
      content: match[3].trim(),
    });
  }

  const displayText = response.replace(regex, "").trim();

  return { displayText, questions };
}

export function extractQuestionId(text: string): string | null {
  const match = text.match(/【提问:(Q\d{14})】/);
  return match ? match[1] : null;
}

export function extractAnswerId(text: string): string | null {
  const match = text.match(/【回答:(Q\d{14})】/);
  return match ? match[1] : null;
}

// ============ 解析调度标签 ============

export interface DispatchInstruction {
  botName: string;
  task: string;
  taskId?: string;
}

export function parseDispatchTags(
  response: string
): { displayText: string; instructions: DispatchInstruction[] } {
  const instructions: DispatchInstruction[] = [];
  const regex = /\[DISPATCH:(.+?)(?::(T\d{14}(?:-\d+)?))?\]([\s\S]*?)\[\/DISPATCH\]/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(response)) !== null) {
    instructions.push({
      botName: match[1].trim(),
      taskId: match[2] || undefined,
      task: match[3].trim(),
    });
  }

  const displayText = response.replace(regex, "").trim();

  return { displayText, instructions };
}
