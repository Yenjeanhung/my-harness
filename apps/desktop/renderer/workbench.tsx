// 工作台组件（IDE-DESIGN.md）：FileTree 资源管理器 / EditorPane 编辑器(CodeMirror 6) / DiffView 改动对比。
// 全部经 ws.ts 的 sendCmd 走 daemon 协议（安全边界/权限闸/快照在服务端复用），不在渲染层碰文件系统。
import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars } from "@codemirror/view";
import type { KeyBinding } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentUnit, bracketMatching, StreamLanguage } from "@codemirror/language";
import { search as cmSearch, searchKeymap } from "@codemirror/search";
import { linter, type Diagnostic } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { MergeView } from "@codemirror/merge";
import { Icon } from "./icons";
import { sendCmd } from "./ws";

// 编辑器里每个打开文件的文档状态（App 层持有，切 tab/重挂载不丢）
export interface FileDoc {
  saved: string; // 最近一次保存/从磁盘读入的内容（脏判定基准）
  text: string; // 当前编辑器文本
  truncated: boolean;
  binary: boolean;
  version: number; // 外部重载（Agent 改动自动刷新）时自增，EditorPane 据此覆盖 CM 文档
}

interface DirEntry {
  name: string;
  kind: "file" | "dir";
  size: number;
  mtime: number;
}

// —— 语言包：按扩展名动态 import（不用的语言不进首屏路径）——
async function langExtension(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  try {
    switch (ext) {
      case "js":
      case "jsx":
      case "mjs":
        return (await import("@codemirror/lang-javascript")).javascript({ jsx: ext !== "js" });
      case "ts":
        return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
      case "tsx":
        return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
      case "py":
        return (await import("@codemirror/lang-python")).python();
      case "json":
        return (await import("@codemirror/lang-json")).json();
      case "html":
      case "htm":
        return (await import("@codemirror/lang-html")).html();
      case "css":
        return (await import("@codemirror/lang-css")).css();
      case "md":
      case "markdown":
        return (await import("@codemirror/lang-markdown")).markdown();
      case "yaml":
      case "yml":
        return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/yaml")).yaml);
      case "toml":
        return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
      case "sh":
      case "bash":
        return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
      case "go":
        return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/go")).go);
      case "rs":
        return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/rust")).rust);
      case "c":
      case "h":
        return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).c);
      case "cpp":
      case "hpp":
      case "cc":
        return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).cpp);
      case "java":
        return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).java);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// git 状态码 → 角标字母与颜色（??/A=绿 U，M=黄，D=红）
function gitBadge(code: string): { letter: string; color: string } | null {
  if (!code) return null;
  if (code === "??" || code === "A") return { letter: "U", color: "#3fb950" };
  if (code.includes("D")) return { letter: "D", color: "#f85149" };
  if (code.includes("M") || code.includes("R")) return { letter: "M", color: "#e3b341" };
  return { letter: code[0], color: "#8b949e" };
}

// —— 语法校验：编辑防抖后把全文发给 daemon（LintCheck），结果经 app.tsx 的 wb-lint 事件转回 ——
interface LintDiag {
  line: number;
  col: number;
  end_line: number;
  end_col: number;
  message: string;
  severity: "error" | "warning" | "info";
}
let lintSeq = 0;
let lintPath = ""; // 当前编辑文件路径（单编辑器实例，模块级即可）
const lintPending = new Map<number, (diags: LintDiag[]) => void>();

// —— 跳转定义（Ctrl+点击）：GotoDef 请求/响应配对，结果经 app.tsx 的 wb-gotodef 事件转回 ——
let gotoSeq = 0;
let gotoPending: { req: number; fn: (file: string | null, line: number) => void } | null = null;

function toCmDiag(state: EditorState, d: LintDiag): Diagnostic {
  const lineNo = Math.min(Math.max(1, d.line), state.doc.lines);
  const line = state.doc.line(lineNo);
  const endNo = Math.min(Math.max(1, d.end_line || d.line), state.doc.lines);
  const endLine = state.doc.line(endNo);
  const from = Math.min(line.from + Math.max(0, d.col), line.to);
  let to = Math.min(endLine.from + Math.max(0, d.end_col), endLine.to);
  if (to <= from) to = Math.min(from + 1, state.doc.length); // 空范围 → 至少标 1 字符
  return { from, to, message: d.message, severity: d.severity || "info" };
}

const cmLinter = linter(
  (view) =>
    new Promise<Diagnostic[]>((resolve) => {
      const req = ++lintSeq;
      const timer = setTimeout(() => {
        lintPending.delete(req);
        resolve([]); // daemon 未响应/超时：不标错，避免卡住 UI
      }, 3000);
      lintPending.set(req, (ds) => {
        clearTimeout(timer);
        resolve(ds.map((d) => toCmDiag(view.state, d)));
      });
      sendCmd({ type: "LintCheck", path: lintPath, text: view.state.doc.toString(), req });
    }),
  { delay: 700 }
);

// —— 资源管理器：懒展开文件树 + 树内增删改 + 跨文件搜索 ——
export function FileTree(props: {
  listing: { path: string; entries: DirEntry[]; n: number } | null;
  searchRes: { query: string; results: { path: string; line: number; col: number; text: string }[]; total: number; truncated: boolean } | null;
  changed: string[];
  gitFiles: Record<string, string>;
  scm: { repo: boolean; branch: string; files: { path: string; code: string; xy: string }[] };
  refreshTick: number;
  onOpen(path: string, line?: number): void;
  onDiff(path: string): void;
  onRefresh(): void;
  onStage(path: string): void;
  onStageAll(): void;
  onUnstage(path: string): void;
  onCommit(message: string, all: boolean): void;
}) {
  const [entries, setEntries] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [newEntry, setNewEntry] = useState<{ parent: string; kind: "file" | "dir" } | null>(null);
  const [newName, setNewName] = useState("");
  const [mode, setMode] = useState<"tree" | "search" | "git">("tree");
  const [searchQ, setSearchQ] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const lastSeq = useRef(0);

  // 服务端 DirListing → 缓存
  useEffect(() => {
    const l = props.listing;
    if (!l) return;
    lastSeq.current += 1;
    setEntries((prev) => ({ ...prev, [l.path || ""]: l.entries }));
  }, [props.listing]);

  // 首次 + 刷新信号：重拉根目录与所有已展开目录
  useEffect(() => {
    sendCmd({ type: "ListDir", path: "" });
    for (const d of expanded) if (d) sendCmd({ type: "ListDir", path: d });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshTick]);

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!entries[dir]) sendCmd({ type: "ListDir", path: dir });
      }
      return next;
    });
  };

  const doneMutation = () => {
    setTimeout(() => props.onRefresh(), 250);
  };

  const submitNew = () => {
    if (!newEntry || !newName.trim()) return setNewEntry(null);
    const rel = newEntry.parent ? `${newEntry.parent}/${newName.trim()}` : newName.trim();
    sendCmd({ type: "CreateEntry", path: rel, kind: newEntry.kind });
    setNewEntry(null);
    setNewName("");
    doneMutation();
  };

  const submitRename = (path: string) => {
    const name = renameVal.trim();
    setRenaming(null);
    if (!name) return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const to = parent ? `${parent}/${name}` : name;
    if (to !== path) {
      sendCmd({ type: "MoveEntry", path, to });
      doneMutation();
    }
  };

  const del = (path: string) => {
    sendCmd({ type: "DeleteEntry", path });
    setConfirmDel(null);
    doneMutation();
  };

  const iconFor = (name: string) => {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    if (["md", "markdown", "txt"].includes(ext)) return "file";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext)) return "download";
    return "file";
  };

  const Row = ({ dir, e, depth }: { dir: string; e: DirEntry; depth: number }) => {
    const path = dir ? `${dir}/${e.name}` : e.name;
    const isOpen = expanded.has(path);
    const badge = gitBadge(props.gitFiles[path]);
    const touched = props.changed.includes(path);
    const kids = entries[path];
    return (
      <>
        <div
          className={"ft-row" + (touched ? " touched" : "")}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (e.kind === "dir" ? toggle(path) : props.onOpen(path))}
          title={path + (e.kind === "file" ? "（悬浮 ✎ 可看改动 diff）" : "")}
        >
          <span className="ft-chev">{e.kind === "dir" ? (isOpen ? "▾" : "▸") : ""}</span>
          <span className="ft-icon">
            <Icon name={e.kind === "dir" ? "folder" : iconFor(e.name)} size={12} />
          </span>
          {renaming === path ? (
            <input
              className="ft-ren"
              autoFocus
              value={renameVal}
              onChange={(ev) => setRenameVal(ev.target.value)}
              onClick={(ev) => ev.stopPropagation()}
              onBlur={() => submitRename(path)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") submitRename(path);
                if (ev.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <span className="ft-name">{e.name}</span>
          )}
          {touched && <span className="ft-dot" title="本次任务已改动" />}
          {badge && (
            <span className="ft-git" style={{ color: badge.color }} title={`git: ${props.gitFiles[path]}`}>
              {badge.letter}
            </span>
          )}
          <span className="ft-acts" onClick={(ev) => ev.stopPropagation()}>
            {e.kind === "dir" && (
              <>
                <button className="ft-b" title="新建文件" onClick={() => { setNewEntry({ parent: path, kind: "file" }); setNewName(""); }}>
                  <Icon name="filePlus" size={11} />
                </button>
                <button className="ft-b" title="新建文件夹" onClick={() => { setNewEntry({ parent: path, kind: "dir" }); setNewName(""); }}>
                  <Icon name="folderPlus" size={11} />
                </button>
              </>
            )}
            {e.kind === "file" && (
              <button className="ft-b" title="查看改动 (diff)" onClick={() => props.onDiff(path)}>
                <Icon name="edit" size={11} />
              </button>
            )}
            <button className="ft-b" title="重命名" onClick={() => { setRenaming(path); setRenameVal(e.name); }}>
              <Icon name="edit" size={11} />
            </button>
            {confirmDel === path ? (
              <>
                <button className="ft-b danger" title="确认删除" onClick={() => del(path)}>✓</button>
                <button className="ft-b" title="取消" onClick={() => setConfirmDel(null)}>×</button>
              </>
            ) : (
              <button className="ft-b" title="删除（进回收站）" onClick={() => setConfirmDel(path)}>
                <Icon name="x" size={11} />
              </button>
            )}
          </span>
        </div>
        {e.kind === "dir" && isOpen && (
          <>
            {(kids || []).map((k) => (
              <Row key={path + "/" + k.name} dir={path} e={k} depth={depth + 1} />
            ))}
            {kids && kids.length === 0 && <div className="ft-empty" style={{ paddingLeft: 22 + depth * 14 }}>(空)</div>}
            {newEntry?.parent === path && (
              <div className="ft-row" style={{ paddingLeft: 22 + depth * 14 }}>
                <Icon name={newEntry.kind === "dir" ? "folder" : "file"} size={12} />
                <input
                  className="ft-ren"
                  autoFocus
                  placeholder={newEntry.kind === "dir" ? "文件夹名，Enter 创建" : "文件名，Enter 创建"}
                  value={newName}
                  onChange={(ev) => setNewName(ev.target.value)}
                  onBlur={submitNew}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") submitNew();
                    if (ev.key === "Escape") setNewEntry(null);
                  }}
                />
              </div>
            )}
          </>
        )}
      </>
    );
  };

  const root = entries[""] || [];
  const searchGroups = new Map<string, { line: number; col: number; text: string }[]>();
  for (const h of props.searchRes?.results || []) {
    if (!searchGroups.has(h.path)) searchGroups.set(h.path, []);
    searchGroups.get(h.path)!.push(h);
  }

  return (
    <div className="ft">
      {/* VSCode 式活动栏：视图切换 + 刷新，替代原顶部拥挤的 seg 按钮 */}
      <div className="ft-act">
        <button title="资源管理器" className={mode === "tree" ? "on" : ""} onClick={() => setMode("tree")}>
          <Icon name="folder" size={16} />
        </button>
        <button title="搜索" className={mode === "search" ? "on" : ""} onClick={() => setMode("search")}>
          <Icon name="search" size={16} />
        </button>
        <button
          title="源代码管理"
          className={mode === "git" ? "on" : ""}
          onClick={() => {
            setMode("git");
            props.onRefresh(); // 进面板即拉最新 git 状态
          }}
        >
          <Icon name="branch" size={16} />
          {props.scm.repo && props.scm.files.length > 0 && <b className="act-badge">{props.scm.files.length}</b>}
        </button>
        <div className="act-spacer" />
        <button title="刷新（同步 git 状态）" onClick={props.onRefresh}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <div className="ft-main">
      {mode === "tree" ? (
        <div className="ft-tree">
          {newEntry?.parent === "" && (
            <div className="ft-row" style={{ paddingLeft: 8 }}>
              <Icon name={newEntry.kind === "dir" ? "folder" : "file"} size={12} />
              <input
                className="ft-ren"
                autoFocus
                placeholder={newEntry.kind === "dir" ? "文件夹名" : "文件名"}
                value={newName}
                onChange={(ev) => setNewName(ev.target.value)}
                onBlur={submitNew}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") submitNew();
                  if (ev.key === "Escape") setNewEntry(null);
                }}
              />
            </div>
          )}
          {root.map((e) => (
            <Row key={e.name} dir="" e={e} depth={0} />
          ))}
          {!root.length && <div className="ft-empty">(空目录或加载中)</div>}
        </div>
      ) : mode === "search" ? (
        <div className="ft-tree">
          <div className="ft-search">
            <input
              autoFocus
              placeholder="搜索文件内容，Enter 执行"
              value={searchQ}
              onChange={(ev) => setSearchQ(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && searchQ.trim()) sendCmd({ type: "SearchWorkspace", query: searchQ.trim(), max: 300 });
              }}
            />
          </div>
          {props.searchRes && (
            <div className="ft-smeta">
              {props.searchRes.total} 个命中{props.searchRes.truncated ? "（已截断）" : ""}
            </div>
          )}
          {[...searchGroups.entries()].map(([path, hits]) => (
            <div key={path}>
              <div className="ft-spath" title={path} onClick={() => props.onOpen(path)}>
                <Icon name="file" size={11} /> {path}
              </div>
              {hits.map((h, i) => (
                <div key={i} className="ft-hit" onClick={() => props.onOpen(path, h.line)}>
                  <span className="ft-ln">{h.line}</span>
                  <span className="ft-htext">{h.text.trim()}</span>
                </div>
              ))}
            </div>
          ))}
          {props.searchRes && props.searchRes.total === 0 && <div className="ft-empty">无匹配</div>}
        </div>
      ) : (
        <GitPanel
          scm={props.scm}
          msg={commitMsg}
          setMsg={setCommitMsg}
          onStage={props.onStage}
          onStageAll={props.onStageAll}
          onUnstage={props.onUnstage}
          onCommit={props.onCommit}
          onDiff={props.onDiff}
          onOpen={props.onOpen}
        />
      )}
      </div>
    </div>
  );
}

// —— 源代码管理（VSCode 式）：提交信息 + 暂存/更改两栏 + stage/unstage ——
function GitPanel(props: {
  scm: { repo: boolean; branch: string; files: { path: string; code: string; xy: string }[] };
  msg: string;
  setMsg(v: string): void;
  onStage(path: string): void;
  onStageAll(): void;
  onUnstage(path: string): void;
  onCommit(message: string, all: boolean): void;
  onDiff(path: string): void;
  onOpen(path: string, line?: number): void;
}) {
  const { scm } = props;
  // xy 两位码：X=暂存区（第 1 位）、Y=工作区（第 2 位）；?? 未跟踪
  const staged = scm.files.filter((f) => f.xy[0] !== " " && f.xy[0] !== "?");
  const changes = scm.files.filter((f) => f.xy[1] !== " " || f.xy[0] === "?");
  const canCommit = scm.repo && props.msg.trim().length > 0 && (staged.length > 0 || changes.length > 0);
  const badge = (f: { xy: string }) => {
    const c = f.xy === "?? " || f.xy === "??" ? "U" : f.xy[1] !== " " ? f.xy[1] : f.xy[0];
    const color = c.includes("D") ? "#f85149" : c === "U" || c === "A" ? "#3fb950" : "#e3b341";
    return <span className="git-badge" style={{ color }}>{c}</span>;
  };
  const row = (f: { path: string; xy: string }, inStaged: boolean) => {
    const name = f.path.split(/[\\/]/).pop() || f.path;
    const dir = f.path.slice(0, f.path.length - name.length).replace(/[\\/]$/, "");
    return (
      <div key={f.path} className="git-row" title={f.path} onClick={() => props.onDiff(f.path)}>
        {badge(f)}
        <span className="git-name">{name}</span>
        <span className="git-dir">{dir}</span>
        <span
          className="git-act"
          title={inStaged ? "取消暂存" : "暂存"}
          onClick={(e) => {
            e.stopPropagation();
            inStaged ? props.onUnstage(f.path) : props.onStage(f.path);
          }}
        >
          {inStaged ? "−" : "+"}
        </span>
      </div>
    );
  };
  if (!scm.repo)
    return (
      <div className="ft-git">
        <div className="ft-empty">当前目录不是 git 仓库</div>
      </div>
    );
  return (
    <div className="ft-git">
      <textarea
        className="git-msg"
        placeholder="提交信息…"
        value={props.msg}
        rows={2}
        onChange={(e) => props.setMsg(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit) {
            props.onCommit(props.msg.trim(), staged.length === 0);
            props.setMsg("");
          }
        }}
      />
      <button
        className="git-commit"
        disabled={!canCommit}
        title={staged.length === 0 ? "无暂存内容：提交全部更改（git commit -a）" : "提交暂存内容"}
        onClick={() => {
          props.onCommit(props.msg.trim(), staged.length === 0);
          props.setMsg("");
        }}
      >
        ✓ 提交{staged.length > 0 ? `（${staged.length}）` : changes.length > 0 ? "全部" : ""}
      </button>
      {scm.branch && <div className="git-branch">⑂ {scm.branch}</div>}
      <div className="git-sec">
        暂存的更改 <b>{staged.length}</b>
      </div>
      {staged.map((f) => row(f, true))}
      <div className="git-sec">
        <span>
          更改 <b>{changes.length}</b>
        </span>
        {changes.length > 0 && (
          <span className="git-sec-act" title="全部暂存（含新增/删除）" onClick={() => props.onStageAll()}>
            ＋
          </span>
        )}
      </div>
      {changes.map((f) => row(f, false))}
      {staged.length === 0 && changes.length === 0 && <div className="ft-empty">工作区干净</div>}
    </div>
  );
}

// —— 编辑器：多 tab + CodeMirror 6 + 冲突条 + 选中即问 ——
export function EditorPane(props: {
  tabs: { path: string; dirty: boolean; truncated: boolean; binary: boolean }[];
  diffTabs: string[];
  active: { kind: "file" | "diff"; path: string | null };
  docs: React.MutableRefObject<Record<string, FileDoc>>;
  conflict: string | null;
  diffData: Record<string, { base?: string; current?: string }>;
  reveal: { path: string; line: number } | null;
  gitLabel: (path: string) => string;
  onActivate(kind: "file" | "diff", path: string): void;
  onClose(kind: "file" | "diff", path: string): void;
  onSave(path: string): void;
  onText(path: string, text: string): void;
  onDirty(path: string, dirty: boolean): void;
  onAsk(text: string): void;
  onAiAction(kind: "explain" | "comment" | "refactor" | "fix" | "test" | "file-review", path: string, sel: string, fromLine: number, toLine: number): void;
  onAddRef(path: string, fromLine: number, toLine: number): void;
  onJump(path: string, line: number): void; // 跳转定义命中 / 行号引用 → App 的 openFile
  onConflictReload(): void;
  onConflictKeep(): void;
  onBrowse(): void; // 空态：去文件树
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  const activeRef = useRef(props.active);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [hasSelection, setHasSelection] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const ctxRef = useRef<HTMLDivElement | null>(null);
  const aiRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent) => {
      // 菜单内部的按下不算关闭，否则 mousedown 先移除了菜单，click 永远到不了菜单项
      if (ctxRef.current && ctxRef.current.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [ctxMenu]);
  useEffect(() => {
    if (!aiOpen) return;
    const onDown = (e: MouseEvent) => {
      if (aiRef.current && !aiRef.current.contains(e.target as Node)) setAiOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [aiOpen]);

  useEffect(() => {
    activeRef.current = props.active;
  }, [props.active]);

  // LintResult 事件 → 唤醒等待中的 linter promise（app.tsx 收到 daemon 消息后转发）
  useEffect(() => {
    const onLint = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { req: number; diagnostics?: LintDiag[] };
      const waiter = d && typeof d.req === "number" ? lintPending.get(d.req) : undefined;
      if (waiter) {
        lintPending.delete(d.req);
        waiter(d.diagnostics || []);
      }
    };
    window.addEventListener("wb-lint", onLint);
    // GotoDefResult 事件 → 命中则跳转打开
    const onGoto = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { req: number; file: string | null; line: number };
      if (gotoPending?.req === d.req) gotoPending.fn(d.file, d.line || 1);
    };
    window.addEventListener("wb-gotodef", onGoto);
    return () => {
      window.removeEventListener("wb-lint", onLint);
      window.removeEventListener("wb-gotodef", onGoto);
    };
  }, []);

  // 创建 CM 实例（一次）
  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    const initial = propsRef.current.active;
    const doc0 = initial.kind === "file" && initial.path ? propsRef.current.docs.current[initial.path]?.text ?? "" : "";
    viewRef.current = new EditorView({
      state: EditorState.create({
        doc: doc0,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          indentUnit.of("    "),
          cmSearch({ top: true }),
          keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab] as KeyBinding[]),
          langComp.current.of([]),
          cmLinter,
          oneDark,
          EditorView.domEventHandlers({
            contextmenu: (event, view) => {
              const { from, to } = view.state.selection.main;
              if (from === to) return false; // 无选区走系统默认菜单
              event.preventDefault();
              setCtxMenu({ x: event.clientX, y: event.clientY });
              return true;
            },
            click: (event, view) => {
              // Ctrl/Cmd+点击标识符 → 跳转定义（后端 GotoDef 全工作区搜 def/class）
              if (!(event.ctrlKey || event.metaKey)) return false;
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos == null) return false;
              const word = view.state.wordAt(pos);
              if (!word) return false;
              const name = view.state.sliceDoc(word.from, word.to);
              if (!/^[A-Za-z_]\w*$/.test(name)) return false;
              const a = activeRef.current;
              if (a.kind !== "file" || !a.path) return false;
              const req = ++gotoSeq;
              event.preventDefault();
              sendCmd({ type: "GotoDef", name, path: a.path, req });
              const timer = setTimeout(() => {
                if (gotoPending?.req === req) gotoPending = null; // daemon 未响应：超时放弃
              }, 3000);
              gotoPending = {
                req,
                fn: (file, line) => {
                  clearTimeout(timer);
                  gotoPending = null;
                  if (file) propsRef.current.onJump(file, line);
                },
              };
              return true;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const a = activeRef.current;
            if (a.kind !== "file" || !a.path) return;
            const text = u.state.doc.toString();
            const d = propsRef.current.docs.current[a.path];
            if (d) {
              d.text = text;
              propsRef.current.onText(a.path, text);
              propsRef.current.onDirty(a.path, text !== d.saved);
            }
            setHasSelection(!u.state.selection.main.empty);
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { fontFamily: "Consolas, 'Cascadia Mono', monospace", lineHeight: "1.55" },
            ".cm-gutters": { background: "#0d1017", borderRight: "1px solid #262a33" },
            ".cm-activeLine": { background: "#161b2266" },
          }),
        ],
      }),
      parent: hostRef.current,
    });
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切 tab / 外部重载(version)：覆盖 CM 文档 + 切语言
  const activePath = props.active.kind === "file" ? props.active.path : null;
  const docVersion = activePath ? props.docs.current[activePath]?.version : 0;
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !activePath) return;
    const d = props.docs.current[activePath];
    if (!d) return;
    lintPath = activePath; // linter 闭包按当前文件路径发 LintCheck
    if (view.state.doc.toString() !== d.text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: d.text } });
    }
    let cancelled = false;
    langExtension(activePath).then((ext) => {
      if (!cancelled && viewRef.current) viewRef.current.dispatch({ effects: langComp.current.reconfigure(ext || []) });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, docVersion]);

  // 跳转定位（搜索命中 / 工具卡片）
  useEffect(() => {
    const view = viewRef.current;
    const r = props.reveal;
    if (!view || !r || r.path !== activePath) return;
    const line = view.state.doc.line(Math.max(1, Math.min(r.line, view.state.doc.lines)));
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    view.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reveal?.path, props.reveal?.line, activePath, docVersion]);

  const askSelection = () => {
    const view = viewRef.current;
    const p = activePath;
    if (!view || !p) return;
    const { from, to } = view.state.selection.main;
    if (from === to) return;
    const startLine = view.state.doc.lineAt(from).number;
    const endLine = view.state.doc.lineAt(to).number;
    const sel = view.state.sliceDoc(from, to);
    if (sel.length > 8000) {
      props.onAsk(`${p}:${startLine}-${endLine} 有 ${sel.length} 字符选中内容，请用 read_file 查看该范围。`);
    } else {
      props.onAsk(`关于 ${p}:${startLine}-${endLine} 的这段代码：\n\`\`\`\n${sel}\n\`\`\`\n`);
    }
  };
  // AI 辅助：取选区（无选区=整文件），组装引用后交给 App 发给 Agent
  const runAi = (kind: "explain" | "comment" | "refactor" | "fix" | "test" | "file-review") => {
    setAiOpen(false);
    const view = viewRef.current;
    const p = activePath;
    if (!view || !p) return;
    const { from, to } = view.state.selection.main;
    const has = from !== to;
    const startLine = has ? view.state.doc.lineAt(from).number : 1;
    const endLine = has ? view.state.doc.lineAt(to).number : view.state.doc.lines;
    const sel = has ? view.state.sliceDoc(from, to) : view.state.doc.toString().slice(0, 8000);
    props.onAiAction(kind, p, sel, startLine, endLine);
  };
  // 选区加入对话：不塞正文，由 composer 显示引用 chip，发送时展开内容
  const addRef = () => {
    const view = viewRef.current;
    const p = activePath;
    if (!view || !p) return;
    const { from, to } = view.state.selection.main;
    if (from === to) return;
    const startLine = view.state.doc.lineAt(from).number;
    const endLine = view.state.doc.lineAt(to).number;
    setAiOpen(false);
    props.onAddRef(p, startLine, endLine);
  };

  const fileName = (p: string) => p.split(/[\\/]/).pop() || p;
  const isEmpty = props.active.path == null;

  return (
    <div className="ed">
      <div className="ed-tabs">
        {props.tabs.map((t) => (
          <div
            key={t.path}
            className={"ed-tab" + (props.active.kind === "file" && props.active.path === t.path ? " on" : "")}
            onClick={() => props.onActivate("file", t.path)}
            title={t.path}
          >
            <span className={"ed-name" + (t.dirty ? " dirty" : "")}>{fileName(t.path)}</span>
            {t.binary && <span className="ed-bin">二进制</span>}
            <button
              className="ed-x"
              title={t.dirty ? "关闭（有未保存修改）" : "关闭"}
              onClick={(e) => {
                e.stopPropagation();
                props.onClose("file", t.path);
              }}
            >
              ×
            </button>
          </div>
        ))}
        {props.diffTabs.map((p) => (
          <div
            key={"diff:" + p}
            className={"ed-tab diff" + (props.active.kind === "diff" && props.active.path === p ? " on" : "")}
            onClick={() => props.onActivate("diff", p)}
            title={`改动对比：${p}`}
          >
            <Icon name="branch" size={11} />
            <span className="ed-name">{fileName(p)} (diff)</span>
            <button className="ed-x" title="关闭" onClick={(e) => { e.stopPropagation(); props.onClose("diff", p); }}>
              ×
            </button>
          </div>
        ))}
        <div style={{ flex: 1 }} />
        {props.active.kind === "file" && activePath && (
          <>
            <button className="ed-tool" title="Ctrl+S 保存" onClick={() => props.onSave(activePath)}>
              保存
            </button>
          </>
        )}
      </div>
      {props.conflict && (
        <div className="ed-conflict">
          <span>⚠ 文件已被 Agent 修改：{fileName(props.conflict)}</span>
          <button className="primary" onClick={props.onConflictReload}>重新加载</button>
          <button onClick={props.onConflictKeep}>保留我的版本</button>
        </div>
      )}
      <div className="ed-stage">
        {props.active.kind === "diff" && props.active.path ? (
          <DiffView path={props.active.path} store={props.diffData[props.active.path]} />
        ) : (
          <>
            <div ref={hostRef} className="ed-host" />
            <div className="ed-floats">
            {hasSelection && (
              <button className="ed-tool add2chat" title="选区加入对话（发送时自动带上代码）" onClick={addRef}>
                <Icon name="download" size={13} />
              </button>
            )}
            <div className="ai-wrap" ref={aiRef}>
              <button
                className={"ed-tool ai" + (aiOpen ? " on" : "")}
                title="AI 辅助（有选区=作用于选区，无选区=作用于整个文件）"
                onClick={() => setAiOpen((o) => !o)}
              >
                <Icon name="sparkles" size={12} /> AI
              </button>
              {aiOpen && (
                <div className="ai-menu down">
                  {hasSelection && (
                    <div className="ai-item" onClick={() => runAi("explain")}>
                      <Icon name="cpu" size={13} /> 解释这段代码
                    </div>
                  )}
                  {hasSelection && (
                    <div className="ai-item" onClick={() => runAi("comment")}>
                      <Icon name="edit" size={13} /> 加注释（直接修改）
                    </div>
                  )}
                  {hasSelection && (
                    <div className="ai-item" onClick={() => runAi("refactor")}>
                      <Icon name="zap" size={13} /> 重构优化（直接修改）
                    </div>
                  )}
                  {hasSelection && (
                    <div className="ai-item" onClick={() => runAi("fix")}>
                      <Icon name="shield-alert" size={13} /> 修复问题（直接修改）
                    </div>
                  )}
                  <div className="ai-item" onClick={() => runAi("test")}>
                    <Icon name="file" size={13} /> 写单元测试
                  </div>
                  <div className="ai-item" onClick={() => runAi("file-review")}>
                    <Icon name="search" size={13} /> 审阅整个文件
                  </div>
                  {hasSelection && (
                    <div className="ai-item" onClick={() => { setAiOpen(false); addRef(); }}>
                      <Icon name="download" size={13} /> 加入对话（带行号引用）
                    </div>
                  )}
                </div>
              )}
            </div>
            </div>
            {ctxMenu && (
              <div className="ctx-menu" ref={ctxRef} style={{ left: ctxMenu.x, top: ctxMenu.y }}>
                <div className="ai-item" onClick={() => { addRef(); setCtxMenu(null); }}>
                  <Icon name="download" size={13} /> 加入对话
                </div>
                <div className="ai-item" onClick={() => { runAi("explain"); setCtxMenu(null); }}>
                  <Icon name="cpu" size={13} /> 解释这段代码
                </div>
                <div className="ai-item" onClick={() => { runAi("comment"); setCtxMenu(null); }}>
                  <Icon name="edit" size={13} /> 加注释（直接修改）
                </div>
                <div className="ai-item" onClick={() => { runAi("refactor"); setCtxMenu(null); }}>
                  <Icon name="zap" size={13} /> 重构优化（直接修改）
                </div>
                <div className="ai-item" onClick={() => { runAi("fix"); setCtxMenu(null); }}>
                  <Icon name="shield-alert" size={13} /> 修复问题（直接修改）
                </div>
                <div
                  className="ai-item"
                  onClick={() => {
                    const view = viewRef.current;
                    if (view) {
                      const { from, to } = view.state.selection.main;
                      navigator.clipboard?.writeText(view.state.sliceDoc(from, to)).catch(() => {});
                    }
                    setCtxMenu(null);
                  }}
                >
                  <Icon name="copy" size={13} /> 复制
                </div>
              </div>
            )}
            {isEmpty && (
              <div className="ed-empty ed-overlay">
                <div className="ed-empty-t">从左侧「文件」打开文件开始阅读 / 编辑</div>
                <button onClick={props.onBrowse}>浏览项目文件</button>
                <div className="ed-empty-s">
                  单击预览 · 双击固定 tab · Ctrl+S 保存 · Agent 改动会在 tab 上标脏并提示冲突
                </div>
              </div>
            )}
            {!isEmpty && activePath && props.docs.current[activePath]?.binary && (
              <div className="ed-empty ed-overlay">
                <div className="ed-empty-t">二进制文件，无法编辑</div>
                <div className="ed-empty-s">{activePath}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}


// —— 改动对比：git index 版本 vs 磁盘当前（CodeMirror MergeView），数据由 App 的 diffStore 注入 ——
export function DiffView({ path, store }: { path: string; store?: { base?: string; current?: string } }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !store || store.base == null || store.current == null) return;
    host.innerHTML = "";
    if (store.base === store.current) {
      const tip = document.createElement("div");
      tip.className = "diff-same";
      tip.textContent = "与 git 基线无改动（未跟踪的新文件基线为空，即全部新增）";
      host.appendChild(tip);
      return;
    }
    const view = new MergeView({
      a: { doc: store.base, extensions: [EditorView.editable.of(false), EditorView.lineWrapping] },
      b: { doc: store.current, extensions: [EditorView.editable.of(false), EditorView.lineWrapping] },
      parent: host,
    });
    return () => view.destroy();
  }, [path, store?.base, store?.current]);

  return (
    <div className="diff-wrap">
      <div className="diff-head">
        <span>基线（git index）</span>
        <span className="diff-path" title={path}>{path}</span>
        <span>当前（磁盘）</span>
      </div>
      <div ref={hostRef} className="diff-host" />
      {(!store || store.base == null || store.current == null) && <div className="diff-loading">加载对比中…</div>}
    </div>
  );
}
