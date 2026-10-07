// 工作台组件（IDE-DESIGN.md M6）：FileTree 资源管理器 / EditorPane 编辑器(Monaco·VS Code 内核) / DiffView 改动对比。
// 全部经 ws.ts 的 sendCmd 走 daemon 协议（安全边界/权限闸/快照在服务端复用），不在渲染层碰文件系统。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";
import { monaco, markersOf, modelFor, getModel, lspLanguageFor, baseEditorOptions, fileUri, type RulerDiag } from "./monaco";
import { ensureStartedForPath, isLspRunning, onLspStatus, requestLocations, type RefLocation } from "./lsp";
import { Icon } from "./icons";
import { mdRender } from "./md";
import { sendCmd } from "./ws";

// 编辑器里每个打开文件的文档状态（App 层持有，切 tab/重挂载不丢）
export interface FileDoc {
  saved: string; // 最近一次保存/从磁盘读入的内容（脏判定基准）
  text: string; // 当前编辑器文本
  truncated: boolean;
  binary: boolean;
  version: number; // 外部重载（Agent 改动自动刷新）时自增，EditorPane 据此覆盖 model 内容
}

interface DirEntry {
  name: string;
  kind: "file" | "dir";
  size: number;
  mtime: number;
}

// git 状态码 → 角标字母与颜色（??/A=绿 U，M=黄，D=红）
function gitBadge(code: string): { letter: string; color: string } | null {
  if (!code) return null;
  if (code === "??" || code === "A") return { letter: "U", color: "#3fb950" };
  if (code.includes("D")) return { letter: "D", color: "#f85149" };
  if (code.includes("M") || code.includes("R")) return { letter: "M", color: "#e3b341" };
  return { letter: code[0], color: "#8b949e" };
}

// —— 语法校验兜底（python 且 LSP 不可用时才发）：编辑防抖后把全文发给 daemon（LintCheck），
// 结果写进 monaco marker 服务——与 LSP 推送诊断、monaco 内建校验（TS/JSON/…）同一出口，
// 报错总览条与 F8 只读 marker，不再单独维护事件 ——
interface LintDiag {
  line: number;
  col: number;
  end_line: number;
  end_col: number;
  message: string;
  severity: "error" | "warning" | "info";
}
let lintSeq = 0;
let lintTimer: ReturnType<typeof setTimeout> | null = null;
const lintPending = new Map<number, string>(); // req → path（daemon 未响应 3s 后自动作废）

function scheduleLint(path: string) {
  if (lspLanguageFor(path) !== "python" || isLspRunning("python")) return;
  if (lintTimer) clearTimeout(lintTimer);
  lintTimer = setTimeout(() => {
    const model = getModel(path);
    if (!model) return;
    const req = ++lintSeq;
    lintPending.set(req, path);
    setTimeout(() => lintPending.delete(req), 3000); // 超时作废：不标错，避免卡住 UI
    sendCmd({ type: "LintCheck", path, text: model.getValue(), req });
  }, 700);
}

function applyLintResult(model: monaco.editor.ITextModel, ds: LintDiag[]) {
  const markers: monaco.editor.IMarkerData[] = ds.map((d) => {
    const startLine = Math.min(Math.max(1, d.line), model.getLineCount());
    const endLine = Math.min(Math.max(1, d.end_line || d.line), model.getLineCount());
    const startCol = Math.max(1, d.col + 1);
    return {
      severity: d.severity === "error" ? monaco.MarkerSeverity.Error : d.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
      message: d.message,
      startLineNumber: startLine,
      startColumn: startCol,
      endLineNumber: endLine,
      endColumn: Math.max(startCol + 1, (d.end_col || d.col) + 1),
      source: "harness-lint",
    };
  });
  monaco.editor.setModelMarkers(model, "harness-lint", markers);
}

// —— 跳转定义兜底（python 且 LSP 不可用）：GotoDef 请求/响应配对，结果经 app.tsx 的 wb-gotodef 转回 ——
let gotoSeq = 0;
let gotoPending: { req: number; fn: (file: string | null, line: number) => void } | null = null;
let gotoFromPath = ""; // 当前文件（EditorPane 切 tab 时同步）——GotoDef 的来源文件

// python 无 LSP：Ctrl+点击 → daemon GotoDef（全工作区搜 def/class/赋值），命中经 opener 打开
monaco.languages.registerDefinitionProvider("python", {
  provideDefinition(model, position) {
    if (isLspRunning("python")) return null; // LSP 在跑：让 lsp.ts 的 provider 应答
    const word = model.getWordAtPosition(position);
    if (!word || !/^[A-Za-z_]\w*$/.test(word.word) || !gotoFromPath) return null;
    const req = ++gotoSeq;
    return new Promise<monaco.languages.Location[]>((resolve) => {
      sendCmd({ type: "GotoDef", name: word.word, path: gotoFromPath, req });
      const timer = setTimeout(() => {
        if (gotoPending?.req === req) gotoPending = null; // daemon 未响应：超时放弃
        resolve([]);
      }, 3000);
      gotoPending = {
        req,
        fn: (file, line) => {
          clearTimeout(timer);
          gotoPending = null;
          resolve(file ? [{ uri: fileUri(file), range: new monaco.Range(line, 1, line, 1) }] : []);
        },
      };
    }).then((locs) => (locs.length ? locs : null));
  },
});

// —— 编辑器右键菜单（自绘，CodeBuddy 式：纯文本项 + 快捷键右对齐 + 分组分隔线，
// 替代 monaco 原生菜单——原生菜单样式不可控且中英文混排）——
interface MenuItem {
  label: string;
  key?: string; // 右侧快捷键提示（仅展示，不负责绑定）
  disabled?: boolean;
  run?(): void;
}

export function EditorMenu(props: { x: number; y: number; items: (MenuItem | "sep")[]; onClose(): void }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [active, setActive] = useState(-1); // 键盘上下文高亮（可运行项）
  // 贴边修正：右/下越界时往回收（渲染后量实际尺寸再摆位）
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let { x, y } = props;
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8);
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [props.x, props.y]);
  // 外点 / Esc / 滚轮关闭；↑↓ 移动高亮、Enter 执行
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = boxRef.current;
      if (el && !el.contains(e.target as Node)) propsRef.current.onClose();
    };
    const enabledIdx = () => {
      const out: number[] = [];
      propsRef.current.items.forEach((it, i) => {
        if (it !== "sep" && !it.disabled) out.push(i);
      });
      return out;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        propsRef.current.onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
      const en = enabledIdx();
      if (!en.length) return;
      e.preventDefault();
      if (e.key === "Enter") {
        const it = propsRef.current.items[active];
        if (it !== "sep" && it && !it.disabled) {
          propsRef.current.onClose();
          it.run?.();
        }
        return;
      }
      const cur = en.indexOf(active);
      const next = e.key === "ArrowDown" ? en[(cur + 1 + en.length) % en.length] : en[(cur - 1 + en.length) % en.length];
      setActive(cur < 0 ? en[0] : next);
    };
    const onWheel = () => propsRef.current.onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pick = (it: MenuItem) => {
    if (it.disabled) return;
    props.onClose();
    it.run?.();
  };
  return (
    <div className="edmenu" ref={boxRef} style={{ left: props.x, top: props.y }} onContextMenu={(e) => e.preventDefault()}>
      {props.items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="msep" />
        ) : (
          <div
            key={i}
            className={"mi" + (it.disabled ? " dis" : "") + (active === i ? " on" : "")}
            onMouseEnter={() => setActive(it.disabled ? -1 : i)}
            onClick={() => pick(it)}
          >
            <span className="ml">{it.label}</span>
            {it.key && <span className="kb">{it.key}</span>}
          </div>
        )
      )}
    </div>
  );
}

// —— 「查找所有引用」结果面板（python 直连 LSP，不依赖目标文件已打开）——
export function RefPanel(props: {
  x: number;
  y: number;
  title: string;
  items: RefLocation[];
  onClose(): void;
  onJump(path: string, line: number): void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let { x, y } = props;
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8);
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [props.x, props.y]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") propsRef.current.onClose();
    };
    const onDown = (e: MouseEvent) => {
      const el = boxRef.current;
      if (el && !el.contains(e.target as Node)) propsRef.current.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, []);
  return (
    <div className="refpanel" ref={boxRef} style={{ left: props.x, top: props.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="rp-head">
        {props.title} <b>{props.items.length}</b> 处 · 点击跳转，Esc 关闭
      </div>
      <div className="rp-list">
        {props.items.map((r, i) => {
          const m = getModel(r.path);
          const text = m ? m.getLineContent(Math.min(r.line, m.getLineCount())).trim().slice(0, 160) : "";
          return (
            <div
              key={i}
              className="rp-row"
              title={`${r.path}:${r.line}:${r.col}`}
              onClick={() => {
                props.onClose();
                props.onJump(r.path, r.line);
              }}
            >
              <span className="rp-loc">
                {r.path.split(/[\\/]/).pop()}:{r.line}
              </span>
              {text && <span className="rp-text">{text}</span>}
            </div>
          );
        })}
        {!props.items.length && <div className="rp-empty">未找到引用（语言服务器未就绪或该符号无引用）</div>}
      </div>
    </div>
  );
}

// —— 资源管理器：懒展开文件树 + 树内增删改 + 跨文件搜索 ——
export function FileTree(props: {
  mode: "tree" | "search" | "git"; // 由 app 级活动栏控制
  listing: { path: string; entries: DirEntry[]; n: number } | null;
  activeFile: string | null; // 编辑器当前活动文件（「定位文件」按钮跳到这里）
  searchRes: { query: string; results: { path: string; line: number; col: number; text: string }[]; files: string[]; total: number; truncated: boolean } | null;
  changed: string[];
  gitFiles: Record<string, string>;
  scm: { repo: boolean; branch: string; ahead?: number; files: { path: string; code: string; xy: string }[]; error?: string };
  refreshTick: number;
  onOpen(path: string, line?: number): void;
  onDiff(path: string): void;
  onRefresh(): void;
  onCollapse(): void; // 收起侧栏（VSCode 资源管理器标题栏最后一个按钮）
  onStage(path: string): void;
  onStageAll(): void;
  onUnstage(path: string): void;
  onCommit(message: string, all: boolean, push: boolean): void;
  onPush(): void;
  onGenMsg(): void;
}) {
  const [entries, setEntries] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [newEntry, setNewEntry] = useState<{ parent: string; kind: "file" | "dir" } | null>(null);
  const [newName, setNewName] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  // 行右键菜单：在资源管理器中显示（桌面端 shell.showItemInFolder，浏览器环境无此能力则不出现）
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string; kind: "file" | "dir" } | null>(null);
  const ctxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ctx) return;
    const onDown = (e: MouseEvent) => {
      if (ctxRef.current && ctxRef.current.contains(e.target as Node)) return;
      setCtx(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [ctx]);
  const [pushing, setPushing] = useState(false); // 推送进行中：按钮禁用，GitDone(op=push) 经 wb-pushdone 复位
  const lastSeq = useRef(0);
  // 「定位文件」：展开活动文件的各级祖先目录 → 行渲染出来后滚动过去并短暂高亮
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  const [flashPath, setFlashPath] = useState<string | null>(null);

  useEffect(() => {
    const onPushDone = () => setPushing(false);
    window.addEventListener("wb-pushdone", onPushDone);
    return () => window.removeEventListener("wb-pushdone", onPushDone);
  }, []);

  // 顶栏菜单「文件→新建文件」：在根目录打开内联输入框（App 侧保证已切到资源管理器再派发）
  useEffect(() => {
    const onNew = () => {
      setExpanded((prev) => new Set(prev).add(""));
      setNewEntry({ parent: "", kind: "file" });
      setNewName("");
    };
    window.addEventListener("wb-newfile", onNew);
    return () => window.removeEventListener("wb-newfile", onNew);
  }, []);

  // 推送入口统一走这里：立即置 pending（按钮禁用），GitDone(op=push) → wb-pushdone 复位
  const doPush = () => {
    if (pushing) return;
    setPushing(true);
    props.onPush();
  };

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

  const revealActive = () => {
    const target = props.activeFile;
    if (!target) return;
    const segs = target.replace(/\\/g, "/").split("/");
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let i = 1; i < segs.length; i++) next.add(segs.slice(0, i).join("/"));
      return next;
    });
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join("/");
      if (!entries[d]) sendCmd({ type: "ListDir", path: d });
    }
    setRevealTarget(target);
    setTimeout(() => setRevealTarget((t) => (t === target ? null : t)), 4000); // 兜底：文件已不在树上时别一直等
  };

  // 各级目录列表到位、目标行渲染出来后：滚动到中间 + 高亮 1.6s（列表没到就等下一轮 entries 更新）
  useEffect(() => {
    if (!revealTarget) return;
    const el = document.querySelector(`[data-ft-path="${CSS.escape(revealTarget)}"]`) as HTMLElement | null;
    if (!el) return;
    setRevealTarget(null);
    el.scrollIntoView({ block: "center" });
    setFlashPath(revealTarget);
    // 定时器不能放 cleanup：setRevealTarget(null) 会立刻重跑本 effect、取消掉刚挂的清除定时器
    setTimeout(() => setFlashPath(null), 1600);
  }, [revealTarget, entries, expanded]);

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
          className={"ft-row" + (touched ? " touched" : "") + (flashPath === path ? " flash" : "")}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-ft-path={path}
          onClick={() => (e.kind === "dir" ? toggle(path) : props.onOpen(path))}
          onContextMenu={(ev) => {
            if (!window.myharness) return; // 浏览器调试环境没有 shell 能力
            ev.preventDefault();
            setCtx({ x: ev.clientX, y: ev.clientY, path, kind: e.kind });
          }}
          title={path}
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
  const ahead = props.scm.ahead || 0; // 本地领先远程的未推送提交数（标题栏推送按钮徽标）
  const searchGroups = new Map<string, { line: number; col: number; text: string }[]>();
  for (const h of props.searchRes?.results || []) {
    if (!searchGroups.has(h.path)) searchGroups.set(h.path, []);
    searchGroups.get(h.path)!.push(h);
  }

  return (
    <div className="ft">
      {props.mode === "tree" && (
        <div className="ft-head">
          <span className="ft-head-title">资源管理器</span>
          <span className="ft-head-acts" onClick={(ev) => ev.stopPropagation()}>
            <button className="ft-b" title="新建文件" onClick={() => { setNewEntry({ parent: "", kind: "file" }); setNewName(""); }}>
              <Icon name="filePlus" size={13} />
            </button>
            <button className="ft-b" title="新建文件夹" onClick={() => { setNewEntry({ parent: "", kind: "dir" }); setNewName(""); }}>
              <Icon name="folderPlus" size={13} />
            </button>
            <button className="ft-b" title="刷新（同步目录与 git 状态）" onClick={props.onRefresh}>
              <Icon name="refresh" size={13} />
            </button>
            <button
              className="ft-b"
              title={props.activeFile ? `定位当前文件：${props.activeFile}` : "定位当前文件（编辑器里没有活动文件）"}
              disabled={!props.activeFile}
              onClick={revealActive}
            >
              <Icon name="locate" size={13} />
            </button>
            <button
              className="ft-b"
              title="折叠全部目录"
              onClick={() => {
                setExpanded(new Set([""]));
                if (!entries[""]) sendCmd({ type: "ListDir", path: "" });
              }}
            >
              <Icon name="fold" size={13} />
            </button>
            <button className="ft-b" title="收起侧栏" onClick={props.onCollapse}>
              <Icon name="panel" size={13} />
            </button>
          </span>
        </div>
      )}
      {props.mode === "tree" ? (
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
      ) : props.mode === "search" ? (
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
          {props.searchRes && ((props.searchRes.files?.length ?? 0) > 0 || props.searchRes.results.length > 0) && (
            <div className="ft-smeta">
              {(props.searchRes.files?.length ?? 0) > 0 && `${props.searchRes.files.length} 个文件名匹配 · `}
              {props.searchRes.total} 个内容命中{props.searchRes.truncated ? "（已截断）" : ""}
            </div>
          )}
          {(props.searchRes?.files?.length ?? 0) > 0 && (
            <div className="ft-ghead">文件名匹配</div>
          )}
          {props.searchRes?.files?.map((f) => {
            const name = f.split("/").pop() || f;
            return (
              <div key={"f" + f} className="ft-row" style={{ paddingLeft: 10 }} title={f} onClick={() => props.onOpen(f)}>
                <span className="ft-icon"><Icon name="file" size={11} /></span>
                <span className="ft-name">{name}</span>
                <span className="ft-dir" style={{ color: "#6e7681", fontSize: 10.5, marginLeft: "auto" }}>{f.slice(0, f.length - name.length - 1)}</span>
              </div>
            );
          })}
          {(props.searchRes?.results?.length ?? 0) > 0 && <div className="ft-ghead">内容命中</div>}
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
      ) : props.mode === "git" ? (
        <>
          <div className="ft-head">
            <span className="ft-head-title">源代码管理</span>
            <span className="ft-head-acts">
              <button
                className="ft-b push-wrap"
                disabled={pushing}
                title={pushing ? "推送中…" : ahead > 0 ? `推送到远程（${ahead} 个未推送提交）` : "推送到远程（git push）"}
                onClick={doPush}
              >
                <Icon name="push" size={13} />
                {ahead > 0 && <b className="push-badge">{ahead}</b>}
              </button>
              <button className="ft-b" title="刷新（同步目录与 git 状态）" onClick={props.onRefresh}>
                <Icon name="refresh" size={13} />
              </button>
            </span>
          </div>
          <GitPanel
            scm={props.scm}
            msg={commitMsg}
            setMsg={setCommitMsg}
            onStage={props.onStage}
            onStageAll={props.onStageAll}
            onUnstage={props.onUnstage}
            onCommit={props.onCommit}
            onPush={doPush}
            onGenMsg={props.onGenMsg}
            onDiff={props.onDiff}
            onOpen={props.onOpen}
          />
        </>
      ) : null}
      {ctx && (
        <div className="ctx-menu" ref={ctxRef} style={{ left: ctx.x, top: ctx.y }}>
          {ctx.kind === "dir" && (
            <>
              <div
                className="ai-item"
                onClick={() => {
                  setNewEntry({ parent: ctx.path, kind: "file" });
                  setNewName("");
                  setCtx(null);
                }}
              >
                <Icon name="filePlus" size={13} /> 新建文件
              </div>
              <div
                className="ai-item"
                onClick={() => {
                  setNewEntry({ parent: ctx.path, kind: "dir" });
                  setNewName("");
                  setCtx(null);
                }}
              >
                <Icon name="folderPlus" size={13} /> 新建文件夹
              </div>
            </>
          )}
          <div
            className="ai-item"
            onClick={() => {
              // 需要该行可见才能内联改名：展开祖先目录后置 renaming（树上行渲染时生效）
              setRenaming(ctx.path);
              setRenameVal(ctx.path.split("/").pop() || ctx.path);
              setCtx(null);
            }}
          >
            <Icon name="edit" size={13} /> 重命名
          </div>
          <div
            className="ai-item"
            onClick={() => {
              setConfirmDel(ctx.path);
              setCtx(null);
            }}
          >
            <Icon name="x" size={13} /> 删除（进回收站）
          </div>
          <div
            className="ai-item"
            onClick={() => {
              navigator.clipboard?.writeText(ctx.path).catch(() => {});
              setCtx(null);
            }}
          >
            <Icon name="file" size={13} /> 复制相对路径
          </div>
          <div className="msep" />
          <div
            className="ai-item"
            onClick={() => {
              window.myharness?.showInFolder(ctx.path);
              setCtx(null);
            }}
          >
            <Icon name="folder" size={13} /> {ctx.kind === "dir" ? "在资源管理器中打开" : "在资源管理器中显示"}
          </div>
        </div>
      )}
    </div>
  );
}

// —— 源代码管理（VSCode 式）：提交信息 + 暂存/更改两栏 + stage/unstage ——
function GitPanel(props: {
  scm: { repo: boolean; branch: string; ahead?: number; files: { path: string; code: string; xy: string }[]; error?: string };
  msg: string;
  setMsg(v: string): void;
  onStage(path: string): void;
  onStageAll(): void;
  onUnstage(path: string): void;
  onCommit(message: string, all: boolean, push: boolean): void;
  onPush(): void;
  onGenMsg(): void; // AI 生成提交信息
  onDiff(path: string): void;
  onOpen(path: string, line?: number): void;
}) {
  const { scm } = props;
  const ahead = scm.ahead || 0; // 未推送提交数：无可提交内容时该按钮退化为纯推送并显示计数
  const [genPending, setGenPending] = useState(false);
  // AI 生成的提交信息（app.tsx 转发的 wb-gitmsg 事件）→ 填进输入框
  useEffect(() => {
    const onMsg = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { ok: boolean; message?: string; error?: string };
      setGenPending(false);
      if (d.ok && d.message) props.setMsg(d.message);
    };
    window.addEventListener("wb-gitmsg", onMsg);
    return () => window.removeEventListener("wb-gitmsg", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
        {/* repo:false 且带 error = git 本身不可用/执行失败，如实显示原因；否则才是真·不是仓库 */}
        <div className="ft-empty">{scm.error || "当前目录不是 git 仓库"}</div>
      </div>
    );
  return (
    <div className="ft-git">
      <div className="git-msg-wrap">
        <textarea
          className="git-msg"
          placeholder="提交信息…"
          value={props.msg}
          rows={2}
          onChange={(e) => props.setMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit) {
              props.onCommit(props.msg.trim(), staged.length === 0, false);
              props.setMsg("");
            }
          }}
        />
        <button
          className="git-gen"
          title={genPending ? "生成中…" : "AI 生成提交信息（基于暂存 diff）"}
          disabled={genPending}
          onClick={() => {
            setGenPending(true);
            props.onGenMsg();
            setTimeout(() => setGenPending(false), 60000); // 兜底复位：模型异常时不永久卡灰
          }}
        >
          <Icon name="sparkles" size={14} />
        </button>
      </div>
      <div className="git-commit-row">
        <button
          className="git-commit"
          disabled={!canCommit}
          title={staged.length === 0 ? "无暂存内容：提交全部更改（git commit -a）" : "提交暂存内容"}
          onClick={() => {
            props.onCommit(props.msg.trim(), staged.length === 0, false);
            props.setMsg("");
          }}
        >
          ✓ 提交{staged.length > 0 ? `（${staged.length}）` : changes.length > 0 ? "全部" : ""}
        </button>
        <button
          className="git-commit-alt push-wrap"
          disabled={!canCommit && ahead === 0}
          title={canCommit ? "提交并推送（commit + push）" : ahead > 0 ? `推送 ${ahead} 个未推送提交` : "提交并推送（commit + push）"}
          onClick={() => {
            if (canCommit) {
              props.onCommit(props.msg.trim(), staged.length === 0, true);
              props.setMsg("");
            } else {
              props.onPush(); // 无可提交内容：纯推送本地已有的未推送提交（FileTree 的 doPush 统一管 pending 态）
            }
          }}
        >
          <Icon name="push" size={13} />
          {!canCommit && ahead > 0 && <b className="push-badge">{ahead}</b>}
        </button>
      </div>
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

// —— 编辑器：多 tab + Monaco（VS Code 内核）+ 冲突条 + 选中即问 ——
// 模型/视图分离：文件 → model（monaco.ts 注册表，URI=file:// 绝对路径，LSP 据此匹配），
// 编辑器实例宿主常驻只建一次；切 tab = setModel + 视图状态保存/恢复（滚动/光标/折叠都保留）。
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
  minimap: boolean; // 查看→最小地图（App 持久化在 localStorage）
  wordWrap: boolean; // 查看→自动换行
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activeRef = useRef(props.active);
  const propsRef = useRef(props);
  propsRef.current = props;
  // 每个 tab 的视图状态（滚动/光标/选区/折叠），切 tab 保存、切回恢复
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const loadedVersion = useRef(new Map<string, number>()); // 各文件已加载的外部重载 version
  const suppress = useRef(false); // 程序化 setValue 期间抑制 onDidChangeContent（外部重载不算用户编辑）
  const modelSubs = useRef(new Map<string, { model: monaco.editor.ITextModel; sub: monaco.IDisposable }>()); // path → {model, onDidChangeContent 订阅}（model 重开换实例后须重挂）
  const prevPathRef = useRef<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  // 报错总览条：当前文件 marker（daemon lint 兜底 + LSP 推送 + monaco 内建校验），F8 跳下一条
  const [diags, setDiags] = useState<RulerDiag[]>([]);
  const diagsRef = useRef(diags);
  const jumpRef = useRef<(dir: 1 | -1) => boolean>(() => false);
  const runAiRef = useRef<(kind: "explain" | "comment" | "refactor" | "fix" | "test" | "file-review") => void>(() => {});
  const addRefRef = useRef<() => void>(() => {});
  // md 预览：编辑/预览切换（仅 .md/.markdown tab 显示按钮）
  const [mdPreview, setMdPreview] = useState(false);
  const [mdTick, setMdTick] = useState(0);
  const mdPreviewRef = useRef(false);
  mdPreviewRef.current = mdPreview;
  const mdToggleRef = useRef(() => {});
  // LSP 状态 chip（python/pyright 等）
  const [lspState, setLspState] = useState<{ language: string; status: string; detail?: string } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const aiRef = useRef<HTMLDivElement | null>(null);
  // 自绘右键菜单 + 引用面板（坐标为视口坐标，组件内部做贴边修正）
  const [edMenu, setEdMenu] = useState<{ x: number; y: number } | null>(null);
  const [refPanel, setRefPanel] = useState<{ x: number; y: number; items: RefLocation[] } | null>(null);
  const openMenuRef = useRef<(x: number, y: number) => void>(() => {});
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

  // daemon 事件（app.tsx 转发）：lint 兜底结果 / 跳转定义结果 / LSP 状态
  useEffect(() => {
    const onLint = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { req: number; diagnostics?: LintDiag[] };
      const path = lintPending.get(d.req);
      if (path == null) return;
      lintPending.delete(d.req);
      const model = getModel(path);
      if (model) applyLintResult(model, d.diagnostics || []);
    };
    const onGoto = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { req: number; file: string | null; line: number };
      if (gotoPending?.req === d.req) gotoPending.fn(d.file, d.line || 1);
    };
    const off = onLspStatus((s) => setLspState({ language: s.language, status: s.status, detail: s.detail }));
    window.addEventListener("wb-lint", onLint);
    window.addEventListener("wb-gotodef", onGoto);
    return () => {
      off();
      window.removeEventListener("wb-lint", onLint);
      window.removeEventListener("wb-gotodef", onGoto);
    };
  }, []);

  // 创建编辑器实例（VS Code 式懒创建：编辑器部分首次真正用到才建，不在应用启动时建——
  // 启动时窗口若尚未可见，monaco 的首布局会作废且 rAF 渲染循环暂停）。快捷键经 *Ref 间接引用最新闭包。
  const editorCleanup = useRef<(() => void) | null>(null);
  const ensureEditor = () => {
    if (editorRef.current || !hostRef.current) return editorRef.current;
    const ed = monaco.editor.create(hostRef.current, {
      ...baseEditorOptions,
      minimap: { enabled: propsRef.current.minimap, renderCharacters: false },
      wordWrap: propsRef.current.wordWrap ? "on" : "off",
    });
    editorRef.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const a = propsRef.current.active;
      if (a.kind === "file" && a.path) propsRef.current.onSave(a.path);
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyV, () => mdToggleRef.current());
    ed.addCommand(monaco.KeyCode.F8, () => {
      jumpRef.current(1);
    });
    ed.onDidChangeCursorSelection(() => setHasSelection(!!ed.getSelection() && !ed.getSelection()!.isEmpty()));
    // 任何来源的 marker 变化（lint 兜底 / LSP 推送 / monaco 内建校验）→ 刷新报错总览条
    const markerSub = monaco.editor.onDidChangeMarkers((uris) => {
      const a = activeRef.current;
      if (a.kind !== "file" || !a.path) return;
      const m = getModel(a.path);
      if (!m || !uris.some((u) => u.toString() === m.uri.toString())) return;
      const ds = markersOf(m.uri);
      diagsRef.current = ds;
      setDiags(ds);
    });
    // 右键菜单：自绘（contextmenu:false 关掉 monaco 原生菜单，host 上监听 contextmenu 事件）。
    // 菜单项在打开时构建（buildMenuItemsRef 指向最新闭包），动作经 ref 走最新 props。
    ed.updateOptions({ contextmenu: false });
    const host = hostRef.current;
    const onDomCtx = (e: MouseEvent) => {
      e.preventDefault();
      openMenuRef.current(e.clientX, e.clientY);
    };
    host?.addEventListener("contextmenu", onDomCtx);
    editorCleanup.current = () => {
      host?.removeEventListener("contextmenu", onDomCtx);
      markerSub.dispose();
      ed.dispose();
      editorRef.current = null;
    };
    return ed;
  };
  // 挂载即建（编辑器列首屏可见，与 VS Code「打开编辑器组即建」一致）；卸载时释放
  useEffect(() => {
    ensureEditor();
    // 窗口从隐藏恢复可见（最小化/托盘回来）：显式重排一次，不等 automaticLayout 的 ResizeObserver
    const onVis = () => {
      if (!document.hidden) editorRef.current?.layout();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      editorCleanup.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 查看→外观开关即时生效（diff 视图固定无 minimap，不在此列）
  useEffect(() => {
    editorRef.current?.updateOptions({ minimap: { enabled: props.minimap, renderCharacters: false } });
  }, [props.minimap]);
  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: props.wordWrap ? "on" : "off" });
  }, [props.wordWrap]);

  // 顶栏菜单 → 编辑器动作桥（app.tsx 派发 wb-edit；动作 id 与自绘右键菜单同一套）
  useEffect(() => {
    const onEdit = (ev: Event) => {
      const action = (ev as CustomEvent).detail?.action as string | undefined;
      const ed = editorRef.current;
      if (!action || !ed) return;
      if (action === "undo" || action === "redo") ed.trigger("menu", action, null);
      else if (action === "nextDiag") jumpRef.current(1);
      else if (action === "mdPreview") mdToggleRef.current();
      else ed.getAction(action)?.run();
      ed.focus();
    };
    window.addEventListener("wb-edit", onEdit);
    return () => window.removeEventListener("wb-edit", onEdit);
  }, []);

  // 切 tab / 外部重载(version)：切 model + 视图状态 + 只读态 + marker 总览
  const activePath = props.active.kind === "file" ? props.active.path : null;
  const isDiff = props.active.kind === "diff" && !!props.active.path; // diff 标签激活：编辑器宿主隐藏不卸载
  const docVersion = activePath ? props.docs.current[activePath]?.version : 0;
  useEffect(() => {
    const ed = ensureEditor();
    if (!ed) return;
    gotoFromPath = activePath || ""; // GotoDef 兜底的来源文件
    // 保存上一个 tab 的视图状态
    const prev = prevPathRef.current;
    if (prev && prev !== activePath && ed.getModel()) viewStates.current.set(prev, ed.saveViewState());
    prevPathRef.current = activePath;

    diagsRef.current = [];
    setDiags([]); // 换文件先清掉上一个文件的报错总览
    if (!activePath) {
      ed.setModel(null);
      return;
    }
    const d = props.docs.current[activePath];
    if (!d) return;
    const model = modelFor(activePath, d.text);
    // 外部重载（Agent 改动，version 自增）：覆盖 model 内容，但保留光标附近的视图状态
    const seen = loadedVersion.current.get(activePath);
    if (seen !== undefined && seen !== docVersion) {
      suppress.current = true;
      model.setValue(d.text);
      suppress.current = false;
    }
    loadedVersion.current.set(activePath, docVersion);
    // 每个文件的内容监听只挂一次（VS Code 式 model↔viewState 绑定）：脏判定 + lint 兜底 + md 预览刷新。
    // 条目带 model 指纹：tab 关闭会释放 model，重开得到新 model 实例时旧订阅随之作废，须重挂。
    const entry = modelSubs.current.get(activePath);
    if (!entry || entry.model !== model) {
      entry?.sub.dispose();
      modelSubs.current.set(
        activePath,
        { model,
          sub: model.onDidChangeContent(() => {
            if (suppress.current) return;
            const a = activeRef.current;
            if (a.kind !== "file" || a.path !== activePath) return;
            const dd = propsRef.current.docs.current[activePath];
            const text = model.getValue();
            if (dd) {
              dd.text = text;
              propsRef.current.onText(activePath, text);
              propsRef.current.onDirty(activePath, text !== dd.saved);
            }
            setHasSelection(!!editorRef.current?.getSelection() && !editorRef.current!.getSelection()!.isEmpty());
            if (mdPreviewRef.current) setMdTick((t) => t + 1);
            scheduleLint(activePath);
          }) }
      );
    }
    ed.setModel(model);
    const vs = viewStates.current.get(activePath);
    if (vs) ed.restoreViewState(vs);
    ed.updateOptions({ readOnly: !!(d.binary || d.truncated) });
    const ds = markersOf(model.uri);
    diagsRef.current = ds;
    setDiags(ds);
    if (!isDiff && !mdPreviewRef.current) ed.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, docVersion]);

  // python 文件：自动经 daemon 拉起语言服务器（pyright/pylsp，TS/JSON/CSS/HTML 用 monaco 内建服务无需外部进程）
  useEffect(() => {
    if (activePath) ensureStartedForPath(activePath);
  }, [activePath]);

  // 跳转定位（搜索命中 / 工具卡片）
  useEffect(() => {
    const ed = editorRef.current;
    const r = props.reveal;
    if (!ed || !r || r.path !== activePath) return;
    const model = ed.getModel();
    if (!model) return;
    const line = Math.max(1, Math.min(r.line, model.getLineCount()));
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reveal?.path, props.reveal?.line, activePath, docVersion]);

  const askSelection = () => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const p = activePath;
    if (!ed || !model || !p) return;
    const sel = ed.getSelection();
    if (!sel || sel.isEmpty()) return;
    const selText = model.getValueInRange(sel);
    if (selText.length > 8000) {
      props.onAsk(`${p}:${sel.startLineNumber}-${sel.endLineNumber} 有 ${selText.length} 字符选中内容，请用 read_file 查看该范围。`);
    } else {
      props.onAsk(`关于 ${p}:${sel.startLineNumber}-${sel.endLineNumber} 的这段代码：\n\`\`\`\n${selText}\n\`\`\`\n`);
    }
  };
  // AI 辅助：取选区（无选区=整文件），组装引用后交给 App 发给 Agent
  const runAi = (kind: "explain" | "comment" | "refactor" | "fix" | "test" | "file-review") => {
    setAiOpen(false);
    const ed = editorRef.current;
    const model = ed?.getModel();
    const p = activePath;
    if (!ed || !model || !p) return;
    const sel = ed.getSelection();
    const has = !!sel && !sel.isEmpty();
    const startLine = has ? sel!.startLineNumber : 1;
    const endLine = has ? sel!.endLineNumber : model.getLineCount();
    const selText = has ? model.getValueInRange(sel!) : model.getValue().slice(0, 8000);
    props.onAiAction(kind, p, selText, startLine, endLine);
  };
  // 选区插入对话输入框（@path:行段 token 长在句子里），发送时 composeMessage 就地展开成代码块
  const addRef = () => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const p = activePath;
    if (!ed || !model || !p) return;
    const sel = ed.getSelection();
    if (!sel || sel.isEmpty()) return;
    setAiOpen(false);
    props.onAddRef(p, sel.startLineNumber, sel.endLineNumber);
  };
  runAiRef.current = runAi;
  addRefRef.current = addRef;
  // —— 自绘右键菜单：打开时按当前状态构建菜单项 ——
  // python 无 LSP 时依赖 LSP 的项置灰（重命名/格式化/整理 Import/引用查找没有免 LSP 的兜底实现）
  const buildMenuItems = (): (MenuItem | "sep")[] => {
    const ed = editorRef.current;
    if (!ed) return [];
    const sel = ed.getSelection();
    const hasSel = !!sel && !sel.isEmpty();
    const pyNoLsp = lspLanguageFor(activePath || "") === "python" && !isLspRunning("python");
    const act = (id: string) => () => {
      ed.getAction(id)?.run();
    };
    const ai = (k: "explain" | "comment" | "refactor" | "fix" | "test" | "file-review") => () => runAiRef.current(k);
    return [
      { label: "转到定义", key: "F12", run: act("editor.action.revealDefinition") },
      { label: "转到声明", run: act("editor.action.revealDeclaration") },
      { label: "转到类型定义", run: act("editor.action.goToTypeDefinition") },
      { label: "转到实现", run: act("editor.action.goToImplementation") },
      // python 的引用查找走直连 LSP + 自绘面板（monaco 的 peek 要求目标文件已打开才有内容）
      langIsPy(activePath) && isLspRunning("python")
        ? { label: "转到引用", key: "Shift+F12", run: () => void showPythonRefs(-1, -1) }
        : { label: "转到引用", key: "Shift+F12", disabled: langIsPy(activePath) && pyNoLsp, run: act("editor.action.goToReferences") },
      { label: "快速查看", run: act("editor.action.peekDefinition") },
      "sep",
      { label: "重命名符号", key: "F2", disabled: pyNoLsp, run: act("editor.action.rename") },
      { label: "更改所有匹配项", key: "Ctrl+F2", disabled: !hasSel, run: act("editor.action.changeAll") },
      { label: "添加行注释", key: "Ctrl+/", run: act("editor.action.commentLine") },
      { label: "格式化文档", disabled: pyNoLsp, run: act("editor.action.formatDocument") },
      // monaco 的 organizeImports 只挂在 TS/JS 语言服务上，python 没有对应能力 → 置灰
      { label: "整理 Import", disabled: pyNoLsp || langIsPy(activePath), run: act("editor.action.organizeImports") },
      "sep",
      { label: "剪切", key: "Ctrl+X", disabled: !hasSel, run: act("editor.action.clipboardCutAction") },
      { label: "复制", key: "Ctrl+C", disabled: !hasSel, run: act("editor.action.clipboardCopyAction") },
      { label: "粘贴", key: "Ctrl+V", run: act("editor.action.clipboardPasteAction") },
      "sep",
      { label: "AI：解释这段代码", disabled: !hasSel, run: ai("explain") },
      { label: "AI：加注释（直接修改）", disabled: !hasSel, run: ai("comment") },
      { label: "AI：重构优化（直接修改）", disabled: !hasSel, run: ai("refactor") },
      { label: "AI：修复问题（直接修改）", disabled: !hasSel, run: ai("fix") },
      { label: "AI：写单元测试", run: ai("test") },
      { label: "AI：审阅整个文件", run: ai("file-review") },
      { label: "插入到对话（带行号引用）", disabled: !hasSel, run: () => addRefRef.current() },
      "sep",
      { label: "命令面板…", key: "F1", run: act("editor.action.quickCommand") },
    ];
  };
  const langIsPy = (p: string | null) => !!p && lspLanguageFor(p) === "python";
  // python 查找引用：直连 LSP，结果面板支持跳未打开的文件
  const showPythonRefs = async (x: number, y: number) => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    const pos = ed?.getPosition();
    if (!ed || !model || !pos) return;
    const ed2 = ed;
    const rect = ed2.getContainerDomNode().getBoundingClientRect();
    const px = x >= 0 ? x : rect.left + rect.width - 380;
    const py = y >= 0 ? y : rect.top + 60;
    const refs = await requestLocations("python", "textDocument/references", model, pos, { includeDeclaration: true });
    const seen = new Set<string>();
    const items = refs.filter((r) => {
      const k = `${r.path}:${r.line}:${r.col}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    setRefPanel({ x: px, y: py, items });
  };
  openMenuRef.current = (x: number, y: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    // VS Code 语义：右键落在选区内保持选区不动；落在外面把光标移到点击处（词级）
    const model = ed.getModel();
    const t = ed.getTargetAtClientPoint(x, y);
    const pos = t?.position || null;
    if (model && pos) {
      const sel = ed.getSelection();
      const inSel = !!sel && !sel.isEmpty() && sel.containsPosition(pos);
      if (!inSel) {
        const w = model.getWordAtPosition(pos);
        if (w) ed.setSelection(new monaco.Range(pos.lineNumber, w.startColumn, pos.lineNumber, w.endColumn));
        else ed.setPosition(pos);
      }
      ed.focus();
    }
    setEdMenu({ x, y });
  };
  // 跳到指定行（报错总览条点击 / F8）
  const gotoLine = (n: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.revealLineInCenter(n);
    ed.setPosition({ lineNumber: n, column: 1 });
    ed.focus();
  };
  // F8：按行序找下一条诊断，越过最后一条回到第一条
  const jumpDiag = (dir: 1 | -1) => {
    const ed = editorRef.current;
    if (!ed || !diagsRef.current.length) return false;
    const ds = [...diagsRef.current].sort((a, b) => a.line - b.line);
    const cur = ed.getPosition()?.lineNumber || 1;
    let idx = ds.findIndex((d) => (dir > 0 ? d.line > cur : d.line < cur));
    if (idx < 0) idx = dir > 0 ? 0 : ds.length - 1;
    gotoLine(ds[idx].line);
    return true;
  };
  jumpRef.current = jumpDiag;
  const isMd = !!activePath && /\.(md|markdown)$/i.test(activePath);
  mdToggleRef.current = () => {
    if (isMd) setMdPreview((v) => !v);
  };

  const fileName = (p: string) => p.split(/[\\/]/).pop() || p;
  const isEmpty = props.active.path == null;
  const lspChip =
    activePath && lspState && lspState.language === lspLanguageFor(activePath)
      ? lspState.status === "running"
        ? { text: lspState.detail || "LSP", color: "#3fb950" }
        : lspState.status === "starting"
          ? { text: "LSP 启动中", color: "#7d8590" }
          : lspState.status === "error"
            ? { text: "LSP 不可用", color: "#d29922" }
            : null
      : null;

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
        {lspChip && (
          <span className="ed-tool" style={{ border: "none", cursor: "default", color: lspChip.color }} title={`语言服务器：${lspChip.text}`}>
            ◆ {lspChip.text}
          </span>
        )}
        {props.active.kind === "file" && activePath && isMd && (
          <button
            className={"ed-tool md-tog" + (mdPreview ? " on" : "")}
            title={mdPreview ? "切换到编辑模式（Ctrl+Shift+V）" : "切换到预览模式（Ctrl+Shift+V）"}
            onClick={() => setMdPreview((v) => !v)}
          >
            <Icon name="eye" size={12} /> {mdPreview ? "编辑" : "预览"}
          </button>
        )}
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
        {/* 编辑器宿主永久常驻（diff/md 预览只隐藏、不卸载）：monaco 实例仅在挂载时创建一次，
            automaticLayout 负责隐藏/显示后的重测量；卸载宿主会让 DOM 脱挂——「点了文件打不开」的根因 */}
        <div ref={hostRef} className="ed-host" style={mdPreview || isDiff ? { display: "none" } : undefined} />
        {isDiff ? (
          props.active.path ? (
            <DiffView path={props.active.path} store={props.diffData[props.active.path]} />
          ) : null
        ) : (
          <>
            {!mdPreview && (
              <div className="ed-ruler" title="报错总览（点击标记跳转，F8 下一条）">
                {(() => {
                  const total = Math.max(1, editorRef.current?.getModel()?.getLineCount() || 1);
                  return diags.map((d, i) => {
                    const color = d.severity === "error" ? "#f85149" : d.severity === "warning" ? "#e3b341" : "#4493f8";
                    const top = (Math.min(d.line, total) / total) * 100;
                    const h = Math.max(0.8, ((d.endLine - d.line + 1) / total) * 100);
                    return (
                      <div
                        key={i}
                        className="ed-ruler-mark"
                        title={`第 ${d.line} 行 ${d.severity === "error" ? "错误" : d.severity === "warning" ? "警告" : "提示"}：${d.message}`}
                        style={{ top: `${top}%`, height: `${h}%`, background: color }}
                        onClick={() => gotoLine(d.line)}
                      />
                    );
                  });
                })()}
              </div>
            )}
            {mdPreview && (
              <div
                className="md md-preview"
                dangerouslySetInnerHTML={{
                  __html: mdRender(props.active.kind === "file" && activePath ? props.docs.current[activePath]?.text ?? "" : ""),
                }}
              />
            )}
            <div className="ed-floats" style={mdPreview ? { display: "none" } : undefined}>
            {hasSelection && (
              <button className="ed-tool add2chat" title="插入到对话输入框（光标处生成 @文件:行段，可穿插多段代码）" onClick={addRef}>
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
                      <Icon name="download" size={13} /> 插入到对话（带行号引用）
                    </div>
                  )}
                </div>
              )}
            </div>
            </div>
            {isEmpty && (
              <div className="ed-empty ed-overlay">
                <div className="ed-empty-t">从左侧「文件」打开文件开始阅读 / 编辑</div>
                <button onClick={props.onBrowse}>浏览项目文件</button>
                <div className="ed-empty-s">
                  Monaco 内核：多光标/折叠/minimap · TS/JS/JSON/CSS/HTML 内建智能 · python 走 pyright LSP · Ctrl+S 保存 · Agent 改动提示冲突
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
      {edMenu && <EditorMenu x={edMenu.x} y={edMenu.y} items={buildMenuItems()} onClose={() => setEdMenu(null)} />}
      {refPanel && (
        <RefPanel
          x={refPanel.x}
          y={refPanel.y}
          title="引用"
          items={refPanel.items}
          onClose={() => setRefPanel(null)}
          onJump={(p, line) => props.onJump(p, line)}
        />
      )}
    </div>
  );
}


// —— 改动对比：git index 版本 vs 磁盘当前（monaco DiffEditor），数据由 App 的 diffStore 注入 ——
export function DiffView({ path, store }: { path: string; store?: { base?: string; current?: string } }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 单栏模式：无差异（暂存后未再改，基线=当前）或新文件（未跟踪，基线为空）——直接展示当前内容
  const single = !!store && store.base != null && store.current != null && (!store.base || store.base === store.current);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !store || store.base == null || store.current == null) return;
    let disposed = false;
    let editor: monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor | null = null;
    const owned: monaco.editor.ITextModel[] = [];
    host.innerHTML = "";
    // 与主编辑器同款观感；超大文件不折行（压缩单行 bundle 折行会折出数万可视行卡死渲染）
    (async () => {
      const lang = langIdForMonaco(path);
      const big = Math.max(store.base!.length, store.current!.length) > 400_000;
      if (single) {
        editor = monaco.editor.create(host, {
          ...baseEditorOptions,
          value: store.current!,
          language: lang,
          readOnly: true,
          minimap: { enabled: false },
          wordWrap: big ? "off" : "on",
        });
        return;
      }
      // diff 专用一次性 model：独立 scheme 避免与主编辑器 model 冲突，卸载即销毁
      const mount = `m${++diffMountSeq}`;
      const base = monaco.editor.createModel(store.base!, lang, monaco.Uri.parse(`yharness-diff://base/${mount}/${path}`));
      const cur = monaco.editor.createModel(store.current!, lang, monaco.Uri.parse(`yharness-diff://cur/${mount}/${path}`));
      owned.push(base, cur);
      if (disposed) return;
      const diff = monaco.editor.createDiffEditor(host, {
        ...baseEditorOptions,
        readOnly: true,
        renderSideBySide: true,
        // 长段未改动区域折叠（VS Code 式），改动一眼可见
        hideUnchangedRegions: { enabled: true, minimumLineCount: 5, contextLineCount: 4 },
        diffWordWrap: big ? "off" : "on",
        minimap: { enabled: false },
      });
      diff.setModel({ original: base, modified: cur });
      editor = diff;
    })();
    return () => {
      disposed = true;
      editor?.dispose();
      editor = null;
      for (const m of owned) m.dispose();
    };
  }, [path, store?.base, store?.current, single]);

  return (
    <div className="diff-wrap">
      <div className="diff-head">
        {single ? (
          <span className="diff-path" title={path}>{path}</span>
        ) : (
          <>
            <span>基线（git index）</span>
            <span className="diff-path" title={path}>{path}</span>
            <span>当前（磁盘）</span>
          </>
        )}
      </div>
      <div ref={hostRef} className="diff-host" />
      {(!store || store.base == null || store.current == null) && <div className="diff-loading">加载对比中…</div>}
    </div>
  );
}

let diffMountSeq = 0;
// diff 面板语言 id（与 monaco.ts 的 langIdFor 同表；避免为了一行映射多引一次模块状态）
function langIdForMonaco(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (["ts", "mts", "cts"].includes(ext)) return "typescript";
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return "javascript";
  if (ext === "json") return "json";
  if (ext === "css") return "css";
  if (ext === "scss") return "scss";
  if (ext === "less") return "less";
  if (["html", "htm"].includes(ext)) return "html";
  if (["py", "pyw"].includes(ext)) return "python";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["yaml", "yml"].includes(ext)) return "yaml";
  if (["sh", "bash", "bat", "cmd"].includes(ext)) return "shell";
  if (ext === "go") return "go";
  if (ext === "rs") return "rust";
  if (ext === "java") return "java";
  if (["c", "h"].includes(ext)) return "c";
  if (["cpp", "hpp", "cc", "hh"].includes(ext)) return "cpp";
  if (["toml", "ini", "cfg"].includes(ext)) return "ini";
  if (["xml", "svg"].includes(ext)) return "xml";
  if (ext === "sql") return "sql";
  if (ext === "rb") return "ruby";
  if (ext === "php") return "php";
  return "plaintext";
}
