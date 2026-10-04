# My-Harness 设计文档

> 版本 v0.2.2 · 2026-10-03（v0.2：增补 Windows 桌面端 / Local Server 设计；v0.2.1：确认 Tauri 2 + React 19 + TS；v0.2.2：Tauri 实测 bug 多，改选 Electron + React 19 + TS）
> 调研基准：截至 2026-10 的公开资料（GitHub 星数为 2026-10 时点读数，均标注来源）
> 状态：设计稿（未开始编码）

---

## 0. TL;DR

My-Harness 是一个从零构建的 LLM Agent Harness（把大模型变成能干活的 agent 的运行时脚手架），覆盖当前业界公认的核心能力：

1. **模型接入层**：多 Provider 统一抽象（OpenAI / Anthropic / Gemini / DeepSeek / GLM / Ollama…），流式、工具调用规范化、结构化输出、prompt cache、重试降级、成本核算。
2. **Agent Loop 运行时**：ReAct 主循环 + 可插拔策略（Plan-and-Execute、CodeAct、Reflection），可中断、可 steering、有预算上限。
3. **工具系统**：本地工具（bash/文件/搜索…）+ **MCP 客户端**（外部工具生态）+ **Agent Skills**（SKILL.md 渐进式披露的程序性知识）+ 统一权限闸与沙箱执行。
4. **记忆系统**：短期（in-context blocks）/ 情景（全量事件日志）/ 语义（事实库，文件+向量）/ 程序性（AGENT.md 规则），后台整理与合并去重，记忆即工具（agent 自己读写）。
5. **上下文引擎**：token 预算管理、tool-result 清理、对话压缩（compaction）、大对象文件外置（offload）、KV-cache 友好的 append-only 设计。
6. **多智能体**：subagent 隔离上下文、orchestrator-worker 扇出、handoff 移交、（远期）团队协作与 A2A 协议。
7. **补充能力**：事件溯源式会话持久化（resume/fork/checkpoint）、权限模式与规则引擎、Hooks 全生命周期、OTel 可观测、评测 harness（Task/Trial/Grader、pass@k）。
8. **桌面应用（Windows）**：ZCode 式本地桌面工作台——会话管理、流式对话、工具调用卡片与 diff 审批、MCP/Skills/记忆管理面板、成本与上下文占用仪表；内核以本地服务（daemon）运行，UI 只是事件协议的一个客户端。

第 2 章是对 18 个主流开源项目的功能盘点（Claude Code、Codex、Gemini CLI、LangGraph、Microsoft Agent Framework、OpenHands、Letta、mem0、Zep 等），第 3-4 章是本项目架构与模块设计，第 5 章把「设计模式」系统地映射到 harness 各模块，第 8 章给出五个里程碑的路线图。

---

## 1. 项目定位与目标

### 1.1 什么是 Agent Harness

Harness（挽具/脚手架）= 围绕 LLM 的全部非模型基础设施：驱动模型循环、管理上下文与记忆、执行工具、编排多 agent、控制权限与预算、记录与评测。业界的共识表述：

> Microsoft Agent Framework（2026-09）："agent harness 是把 LLM 变成能干活的 agent 的运行时脚手架——驱动模型与工具调用、管理会话状态与上下文、执行审批策略、维持多步推进。"
> LangChain 1.0（2025-10）：**Agent = Model + Harness**。

2025-2026 的明显趋势：各家都在把「编码 agent 的 harness 形态」（subagents、SKILL.md 技能、hooks、compaction、记忆、审批/沙箱）下沉为通用框架能力；MCP 成为默认工具协议；A2A 进入 Microsoft/Google/CrewAI 三家的多 agent 栈。My-Harness 的目标就是把这套共识能力完整实现一遍，做到**自用可控、模块可拆、每个设计决策可追溯**。

### 1.2 目标与非目标

**目标**
- 一个可嵌入应用的 Python SDK + 一个可日常使用的 CLI + 一个 Windows 桌面工作台（对标 ZCode），三者共用同一内核；
- 所有核心组件面向接口编程：Provider、Tool、Store、Condenser、Sandbox、Hook 都可替换；
- 上下文经济学优先：KV-cache 命中率、token 预算、压缩可还原是一等设计约束；
- 安全默认：工具调用默认过权限闸，写操作可回滚（shadow checkpoint）；
- 从第一天起可观测、可评测（OTel + 评测集）。

**非目标（v1 不做）**
- 不做工作流可视化编排画布（对标 Dify/AutoGPT 的 DAG 画布）——桌面端做「对话/工作台」形态，不做「画布」形态；
- 不做模型训练/微调；
- 不追求全平台沙箱（Windows 原生沙箱 v1 只做进程级权限闸，OS 级隔离走 Docker/WSL2 适配器）。

### 1.3 功能清单（含补充项）

| # | 能力域 | 子能力 | 来源需求 |
|---|---|---|---|
| 1 | 设计模式 | ReAct / Plan-Execute / CodeAct / Reflection / 状态机 / 20+ 经典与 agent 原生模式映射 | 需求 + 补充 |
| 2 | 记忆 | 短期（working blocks）、长期（情景/语义/程序性）、记忆压缩与整理、记忆即工具 | 需求 |
| 3 | 工具 | tool calling、MCP 客户端、Skills（渐进式披露）、工具设计规范 | 需求 |
| 4 | 上下文 | token 预算、tool-result 清理、compaction、大对象外置、KV-cache 友好 | 需求 |
| 5 | 多 agent | subagent、orchestrator-worker、handoff、team、A2A（远期） | 需求 |
| 6 | 补充：会话 | 事件溯源、resume/fork、checkpoint、shadow-git 回滚 | 补充 |
| 7 | 补充：安全 | 权限模式/规则、hooks、沙箱适配器、注入防御 | 补充 |
| 8 | 补充：质量 | OTel GenAI 追踪、成本面板、评测 harness | 补充 |
| 9 | 补充：交互 | CLI/TUI 流式、SDK、Local Server 与 UI 事件协议、HITL 审批、**Windows 桌面工作台（对标 ZCode）** | 补充 + 新需求 |

---

## 2. 市面主流 Harness 开源项目调研

### 2.1 项目总览

| 项目 | 组织 | Stars(2026-10) | 语言 | 定位 | 最值得借鉴的 1 件事 |
|---|---|---|---|---|---|
| [claude-code](https://github.com/anthropics/claude-code) | Anthropic | ~149k | TS | 终端编码 agent + Agent SDK | subagent 隔离上下文 + compaction + hooks 的上下文经济学 |
| [codex](https://github.com/openai/codex) | OpenAI | ~128k | Rust | 终端编码 agent | 三档沙箱 × 审批策略正交的安全模型 |
| [gemini-cli](https://github.com/google-gemini/gemini-cli) | Google | ~107k | TS | 终端编码 agent（免费额度最大） | shadow git checkpoint + argsPattern 策略引擎 |
| [dify](https://github.com/langgenius/dify) | LangGenius | ~158k | TS/Py | 可视化 LLMOps 平台 | 插件四分类治理（tool/model/extension/agent-strategy） |
| [AutoGPT](https://github.com/Significant-Gravitas/AutoGPT) | Gravitas | ~188k | Py/TS | 低代码 agent 平台 | 手动/定时/webhook 触发 + 成本面板 |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | All-Hands-AI | ~90k | TS/Py | 编码 agent 控制中心 | Condenser：「事件→视图」两段式上下文压缩 |
| [MetaGPT](https://github.com/FoundationAgents/MetaGPT) | FoundationAgents | ~71k | Py | SOP 多角色 AI 软件公司 | 中间产物文件化压缩跨角色上下文 |
| [crewAI](https://github.com/crewAIInc/crewAI) | CrewAI | ~59k | Py | 角色化多 agent 框架 | 统一 Memory：召回打分（相似度×衰减×重要性）+ LLM 合并去重 |
| [goose](https://github.com/block/goose) | Block→Linux AAIF | ~55k | Rust | 本地优先桌面 agent | MCP 作为唯一插件协议 + lead-worker 成本分层 |
| [langgraph](https://github.com/langchain-ai/langgraph) | LangChain | ~43k | Py | 底层状态图编排 | durable execution：checkpointer/store + interrupt/resume |
| [LangChain](https://github.com/langchain-ai/langchain) | LangChain | ~147k | Py | Agent = Model + Harness | 「prompt + tools + middleware」组合学 |
| [agno](https://github.com/agno-agi/agno) | Agno | ~43k | Py | 自托管 agent 平台运行时 | 会话/记忆/知识/trace 全落自建库的数据主权 |
| [agentscope](https://github.com/agentscope-ai/agentscope) | 阿里 | ~33k | Py | 生产级 ReAct 框架 | tool-result offloading + 全环节中间件钩子 |
| [openai-agents-python](https://github.com/openai/openai-agents-python) | OpenAI | ~30k | Py | 轻量多 agent 框架（Swarm 后继） | handoff 与 agents-as-tools 双委托语义 |
| [smolagents](https://github.com/huggingface/smolagents) | HuggingFace | ~30k | Py | 千行级极简库 | Code-as-Action（写代码当动作，省步数） |
| [adk-python](https://github.com/google/adk-python) | Google | ~22k | Py | 多 agent 构建-评测-部署框架 | Session/State/Memory/Artifact 四服务化 + 轨迹级 conformance 测试 |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) | Princeton | ~21k | Py | ACI 研究平台（已维护模式） | ACI 工具设计准则（lint 回拒/受限查看器/空输出回执） |
| [pydantic-ai](https://github.com/pydantic/pydantic-ai) | Pydantic | ~20k | Py | 类型安全 AI SDK | Capabilities 可拼装 harness + 8 引擎持久化执行 |
| [elizaOS](https://github.com/elizaOS/eliza) | elizaOS | ~20k | TS | 角色 agent 运行时 | Providers 动态上下文注入 + 类型化七类记忆 |
| [autogen](https://github.com/microsoft/autogen) | Microsoft | ~61k | Py | ⚠️ 已进入维护模式 | 被 Agent Framework 官方取代 |
| [agent-framework](https://github.com/microsoft/agent-framework) | Microsoft | ~14k | Py/.NET | AutoGen+SK 企业级合体 | workflow checkpoint + time-travel；HarnessAgent 一等概念 |
| [letta](https://github.com/letta-ai/letta) | Letta | 记忆专项 | Py | MemGPT 后继，OS 式记忆 | memory blocks（带字符上限的 in-context 记忆）+ sleep-time 整理 |
| [mem0](https://github.com/mem0ai/mem0) | Mem0 | 记忆专项 | Py | 记忆抽取-整合管线 | 抽取→对账（ADD/UPDATE/DELETE/NOOP）+ OpenMemory MCP |
| [zep/graphiti](https://github.com/getzep/graphiti) | Zep | 记忆专项 | Py | 时序知识图谱记忆 | bi-temporal 失效：过期事实标记而非删除 |

> 注：Letta/mem0/Zep 星数未在本次调研中实测确认，故不标数字；其余为调研 agent 于 2026-10-03 从 GitHub 实读。

### 2.2 功能对照矩阵

✓=完整支持 ◐=部分/实验 –=无

| 项目 | 记忆(长期) | MCP | Skills | 多agent | 上下文压缩 | 沙箱/权限 | 观测/评测 |
|---|---|---|---|---|---|---|---|
| Claude Code | ◐ CLAUDE.md/auto-memory | ✓ | ✓ | ✓ subagent/teams | ✓✓ compaction+clearing | ✓ 权限模式+hooks | ◐ usage+hooks |
| Codex | ✓ Memories | ✓ | ✓ | ◐ subagent | ✓ | ✓✓ 三档沙箱 | ◐ |
| Gemini CLI | ✓ GEMINI.md | ✓ | ✓ | ◐ 实验中 | ✓ | ✓ 容器+policy engine | ✓ OTel |
| OpenHands | ◐ 事件流+skills | ✓ | ✓ | ◐ | ✓✓ Condenser | ✓ Docker runtime | ✓ |
| LangGraph | ✓ checkpointer+store | ✓ | ◐ | ✓ 图/supervisor | ◐ middleware | – 自建 | ✓ LangSmith |
| MS Agent Framework | ✓ context providers | ✓ | ✓ | ✓✓ 5种编排 | ✓ compaction | ◐ | ✓ OTel |
| OpenAI Agents SDK | ✓ sessions 多后端 | ✓ | – | ✓✓ handoff | – | ◐ sandbox agents | ✓ 内置 tracing |
| CrewAI | ✓✓ 统一Memory | ✓ | – | ✓ crews/flows | – | – | ◐ 遥测 |
| Google ADK | ✓✓ 四服务 | ✓ | ✓ | ✓✓ 层级+Task API | – | ◐ | ✓✓ conformance |
| Letta | ✓✓ blocks/archival | ✓ | ◐ | ✓ 共享blocks | ✓ 递归摘要 | – | ◐ |
| mem0 | ✓✓ 抽取-整合 | ✓ server | – | – | – | – | ◐ |
| Zep | ✓✓ 时序图谱 | ✓ server | – | – | – | – | – |

### 2.3 编码 Agent 类项目要点

**Claude Code / Claude Agent SDK（Anthropic）** — 单循环 + 流式消息协议；SDK 本体是打包的 Claude Code 二进制，库只是消息协议包装。要点：① subagent 全新会话、只回传最终摘要（父上下文只增长一段文字）；② hooks 全生命周期（PreToolUse/PostToolUse/PreCompact/SubagentStart…）且跑在宿主进程不占上下文；③ `max_budget_usd` 覆盖整棵子代理树；④ 权限规则 `Tool(specifier)` 语法，deny→ask→allow 先匹配先赢；⑤ 自动 compaction + `/compact` 手动 + thrashing 保护（摘要后立即又满 → 报错而非死循环）。[来源](https://code.claude.com/docs/en/agent-sdk/overview)

**Codex CLI（OpenAI）** — Rust 内核。要点：① 沙箱三档 `read-only / workspace-write / danger-full-access` 与审批策略 `on-request / on-failure / never` 正交组合；平台实现 macOS Seatbelt、Linux Landlock+seccomp/bubblewrap；② `config.toml` 声明式配置（MCP/profiles/审批/沙箱一体）；③ 2026 新增 Memories（含后台 memory-consolidation 子代理）与 Skills/Hooks/Rules。[来源](https://developers.openai.com/codex/sandboxing)

**Gemini CLI（Google）** — TS monorepo（cli+core）。要点：① **shadow git checkpointing**：每次文件修改前自动在 `~/.gemini/history/<hash>` 打快照，`/restore` 连同对话历史一起恢复；② policy engine 按 `argsPattern` 做参数级工具白/黑名单（如禁写 `.env`）；③ GEMINI.md 三层 context file（全局/项目/子目录）发现机制；④ 1M 窗口 + token caching + 历史压缩。[来源](https://github.com/google-gemini/gemini-cli)

**OpenHands（原 OpenDevin）** — 已重构为多仓库：事件流内核 SDK（Python）+ TS 前端。要点：① **Condenser 体系**：`CondenserBase.condense()` 抽象；`LLMSummarizingCondenser` 保留头部 keep_first 条 + 近期尾部、中间用便宜模型摘要，产出带 `forgotten_event_ids` 的 Condensation 事件，下一步 `View.from_events()` 重建视图——压缩只是视图，事件永不丢；自动触发（每步检查）+ 溢出错误后手动触发双机制；② Action/Observation/Executor 类型化工具协议 + 安全风险分级；③ Agent Server 把循环做成 REST/WebSocket 服务，暴露 OpenAI 兼容端点。[来源](https://docs.openhands.dev/sdk/arch/condenser)

**SWE-agent（Princeton，已被 mini-swe-agent 接棒）** — 核心遗产是 **ACI（Agent-Computer Interface）** 设计准则，每条都有论文消融支撑：带 lint 回拒的编辑命令（写坏了立刻报错）、只显示 100 行的文件查看器（防上下文爆炸）、只列文件名的搜索（防输出淹没）、空输出回执（明确「成功但无输出」）。一个 YAML 即一个完整 harness（模板+工具+环境）。[来源](https://swe-agent.com/latest/background/aci/)

**goose（Block → Linux 基金会 AAIF）** — 要点：① **MCP 作为唯一插件协议**（70+ extensions 全走 MCP，零自研插件 API）；② lead-worker：贵模型规划、便宜模型执行的成本分层 subagent；③ 权限四级（approve-all / smart / manual / chat-only）+ recipe（YAML 参数化可嵌套任务模板）+ 内置 cron。[来源](https://github.com/block/goose)

### 2.4 框架类项目要点

**LangGraph + LangChain 1.0** — durable execution 事实标准。要点：① **Checkpointer**（thread 级短期，按 `thread_id` 恢复）+ **Store**（跨线程长期，命名空间+语义检索）双持久化；② **interrupt/resume** HITL 原语：暂停时状态可被外部改写再恢复；time travel 回放；③ LangChain 1.0 的 `create_agent` = 最小可配置 harness（prompt+tools+middleware），SummarizationMiddleware/HITL/guardrails 全是 middleware；④ deepagents 包 = Claude Code 式「电池全含」agent（规划+虚拟文件系统+子代理+自动压缩，85% 阈值触发、保留 10% 最近原始消息、>20K token 大对象落盘换指针）。[来源](https://docs.langchain.com/oss/python/deepagents/context-engineering)

**Microsoft Agent Framework** — AutoGen(维护模式)+Semantic Kernel 的合体。要点：① **HarnessAgent**：chat client → chat pipeline（函数调用/历史持久化/可选 compaction）→ context providers（todo/模式/记忆/技能）→ middleware（审批/观测/有界循环）→ 应用 UX；② 五种预置编排：sequential / concurrent / handoff / group-chat / Magentic；③ workflow checkpoint + time-travel + 「workflow 也能当 agent 用」的双向抽象；④ 每个出厂能力都有 Disable 开关的组合式设计。[来源](https://learn.microsoft.com/en-us/agent-framework/concepts/harness)

**OpenAI Agents SDK** — Swarm 生产化。要点：① **handoff** 一等公民（tool 名/描述覆盖、`input_filter` 过滤交接输入、`on_handoff` 回调）vs **agents-as-tools** 双委托模型，官方给选型指南；② guardrails 与 agent 执行并行、fail-fast；③ sessions 多后端（SQLite/Redis/Mongo/加密…）；④ 内置 tracing + 自定义 trace processor。[来源](https://openai.github.io/openai-agents-python/handoffs/)

**CrewAI** — 要点：① **统一 Memory**（2026 重构）：LLM 驱动 remember() 自动推断 scope/类别/重要性；召回打分 = 语义相似度 0.5 + 时间衰减 0.3（30 天半衰期）+ 重要性 0.2；写入时 LLM 合并去重（相似阈值 0.85）；默认 LanceDB 后端；② Crews（自治协作）+ Flows（`@start/@listen/@router` 装饰器确定性编排）双范式；③ hierarchical process 内置 manager agent 的「规划-分配-审查-验收」闭环。[来源](https://docs.crewai.com/concepts/memory)

**Google ADK** — 要点：① **四服务化**：SessionService / MemoryService / ArtifactService / （State 内嵌于 Session，`temp:/user:/app:` 作用域前缀），接口+多后端从本地到云平滑升级；② 记忆注入双模式：Preload（每轮自动注入）vs Load tool（模型自取）+ after_agent_callback 自动回写；③ **评测最强**：`adk web` 录制会话为 evalset → RecordingsPlugin 录制 golden baseline → Replay 模式回归对比，可进 CI 门槛（conformance test）。[来源](https://adk.dev/evaluate/)

**其他**：smolagents 的 Code-as-Action（一次 LLM 调用写一段 Python 含多工具调用与控制流，实测少 30% 步数）与 PlanningStep 周期性重规划、`replay()` 确定性重放；pydantic-ai 的 Capabilities 可拼装块（`Coder() = FileSystem + Shell + RepoContext + SubAgents + ClearToolResults + WarnNearLimits`）、每次模型/工具调用都是可恢复 Activity 的持久化执行、pydantic_evals「pytest 化」评测与 TestModel 无 key 单测；agno 的 Team 三模式（route/coordinate/collaborate）+ 数据全落自建库；AgentScope 的 tool-result offloading（工具大输出落盘、上下文只留引用）与覆盖 reply/reasoning/acting/压缩全环节的中间件、最全的多 agent 谱系（debate/handoffs/routing/msg-hub/team）；MetaGPT 的 SOP 角色订阅-发布与中间产物文件化；elizaOS 的 Providers 动态上下文注入与七类类型化记忆（message/fact/document/relationship/goal/task/action）；Dify 的插件四分类 marketplace；AutoGPT 的触发器三件套与 block 显式 IO。

### 2.5 记忆专项项目要点

**Letta（MemGPT 后继）** — OS 式虚拟上下文管理。① **Memory Blocks**：常驻上下文的可编辑记忆块（label/value/description/limit 字符上限；每块 <50k 字符、每 agent <20 块；上下文中带 `chars_current/chars_limit` 元数据）；agent 用 `memory_insert/replace/rethink` 工具自编辑；② **Recall**：全量消息库 + 检索（部分驱逐约 70% 时做递归摘要，旧内容影响递减）；③ **Archival**：向量库（每 passage ≈300 token）+ `archival_memory_insert/search`；④ **sleep-time agents**：后台子代理复盘会话、沉淀教训到 git-backed 记忆文件系统（MemFS），空闲算力换推理时压缩（同等准确率 test-time compute 降约 5x）；⑤ **共享 blocks**：一个 block 挂多个 agent 即共享记忆（敏感块可 read_only）。[来源](https://docs.letta.com/guides/agents/memory-blocks)

**mem0** — 对话后处理式记忆服务：Phase1 抽取候选事实（滚动摘要+最近 10 条+新消息对）→ Phase2 对账：取 top-10 相似既有记忆，LLM 决策 ADD/UPDATE/DELETE/NOOP；双通道检索（语义+BM25+实体加权）；2026 v3 转向 single-pass ADD-only + 原生实体共现图（注意：社区反馈旧矛盾事实可能残留）。**OpenMemory MCP**：本地自托管记忆 MCP server，任何 MCP 客户端即插即用、跨应用共享、数据不出本机。[来源](https://arxiv.org/abs/2504.19413)

**Zep / Graphiti** — 时序知识图谱：episode 子图（原始输入无损）+ 实体子图（摘要+facts）+ 社区子图（label propagation 增量扩展）；**bi-temporal**：每条 fact 记 `t_valid/t_invalid`（世界时间线）+ `t'_created/t'_expired`（系统时间线），矛盾时旧边设 `t_invalid` 而非删除——可回答「某时点哪些事实成立」；混合检索（余弦+BM25+图遍历）→ 重排（RRF/MMR/cross-encoder）。LongMemEval 上 gpt-4o +18.5%，上下文 115k→1.6k token。[来源](https://arxiv.org/abs/2501.13956)

**LangMem** — CoALA 三分类落地：semantic（profile 单文档就地更新 vs collection 多条检索+对账）/ episodic（Episode(observation, thoughts, action, result)）/ procedural（prompt 优化器从带评分轨迹反思改写）；**hot path**（agent 工具即时读写，快但加延迟）vs **background**（对话后异步反思抽取，recall 高）双写入路径。

**Anthropic memory tool（Claude 平台，2025-09 beta）** — 完全 client-side 的 `/memories` 文件目录 + 六命令（view/create/str_replace/insert/delete/rename）；与 context editing 组合：editing 清过程性旧工具结果，memory tool 把要存活的结论外置。官方数字：两者组合在内部 agentic search 评测 **+39%**，100 轮 web search 流程 token 降 **84%**。[来源](https://claude.com/blog/context-management)

### 2.6 横向趋势与洞察

1. **形态趋同**：编码 agent（Claude Code/Codex/Gemini CLI）与通用框架（LangGraph/MAF/ADK）正在互相吸收——subagents、SKILL.md、hooks、compaction、审批沙箱成为通用底座能力；MAF 直接把 HarnessAgent 做成一等概念。
2. **MCP 赢得工具协议之争**：goose 干脆只留 MCP 一种插件协议；Codex/Claude Code/Gemini CLI/ADK/MAF 全部一等支持。MCP 规范 2026-07-28 版（"2.0"）核心无状态化、Extensions 框架化（Tasks、MCP Apps 为首批扩展；Roots/Sampling/Logging/DCR 弃用）。
3. **上下文工程从技巧变机制**：compaction/tool-result clearing/offload 从博客技巧沉淀为 API 特性（Anthropic context editing、OpenAI encrypted compaction item、LangChain SummarizationMiddleware）。共识阈值：**压缩触发 75-85% 窗口**、**保留最近 ~10% 原始消息**、**工具结果清理保留最近 N 次**、**>20K token 大对象外置换指针**。
4. **记忆的三个流派**：agent 自编辑 in-context blocks（Letta）> 对话后处理抽取管线（mem0）> 时序知识图谱（Zep）。实证倾向：对小规模高信号状态，**文件系统 + agentic 检索** 已能胜过专用检索管线（Letta Filesystem LoCoMo 74.0% vs mem0 68.5%）。
5. **多 agent 的冷思考**：Anthropic 实测多 agent 研究系统较单 agent **+90.2%**，但 token 烧 **~15x**；编码类强依赖任务（共享上下文）场景反而不适合。LangChain 基准发现 supervisor 有「传声筒」损耗（转述丢真），swarm 略优。结论：多 agent 是工具不是信仰，按任务复杂度伸缩（effort scaling 写进 prompt）。
6. **安全=沙箱×审批×规则三层**：OS 沙箱管「能做什么」，审批策略管「何时问人」，规则引擎（含参数级 pattern）管「细粒度黑白名单」。三者正交组合是 Codex/Claude Code/Gemini CLI 的共同演化方向。
7. **评测内建化**：ADK 的录制回放 conformance、pydantic_evals 的 pytest 化、Anthropic 的 Task/Trial/Grader 术语体系——评测从事后活动变成 harness 的一等模块。

---

## 3. 总体架构

### 3.1 设计原则

1. **上下文是第一公民**。每个模块的设计都要回答「它让上下文变大还是变小、是高信号还是噪声」（Anthropic：找**最小高信号 token 集**；Manus：KV-cache 命中率是最重要的单一指标，agent 输入:输出 ≈ 100:1，cached 与 uncached 输入价差 ~10x）。
2. **事件溯源**。会话 = append-only 事件日志（学 OpenHands）；压缩只是重建「视图」，原始事件永不丢；resume/fork/回放/审计全部免费获得。
3. **一切可插拔**。Provider/Tool/Store/Condenser/Sandbox/Orchestrator 都是协议接口 + 默认实现；出厂能力像 MAF 一样每个可关。
4. **安全默认**。工具默认过权限闸；写操作先打 shadow checkpoint；工具输出视为不可信数据（防注入）。
5. **简单优先**。"do the simplest thing that works"——数据小就放上下文，先文件后向量后图谱；每个机制先做最轻版本。
6. **可还原压缩**。不可逆压缩很危险（Manus）：丢内容必须留指针（URL/路径），大对象落盘。

### 3.2 分层架构图

```
┌────────────────────────────────────────────────────────────────┐
│  交互层 Interface  Desktop(Electron+React) │ CLI/TUI │ Python SDK  │
│  Local Server(WS/SSE)：流式输出│HITL 审批│成本面板│多会话管理      │
├────────────────────────────────────────────────────────────────┤
│  编排层 Orchestration                                          │
│    Subagent(隔离上下文) │ Orchestrator-Worker │ Handoff          │
│    Team(共享任务列表)   │ A2A client/server(远期)                │
├────────────────────────────────────────────────────────────────┤
│  Agent 运行时 Runtime                                          │
│    Agent Loop(ReAct 默认) │ 策略: Plan-Execute/CodeAct/Reflect   │
│    中断/steering │ 预算与步数上限 │ 结构化输出                    │
├──────────────┬─────────────────────────┬───────────────────────┤
│  上下文引擎    │  记忆系统 Memory         │  工具系统 Tools        │
│  token 预算   │  短期: memory blocks    │  ToolRegistry         │
│  Condenser    │  情景: 事件日志+检索     │  Executor(超时/截断)   │
│  管道         │  语义: 事实库(文件+向量) │  内置工具集            │
│  工具结果清理  │  程序性: AGENT.md       │  MCP Client           │
│  大对象外置    │  整理: 后台合并/去重     │  Skills 加载器         │
├──────────────┴─────────────────────────┴───────────────────────┤
│  模型层 Provider                                                │
│    OpenAI│Anthropic│Gemini│DeepSeek│GLM│Ollama…                 │
│    流式│工具调用规范化│结构化输出│prompt cache│重试/熔断│计费       │
├────────────────────────────────────────────────────────────────┤
│  横切层 Cross-cutting                                           │
│    会话持久化(事件溯源+SQLite) │ 权限&规则引擎 │ Hooks            │
│    沙箱适配器(local/Docker) │ OTel 观测 │ 评测 harness │ 插件     │
└────────────────────────────────────────────────────────────────┘
```

### 3.3 核心数据模型

```python
# —— 事件溯源核心 ——
class Event(BaseModel):            # 会话内一切皆事件，append-only
    id: str; seq: int; ts: datetime
    type: EventType                # USER_MESSAGE / ASSISTANT_MESSAGE / TOOL_CALL_STARTED
                                   # / TOOL_CALL_COMPLETED / PERMISSION_DECISION
                                   # / COMPACTION_OCCURRED / SUBAGENT_SPAWNED
                                   # / HANDOFF_OCCURRED / MEMORY_UPDATED / ERROR / ...
    payload: dict

class Session:                     # 一次会话 = 一条事件流
    id: str; events: EventStore    # SQLite + JSONL 双写
    metadata: dict; agent_md_paths: list[Path]

class Run:                         # 一次 agent loop 调用
    session: Session
    status: Running|Done|Failed|Cancelled|AwaitingApproval
    budget: Budget                 # max_turns / max_tokens / max_usd（含子代理树）
    usage: Usage                   # tokens/cost/turns 累计

class Message:                     # 规范化消息（与 Provider 无关）
    role: user|assistant|system|tool
    blocks: list[TextBlock|ToolUseBlock|ToolResultBlock|ImageBlock|ThinkingBlock]

# —— 工具 ——
class ToolSpec:
    name: str                      # 命名空间: bash / mcp__github__create_issue
    description: str; parameters: JSONSchema
    annotations: ToolAnnotations   # readOnlyHint / destructiveHint / openWorldHint
    source: builtin|mcp|skill|plugin
    permission_tag: str

# —— 记忆 ——
class MemoryBlock:                 # in-context 短期记忆（学 Letta）
    label: str; value: str
    description: str; limit_chars: int = 5000

# —— 多 agent ——
class AgentSpec:                   # subagent/team 成员的静态定义
    name: str; system_prompt: str
    tools: list[str]; model: str
    permission_mode: PermissionMode
    memory_scope: str | None
```

### 3.4 一次典型运行的时序

```
用户输入
  → [交互层] 校验 → 追加 USER_MESSAGE 事件 → 创建 Run
  → [上下文引擎] 组装本轮请求：system prompt（稳定前缀）
      + AGENT.md/记忆 blocks（程序性+短期记忆注入）
      + 工具定义（内置+MCP 已连接+已激活 Skills，masked-not-removed）
      + 历史视图（事件流 → View：原始区 + 摘要区 + 占位符区）
      → 预算检查：>85% 窗口 → 先触发 compaction
  → [Provider] 发请求（带 cache breakpoints，append-only 前缀）
  ← 流式返回：文本 / tool_use 块
  → [运行时] 逐个 tool_use：
      → [权限引擎] 规则匹配（deny→ask→allow）→ 需要时问人（HITL）/ hooks 预检
      → [沙箱] 按工具注解选择执行环境（local / Docker / MCP server）
      → [执行] 超时/重试/幂等控制 → 结果截断（≤25K token，留信号）
      → 追加 TOOL_CALL_* 事件 → 结果回填消息流
  → 循环（每个 tool_result 都要回填，直到纯文本回复 or 预算耗尽）
  → [整理] 后台任务：记忆抽取/合并（非阻塞）→ 追加 MEMORY_UPDATED 事件
  → [交互层] Result（usage/cost/stop_reason）→ 事件流持久化，可 resume/fork
```

---

## 4. 模块设计

### 4.1 模型接入层 Provider

**职责**：把 20+ 家模型的差异吞掉，向上只暴露一种规范。

- **统一接口**：`chat(messages, tools, stream, response_format, cache_control) -> Stream[Chunk]`；Chunk 含 text delta / tool_call delta / usage / finish_reason。
- **规范化**：工具调用协议统一为「content blocks」模型（Anthropic 风格），OpenAI 式 `tool_calls` 数组在其适配器内转换；`tool_choice: auto/any/tool`、`disable_parallel_tool_use` 对齐。
- **prompt cache**：接口显式暴露 cache 断点；适配器负责各家语义（Anthropic `cache_control`、OpenAI 自动前缀缓存、Gemini explicit cache）；**harness 侧保证稳定前缀 + append-only + 确定性序列化**（禁止在 system prompt 放当前时间戳；JSON 序列化 key 顺序固定）。
- **可靠性**：指数退避重试（区分 429/5xx 可重试 vs 400 不可重试）、多 Provider 熔断降级（主模型挂了切备用）、速率限制。
- **计量**：每次调用记录 tokens（input/output/cache read/write）与成本（价格表可配置），写入事件流供成本面板聚合。
- **token 计数**：优先 Provider 的 count-token API，fallback tiktoken/字符估算（预算管理用）。

### 4.2 Agent Loop 运行时

**主循环（默认 ReAct）**：组上下文 → 调模型 → 若有 tool_use：权限闸 → 执行 → 结果回填 → 继续；若无：结束。三条铁律：① 每个 `tool_use` 必须有对应 `tool_result`（失败也回填 `is_error`）——in-flight 调用在 compaction 时也要配对保持（学 Deep Agents 的 PatchToolCalls）；② 「模型记得自己做过什么，只是不记得每行输出」——清理只动工具结果，不动动作史（Claude Code microcompact）；③ 错误保留在上下文中（Manus：抹除失败就抹除了证据）。

**可插拔策略**（Strategy 模式，接口 `RunStrategy`）：
- `ReactLoop`（默认）：上文的直循环。
- `PlanExecute`：先出计划（可 HITL 批准），按计划逐步执行，执行器可回头修订计划；todo.md 常驻并周期性「复诵」到上下文尾部（Manus 对抗 lost-in-the-middle 的做法）。
- `CodeAct`（学 smolagents，v2）：动作 = 一段沙箱内执行的 Python 代码（可含多工具调用与控制流），减少往返步数。
- `Reflexion`：失败后附加自我反思消息再重试（有限次数）。

**运行控制**：`max_turns` / `max_tokens` / `max_usd`（覆盖整棵子代理树，学 Claude Agent SDK）；用户可随时插话 steering（流式输入进队列，下一轮注入）；中断（Cancel）后事件流保持一致，可 resume；计划模式（plan mode）= 只读工具白名单。

**结构化输出**：final answer 可绑定 Pydantic schema，适配到各家 structured output / tool-forced 抽取。

### 4.3 工具系统（Tool Calling / MCP / Skills）

#### 4.3.1 工具设计与执行管道

**设计规范**（依据 Anthropic《Writing effective tools for agents》与 SWE-agent ACI）：
- 面向工作流合并工具：`search` 优于 `list`，`schedule_event` 优于 `list_users+list_events+create_event`；工具集小而精（实验：每次只暴露 3-5 个相关工具可提约 3 倍准确率）。
- 命名空间前缀：`github__create_issue`、`mcp__<server>__<tool>`。
- 高信噪返回：给可读名不给 UUID；提供 `response_format: CONCISE|DETAILED` 枚举；分页+过滤+默认截断（**工具结果硬上限 25K token**，截断提示语引导 agent 做多次小搜索）。
- 错误消息写给 agent 看不给人看：给具体修复建议与正确输入示例，不给裸堆栈。
- ACI 细节：编辑命令写坏立刻 lint 回拒；查看器限制行数；空输出回执「成功但无输出」。

**执行管道**（Decorator/Chain 模式）：

```
tool_use → [hook: PreToolUse] → [权限闸: 规则+审批] → [沙箱选择]
        → [执行: 超时/重试(区分网络错误 vs 逻辑错误)/幂等键]
        → [后处理: 截断/格式化] → [hook: PostToolUse] → tool_result
```

- 超时默认 60s（可按工具配置）；长任务用后台执行+进度轮询。
- 并行工具调用：无副作用的只读工具可并行执行，写类工具串行。

#### 4.3.2 内置工具集（M0 范围）

`bash`（前台/后台）、`read_file`（行号+范围+限行）、`write_file`、`edit_file`（str_replace + lint 回拒）、`glob`、`grep`（只列文件名模式）、`web_search`、`web_fetch`（私网 IP 校验）、`todo_write`（复诵目标）、`subagent`（见 4.6）、`memory_*`（见 4.4）。

#### 4.3.3 MCP 客户端

- **多传输**：stdio（本地进程拉起/回收）+ Streamable HTTP（远程，含 OAuth：PKCE + resource indicator 绑定 token）；对齐 2026-07-28 规范的无状态核心，兼容旧版 initialize 握手。
- **工具接入**：`tools/list`（分页）→ 映射为本地 `ToolSpec`（命名空间 `mcp__<server>__<tool>`）→ 监听 `list_changed` 刷新缓存；处理 text/image/resource 多种 content；**参考 `readOnlyHint/destructiveHint` 注解决定确认策略**。
- **延迟加载**（学 Claude Code ToolSearch/deferred loading）：连接多个 server 时工具定义不全量进上下文，先给 agent 一个 `tool_search` 工具按需取 schema——多 MCP 场景省 token 且保护 KV-cache。
- **运维**：每请求超时、server 崩溃重启退避、per-server 工具 allow/deny 列表、健康状态在 CLI 面板可见。

#### 4.3.4 Skills（程序性知识包）

- **格式**：对齐开放标准 agentskills.io——一个目录 + `SKILL.md`（frontmatter：`name` 与目录同名、`description` ≤1024 字符写清「做什么+何时用」；可选 `allowed-tools` 预授权工具）；附属 `scripts/`、`references/`、`assets/`。
- **渐进式披露三级**：L1 启动时只有 name+description（~100 token）进系统提示 → L2 判定相关才载入正文（<5K token）→ L3 脚本/参考按需读取/执行（**脚本直接执行不读进上下文**，要求 code execution 能力）。
- **与 MCP 分工**：MCP 管连接性（接工具/数据），Skills 管程序性知识（教 agent 怎么用好工具）；本项目内置技能（如 xlsx 处理、git 操作规范）与用户技能目录（全局 `~/.my-harness/skills` + 项目 `.my-harness/skills`）。

### 4.4 记忆系统（短期 / 长期 / 压缩）

**四层模型**（CoALA 分类 + Letta/Anthropic/langmem 实践落地）：

| 层 | 内容 | 存储 | 进上下文方式 |
|---|---|---|---|
| 短期 Working | 当前任务活状态：目标、决策、TODO、关键结论 | **Memory blocks**（内存+持久化到 session） | 每轮注入 system 区，带 `chars_current/limit` |
| 情景 Episodic | 完整事件日志（永不删） | SQLite 事件表 | 不注入；提供 `search_history` 检索工具 |
| 语义 Semantic | 抽取的用户/项目/世界事实 | **文件优先**（Markdown 知识库）+ 可选向量索引 | `memory_search` 工具按需取（JIT） |
| 程序性 Procedural | 规则、偏好、工作流 | **AGENT.md**（全局/项目/子目录三层，学 CLAUDE.md/GEMINI.md） | 每轮注入（稳定前缀，护 KV-cache） |

**关键机制**：
1. **记忆即工具**：agent 用 `memory_write/memory_update/memory_search` 自己读写（Anthropic memory tool 六命令为最小集：view/create/str_replace/insert/delete/rename，映射到 `/memories` 目录）；这比纯自动管线好——agent 知道什么值得记（Anthropic 评测：memory tool + context editing 组合 +39%）。
2. **双写入路径**（学 langmem）：hot path（agent 工具即时写，快但占轮次）+ **background**（会话结束/每 N 步异步反思抽取事实，非阻塞，学 CrewAI/elizaOS）；两路写入同一合并管道。
3. **合并与去重**（学 CrewAI/mem0）：新事实取 top-10 相似既有记忆 → LLM 决策 ADD/UPDATE/DELETE/NOOP；向量 ≥0.98 直接去重；矛盾不删而是**标记失效 + 时间线**（学 Zep bi-temporal 的简化版：事实带 `valid_from/invalid_at`）。
4. **召回排序**（学 CrewAI）：score = 0.5×语义相似 + 0.3×时间衰减（30 天半衰期）+ 0.2×重要性；top-k 注入有预算上限。
5. **整理与审计**：sleep-time 式后台整理（合并重复块、拆大文件、审计 system prompt 占用，学 Letta dreaming + `/doctor`）；`memory stats` 命令展示各层大小。
6. **安全**：per-project/per-user 作用域隔离；不存 secrets/PII（写入时正则拦截）；记忆读回时按不可信数据对待（防 memory poisoning）；共享 blocks（多 agent 场景）默认 read_only。

**为什么文件优先**：Letta 实证「文件系统 + agentic 检索（grep/open）」在 LoCoMo 上 74.0% 胜过专用向量管线 68.5%——经过 agentic 训练的模型极擅长文件工具；向量索引作为加速层可选挂载，bi-temporal 图谱留作 v2 扩展点（强时序关系需求时）。

### 4.5 上下文引擎

**Token 预算**（对齐业界数字）：

| 区 | 预算策略 |
|---|---|
| system prompt + AGENT.md + blocks | 稳定前缀，尽量小（高信号原则），目标 <5K |
| 工具定义 | 内置精简；MCP 延迟加载；被禁用工具**屏蔽不删除**（护 cache） |
| 历史视图 | 主体；受压缩策略治理 |
| 本轮输出 | 预留 8K+ |

 degradation 阶梯（渐满时依序触发）：

**压缩管道（Condenser 管道，学 OpenHands/Deep Agents）**——`Condenser` 接口：`condense(events) -> View`，多种实现可串联（Pipeline 模式）：

1. **ToolResultClearing**（最轻，先触发）：阈值 `input_tokens > 30K`（可配）→ 把旧的工具结果替换为占位符 `[cleared: bash output 12.3K tokens]`，保留最近 N=3 次 tool use 原文；按 `tool_use_id` 配对保持合法性；memory/todo 工具豁免。
2. **LargeObjectOffload**：>20K token 的工具输入/输出 → 落盘 artifacts/，上下文留「路径 + 前 10 行预览」指针（可还原压缩）。
3. **SummarizingCompaction**（重锤）：触发阈值 **85% 窗口**（学 Deep Agents；Claude Code 新版 ~75-80%）→ 结构化摘要（用便宜模型）：**session intent + 已产出 artifacts（路径）+ 关键决策 + 未决问题 + next steps**（显式防 brevity bias 丢约束）；保留最近 ~10% 原始消息；压缩前全量渲染文本落盘（canonical record，可找回）；产出 `COMPACTION_OCCURRED` 事件（原始事件仍在，View 重建）；压缩后自动重读最近访问的 5 个文件（学 Claude Code）。
4. **Thrashing 保护**：若压缩后窗口再次迅速 >85%，重试 2 次后报错终止而非死循环（学 Claude Code）。

**KV-cache 纪律**（写进代码规范）：system/工具定义/记忆注入区是稳定前缀（禁止放时间戳/随机数）；消息 append-only，序列化确定性；压缩是「例外事件」而非常态；每轮请求带 cache 断点并记录命中率（Manus：这是生产 agent 第一指标）。

**复诵**（Recitation）：todo.md 勾选状态每 N 步重写进上下文尾部——目标常驻注意力最强位置，防长任务漂移。

### 4.6 多智能体编排

**原语（v1）**：
1. **Subagent**（Agent-as-Tool）：`spawn(spec, task) -> summary`；子 agent 全新 Session（不带父历史，带 AGENT.md/记忆），独立预算，**只回传最终摘要**（典型 1-2K token，Anthropic 上下文经济学的核心）；可并行 fan-out；结果大对象走文件系统传递（**上下文交接损耗**的解法：写盘留引用，学 Anthropic 研究系统）。
2. **Orchestrator-Worker**：lead 负责拆解/派发/聚合；**effort scaling 规则写进 lead 的 prompt**：简单事实 1 agent 3-10 次工具调用；对比类 2-4 subagents 各 10-15 次；复杂研究 10+ subagents 分工（Anthropic 实测 +90.2%，代价 ~15x token——因此默认开预算护栏）。
3. **Handoff**（学 OpenAI Agents SDK）：agent 间控制权移交（可带 `input_filter` 过滤交接输入）；适用于分诊→专家的接线模式。
4. **Team**（v2，学 Claude Code agent teams）：3-5 个对等 agent + 共享任务列表（认领/依赖/完成态）+ 消息互发；适合需要互查/讨论的自组织场景。

**模式库**（模板形式提供）：pipeline（链式）、map-reduce fan-out（并行调研）、debate（正反方+裁判）、evaluator-optimizer（生成-评审循环）、blackboard（共享工作区各专家认领）、SOP（MetaGPT 式角色订阅-发布，用 Team+规则实现）。

**反模式警示**（写进文档）：需要全员共享单一上下文或强相互依赖的任务（多数编码任务）不要上多 agent；任务价值不足以摊 15x token 成本时不要上；supervisor 有「传声筒」损耗（LangChain 基准），能让子 agent 直接对用户说话就别转述。

**协议（远期）**：A2A client/server（Agent Card 发现 + Task 生命周期 + Artifact），让外部 agent 系统接入为「远程 subagent」；AG-UI 事件协议用于 Web 前端对接（16 种标准事件）。

### 4.7 会话持久化与事件溯源

- **双写存储**：SQLite（结构化事件表，供查询/统计）+ JSONL（`~/.my-harness/projects/<proj>/<session>.jsonl`，人类可读可 rsync，学 Claude Code）。
- **resume / fork**：按 session_id 恢复（重建 View 继续跑）；fork 复制事件流分支（原会话不动）。
- **Checkpoint**：Run 级快照（消息+blocks+todo+usage），进程崩溃后从断点恢复；长工作流每个 super-step 落盘（学 LangGraph durable execution）。
- **Shadow git**（学 gemini-cli）：harness 修改的每个文件在 `~/.my-harness/history/<hash>` 影子仓库打快照；`/rollback` 连同对话状态一起恢复到任一工具调用前。
- **回放**：事件流 → 逐事件重放可复现任意历史时点的上下文视图（调试利器，也是评测 conformance 的基础，学 ADK RecordingsPlugin）。

### 4.8 安全：权限、Hooks 与沙箱

**权限模式**（学 Claude Code/Codex，正交于沙箱）：

| 模式 | 行为 |
|---|---|
| `default` | 写类工具逐个首次确认，只读放行 |
| `acceptEdits` | 自动接受文件编辑与常见安全命令 |
| `plan` | 只读白名单，产出计划待批准 |
| `dontAsk` | 会弹窗的一律自动拒绝 |
| `bypass` | 全放行（仅容器内使用，CLI 需显式 flag） |

**规则引擎**：`Tool(specifier)` 语法（`Bash(git push *)`、`Edit(/src/**/*.ts)`、`mcp__*`、参数级 `Agent(model:opus)`）；评估顺序 **deny → ask → allow，先匹配先赢**；路径规则用 gitignore 语法；裸工具名 deny 直接把定义从上下文屏蔽（mask-not-remove，护 cache）。

**Hooks**（事件驱动扩展点，跑在宿主进程）：SessionStart/End、UserPromptSubmit、**PreToolUse/PostToolUse**、PermissionRequest、Stop、SubagentStart/Stop、PreCompact、MemoryUpdated…；hook 返回 JSON 可 `deny` / `ask` / 改注入 `additionalContext` / 改工具入参；exit code 2 = 阻断。硬安全规则走权限引擎，hooks 是软扩展（best-effort）。

**沙箱适配器**（`SandboxBackend` 接口）：
- `local`（默认）：权限闸 + shadow git 兜底，适合个人开发机；
- `docker`：每会话一容器（学 OpenHands），workspace 挂载可写、网络默认关、可配 writable_roots 白名单；
- `wasm/微虚拟机`（远期评估）。

**注入防御**（ lethal trifecta 意识）：私有数据 + 不可信内容 + 外呼通道齐备时注入实质无解，架构上拆掉其一——① 工具输出明确标注为数据（delimiting/data marking，spotlighting）；② 注入高危工具（发邮件/删库）默认 ask；③ 外发类动作做二次确认与域名白名单；④ 记忆/skill 来源审计，不可信 skill 安装前 diff 审查。

### 4.9 可观测性与评估

**追踪**：OpenTelemetry GenAI 语义约定（`invoke_workflow → invoke_agent → execute_tool / chat` span 层级；`gen_ai.*` token/duration 指标；MCP span `{mcp.method.name} {target}`）；本地默认写 JSONL trace，一键导出 OTLP（Langfuse/Jaeger 自选）；每 Run 汇总 cost/latency/token 明细（成本面板）。

**评测 harness**（对齐 Anthropic《Demystifying Evals》）：
- 术语：**Task**（输入+成功标准）/ **Trial**（单次运行，多 trial 统计）/ **Grader**（打分器，可多个）/ **Transcript**（完整事件流）。
- Grader 三类：代码断言（快/客观/脆，含 fail-to-pass 测试）、LLM-as-judge（rubric + 0.0-1.0 评分 + pass/fail + "Unknown" 逃生口）、人工（校准 judge 用）。
- **评产出不评路径**：默认 outcome 检查（环境最终状态），trajectory 只作辅助诊断。
- 指标：`pass@k`（编码类，至少一次成功）与 `pass^k`（一致性，k 次全成功；单次 75% → 3 次 ≈42%）；从 **20-50 个真实失败案例** 起步建集；0% pass@100 通常说明任务坏了而非 agent 不行。
- **录制回放 conformance**：录制 golden run（含 stub 的 LLM 响应）→ CI 中回放比对（学 ADK），保证重构不回归；TestModel 假模型做无成本单测（学 pydantic-ai）。

### 4.10 扩展体系：Hooks / Middleware / Plugin

- **Middleware**（进程内，类型安全）：包裹 LLM 调用与工具执行的 async 管道（重试/限流/缓存/日志/PII 过滤/Summarization…），学 LangChain/AgentScope——横切关注点的正解。
- **Hooks**（进程外）：shell 命令/HTTP webhook，覆盖全生命周期，用户可用任意语言写。
- **Plugin**（打包分发）：一个 plugin = skills + tools(MCP 配置) + hooks + AGENT.md 片段 + 斜杠命令 的 tar 包；`my-harness plugin add <path|registry>`；内置四类能力分类治理（tool/model/extension/agent-strategy，学 Dify）。
- **配置**：`my-harness.toml` 声明式（学 Codex）：providers、mcp_servers、permissions、sandbox、memory、profiles（预设组合，如 `profile="safe"` = plan 模式 + docker 沙箱）。

### 4.11 交互层：CLI / Desktop / SDK / Local Server

**总原则：内核即服务，界面皆客户端。** 所有界面（CLI、桌面端、第三方前端）都通过同一个「本地服务 + UI 事件协议」与内核交互——会话是事件流，界面只是事件流的订阅者与命令发送者（ZCode / Claude Desktop 的形态）。这反过来强化分层：协议先行，CLI 永远兜底，UI 迭代不阻塞内核。

**Local Server（daemon）**
- FastAPI + WebSocket（主通道，双向）+ SSE（只读降级）；`my-harness serve` 拉起，单机托管多会话；桌面端启动时自动拉起/复用单实例（单实例锁）。
- **UI 事件协议（协议即产品，M0 定 schema、M1 上线）**：
  - 服务端→客户端：`RunStarted / TokenDelta / MessageCompleted / ToolCallStarted / ToolCallResult(卡片载荷：bash 输出/diff/网页摘要) / PermissionRequest(带选项与风险标注) / TodoUpdated / CompactionOccurred / ContextStats(占用分解) / CostUpdated / SessionChanged / RunFinished(usage)` 等约 16-20 个类型化事件——分类对齐 AG-UI 的五类标准事件（生命周期/文本流/工具调用/状态同步/通用）。
  - 客户端→服务端：`CreateSession / ResumeSession / SendMessage / Steer(插话) / CancelRun / RespondPermission / SetPermissionMode / InvokeSlashCommand / ManageMemory / ManageMcp`。
  - schema 用 Pydantic 单一定义，CI 生成 TypeScript 类型（datamodel-code-generator），前后端契约永不漂移。
- 兼容端点：OpenAI 兼容 `/v1/chat/completions`（学 OpenHands Agent Server）；AG-UI 适配器留 v2。

**CLI**：typer + rich 流式渲染；核心命令 `my-harness run / chat / resume / sessions / memory / mcp / skills / eval / cost / serve`；斜杠命令（/compact /clear /rollback /context 占用分解 /model 切换）；HITL 审批（diff 展示 + y/n/a-always）。CLI 默认进程内直连内核，也支持 `--server` 模式接 daemon——两条路径共用同一协议。

**Desktop（Windows 优先，对标 ZCode）**
- **技术选型：Electron + React 19 + TypeScript（v0.2.2 确认，替代 Tauri）**。内核经 PyInstaller 打包为 sidecar 由 Electron 主进程拉起；自带固定版 Chromium，三平台渲染一致。代价照实记录：安装包 ~80-150MB+（壳 + Python sidecar）、内存高于系统 WebView 方案。换选原因：Tauri 2 实际使用中 bug 太多（工程判断，2026-10），优先开发效率与生态成熟度——Electron 的安装器/自动更新（electron-builder + electron-updater）/崩溃上报/多窗口/托盘全部是现成件，与 ZCode/Claude Desktop 同路线，踩坑成本最低。UI 层是 TypeScript 不改变内核 Python 的选型——本地服务边界让语言解耦（Codex：Rust 内核 + TS UI 同理）。
- **首版功能清单**：
  - 会话：侧栏列表/搜索/resume/fork/删除；多会话并行运行，后台徽标 + Windows 通知（完成/待审批）；
  - 对话区：流式 Markdown + 代码高亮 + 一键复制/应用；thinking 折叠；消息级「回到此处 fork」；
  - 工具卡片：bash 输出（ANSI 渲染 + 折叠）、文件 diff（Monaco DiffEditor）、网页/检索摘要；每卡片附「重跑 / 复制命令 / 查看原始事件」；
  - 审批流：PermissionRequest 卡片（diff + 风险提示 + 仅本次/总是允许/拒绝），顶栏权限模式下拉（default/acceptEdits/plan/bypass）；
  - 面板：todo 任务列表、上下文占用条（/context 图形化）、成本仪表、记忆查看器（blocks/语义库可视化编辑）、MCP/Skills/Plugin 管理页、模型与 profile 切换；
  - 系统集成：托盘图标、开机自启（可选）、深色/浅色主题、`tauri-updater` 自动更新（v2）。
- **Windows 适配要点**：`bash` 工具做 shell 适配层（PowerShell/cmd/Git Bash/WSL 探测与降级，PowerShell 为默认）；长路径与中文路径兼容；打包链 = PyInstaller(--onefile) sidecar × electron-builder（NSIS 安装包 + electron-updater 自动更新），代码签名避免 SmartScreen 拦截。

**SDK**：`from harness import Agent; Agent(tools=[...], memory=...).run(task)`——与内核同一套对象，无第二种语义；桌面端不走 SDK，走协议。

---

## 5. 设计模式清单

### 5.1 经典模式在 Harness 中的映射

| 模式 | 在 My-Harness 中的落点 |
|---|---|
| **Strategy** 策略 | RunStrategy（ReAct/PlanExecute/CodeAct/Reflexion）、Condenser、SandboxBackend、召回排序公式 |
| **Registry** 注册表 | ToolRegistry、SkillRegistry、ProviderRegistry、PluginRegistry |
| **Adapter** 适配器 | 各 LLM Provider 适配器（tool_calls ↔ content blocks）、MCP 工具→本地 ToolSpec |
| **Facade** 门面 | `Agent` 类 / SDK 入口：一个对象收编 loop+context+memory+tools |
| **Proxy** 代理 | MCP 远程工具的本地桩、沙箱内命令代理 |
| **Decorator** 装饰器 | 工具执行管道：权限→日志→重试→截断逐层包裹 |
| **Chain of Responsibility** 责任链 | Middleware 管道、权限规则链（deny→ask→allow 先匹配先赢） |
| **Observer** 观察者 | 事件总线 / Hooks / 流式订阅（UI 与内核解耦） |
| **Command** 命令 | ToolCall/Action 对象化：可序列化、可重放、可撤销（配合 Memento） |
| **Memento** 备忘录 | Checkpoint、shadow git 快照、事件流任意时点 View 重建 |
| **Mediator** 中介者 | Orchestrator（subagent 间不直接通信，经 lead 协调） |
| **Template Method** 模板方法 | AgentLoop 骨架固定，钩点（before_llm/after_tool/on_compact）子类定制 |
| **Builder** 建造器 | `Agent.builder().tools(...).memory(...).budget(...)` 流式构造 |
| **Factory** 工厂 | Provider/Store/Sandbox 按 URI 或配置创建（`sqlite://`、`docker://`） |
| **Circuit Breaker** 熔断 | Provider 故障熔断与备用模型降级 |
| **Null Object** 空对象 | NoOpSandbox（local 模式）、NullStore（无记忆模式）——测试与最小安装 |
| **State** 状态 | Agent 运行状态机（plan/act/await_approval/compacting） |
| **Pipeline** 管道 | Condenser 管道、消息后处理管道、记忆整理管道 |
| **Saga** 补偿事务 | 长工作流失败时的逆操作链（v2，配合 checkpoint） |
| **Blackboard** 黑板 | 共享工作区模式（文件系统 + 各专家认领任务） |

### 5.2 Agent 原生模式

| 模式 | 一句话 | 本项目落点 |
|---|---|---|
| ReAct | 推理-行动交替循环 | 默认 RunStrategy |
| Plan-and-Execute | 先规划后执行，执行中可修订 | PlanExecute 策略 + todo 复诵 |
| CodeAct | 动作=沙箱代码，省往返 | v2 策略（学 smolagents） |
| Reflexion | 失败后自我反思再试 | 可选包装器 |
| Orchestrator-Worker | lead 拆解派发，worker 隔离执行 | 4.6 原语 2 |
| Handoff/Swarm | 控制权移交 + 输入过滤 | 4.6 原语 3 |
| Subagent Isolation | 干净窗口换浓缩摘要 | 4.6 原语 1（上下文经济学核心） |
| Map-Reduce Fan-out | 并行调研后聚合 | orchestrator 模板 |
| Debate | 正反方+裁判 | 模式库 |
| Evaluator-Optimizer | 生成-评审循环直至达标 | 模式库 |
| Sleeping Agent | 空闲算力做记忆整理 | 后台整理任务（学 Letta） |
| JIT Retrieval | 上下文只放标识符，按需加载 | memory_search / tool_search / 文件引用 |
| Filesystem-as-Context | 文件系统是无限外置记忆 | artifacts + offload（学 Manus/Letta） |
| Recitation | 目标复诵到注意力高位 | todo.md 机制（学 Manus） |
| Mask-not-Remove | 屏蔽工具而非增删定义 | 权限引擎默认行为（学 Manus） |
| Human-in-the-Loop | 断点审批，恢复前可改状态 | 权限模式 + interrupt/resume |

---

## 6. 技术选型

| 维度 | 选型 | 理由 |
|---|---|---|
| 语言 | **Python 3.12+**（asyncio） | AI 生态最全（MCP python-sdk、各家 SDK、tiktoken、向量库）；与主要参考实现（LangGraph/Letta/mem0/OpenHands SDK）同语言便于借鉴；Pydantic 生态。代价：性能不如 Rust（Codex/goose），但对 I/O 密集的 agent 循环影响有限 |
| 数据模型 | Pydantic v2 | schema 即文档，工具参数校验、结构化输出、配置三合一 |
| 存储 | SQLite + JSONL | 零运维；事件表用 SQLite（WAL 模式），会话文件用 JSONL；向量可选 sqlite-vec / LanceDB（学 CrewAI 默认 LanceDB） |
| MCP | 官方 `mcp` python-sdk（client） | 规范跟进最快；stdio + streamable http 双传输 |
| 观测 | OpenTelemetry SDK（GenAI semconv） | 标准底座，OTLP 导出接 Langfuse/Jaeger；本地默认 JSONL trace 零依赖 |
| CLI | typer + rich | 流式 Markdown 渲染、审批 UI、/context 占用图表 |
| UI | **Electron + React 19 + TypeScript**（v0.2.2 确认，替代 Tauri） | 自带 Chromium 三平台渲染一致；安装器/自动更新/托盘生态最成熟（ZCode/Claude Desktop 同路线）；安装包 ~80-150MB+（含 PyInstaller sidecar）、内存较高；内核保持 Python |
| 沙箱 | Docker（`docker` SDK）；Windows 下走 WSL2 后端 | Windows 原生受限 token 沙箱列为实验性 |
| 测试 | pytest + 录制回放 + TestModel 假 Provider | 无 key 单测 + conformance 回归（学 ADK/pydantic-ai） |
| 配置 | TOML（`my-harness.toml`） | 学 Codex；profiles 支持预设组合 |

**TS 版问题**：Claude Code/Gemini CLI 证明 TS 同样可行且 CLI 分发更顺。建议 v1 单语言 Python 走通全部机制；若后续要发布 npm SDK，按 Agent SDK 模式（原生二进制 + 消息协议包装）补 TS 客户端，不重写内核。

**桌面端选型决策记录**：
- v0.2.1（2026-10-03）：选 Tauri 2 + React 19 + TS。当时依据：本机 ZCode 安装目录实测为 Electron（`LICENSE.electron.txt`、`resources/app.asar`、`app-update.yml`），同类产品（Claude Desktop/Cursor/VS Code）均如此，其理由为 ① VS Code 血统需 Monaco/xterm/Node 生态；② 团队全栈 TS；③ 自带固定版 Chromium 三平台一致；④ 安装器/更新/崩溃上报生态成熟；⑤ 多在 Tauri 2 稳定（2024-10）前立项。当时判断这些理由对本项目不成立（重活在 Python sidecar、Windows 优先避开 Linux WebKitGTK、UI 需求均为纯 Web 能力）。
- **v0.2.2（2026-10-03，当前决定）：改选 Electron + React 19 + TS。** 原因：Tauri 2 实际使用中 bug 太多（工程实践判断），开发效率与生态稳定性优先。接受代价：安装包 80-150MB+、内存较高。不变项：React 19 + TS 前端、本地 daemon + UI 事件协议、PyInstaller sidecar 全部保留。**若后续体积/内存成为硬约束，可基于「协议先行」原则换回系统 WebView 方案。**

---

## 7. 代码仓库结构规划

```
my-harness/
├── DESIGN.md                    # 本文档
├── README.md
├── pyproject.toml               # uv 管理；src 布局
├── my-harness.toml.example
├── src/harness/
│   ├── core/                    # 事件、消息、Session、Run、Budget
│   │   ├── events.py            #   EventType、EventStore 协议
│   │   ├── messages.py          #   规范化 content blocks
│   │   ├── session.py           #   事件溯源 + View 重建
│   │   └── run.py               #   Run 生命周期、中断、预算
│   ├── loop/                    # Agent Loop 与策略
│   │   ├── react.py  plan_execute.py  codeact.py
│   ├── providers/               # base.py + openai/anthropic/gemini/deepseek/glm/ollama
│   ├── context/                 # 预算、Condenser 管道、View、KV-cache 纪律检查
│   │   └── condensers/          #   clearing.py  offload.py  summarize.py  pipeline.py
│   ├── memory/                  # blocks、episodic 检索、semantic 库、AGENT.md、整理任务
│   │   └── tools/               #   memory_view/create/update/search …
│   ├── tools/                   # registry、executor 管道、内置工具
│   │   ├── builtin/             #   bash  read  write  edit  glob  grep  web  todo
│   │   ├── mcp_client.py        #   生命周期/命名空间/延迟加载/OAuth
│   │   └── skills.py            #   SKILL.md 解析、三级披露
│   ├── orchestrator/            # subagent、orchestrator、handoff、模式库模板
│   ├── security/                # 权限模式与规则引擎、hooks、sandbox 适配器、注入防御
│   │   └── sandbox/             #   local.py  docker.py
│   ├── persistence/             # SQLite/JSONL 双写、checkpoint、shadow git
│   ├── observability/           # OTel、成本聚合、trace JSONL
│   ├── evals/                   # Task/Trial/Grader、录制回放、TestModel
│   ├── extension/               # middleware、plugin 打包、配置加载
│   ├── interfaces/              # cli/（typer）、sdk.py
│   └── server/                  # FastAPI daemon、UI 事件协议（Pydantic → TS 类型生成）
├── apps/
│   └── desktop/                 # Electron（main 进程 TS + React 渲染进程）
├── skills/                      # 内置技能（git、xlsx、pdf …）
├── evals/tasks/                 # 评测集（20-50 个真实任务起步）
├── examples/                    # 快速上手脚本
└── docs/                        # 各模块深挖文档（本文档拆分目标）
```

---

## 8. 路线图

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0 内核跑通**（~2-3 周） | Provider 抽象（OpenAI+Anthropic+DeepSeek/GLM）、ReAct 主循环、内置 6 工具、CLI 流式、SQLite+JSONL 事件溯源（事件 schema 按 UI 协议设计，一次定型）、resume | 能在终端连续完成一个多步编码任务；进程杀掉后 resume 不丢状态；KV-cache 命中率可观测 |
| **M1 上下文与安全** | 预算管理、ToolResultClearing/Offload/SummarizingCompaction 三级管道、权限模式+规则引擎、hooks、MCP 客户端（stdio）、shadow git、**Local Server（FastAPI+WS）与 UI 事件协议（生成 TS 类型）** | 200 轮长任务不爆窗口；危险命令被规则拦截且可审计；接一个真实 MCP server；同一会话能从 CLI 和浏览器页面同时查看/操作 |
| **M2 记忆与技能** | Memory blocks、AGENT.md 三层、语义记忆（文件+可选向量）、双写入+合并去重、后台整理、memory 工具、Skills 三级披露 | 跨会话记住用户偏好并正确召回；记忆膨胀有上界（stats 可见）；安装第三方 skill 并触发 |
| **M3 多 agent** | spawn subagent（隔离上下文+摘要回传）、orchestrator-worker 模板（effort scaling）、handoff、Docker 沙箱、预算树 | 并行调研任务（3+ subagent）聚合产出正确；单 agent 显著更优的场景文档化 |
| **M4 生产化与桌面端** | OTel 导出、成本面板、评测 harness（20+ 任务 + 录制回放 conformance）、plugin 打包、**Electron 桌面端首版**（会话侧栏/流式对话/工具卡片/审批流/占用与成本面板/通知），electron-builder 打包 + 自动更新 | CI 里跑评测集并出 pass@k 报告；日常通过桌面端使用一周，不靠 bypass 模式 |
| **v2 展望** | CodeAct、Team 对等协作、A2A 接入、AG-UI/CopilotKit 适配器、桌面端自动更新与三平台分发、bi-temporal 语义记忆、分布式 worker | — |

---

## 9. 风险与开放问题

1. **多 agent 成本失控**：~15x token 是实测数。对策：预算树硬上限、effort scaling 默认保守（≤3 subagents）、成本面板实时可见。
2. **压缩丢信息**：auto-compact 摘要丢关键指令是 Claude Code 已知 bug 类型。对策：结构化摘要模板（intent/artifacts/decisions/next steps 显式字段）、压缩前全量落盘可找回、先 recall 后 precision 调优摘要 prompt。
3. **Prompt injection**：无完美解。对策：三要素拆解（4.8）、高危工具默认 ask、定期用注入样本做回归评测。
4. **记忆陈旧与膨胀**：ADD-only 管线会残留矛盾事实（mem0 v3 已知问题）。对策：失效标记 + 时间衰减排序 + 后台合并 + `/doctor` 审计。
5. **Windows 沙箱弱**：v1 只有权限闸 + shadow git。对策：文档明示 bypass/危险模式的容器化要求；WSL2 Docker 为推荐姿势。
6. **评测集腐化**：SWE-bench 一年从 40%→80%+（含 grader bug 修复的水分）。对策：评测集版本化、人工抽读 transcript、任务 0% pass@100 时先怀疑任务本身。
7. **开放问题**：① 记忆作用域模型（user vs project vs agent）如何与团队共享场景兼容；② MCP server 生态的信任模型（装第三方 server = 装软件）；③ 长任务跨进程/跨机器的 durable execution 是否值得引入 Temporal 级依赖（pydantic-ai 支持 8 引擎，可后置评估）。
8. **桌面端打包链复杂**：PyInstaller sidecar × Electron（electron-builder）× Windows 代码签名/SmartScreen 提示，任一环节断都发不了版。对策：打包 CI 矩阵从 M1 就打通（哪怕先发未签名包）；「协议先行、CLI 兜底」保证 UI 层迭代永不阻塞内核。

---

## 10. 参考资料

**工程博客（核心方法论）**
- Anthropic：[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) · [How we built our multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system) · [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) · [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) · [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) · [Context management 公告](https://claude.com/blog/context-management)
- Manus：[Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- LangChain：[Benchmarking multi-agent architectures](https://www.langchain.com/blog/benchmarking-multi-agent-architectures) · [Memory for agents](https://www.langchain.com/blog/memory-for-agents) · [Deep Agents context engineering](https://docs.langchain.com/oss/python/deepagents/context-engineering)

**协议与标准**
- [MCP 规范](https://modelcontextprotocol.io/specification/2025-11-25)（2026-07-28 版见 [官方博客](https://blog.modelcontextprotocol.io)） · [Agent Skills 开放标准](https://agentskills.io/specification) · [A2A](https://github.com/a2aproject/A2A) · [ACP](https://agentcommunicationprotocol.dev) · [AG-UI](https://docs.ag-ui.com) · [OTel GenAI semconv](https://opentelemetry.io/docs/specs/semconv/gen-ai/)

**论文**
- MemGPT (arXiv:2310.08560) · Mem0 (arXiv:2504.19413) · Zep/Graphiti (arXiv:2501.13956) · CoALA (arXiv:2309.02427) · Sleep-time Compute (arXiv:2504.13171) · OpenHands SDK (arXiv:2511.03690) · Spotlighting (arXiv:2403.14720)

**文档**
- [Claude Code docs](https://code.claude.com/docs) · [Codex sandboxing](https://developers.openai.com/codex/sandboxing) · [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) · [Letta docs](https://docs.letta.com) · [Google ADK](https://adk.dev) · [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/) · [CrewAI memory](https://docs.crewai.com/concepts/memory) · [OpenHands Condenser](https://docs.openhands.dev/sdk/arch/condenser) · [SWE-agent ACI](https://swe-agent.com/latest/background/aci/)

**安全**
- Simon Willison, [The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)
