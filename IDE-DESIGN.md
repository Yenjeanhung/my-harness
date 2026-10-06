# My-Harness 工作台（Workbench）设计 —— 媲美 VS Code 的写代码体验

> **状态（2026-10-06）：M0-M6 已全部实现**。M0-M5（2026-10-05）：三栏布局、文件树、编辑器、跨文件搜索、
> Git 角标 + diff、Agent 联动四件套。M6（2026-10-06）：**编辑器内核 CodeMirror 6 → Monaco（VS Code 内核）
> + LSP 桥**（多光标/折叠/minimap/sticky scroll、TS/JS/JSON/CSS/HTML 内嵌语言服务、python 走 pylsp/pyright
> 补全/悬停/定义/诊断/格式化）。协议新增见 PROTOCOL.md「编辑器 LSP 桥」段。
> 桌面端源码：`apps/desktop/renderer/`（workbench.tsx / monaco.ts 内核模块 / lsp.ts 传输桥）+ icons.tsx + ws.ts。

> 目标：让 My-Harness 从「对话窗口」进化为「Agent 结对工作台」——人能看项目结构、读代码、改代码、
> 审查 Agent 的每一次修改；Agent 的工具调用与人的编辑器双向联动。
> 定位是 **ZCode / Cursor 式的结对工作台**。M6 起编辑体验对齐 VS Code（Monaco 内核 + LSP），
> 但仍不做调试器、不做插件市场（见 §7）。

## 0. 设计原则

1. **编辑器只是协议的另一个客户端**：所有文件读写都走 daemon（工作区安全边界、权限闸、shadow 快照全部复用），
   不在渲染层开第二套文件访问路径。CLI / 桌面端 / 未来 Web 端共享同一组命令。
2. **协议只增不改**：新命令全部新增，旧客户端忽略未知 type 即可（PROTOCOL.md 惯例）。
3. **Agent 联动是一等公民**：这不是顺带功能——文件树/编辑器/diff 的价值一半来自「Agent 正在改什么看得见」。
4. **懒加载保启动速度**：Monaco 主包 ESM + code splitting（语言语法按需分块）、5 个语言服务 worker 独立分包；
   文件树目录懒展开。

## 1. 布局（M0，地基）

从「单栏对话」升级为三栏可调工作台（ZCode/VS Code 同款骨架）：

```
┌──────┬───────────────┬──────────────────────┐
│ 侧栏  │   编辑器区      │        对话区          │
│(可切) │  多 tab 文件    │     （现有全部功能）     │
│ 会话  │  + diff 视图   │  工具卡片/终端/审批…     │
│ 文件  │               │                      │
├──────┴───────────────┴──────────────────────┤
│ 终端面板（现有，跨全宽）                          │
└─────────────────────────────────────────────┘
```

- 三栏之间可拖拽分栏；对话区可折叠成窄条（纯编辑模式）；编辑器区没有 tab 时显示工作台空态（最近文件 / 快捷操作）。
- 侧栏顶部两个 tab：**会话**（现有）与 **文件**（资源管理器，M1）。项目切换逻辑不变。
- 编辑器 tab 与对话共存：对话不再占满主区，而是右侧固定栏（宽度可拖，最小 320px）。

## 2. 文件树 · 资源管理器（M1）

**后端（新命令）**

| 命令 | 字段 | 返回 |
|---|---|---|
| `ListDir` | `path`（相对工作区，空=根） | `DirListing{ entries: [{name, kind: file/dir, size, mtime}] }` |
| `ReadWorkspaceFile`（扩展） | `path` | 现有 + `binary: true` 时不回内容；上限提到 1MB，超限 `truncated` |
| `WriteWorkspaceFile` | `path`, `content` | `FileSaved{path, size}`（走 daemon 的写路径=安全边界内） |
| `MoveEntry` / `DeleteEntry` | `path`, `to` / `path` | `Notice`（删除进工作区回收站 `.my-harness/trash/`，可恢复） |
| `CreateEntry` | `path`, `kind: file/dir` | `Notice` |

- 过滤：复用内核 `_SKIP_DIRS`（.git/.venv/node_modules/…）+ 解析 `.gitignore`（v1 简单前缀匹配即可）。
- 文件图标：单色线性（延续现有 Icon 体系），按扩展名映射（js/ts/py/json/md/css/html/img/git…）。

**前端**
- 懒展开目录（点开才 ListDir）、当前项目根为树根、顶部路径面包屑 + 刷新按钮。
- 行内操作（悬浮显形）：新建/重命名/删除/在终端中打开（cd 到该目录）/「让 Agent 处理」。
- Agent 改动过的文件在树上带蓝点标记（数据源见 §5）。

## 3. 编辑器（M2 基础 + M6 内核升级）

**内核选型（M6 定稿）：Monaco（VS Code 内核）**
- M2 阶段先选了 CodeMirror 6（~300KB gz 启动快）。实际使用中「功能太少、不完善」的差距都在内核能力：
  无补全/无折叠/无多光标/minimap 等都要自己搭，搭出来也是劣化版 VS Code。
- M6 换 **monaco-editor 0.57**（Cursor 同款内核）：多光标/折叠/minimap/sticky scroll/find/多选/括号着色全白拿；
  TS/JS/JSON/CSS/HTML 的语言服务内嵌在 worker 里（浏览器内 tsserver），打开即有智能提示。
- 架构要点（`renderer/monaco.ts`）：
  - 渲染页从 **`app://` 自定义协议**加载（standard+secure，main.ts `protocol.handle`）——file:// 下
    origin 为 null，Monaco 的 Worker 加载过不去；这是换内核最大的坑。
  - esbuild 输出 **ESM + splitting**（语言语法按需分块）+ **5 个 worker 独立 iife 包**
    （`MonacoEnvironment.getWorker` 按 label 分发 editor/ts/json/css/html worker）。
  - 文件 → model 注册表：URI = `file://<workspaceRoot>/<relPath>`（workspaceRoot 由 main.ts 经
    query 传入），语言服务器按 URI 匹配工作区文件。切 tab = setModel + ViewState 保存恢复（滚动/光标/折叠不丢）。
  - 诊断统一出口：daemon lint 兜底 / LSP publishDiagnostics / monaco 内建校验全写进 marker 服务，
    报错总览条与 F8 只读 marker。
  - TS 诊断屏蔽模块解析类错误码（2307/2304 等）——浏览器里没有 node_modules 类型，Node 项目全是噪音；
    保留真正的类型/语法错误。

**LSP 桥（M6，`renderer/lsp.ts` + `src/harness/server/lsp.py`）**
- monaco 0.57 内置 LSP 客户端（`monaco.lsp.MonacoLspClient`）：补全/悬停/签名/诊断推送/格式化/重命名/
  代码操作全由它接 Monaco，渲染层只写**传输桥**——JSON-RPC 装进 daemon 协议
  （`LspStart`/`LspToServer`/`LspFromServer`/`LspStatus`），daemon 是哑管道（spawn 语言服务器子进程 +
  Content-Length 帧转发），不懂 LSP 语义。
- python：自动探测 `pyright-langserver` → `pylsp`（PATH）；`settings.json` 的 `lsp.python.command` 可覆盖。
  TS/JS/JSON/CSS/HTML 用 monaco 内嵌服务，不需要外部进程。
- **LspStart = 重启语义**：LSP initialize 每进程只允许一次，页面重载后的客户端必须重新协商——
  复用旧进程会让第二次 initialize 报错、全部功能静默失效（踩过）。
- 跳转定义双通道：LSP 在跑时由渲染层直发 `textDocument/definition`（内置客户端要求目标文件已有
  model，未打开的文件会失败）；未打开文件经 `editor opener` → `App.openFile` 开 tab + 跳行。
  无 LSP 时退回 daemon 的 `GotoDef`（全工作区搜 def/class）。

**功能清单**
- 多 tab（中间区），脏标记 · Ctrl+S 保存（走 `WriteWorkspaceFile`）· 关闭前未保存提示。
- 行号 / 当前行高亮 / 括号匹配 / 面板内搜索 / 折叠 / 多光标 / minimap / sticky scroll（Monaco 内建）。
- 右键菜单 AI 动作：解释/加注释/重构/修复/写测试/审阅（有选区作用选区，无选区作用整文件）。
- md 预览（Ctrl+Shift+V）；只读模式：>1MB 文本、`binary` 文件。
- 编辑冲突处理：Agent 改动了已打开的文件 → 顶栏黄条「文件已被 Agent 修改 · 重新加载 / 保留我的版本」（diff 后选）。
- LSP 状态 chip：tab 条显示 pylsp/pyright 运行态（启动中/名称/不可用），不可用自动退回兜底路径。

## 4. 跨文件搜索（M3）

- 后端 `SearchWorkspace{query, glob?, is_regex?, max}`：复用内核 grep 工具实现（Python 端已有），流式返回
  `SearchHit{path, line, col, line_text}`（多条事件，末尾 `SearchDone{total, truncated}`）。
- 前端：侧栏「搜索」子面板（文件 tab 顶部切换）：结果按文件分组、点击跳编辑器定位行列；替换（M3.1）先做单文件内替换。

## 5. Agent ↔ 编辑器联动（M5，差异化所在）

1. **改动列表**：run 期间 `edit_file/write_file/bash` 触及的文件聚合成「本次任务改动 N 个文件」浮条
   （数据源：现有 TOOL_CALL 事件 + args.path，无需后端改动）→ 点击逐个打开 diff。
2. **Diff 视图**：编辑器的一种 tab 类型。左右分栏（修改前 shadow 快照 / 当前磁盘），CodeMirror merge 简化版；
   `edit_file` 卡片上点「查看 diff」直达。shadow 快照已在工具层存在，diff 只读快照 vs 磁盘即可，不引 git 依赖。
3. **工具卡片跳转**：`read_file` 卡片点路径 → 编辑器打开该文件并滚动到 offset；`edit/write` → 打开 diff。
4. **选中即问**：编辑器选中代码 → 悬浮「问 Agent」按钮 → 输入框自动填 `` `path:12-34` 选中内容 `` 引用。
5. **文件树标记**：本 run 改动的文件带蓝点；git 变更（M4）带 M/U 红绿字母。

## 6. Git 基础集成（M4，可选增强）

- 后端 `GitStatus{}`（`git status --porcelain` 包装）→ 文件树角标；`GitDiff{path}` → diff 视图数据源。
- 不做 stage/commit UI（v1）；commit 让用户在终端（已内嵌）或让 Agent 做。

## 7. 明确不做（防蔓延）

断点调试、插件市场、远程开发、多根工作区、设置同步。
~~LSP/IntelliSense~~（M6 已做：Monaco 内嵌语言服务 + daemon LSP 桥，见 §3）。
调试器与插件市场仍是 VS Code 的护城河，不是 Agent 工作台的刚需。

## 8. 协议新增汇总（全部只增）

命令：`ListDir` / `CreateEntry` / `MoveEntry` / `DeleteEntry` / `WriteWorkspaceFile` /
`SearchWorkspace` / `GitStatus` / `GitDiff`
事件：`DirListing` / `FileSaved` / `SearchHit` / `SearchDone` / `FileChanged`（v2 文件 watch 再加）
扩展：`ReadWorkspaceFile` 加 `binary` 语义与 1MB 上限。
M6 新增：命令 `LspStart` / `LspToServer` / `LspStop`；事件 `LspStatus` / `LspFromServer`。

## 9. 里程碑与工作量

| 里程碑 | 内容 | 预估 | 交付判据 |
|---|---|---|---|
| M0 | 三栏布局 + 分栏拖拽 + 对话区折叠 | 1 天 | 三栏可拖、对话可折叠、现有功能无损 |
| M1 | 文件树（懒展开/图标/增删改/终端/过滤） | 2 天 | 树上完成全部文件操作，agent 改动有蓝点 |
| M2 | CodeMirror 编辑器（多 tab/保存/只读/冲突提示） | 3 天 | 改代码→Ctrl+S→agent 能读到新内容 |
| M3 | 跨文件搜索（+单文件替换） | 1.5 天 | 搜中文串能定位到行列 |
| M4 | Git 状态 + diff 数据源 | 1.5 天 | 文件树显示 M/U，点击看 diff |
| M5 | 联动（改动浮条/diff 视图/卡片跳转/选中即问） | 2 天 | agent 改完 → 两击内看到 diff |
| M6 | Monaco 内核 + LSP 桥（app:// 协议、worker 分包、pyright/pylsp） | 1.5 天 | python 补全/悬停/Ctrl+点击跨文件跳定义、TS 浏览器内 tsserver 生效 |

## 10. 风险与对策

- **bundle 膨胀**：Monaco 主包 ~800KB + 首批 chunk ~1.5MB（语言语法独立分块按需加载）；
  5 个 worker 共 ~2.5MB 仅在用到对应语言时拉起。便携包用模式匹配收全产物（chunk-*.js/css、monaco-*.worker.js、codicon-*.ttf）。
- **大仓库文件树卡顿**：懒展开 + ignore 过滤后无压力；不做全局递归树。
- **Agent 与人同时写同一文件**：v1 用「顶栏冲突黄条 + diff 选择」，不做 OT/CRDT 实时合并（明确不做的范围）。
- **Windows 路径**：全部相对工作区 posix 风格传输（现有 ReadWorkspaceFile 惯例）；Monaco model 的
  file:// URI 由 workspaceRoot（main.ts query 传入）+ 相对路径拼出，URI 匹配做大小写不敏感。
- **语言服务器不在**：pylsp/pyright 探测失败 → LspStatus(error) → 编辑器退回 daemon lint/GotoDef 兜底，功能不倒退。
