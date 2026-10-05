# My-Harness 工作台（Workbench）设计 —— 媲美 VS Code 的写代码体验

> **状态（2026-10-05）：M0-M5 已全部实现**（CodeMirror 6 方案、三栏布局、文件树、编辑器、跨文件搜索、
> Git 角标 + MergeView diff、Agent 联动四件套）。协议新增见 PROTOCOL.md「工作台（IDE）」段。
> 桌面端源码：`apps/desktop/renderer/workbench.tsx`（FileTree/EditorPane/DiffView）+ icons.tsx + ws.ts。

> 目标：让 My-Harness 从「对话窗口」进化为「Agent 结对工作台」——人能看项目结构、读代码、改代码、
> 审查 Agent 的每一次修改；Agent 的工具调用与人的编辑器双向联动。
> 定位是 **ZCode / Cursor 式的结对工作台**，不是通用 IDE：不做 LSP 补全、不做调试器、不做插件市场。

## 0. 设计原则

1. **编辑器只是协议的另一个客户端**：所有文件读写都走 daemon（工作区安全边界、权限闸、shadow 快照全部复用），
   不在渲染层开第二套文件访问路径。CLI / 桌面端 / 未来 Web 端共享同一组命令。
2. **协议只增不改**：新命令全部新增，旧客户端忽略未知 type 即可（PROTOCOL.md 惯例）。
3. **Agent 联动是一等公民**：这不是顺带功能——文件树/编辑器/diff 的价值一半来自「Agent 正在改什么看得见」。
4. **懒加载保启动速度**：编辑器内核与语言包按需 import；文件树目录懒展开；bundle 增量控制在 +400KB 内（编辑器内核除外，见 §2）。

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

## 3. 编辑器（M2，核心投入）

**内核选型：CodeMirror 6（推荐）** vs Monaco
- CodeMirror 6：核心 ~300KB gz、语言包按需动态 import、启动快、移动性好——ZCode 实测同量级。
- Monaco：真 VS Code 内核（补全/悬停最强）但 ~5MB、启动重、和 React 集成繁琐。
- **结论：先 CodeMirror 6**。语法高亮覆盖 ts/js/tsx/py/json/md/css/html/sh/toml/yaml/go/rust/java/c 系；
  补全不在承诺内（那是 LSP 的活，见 §7 不做清单）。

**功能清单**
- 多 tab（中间区），脏标记 · Ctrl+S 保存（走 `WriteWorkspaceFile`）· 关闭前未保存提示。
- 行号 / 当前行高亮 / 括号匹配 / 搜索（面板内 Ctrl+F，CodeMirror 自带）/ 自动换行开关。
- 只读模式：>1MB 文本、`binary` 文件（显示元信息 + 「用 Agent 看看」入口）。
- 编辑冲突处理：Agent 改动了已打开的文件 → 顶栏黄条「文件已被 Agent 修改 · 重新加载 / 保留我的版本」（diff 后选）。
- 打开方式：文件树单击预览（斜体 tab，复用 VS Code 习惯）、双击固定；Agent 卡片点击跳转（§5）。

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

LSP/IntelliSense、断点调试、插件市场、远程开发、多根工作区、设置同步。
（这些是 VS Code 的护城河，不是 Agent 工作台的刚需；需要补全时用户本来就该开 VS Code，两个工具共存。）

## 8. 协议新增汇总（全部只增）

命令：`ListDir` / `CreateEntry` / `MoveEntry` / `DeleteEntry` / `WriteWorkspaceFile` /
`SearchWorkspace` / `GitStatus` / `GitDiff`
事件：`DirListing` / `FileSaved` / `SearchHit` / `SearchDone` / `FileChanged`（v2 文件 watch 再加）
扩展：`ReadWorkspaceFile` 加 `binary` 语义与 1MB 上限。

## 9. 里程碑与工作量

| 里程碑 | 内容 | 预估 | 交付判据 |
|---|---|---|---|
| M0 | 三栏布局 + 分栏拖拽 + 对话区折叠 | 1 天 | 三栏可拖、对话可折叠、现有功能无损 |
| M1 | 文件树（懒展开/图标/增删改/终端/过滤） | 2 天 | 树上完成全部文件操作，agent 改动有蓝点 |
| M2 | CodeMirror 编辑器（多 tab/保存/只读/冲突提示） | 3 天 | 改代码→Ctrl+S→agent 能读到新内容 |
| M3 | 跨文件搜索（+单文件替换） | 1.5 天 | 搜中文串能定位到行列 |
| M4 | Git 状态 + diff 数据源 | 1.5 天 | 文件树显示 M/U，点击看 diff |
| M5 | 联动（改动浮条/diff 视图/卡片跳转/选中即问） | 2 天 | agent 改完 → 两击内看到 diff |

建议切分确认：**第一批 M0+M1+M2+M5（≈8 天量级的开发节奏，按你验证节奏分批交付）**，M3/M4 第二批。

## 10. 风险与对策

- **bundle 膨胀**：CodeMirror 核心 + 常用语言包预计 +400~600KB gz；语言包全部 dynamic import，不用不全量进首屏。
- **大仓库文件树卡顿**：懒展开 + ignore 过滤后无压力；不做全局递归树。
- **Agent 与人同时写同一文件**：v1 用「顶栏冲突黄条 + diff 选择」，不做 OT/CRDT 实时合并（明确不做的范围）。
- **Windows 路径**：全部相对工作区 posix 风格传输（现有 ReadWorkspaceFile 惯例），渲染层不做绝对路径拼接。
