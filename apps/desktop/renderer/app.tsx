// My-Harness 桌面端渲染进程：纯 Web 页面 + WebSocket，走 Local Server 的 UI 事件协议（DESIGN.md §4.11）。
// 工作区：ZCode 式布局——模型回答靠左、用户输入靠右（气泡）、工具卡片、审批卡片、运行时长。
// 输入栏：＋附件 / 权限模式 / 思考档位 / 模型切换 / 发送。设置页：模型(列表)/记忆/MCP/技能/常规。
import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type {
  Img,
  SessionInfo,
  ContentResult,
  SettingsState,
  SessionCostData,
  StatsState,
  MemBlock,
  MemFile,
  McpServerInfo,
  SkillInfo,
  PermissionRequest,
  ModelTestResult,
  Usage,
  PermMode,
  ThinkLevel,
  WsEvent,
  WsCommand,
} from "./protocol";

marked.setOptions({ gfm: true, breaks: true });

// 助手消息是模型输出的 Markdown：渲染成 HTML 前做最小净化（去 script/事件属性/js: 链接）
function mdRender(text: string): string {
  const html = marked.parse(text || "");
  return String(html)
    .replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, "");
}

const params = new URLSearchParams(window.location.search);
const WS_URL = params.get("ws") || "ws://127.0.0.1:8765/ws";
const SERVER_STATE = params.get("server") || "unknown";

// daemon 握手状态 → 设置页「常规」里的人类可读说明
const STATE_TEXT: Record<string, string> = {
  attached: "attached",
  started: "sidecar started",
  restarted: "旧 daemon 已替换",
  unavailable: "daemon NOT found",
};

const PROVIDERS: { key: string; name: string; hint: string }[] = [
  { key: "deepseek", name: "DeepSeek", hint: "如 deepseek-chat / deepseek-reasoner" },
  { key: "zhipuai", name: "智谱 BigModel", hint: "如 glm-4.6 / glm-4.5-air" },
  { key: "moonshot", name: "Moonshot Kimi", hint: "如 kimi-k2 / moonshot-v1-8k" },
  { key: "dashscope", name: "阿里通义 DashScope", hint: "如 qwen-max / qwen-plus" },
  { key: "openai", name: "OpenAI", hint: "官方或兼容端点" },
  { key: "anthropic", name: "Anthropic", hint: "Claude 系列" },
  { key: "ollama", name: "Ollama（本机）", hint: "本机已 pull 的模型名" },
  { key: "custom", name: "自定义（OpenAI 兼容）", hint: "任意 OpenAI 兼容端点，需填 Base URL" },
];
const KNOWN_PREFIXES = PROVIDERS.filter((p) => p.key !== "custom").map((p) => p.key);
// 各厂商 OpenAI 兼容端点缺省值（与内核 DEFAULT_BASES 一致；用户显式填写时覆盖）
const PROVIDER_BASES: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  zhipuai: "https://open.bigmodel.cn/api/paas/v4",
  moonshot: "https://api.moonshot.cn/v1",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  ollama: "http://localhost:11434/v1",
  openai: "",
  anthropic: "",
  custom: "",
};
const THINKING_LABELS: Record<ThinkLevel, string> = { off: "关", low: "低", high: "高", max: "最高" };

let ws: WebSocket | null = null;
let nextId = 1;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closingForGood = false; // 页面卸载主动关闭：不再重连

// 唯一的消息出口：命令类型不对编译不过，ws 未连接时静默丢弃
function sendCmd(cmd: WsCommand) {
  ws?.send(JSON.stringify(cmd));
}

const GROUP_ORDER = ["今天", "昨天", "本周", "本月", "更早"];

function groupKey(lastActive: string): string {
  const d = new Date(lastActive);
  if (isNaN(d.getTime())) return "更早";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return "本周";
  if (diffDays < 30) return "本月";
  return "更早";
}

function groupSessions(list: SessionInfo[] | null | undefined): { key: string; label: string; items: SessionInfo[] }[] {
  const byKey: Record<string, SessionInfo[]> = {};
  for (const s of list || []) {
    const k = groupKey(s.last_active);
    (byKey[k] = byKey[k] || []).push(s);
  }
  return GROUP_ORDER.filter((k) => byKey[k]).map((k) => ({ key: "date:" + k, label: k, items: byKey[k] }));
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// 简洁线性图标（feather 风格，currentColor 跟随文字色）
const ICON_PATHS = {
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
};

type IconName = keyof typeof ICON_PATHS;

// 思考活动行：默认折叠「思考 · 持续了 N 秒」，有全文时点击展开（ZCode 式 thoughts 折叠条）
function ThinkRow({ it }: { it: ThinkItem }) {
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

function TerminalPanel({ onClose }: { onClose: () => void }) {
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

function Icon({ name, size = 13, filled = false }: { name: IconName; size?: number; filled?: boolean }) {
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

// 权限模式：ZCode 式下拉（图标+标题+描述），完全访问用橘黄警示
const PERM_META: Record<PermMode, { label: string; desc: string; icon: IconName }> = {
  plan: { label: "计划模式", desc: "编辑前先出计划，确认后再动手。", icon: "bulb" },
  default: { label: "默认确认", desc: "写入和命令执行前先问我。", icon: "pointer" },
  acceptEdits: { label: "自动编辑", desc: "自动应用文件编辑。", icon: "shield-check" },
  dontAsk: { label: "自动拒绝", desc: "不询问，直接拒绝敏感操作。", icon: "shield-x" },
  bypass: { label: "完全访问", desc: "跳过所有确认，谨慎使用。", icon: "shield-alert" },
};

function fmtRowTime(lastActive: string): string {
  const d = new Date(lastActive);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86400000);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (diffDays <= 0) return hm;
  if (diffDays === 1) return `昨天 ${hm}`;
  if (diffDays < 7) return `周${"日一二三四五六"[d.getDay()]} ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function providerName(key: string): string {
  return PROVIDERS.find((p) => p.key === key)?.name || key;
}
// token 数紧凑显示：1234 -> 1.2k
function fmtTok(n: number): string {
  const v = Number(n) || 0;
  return v >= 10000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}
function fmtCost(c: number | null | undefined): string | null {
  return c == null ? null : c < 0.0001 && c > 0 ? "<$0.0001" : `$${c.toFixed(4)}`;
}
// 运行时长：>60s 转为 X m X s（秒表式，避免 771.6s 这种难读的数字）
function fmtClock(sec: number): string {
  const s = Math.floor(sec);
  if (s < 60) return `${sec < 10 ? sec.toFixed(1) : s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}
// 中文场景：>60s 转为 X 分 X 秒
function fmtClockCn(sec: number): string {
  const s = Math.floor(sec);
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}
// token 数中文万格式：33300 -> 3.3万
function fmtWan(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);
}

// 工具调用 → ZCode 式活动行动词/目标/新增行数（+N 徽标）
interface ToolMeta {
  verb: string;
  icon: IconName;
  target: string;
  add?: number | null;
}

function describeTool(tool: string, args?: unknown): ToolMeta {
  const a = (args || {}) as Record<string, any>;
  const lines = (s: unknown) => (typeof s === "string" && s ? s.split("\n").length : null);
  if (tool === "read_file") return { verb: "读取", icon: "file", target: a.path };
  if (tool === "grep") return { verb: "搜索", icon: "search", target: a.pattern };
  if (tool === "glob") return { verb: "查找", icon: "search", target: a.pattern };
  if (tool === "write_file") return { verb: "写入", icon: "edit", target: a.path, add: lines(a.content) };
  if (tool === "edit_file") return { verb: "编辑", icon: "edit", target: a.path, add: lines(a.new_str) };
  if (tool === "bash") return { verb: "终端", icon: "terminal", target: (a.command || "").slice(0, 160) };
  if (tool === "spawn_subagent") return { verb: "子代理", icon: "cpu", target: a.task ? String(a.task).slice(0, 100) : "" };
  if (tool === "load_skill") return { verb: "技能", icon: "zap", target: a.name || a.skill || "" };
  if (/^mcp__/.test(tool)) {
    const parts = String(tool).split("__");
    return { verb: "MCP", icon: "server", target: `${parts[1] || ""}·${parts.slice(2).join("__")}` };
  }
  if (/^(memory_|block_)/.test(tool)) return { verb: "记忆", icon: "database", target: a.path || a.label || "" };
  return { verb: tool, icon: "zap", target: "" };
}

function splitModel(model: string | undefined, apiBase: string | undefined): { provider: string; modelName: string } {
  const slash = (model || "").indexOf("/");
  const p = slash > 0 ? model!.slice(0, slash) : "";
  const name = slash > 0 ? model!.slice(slash + 1) : model || "";
  if (KNOWN_PREFIXES.includes(p) && name) return { provider: p, modelName: name };
  if (model && apiBase) return { provider: "custom", modelName: model.replace(/^openai\//, "") };
  if (model) return { provider: "custom", modelName: model };
  return { provider: "deepseek", modelName: "" };
}

// —— 会话消息流条目（客户端状态，History/事件流归一后的形状）——
interface UserItem {
  id: number;
  kind: "user";
  text: string;
  images?: Img[];
  seq?: number;
}
interface AssistantItem {
  id: number;
  kind: "assistant";
  text: string;
  seq?: number;
  duration_ms?: number;
  usage?: Usage;
  cost_usd?: number | null;
}
interface ToolItem {
  id: number;
  kind: "tool";
  text?: string;
  tool: string;
  args?: string;
  callId?: string; // 服务端 tool_use id：参数流式(ToolCallArgs)/执行输出(ToolCallOutput)都按它归位到同一张卡片
  argsRaw?: string; // 参数还在生成时的原始 JSON 文本（流式预览）
  output?: string; // 执行期过程输出尾部（bash 逐行上报，只保留末尾几百字符）
  startedAt?: number; // 首次出现时刻：running/streaming 状态下据此显示已运行秒数
  status?: "streaming" | "running" | "done" | "stopped" | "fail";
  detail?: string;
  meta?: ToolMeta;
}
interface ThinkItem {
  id: number;
  kind: "think";
  secs?: number;
  text?: string; // 完整推理内容：默认折叠一行，点击展开
}
interface NoticeItem {
  id: number;
  kind: "notice";
  text: string;
}
interface ErrorItem {
  id: number;
  kind: "error";
  text: string;
}
type ChatItem = UserItem | AssistantItem | ToolItem | ThinkItem | NoticeItem | ErrorItem;
type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;

interface Attachment {
  path: string;
  content: string;
  truncated?: boolean;
}
interface PasteImage {
  media_type: string;
  data: string;
  path?: string;
  preview?: string;
}
interface QueueItem {
  id: number;
  text: string;
  composed: string;
  imgs: Img[];
}
interface ModelForm {
  provider: string;
  modelName: string;
  api_key: string;
  api_base: string;
}
type TestState = { status: "running" } | ModelTestResult;
type ConnState = "connecting" | "open" | "closed";
type Section = "models" | "memory" | "mcp" | "skills" | "general";

function App() {
  const [view, setView] = useState<"chat" | "settings">("chat"); // chat | settings
  const [section, setSection] = useState<Section>("models");
  const [conn, setConn] = useState<ConnState>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [permission, setPermission] = useState<PermissionRequest | null>(null); // 审批请求
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionGroups, setSessionGroups] = useState<string[]>([]);
  const [showGroupInput, setShowGroupInput] = useState(false);
  const [groupInput, setGroupInput] = useState("");
  const [groupRenaming, setGroupRenaming] = useState<{ old: string; value: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moveSession, setMoveSession] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [groupBy, setGroupBy] = useState<"date" | "group">("date"); // date | topic | group
  const [sideTab, setSideTab] = useState<"sessions" | "projects">("sessions"); // 侧栏第三个 tab：项目
  const [projects, setProjects] = useState<{ current: string | null; recent: string[] }>({
    current: null,
    recent: [],
  });
  const [contentResults, setContentResults] = useState<ContentResult[]>([]);
  const [searchQ, setSearchQ] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null); // 待确认删除的 session_id
  const [settings, setSettings] = useState<SettingsState>({
    model: "", has_api_key: false, api_base: "", server_version: "",
    permission_mode: "default", thinking: "off", models: [],
  });
  const [modelForm, setModelForm] = useState<ModelForm>({ provider: "deepseek", modelName: "", api_key: "", api_base: "" });
  const [savedFlash, setSavedFlash] = useState(false);
  const [permMode, setPermMode] = useState<PermMode>("default");
  const [thinking, setThinking] = useState<ThinkLevel>("off");
  const [attachments, setAttachments] = useState<Attachment[]>([]); // 文本附件
  const [pasteImages, setPasteImages] = useState<PasteImage[]>([]);
  const [showAttach, setShowAttach] = useState(false);
  const [attachPath, setAttachPath] = useState("");
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [firstToken, setFirstToken] = useState(false); // 本轮是否已收到首 token
  const [reason, setReason] = useState(""); // 当前轮推理增量（保留末 400 字符，ZCode 式正在思考）
  const [reasonFull, setReasonFull] = useState(""); // 本轮完整推理全文：思考区实时流式显示（ZCode 式）
  const [queue, setQueue] = useState<QueueItem[]>([]); // 运行中排队的消息
  const [termOpen, setTermOpen] = useState(false); // 内嵌终端面板（底部抽屉）
  const [permOpen, setPermOpen] = useState(false); // 权限模式下拉
  const [outlineTip, setOutlineTip] = useState<{ text: string; top: number } | null>(null); // 左侧消息导航悬浮预览
  const [copiedId, setCopiedId] = useState<number | null>(null); // 刚复制完的消息 id（图标短暂变 ✓）
  const permDropRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<string | null>(null); // 图片放大预览（dataURL）
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [onboard, setOnboard] = useState(true); // 首启引导：模型列表为空时全屏展示
  const [testState, setTestState] = useState<TestState | null>(null); // TestModel 结果
  const [sessCost, setSessCost] = useState<SessionCostData | null>(null); // 当前会话累计（落库部分，RunFinished 后刷新）
  const [runUsage, setRunUsage] = useState<{ input_tokens: number; output_tokens: number } | null>(null); // 进行中 run 的实时累计
  const [ctxInfo, setCtxInfo] = useState<{ tokens: number; window: number; static: number } | null>(null); // 当前上下文规模（容量弹窗）
  const [ctxOpen, setCtxOpen] = useState(false); // 上下文容量弹窗
  const ctxPopRef = useRef<HTMLDivElement | null>(null);
  const [stats, setStats] = useState<StatsState | null>(null); // GetStats 结果（设置页「常规」）
  const [memory, setMemory] = useState<{ blocks: MemBlock[]; files: MemFile[] }>({ blocks: [], files: [] });
  const [memFile, setMemFile] = useState<{ path: string; content: string } | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [mcpForm, setMcpForm] = useState<{ name: string; transport: "stdio" | "http"; command: string; args: string; url: string }>({ name: "", transport: "stdio", command: "", args: "", url: "" });
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const assistantBuf = useRef<boolean | null>(null);
  const runStart = useRef(0);
  const pickedInitial = useRef(false); // 启动时只自动恢复一次最近会话
  // ws.onmessage 闭包只捕获首帧值，事件回调里读 state 一律走这些 ref
  const connRef = useRef<ConnState>("connecting");
  const sessionIdRef = useRef<string | null>(null);
  const viewRef = useRef<"chat" | "settings">("chat");
  const roundStart = useRef(0); // 当前思考轮起点（思考·持续了 N 秒）
  const thinkPushed = useRef(true);
  const reasonRef = useRef(""); // 尾部 400 字符滚动窗口（正在思考指示行）
  const fullReasonRef = useRef(""); // 本轮完整推理内容（落进「思考」折叠条，不截断）
  const liveThinkRef = useRef<HTMLDivElement | null>(null); // 实时思考块：新内容到底部跟随
  const queueRef = useRef<QueueItem[]>([]);
  const runningRef = useRef(false);
  useEffect(() => { connRef.current = conn; }, [conn]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { runningRef.current = running; }, [running]);

  const addItem = (item: WithoutId<ChatItem>) =>
    setItems((prev) => [...prev, { id: nextId++, ...item } as ChatItem]);
  const patchLastAssistant = (fn: (it: AssistantItem) => Partial<AssistantItem>) =>
    setItems((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        const it = next[i];
        if (it.kind === "assistant") {
          next[i] = { ...it, ...fn(it) };
          return next;
        }
      }
      return next;
    });

  // 本轮思考结束（首个正文 token / 工具参数开始生成 / 工具调用开始）→ 落一条「思考 · 持续了 N 秒」活动行（全文可展开）
  const pushThinkRow = () => {
    if (thinkPushed.current) return;
    thinkPushed.current = true;
    const secs = Math.round((Date.now() - roundStart.current) / 1000);
    const txt = fullReasonRef.current;
    if (secs >= 1 || txt) addItem({ kind: "think", secs, text: txt });
  };
  // run 结束/被停止：所有还在生成/运行中的工具卡片标记为已停止
  const markRunEnded = () => {
    reasonRef.current = "";
    fullReasonRef.current = "";
    setReason("");
    setReasonFull("");
    setItems((prev) =>
      prev.map((it): ChatItem =>
        it.kind === "tool" && (it.status === "running" || it.status === "streaming")
          ? { ...it, status: "stopped" }
          : it
      )
    );
  };
  // 实际发送（composed=附件拼好的文本；队列回放时用入队时拼好的版本）
  const sendNow = (text: string, composed: string, imgs: Img[]) => {
    pinnedRef.current = true; // 队列自动补发同样贴底
    addItem({ kind: "user", text, images: imgs.length ? imgs : undefined });
    sendCmd({
      type: "SendMessage",
      session_id: sessionIdRef.current,
      text: composed || text,
      images: imgs.length ? imgs : undefined,
    });
  };

  // 上下文弹窗：点击外面关闭
  useEffect(() => {
    if (!ctxOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ctxPopRef.current && !ctxPopRef.current.contains(e.target as Node)) setCtxOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ctxOpen]);

  // 运行中的计时器
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed((Date.now() - runStart.current) / 1000), 200);
    return () => clearInterval(t);
  }, [running]);

  // 权限下拉：点击外面关闭
  useEffect(() => {
    if (!permOpen) return;
    const onDown = (e: MouseEvent) => {
      if (permDropRef.current && !permDropRef.current.contains(e.target as Node)) setPermOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [permOpen]);

  // 断线自动重连：daemon 重启（切项目）/ 崩溃 / 未就绪时每 2s 重试，连上即恢复
  const scheduleReconnect = () => {
    if (closingForGood || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closingForGood || connRef.current === "open") return;
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
      connect();
    }, 2000);
  };

  const connect = () => {
    setConn("connecting");
    closingForGood = false;
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      setConn("open");
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      sendCmd({ type: "ListSessions" }); // 由 SessionList 决定恢复最近会话或新建
      sendCmd({ type: "GetSettings" });
      // 重连场景：daemon 可能重启过（内存会话已丢），重新挂载当前会话，服务端回放 History 重建界面
      if (sessionIdRef.current) sendCmd({ type: "ResumeSession", session_id: sessionIdRef.current });
    };
    ws.onclose = () => {
      setConn("closed");
      scheduleReconnect();
    };
    ws.onerror = () => setConn("closed");
    ws.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as WsEvent;
      switch (e.type) {
        case "SessionCreated":
          setSessionId(e.session_id);
          sessionIdRef.current = e.session_id; // 同步 ref：紧随其后的事件（ContextInfo/SessionCost）按会话过滤时不能读到旧值
          setPermMode(e.mode || "default");
          setPermission(null); // 换会话不带审批卡片
          setAttachments([]);
          setPasteImages([]);
          assistantBuf.current = null;
          setRunning(false);
          setSessCost(null);
          setRunUsage(null);
          setCtxInfo(null); // 上下文规模属于会话，切走即清
          setCtxOpen(false);
          // 新会话没有 History 事件回放，必须主动清场，否则正文/排队消息还挂在旧会话上
          setItems([]);
          setQueue([]);
          setReason("");
          reasonRef.current = "";
          setReasonFull("");
          break;
        case "SessionResumed":
          setSessionId(e.session_id);
          sessionIdRef.current = e.session_id; // 同步 ref，理由同 SessionCreated
          setPermission(null);
          setAttachments([]);
          setPasteImages([]);
          assistantBuf.current = null;
          setRunning(false);
          setSessCost(null);
          setRunUsage(null);
          setCtxInfo(null);
          setCtxOpen(false);
          setQueue([]); // 排队消息属于旧会话，切走后不再回放
          sendCmd({ type: "GetSessionCost", session_id: e.session_id });
          // 分支/恢复会话后刷侧栏：fork 出的新会话立即可见，不用等首轮跑完
          sendCmd({ type: "ListSessions" });
          break;
        case "ContentSearchResult":
          setContentResults(e.results || []);
          break;
        case "SessionList":
          setSessions(e.sessions || []);
          setSessionGroups(e.groups || []);
          if (!pickedInitial.current) {
            pickedInitial.current = true;
            const list = e.sessions || [];
            if (list.length) {
              // 打开应用自动恢复最近一次会话（ZCode 行为），历史由 History 事件回放
              resume(list[0].session_id);
            } else {
              newSession();
            }
          } else if (sessionIdRef.current && !(e.sessions || []).some((s) => s.session_id === sessionIdRef.current)) {
            // 当前会话被删除：自动回落到最近会话或新建
            const list = e.sessions || [];
            if (list.length) resume(list[0].session_id);
            else newSession();
          }
          break;
        case "History":
          setItems(
            (e.items || []).map((it): ChatItem => ({
              id: nextId++,
              kind: it.kind as ChatItem["kind"],
              text: it.text || "",
              tool: it.tool || "",
              args: it.args ? JSON.stringify(it.args) : undefined,
              status: it.kind === "tool" ? "done" : undefined,
              images: it.images,
              meta: it.kind === "tool" ? describeTool(it.tool || "", it.args) : undefined,
              seq: it.seq,
            }))
          );
          break;
        case "Settings":
          setSettings(e);
          setSettingsLoaded(true);
          setPermMode(e.permission_mode || "default");
          setThinking(e.thinking || "off");
          setModelForm((f) =>
            f.modelName ? f : { ...f, ...splitModel(e.model, e.api_base), api_base: e.api_base || "" }
          );
          break;
        case "ModelSet":
          setSettings((s) => ({ ...s, model: e.model, has_api_key: e.has_api_key, models: e.models || s.models }));
          setOnboard(false); // 首启引导里保存成功 → 关闭引导
          setSavedFlash(true);
          setTimeout(() => setSavedFlash(false), 2500);
          break;
        case "ModelTestResult":
          setTestState(e);
          break;
        case "SessionCost":
          if (e.session_id === sessionIdRef.current) setSessCost(e);
          break;
        case "Stats":
          setStats(e);
          break;
        case "MemoryList":
          setMemory({ blocks: e.blocks || [], files: e.files || [] });
          break;
        case "MemoryFileContent":
          setMemFile({ path: e.path, content: e.content });
          break;
        case "McpList":
          setMcpServers(e.servers || []);
          break;
        case "SkillList":
          setSkills(e.skills || []);
          break;
        case "ImageSaved":
          setPasteImages((prev) =>
            prev.some((p) => p.data === e.data)
              ? prev
              : [...prev, { media_type: e.media_type, data: e.data, path: e.path }]
          );
          break;
        case "WorkspaceFile":
          setAttachments((prev) =>
            prev.some((a) => a.path === e.path)
              ? prev
              : [...prev, { path: e.path, content: e.content, truncated: e.truncated }]
          );
          setShowAttach(false);
          setAttachPath("");
          break;
        case "RunStarted":
          assistantBuf.current = null;
          setRunning(true);
          setFirstToken(false);
          setReason("");
          reasonRef.current = "";
          fullReasonRef.current = "";
          setReasonFull("");
          setRunUsage(null); // 本 run 的实时用量从零起算（顶栏会话 token = 已落库累计 + 本 run 实时）
          roundStart.current = Date.now();
          thinkPushed.current = false;
          runStart.current = Date.now();
          setElapsed(0);
          // 首条消息此刻已落库：立刻刷侧栏，新会话不用等 RunFinished 才出现
          sendCmd({ type: "ListSessions" });
          break;
        case "Usage":
          // 每轮模型返回后的本 run 累计 token：顶栏会话用量实时跳动；上下文规模供容量圆环
          if (!e.session_id || e.session_id === sessionIdRef.current) {
            setRunUsage({ input_tokens: e.input_tokens, output_tokens: e.output_tokens });
            if (e.context_window) setCtxInfo({ tokens: e.context_tokens || 0, window: e.context_window, static: e.static_tokens || 0 });
          }
          break;
        case "ContextInfo":
          // 恢复会话时的上下文快照：容量圆环一进来就显示，不用等首轮
          if (!e.session_id || e.session_id === sessionIdRef.current)
            setCtxInfo({ tokens: e.context_tokens, window: e.context_window, static: e.static_tokens });
          break;
        case "ReasoningDelta":
          fullReasonRef.current += e.text;
          reasonRef.current = (reasonRef.current + e.text).slice(-400);
          setReason((r) => (r + e.text).slice(-400));
          setReasonFull((f) => f + e.text); // 思考区实时全文
          break;
        case "TokenDelta":
          setFirstToken(true);
          pushThinkRow();
          if (!assistantBuf.current) {
            assistantBuf.current = true;
            addItem({ kind: "assistant", text: "" });
          }
          patchLastAssistant((it) => ({ text: (it.text || "") + e.text }));
          break;
        case "ToolCallArgs":
          // 参数边生成边显示（ZCode 式）：卡片在模型还在写参数时就出现，argsRaw 逐段替换
          pushThinkRow();
          setItems((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const it = next[i];
              if (it.kind === "tool" && it.callId === e.call_id && (it.status === "streaming" || it.status === "running")) {
                next[i] = { ...it, tool: e.tool, argsRaw: e.args_text };
                return next;
              }
            }
            return [
              ...next,
              {
                id: nextId++,
                kind: "tool",
                tool: e.tool,
                callId: e.call_id,
                argsRaw: e.args_text,
                status: "streaming",
                startedAt: Date.now(),
                meta: describeTool(e.tool),
              } as ChatItem,
            ];
          });
          break;
        case "ToolCallStarted":
          assistantBuf.current = null;
          pushThinkRow();
          setItems((prev) => {
            const next = [...prev];
            // 参数流式阶段已建卡：就地补全最终参数；否则新建（非流式 provider/旧 daemon）
            for (let i = next.length - 1; i >= 0; i--) {
              const it = next[i];
              if (
                it.kind === "tool" &&
                e.call_id &&
                it.callId === e.call_id &&
                (it.status === "streaming" || it.status === "running")
              ) {
                next[i] = {
                  ...it,
                  tool: e.tool,
                  args: JSON.stringify(e.args),
                  argsRaw: undefined,
                  status: "running",
                  startedAt: it.startedAt || Date.now(),
                  meta: describeTool(e.tool, e.args),
                };
                return next;
              }
            }
            next.push({
              id: nextId++,
              kind: "tool",
              tool: e.tool,
              callId: e.call_id,
              args: JSON.stringify(e.args),
              status: "running",
              startedAt: Date.now(),
              meta: describeTool(e.tool, e.args),
            } as ChatItem);
            return next;
          });
          break;
        case "ToolCallOutput":
          // 工具执行期过程输出（bash 逐行）：只保留尾部几百字符，卡片实时滚动最后一行
          setItems((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const it = next[i];
              if (it.kind === "tool" && it.callId === e.call_id && (it.status === "running" || it.status === "streaming")) {
                next[i] = { ...it, output: ((it.output || "") + e.text).slice(-600) };
                return next;
              }
            }
            return next;
          });
          break;
        case "ToolCallResult":
          setFirstToken(false); // 工具跑完进入下一轮模型调用，重新进入等待
          setReason("");
          reasonRef.current = "";
          fullReasonRef.current = "";
          setReasonFull("");
          roundStart.current = Date.now();
          thinkPushed.current = false;
          setItems((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const it = next[i];
              // 优先按 call_id 归位；旧 daemon 无 call_id 时退回「最后一个同名 running 卡片」
              if (
                it.kind === "tool" &&
                it.status === "running" &&
                (e.call_id ? it.callId === e.call_id : it.tool === e.tool)
              ) {
                next[i] = {
                  ...it,
                  status: e.is_error ? "fail" : "done",
                  // 失败：状态行显示「执行失败」，具体原因进悬浮提示（服务端附 preview）
                  detail: e.is_error ? e.preview || "执行失败" : `${e.chars} chars`,
                };
                break;
              }
            }
            return next;
          });
          break;
        case "Notice":
          assistantBuf.current = null;
          // 通知不再以胶囊进时间线（用户要求）：这些状态变化都有对应 UI
          // （权限/思考档位→下拉高亮、停止→工具卡标「已停止」、MCP/记忆→设置页刷新）
          if (/run cancelled/.test(e.text)) {
            // 服务端确认任务已停止：复位运行态，排队的消息留在队列里等手动发送
            setRunning(false);
            markRunEnded();
          }
          if (viewRef.current !== "chat") {
            if (/已删除 memory:/.test(e.text)) sendCmd({ type: "ListMemory", session_id: sessionIdRef.current });
            if (/已移除|已连接/.test(e.text)) sendCmd({ type: "ListMcp" });
          }
          break;
        case "PermissionRequest":
          assistantBuf.current = null;
          setPermission(e);
          break;
        case "RunFinished":
          assistantBuf.current = null;
          setRunning(false);
          setRunUsage(null); // GetSessionCost 回来的会话累计已包含本 run，实时增量清零防重复
          markRunEnded();
          patchLastAssistant((it) => ({
            duration_ms: e.duration_ms,
            usage: e.usage,
            cost_usd: e.cost_usd,
            // 服务端补发本轮最后一条消息的 seq：新消息立刻可分支，不用重进会话
            seq: it.seq ?? e.last_seq ?? undefined,
          }));
          if (sessionIdRef.current)
            sendCmd({ type: "GetSessionCost", session_id: sessionIdRef.current });
          sendCmd({ type: "ListSessions" });
          // 队列里有排队的消息：当前任务结束，自动发出第一条
          {
            const q = queueRef.current;
            if (q.length && sessionIdRef.current && connRef.current === "open") {
              setQueue((prev) => prev.slice(1));
              const nxt = q[0];
              setTimeout(() => sendNow(nxt.text, nxt.composed, nxt.imgs || []), 50);
            }
          }
          break;
        case "Error":
          assistantBuf.current = null;
          setRunning(false);
          markRunEnded();
          {
            const msg = e.error || JSON.stringify(e);
            if (/ListSessions|GetSettings|SetModel|ResumeSession/.test(msg)) {
              addItem({
                kind: "error",
                text: "检测到旧版本 daemon 正在运行（缺少新协议命令）。\n请完全退出所有 My-Harness 实例后重新打开；新版本会自动替换旧 daemon。",
              });
            } else {
              addItem({ kind: "error", text: msg });
            }
          }
          break;
        default:
          break;
      }
    };
  };

  useEffect(() => {
    connect();
    return () => {
      closingForGood = true; // 页面卸载：停止重连，避免定时器泄漏
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 跟随滚动（钉底模式）——
  // pinned=用户钉在底部：内容增长就跟到底；自己上滚解除，滚回底部自动恢复。
  // 不能用「距底部<60px 才跟随」判断：大表格/代码块一次渲染就把距离顶开，跟丢后只能手动滚。
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
    // reasonFull：思考阶段只有推理流式增长、items 不变，列表同样需要跟随
  }, [items, reasonFull]);
  // 换会话（History 回放）或审批卡片出现：无条件回到底部
  useEffect(() => {
    pinnedRef.current = true;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId, permission]);
  // 实时思考块：新推理内容追加减渲染后贴到底部
  useEffect(() => {
    const el = liveThinkRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasonFull]);

  // 设置页数据拉取：进入面板或连接建立时拉取
  useEffect(() => {
    if (view !== "settings" || conn !== "open") return;
    if (section === "memory") sendCmd({ type: "ListMemory", session_id: sessionIdRef.current });
    if (section === "mcp") sendCmd({ type: "ListMcp" });
    if (section === "skills") sendCmd({ type: "ListSkills" });
    if (section === "models") sendCmd({ type: "GetSettings" });
    if (section === "general") sendCmd({ type: "GetStats" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, section, conn]);

  const composeMessage = (text: string): string => {
    if (!attachments.length) return text;
    const blocks = attachments
      .map((a) => `--- 附件文件: ${a.path}${a.truncated ? "（已截断）" : ""} ---\n${a.content}`)
      .join("\n\n");
    return `${text}\n\n${blocks}`;
  };

  // 侧栏搜索：标题/ID 即时过滤，正文全文搜索防抖 300ms
  useEffect(() => {
    if (view !== "chat" || conn !== "open") return;
    const q = searchQ.trim();
    if (!q) {
      setContentResults([]);
      return;
    }
    const t = setTimeout(() => sendCmd({ type: "SearchContent", query: q, limit: 20 }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQ, view, conn]);

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (!files.length) return; // 文本粘贴走默认行为
    e.preventDefault();
    files.slice(0, 4).forEach((f) => {
      if (f.size > 10 * 1024 * 1024) {
        addItem({ kind: "notice", text: `图片过大（>10MB），已跳过` });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (connRef.current === "open" && typeof reader.result === "string") {
          sendCmd({ type: "UploadImage", data_url: reader.result });
        }
      };
      reader.readAsDataURL(f);
    });
  };

  const sendMessage = () => {
    const text = input.trim();
    if (!text || connRef.current !== "open" || !sessionIdRef.current) return;
    const imgs: Img[] = pasteImages.map((p) => ({ media_type: p.media_type, data: p.data }));
    pinnedRef.current = true; // 自己发的消息：无论如何都贴到底部看回显
    if (runningRef.current) {
      // 任务运行中：入队等待，当前任务结束（RunFinished）后自动发出。
      // 队列条显示在输入框上方（ZCode 式），不进消息时间线。
      setQueue((q) => [...q, { id: nextId++, text, composed: composeMessage(text), imgs }]);
    } else {
      sendNow(text, composeMessage(text), imgs);
    }
    setInput("");
    setAttachments([]);
    setPasteImages([]);
  };

  // 停止当前任务（服务端 CancelRun → run cancelled Notice 复位运行态）
  const stopRun = () => {
    if (connRef.current === "open" && sessionIdRef.current)
      sendCmd({ type: "CancelRun", session_id: sessionIdRef.current });
  };
  // 分支会话：从指定消息（含）复制上下文开启新会话，服务端自动切入
  const forkSession = (it: { seq?: number }) => {
    if (connRef.current !== "open" || !sessionIdRef.current || it.seq == null) return;
    sendCmd({ type: "ForkSession", session_id: sessionIdRef.current, upto_seq: it.seq });
  };
  // 复制消息原文：clipboard API 不可用时（file:// 权限等）退回 execCommand
  const copyMsg = async (it: { id: number; text?: string }) => {
    const text = it.text || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopiedId(it.id);
    setTimeout(() => setCopiedId((c) => (c === it.id ? null : c)), 1200);
  };
  // 「立即」：没有任务在跑（如取消后的遗留队列）→ 直接发送；有任务在跑 → 插到队首，任务结束后第一个发出
  const queueBump = (id: number) => {
    const q = queueRef.current;
    const item = q.find((x) => x.id === id);
    if (!item) return;
    if (runningRef.current) {
      setQueue((prev) => {
        const idx = prev.findIndex((x) => x.id === id);
        if (idx <= 0) return prev;
        return [prev[idx], ...prev.filter((x) => x.id !== id)];
      });
      return;
    }
    setQueue((prev) => prev.filter((x) => x.id !== id));
    setTimeout(() => sendNow(item.text, item.composed, item.imgs || []), 50);
  };
  const queueEdit = (qitem: QueueItem) => {
    setInput(qitem.text);
    setQueue((q) => q.filter((x) => x.id !== qitem.id));
  };
  const queueDelete = (id: number) => setQueue((q) => q.filter((x) => x.id !== id));

  const submitAttach = () => {
    const p = attachPath.trim();
    if (p && conn === "open") sendCmd({ type: "ReadWorkspaceFile", path: p });
    else setShowAttach(false);
  };

  const newSession = () => {
    if (connRef.current !== "open") return;
    setView("chat");
    sendCmd({ type: "CreateSession" });
  };
  const resume = (id: string) => {
    setView("chat");
    if (connRef.current === "open") sendCmd({ type: "ResumeSession", session_id: id });
  };

  // —— 项目（工作区）——
  // 切项目 = 主进程带 --workspace 重启 daemon，完成后 loadFile 重开页面；这里只做确认、反馈与触发
  const [switching, setSwitching] = useState(false);
  const switchProject = async (p: string) => {
    if (runningRef.current && !confirm("当前任务运行中，切换项目会中断它。继续切换？")) return;
    setSwitching(true); // daemon 重启期间连接会断开：遮罩提示，页面随后被主进程重开
    try {
      const r = await window.myharness?.openProject?.(p);
      setSwitching(false);
      if (r === "invalid") addItem({ kind: "error", text: `打开项目失败：目录无效（${p}）` });
      else if (r === "unavailable")
        addItem({ kind: "error", text: "daemon 重启失败：请确认 harness 在 PATH 中，或重新打包内嵌 sidecar。" });
    } catch {
      setSwitching(false); // 页面重开竞态下 promise 被打断属正常
    }
  };
  const pickProject = async () => {
    const p = await window.myharness?.pickFolder?.();
    if (p) switchProject(p);
  };
  // 进入项目 tab 时拉取最近项目列表
  useEffect(() => {
    if (sideTab !== "projects") return;
    window.myharness?.getProjects?.().then(setProjects).catch(() => {});
  }, [sideTab]);

  const pickProvider = (key: string) =>
    setModelForm((f) => ({ ...f, provider: key, api_base: f.api_base || PROVIDER_BASES[key] || "" }));

  const saveSettings = () => {
    if (conn !== "open" || !modelForm.modelName.trim()) return;
    const model =
      modelForm.provider === "custom"
        ? `openai/${modelForm.modelName.trim()}`
        : `${modelForm.provider}/${modelForm.modelName.trim()}`;
    sendCmd({
      type: "SetModel",
      model,
      api_base: modelForm.api_base.trim(),
      ...(modelForm.api_key.trim() ? { api_key: modelForm.api_key.trim() } : {}),
    });
  };

  const switchModel = (model: string) =>
    conn === "open" && model && sendCmd({ type: "SwitchModel", model });
  const deleteModelConfig = (model: string) =>
    conn === "open" && sendCmd({ type: "DeleteModelConfig", model });

  // 连通性测试：用当前表单配置发一次最小请求（api_key 留空时服务端沿用已保存配置）
  const testModel = () => {
    if (conn !== "open" || !modelForm.modelName.trim()) return;
    setTestState({ status: "running" });
    sendCmd({
      type: "TestModel",
      model: composedModel,
      api_key: modelForm.api_key.trim(),
      api_base: modelForm.api_base.trim(),
    });
  };
  const removeMcp = (name: string) =>
    conn === "open" && sendCmd({ type: "RemoveMcpServer", name });

  const respond = (answer: "yes" | "always" | "no") => {
    if (!permission) return;
    sendCmd({ type: "RespondPermission", request_id: permission.request_id, answer });
    setPermission(null);
  };
  const setPerm = (mode: PermMode) => {
    setPermMode(mode);
    if (conn === "open") sendCmd({ type: "SetPermissionMode", mode });
  };
  const setThink = (level: ThinkLevel) => {
    setThinking(level);
    if (conn === "open") sendCmd({ type: "SetThinking", level });
  };

  const dot = conn === "open" ? "ok" : conn === "connecting" ? "" : "bad";
  const stateText = STATE_TEXT[SERVER_STATE] || "";
  const currentModel = settings.model || "(默认)";
  // 界面展示只取模型名（zhipuai/glm-5.3-flash → glm-5.3-flash）；存储与 SetModel 仍用完整串
  const shortModel = (m: string) => m.split("/").pop() || m;
  const currentSession = (sessions || []).find((s) => s.session_id === sessionId);
  const currentTitle = currentSession?.title || (sessionId ? `新会话 ${sessionId.slice(0, 6)}` : "未开始");
  // 左侧消息导航（ZCode 式 outline）：用户/助手消息各一条，宽度随内容长度
  const outlineItems = items.filter(
    (it): it is UserItem | AssistantItem => (it.kind === "user" || it.kind === "assistant") && !!it.text
  );
  const composedModel =
    modelForm.provider === "custom"
      ? `openai/${modelForm.modelName.trim()}`
      : `${modelForm.provider}/${modelForm.modelName.trim()}`;
  const composedHint = modelForm.modelName.trim() ? `实际模型串: ${composedModel}` : "填写模型名称后自动拼接 provider 前缀";

  const fmtDur = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

  // 首启引导：模型列表为空且从未配置过 key 时全屏展示（首件事是连接自己的模型，不是登录）
  const showOnboard =
    settingsLoaded && onboard && (settings.models || []).length === 0 && !settings.has_api_key;

  // —— 设置页 ——
  const modelsPage = (
    <>
      <h1>模型设置</h1>
      <div className="desc">已保存的模型配置列表——点击「启用」切换，同时只有一个生效；对所有会话即时生效。</div>
      <div className="provider-card" style={{ marginBottom: 16 }}>
        <div className="card-title">模型列表（{settings.models?.length || 0}）</div>
        {(!settings.models || settings.models.length === 0) && (
          <div className="meta">还没有已保存的模型配置，用下方表单添加第一套。</div>
        )}
        {(settings.models || []).map((m) => {
          const p = splitModel(m.model, m.api_base);
          return (
            <div key={m.model} className="memrow">
              <div className="clickable" onClick={() => switchModel(m.model)} title="点击启用">
                <b>{providerName(p.provider)}</b> <code className="mempv">{m.model}</code>
                {m.active && <span className="tag ok">当前生效</span>}
                <div className="mempv">
                  {m.has_key ? "key 已配置" : "key 未配置"}
                  {m.api_base ? ` · ${m.api_base}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() =>
                    setModelForm((f) => ({
                      provider: p.provider, modelName: p.modelName, api_key: "", api_base: m.api_base || "",
                    }))
                  }
                >
                  编辑
                </button>
                {!m.active && (
                  <button className="danger" onClick={() => deleteModelConfig(m.model)}>删除</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="provider-card">
        <div className="pbadge">
          <span className={"pdot " + (settings.has_api_key ? "ok" : "warn")} />
          {providerName(modelForm.provider)}
          <span className="pmeta">保存后立即启用此模型（同一模型串会覆盖原配置）</span>
        </div>
        <div className="prow">
          <label>厂商</label>
          <select value={modelForm.provider} onChange={(e) => pickProvider(e.target.value)}>
            {PROVIDERS.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
          <div className="meta">{PROVIDERS.find((p) => p.key === modelForm.provider)?.hint}</div>
        </div>
        <div className="prow">
          <label>模型名称（自由填写，不做预设限制）</label>
          <input
            placeholder="例如 glm-4.6 / deepseek-chat"
            value={modelForm.modelName}
            onChange={(e) => setModelForm((f) => ({ ...f, modelName: e.target.value }))}
          />
          <div className="meta">{composedHint}</div>
        </div>
        <div className="prow">
          <label>API Key {settings.has_api_key ? "（已配置，留空保持不变）" : ""}</label>
          <input
            type="password"
            placeholder={settings.has_api_key ? "••••••••••••" : "sk-..."}
            value={modelForm.api_key}
            onChange={(e) => setModelForm((f) => ({ ...f, api_key: e.target.value }))}
          />
        </div>
        <div className="prow">
          <label>Base URL{modelForm.provider === "custom" ? "（必填，OpenAI 兼容端点）" : "（可选，覆盖官方端点 / 中转）"}</label>
          <input
            placeholder="https://..."
            value={modelForm.api_base}
            onChange={(e) => setModelForm((f) => ({ ...f, api_base: e.target.value }))}
          />
        </div>
        <button className="savebtn" onClick={saveSettings} disabled={conn !== "open" || !modelForm.modelName.trim()}>
          {savedFlash ? "✓ 已保存并启用" : "保存并启用"}
        </button>
        <div className="kv">保存到 ~/.my-harness/settings.json · 服务端版本 {settings.server_version || "?"}</div>
      </div>
    </>
  );

  const memoryPage = (
    <>
      <h1>记忆管理</h1>
      <div className="desc">工作记忆 = 当前会话常驻上下文的 blocks；长期记忆 = 项目级 Markdown 知识库。</div>
      <div className="panel-grid">
        <div className="provider-card">
          <div className="card-title">工作记忆（blocks · {memory.blocks.length}）</div>
          {memory.blocks.length === 0 && <div className="meta">当前会话还没有 blocks。</div>}
          {memory.blocks.map((b) => (
            <div key={b.label} className="memrow">
              <div>
                <b>{b.label}</b> <span className="meta">{b.chars}/{b.limit} chars</span>
                <div className="mempv">{b.value || "(empty)"}</div>
              </div>
              <button className="danger" onClick={() => sendCmd({ type: "DeleteMemoryBlock", session_id: sessionId, label: b.label })}>删除</button>
            </div>
          ))}
        </div>
        <div className="provider-card">
          <div className="card-title">长期记忆文件（{memory.files.length}）</div>
          {memory.files.length === 0 && <div className="meta">还没有长期记忆文件。</div>}
          {memory.files.map((f) => (
            <div key={f.path} className="memrow">
              <div className="clickable" onClick={() => sendCmd({ type: "ReadMemoryFile", path: f.path })}>
                <b>{f.path}</b> <span className="meta">{f.size} bytes · 点击查看</span>
              </div>
              <button className="danger" onClick={() => sendCmd({ type: "DeleteMemoryFile", path: f.path })}>删除</button>
            </div>
          ))}
          {memFile && (
            <div className="memview">
              <div className="meta">memory:{memFile.path}</div>
              <pre>{memFile.content}</pre>
            </div>
          )}
        </div>
      </div>
    </>
  );

  const mcpPage = (
    <>
      <h1>MCP 服务器</h1>
      <div className="desc">stdio：本地命令进程；HTTP：Streamable HTTP 端点。连接后工具以 mcp__名称__工具 注入所有会话。</div>
      <div className="provider-card">
        <div className="card-title">已配置（{mcpServers.length}）</div>
        {mcpServers.length === 0 && <div className="meta">还没有 MCP server。</div>}
        {mcpServers.map((s) => (
          <div key={s.name} className="memrow">
            <div>
              <b>{s.name}</b>{" "}
              <span className={"tag " + (s.status === "已连接" ? "ok" : "warn")}>{s.status}</span>{" "}
              <span className="tag">{s.transport}</span> <span className="tag">{s.source}</span>
              <div className="mempv">{s.target} · {s.tools} tools</div>
            </div>
            <button className="danger" onClick={() => sendCmd({ type: "RemoveMcpServer", name: s.name })}>移除</button>
          </div>
        ))}
        <div className="card-title" style={{ marginTop: 18 }}>添加</div>
        <div className="prow">
          <label>名称</label>
          <input value={mcpForm.name} onChange={(e) => setMcpForm((f) => ({ ...f, name: e.target.value }))} placeholder="filesystem" />
        </div>
        <div className="prow">
          <label>传输</label>
          <select value={mcpForm.transport} onChange={(e) => setMcpForm((f) => ({ ...f, transport: e.target.value as "stdio" | "http" }))}>
            <option value="stdio">stdio（本地命令）</option>
            <option value="http">HTTP（Streamable HTTP）</option>
          </select>
        </div>
        {mcpForm.transport === "stdio" ? (
          <>
            <div className="prow">
              <label>命令</label>
              <input value={mcpForm.command} onChange={(e) => setMcpForm((f) => ({ ...f, command: e.target.value }))} placeholder="npx" />
            </div>
            <div className="prow">
              <label>参数（空格分隔）</label>
              <input value={mcpForm.args} onChange={(e) => setMcpForm((f) => ({ ...f, args: e.target.value }))} placeholder="-y @modelcontextprotocol/server-filesystem D:/dir" />
            </div>
          </>
        ) : (
          <div className="prow">
            <label>URL</label>
            <input value={mcpForm.url} onChange={(e) => setMcpForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://example.com/mcp" />
          </div>
        )}
        <button className="savebtn" onClick={() => conn === "open" && mcpForm.name.trim() && sendCmd({
          type: "AddMcpServer", name: mcpForm.name.trim(), transport: mcpForm.transport,
          command: mcpForm.command, args: mcpForm.args, url: mcpForm.url,
        })}>添加并连接</button>
      </div>
    </>
  );

  const skillsPage = (
    <>
      <h1>技能</h1>
      <div className="desc">Skill = 含 SKILL.md 的目录，渐进式披露：仅名称/描述常驻上下文，正文按需载入。</div>
      <div className="provider-card">
        <div className="card-title">已加载（{skills.length}）</div>
        {skills.length === 0 && (
          <div className="meta">在 ~/.my-harness/skills/&lt;名称&gt;/SKILL.md 放入技能定义后重启。</div>
        )}
        {skills.map((s) => (
          <div key={s.name} className="memrow">
            <div>
              <b>{s.name}</b>
              <div className="mempv">{s.description}</div>
              <div className="meta">{s.source}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );

  const generalPage = (
    <>
      <h1>常规</h1>
      <div className="desc">运行环境与本机数据——所有数据都留在你的电脑上，无云同步、无遥测。</div>
      <div className="provider-card">
        <div className="kvrow"><span>服务端版本</span><b>{settings.server_version || "?"}</b></div>
        <div className="kvrow"><span>daemon 状态</span><b>{conn} {stateText ? `· ${stateText}` : ""}</b></div>
        <div className="kvrow">
          <span>数据目录</span>
          <b style={{ flex: 1, minWidth: 0, wordBreak: "break-all" }}>{stats?.data_dir || "~/.my-harness/"}</b>
          <button onClick={() => conn === "open" && sendCmd({ type: "OpenDataDir" })}>
            打开
          </button>
        </div>
      </div>
      <div className="provider-card">
        <div className="card-title">本机统计</div>
        {!stats ? (
          <div className="meta">加载中…</div>
        ) : (
          <>
            <div className="kvrow"><span>会话数</span><b>{stats.sessions}</b></div>
            <div className="kvrow"><span>消息数</span><b>{stats.messages}</b></div>
            <div className="kvrow"><span>运行次数</span><b>{stats.runs}</b></div>
            <div className="kvrow">
              <span>累计 tokens</span>
              <b>↑{fmtTok(stats.input_tokens)} ↓{fmtTok(stats.output_tokens)}</b>
            </div>
            <div className="kvrow">
              <span>累计费用（近似）</span>
              <b>{stats.cost_usd != null ? fmtCost(stats.cost_usd) : "部分模型无价格，未计入"}</b>
            </div>
            <div className="kvrow"><span>事件库大小</span><b>{(stats.db_bytes / 1024 / 1024).toFixed(1)} MB</b></div>
          </>
        )}
        <div className="kv">费用按 RUN_FINISHED 里记录的模型与 [pricing] 价格表逐条近似，未知价格不计入（不猜测）。</div>
      </div>
    </>
  );

  if (view === "settings") {
    const pages = { models: modelsPage, memory: memoryPage, mcp: mcpPage, skills: skillsPage, general: generalPage };
    return (
      <div className="settings-screen">
        <aside className="settings-menu">
          <div className="back" onClick={() => setView("chat")}>← 返回工作区</div>
          {permission && (
            <div className="perm-badge" onClick={() => { setView("chat"); }} title="有待审批请求，点击返回">
              ⚠ 有待审批请求
            </div>
          )}
          <h3>基础设置</h3>
          <div className={"mitem" + (section === "models" ? " active" : "")} onClick={() => setSection("models")}><Icon name="cpu" size={15} /> 模型设置</div>
          <h3>Agent 能力</h3>
          <div className={"mitem" + (section === "memory" ? " active" : "")} onClick={() => setSection("memory")}><Icon name="database" size={15} /> 记忆管理</div>
          <div className={"mitem" + (section === "mcp" ? " active" : "")} onClick={() => setSection("mcp")}><Icon name="server" size={15} /> MCP 服务器</div>
          <div className={"mitem" + (section === "skills" ? " active" : "")} onClick={() => setSection("skills")}><Icon name="zap" size={15} /> 技能</div>
          <h3>其他</h3>
          <div className={"mitem" + (section === "general" ? " active" : "")} onClick={() => setSection("general")}><Icon name="sliders" size={15} /> 常规</div>
        </aside>
        <div className="settings-content">{pages[section]}</div>
      </div>
    );
  }

  // —— 工作区（聊天）视图 ——
  return (
    <div className="app">
      <aside>
        <button className="newbtn" onClick={newSession} disabled={conn !== "open"}>＋ 新建会话</button>
        {sideTab === "sessions" && (
          <input
            className="search"
            placeholder="搜索会话标题与内容…"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
          />
        )}
        {sideTab === "sessions" && <h3>会话</h3>}
        <div className="seg">
          <button
            className={sideTab === "sessions" && groupBy === "date" ? "on" : ""}
            onClick={() => {
              setSideTab("sessions");
              setGroupBy("date");
            }}
          >
            时间
          </button>
          <button
            className={sideTab === "sessions" && groupBy === "group" ? "on" : ""}
            onClick={() => {
              setSideTab("sessions");
              setGroupBy("group");
            }}
          >
            分组
          </button>
          <button className={sideTab === "projects" ? "on" : ""} onClick={() => setSideTab("projects")}>
            项目
          </button>
        </div>
        {sideTab === "projects" && (
          <div className="proj-pane">
            <div className="proj-card">
              <div className="proj-label">当前项目</div>
              <div className="proj-path" title={projects.current || ""}>
                {projects.current ? projects.current.split(/[\\/]/).filter(Boolean).pop() : "默认目录"}
              </div>
              <div className="proj-full" title={projects.current || ""}>
                {projects.current || "未选择项目，daemon 以启动目录为工作区"}
              </div>
            </div>
            <button
              className="newbtn"
              style={{ marginTop: 10 }}
              onClick={pickProject}
              disabled={!window.myharness || switching}
              title={window.myharness ? "选择一个本地文件夹作为项目工作区" : "仅桌面端可用"}
            >
              {switching ? "切换中…" : "打开文件夹…"}
            </button>
            {projects.recent.length > 0 && <h3 style={{ marginTop: 14 }}>最近项目</h3>}
            {projects.recent.map((p) => (
              <div
                key={p}
                className={"sess" + (p === projects.current ? " active" : "")}
                onClick={() => switchProject(p)}
                title={p}
              >
                <div className="sinfo">
                  <div className="stitle proj-name">
                    <Icon name="folder" size={12} />
                    {p.split(/[\\/]/).filter(Boolean).pop()}
                  </div>
                  <div className="smeta">{p}</div>
                </div>
              </div>
            ))}
            <div className="proj-hint">
              切换项目会重启本地 daemon。每个项目有独立的记忆库与 AGENT.md；会话仍全局保留。
            </div>
          </div>
        )}
        {sideTab === "sessions" && groupBy === "group" && (
          <>
            <button className="newbtn" style={{ marginTop: 8 }} onClick={() => setShowGroupInput((s) => !s)}>
              ＋ 新建分组
            </button>
            {showGroupInput && (
              <div className="attach-row">
                <input
                  autoFocus
                  placeholder="分组名称，Enter 创建"
                  value={groupInput}
                  onChange={(e) => setGroupInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const n = groupInput.trim();
                      if (n && conn === "open") sendCmd({ type: "CreateSessionGroup", name: n });
                      setGroupInput("");
                      setShowGroupInput(false);
                    }
                    if (e.key === "Escape") setShowGroupInput(false);
                  }}
                />
              </div>
            )}
          </>
        )}
        {sideTab === "sessions" && searchQ.trim() && contentResults.length > 0 && (
          <>
            <div className="ghead" style={{ cursor: "default" }}>
              <span>🔍 内容匹配</span>
              <span>{contentResults.length}</span>
            </div>
            {contentResults.map((r, i) => (
              <div
                key={r.session_id + String(i)}
                className={"sess" + (r.session_id === sessionId ? " active" : "")}
                onClick={() => resume(r.session_id)}
                title={r.snippet}
              >
                <div className="sinfo">
                  <div className="stitle">{r.title || r.session_id.slice(0, 10)}</div>
                  <div className="smeta">{r.snippet}</div>
                </div>
              </div>
            ))}
          </>
        )}
        {sideTab === "sessions" &&
          (() => {
            const q = searchQ.trim().toLowerCase();
          const filtered = q
            ? (sessions || []).filter(
                (s) =>
                  (s.title || "").toLowerCase().includes(q) || s.session_id.includes(q)
              )
            : sessions || [];
          if (q && filtered.length === 0) return <div className="meta" style={{ padding: "4px 14px" }}>无匹配会话</div>;

          const sessionRow = (s: SessionInfo) => (
            <div
              key={s.session_id}
              className={"sess" + (s.session_id === sessionId ? " active" : "")}
              draggable={groupBy === "group"}
              onDragStart={(e) => e.dataTransfer.setData("text/session-id", s.session_id)}
              onClick={() => renaming?.id !== s.session_id && resume(s.session_id)}
            >
              <div className="sinfo">
                {renaming?.id === s.session_id ? (
                  <input
                    className="ren"
                    autoFocus
                    value={renaming.value}
                    onChange={(e) => setRenaming((r) => (r ? { ...r, value: e.target.value } : r))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        sendCmd({ type: "RenameSession", session_id: s.session_id, title: renaming.value });
                        setRenaming(null);
                      } else if (e.key === "Escape") {
                        setRenaming(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div className="stitle">
                    {s.pinned && <span className="pinmark"><Icon name="pin" size={11} filled /></span>}
                    {s.title || s.session_id.slice(0, 10)}
                  </div>
                )}
                <div className="smeta">
                  {fmtRowTime(s.last_active)} · {s.events} ev
                </div>
              </div>
              <div className="actions" onClick={(e) => e.stopPropagation()}>
                {confirmDelete === s.session_id ? (
                  <>
                    <span className="confirm-label">删除?</span>
                    <button
                      className="icon danger"
                      title="确认删除"
                      onClick={() => {
                        sendCmd({ type: "DeleteSession", session_id: s.session_id });
                        setConfirmDelete(null);
                      }}
                    >
                      <Icon name="check" />
                    </button>
                    <button className="icon" title="取消" onClick={() => setConfirmDelete(null)}>
                      <Icon name="x" />
                    </button>
                  </>
                ) : (
                  <>
                    {groupBy === "group" &&
                      (moveSession === s.session_id ? (
                        <select
                          className="moveselect"
                          autoFocus
                          defaultValue={s.group || ""}
                          onChange={(e) => {
                            sendCmd({ type: "SetSessionGroup", session_id: s.session_id, group: e.target.value });
                            setMoveSession(null);
                          }}
                          onBlur={() => setMoveSession(null)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <option value="">未分组</option>
                          {sessionGroups.map((gname) => (
                            <option key={gname} value={gname}>{gname}</option>
                          ))}
                        </select>
                      ) : (
                        <button className="icon" title="移动到分组" onClick={() => setMoveSession(s.session_id)}>
                          <Icon name="folder" size={12} />
                        </button>
                      ))}
                    <button className="icon" title="重命名" onClick={() => setRenaming({ id: s.session_id, value: s.title || "" })}>
                      <Icon name="edit" />
                    </button>
                    <button
                      className="icon"
                      title={s.pinned ? "取消置顶" : "置顶"}
                      onClick={() =>
                        sendCmd({ type: "PinSession", session_id: s.session_id, pinned: !s.pinned })
                      }
                    >
                      <Icon name="pin" filled={s.pinned} />
                    </button>
                    <button className="icon danger" title="删除会话" onClick={() => setConfirmDelete(s.session_id)}>
                      <Icon name="x" />
                    </button>
                  </>
                )}
              </div>
            </div>
          );

          // 新建的会话还没有任何事件，服务端列表（events 表派生）里不存在：
          // 乐观显示一行，首条消息落库后 RunStarted→ListSessions 用服务器数据接管
          const provisionalRow =
            sessionId && !q && !(sessions || []).some((s) => s.session_id === sessionId)
              ? sessionRow({
                  session_id: sessionId,
                  title: "新会话",
                  last_active: new Date().toISOString(),
                  events: 0,
                })
              : null;

          // 手动分组模式：自定义分组 + 拖拽/菜单移动 + 未分组区
          if (groupBy === "group") {
            const grouped = filtered.filter((s) => s.group);
            const ungrouped = filtered.filter((s) => !s.group);
            const groupBlock = (gname: string | null, groupItems: SessionInfo[], hint?: string) => (
              <div key={gname || "__ungrouped__"}>
                {gname ? (
                  <div
                    className={"ghead" + (dropTarget === gname ? " drop" : "")}
                    onClick={() => setCollapsedGroups((c) => ({ ...c, ["group:" + gname]: !c["group:" + gname] }))}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDropTarget(gname);
                    }}
                    onDragLeave={() => setDropTarget((t) => (t === gname ? null : t))}
                    onDrop={(e) => {
                      e.preventDefault();
                      const sid = e.dataTransfer.getData("text/session-id");
                      if (sid) sendCmd({ type: "SetSessionGroup", session_id: sid, group: gname });
                      setDropTarget(null);
                    }}
                  >
                    {groupRenaming?.old === gname ? (
                      <input
                        className="ren"
                        autoFocus
                        value={groupRenaming.value}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") {
                            sendCmd({ type: "RenameSessionGroup", name: gname, new_name: groupRenaming.value });
                            setGroupRenaming(null);
                          } else if (e.key === "Escape") {
                            setGroupRenaming(null);
                          }
                        }}
                      />
                    ) : (
                      <span className="glabel">
                        {collapsedGroups["group:" + gname] ? "▸" : "▾"} # {gname}
                      </span>
                    )}
                    <span className="gact" onClick={(e) => e.stopPropagation()}>
                      {groupItems.length}
                      <button className="icon" title="重命名分组" onClick={() => setGroupRenaming({ old: gname, value: gname })}>
                        <Icon name="edit" size={11} />
                      </button>
                      <button
                        className="icon danger"
                        title="删除分组（组内会话移至未分组）"
                        onClick={() => sendCmd({ type: "DeleteSessionGroup", name: gname })}
                      >
                        <Icon name="x" size={11} />
                      </button>
                    </span>
                  </div>
                ) : (
                  <div className="ghead" style={{ cursor: "default" }}>
                    <span>未分组</span>
                    <span>{groupItems.length}</span>
                  </div>
                )}
                {(!gname || !collapsedGroups["group:" + gname]) &&
                  (groupItems.length ? (
                    groupItems.map(sessionRow)
                  ) : (
                    <div className="drop-hint">{hint || "拖拽会话到这里"}</div>
                  ))}
              </div>
            );
            return (
              <>
                {provisionalRow}
                {sessionGroups.map((gname) =>
                  groupBlock(gname, grouped.filter((s) => s.group === gname), "拖拽会话到这里")
                )}
                {groupBlock(null, ungrouped, "暂无会话")}
              </>
            );
          }

          // 时间自动分组模式
          return (
            <>
              {provisionalRow}
              {groupSessions(filtered).map((g) => (
                <div key={g.key}>
                  <div
                    className="ghead"
                    onClick={() => setCollapsedGroups((c) => ({ ...c, [g.key]: !c[g.key] }))}
                  >
                    <span>{collapsedGroups[g.key] ? "▸" : "▾"} {g.label}</span>
                    <span>{g.items.length}</span>
                  </div>
                  {!collapsedGroups[g.key] && g.items.map(sessionRow)}
                </div>
              ))}
            </>
          );
        })()}
        <div className="aside-footer">
          <div className="avatar">本</div>
          <div className="acct">
            <div className="name">本地用户</div>
            <div className="sub">本地模式 · 账号体系开发中</div>
          </div>
          <button className="gear" title="设置" onClick={() => setView("settings")}>⚙</button>
        </div>
      </aside>
      <div className="main">
        <header>
          <span className={"dot " + dot} />
          <span className="title topic" title={currentTitle}>{currentTitle}</span>
          <span className="meta">
            {conn} · {shortModel(currentModel)}
            {running ? ` · ⏱ ${fmtClock(elapsed)}` : ""}
            {sessCost || runUsage
              ? ` · 会话 ↑${fmtTok((sessCost?.input_tokens || 0) + (runUsage?.input_tokens || 0))} ↓${fmtTok(
                  (sessCost?.output_tokens || 0) + (runUsage?.output_tokens || 0)
                )} tok`
              : ""}
            {sessCost?.cost_usd != null ? ` · ${fmtCost(sessCost.cost_usd)}` : ""}
          </span>
          {(() => {
            if (!ctxInfo || ctxInfo.window <= 0 || ctxInfo.tokens <= 0) return null;
            const pct = Math.min(100, (ctxInfo.tokens / ctxInfo.window) * 100);
            const color = pct >= 85 ? "#f85149" : pct >= 70 ? "#e3b341" : "#4493f8";
            const r = 6, c = 2 * Math.PI * r;
            return (
              <button className={"ctx-chip" + (ctxOpen ? " on" : "")} title="上下文容量" onClick={() => setCtxOpen((o) => !o)}>
                <svg width="16" height="16" viewBox="0 0 16 16" style={{ display: "block" }}>
                  <circle cx="8" cy="8" r={r} fill="none" stroke="#30363d" strokeWidth="2.5" />
                  <circle
                    cx="8" cy="8" r={r} fill="none" stroke={color} strokeWidth="2.5"
                    strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round"
                    transform="rotate(-90 8 8)"
                  />
                </svg>
                {Math.round(pct)}%
              </button>
            );
          })()}
          <button
            className={"term-toggle" + (termOpen ? " on" : "")}
            title={termOpen ? "收起终端" : "打开终端"}
            onClick={() => setTermOpen((o) => !o)}
          >
            <Icon name="terminal" size={14} />
          </button>
        </header>
        {ctxOpen && ctxInfo && ctxInfo.window > 0 && (
          <div className="ctx-pop" ref={ctxPopRef}>
            {(() => {
              const pct = Math.min(100, (ctxInfo.tokens / ctxInfo.window) * 100);
              const statPct = Math.min(100, (ctxInfo.static / ctxInfo.window) * 100);
              const msgTok = Math.max(0, ctxInfo.tokens - ctxInfo.static);
              const msgPct = Math.min(100, (msgTok / ctxInfo.window) * 100);
              const barColor = pct >= 85 ? "#f85149" : pct >= 70 ? "#e3b341" : "#4493f8";
              return (
                <>
                  <div className="ctx-head">
                    <span>上下文容量</span>
                    <span className="ctx-nums">
                      {fmtWan(ctxInfo.tokens)} / {fmtWan(ctxInfo.window)}（{pct.toFixed(1)}%）
                    </span>
                  </div>
                  <div className="ctx-bar">
                    <div className="ctx-fill" style={{ width: `${pct}%`, background: barColor }} />
                  </div>
                  <div className="ctx-row"><span><i className="cdot" style={{ background: barColor }} />对话消息</span><b>{msgPct.toFixed(1)}%</b></div>
                  <div className="ctx-row"><span><i className="cdot" style={{ background: "#8b949e" }} />系统提示词与工具</span><b>{statPct.toFixed(1)}%</b></div>
                  <div className="ctx-row"><span><i className="cdot" style={{ background: "#30363d" }} />剩余余量</span><b>{(100 - pct).toFixed(1)}%</b></div>
                  <div className="ctx-note">对话消息按模型返回的 input tokens 计，静态部分为字符估算，供参考；超 85% 触发自动压缩。</div>
                </>
              );
            })()}
          </div>
        )}
        {outlineItems.length > 1 && (
          <div className="outline-nav">
            {outlineItems.map((it) => (
              <div
                key={it.id}
                className={"obar" + (it.kind === "user" ? " me" : "")}
                style={{ width: `${Math.min(52, 12 + Math.min(it.text.length, 400) / 8)}px` }}
                onClick={() => {
                  const el = document.querySelector(`[data-mid="${it.id}"]`);
                  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                onMouseEnter={(e) =>
                  // offsetTop 相对导航条（自身 top:54px），换算成 .main 坐标 + 64 间隙
                  setOutlineTip({ text: it.text.slice(0, 200), top: e.currentTarget.offsetTop + 64 })
                }
                onMouseLeave={() => setOutlineTip(null)}
              />
            ))}
          </div>
        )}
        {outlineTip && (
          <div className="outline-tip" style={{ top: outlineTip.top }}>{outlineTip.text}</div>
        )}
        <div id="msgs" ref={listRef} className={outlineItems.length > 1 ? "with-nav" : ""}>
          {items.map((it) => {
            if (it.kind === "think") {
              return <ThinkRow key={it.id} it={it} />;
            }
            if (it.kind === "tool") {
              const m = it.meta;
              const live = it.status === "running" || it.status === "streaming";
              const secs = live && it.startedAt ? Math.floor((Date.now() - it.startedAt) / 1000) : null;
              const outLine = it.output ? it.output.trimEnd().split("\n").pop() || "" : "";
              const preview = it.status === "streaming" && it.argsRaw ? it.argsRaw.slice(-140) : "";
              return (
                <div
                  key={it.id}
                  className={
                    "tool " +
                    (it.status === "done"
                      ? "done"
                      : it.status === "fail"
                        ? "fail"
                        : it.status === "stopped"
                          ? "stopped"
                          : live
                            ? "live"
                            : "")
                  }
                  title={(it.args || it.argsRaw || it.tool) + (it.status === "fail" && it.detail ? `\n——\n${it.detail}` : "")}
                >
                  <span className="ticon"><Icon name={m?.icon || "zap"} size={12} /></span>
                  <span className="tverb">{m?.verb || it.tool}</span>
                  {it.status === "streaming" ? (
                    preview ? <span className="ttarget raw">{preview}</span> : null
                  ) : (
                    <>
                      {m?.target ? <span className="ttarget">{m.target}</span> : null}
                      {m?.add != null ? <span className="tadd">+{m.add}</span> : null}
                    </>
                  )}
                  <span className={"tstatus" + (it.status === "stopped" ? " stopped" : it.status === "fail" ? " fail" : "")}>
                    {live ? <span className="spin" /> : null}
                    {it.status === "streaming"
                      ? "生成中"
                      : it.status === "running"
                        ? "running"
                        : it.status === "done"
                          ? "✓"
                          : it.status === "stopped"
                            ? "已停止"
                            : "执行失败"}
                    {secs != null ? ` ${fmtClock(secs)}` : ""}
                  </span>
                  {live && outLine ? (
                    <div className="tout" title={it.output}>
                      {outLine.slice(-160)}
                    </div>
                  ) : null}
                </div>
              );
            }
            if (it.kind === "user") {
              return (
                <div key={it.id} className="msg user" data-mid={it.id}>
                  <div className="bubble">
                    {it.images && it.images.length > 0 && (
                      <div className="imgs">
                        {it.images.map((im, i) => (
                          <img
                            key={i}
                            src={`data:${im.media_type};base64,${im.data}`}
                            alt="附件图片"
                            onClick={() => setPreview(`data:${im.media_type};base64,${im.data}`)}
                          />
                        ))}
                      </div>
                    )}
                    {it.text}
                  </div>
                  {/* 分支按钮在文档流里（悬停显形），不再悬浮压字、也不会因移出消息而点不到 */}
                  <div className="msg-foot user-foot">
                    {it.seq != null && (
                      <button className="mact" title="从此消息开启分支会话" onClick={() => forkSession(it)}>
                        <Icon name="branch" size={13} />
                      </button>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div key={it.id} className={"msg " + it.kind} data-mid={it.kind === "assistant" ? it.id : undefined}>
                {it.kind === "assistant" && it.text ? (
                  <div className="md" dangerouslySetInnerHTML={{ __html: mdRender(it.text) }} />
                ) : (
                  it.text
                )}
                {it.kind === "assistant" && it.text === "" ? <span className="cursor" /> : null}
                {it.kind === "assistant" && (it.seq != null || it.duration_ms != null) ? (
                  <div className="msg-foot">
                    {it.text ? (
                      <button className="mact" title="复制内容" onClick={() => copyMsg(it)}>
                        <Icon name={copiedId === it.id ? "check" : "copy"} size={13} />
                      </button>
                    ) : null}
                    {it.seq != null && (
                      <button className="mact" title="从此消息开启分支会话" onClick={() => forkSession(it)}>
                        <Icon name="branch" size={13} />
                      </button>
                    )}
                    {it.duration_ms != null ? (
                      <span className="dur">
                        ⏱ {fmtDur(it.duration_ms)}
                        {it.usage ? ` · ↑${fmtTok(it.usage.input_tokens)} ↓${fmtTok(it.usage.output_tokens)} tok` : ""}
                        {it.cost_usd != null ? ` · ${fmtCost(it.cost_usd)}` : ""}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {running && !firstToken && (
            <div className="working">
              <div className="working-head">
                <span className="spin" />
                {reasonFull ? `思考中 · ${fmtClockCn(elapsed)}` : `工作中 ${fmtClockCn(elapsed)}`}
              </div>
              {reasonFull ? (
                // ZCode 式实时思考区：推理全文流式滚动，本轮结束后落成可展开的「思考」折叠条
                <div className="think-live" ref={liveThinkRef}>
                  <pre>{reasonFull}</pre>
                </div>
              ) : null}
            </div>
          )}
          {permission && (
            <div className="perm">
              <div>⚠ 审批请求：{permission.tool}</div>
              <div className="reason">{permission.reason}</div>
              <button className="primary" onClick={() => respond("yes")}>仅本次允许</button>
              <button onClick={() => respond("always")}>总是允许</button>
              <button onClick={() => respond("no")}>拒绝</button>
            </div>
          )}
          {preview && (
            <div className="lightbox" onClick={() => setPreview(null)}>
              <img src={preview} alt="preview" />
            </div>
          )}
        </div>
        {/* 排队中的消息悬停在输入框上方（ZCode 式）：↑立即=空闲直接发/运行中插队首 / 编辑 / 移除 */}
        {queue.map((q) => (
          <div key={q.id} className="queue-row">
            <div className="qtext" title={q.text}>{q.text}</div>
            <button
              className="qbtn primary"
              title={running ? "插到队首，当前任务结束后第一个发送" : "立即发送这条消息"}
              onClick={() => queueBump(q.id)}
            >
              ↑ 立即
            </button>
            <button className="qbtn" title="改回输入框" onClick={() => queueEdit(q)}>
              <Icon name="edit" size={12} />
            </button>
            <button className="qbtn" title="移除" onClick={() => queueDelete(q.id)}>
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
        {termOpen && <TerminalPanel onClose={() => setTermOpen(false)} />}
        <div className="composer">
          {pasteImages.length > 0 && (
            <div className="atchips">
              {pasteImages.map((p, i) => (
                <span key={i} className="chip imgchip">
                  <img src={`data:${p.media_type};base64,${p.data}`} alt="paste" />
                  <span className="chipx" onClick={() => setPasteImages((prev) => prev.filter((_, j) => j !== i))}>×</span>
                </span>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="atchips">
              {attachments.map((a) => (
                <span key={a.path} className="chip">
                  📄 {a.path}
                  <span className="chipx" onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}>×</span>
                </span>
              ))}
            </div>
          )}
          {showAttach && (
            <div className="attach-row">
              <input
                autoFocus
                placeholder="输入工作区内文件路径，Enter 添加附件"
                value={attachPath}
                onChange={(e) => setAttachPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitAttach()}
              />
            </div>
          )}
          <textarea
            id="input"
            rows={2}
            value={input}
            placeholder={
              running
                ? "继续输入以排队后续修改…（Enter 入队，当前任务结束后自动发送）"
                : conn === "open"
                  ? "输入任务，Enter 发送；可直接 Ctrl+V 粘贴图片…"
                  : "等待连接…"
            }
            onChange={(e) => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            disabled={conn !== "open"}
          />
          <div className="controls">
            <button className="ctl" title="添加工作区文件为附件" onClick={() => setShowAttach((s) => !s)}>＋</button>
            <div className="pdrop" ref={permDropRef}>
              <button
                className={"ctl pchip" + (permMode === "bypass" ? " hot" : "")}
                title="权限模式"
                onClick={() => setPermOpen((s) => !s)}
              >
                <Icon name={(PERM_META[permMode] || PERM_META.default).icon} size={12} />
                {(PERM_META[permMode] || PERM_META.default).label}
                <Icon name="chev" size={11} />
              </button>
              {permOpen && (
                <div className="pmenu">
                  {(Object.entries(PERM_META) as [PermMode, { label: string; desc: string; icon: IconName }][]).map(([k, m]) => (
                    <div
                      key={k}
                      className={"pitem" + (k === permMode ? " active" : "")}
                      onClick={() => {
                        setPerm(k);
                        setPermOpen(false);
                      }}
                    >
                      <span className="picon"><Icon name={m.icon} size={15} /></span>
                      <span className="pbody">
                        <b>{m.label}</b>
                        <i>{m.desc}</i>
                      </span>
                      {k === permMode && <span className="pcheck"><Icon name="check" size={14} /></span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ flex: 1 }} />
            <div className="think-select" title="思考档位">
              <Icon name="brain" size={13} />
              <select className="ctl" value={thinking} onChange={(e) => setThink(e.target.value as ThinkLevel)}>
                {Object.entries(THINKING_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <select
              className="ctl model"
              value={settings.model}
              title="切换模型（仅一个生效）"
              onChange={(e) => {
                if (e.target.value === "__manage__") {
                  setView("settings");
                  setSection("models");
                } else {
                  switchModel(e.target.value);
                }
              }}
            >
              {(settings.models?.length ? settings.models.map((m) => m.model) : [settings.model]).map((m) => (
                <option key={m} value={m}>{shortModel(m)}</option>
              ))}
              <option value="__manage__">⚙ 管理模型…</option>
            </select>
            {running ? (
              <button className="send stop" title="停止当前任务" onClick={stopRun}>
                <span className="stopsq" />
              </button>
            ) : (
              <button className="send" onClick={sendMessage} disabled={conn !== "open" || !input.trim()}>↑</button>
            )}
          </div>
        </div>
      </div>
      {switching && (
        <div className="switching-mask">
          <div className="switching-card">
            <div className="spin big" />
            <div>正在切换项目 · daemon 重启中…</div>
            <div className="meta">通常需要 5–20 秒（sidecar 冷启动），完成后自动重连</div>
          </div>
        </div>
      )}
      {showOnboard && (
        <div className="onboard-mask">
          <div className="onboard-card">
            <div className="onboard-title">连接你的模型</div>
            <div className="onboard-sub">
              My-Harness 不绑定任何厂商：填任意 OpenAI 兼容端点即可开始。
              API Key 与全部对话数据只保存在本机 ~/.my-harness/，无账号、无云同步、无遥测。
            </div>
            <div className="prow">
              <label>厂商</label>
              <select value={modelForm.provider} onChange={(e) => pickProvider(e.target.value)}>
                {PROVIDERS.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
              </select>
              <div className="meta">{PROVIDERS.find((p) => p.key === modelForm.provider)?.hint}</div>
            </div>
            <div className="prow">
              <label>模型名称（自由填写，不做预设限制）</label>
              <input
                placeholder="例如 glm-4.6 / deepseek-chat"
                value={modelForm.modelName}
                onChange={(e) => setModelForm((f) => ({ ...f, modelName: e.target.value }))}
              />
            </div>
            <div className="prow">
              <label>API Key</label>
              <input
                type="password"
                placeholder="sk-..."
                value={modelForm.api_key}
                onChange={(e) => setModelForm((f) => ({ ...f, api_key: e.target.value }))}
              />
            </div>
            <div className="prow">
              <label>Base URL（可选，已按厂商预填）</label>
              <input
                placeholder="https://..."
                value={modelForm.api_base}
                onChange={(e) => setModelForm((f) => ({ ...f, api_base: e.target.value }))}
              />
            </div>
            {testState && (
              <div className={"test-line " + (testState.status === "running" ? "" : testState.ok ? "ok" : "fail")}>
                {testState.status === "running"
                  ? "测试中…（最长 30s）"
                  : testState.ok
                    ? `✓ 连接正常 · ${testState.latency_ms}ms · 回复: ${testState.reply || "(空)"}`
                    : `连接失败：${testState.error}`}
              </div>
            )}
            <div className="onboard-actions">
              <button
                onClick={testModel}
                disabled={conn !== "open" || !modelForm.modelName.trim() || testState?.status === "running"}
              >
                测试连接
              </button>
              <button className="savebtn" onClick={saveSettings} disabled={conn !== "open" || !modelForm.modelName.trim()}>
                保存并开始
              </button>
              <button className="onboard-skip" onClick={() => setOnboard(false)}>
                跳过，稍后在设置里配置
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
