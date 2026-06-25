/**
 * Per-project Bot 状态文件
 *
 * 每个 bot 在每个小说项目目录下都有自己的"工作笔记"，记录：
 * - 当前进度（写到第几章、走到流水线哪一步）
 * - 最近的任务
 * - 待办（pending questions、等待上游）
 * - 关联资源（OpenCode session id、上一次任务 id）
 *
 * 文件位置: {NOVEL_DIR}/.bot-state/{botName}.json
 *
 * 设计原则：
 * 1. 状态文件是 bot 视角，不是流水线视角（流水线视角在 shared/data/tasks.json）
 * 2. 状态文件不存 OpenCode session 内部对话（那个由 OpenCode 自己存）
 * 3. 状态文件持久化，bot 重启后能立即恢复"我在哪里、刚做了什么"
 * 4. 多个 bot 可以读同一个 .bot-state/ 目录，跨 bot 共享项目视图
 */
import * as fs from "fs";
import * as path from "path";

// ============ 数据结构 ============

export interface PendingQuestion {
  questionId: string;
  taskId: string;
  question: string;
  createdAt: number;
  /** 超时时间戳，超过则视为失效 */
  expiresAt: number;
}

export interface RecentTask {
  taskId: string;
  /** 来自哪个 bot（主编/上游） */
  fromBot: string;
  /** 任务简述（截取前 100 字符） */
  summary: string;
  status: "pending" | "completed" | "failed";
  startedAt: number;
  completedAt: number | null;
}

export interface BotState {
  /** bot 名称：writer / researcher / analyst / editor / ... */
  botName: string;
  /** 小说项目根目录 */
  novelDir: string;
  /** 飞书 chatId，标识这是哪个群的项目 */
  chatId: string;
  /** 当前章节编号（写作 bot 用），0 表示还没开始 */
  currentChapter: number;
  /** 已完成的章节文件列表 */
  chaptersCompleted: string[];
  /** 当前所在流水线步骤（如 "人物设定"、"大纲"、"写作"），可空 */
  currentStep: string;
  /** 当前任务状态机：idle / busy / waiting_answer / waiting_upstream */
  status: "idle" | "busy" | "waiting_answer" | "waiting_upstream";
  /** 最近 N 条任务记录 */
  recentTasks: RecentTask[];
  /** 当前等待主编回答的提问（最多 5 个） */
  pendingQuestions: PendingQuestion[];
  /** 上次使用的 OpenCode session id，用于排查 */
  lastOpenCodeSessionId: string;
  /** 状态最后更新时间 */
  lastUpdated: number;
  /** 状态文件版本，便于将来 schema 升级 */
  version: number;
}

const STATE_VERSION = 1;
const MAX_RECENT_TASKS = 10;
const MAX_PENDING_QUESTIONS = 5;
const QUESTION_TTL_MS = 30 * 60 * 1000; // 30 分钟

// ============ 内部状态（缓存）============

const stateCache: Map<string, BotState> = new Map(); // key = `${botName}:${novelDir}`

// ============ 路径计算 ============

/**
 * 计算状态文件路径：{NOVEL_DIR}/.bot-state/{botName}.json
 */
export function getBotStatePath(botName: string, novelDir: string): string {
  return path.join(novelDir, ".bot-state", `${botName}.json`);
}

// ============ 加载 / 初始化 ============

/**
 * 加载 bot 状态。如果文件不存在或损坏，返回初始空状态。
 * 加载后写入内存缓存。
 */
export function loadBotState(botName: string, novelDir: string, chatId: string = ""): BotState {
  const cacheKey = `${botName}:${novelDir}`;

  // 命中缓存
  const cached = stateCache.get(cacheKey);
  if (cached) return cached;

  const filePath = getBotStatePath(botName, novelDir);
  let state: BotState;

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as BotState;
      // 兼容升级：旧版本没有的字段补默认值
      state = migrateState(parsed, botName, novelDir, chatId);
      console.log(`📋 [${botName}] 已加载状态: 第 ${state.currentChapter} 章, ${state.chaptersCompleted.length} 章已完成`);
    } catch (e) {
      console.warn(`⚠️ [${botName}] 状态文件损坏，创建新状态: ${filePath}`, e);
      state = createEmptyState(botName, novelDir, chatId);
    }
  } else {
    state = createEmptyState(botName, novelDir, chatId);
  }

  // 清理过期 pending questions
  state.pendingQuestions = state.pendingQuestions.filter(q => q.expiresAt > Date.now());

  stateCache.set(cacheKey, state);
  return state;
}

function createEmptyState(botName: string, novelDir: string, chatId: string): BotState {
  return {
    botName,
    novelDir,
    chatId,
    currentChapter: 0,
    chaptersCompleted: [],
    currentStep: "",
    status: "idle",
    recentTasks: [],
    pendingQuestions: [],
    lastOpenCodeSessionId: "",
    lastUpdated: Date.now(),
    version: STATE_VERSION,
  };
}

function migrateState(parsed: any, botName: string, novelDir: string, chatId: string): BotState {
  return {
    botName: parsed.botName || botName,
    novelDir: parsed.novelDir || novelDir,
    chatId: parsed.chatId || chatId,
    currentChapter: parsed.currentChapter ?? 0,
    chaptersCompleted: Array.isArray(parsed.chaptersCompleted) ? parsed.chaptersCompleted : [],
    currentStep: parsed.currentStep || "",
    status: parsed.status || "idle",
    recentTasks: Array.isArray(parsed.recentTasks) ? parsed.recentTasks : [],
    pendingQuestions: Array.isArray(parsed.pendingQuestions) ? parsed.pendingQuestions : [],
    lastOpenCodeSessionId: parsed.lastOpenCodeSessionId || "",
    lastUpdated: parsed.lastUpdated || Date.now(),
    version: STATE_VERSION,
  };
}

// ============ 保存 ============

/**
 * 保存状态到磁盘。状态文件所在目录会自动创建。
 */
export function saveBotState(state: BotState): void {
  state.lastUpdated = Date.now();
  const filePath = getBotStatePath(state.botName, state.novelDir);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 写入临时文件再 rename，避免半写状态
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);

  stateCache.set(`${state.botName}:${state.novelDir}`, state);
}

// ============ 更新方法（高频操作）============

/**
 * 记录新任务开始
 */
export function recordTaskStart(state: BotState, taskId: string, fromBot: string, task: string): void {
  state.status = "busy";
  state.recentTasks.unshift({
    taskId,
    fromBot,
    summary: task.substring(0, 100),
    status: "pending",
    startedAt: Date.now(),
    completedAt: null,
  });
  // 限制长度
  state.recentTasks = state.recentTasks.slice(0, MAX_RECENT_TASKS);
  saveBotState(state);
}

/**
 * 记录任务完成
 */
export function recordTaskComplete(state: BotState, taskId: string, status: "completed" | "failed" = "completed"): void {
  const task = state.recentTasks.find(t => t.taskId === taskId);
  if (task) {
    task.status = status;
    task.completedAt = Date.now();
  }
  state.status = "idle";
  saveBotState(state);
}

/**
 * 记录写作 bot 完成一章
 */
export function recordChapterCompleted(state: BotState, chapterFile: string): void {
  if (!state.chaptersCompleted.includes(chapterFile)) {
    state.chaptersCompleted.push(chapterFile);
  }
  state.currentChapter = Math.max(state.currentChapter, state.chaptersCompleted.length);
  saveBotState(state);
}

/**
 * 记录提问主编
 */
export function recordQuestionAsked(state: BotState, questionId: string, taskId: string, question: string): void {
  state.status = "waiting_answer";
  state.pendingQuestions.push({
    questionId,
    taskId,
    question: question.substring(0, 200),
    createdAt: Date.now(),
    expiresAt: Date.now() + QUESTION_TTL_MS,
  });
  // 限制数量
  state.pendingQuestions = state.pendingQuestions.slice(-MAX_PENDING_QUESTIONS);
  saveBotState(state);
}

/**
 * 记录主编回答
 */
export function recordQuestionAnswered(state: BotState, questionId: string): void {
  state.pendingQuestions = state.pendingQuestions.filter(q => q.questionId !== questionId);
  if (state.status === "waiting_answer") {
    state.status = "idle";
  }
  saveBotState(state);
}

/**
 * 记录 OpenCode session id
 */
export function recordOpenCodeSession(state: BotState, sessionId: string): void {
  state.lastOpenCodeSessionId = sessionId;
  saveBotState(state);
}

/**
 * 设置当前步骤（pipeline step）
 */
export function setCurrentStep(state: BotState, step: string): void {
  state.currentStep = step;
  saveBotState(state);
}

// ============ 状态摘要（注入到 system prompt）============

/**
 * 把状态格式化为可注入到 system prompt 的摘要。
 * bot 醒来时读到这段就知道"我在哪里、刚做了什么"。
 */
export function formatStateSummary(state: BotState): string {
  const lines: string[] = [];
  lines.push(`## 项目记忆（自动恢复）`);
  lines.push(`- 小说：${path.basename(state.novelDir)}`);
  if (state.currentStep) lines.push(`- 当前步骤：${state.currentStep}`);

  if (state.botName === "writer" || state.chaptersCompleted.length > 0) {
    lines.push(`- 章节进度：已完成 ${state.chaptersCompleted.length} 章${state.currentChapter ? `，当前第 ${state.currentChapter + 1} 章` : ""}`);
    if (state.chaptersCompleted.length > 0) {
      const last = state.chaptersCompleted[state.chaptersCompleted.length - 1];
      lines.push(`- 上一章文件：${last}`);
    }
  }

  if (state.status !== "idle") {
    lines.push(`- 当前状态：${state.status}`);
  }

  if (state.pendingQuestions.length > 0) {
    lines.push(`- 待回答的提问：${state.pendingQuestions.length} 个`);
  }

  if (state.recentTasks.length > 0) {
    const lastTask = state.recentTasks[0];
    lines.push(`- 上次任务：${lastTask.taskId} (${lastTask.status}) - ${lastTask.summary}`);
  }

  if (state.lastOpenCodeSessionId) {
    lines.push(`- 上次 OpenCode session: ${state.lastOpenCodeSessionId}`);
  }

  return lines.join("\n");
}
