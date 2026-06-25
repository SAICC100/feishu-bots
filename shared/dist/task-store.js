/**
 * 任务持久化存储模块
 * 主编调度时存储任务记录，收到回复后存储结果
 * 子 Bot 通过任务 ID 查询上游完整产出
 *
 * 存储位置: {dataDir}/tasks.json
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
// ============ 内部状态 ============
let storeData = { tasks: {} };
let dataDir = "";
let writeQueue = Promise.resolve();
// 项目根目录（所有 bot 共享同一个 tasks.json）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SHARED_DATA_DIR = path.join(PROJECT_ROOT, "data");
// ============ 初始化 ============
export function initTaskStore(dir) {
    dataDir = dir || SHARED_DATA_DIR;
    const filePath = path.join(dataDir, "tasks.json");
    if (fs.existsSync(filePath)) {
        try {
            const raw = fs.readFileSync(filePath, "utf-8");
            storeData = JSON.parse(raw);
            console.log(`📋 已加载任务存储: ${Object.keys(storeData.tasks).length} 条记录`);
        }
        catch (e) {
            console.warn(`⚠️ 加载任务存储失败，创建新存储`, e);
            storeData = { tasks: {} };
        }
    }
    else {
        fs.mkdirSync(dataDir, { recursive: true });
        storeData = { tasks: {} };
        flushToDisk();
        console.log(`📋 已创建新任务存储: ${filePath}`);
    }
}
// ============ 生成任务 ID ============
export function generateTaskId() {
    const now = new Date();
    const ts = now.getFullYear().toString() +
        (now.getMonth() + 1).toString().padStart(2, "0") +
        now.getDate().toString().padStart(2, "0") +
        now.getHours().toString().padStart(2, "0") +
        now.getMinutes().toString().padStart(2, "0") +
        now.getSeconds().toString().padStart(2, "0");
    let taskId = `T${ts}`;
    let suffix = 2;
    while (storeData.tasks[taskId]) {
        taskId = `T${ts}-${suffix}`;
        suffix++;
    }
    return taskId;
}
// ============ 存储操作 ============
export function storeTask(record) {
    const taskRecord = {
        ...record,
        result: null,
        completedAt: null,
        status: "pending",
    };
    storeData.tasks[record.taskId] = taskRecord;
    scheduleFlush();
    console.log(`💾 存储任务: ${record.taskId} (${record.fromBot} -> ${record.toBot})`);
    return record.taskId;
}
export function storeResult(taskId, result) {
    const record = storeData.tasks[taskId];
    if (!record) {
        console.warn(`⚠️ 未找到任务 ${taskId}，无法存储结果`);
        return;
    }
    record.result = result;
    record.completedAt = Date.now();
    record.status = "completed";
    scheduleFlush();
    console.log(`💾 存储结果: ${taskId} (${record.toBot})`);
}
// ============ 查询操作 ============
/** 从磁盘重新加载最新数据（跨进程同步） */
function reloadFromDisk() {
    const filePath = path.join(dataDir, "tasks.json");
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, "utf-8");
            storeData = JSON.parse(raw);
        }
    }
    catch {
        // 读取失败则继续用内存数据
    }
}
export function queryTask(taskId) {
    reloadFromDisk();
    return storeData.tasks[taskId] || null;
}
export function queryTaskChain(taskId) {
    reloadFromDisk();
    const chain = [];
    let current = storeData.tasks[taskId];
    while (current) {
        chain.unshift(current);
        if (!current.parentTaskId)
            break;
        current = storeData.tasks[current.parentTaskId];
    }
    return chain;
}
export function queryTasksByChat(chatId) {
    return Object.values(storeData.tasks).filter((t) => t.chatId === chatId);
}
// ============ 清理过期任务 ============
export function pruneOldTasks(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    const before = Object.keys(storeData.tasks).length;
    for (const [id, record] of Object.entries(storeData.tasks)) {
        if (record.timestamp < cutoff) {
            delete storeData.tasks[id];
        }
    }
    const after = Object.keys(storeData.tasks).length;
    if (before !== after) {
        scheduleFlush();
        console.log(`📋 清理过期任务: ${before - after} 条`);
    }
}
// ============ 磁盘写入 ============
function scheduleFlush() {
    writeQueue = writeQueue.then(() => flushToDisk()).catch((e) => {
        console.error(`❌ 写入任务存储失败:`, e);
    });
}
function flushToDisk() {
    if (!dataDir)
        return;
    const filePath = path.join(dataDir, "tasks.json");
    const tmpPath = filePath + ".tmp";
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(storeData, null, 2), "utf-8");
        fs.renameSync(tmpPath, filePath);
    }
    catch (e) {
        console.error(`❌ 写入任务存储失败:`, e);
    }
}
// ============ 提问相关操作 ============
export function generateQuestionId() {
    const now = new Date();
    const ts = now.getFullYear().toString() +
        (now.getMonth() + 1).toString().padStart(2, "0") +
        now.getDate().toString().padStart(2, "0") +
        now.getHours().toString().padStart(2, "0") +
        now.getMinutes().toString().padStart(2, "0") +
        now.getSeconds().toString().padStart(2, "0");
    return `Q${ts}`;
}
export function storeQuestion(taskId, questionId, question) {
    reloadFromDisk();
    const record = storeData.tasks[taskId];
    if (!record) {
        console.warn(`⚠️ 未找到任务 ${taskId}，无法存储提问`);
        return;
    }
    if (!record.questions)
        record.questions = [];
    record.questions.push({
        questionId,
        question,
        answer: null,
        timestamp: Date.now(),
        answeredAt: null,
    });
    record.status = "waiting_answer";
    scheduleFlush();
    console.log(`💾 存储提问: ${questionId} (任务 ${taskId})`);
}
export function storeAnswer(questionId, answer) {
    reloadFromDisk();
    for (const record of Object.values(storeData.tasks)) {
        if (record.questions) {
            const q = record.questions.find(q => q.questionId === questionId);
            if (q) {
                q.answer = answer;
                q.answeredAt = Date.now();
                // 如果所有提问都已回答，恢复 pending 状态
                const allAnswered = record.questions.every(q => q.answer !== null);
                if (allAnswered) {
                    record.status = "pending";
                }
                scheduleFlush();
                console.log(`💾 存储回答: ${questionId} (任务 ${record.taskId})`);
                return;
            }
        }
    }
    console.warn(`⚠️ 未找到提问 ${questionId}，无法存储回答`);
}
export function queryQuestion(questionId) {
    reloadFromDisk();
    for (const record of Object.values(storeData.tasks)) {
        if (record.questions) {
            const q = record.questions.find(q => q.questionId === questionId);
            if (q)
                return q;
        }
    }
    return null;
}
// ============ 从消息文本提取任务 ID ============
export function extractTaskId(text) {
    // 匹配 【任务ID:T20260624153045】 或 【任务ID:T20260624153045-2】
    const match = text.match(/【任务ID:(T\d{14}(?:-\d+)?)】/);
    return match ? match[1] : null;
}
