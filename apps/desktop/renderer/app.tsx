// My-Harness 桌面端渲染进程：纯 Web 页面 + WebSocket，走 Local Server 的 UI 事件协议（DESIGN.md §4.11）。
// 工作区：ZCode 式布局——模型回答靠左、用户输入靠右（气泡）、工具卡片、审批卡片、运行时长。
// 输入栏：＋附件 / 权限模式 / 思考档位 / 模型切换 / 发送。设置页：模型(列表)/记忆/MCP/技能/常规。
import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Icon, ThinkRow, TerminalPanel, type IconName } from "./icons";
import { FileTree, EditorPane } from "./workbench";
import type { FileDoc } from "./workbench";
import { setSocket } from "./ws";
import { setWorkspaceRoot, disposeFileModel } from "./monaco";
import * as lsp from "./lsp";
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

import { mdRender } from "./md";

const params = new URLSearchParams(window.location.search);
const WS_URL = params.get("ws") || "ws://127.0.0.1:8765/ws";
const SERVER_STATE = params.get("server") || "unknown";
// 当前项目根（main.ts 经 query 传入）：Monaco model 的 file:// URI 基准
const WORKSPACE_ROOT = params.get("root") || "";

// daemon 握手状态 → 设置页「常规」里的人类可读说明
const STATE_TEXT: Record<string, string> = {
  attached: "attached",
  started: "sidecar started",
  restarted: "旧 daemon 已替换",
  starting: "daemon 启动中…（就绪后自动连接）",
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

// 心跳看门狗：TCP 半死（睡眠唤醒/静默断链）时 send 不报错、onclose 不触发，界面全部「没反应」。
// 每 15s 发 Ping，10s 内无 Pong 判定连接已死 → 强制 close 走既有的 2s 自动重连。
let hbTimer: ReturnType<typeof setInterval> | null = null;
let hbAwaitingPong = false;
let hbSeq = 0;
function startHeartbeat() {
  stopHeartbeat();
  hbAwaitingPong = false;
  hbTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (hbAwaitingPong) {
      try { ws.close(); } catch { /* 已关闭无所谓 */ }
      return;
    }
    hbAwaitingPong = true;
    const seq = ++hbSeq;
    sendCmd({ type: "Ping" });
    setTimeout(() => {
      if (hbSeq === seq) hbAwaitingPong = false; // Pong 已到会推进 hbSeq，过期定时器不误清
    }, 10000);
  }, 15000);
}
function stopHeartbeat() {
  if (hbTimer) {
    clearInterval(hbTimer);
    hbTimer = null;
  }
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
  refs?: { path: string; from: number; to: number }[]; // 引用芯片：从 composed/落库文本解析
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

// —— 顶栏菜单栏（VS Code 式）：文件/编辑/查看/转到/终端/帮助 ——
// 菜单项由 App 每次渲染用最新闭包构建；点开某项后悬停即切换，外点/Esc 关闭。
// 弹层 fixed 定位挂在 menubar 里（.mb-pop 自带 no-drag，不受顶栏拖拽区影响）。
type MenuEntry = { label: string; accel?: string; checked?: boolean; disabled?: boolean; hide?: boolean; run(): void } | "sep";

function MenuBar(props: { menus: { label: string; items: MenuEntry[] }[] }) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [popAt, setPopAt] = useState({ x: 8, y: 32 });
  const openAt = (i: number) => {
    const b = btnRefs.current[i];
    if (b) {
      const r = b.getBoundingClientRect();
      setPopAt({ x: r.left, y: r.bottom + 4 });
    }
    setOpen(i);
  };
  useEffect(() => {
    if (open == null) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menubar" ref={barRef}>
      {props.menus.map((m, i) => (
        <button
          key={m.label}
          ref={(el) => {
            btnRefs.current[i] = el;
          }}
          className={"mb-item" + (open === i ? " on" : "")}
          onClick={() => (open === i ? setOpen(null) : openAt(i))}
          onMouseEnter={() => {
            if (open != null && open !== i) openAt(i);
          }}
        >
          {m.label}
        </button>
      ))}
      {open != null && (
        <div className="mb-pop" style={{ left: popAt.x, top: popAt.y }}>
          {props.menus[open].items
            .filter((it) => it === "sep" || !it.hide)
            .map((it, i) =>
              it === "sep" ? (
                <div key={"s" + i} className="mb-sep" />
              ) : (
                <div
                  key={it.label}
                  className={"mb-row" + (it.disabled ? " dis" : "")}
                  onClick={() => {
                    if (it.disabled) return;
                    setOpen(null);
                    it.run();
                  }}
                >
                  <span className="mb-check">{it.checked ? "✓" : ""}</span>
                  <span>{it.label}</span>
                  {it.accel && <span className="mb-accel">{it.accel}</span>}
                </div>
              )
            )}
        </div>
      )}
    </div>
  );
}

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
  const [dragSid, setDragSid] = useState<string | null>(null); // 正在被拖拽的会话（拖拽反馈 + dataTransfer 兜底）
  const [moveSession, setMoveSession] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [groupBy, setGroupBy] = useState<"date" | "group">("date"); // date | topic | group
  const [sideTab, setSideTab] = useState<"sessions" | "files">("sessions"); // 两种模式：会话（harness）/ 代码（IDE）
  const [codeMode, setCodeMode] = useState<"tree" | "search" | "git">("tree"); // 代码面板子视图（由活动栏切换）
  const [showProjects, setShowProjects] = useState(false); // 会话模式内的项目子面板
  const [projects, setProjects] = useState<{ current: string | null; recent: string[] }>({
    current: null,
    recent: [],
  });
  const [contentResults, setContentResults] = useState<ContentResult[]>([]);
  const [searchQ, setSearchQ] = useState("");
  // 「搜索会话」按钮：打开侧栏会话 tab 并把焦点交给搜索框（自增 tick 驱动 focus）
  const [sessSearchFocus, setSessSearchFocus] = useState(0);
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
  // 输入框镜像层：@path:from-to 引用 token 在底下垫成卡片（CodeBuddy 式）。镜像文本透明只留底色，
  // 与 textarea 同字体/行高/内边距，宽度跟随 clientWidth（滚动条出现时内容宽一致），滚动同步。
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const [attachPath, setAttachPath] = useState("");
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [firstToken, setFirstToken] = useState(false); // 本轮是否已收到首 token
  const [reason, setReason] = useState(""); // 当前轮推理增量（保留末 400 字符，ZCode 式正在思考）
  const [reasonFull, setReasonFull] = useState(""); // 本轮完整推理全文：思考区实时流式显示（ZCode 式）
  const [queue, setQueue] = useState<QueueItem[]>([]); // 运行中排队的消息
  const [termOpen, setTermOpen] = useState(false); // 内嵌终端面板（编辑器下方抽屉）
  // —— 工作台（IDE，见 IDE-DESIGN.md）——
  // editorOpen=false 即「对话模式」：编辑器让位、对话占满主区（actbar 会话键切换）
  const [editorOpen, setEditorOpen] = useState(false); // 默认会话模式（ZCode 式大对话）；代码模式点活动栏「资源管理器」等进入
  const [chatW, setChatW] = useState(400); // 对话栏宽度（CodeBuddy/Trae 式窄栏，编辑器占主区）
  const [chatHidden, setChatHidden] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // 顶栏「查看」菜单的编辑器外观开关（localStorage 持久化，重启记住）
  const [minimapOn, setMinimapOn] = useState(() => localStorage.getItem("yh.minimap") !== "0");
  const [wrapOn, setWrapOn] = useState(() => localStorage.getItem("yh.wordwrap") === "1");
  const toggleMinimap = () =>
    setMinimapOn((v) => {
      localStorage.setItem("yh.minimap", v ? "0" : "1");
      return !v;
    });
  const toggleWrap = () =>
    setWrapOn((v) => {
      localStorage.setItem("yh.wordwrap", v ? "0" : "1");
      return !v;
    });
  const chatDrag = useRef<{ startX: number; startW: number } | null>(null);
  const [openFiles, setOpenFiles] = useState<{ path: string; truncated: boolean; binary: boolean; dirty: boolean }[]>([]);
  const openFilesRef = useRef(openFiles);
  useEffect(() => { openFilesRef.current = openFiles; }, [openFiles]);
  const diffTabsRef = useRef<string[]>([]);
  const [, bumpDiffs] = useState(0);
  const [activeTab, setActiveTab] = useState<{ kind: "file" | "diff"; path: string | null }>({ kind: "file", path: null });
  const fileDocs = useRef<Record<string, FileDoc>>({});
  const [conflict, setConflict] = useState<string | null>(null);
  const pendingOpen = useRef<Record<string, { line?: number }>>({});
  const pendingReload = useRef<Set<string>>(new Set());
  const diffReq = useRef<Set<string>>(new Set());
  const diffStore = useRef<Record<string, { base?: string; current?: string }>>({});
  const [reveal, setReveal] = useState<{ path: string; line: number } | null>(null);
  const [dirListing, setDirListing] = useState<{ path: string; entries: { name: string; kind: "file" | "dir"; size: number; mtime: number }[]; n: number } | null>(null);
  const dirSeq = useRef(0);
  const [searchRes, setSearchRes] = useState<{ query: string; results: { path: string; line: number; col: number; text: string }[]; files: string[]; total: number; truncated: boolean } | null>(null);
  const [gitFiles, setGitFiles] = useState<Record<string, string>>({});
  const [gitScm, setGitScm] = useState<{ repo: boolean; branch: string; ahead: number; files: { path: string; code: string; xy: string }[]; error?: string }>({ repo: false, branch: "", ahead: 0, files: [] });
  const [gitBranch, setGitBranch] = useState("");
  const [runChanged, setRunChanged] = useState<string[]>([]);
  const runChangedRef = useRef(runChanged);
  useEffect(() => { runChangedRef.current = runChanged; }, [runChanged]);
  const toolPaths = useRef(new Map<string, string>()); // call_id → path（ToolCallResult 补做写盘后重载）
  const [filesRefresh, setFilesRefresh] = useState(0);
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
  const [lastRun, setLastRun] = useState<{ duration_ms?: number; usage?: { input_tokens: number; output_tokens: number }; cost_usd?: number | null } | null>(null); // 最近一次对话（输入框上方用量条）
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
    addItem({ kind: "user", text, images: imgs.length ? imgs : undefined, refs: parseChatRefs(composed || text) });
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

  // 编辑器列宽拖拽
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!chatDrag.current) return;
      const w = chatDrag.current.startW - (e.clientX - chatDrag.current.startX);
      setChatW(Math.max(370, Math.min(window.innerWidth * 0.55, w))); // 370 以下模型选择器等图标放不下
    };
    const onUp = () => {
      chatDrag.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

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
    setSocket(ws);
    ws.onopen = () => {
      setConn("open");
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      startHeartbeat();
      sendCmd({ type: "ListSessions" }); // 由 SessionList 决定恢复最近会话或新建
      sendCmd({ type: "GetSettings" });
      // 重连场景：daemon 可能重启过（内存会话已丢），重新挂载当前会话，服务端回放 History 重建界面
      if (sessionIdRef.current) sendCmd({ type: "ResumeSession", session_id: sessionIdRef.current });
      // Monaco model 的 file:// URI 需要 workspace 绝对路径（LSP 按路径匹配文件）：
      // 首选 main.ts 经 query 传入的 root；没有（纯浏览器调试）再问 /health
      if (WORKSPACE_ROOT) setWorkspaceRoot(WORKSPACE_ROOT);
      else
        fetch(WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "/health"))
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => setWorkspaceRoot(j?.workspace))
          .catch(() => {});
    };
    ws.onclose = () => {
      stopHeartbeat();
      setConn("closed");
      scheduleReconnect();
    };
    ws.onerror = () => setConn("closed");
    ws.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as WsEvent;
      switch (e.type) {
        case "Pong": // 心跳应答：重置看门狗
          hbAwaitingPong = false;
          hbSeq++;
          break;
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
          setLastRun(null); // 用量属于会话，切换/新建时清空
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
          setLastRun(null); // 用量属于会话，切换/新建时清空
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
              refs: it.kind === "user" ? parseChatRefs(it.text || "") : undefined,
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
          setRunChanged([]); // 新任务：改动列表从零开始
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
        case "DirListing":
          dirSeq.current += 1;
          setDirListing({ path: e.path, entries: e.entries, n: dirSeq.current });
          break;
        case "GotoDefResult":
          // 跳转定义结果：转发给编辑器（EditorPane 按 req 配对后 onJump）
          window.dispatchEvent(
            new CustomEvent("wb-gotodef", { detail: { req: e.req, file: e.file, line: e.line } })
          );
          break;
        case "LintResult":
          // 语法校验结果：转发给编辑器（EditorPane 里的 linter 按 req 配对）
          window.dispatchEvent(new CustomEvent("wb-lint", { detail: { req: e.req, diagnostics: e.diagnostics } }));
          break;
        case "FileContent": {
          window.dispatchEvent(new CustomEvent("wb-filecontent", { detail: { path: e.path, content: e.content } }));          const p = e.path;
          const openReq = pendingOpen.current[p];
          if (openReq) {
            // 编辑器打开请求：建 tab + 文档
            delete pendingOpen.current[p];
            fileDocs.current[p] = { saved: e.content, text: e.content, truncated: e.truncated, binary: e.binary, version: 0 };
            setOpenFiles((prev) => (prev.some((f) => f.path === p) ? prev : [...prev, { path: p, truncated: e.truncated, binary: e.binary, dirty: false }]));
            setActiveTab({ kind: "file", path: p });
            if (openReq.line) setReveal({ path: p, line: openReq.line });
            break;
          }
          if (pendingReload.current.has(p)) {
            // Agent 改完（写盘后）重载干净打开的文件：内容变了才覆盖 model（不动 undo/光标）；
            // 等待期间用户开始编辑（脏了）→ 转冲突条，不静默吞掉用户输入
            pendingReload.current.delete(p);
            const d = fileDocs.current[p];
            if (d) {
              if (d.text !== d.saved) {
                setConflict(p);
                break;
              }
              if (e.content !== d.saved) {
                d.saved = e.content;
                d.text = e.content;
                d.version += 1;
                setOpenFiles((prev) => prev.map((f) => (f.path === p ? { ...f, truncated: e.truncated, binary: e.binary } : f)));
              }
            }
            break;
          }
          if (diffReq.current.has(p)) {
            diffReq.current.delete(p);
            diffStore.current[p] = { ...(diffStore.current[p] || {}), current: e.content };
            bumpDiffs((n) => n + 1);
          }
          break;
        }
        case "FileSaved": {
          const p = e.path;
          const d = fileDocs.current[p];
          if (d) d.saved = d.text;
          setOpenFiles((prev) => prev.map((f) => (f.path === p ? { ...f, dirty: false } : f)));
          setFilesRefresh((n) => n + 1); // 新文件落盘后文件树能看到
          break;
        }
        case "FileSaveConflict": {
          // 保存被 daemon 拒绝（磁盘已被 Agent/外部改过）：以磁盘内容为新基准 + 弹冲突条。
          // 「重新加载」丢弃自己的修改；「保留我的版本」后再次保存即可覆盖（上次冲突已知情）。
          const p = e.path;
          const d = fileDocs.current[p];
          if (d) {
            d.saved = e.disk;
            setOpenFiles((prev) => prev.map((f) => (f.path === p ? { ...f, dirty: d.text !== d.saved } : f)));
          }
          setConflict(p);
          break;
        }
        case "FileBase": {
          const p = e.path;
          if (diffStore.current[p]) {
            diffStore.current[p] = { ...(diffStore.current[p] || {}), base: e.content };
            bumpDiffs((n) => n + 1);
          }
          window.dispatchEvent(new CustomEvent("wb-filebase", { detail: { path: p, content: e.content } }));
          break;
        }
        case "SearchResult":
          setSearchRes({ query: e.query, results: e.results, files: e.files || [], total: e.total, truncated: e.truncated });
          break;
        case "GitStatus":
          setGitBranch(e.branch || "");
          setGitFiles(Object.fromEntries((e.files || []).map((f) => [f.path, f.code])));
          setGitScm({ repo: e.repo !== false, branch: e.branch || "", ahead: e.ahead || 0, files: (e.files || []).map((f) => ({ ...f, xy: f.xy ?? f.code })), error: e.error });
          break;
        case "GitDone":
          // stage/unstage/commit/push 结果：服务端已自动回发 GitStatus；失败/成功都提示到对话流
          if (!e.ok) addItem({ kind: "error", text: `Git ${e.op} 失败：${e.message}` });
          else if (e.op === "commit")
            addItem({ kind: "notice", text: `已提交：${(e.message || "").split("\n")[0]}` });
          else if (e.op === "push") {
            window.dispatchEvent(new CustomEvent("wb-pushdone", { detail: { ok: e.ok } })); // SCM 面板按钮复位
            addItem({ kind: "notice", text: e.ok ? `已推送到远程：${(e.message || "").split("\n")[0]}` : `Git push 失败：${e.message}` });
          }
          break;
        case "GitCommitMsg":
          // AI 生成的提交信息：转发给 Git 面板（生成失败也走同一事件，面板内提示）
          window.dispatchEvent(
            new CustomEvent("wb-gitmsg", { detail: { ok: e.ok, message: e.message, error: e.error } })
          );
          break;
        case "LspStatus":
        case "LspFromServer":
          // 编辑器 LSP 桥：状态/服务端消息转给 lsp.ts（内置 LSP 客户端 + 自有 definition 请求都从这里喂）
          lsp.handleDaemonEvent(e);
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
          {
            // 工作台联动：Agent 触及的文件记入「本次改动」；打开中的文件按脏/净决定冲突条或写盘后重载。
            // 重载必须等 ToolCallResult（写盘已完成）——Started 时读文件拿到的是改前内容，等于没读。
            const wa = (e.args || {}) as Record<string, unknown>;
            const wp = typeof wa.path === "string" ? wa.path.replace(/\\/g, "/") : "";
            if ((e.tool === "edit_file" || e.tool === "write_file") && wp) {
              setRunChanged((prev) => (prev.includes(wp) ? prev : [...prev, wp]));
              if (openFilesRef.current.some((f) => f.path === wp)) {
                toolPaths.current.set(e.call_id || e.tool, wp); // 旧 daemon 无 call_id：退回按工具名配对
                const wd = fileDocs.current[wp];
                if (wd && wd.text !== wd.saved) setConflict(wp);
              }
            }
          }
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
          {
            // Agent 写盘已完成：此刻重载才是改后内容。干净的 tab 静默刷新；脏的弹冲突条让用户选。
            const wp = toolPaths.current.get(e.call_id || e.tool);
            toolPaths.current.delete(e.call_id || e.tool);
            if (wp && !e.is_error) {
              const wd = fileDocs.current[wp];
              if (wd && wd.text !== wd.saved) setConflict(wp);
              else {
                pendingReload.current.add(wp);
                sendCmd({ type: "ReadFile", path: wp });
              }
            }
          }
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
          setLastRun({ duration_ms: e.duration_ms, usage: e.usage, cost_usd: e.cost_usd }); // 输入框上方「最近一次对话」
          markRunEnded();
          {
            // 兜底同步：本 run 改过的文件重新读盘（覆盖经 bash 等非 edit_file 改文件的场景——
            // 那些不走 ToolCallStarted/Result 的 path 记录）。干净的重载，脏的弹冲突条。
            for (const wp of runChangedRef.current) {
              if (!openFilesRef.current.some((f) => f.path === wp)) continue;
              const wd = fileDocs.current[wp];
              if (wd && wd.text !== wd.saved) setConflict(wp);
              else {
                pendingReload.current.add(wp);
                sendCmd({ type: "ReadFile", path: wp });
              }
            }
          }
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

  // 发送时把输入框里的内联引用 token（@path:from-to）就地展开成代码块——
  // 引用长在句子里，多段代码按用户排布的顺序原位展开，不会全部堆到消息末尾
  const composeMessage = (text: string): string => {
    let out = text.replace(/@([^\s@:，。；、]+?):(\d+)-(\d+)/g, (_m, p: string, f: string, t: string) => {
      const d = fileDocs.current[p];
      let body = "";
      if (d && d.text) {
        const lines = d.text.split("\n");
        const seg = lines.slice(Math.max(0, +f - 1), +t).join("\n");
        body = seg.length > 4000 ? seg.slice(0, 4000) + "\n...(truncated)" : seg;
      }
      return (
        `[引用] ${p}:${f}-${t}` +
        (body ? `:\n\`\`\`\n${body}\n\`\`\`` : "（文件未在编辑器打开，请先用 read_file 读取该范围）")
      );
    });
    if (!attachments.length) return out;
    const blocks = attachments
      .map((a) => `--- 附件文件: ${a.path}${a.truncated ? "（已截断）" : ""} ---\n${a.content}`)
      .join("\n\n");
    return `${out}\n\n${blocks}`;
  };

  // 用户消息里的引用标记解析：气泡里只显示问题正文 + 引用芯片，代码块不再重复贴出来
  const parseChatRefs = (text: string): { path: string; from: number; to: number }[] => {
    const out: { path: string; from: number; to: number }[] = [];
    for (const m of text.matchAll(/\[引用\] ([^\n:]+):(\d+)-(\d+)/g)) {
      if (!out.some((r) => r.path === m[1] && r.from === +m[2] && r.to === +m[3]))
        out.push({ path: m[1], from: +m[2], to: +m[3] });
    }
    return out;
  };
  const stripRefBlocks = (text: string): string =>
    text
      .replace(/\[引用\] [^\n]*\n?```[\s\S]*?```/g, "")
      .replace(/\[引用\] [^\n]*（文件未在编辑器打开[^）]*）/g, "")
      .replace(/\n?--- 附件文件: [^\n]*---\n[\s\S]*?(?=\n\n--- 附件文件:|\n\n\[引用\]|$)/g, "")
      .trim();

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
  // 头部「搜索会话」：侧栏会话列表渲染出来后聚焦搜索框
  useEffect(() => {
    if (!sessSearchFocus) return;
    setTimeout(() => document.getElementById("sess-search")?.focus(), 60);
  }, [sessSearchFocus]);

  // 输入框引用 token → 镜像层卡片（发送时 composeMessage 原样展开，正则保持一致）
  const INPUT_REF_TOKEN = /@([^\s@:，。；、]+?):(\d+)-(\d+)/g;
  const mirrorHtml = (text: string): string => {
    if (!text) return "";
    const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // 末尾补零宽空格：pre-wrap 下纯换行尾不会塌掉最后一行行高
    return esc.replace(INPUT_REF_TOKEN, (m) => `<span class="refpill">${m}</span>`) + "\u200b";
  };
  // 自适应高度（上限 40% 视口）+ 镜像层滚动/宽度同步（textarea 出滚动条时两边内容宽必须一致，换行才不错位）
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
    const m = mirrorRef.current;
    if (m) {
      m.scrollTop = ta.scrollTop;
      m.style.width = `${ta.clientWidth}px`;
    }
  }, [input, conn]);
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const m = mirrorRef.current;
      if (m) m.style.width = `${ta.clientWidth}px`;
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, []);

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

  // —— 回答中的代码引用可点击：path:114 / path:114-120 / 第 114-120 行 → 打开对应文件跳行 ——
  // 无文件名的“第 N 行”落到点击时的活动编辑器文件；结果经 mdRender 后的 HTML 上做后处理
  const linkifyLineRefs = (html: string): string =>
    html
      .replace(
        /([\w.\-\/\\]+?\.(?:py|ts|tsx|js|jsx|mjs|json|md|toml|yaml|yml|css|html|go|rs|java|c|cpp)):(\d+)(?:[-–—](\d+))?/g,
        (m, p, l) => `<span class="md-jump" data-path="${p}" data-line="${l}">${m}</span>`
      )
      .replace(/第\s*(\d+)\s*(?:[-–—~]\s*\d+\s*)?行/g, (m, l) => `<span class="md-jump" data-line="${l}">${m}</span>`);

  const onChatClick = (e: React.MouseEvent) => {
    const t = (e.target as HTMLElement).closest(".md-jump") as HTMLElement | null;
    if (!t) return;
    const line = parseInt(t.dataset.line || "0", 10);
    if (!line) return;
    const path = t.dataset.path || (activeTab.kind === "file" && activeTab.path ? activeTab.path : null);
    if (path) openFile(path, line);
  };

  // —— 工作台动作 ——
  const openFile = (path: string, line?: number) => {
    const norm = path.replace(/\\/g, "/");
    if (openFilesRef.current.some((f) => f.path === norm)) {
      setActiveTab({ kind: "file", path: norm });
      if (line) setReveal({ path: norm, line });
      return;
    }
    // VS Code 语义：脏缓冲的 tab 关闭后重开，恢复内存里的未保存内容，不被磁盘读回覆盖
    const keep = fileDocs.current[norm];
    if (keep && keep.text !== keep.saved) {
      keep.version += 1;
      setOpenFiles((prev) => (prev.some((f) => f.path === norm) ? prev : [...prev, { path: norm, truncated: keep.truncated, binary: keep.binary, dirty: true }]));
      setActiveTab({ kind: "file", path: norm });
      if (line) setReveal({ path: norm, line });
      return;
    }
    pendingOpen.current[norm] = { line };
    sendCmd({ type: "ReadFile", path: norm });
  };
  // Editor opener：monaco 跳转定义命中未打开的文件（LSP/兜底都一样）→ 走 openFile 开 tab 并跳行
  useEffect(() => {
    lsp.setOpenHandler(openFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const openDiff = (path: string) => {
    const norm = path.replace(/\\/g, "/");
    if (!diffTabsRef.current.includes(norm)) diffTabsRef.current = [...diffTabsRef.current, norm];
    if (!diffStore.current[norm]) diffStore.current[norm] = {};
    diffReq.current.add(norm);
    bumpDiffs((n) => n + 1);
    setActiveTab({ kind: "diff", path: norm });
    sendCmd({ type: "GitFileBase", path: norm });
    sendCmd({ type: "ReadFile", path: norm });
  };
  const closeTab = (kind: "file" | "diff", path: string) => {
    if (kind === "file") {
      // VS Code 语义：干净的 tab 关闭即释放文本模型（下次打开从磁盘重读）；
      // 脏缓冲保留在 fileDocs 里，重开时恢复未保存内容
      const d = fileDocs.current[path];
      if (d && d.text === d.saved) {
        delete fileDocs.current[path];
        disposeFileModel(path);
      }
      setOpenFiles((prev) => {
        const next = prev.filter((f) => f.path !== path);
        setActiveTab((a) => (a.kind === "file" && a.path === path ? { kind: "file", path: next[next.length - 1]?.path ?? null } : a));
        return next;
      });
    } else {
      diffTabsRef.current = diffTabsRef.current.filter((x) => x !== path);
      delete diffStore.current[path];
      bumpDiffs((n) => n + 1);
      setActiveTab((a) => {
        if (a.kind !== "diff" || a.path !== path) return a;
        if (diffTabsRef.current.length) return { kind: "diff", path: diffTabsRef.current[diffTabsRef.current.length - 1] };
        return { kind: "file", path: openFilesRef.current[openFilesRef.current.length - 1]?.path ?? null };
      });
    }
  };
  const saveFile = (path: string) => {
    const d = fileDocs.current[path];
    if (!d) return;
    // 带 base（最后一次看到的磁盘内容）：期间被 Agent 改过时 daemon 拒写并回 FileSaveConflict，
    // 防止旧缓冲把磁盘上的新内容盖掉
    sendCmd({ type: "WriteWorkspaceFile", path, content: d.text, base: d.saved });
  };
  // 全局 Ctrl+S：编辑器聚焦时 monaco 命令已处理并拦截，这里兜住焦点在对话输入框等处时的保存
  const saveHotkeyRef = useRef<() => void>(() => {});
  saveHotkeyRef.current = () => {
    if (activeTab.kind === "file" && activeTab.path) saveFile(activeTab.path);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      if (e.key.toLowerCase() === "s" && !e.shiftKey) {
        e.preventDefault();
        saveHotkeyRef.current();
      } else if (e.key === "`") {
        e.preventDefault();
        setTermOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const askSelection = (text: string) => {
    setInput((prev) => (prev ? prev + "\n\n" + text : text));
    setTimeout(() => document.getElementById("input")?.focus(), 30);
  };
  // 编辑器 AI 辅助：组装带 path:行号 引用的提示词，直接发给 Agent。
  // 改码类动作在提示词里要求直接 edit_file 落盘——改完走既有联动（浮条/diff/冲突检测）。
  const aiAction = (
    kind: "explain" | "comment" | "refactor" | "fix" | "test" | "file-review",
    path: string,
    sel: string,
    fromLine: number,
    toLine: number
  ) => {
    const ref = `${path}:${fromLine}-${toLine}`;
    const code = `\n\`\`\`\n${sel}\n\`\`\`\n`;
    let prompt = "";
    switch (kind) {
      case "explain":
        prompt = `请解释 ${ref} 的这段代码：用中文说明它在做什么、关键逻辑和潜在风险，不要修改文件。${code}`;
        break;
      case "comment":
        prompt = `请给 ${ref} 的这段代码加上清晰的中文注释：直接用 edit_file 修改原文件，保持逻辑完全不变，只加注释。${code}`;
        break;
      case "refactor":
        prompt = `请重构优化 ${ref} 的这段代码：直接用 edit_file 修改原文件，保持行为不变，改完简要说明你改了什么、为什么。${code}`;
        break;
      case "fix":
        prompt = `请检查并修复 ${ref} 这段代码里的问题（bug、边界条件、错误处理）：直接用 edit_file 修改原文件，改完列出发现的问题。${code}`;
        break;
      case "test":
        prompt = `请为 ${path} 中的以下代码写单元测试：新建一个合适的测试文件（跟随项目现有测试目录/命名习惯），并保证能直接运行。${code}`;
        break;
      case "file-review":
        prompt = `请通读 ${path} 整个文件并做代码审阅：指出正确性、可读性、性能、安全方面的问题，按严重程度排序；不要修改文件，等我决定。`;
        break;
    }
    if (!prompt) return;
    setChatHidden(false); // 回答/改动说明展示在对话栏，确保可见
    sendNow(prompt, prompt, []);
  };

  // 编辑器选区 → 在输入框光标处插入内联引用 token（CodeBuddy 式：引用长在句子里，可多段穿插）。
  // 发送时 composeMessage 就地把 @path:from-to 展开成代码块；文件未打开也接受，Agent 发送时自行 read_file
  const addChatRef = (path: string, from: number, to: number) => {
    const norm = path.replace(/\\/g, "/");
    const token = `@${norm}:${from}-${to}`;
    const el = document.getElementById("input") as HTMLTextAreaElement | null;
    if (el) {
      const s = el.selectionStart ?? el.value.length;
      const e = el.selectionEnd ?? s;
      const before = el.value.slice(0, s);
      const after = el.value.slice(e);
      const pad = before && !/\s$/.test(before) ? " " : "";
      setInput(`${before}${pad}${token} ${after}`);
      const pos = (before + pad + token + " ").length;
      setTimeout(() => {
        el.focus();
        el.setSelectionRange(pos, pos);
      }, 30);
    } else {
      setInput((prev) => (prev ? `${prev} ${token}` : token));
    }
    setChatHidden(false); // 引用在对话栏输入框里，收起时自动展开
  };

  const refreshFiles = () => {
    setFilesRefresh((n) => n + 1);
    sendCmd({ type: "GitStatus" });
    sendCmd({ type: "ListDir", path: "" });
  };
  // 工具卡片点击跳转：读→打开文件（offset 行），写→打开 diff
  const toolJump = (it: { tool: string; args?: string }) => {
    let a: Record<string, unknown> = {};
    try {
      a = it.args ? JSON.parse(it.args) : {};
    } catch {
      return;
    }
    const p = typeof a.path === "string" ? a.path : undefined;
    if (!p) return;
    if (it.tool === "read_file") openFile(p, typeof a.offset === "number" ? (a.offset as number) : undefined);
    else if (it.tool === "write_file" || it.tool === "edit_file") openDiff(p);
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
  // 项目列表：项目子面板打开时拉取；文件模式顶栏的当前项目名也依赖它
  useEffect(() => {
    if (sideTab === "files" || showProjects) window.myharness?.getProjects?.().then(setProjects).catch(() => {});
  }, [sideTab, showProjects]);

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
  // 文件模式 = 编辑器打开：对话栏是窄侧栏，头部/导航/compressor 用紧凑形态
  const fileMode = editorOpen;

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

  // 面板开关组（CodeBuddy 式三个 toggle）：左侧栏 / 终端 / 对话栏
  const panelToggles = (
    <>
      <button
        className={sidebarOpen ? "on" : ""}
        title={sidebarOpen ? "收起左侧边栏" : "展开左侧边栏"}
        onClick={() => setSidebarOpen((o) => !o)}
      >
        <Icon name="panel" size={14} />
      </button>
      <button
        className={termOpen ? "on" : ""}
        title={termOpen ? "收起终端" : "打开终端"}
        onClick={() => setTermOpen((o) => !o)}
      >
        <Icon name="panelBottom" size={14} />
      </button>
      <button
        className={chatHidden ? "" : "on"}
        title={chatHidden ? "展开对话栏" : "收起对话栏"}
        onClick={() => setChatHidden((o) => !o)}
      >
        <Icon name="panelRight" size={14} />
      </button>
    </>
  );
  // 顶栏（CodeBuddy 式）：按住可拖动窗口，右侧面板开关；更右边的最小化/关闭由系统 WCO 绘制。
  // 菜单栏依赖工作区视图的后置声明（toggleRail 等），构造放下面；设置页顶栏不带菜单。
  const titlebarWith = (menu: React.ReactNode, showToggles: boolean) => (
    <div className="titlebar">
      <span className="tb-title">Y Harness</span>
      {/* 模式切换（顶栏专属）：会话模式显示 </>（去代码模式），代码模式显示气泡（回会话模式）。
          与活动栏的会话/文件键分工：这里切模式，那里切侧栏内容 */}
      {view !== "settings" && (
        <button
          className="mode-switch"
          title={editorOpen ? "切换到会话模式" : "切换到代码模式"}
          onClick={() => (editorOpen ? toggleRail("sessions") : toggleRail("tree"))}
        >
          {/* 图标 = 点它将去往的模式：代码模式显示对话气泡（回会话），会话模式显示 </>（去代码） */}
          <Icon name={editorOpen ? "chat" : "code"} size={14} />
        </button>
      )}
      {menu}
      {/* 面板开关（左侧栏/终端/对话栏）是代码模式专属；对话模式/设置页 = ZCode 式干净顶栏（侧栏收起后有左缘浮出按钮可恢复） */}
      {showToggles && <div className="panel-toggles">{panelToggles}</div>}
    </div>
  );
  if (view === "settings") {
    const pages = { models: modelsPage, memory: memoryPage, mcp: mcpPage, skills: skillsPage, general: generalPage };
    return (
      <div className="root">
        {titlebarWith(null, false)}
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
      </div>
    );
  }

  // —— 工作区（聊天）视图 ——
  // 活动栏当前激活项：会话 / 代码下的三个子视图（与 VSCode 一致，点击已激活项收起侧栏）
  const railActive = sideTab === "sessions" ? "sessions" : codeMode;
  const toggleRail = (target: "sessions" | "tree" | "search" | "git") => {
    // 会话键 = 恒定进入对话模式（不是双向开关）：大对话窗口 + 左侧会话管理栏；回代码模式走资源管理器/搜索/源代码管理键
    if (target === "sessions") {
      setEditorOpen(false);
      setSideTab("sessions");
      setShowProjects(false);
      setSidebarOpen(true); // 会话管理栏（分组/列表）常显
      setChatHidden(false); // 对话模式下对话栏必须可见，否则主区空白
      return;
    }
    // 代码类视图：总是回到代码模式
    setEditorOpen(true);
    if (sidebarOpen && sideTab === "files" && codeMode === target) {
      setSidebarOpen(false);
      return;
    }
    setSideTab("files");
    setCodeMode(target);
    refreshFiles(); // 进代码面板即拉最新目录/git 状态
    setSidebarOpen(true);
  };

  // —— 顶栏菜单栏（VS Code 式）：全部接到既有动作，不新增协议命令 ——
  // 编辑器相关项经 wb-edit 事件桥进 EditorPane（workbench.tsx）；monaco action id 与右键菜单同一套。
  const edCmd = (action: string) => () => window.dispatchEvent(new CustomEvent("wb-edit", { detail: { action } }));
  const menuNewFile = () => {
    setEditorOpen(true);
    setSideTab("files");
    setCodeMode("tree");
    setSidebarOpen(true);
    // FileTree 刚挂载时事件监听还没挂上，等一帧再派发
    setTimeout(() => window.dispatchEvent(new CustomEvent("wb-newfile")), 60);
  };
  const cycleTab = (dir: 1 | -1) => {
    if (!openFiles.length) return;
    const idx = openFiles.findIndex((f) => f.path === activeTab.path);
    const next = ((idx < 0 ? 0 : idx + dir) + openFiles.length) % openFiles.length;
    setActiveTab({ kind: "file", path: openFiles[next].path });
  };
  const menus: { label: string; items: MenuEntry[] }[] = [
    {
      label: "文件",
      items: [
        { label: "新建文件", run: menuNewFile },
        { label: "打开文件夹…", hide: !window.myharness, run: () => void pickProject() },
        "sep",
        {
          label: "保存",
          accel: "Ctrl+S",
          disabled: !(activeTab.kind === "file" && activeTab.path),
          run: () => {
            if (activeTab.kind === "file" && activeTab.path) saveFile(activeTab.path);
          },
        },
        { label: "全部保存", disabled: !openFiles.some((f) => f.dirty), run: () => openFiles.filter((f) => f.dirty).forEach((f) => saveFile(f.path)) },
        { label: "关闭标签页", disabled: !activeTab.path, run: () => activeTab.path && closeTab(activeTab.kind, activeTab.path) },
        {
          label: "关闭全部标签页",
          disabled: !openFiles.length && !diffTabsRef.current.length,
          run: () => {
            diffTabsRef.current.slice().forEach((p) => closeTab("diff", p));
            openFiles.map((f) => f.path).forEach((p) => closeTab("file", p));
          },
        },
        "sep",
        { label: "设置", run: () => setView("settings") },
      ],
    },
    {
      label: "编辑",
      items: [
        { label: "撤销", accel: "Ctrl+Z", run: edCmd("undo") },
        { label: "重做", accel: "Ctrl+Y", run: edCmd("redo") },
        "sep",
        { label: "剪切", accel: "Ctrl+X", run: edCmd("editor.action.clipboardCutAction") },
        { label: "复制", accel: "Ctrl+C", run: edCmd("editor.action.clipboardCopyAction") },
        { label: "粘贴", accel: "Ctrl+V", run: edCmd("editor.action.clipboardPasteAction") },
        { label: "全选", accel: "Ctrl+A", run: edCmd("editor.action.selectAll") },
        "sep",
        { label: "查找", accel: "Ctrl+F", run: edCmd("actions.find") },
        { label: "替换", accel: "Ctrl+H", run: edCmd("editor.action.startFindReplaceAction") },
      ],
    },
    {
      label: "查看",
      items: [
        { label: "会话", checked: railActive === "sessions", run: () => toggleRail("sessions") },
        { label: "资源管理器", checked: railActive === "tree", run: () => toggleRail("tree") },
        { label: "搜索", checked: railActive === "search", run: () => toggleRail("search") },
        { label: "源代码管理", checked: railActive === "git", run: () => toggleRail("git") },
        "sep",
        { label: "最小地图", checked: minimapOn, run: toggleMinimap },
        { label: "自动换行", checked: wrapOn, run: toggleWrap },
        "sep",
        { label: "终端", accel: "Ctrl+`", checked: termOpen, run: () => setTermOpen((o) => !o) },
        {
          label: "Markdown 预览",
          accel: "Ctrl+Shift+V",
          hide: !(activeTab.kind === "file" && activeTab.path && /\.(md|markdown)$/i.test(activeTab.path)),
          run: edCmd("mdPreview"),
        },
      ],
    },
    {
      label: "转到",
      items: [
        { label: "转到行…", accel: "Ctrl+G", run: edCmd("editor.action.gotoLine") },
        { label: "转到定义", accel: "F12", run: edCmd("editor.action.revealDefinition") },
        { label: "下一个问题", accel: "F8", run: edCmd("nextDiag") },
        "sep",
        { label: "下一个标签页", accel: "Ctrl+PgDn", run: () => cycleTab(1) },
        { label: "上一个标签页", accel: "Ctrl+PgUp", run: () => cycleTab(-1) },
      ],
    },
    {
      label: "终端",
      items: [{ label: termOpen ? "关闭终端" : "新建终端", run: () => setTermOpen(true) }],
    },
    {
      label: "帮助",
      items: [
        {
          label: "关于 Y Harness",
          run: () => addItem({ kind: "notice", text: `Y Harness 桌面端 · daemon ${settings.server_version || "…"} · Monaco（VS Code 内核）· 本地优先` }),
        },
      ],
    },
  ];
  // 菜单（文件/编辑/查看/转到/终端/帮助）与面板开关是代码模式专属：对话模式 = ZCode 式纯对话界面
  const titlebar = titlebarWith(editorOpen ? <MenuBar menus={menus} /> : null, editorOpen);
  return (
    <div className="root">
      {titlebar}
      <div className="app">
      {/* 活动栏（会话/文件/搜索/Git 切换）是代码模式专属；会话模式 = 纯净大对话（模式切换走顶栏按钮） */}
      {editorOpen && (
      <div className="actbar">
        {/* 会话键已移除：回会话模式走顶栏模式切换按钮（气泡） */}
        <button title="资源管理器" className={railActive === "tree" ? "on" : ""} onClick={() => toggleRail("tree")}>
          <Icon name="folder" size={16} />
        </button>
        <button title="搜索" className={railActive === "search" ? "on" : ""} onClick={() => toggleRail("search")}>
          <Icon name="search" size={16} />
        </button>
        <button title="源代码管理" className={railActive === "git" ? "on" : ""} onClick={() => toggleRail("git")}>
          <Icon name="branch" size={16} />
          {gitScm.repo && gitScm.files.length > 0 && <b className="act-badge">{gitScm.files.length}</b>}
        </button>
        <div className="act-spacer" />
      </div>
      )}
      {sidebarOpen && (
      <aside>
        {sideTab === "sessions" && (
          <button className="newbtn" onClick={newSession} disabled={conn !== "open"}>＋ 新建会话</button>
        )}
        {sideTab === "files" && (
          <div
            className="proj-bar"
            title={(projects.current || "默认目录（daemon 启动目录）") + (window.myharness ? " · 点击选择其他目录" : "")}
            onClick={() => !switching && pickProject()}
          >
            <Icon name="folder" size={12} />
            <span className="proj-bar-name">
              {switching ? "切换中…" : projects.current ? projects.current.split(/[\\/]/).filter(Boolean).pop() : "打开目录…"}
            </span>
            <span className="proj-bar-act">{window.myharness ? "打开" : ""}</span>
          </div>
        )}
        <div className="aside-body">
        {sideTab === "sessions" && !showProjects && (
          <input
            id="sess-search"
            className="search"
            placeholder="搜索会话标题与内容…"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
          />
        )}
        {sideTab === "files" && (
          <FileTree
            mode={codeMode}
            listing={dirListing}
            activeFile={activeTab.kind === "file" ? activeTab.path : null}
            searchRes={searchRes}
            changed={runChanged}
            gitFiles={gitFiles}
            scm={gitScm}
            refreshTick={filesRefresh}
            onOpen={openFile}
            onDiff={openDiff}
            onRefresh={refreshFiles}
            onCollapse={() => setSidebarOpen(false)}
            onStage={(path) => sendCmd({ type: "GitStage", path })}
            onStageAll={() => sendCmd({ type: "GitStageAll" })}
            onUnstage={(path) => sendCmd({ type: "GitUnstage", path })}
            onCommit={(message, all, push) => sendCmd({ type: "GitCommit", message, all, push })}
            onPush={() => sendCmd({ type: "GitPush" })}
            onGenMsg={() => sendCmd({ type: "GitGenMsg" })}
          />
        )}
        {sideTab === "sessions" && (
          <div className="side-head">
            <h3>{showProjects ? "项目" : "会话"}</h3>
            {!showProjects && (
              <div className="seg mini">
                <button className={groupBy === "date" ? "on" : ""} onClick={() => setGroupBy("date")}>时间</button>
                <button className={groupBy === "group" ? "on" : ""} onClick={() => setGroupBy("group")}>分组</button>
              </div>
            )}
            <button
              className={"side-ic" + (showProjects ? " on" : "")}
              title="项目（切换工作区）"
              onClick={() => setShowProjects((s) => !s)}
            >
              <Icon name="folder" size={13} />
            </button>
          </div>
        )}
        {sideTab === "sessions" && showProjects && (
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
        {sideTab === "sessions" && !showProjects && groupBy === "group" && (
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
        {sideTab === "sessions" && !showProjects && searchQ.trim() && contentResults.length > 0 && (
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
          !showProjects &&
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
              className={"sess" + (s.session_id === sessionId ? " active" : "") + (dragSid === s.session_id ? " dragging" : "")}
              draggable={groupBy === "group"}
              onDragStart={(e) => {
                if ((e.target as HTMLElement).closest(".actions")) {
                  e.preventDefault();
                  return;
                }
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/session-id", s.session_id);
                setDragSid(s.session_id);
              }}
              onDragEnd={() => {
                setDragSid(null);
                setDropTarget(null);
              }}
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

          // 手动分组模式：卡片式分组，整卡都是放置区（含会话行与空组提示），
          // 未分组卡同样接收拖放，会话可拖回未分组
          if (groupBy === "group") {
            const grouped = filtered.filter((s) => s.group);
            const ungrouped = filtered.filter((s) => !s.group);
            const dropKey = (gname: string | null) => gname || "__ungrouped__";
            const move_to = (gname: string | null) => (e: React.DragEvent) => {
              e.preventDefault();
              const sid = e.dataTransfer.getData("text/session-id") || dragSid;
              if (sid) sendCmd({ type: "SetSessionGroup", session_id: sid, group: gname || "" });
              setDropTarget(null);
              setDragSid(null);
            };
            const groupBlock = (gname: string | null, groupItems: SessionInfo[]) => {
              const dk = dropKey(gname);
              const collapsed = !!collapsedGroups["group:" + dk];
              return (
                <div
                  key={dk}
                  className={
                    "sgroup" +
                    (gname ? "" : " ungrouped") +
                    (dropTarget === dk ? " drop" : "") +
                    (collapsed ? " collapsed" : "") +
                    (dragSid ? " drag-active" : "")
                  }
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDropTarget(dk);
                  }}
                  onDragLeave={(e) => {
                    // 只在真正离卡（relatedTarget 不在卡内）时取消高亮，避免子元素间抖动
                    if (!e.currentTarget.contains(e.relatedTarget as Node))
                      setDropTarget((t) => (t === dk ? null : t));
                  }}
                  onDrop={move_to(gname)}
                >
                  <div
                    className="sgroup-h"
                    onClick={() => setCollapsedGroups((c) => ({ ...c, ["group:" + dk]: !c["group:" + dk] }))}
                  >
                    <span className="gcaret">{collapsed ? "▸" : "▾"}</span>
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
                      <span className="gname">{gname || "未分组"}</span>
                    )}
                    <span className="gcnt">{groupItems.length}</span>
                    <span className="gact" onClick={(e) => e.stopPropagation()}>
                      {gname && (
                        <>
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
                        </>
                      )}
                    </span>
                  </div>
                  {!collapsed && (
                    <div className="sgroup-body">
                      {groupItems.length ? (
                        groupItems.map(sessionRow)
                      ) : (
                        <div className="drop-hint">
                          {dragSid ? `松开移动到「${gname || "未分组"}」` : gname ? "拖拽会话到这里" : "暂无会话"}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            };
            return (
              <>
                {provisionalRow}
                {sessionGroups.map((gname) =>
                  groupBlock(gname, grouped.filter((s) => s.group === gname))
                )}
                {groupBlock(null, ungrouped)}
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
        </div>{/* /aside-body */}
        <div className="aside-footer">
          <div className="avatar">本</div>
          <div className="acct">
            <div className="name">本地用户</div>
            <div className="sub">本地模式 · 账号体系开发中</div>
          </div>
          <button className="gear" title="设置" onClick={() => setView("settings")}>⚙</button>
        </div>
      </aside>
      )}
      <div className="ide">
        <div className={"ide-body" + (!editorOpen ? " chatmode" : "")}>
      {editorOpen && (
        <>
          <div className="editor-col">
            <EditorPane
              tabs={openFiles}
              diffTabs={diffTabsRef.current}
              active={activeTab}
              docs={fileDocs}
              conflict={conflict}
              diffData={diffStore.current}
              reveal={reveal}
              gitLabel={(pp) => gitFiles[pp] || ""}
              onActivate={(kind, path) => setActiveTab({ kind, path })}
              onClose={closeTab}
              onSave={saveFile}
              onText={() => {}}
              onDirty={(pp, dirty) =>
                setOpenFiles((prev) => prev.map((f) => (f.path === pp ? { ...f, dirty } : f)))
              }
              onAsk={askSelection}
              onAiAction={aiAction}
              onAddRef={addChatRef}
              onJump={openFile}
              onConflictReload={() => {
                if (conflict) {
                  pendingReload.current.add(conflict);
                  sendCmd({ type: "ReadFile", path: conflict });
                }
                setConflict(null);
              }}
              onConflictKeep={() => setConflict(null)}
              onBrowse={() => {
                setSideTab("files");
                setCodeMode("tree");
                setSidebarOpen(true);
              }}
              minimap={minimapOn}
              wordWrap={wrapOn}
            />
            {termOpen && <TerminalPanel onClose={() => setTermOpen(false)} />}
          </div>
          <div
            className="col-splitter"
            onMouseDown={(e) => {
              chatDrag.current = { startX: e.clientX, startW: chatW };
              e.preventDefault();
            }}
            onDoubleClick={() => setChatW(400)}
            title="拖拽调对话栏宽 · 双击复位"
          />
        </>
      )}
      <div
        className={"main chat-col" + (!editorOpen ? " chat-wide" : "")}
        style={
          editorOpen && chatHidden
            ? { display: "none" } // 收起对话栏：编辑器占满主区，右缘浮出 « 重开按钮
            : editorOpen
              ? { width: chatW, minWidth: 370, flex: "none" }
              : { flex: 1 }
        }
      >
        <header>
          <span className={"dot " + dot} />
          <span className="title topic" title={currentTitle}>{currentTitle}</span>
          {/* 上下文圆环/连接信息已并入输入框上方用量条（两种模式统一），头部只留标题 */}
          {/* 头部按钮是代码模式专属（新建/历史/搜索三键）；对话模式管理入口都在左侧会话栏，头部保持干净 */}
          {fileMode && (
            <>
              <button className="head-ic" title="新建会话" onClick={newSession}>
                <Icon name="plus" size={14} />
              </button>
              <button
                className="head-ic"
                title="会话历史（打开会话列表）"
                onClick={() => {
                  setSideTab("sessions");
                  setShowProjects(false);
                  setSidebarOpen(true);
                }}
              >
                <Icon name="history" size={14} />
              </button>
              <button
                className="head-ic"
                title="搜索会话（标题与内容）"
                onClick={() => {
                  setSideTab("sessions");
                  setShowProjects(false);
                  setSidebarOpen(true);
                  setSessSearchFocus((n) => n + 1);
                }}
              >
                <Icon name="search" size={14} />
              </button>
            </>
          )}
        </header>
        {/* 详情卡从用量条向上弹（触发点在输入框上方，两种模式统一） */}
        {ctxOpen && ctxInfo && ctxInfo.window > 0 && (
          <div className="ctx-pop up" ref={ctxPopRef}>
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
        {!fileMode && outlineItems.length > 1 && (
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
        {!fileMode && outlineTip && (
          <div className="outline-tip" style={{ top: outlineTip.top }}>{outlineTip.text}</div>
        )}
        <div id="msgs" ref={listRef} className={outlineItems.length > 1 ? "with-nav" : ""} onClick={onChatClick}>
          {items.map((it) => {
            if (it.kind === "think") {
              return <ThinkRow key={it.id} it={it} />;
            }
            if (it.kind === "tool") {
              const m = it.meta;
              const jumpable = ["read_file", "write_file", "edit_file"].includes(it.tool);
              const live = it.status === "running" || it.status === "streaming";
              const secs = live && it.startedAt ? Math.floor((Date.now() - it.startedAt) / 1000) : null;
              const outLine = it.output ? it.output.trimEnd().split("\n").pop() || "" : "";
              const preview = it.status === "streaming" && it.argsRaw ? it.argsRaw.slice(-140) : "";
              return (
                <div
                  key={it.id}
                  onClick={jumpable ? () => toolJump(it) : undefined}
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
                            : "") + (jumpable ? " jump" : "")
                  }
                  title={(it.args || it.argsRaw || it.tool) + (jumpable ? "\n点击在工作台打开" : "") + (it.status === "fail" && it.detail ? `\n——\n${it.detail}` : "")}
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
              const refs = it.refs ?? parseChatRefs(it.text);
              const shown = stripRefBlocks(it.text);
              return (
                <div key={it.id} className="msg user" data-mid={it.id}>
                  <div className="bubble">
                    {refs.length > 0 && (
                      <div className="atchips">
                        {refs.map((r, i) => (
                          <span
                            key={i}
                            className="chip refchip"
                            title={`${r.path}:${r.from}-${r.to}（已随消息发给模型），点击跳转`}
                            onClick={() => openFile(r.path, r.from)}
                          >
                            <Icon name="file" size={11} /> {r.path.split(/[\\/]/).pop()}:{r.from}-{r.to}
                          </span>
                        ))}
                      </div>
                    )}
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
                    {shown}
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
                  <div className="md" dangerouslySetInnerHTML={{ __html: linkifyLineRefs(mdRender(it.text)) }} />
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
        {runChanged.length > 0 && (
          <div className="runbar">
            <span className="runbar-label">本次任务改动 {runChanged.length} 个文件</span>
            {runChanged.map((p) => (
              <button key={p} className="runbar-chip" title={`查看改动：${p}`} onClick={() => openDiff(p)}>
                {p.split(/[\\/]/).pop()}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <button className="runbar-clear" title="收起" onClick={() => setRunChanged([])}>
              <Icon name="x" size={11} />
            </button>
          </div>
        )}
        {/* 用量条：上下文圆环 + 运行中实时刷新 + 最近一次对话 + 会话累计，两种模式统一在输入框上方（头部不再显示） */}
        {(() => {
          const ctxValid = !!ctxInfo && ctxInfo.window > 0 && ctxInfo.tokens > 0;
          if (!(running || lastRun || sessCost || ctxValid)) return null;
          const pct = ctxValid ? Math.min(100, (ctxInfo!.tokens / ctxInfo!.window) * 100) : 0;
          const color = pct >= 85 ? "#f85149" : pct >= 70 ? "#e3b341" : "#4493f8";
          const r = 6, c = 2 * Math.PI * r;
          return (
            <div className="usage-strip">
              {ctxValid && (
                <button
                  className={"ctx-chip ctx-mini" + (ctxOpen ? " on" : "")}
                  title="上下文容量"
                  onClick={() => setCtxOpen((o) => !o)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" style={{ display: "block" }}>
                    <circle cx="8" cy="8" r={r} fill="none" stroke="#30363d" strokeWidth="2.5" />
                    <circle
                      cx="8" cy="8" r={r} fill="none" stroke={color} strokeWidth="2.5"
                      strokeDasharray={`${(pct / 100) * c} ${c}`} strokeLinecap="round"
                      transform="rotate(-90 8 8)"
                    />
                  </svg>
                  {Math.round(pct)}%
                </button>
              )}
              {running ? (
                <span className="us-live" title="本次对话进行中">
                  <Icon name="refresh" size={11} /> {fmtClock(elapsed)} · ↑{fmtTok(runUsage?.input_tokens || 0)} ↓{fmtTok(runUsage?.output_tokens || 0)} tok
                </span>
              ) : lastRun ? (
                <span title="最近一次对话">
                  最近 <Icon name="history" size={11} /> {fmtClock((lastRun.duration_ms || 0) / 1000)}
                  {lastRun.usage ? ` · ↑${fmtTok(lastRun.usage.input_tokens)} ↓${fmtTok(lastRun.usage.output_tokens)} tok` : ""}
                </span>
              ) : null}
              {/* 「会话累计」已去掉：与实时/最近统计数字重复（用户要求） */}
              {sessCost?.cost_usd != null && <span>{fmtCost(sessCost.cost_usd)}</span>}
            </div>
          );
        })()}
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
          <div className="input-stack">
            <div className="input-mirror" ref={mirrorRef} aria-hidden dangerouslySetInnerHTML={{ __html: mirrorHtml(input) }} />
            <textarea
              id="input"
              ref={inputRef}
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
              onScroll={(e) => {
                const m = mirrorRef.current;
                if (m) m.scrollTop = e.currentTarget.scrollTop;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              disabled={conn !== "open"}
            />
          </div>
          <div className={"controls" + (fileMode ? " compact" : "")}>
            <button className="ctl" title="添加工作区文件为附件" onClick={() => setShowAttach((s) => !s)}>＋</button>
            <div className="pdrop" ref={permDropRef}>
              <button
                className={"ctl pchip" + (permMode === "bypass" ? " hot" : "") + (fileMode ? " iconly" : "")}
                title={`权限模式：${(PERM_META[permMode] || PERM_META.default).label} · ${(PERM_META[permMode] || PERM_META.default).desc}`}
                onClick={() => setPermOpen((s) => !s)}
              >
                <Icon name={(PERM_META[permMode] || PERM_META.default).icon} size={fileMode ? 14 : 12} />
                {!fileMode && (PERM_META[permMode] || PERM_META.default).label}
                {!fileMode && <Icon name="chev" size={11} />}
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
      {!editorOpen && termOpen && <TerminalPanel onClose={() => setTermOpen(false)} />}
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
              Y Harness 不绑定任何厂商：填任意 OpenAI 兼容端点即可开始。
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
      </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
