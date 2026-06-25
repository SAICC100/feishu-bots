/**
 * 飞书 Bot 共享工具包
 */

import crypto from "crypto";
import fetch from "node-fetch";

// 为 console.log/warn/error 添加时间戳前缀
export function patchConsoleTimestamp(): void {
  const orig = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const ts = () => new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log = (...args: any[]) => orig.log(ts(), ...args);
  console.warn = (...args: any[]) => orig.warn(ts(), ...args);
  console.error = (...args: any[]) => orig.error(ts(), ...args);
}

export {
  initTaskStore,
  generateTaskId,
  storeTask,
  storeResult,
  queryTask,
  queryTaskChain,
  queryTasksByChat,
  pruneOldTasks,
  extractTaskId,
} from "./task-store.js";
export type { TaskRecord } from "./task-store.js";

export interface BotConfig {
  name: string;
  appId: string;
  appSecret: string;
  botName: string;
  systemPrompt: string;
  model?: string;
  tools?: { [key: string]: boolean };
}

export interface FeishuMessage {
  header: {
    app_id: string;
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
  };
  event: {
    sender: {
      sender_id: { open_id: string };
      sender_type: string;
    };
    message: {
      message_id: string;
      root_id?: string;
      parent_id?: string;
      create_time: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
    };
  };
}

// 验证飞书签名
export function verifySignature(
  token: string,
  timestamp: string,
  signature: string,
  secret: string
): boolean {
  const str = `${timestamp}${token}${secret}`;
  const hash = crypto.createHash("sha256").update(str).digest("hex");
  return hash === signature;
}

// 处理飞书 URL 验证 challenge
export function handleChallenge(query: { challenge?: string }): { challenge: string } | null {
  if (query.challenge) {
    return { challenge: query.challenge };
  }
  return null;
}

// 发送消息到飞书
export async function sendMessage(
  accessToken: string,
  receiveId: string,
  receiveIdType: "chat_id" | "open_id",
  msgType: "text" | "post",
  content: string
): Promise<void> {
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      msg_type: msgType,
      content: JSON.stringify({ text: content }),
    }),
  });

  if (!response.ok) {
    console.error("Failed to send message:", await response.text());
  }
}

// 获取 tenant_access_token
export async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  const data = await response.json() as { code?: number; msg?: string; tenant_access_token?: string };
  if (data.code !== 0) {
    throw new Error(`Failed to get access token: ${data.msg}`);
  }

  return data.tenant_access_token!;
}

// 回复消息
export async function replyMessage(
  accessToken: string,
  messageId: string,
  content: string
): Promise<void> {
  const response = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        msg_type: "text",
        content: JSON.stringify({ text: content }),
      }),
    }
  );

  if (!response.ok) {
    console.error("Failed to reply message:", await response.text());
  }
}