# 🦞 小说创作 Agent 团队

一个由多个 AI Agent 组成的飞书群组，专门用于协作创作小说！

## 团队成员

| 角色 | Bot 名字 | 职责 | 使用模型 |
|------|---------|------|---------|
| 🎯 **主编** | @主编 | 统筹规划、分配任务、最终把关 | GPT-4.1 |
| 🔍 **资料员** | @资料员 | 收集素材、历史背景研究 | DeepSeek-V3.2 |
| 📊 **分析师** | @分析师 | 分析素材、评估情节、找漏洞 | Qwen3.5-Plus |
| ✍️ **主笔** | @主笔 | 主要写作任务 | GPT-4.1 |
| 🔥 **段子手** | @段子手 | 金句、对话、高光片段 | Qwen3.6-Plus |
| 📖 **校对** | @校对 | 错别字、语法、逻辑检查 | DeepSeek-V3.2 |
| 🎭 **设定师** | @设定师 | 世界观、人物、势力设定 | Qwen3.6-Plus |

## 快速开始

### 1. 创建飞书应用

你需要为每个 Bot 创建一个飞书自建应用：

1. 打开 [飞书开放平台](https://open.feishu.cn/app)
2. 点击「创建企业自建应用」
3. 创建 7 个应用，分别命名为：主编、资料员、分析师、主笔、段子手、校对、设定师
4. 在每个应用的「凭证与基础信息」中获取 `App ID` 和 `App Secret`
5. 在每个应用的「添加应用能力」中启用「机器人」
6. 在每个应用的「事件订阅」中：
   - 订阅事件：`im.message.receive_v1`
   - 请求网址：`https://你的服务器/webhook`

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入每个 Bot 的 App ID 和 Secret
```

### 3. 启动 Bot

```bash
# 安装依赖
./install.sh

# 启动所有 Bot
./start.sh
```

## 目录结构

```
novel-bots/
├── shared/              # 共享代码
│   └── src/index.ts
├── bots/                # 各 Bot
│   ├── editor/          # 主编
│   ├── researcher/      # 资料员
│   ├── analyst/         # 分析师
│   ├── writer/          # 主笔
│   ├── jokester/        # 段子手
│   ├── proofreader/     # 校对
│   └── worldbuilder/    # 设定师
├── .env.example
├── install.sh
├── start.sh
└── README.md
```

## 添加新 Bot

1. 复制 `bots/template` 目录
2. 修改 `config.ts` 中的配置
3. 添加环境变量到 `.env`
4. 添加启动端口到 `start.sh`

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENCODE_API` | OpenCode API 地址 | `http://localhost:8080` |
| `EDITOR_APP_ID` | 主编 App ID | - |
| `EDITOR_APP_SECRET` | 主编 App Secret | - |
| `EDITOR_PORT` | 主编端口 | 3001 |
| ... | 其他 Bot 同理 | ... |

---

🦞 祝创作愉快！