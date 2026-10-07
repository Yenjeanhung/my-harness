# My-Harness 协议参考（Local Server WS Protocol）

> My-Harness 的架构是「内核即服务，界面皆客户端」：Python 内核以 daemon 形式常驻，
> CLI、Electron 桌面端只是两个参考客户端。**任何语言、任何进程，只要能开 WebSocket，
> 就能完整驱动这个 coding agent**——写你自己的界面、让别的 agent 驱动它、把它嵌进你的
> 工作流，都是同一份协议。

- 传输：WebSocket，默认 `ws://127.0.0.1:8765/ws`（`harness serve --port` 可改）
- 健康检查：`GET http://127.0.0.1:8765/health` → `{"status":"ok","version":"0.2.0","workspace":"<工作区根>","sessions":N,"tools":N}`
  - `version` 用于版本握手：桌面端发现版本不匹配会自动替换旧 daemon
  - `workspace` 让桌面端判断 daemon 是否已在跑目标项目（同版本同工作区则直接附着，不重启）
- 消息格式：单条 JSON 对象，一律带 `type` 字段；请求-响应没有显式 id 关联，
  按 `type` + `session_id` 对应（一条命令可能触发多条事件，见下）
- 事件溯源：会话的一切（消息、工具调用、审批、运行用量）都是 append-only 事件，
  SQLite（`~/.my-harness/harness.db`）供查询，JSONL（`~/.my-harness/sessions/<id>.jsonl`）供人读

## 命令（client → server）

### 会话生命周期
| 命令 | 字段 | 回复事件 |
|---|---|---|
| `CreateSession` | `origin?`（`chat`=会话模式 / `code`=代码模式，缺省 `chat`；决定会话归属池，两池列表互不可见） | `SessionCreated` |
| `ResumeSession` | `session_id` | `SessionResumed` + `History`（回放历史条目，user/assistant 带 `seq`）+ `SessionCost` |
| `ForkSession` | `session_id`, `upto_seq?`（截到该事件序号，缺省=全量复制） | `Notice` + `SessionList` + `SessionResumed` + `History`（新会话）。复制上下文事件为「Fork of <原标题>」新会话；不复制 run_finished（统计不重复计数）；截在带工具调用的助手消息上时自动补齐其后的 tool_results |
| `ListSessions` | — | `SessionList`（含 `groups`；`sessions`/`chat`=会话模式池，`code`=代码模式池，按 `origin` 分池互不可见，老会话无标归 `chat`） |
| `SendMessage` | `session_id`, `text`, `images[]?`(`{media_type,data}` base64) | `RunStarted` → `TokenDelta`/`ToolCallArgs`/`ToolCallStarted`/`ToolCallOutput`/`ToolCallResult`/`Notice`… → `RunFinished` |
| `CancelRun` | `session_id` | `Notice`（run cancelled） |
| `DeleteSession` | `session_id` | `Notice` + `SessionList`（物理删除事件行+JSONL；正在跑的先取消） |
| `RenameSession` | `session_id`, `title` | `SessionList` |
| `PinSession` | `session_id`, `pinned` | `SessionList` |
| `SearchContent` | `query`, `limit?` | `ContentSearchResult`（预计算列全文检索，带 snippet） |
| `ExportSession` | `session_id` | `Notice` + `SessionExported`（Markdown 落到 `~/.my-harness/exports/`） |

### 会话分组
| 命令 | 字段 | 回复事件 |
|---|---|---|
| `CreateSessionGroup` | `name` | `SessionList` |
| `RenameSessionGroup` | `name`, `new_name`（成员跟随改名） | `SessionList` |
| `DeleteSessionGroup` | `name`（组内会话移到未分组，不删会话） | `Notice` + `SessionList` |
| `SetSessionGroup` | `session_id`, `group`（空 = 未分组） | `SessionList` |

### 模型与运行配置（持久化到 `~/.my-harness/settings.json`，优先于 my-harness.toml）
| 命令 | 字段 | 回复事件 |
|---|---|---|
| `SetModel` | `model`, `api_key?`, `api_base?` | `ModelSet`（按 model 串 upsert 到列表并激活；key 留空保持原值） |
| `SwitchModel` | `model` | `Settings`（切换到列表里另一套已保存配置） |
| `DeleteModelConfig` | `model` | `Settings`（删当前生效项自动回落；全删光回退 toml 默认） |
| `GetSettings` | — | `Settings` |
| `SetPermissionMode` | `mode`: `default`/`acceptEdits`/`plan`/`dontAsk`/`bypass` | `Notice` + `Settings`（全局即时生效） |
| `SetThinking` | `level`: `off`/`low`/`high`/`max` | `Notice` + `Settings`（API 级参数：GLM=thinking 开关+reasoning_effort，OpenAI 系=reasoning_effort） |
| `TestModel` | `model`, `api_key?`, `api_base?` | `ModelTestResult`（连通性测试：发一次最小请求；key 留空沿用已保存配置；不影响当前生效配置，不落库；30s 超时） |

### 成本与统计（本地数据可见性）
| 命令 | 字段 | 回复事件 |
|---|---|---|
| `GetSessionCost` | `session_id` | `SessionCost`（该会话 turns/输入/输出 tokens/cost_usd） |
| `GetStats` | — | `Stats`（本机全会话数/消息数/运行次数/累计 tokens/累计费用/事件库大小/data_dir） |
| `OpenDataDir` | — | `Notice`（用系统文件管理器打开数据目录） |

### 记忆 / MCP / 技能 / 附件
| 命令 | 字段 | 回复事件 |
|---|---|---|
| `ListMemory` | `session_id?` | `MemoryList`（工作记忆 blocks + 长期记忆文件） |
| `ReadMemoryFile` | `path` | `MemoryFileContent` |
| `DeleteMemoryFile` | `path` | `Notice` + `MemoryList` |
| `DeleteMemoryBlock` | `session_id`, `label` | `MemoryList` |
| `ListMcp` | — | `McpList`（含连接状态与工具数） |
| `AddMcpServer` | `name`, `transport`: `stdio`(`command`,`args`)/`http`(`url`) | `Notice` + `McpList`（先连接成功才保存） |
| `RemoveMcpServer` | `name` | `Notice` + `McpList`（热断开，注册的工具即时移除） |
| `ListSkills` | — | `SkillList` |
| `ReadWorkspaceFile` | `path`（限工作区内，50K 截断） | `WorkspaceFile`（附件场景） |
| `LintCheck` | `path`, `text`（编辑器全文）, `req`（回显配对） | `LintResult{path, req, diagnostics[{line, col, end_line, end_col, message, severity}]}`（py=compile 语法 + pyflakes 可选；json=loads；编辑器 700ms 防抖）。M6 起 python 且 LSP 在跑时编辑器不再发本命令（诊断走 LSP publishDiagnostics），其余语言/无 LSP 时仍作兜底 |
| `GotoDef` | `name`（标识符）, `path`（来源文件）, `req` | `GotoDefResult{req, name, file, line}`（全工作区搜 def/class，同文件优先；变量退回本文件赋值行）。M6 起 python 的 LSP definition 在跑时优先走 LSP，本命令为无 LSP 兜底 |
| `ListDir` | `path`（空=根；过滤 .git/node_modules 等 + .gitignore） | `DirListing{path, entries[{name,kind,size,mtime}]}` |
| `ReadFile` | `path` | `FileContent{path, content, binary, truncated, size}`（编辑器场景：二进制探测 + 1MB 上限） |
| `WriteWorkspaceFile` | `path`, `content`, `base?`（编辑器最后一次看到的磁盘内容） | `FileSaved{path, size}`；带 `base` 且与当前磁盘不一致 → **拒写**，回 `FileSaveConflict{path, disk}`（附磁盘当前内容），由用户选重新加载/保留版本——防旧缓冲静默覆盖 Agent 改动 |
| `CreateEntry` | `path`, `kind: file/dir` | `Notice` |
| `MoveEntry` | `path`, `to` | `Notice` |
| `DeleteEntry` | `path`（移入 `.my-harness/trash/`，可找回） | `Notice` |
| `SearchWorkspace` | `query`, `is_regex?`, `max?`（≤300 命中） | `SearchResult{query, results[{path,line,col,text}], total, truncated}` |
| `GitStatus` | — | `GitStatus{repo, branch, files[{path,code,xy}]}`（porcelain；xy=原始两位码：X 暂存区/Y 工作区；非 git 仓库 repo=false） |
| `GitStage` / `GitUnstage` | `path` | `GitDone{op, ok, message}` + 自动回发 `GitStatus`（unstage 兼容初始提交：reset 失败时 fallback `rm --cached`） |
| `GitStageAll` | — | 同上（`git add -A`：全部更改含新增/删除一次性暂存） |
| `GitCommit` | `message`, `all?`（无暂存时 `-a` 全部提交） | `GitDone{op:"commit", ok, message}` + 自动回发 `GitStatus` |
| `GitDiff` | `path` | `GitDiff{path, diff}` |
| `GitFileBase` | `path` | `FileBase{path, content}`（git index 版本；未跟踪为空串，diff 视图的「改前」侧） |
| `LspStart` | `language` | `LspStatus{language, status:"running", root_uri, detail}`（daemon 按探测顺序拉起语言服务器子进程，`settings.json` 的 `lsp.<语言>.command` 可覆盖；已在跑则重启——LSP initialize 每进程只允许一次，页面重载必须拿新会话）；找不到服务器 → `status:"error", detail` |
| `LspToServer` | `language`, `message`（LSP JSON-RPC 消息原样） | 消息经 daemon 哑管道写进服务器 stdin；服务端回包以 `LspFromServer{language, message}` 事件流回 |
| `LspStop` | `language` | `LspStatus{status:"stopped"}` |
| `UploadImage` | `data_url`（image/png\|jpeg\|gif\|webp，≤10MB） | `ImageSaved`（落盘 workspace/attachments/ 并回传 base64） |
| `RespondPermission` | `request_id`, `answer`: `yes`/`always`/`no` | —（解除挂起的审批 future） |
| `Ping` | — | `Pong` |

## 事件（server → client）

| 事件 | 关键字段 | 说明 |
|---|---|---|
| `SessionCreated` / `SessionResumed` | `session_id`, `mode` | 会话就绪；Resume 后随 `History` |
| `History` | `items[]`: `{kind: user/assistant/tool, text?, tool?, args?, images?}` | 事件流回放为界面条目 |
| `SessionList` | `sessions[]`(`session_id/title/events/last_active/pinned/group`), `groups[]` | 侧栏数据源 |
| `RunStarted` | `session_id` | 一轮 run 开始 |
| `TokenDelta` | `session_id`, `text` | 流式文本增量 |
| `ReasoningDelta` | `session_id`, `text` | 推理内容增量（GLM/DeepSeek 系 reasoning_content；客户端用于「正在思考」实时展示，可忽略） |
| `ToolCallArgs` | `session_id`, `call_id`, `tool`, `args_text` | 工具调用参数仍在生成时的流式预览（累积原始 JSON 文本）；客户端可提前画出工具卡片，`ToolCallStarted` 随后带最终 `args` |
| `ToolCallStarted` / `ToolCallResult` | `tool`, `args`, `call_id?` / `tool`, `is_error`, `chars`, `call_id?` | 工具卡片；`call_id` 与 `ToolCallArgs`/`ToolCallOutput` 关联同一张卡片 |
| `ToolCallOutput` | `session_id`, `call_id`, `tool`, `text` | 工具执行期过程输出增量（bash 逐行 stdout），客户端在卡片内实时滚动；可忽略 |
| `Usage` | `session_id`, `input_tokens`, `output_tokens`, `context_tokens?`, `context_window?`, `static_tokens?` | 每轮模型返回后推送的本 run 累计 token（含子代理）与当前上下文规模；可忽略 |
| `ContextInfo` | `session_id`, `context_tokens`, `context_window`, `static_tokens` | 恢复会话时的上下文规模快照（字符估算），客户端显示容量指示；可忽略 |
| `RunFinished` | `answer`, `duration_ms`, `usage{input_tokens,output_tokens}`, `cost_usd`(价格未知为 null), `last_seq`(本轮最后一条消息的 seq，会话为空为 null) | 一轮结束，带用量与近似费用；前端据 `last_seq` 让新消息立刻可分支 |
| `PermissionRequest` | `request_id`, `tool`, `reason` | 需要审批；用 `RespondPermission` 应答 |
| `Notice` | `text`, `session_id?` | 非致命通知（取消/导出/权限切换等） |
| `Error` | `error`, `session_id?` | 命令执行失败或 run 报错 |
| `Settings` | `model`, `has_api_key`, `api_base`, `models[]`, `permission_mode`, `thinking`, `server_version` | 设置全量 |
| `ModelSet` | `model`, `has_api_key`, `models[]` | SetModel 确认 |
| `ModelTestResult` | `ok`, `model`, `latency_ms`, `reply?`/`error?` | TestModel 结果 |
| `SessionCost` | `session_id`, `turns`, `input_tokens`, `output_tokens`, `cost_usd?` | 会话用量聚合 |
| `Stats` | `sessions`, `messages`, `runs`, `input_tokens`, `output_tokens`, `cost_usd?`, `db_bytes`, `data_dir` | 本机统计 |
| `ContentSearchResult` | `query`, `results[]`(`session_id`, `snippet`) | 全文搜索命中 |
| `ImageSaved` / `WorkspaceFile` | `path`, `media_type`, `data` / `path`, `content`, `truncated` | 附件就绪 |
| `DirListing` / `FileContent` / `FileSaved` / `FileBase` | 见对应命令 | 工作台文件事件 |
| `SearchResult` / `GitStatus` / `GitDiff` | 见对应命令 | 工作台搜索与 Git 事件 |
| `LspStatus` | `language`, `status`: starting/running/stopped/error, `root_uri?`, `detail?` | 编辑器语言服务器生命周期；running 后客户端发 LSP `initialize`（rootUri 由 daemon 以工作区兜底，daemon spawn 时 cwd=工作区） |
| `LspFromServer` | `language`, `message` | 语言服务器的 JSON-RPC 原样转发（通知/请求/响应都走这里） |
| `MemoryList` / `MemoryFileContent` / `McpList` / `SkillList` / `SessionExported` / `Pong` | — | 对应命令的回复 |

费用说明：token 用量真实记录（每轮模型返回的 usage，子代理共享累计）；`cost_usd` 按
RUN_FINISHED 里记录的模型与 `[pricing]` 价格表（USD/1M tokens，见 my-harness.toml.example）
逐条近似，**价格未知的模型不计入、显示为 null，不猜测**。

## Headless 模式（不连 WS 的可编程用法）

一次性任务可以直接走 CLI，stdout 是稳定的机器可读输出：

```bash
harness run "统计 src 下有多少行 Python 代码" --json
```

`--json` 输出 JSONL 事件流（每行一个 JSON 对象，顺序即执行顺序）：

```jsonl
{"type":"run_started","session_id":"ab12..","model":"zhipuai/glm-4.6","perms":"bypass"}
{"type":"tool_call","tool":"grep","args":{"pattern":"def","path":"src"}}
{"type":"tool_result","tool":"grep","is_error":false,"chars":412}
{"type":"token","text":"共"}
{"type":"done","session_id":"ab12..","model":"zhipuai/glm-4.6","answer":"...","usage":{"input_tokens":18320,"output_tokens":411},"duration_ms":9123,"resume":"harness chat --session ab12.."}
```

失败时输出 `{"type":"error","error":"..."}` 并以非零退出码结束。配套命令：
`harness cost`（按会话汇总 token/费用）、`harness export <id>`（导出 Markdown）、
`harness sessions`、`harness serve`（起 daemon）。

## 最小客户端示例

Python（标准库外只需 `websockets`）：

```python
import asyncio, json, websockets

async def main():
    async with websockets.connect("ws://127.0.0.1:8765/ws") as ws:
        await ws.send(json.dumps({"type": "CreateSession"}))
        created = json.loads(await ws.recv())
        sid = created["session_id"]
        await ws.send(json.dumps({"type": "SendMessage", "session_id": sid, "text": "列出 TODO"}))
        while True:
            e = json.loads(await ws.recv())
            if e["type"] == "TokenDelta":
                print(e["text"], end="", flush=True)
            elif e["type"] == "RunFinished":
                print("\n[done]", e["duration_ms"], "ms,", e["usage"], "tokens")
                break

asyncio.run(main())
```

Node.js（22+ 自带 WebSocket）：

```js
const ws = new WebSocket("ws://127.0.0.1:8765/ws");
ws.onopen = async () => {
  ws.send(JSON.stringify({ type: "CreateSession" }));
};
let sid;
ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (e.type === "SessionCreated") {
    sid = e.session_id;
    ws.send(JSON.stringify({ type: "SendMessage", session_id: sid, text: "hello" }));
  } else if (e.type === "RunFinished") {
    console.log("done:", e.answer, e.usage);
    process.exit(0);
  }
};
```

## 版本与兼容

- daemon 与客户端解耦：先 `/health` 读 `version`，命令/事件字段只增不改；
  旧客户端收到未知 `type` 应忽略（参考客户端即如此）。
- 单 daemon 单客户端（当前设计为桌面端独占 `state.client`）；多客户端并发是路线图项。
