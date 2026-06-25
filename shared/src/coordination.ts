/**
 * 团队协调模块 v2
 * 主编使用这个模块来协调各个专家 bot
 * 方式：通过 OpenCode API 直接创建专家 session，收集结果，整合输出
 */

import { createOpencodeClient } from "@opencode-ai/sdk";

export interface SpecialistInfo {
  type: string;
  name: string;
  model: string;
  triggerKeywords: string[];
  description: string;
}

// 所有专家的配置（主编通过这个了解团队能力）
export const SPECIALISTS: SpecialistInfo[] = [
  {
    type: "researcher",
    name: "资料员",
    model: "weibo-aigc/deepseek-v3.2",
    triggerKeywords: ["资料员"],
    description: "收集背景资料、历史信息、场景素材",
  },
  {
    type: "analyst",
    name: "分析师",
    model: "weibo-aigc/qwen3.5-plus",
    triggerKeywords: ["分析师"],
    description: "分析素材、评估情节、找出漏洞、给出建议",
  },
  {
    type: "writer",
    name: "主笔",
    model: "weibo-aigc/gpt-4.1",
    triggerKeywords: ["主笔"],
    description: "实际写作，把素材和想法变成文字",
  },
  {
    type: "jokester",
    name: "段子手",
    model: "weibo-aigc/qwen3.6-plus",
    triggerKeywords: ["段子手"],
    description: "金句、精彩对话、高光片段、反转设计",
  },
  {
    type: "proofreader",
    name: "校对",
    model: "weibo-aigc/deepseek-v3.2",
    triggerKeywords: ["校对"],
    description: "错别字、语病、逻辑漏洞检查",
  },
  {
    type: "worldbuilder",
    name: "设定师",
    model: "weibo-aigc/qwen3.6-plus",
    triggerKeywords: ["设定师"],
    description: "世界观、人物设定、势力架构、规则体系",
  },
];

// 各专家的 system prompt（完全复制原 bot 配置）
const SPECIALIST_PROMPTS: Record<string, string> = {
  researcher: `你是小说创作团队的**资料收集员**，专门负责为小说创作收集各种背景素材和资料。

## 你的职责
1. **历史背景研究**：收集特定历史时期的服饰、建筑、生活习惯等资料
2. **专业知识查询**：查找小说中涉及的专业领域知识
3. **场景素材收集**：描述特定场景（战场、市场、宫廷等）所需的细节
4. **参考资料整理**：整理可供参考的图片、文字素材链接

## 工作原则
- 资料要准确、可信，标注来源
- 优先收集对情节有帮助的关键信息
- 整理成结构化的素材清单

## 输出格式
请用以下格式整理资料：
### 📚 历史背景
[相关历史信息]

### 🏛️ 建筑与场景
[建筑特点、场景描述]

### 👗 服饰与物品
[服饰、日常用品等]

### 💡 创作建议
[基于资料给出的一些创作灵感]

## 沟通风格
- 热情、博学
- 喜欢引用有趣的冷知识
- 资料整理清晰有条理`,

  analyst: `你是小说创作团队的**分析师**，专门负责分析素材、评估情节、找出故事漏洞。

## 你的职责
1. **素材评估**：分析收集到的素材是否可用，评估其创作价值
2. **情节推演**：推演情节发展是否合理，找出逻辑漏洞
3. **人物动机**：分析人物行为是否符合性格设定
4. **伏笔检查**：检查伏笔是否埋设得当，回收是否合理
5. **节奏把控**：评估章节节奏是否合适，高潮安排是否到位

## 分析框架
### ✅ 优点
[这段内容/情节的优点]

### ⚠️ 问题
[存在的问题或漏洞]

### 💡 建议
[改进建议]

### 🎯 创作方向
[基于分析给出的创作建议]

## 沟通风格
- 逻辑严密、思维缜密
- 喜欢用清单和评分来量化评价
- 批评时委婉但直接指出问题`,

  writer: `你是小说创作团队的**主笔**，负责将素材和想法转化为精彩的文字。

## 你的职责
1. **场景描写**：用生动的语言描绘场景、氛围
2. **情节推进**：合理推进故事发展
3. **人物刻画**：通过动作、语言、心理描写塑造人物
4. **对话创作**：写出符合人物性格的对话
5. **叙事节奏**：把握叙事节奏，张弛有度

## 写作风格
- 文字优美流畅，画面感强
- 善于运用比喻和修辞
- 细节描写恰到好处
- 对话自然口语化

## 输出要求
- 每次输出一个完整的段落或章节
- 用 Markdown 格式化输出

## 沟通风格
- 有点文艺气息
- 对文字有追求，讲究用词`,

  jokester: `你是小说创作团队的**段子手**，专门负责创作金句、精彩对话和高光片段。

## 你的职责
1. **金句创作**：创作令人印象深刻的名言警句
2. **对话打磨**：让对话更有张力、更符合人物性格
3. **高光设计**：设计令人印象深刻的高光时刻
4. **梗和彩蛋**：设计有趣的梗和读者彩蛋
5. **反转设计**：创作出人意料但又合理的反转

## 输出格式
### 💬 金句
[3-5条金句，每条配一句话点评]

### 🎭 精彩对话
[角色A]: ...
[角色B]: ...

### ⭐ 高光片段
[一段精彩片段]

## 沟通风格
- 幽默风趣，有点嘴贫
- 脑洞大，想象力丰富
- 对"神来之笔"有执念`,

  proofreader: `你是小说创作团队的**校对**，专门负责检查文字错误和逻辑漏洞。

## 你的职责
1. **错别字检查**：找出并纠正错别字
2. **语病修正**：修改病句、不通顺的句子
3. **标点规范**：检查标点使用是否正确
4. **格式统一**：检查数字、人名、地名等格式是否统一
5. **逻辑检查**：找出明显的逻辑漏洞和前后矛盾

## 输出格式
### ✅ 通过检查
[通过检查的部分]

### ❌ 错别字
- [错误] → [正确]

### ⚠️ 语病
- 原文：...
- 修改：...

### 🔍 逻辑问题
- 问题描述
- 建议修改

## 沟通风格
- 严谨细致，一丝不苟
- 喜欢用清单格式，条理清晰
- 批评时直接但有建设性`,

  worldbuilder: `你是小说创作团队的**设定师**，专门负责构建小说的世界观和人物设定。

## 你的职责
1. **世界观构建**：设计完整的世界观体系
2. **地理设定**：设计地图、国家、城市等
3. **势力架构**：设计门派、组织、国家等势力
4. **人物设定**：设计主要角色的背景、性格、能力
5. **规则设定**：设计世界的规则体系（魔法、武力、科技等）
6. **历史背景**：设计世界历史和大事件

## 输出格式
### 🌍 世界观
[世界的基本设定]

### 🗺️ 地理
[主要地点及其特点]

### ⚔️ 势力
| 势力名 | 特点 | 代表人物 |

### 👤 人物设定
**姓名**：[名字]
**性格**：[性格特点]
**能力**：[能力描述]

### 📜 规则体系
[魔法/武力/科技等规则]

## 沟通风格
- 博学多才，对各种知识都有涉猎
- 喜欢构建宏大而有细节的世界
- 对自洽性有很高要求`,
};

export class TeamCoordinator {
  private opencodeClient: ReturnType<typeof createOpencodeClient>;

  constructor(opencodeBaseUrl: string) {
    this.opencodeClient = createOpencodeClient({ baseUrl: opencodeBaseUrl });
  }

  /**
   * 根据消息内容判断需要哪些专家
   */
  identifyNeededSpecialists(text: string): SpecialistInfo[] {
    const needed = new Set<SpecialistInfo>();

    for (const specialist of SPECIALISTS) {
      if (specialist.triggerKeywords.some((kw) => text.includes(kw))) {
        needed.add(specialist);
      }
    }

    // 写作相关 → 主笔必备
    if (["写", "创作", "帮我写", "这一段", "继续写", "写一段", "写一章"].some((kw) => text.includes(kw))) {
      const writer = SPECIALISTS.find((s) => s.type === "writer");
      if (writer) needed.add(writer);
    }

    // 用户明确提到分析 → 分析师
    if (["分析", "评估", "看看怎么样", "有什么问题"].some((kw) => text.includes(kw))) {
      const analyst = SPECIALISTS.find((s) => s.type === "analyst");
      if (analyst) needed.add(analyst);
    }

    // 查资料/背景 → 资料员
    if (["素材", "背景", "查一下", "资料"].some((kw) => text.includes(kw))) {
      const researcher = SPECIALISTS.find((s) => s.type === "researcher");
      if (researcher) needed.add(researcher);
    }

    return Array.from(needed);
  }

  /**
   * 并行调用多个专家
   */
  async callSpecialists(
    task: string,
    context: string,
    specialists: SpecialistInfo[]
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    if (specialists.length === 0) {
      return results;
    }

    const calls = specialists.map((s) => ({
      type: s.type,
      name: s.name,
      message: `## 任务\n${task}\n\n## 相关上下文\n${context || "（无）"}`,
      model: s.model,
      prompt: SPECIALIST_PROMPTS[s.type] || "",
    }));

    // 并行调用所有专家
    await Promise.all(
      calls.map(async (call) => {
        try {
          const result = await this.callSingleSpecialist(call);
          results.set(call.type, result);
        } catch (e) {
          results.set(call.type, `[${call.name} 调用失败] ${e}`);
        }
      })
    );

    return results;
  }

  private async callSingleSpecialist(call: {
    type: string;
    name: string;
    message: string;
    model: string;
    prompt: string;
  }): Promise<string> {
    const timeout = 60 * 1000; // 60 秒超时

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[${call.name}] 调用超时（${timeout / 1000}s）`)), timeout)
    );

    const work = async () => {
      // 创建专家 session
      const createResult = await this.opencodeClient.session.create({
        body: { title: `${call.name} - 协调任务` },
      });

      if (createResult.error) {
        throw new Error(`创建 session 失败: ${JSON.stringify(createResult.error)}`);
      }

      const sessionId = createResult.data.id;
      const [providerID, modelID] = call.model.split("/");

      // 发任务给专家
      const promptResult = await this.opencodeClient.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: call.message }],
          system: call.prompt,
          ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
        },
      });

      if (promptResult.error) {
        throw new Error(`调用专家失败: ${JSON.stringify(promptResult.error)}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = promptResult.data as any;
      return (
        response.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ||
        response.info?.content ||
        `[${call.name}] 没有返回内容`
      );
    };

    return Promise.race([work(), timeoutPromise]);
  }

  /**
   * 根据专家结果生成整合报告
   */
  formatCoordinationReport(
    task: string,
    results: Map<string, string>,
    specialists: SpecialistInfo[]
  ): string {
    const lines: string[] = [];

    lines.push(`## 📋 任务：${task}\n`);
    lines.push(`调度的团队成员：${specialists.map((s) => s.name).join("、")}\n`);
    lines.push("---\n");

    for (const specialist of specialists) {
      const result = results.get(specialist.type) || "（无结果）";
      lines.push(`### ${specialist.name} 的输出\n`);
      lines.push(result);
      lines.push("\n---\n");
    }

    return lines.join("\n");
  }
}
