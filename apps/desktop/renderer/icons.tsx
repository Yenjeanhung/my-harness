// 图标体系：从 app.tsx 抽出供工作台组件共用。
// 简洁线性图标（feather 风格，currentColor 跟随文字色）——工作台与对话共用（feather 风格，currentColor 跟随文字色）
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

// 时长中文格式（与 app.tsx 的 fmtClockCn 保持一致；独立小函数避免循环依赖）
function fmtClockCn(sec: number): string {
  const s = Math.floor(sec);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

export const ICON_PATHS = {
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </>
  ),
  pin: (
    <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 2-2V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v3a2 2 0 0 0 2 2h1v4.76z" />
  ),
  x: (
    <>
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </>
  ),
  check: <path d="M20 6L9 17l-5-5" />,
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  // （download 当前未使用；保留供未来导出功能恢复）
  folder: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
  cpu: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </>
  ),
  server: (
    <>
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <path d="M6 6h.01M6 18h.01" />
    </>
  ),
  zap: <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />,
  chat: (
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </>
  ),
  terminal: (
    <>
      <path d="M4 17l6-6-6-6" />
      <path d="M12 19h8" />
    </>
  ),
  file: (
    <>
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M13 2v7h7" />
    </>
  ),
  bulb: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.7.5 1.5 1.3 1.5 2.1h4c0-.8.8-1.6 1.5-2.1A6 6 0 0 0 12 3z" />
    </>
  ),
  pointer: <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  "shield-check": (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  "shield-x": (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </>
  ),
  "shield-alert": (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  chev: <path d="M6 9l6 6 6-6" />,
  sparkles: (
    <>
      <path d="M12 4l1.7 4.3L18 10l-4.3 1.7L12 16l-1.7-4.3L6 10l4.3-1.7L12 4z" />
      <path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z" />
    </>
  ),
  code: (
    <>
      <path d="M16 18l6-6-6-6" />
      <path d="M8 6l-6 6 6 6" />
    </>
  ),
  filePlus: (
    <>
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M13 2v7h7" />
      <path d="M12 18v-6M9 15h6" />
    </>
  ),
  folderPlus: (
    <>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <path d="M12 11v6M9 14h6" />
    </>
  ),
  brain: (
    <>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M12 5v13" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  branch: (
    <>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M1 14h6M9 8h6M17 16h6" />
    </>
  ),
  fold: (
    <>
      <path d="M8 5l4 4 4-4" />
      <path d="M8 19l4-4 4 4" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  panelBottom: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 15h18" />
    </>
  ),
  panelRight: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  push: (
    <>
      <path d="M18 15v4a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-4" />
      <path d="M12 15V3" />
      <path d="M7 8l5-5 5 5" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
};

export type IconName = keyof typeof ICON_PATHS;

// 思考活动行：默认折叠「思考 · 持续了 N 秒」，有全文时点击展开（ZCode 式 thoughts 折叠条）
export function ThinkRow({ it }: { it: { id: number; secs?: number; text?: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="act-think-wrap">
      <div
        className={"act-think" + (it.text ? " clickable" : "")}
        onClick={() => it.text && setOpen((o) => !o)}
        title={it.text ? (open ? "收起思考内容" : "展开思考内容") : ""}
      >
        <Icon name="cpu" size={12} />
        思考{it.secs ? ` · 持续了 ${fmtClockCn(it.secs)}` : ""}
        {it.text ? <span className="think-chev">{open ? "▾" : "▸"}</span> : null}
      </div>
      {open && it.text ? <pre className="think-full">{it.text}</pre> : null}
    </div>
  );
}

// —— 内嵌终端面板（VS Code/ZCode 式：底部抽屉，多 tab，node-pty + xterm.js）——
interface TermTab {
  id: number; // pty 会话 id（=tab id）
  title: string;
  cwd: string;
}

export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // xterm 实例与 fit 插件都存 ref（不进 state：命令式对象，重渲染无关）
  const termsRef = useRef<Map<number, { term: Terminal; fit: FitAddon }>>(new Map());
  const activeRef = useRef<number | null>(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // 全局事件接线只挂一次：data/exit 按 id 路由到对应 xterm
  useEffect(() => {
    window.myharness?.termOnData?.((id, data) => {
      termsRef.current.get(id)?.term.write(data);
    });
    window.myharness?.termOnExit?.((id) => {
      termsRef.current.get(id)?.term.dispose();
      termsRef.current.delete(id);
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        setActive((a) => (a === id ? next[next.length - 1]?.id ?? null : a));
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openTerminal = async () => {
    const host = hostRef.current;
    if (!host || !window.myharness?.termCreate) return;
    // 面板刚挂载时尺寸可能是 0：先给占位行列，挂上后 fit 校正
    const res = await window.myharness.termCreate(80, 24);
    if (res.error) {
      alert(`终端打开失败：${res.error}`);
      onClose();
      return;
    }
    const { id, cwd, title } = res;
    const term = new Terminal({
      fontFamily: "Consolas, 'Cascadia Mono', monospace",
      fontSize: 12.5,
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: "#111318",
        foreground: "#d7dae0",
        cursor: "#79c0ff",
        selectionBackground: "#264f78",
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.onData((d) => window.myharness?.termInput?.(id, d));
    term.onResize(({ cols, rows }) => window.myharness?.termResize?.(id, cols, rows));
    termsRef.current.set(id, { term, fit });
    setTabs((prev) => [...prev, { id, title, cwd }]);
    setActive(id);
  };

  // 激活 tab：把 xterm DOM 挂到 host 并 fit
  useEffect(() => {
    const host = hostRef.current;
    if (!host || active == null) return;
    const entry = termsRef.current.get(active);
    if (!entry) return;
    if (entry.term.element?.parentElement !== host) {
      host.innerHTML = "";
      entry.term.open(host);
    }
    try {
      entry.fit.fit();
      entry.term.focus();
    } catch {}
  }, [active, tabs.length]);

  // 面板尺寸变化（拖动/开合）时重算行列
  useEffect(() => {
    const host = hostRef.current;
    if (!host || active == null) return;
    const ro = new ResizeObserver(() => {
      const entry = termsRef.current.get(activeRef.current ?? -1);
      if (!entry) return;
      try {
        entry.fit.fit();
      } catch {}
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [active == null]);

  // 面板高度拖拽：顶缘把手上下拉，双击复位
  const [termHeight, setTermHeight] = useState(300);
  const termDrag = useRef<{ startY: number; startH: number } | null>(null);
  const onTermDragStart = (e: React.MouseEvent) => {
    termDrag.current = { startY: e.clientY, startH: termHeight };
    e.preventDefault();
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!termDrag.current) return;
      const dy = termDrag.current.startY - e.clientY;
      setTermHeight(Math.max(140, Math.min(window.innerHeight * 0.7, termDrag.current.startH + dy)));
    };
    const onUp = () => {
      termDrag.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [termHeight]);

  const closeTab = (id: number) => {
    window.myharness?.termKill?.(id);
    // 进程退出事件会做实际清理；双保险直接摘
    termsRef.current.get(id)?.term.dispose();
    termsRef.current.delete(id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActive((a) => (a === id ? next[next.length - 1]?.id ?? null : a));
      return next;
    });
  };

  return (
    <div className="term-panel" style={{ height: termHeight }}>
      <div
        className="term-resize"
        title="拖拽调整高度 · 双击复位"
        onMouseDown={onTermDragStart}
        onDoubleClick={() => setTermHeight(300)}
      />
      <div className="term-head">
        <span className="term-label">
          <Icon name="terminal" size={12} /> 终端
        </span>
        {tabs.map((t) => (
          <div key={t.id} className={"term-tab" + (t.id === active ? " on" : "")} onClick={() => setActive(t.id)}>
            <span title={t.cwd}>{t.title}</span>
            <button className="term-x" title="关闭" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</button>
          </div>
        ))}
        <button className="term-new" title="新建终端" onClick={openTerminal}>＋</button>
        <div style={{ flex: 1 }} />
        <button className="term-x" title="收起终端" onClick={onClose}>×</button>
      </div>
      <div ref={hostRef} className="term-host" onClick={() => termsRef.current.get(active ?? -1)?.term.focus()} />
      {tabs.length === 0 && (
        <div className="term-empty">
          <button className="primary" onClick={openTerminal}>打开终端（{window.myharness ? "PowerShell，工作区=当前项目" : "仅桌面端可用"}）</button>
        </div>
      )}
    </div>
  );
}

export function Icon({ name, size = 13, filled = false }: { name: IconName; size?: number; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
