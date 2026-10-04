# My-Harness

> **你的模型，你的数据，你的 harness。**
> Any model. Local first. Fully programmable.

- **模型中立** —— 任何 OpenAI 兼容端点自由接入：GLM / DeepSeek / Kimi / 通义 / OpenAI / Anthropic / Ollama 本机 / 私有中转。多套配置保存为列表、一键切换（同时一个生效），思考档位按厂商适配（GLM：thinking 开关 + reasoning_effort；OpenAI 系：reasoning_effort）。不绑定任何厂商，不做预设模型清单。
- **本地优先** —— 会话 = 本机 append-only 事件流（SQLite + JSONL），写入时预计算全文搜索列（ZCode 同款架构），跨会话搜索不扫 JSON；token 用量与近似费用逐轮落库，聊天顶栏与设置页直接可见；无账号、无云同步、无遥测，数据目录一键打开。
- **完全可编程** —— daemon 即服务：WS 协议全量文档化（[PROTOCOL.md](PROTOCOL.md)），任何语言都能驱动同一个内核，CLI 与桌面端只是两个参考客户端；`harness run --json` 提供 headless JSONL 事件流；MCP + Skills + Hooks 可扩展。

## 本机实测（2026-10-04 · Windows · 单次运行）

| 指标 | 数值 |
|---|---|
| daemon 冷启动（venv `harness serve` → /health 可用） | **~1.1s**，常驻内存 ~51MB |
| sidecar 首次启动（onefile 自解压） | ~7.4s，常驻内存 ~48MB |
| 便携版磁盘占用（win-unpacked，含 Electron + sidecar） | ~372MB（对照：本机 ZCode 安装目录 ~733MB） |
| Windows 安装包（NSIS，内嵌 sidecar） | ~172MB |

> 实测说明：内存为 daemon 就绪后 RSS；对照项只比磁盘占用，未测对方进程内存，不作无依据声明。

从零构建的 LLM Agent Harness，设计见 [DESIGN.md](DESIGN.md)（含 23 个主流开源项目调研、架构、模块设计、选型决策记录），协议见 [PROTOCOL.md](PROTOCOL.md)，打包见 [PACKAGING.md](PACKAGING.md)。

**当前进度：M0-M4 核心全部落地**（详见 DESIGN.md 路线图）：

- ✅ **M0 内核**：事件溯源（SQLite+JSONL 双写）、ReAct 循环、内置工具、CLI 流式、resume
- ✅ **M1 上下文与安全**：三级压缩管道、权限规则引擎（5 模式）、Hooks、MCP 客户端（stdio+HTTP）、Local Server（WS 事件协议）、Shadow 快照/回滚
- ✅ **M2 记忆与技能**：memory blocks（短期）、事件检索（情景）、facts.md+记忆工具（语义）、AGENT.md（程序性）、后台事实整合、Skills 渐进披露
- ✅ **M3 多智能体**：spawn_subagent（隔离上下文+摘要回传+预算树）、Docker 沙箱（bash 进容器、网络默认关）
- ✅ **M4 生产化**：成本核算（`harness cost` + 桌面端逐轮/会话级成本显示）、评测 harness（`harness eval`，pass@k/pass^k）、**Electron 桌面端**（首启引导连接模型/流式对话/工具卡片/审批 UI/本机统计）、**可编程协议**（PROTOCOL.md + `run --json` headless）
- ⬜ 后续：OTLP 导出、插件打包分发、A2A、Team 对等协作、桌面端签名分发

## 安装

```bash
cd my-harness
python -m venv .venv
.venv/Scripts/pip install -e ".[dev]"   # Windows；Unix: .venv/bin/pip
```

配置模型（LiteLLM 格式）与密钥：

```bash
copy my-harness.toml.example my-harness.toml   # 改 model 一行
set OPENAI_API_KEY=sk-...                      # 或 DEEPSEEK_API_KEY / ZHIPUAI_API_KEY / ANTHROPIC_API_KEY
```

## 用法

```bash
harness chat                       # 交互式对话（流式 + 权限审批 + 自动压缩 + 记忆 + MCP + subagent）
harness chat --session <id>        # 恢复历史会话（事件溯源，进程重启可续）
harness run "统计 src 下有多少行 Python 代码"   # 一次性任务（结束自动整合记忆）
harness run "..." --json                        # headless：JSONL 事件流输出，供脚本消费
harness sessions                   # 列出历史会话
harness cost                       # 按会话汇总 token 与费用
harness eval evals/tasks --trials 2   # 跑评测集，输出 pass@1 / pass^k
harness serve --port 8765          # 本地 daemon：WS 协议（桌面端复用，见 PROTOCOL.md）
```

斜杠命令（chat 内）：`/new /sessions /memory /model <m> /mode <m> /rollback [id] /exit`

## 桌面端（Electron）

```bash
cd apps/desktop
npm install                        # 已配置 npmmirror 可用时更快
npm run dev                        # 自动拉起 harness serve（或附着已有 daemon）+ 打开窗口
```

桌面端是 Local Server 的协议客户端：首次打开先引导连接你自己的模型（厂商下拉 + 自由填写模型名/Base URL，可一键测试连通性）；流式对话、工具调用卡片（✓/✗）、审批卡片（仅本次/总是/拒绝）；聊天顶栏实时显示本轮与会话累计 token 用量及近似费用；设置页「常规」提供本机统计（会话/消息/累计费用/事件库大小）与数据目录一键打开。内核 `pip install -e .` 需先装好且 `harness` 在 PATH 中。

程序化使用见 [examples/quickstart.py](examples/quickstart.py)。

## 结构

```
src/harness/
├── core/        # 事件溯源（SQLite+JSONL 双写）、规范化消息、Session/View（压缩可重放）
├── providers/   # LiteLLM Provider（100+ 模型，流式 + 工具调用规范化）
├── loop/        # ReAct 主循环（预算树、权限闸、压缩、blocks 注入、回调）
├── tools/       # 注册表 + 内置工具（ACI 准则）+ MCP 客户端 + Skills 渐进披露
├── memory/      # 四层记忆：blocks（短期）/事件检索（情景）/facts.md（语义）/AGENT.md（程序性）+ 整合器
├── context/     # 上下文引擎：大结果外置 / 工具结果清理 / 85% 摘要压缩
├── security/    # 权限引擎（5 模式 + 规则）+ Docker 沙箱
├── orchestrator/ # spawn_subagent（隔离上下文 + 摘要回传）+ orchestrator 模板
├── extension/   # 生命周期 Hooks（shell 命令，exit 2 / JSON block 可阻断）
├── persistence/ # Shadow 快照/回滚（write/edit 前自动快照，/rollback 恢复）
├── server/      # Local Server：FastAPI + WS 事件协议（审批流往返）
├── observability/ # 成本核算（pricing 表 + harness cost）
├── evals/       # 评测 harness：Task/Trial/Grader，pass@k / pass^k
├── interfaces/  # CLI：chat / run / sessions / cost / eval / serve
└── config.py
apps/desktop/     # Electron 桌面端（main 进程 + React 渲染，WS 协议客户端）
evals/tasks/      # 示例评测用例
```

## 路线图（DESIGN.md §8）

- **M0 内核跑通** ← 当前
- M1 上下文与安全：三级压缩管道、权限规则引擎、hooks、MCP 客户端、Local Server
- M2 记忆与技能：memory blocks、AGENT.md、语义记忆、Skills
- M3 多智能体：subagent、orchestrator-worker、handoff、Docker 沙箱
- M4 生产化与桌面端：OTel、评测 harness、Electron + React 19 桌面端
