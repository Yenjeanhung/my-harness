# 代码结构图

> 本文档描述 My-Harness 的代码组织结构与各模块职责，便于快速定位代码。
> 设计原理见 [DESIGN.md](../DESIGN.md)，协议见 [PROTOCOL.md](../PROTOCOL.md)，打包见 [PACKAGING.md](../PACKAGING.md)。

## 1. 仓库总览

```
my-harness/
├── src/harness/               # Python 内核（daemon、CLI、SDK 共用）
├── apps/desktop/              # Electron 桌面端（TypeScript/React）
├── tests/                     # pytest 单元测试
├── evals/tasks/               # 评测任务集（harness eval 使用）
├── examples/                  # 示例（quickstart.py：Python SDK 用法）
├── packaging/                 # PyInstaller sidecar 打包入口
├── doc/                       # 文档（本目录）
├── DESIGN.md                  # 设计文档（调研/架构/模块设计/ADR）
├── PROTOCOL.md                # WS 协议文档
├── PACKAGING.md               # 打包与分发文档
├── pyproject.toml             # Python 包定义（harness 入口）
├── build-all.bat              # 全量构建脚本（sidecar + 桌面端）
└── package.json               # 根转发入口（转发到 apps/desktop 脚本）
```

## 2. Python 内核 `src/harness/`

按 DESIGN.md 的分层架构组织，行数为当前规模参考：

```
src/harness/
├── config.py                  # 全局配置（my-harness.toml 读取）
├── core/            (~584 行) # 核心数据模型
│   ├── events.py              #   Event / EventType（事件溯源，append-only）
│   ├── session.py             #   Session / Run（会话 = 事件流 + SQLite/JSONL 双写）
│   ├── messages.py            #   Message / Block（与 Provider 无关的规范化消息）
│   └── ...
├── loop/            (~478 行) # Agent 运行时
│   ├── react.py               #   ReAct 循环（默认）：模型→工具→回填→循环
│   └── langgraph_loop.py      #   LangGraph 实现
├── context/         (~170 行) # 上下文引擎
│   └── compactor.py           #   三级压缩管道（历史→摘要→占位符）
├── memory/          (~422 行) # 记忆系统
│   ├── blocks.py              #   短期：in-context memory blocks
│   ├── vault.py               #   语义：facts.md 事实库
│   ├── procedural.py          #   程序性：AGENT.md
│   ├── consolidator.py        #   后台事实整合（抽取/合并/去重）
│   └── tools.py               #   记忆读写工具
├── tools/           (~624 行) # 工具系统
│   ├── base.py                #   ToolSpec / ToolRegistry / Executor
│   ├── builtin.py             #   内置工具集（bash/read/write/edit…）
│   ├── mcp_client.py          #   MCP 客户端（stdio + HTTP）
│   └── skills.py              #   Skills 渐进披露加载器
├── security/        (~157 行) # 安全
│   ├── permissions.py         #   权限规则引擎（deny→ask→allow，HITL 审批）
│   └── sandbox.py             #   沙箱适配器（local / Docker）
├── providers/       (~444 行) # 模型层
│   ├── litellm_provider.py    #   LiteLLM 统一接入（任意 OpenAI 兼容端点）
│   └── langchain_provider.py  #   LangChain 实现
├── orchestrator/     (~91 行) # 多智能体
│   └── subagent.py            #   spawn_subagent（隔离上下文+摘要回传+预算树）
├── persistence/      (~88 行) # 持久化
│   └── shadow.py              #   Shadow 快照 / 回滚
├── server/         (~2029 行) # 交互层服务
│   ├── app.py                 #   Local Server：WS/SSE 事件协议、多会话管理
│   └── lsp.py                 #   LSP 集成
├── interfaces/      (~499 行) # CLI
│   └── cli.py                 #   harness chat/run/cost/eval/resume 等命令
├── observability/    (~57 行) # 观测
│   └── cost.py                #   token 用量与费用核算
├── evals/           (~117 行) # 评测
│   └── runner.py              #   harness eval（pass@k / pass^k）
└── extension/        (~65 行) # 扩展
    └── hooks.py               #   Hooks（工具调用前后生命周期）
```

### 分层对应关系

| DESIGN.md 分层 | 代码目录 |
|---|---|
| 交互层 Interface | `server/`、`interfaces/cli.py`、`apps/desktop/` |
| 编排层 Orchestration | `orchestrator/` |
| Agent 运行时 Runtime | `loop/`、`core/` |
| 上下文引擎 | `context/` |
| 记忆系统 Memory | `memory/` |
| 工具系统 Tools | `tools/` |
| 模型层 Provider | `providers/` |
| 横切层 Cross-cutting | `persistence/`、`security/`、`extension/`、`observability/`、`evals/` |

### 一次请求的调用链

```
CLI / 桌面端
  → server/app.py（WS 事件协议）
  → loop/react.py（ReAct 循环）
      ├─ context/compactor.py   预算检查与压缩
      ├─ memory/                注入记忆 blocks / AGENT.md
      ├─ tools/                 工具定义与执行
      │    ├─ security/permissions.py  权限审批
      │    └─ security/sandbox.py      执行环境
      ├─ orchestrator/subagent.py      子代理派生
      └─ providers/             模型调用（流式）
  → core/events.py              事件落库（SQLite+JSONL），可 resume
  → observability/cost.py       用量与费用累计
```

## 3. 桌面端 `apps/desktop/`

```
apps/desktop/
├── main.ts          (~516 行)  # Electron 主进程：窗口管理、sidecar 守护进程拉起
├── preload.ts                  # 安全桥接（contextBridge）
├── renderer/                   # React 渲染进程
│   ├── app.tsx      (~3401 行) # 应用外壳：连接向导、设置页、多会话列表、成本面板
│   ├── workbench.tsx(~1779 行) # 会话工作台：流式对话、工具卡片、审批 UI、编辑器
│   ├── protocol.ts  (~293 行)  # WS 协议客户端类型与封装（对应 PROTOCOL.md）
│   ├── monaco.ts    (~223 行)  # Monaco 编辑器集成
│   ├── lsp.ts       (~273 行)  # LSP 客户端
│   ├── icons.tsx    (~547 行)  # 图标库
│   ├── ws.ts / md.ts / mdwysiwyg.ts  # WS 连接与 Markdown 渲染
│   └── workers/                # Monaco 语言 worker（ts/json/css/html/editor）
├── build.mjs / pack-fast.cjs / prepkg.cjs  # Vite 构建与 electron-builder 打包
└── icon-design/                # 图标设计源文件
```

## 4. 测试与配套

```
tests/          # pytest：loop、tools、memory、permissions、mcp、server、
                #        subagent、shadow、skills、compaction、providers 等各模块
evals/tasks/    # harness eval 评测任务集
examples/       # quickstart.py：headless SDK 用法示例
packaging/      # build_sidecar.py + server_entry.py：PyInstaller sidecar 入口
```
