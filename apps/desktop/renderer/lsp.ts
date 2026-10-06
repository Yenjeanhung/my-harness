// 渲染层 LSP 接线（IDE-DESIGN.md M6）：monaco 0.57 内置 LSP 客户端（monaco.lsp.MonacoLspClient）
// 承担补全/悬停/签名/诊断推送/格式化/重命名/代码操作等全部功能；这里只做两件事——
// 1. 传输桥：JSON-RPC 消息装进 daemon 协议（LspStart/LspToServer/LspFromServer/LspStatus，
//    daemon 侧是哑管道，转发到语言服务器子进程，见 src/harness/server/lsp.py）；
// 2. 跳转定义：内置客户端要求目标文件已有 monaco model（未打开的文件直接失败），
//    所以 python 的 definition 由这里自己发请求、配合 editor opener（app.tsx 注册）走
//    App.openFile 打开未打开的文件——「VS Code 式跳转」的关键一块。
import { monaco, fileUri, lspLanguageFor, relPathOfWorkspaceUri } from "./monaco";
import { sendCmd } from "./ws";

interface LspEntry {
  status: "idle" | "starting" | "running" | "error";
  detail?: string;
  rootUri?: string;
  client?: { dispose(): void } | null;
  listener?: ((m: unknown) => void) | null;
  failedAt?: number;
  nextId: number;
  pending: Map<number, (result: unknown) => void>;
}

const RETRY_MS = 20_000; // 启动失败（比如没装 pyright）后的冷却时间，防抖动重试
const clients = new Map<string, LspEntry>();
// 直发请求的 id 从高位起步：内置 MonacoLspClient 自己的请求也从 1 开始编号，
// 两边共用同一条 stdin/stdout 管道——低位 id 会和它的请求撞车，响应被错误配对
// （定义请求拿到的是 initialize 的 capabilities，解析不出位置，Ctrl+点击静默失效的根因）
const DIRECT_ID_BASE = 1_000_000;

export function isLspRunning(language: string): boolean {
  return clients.get(language)?.status === "running";
}

export type LspStateInfo = { language: string; status: string; detail?: string };
type StatusListener = (state: LspStateInfo) => void;
const listeners = new Set<StatusListener>();
export function onLspStatus(fn: StatusListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setEntry(language: string, patch: Partial<LspEntry>) {
  const cur: LspEntry = clients.get(language) || { status: "idle", nextId: 1, pending: new Map() };
  const next = { ...cur, ...patch };
  clients.set(language, next);
  for (const l of listeners) l({ language, status: next.status, detail: next.detail });
}

// 打开未打开文件（编辑器 tab + 跳行）——由 app.tsx 注入（openFile）
let openHandler: ((relPath: string, line?: number) => void) | null = null;
export function setOpenHandler(fn: (relPath: string, line?: number) => void) {
  openHandler = fn;
}

let openerRegistered = false;
function registerOpener() {
  if (openerRegistered) return;
  openerRegistered = true;
  // 「跳到未打开文件」的统一出口：definition provider 给出 file:// URI + 行号，这里转成 openFile
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selection) {
      const rel = relPathOf(resource);
      if (rel == null) return false;
      const line = selection && "startLineNumber" in selection ? selection.startLineNumber : (selection as { lineNumber?: number } | undefined)?.lineNumber;
      openHandler?.(rel, line && line > 0 ? line : undefined);
      return true;
    },
  });
}

// file://（工作区内）或 yharness-file://（无根退化态）→ 工作区相对路径
function relPathOf(uri: monaco.Uri): string | null {
  if (uri.scheme === "yharness-file") return decodeURIComponent(uri.path).replace(/^\/+/, "");
  if (uri.scheme === "file") {
    // Windows：monaco Uri.path 形如 /D:/dir/...；与 daemon 报的根做大小写不敏感匹配
    const path = decodeURIComponent(uri.path).replace(/^\/+/, "");
    for (const c of clients.values()) {
      const root = (c.rootUri || "").replace(/^file:\/\/\//, "").replace(/\/$/, "");
      if (root && path.toLowerCase().startsWith(root.toLowerCase() + "/")) return path.slice(root.length + 1);
    }
    // LSP 没跑（无客户端 rootUri，跳转定义兜底场景）：按 monaco 工作区根换算
    return relPathOfWorkspaceUri(uri);
  }
  return null;
}

export function ensureStartedForPath(path: string) {
  registerOpener();
  const language = lspLanguageFor(path);
  if (!language) return;
  const c = clients.get(language);
  if (c) {
    if (c.status === "error" && Date.now() - (c.failedAt || 0) > RETRY_MS) clients.delete(language);
    else return;
  }
  setEntry(language, { status: "starting", detail: undefined });
  sendCmd({ type: "LspStart", language });
}

// daemon 事件（app.tsx 的 WsEvent 分发转进来）
export function handleDaemonEvent(e: { type: string; language?: string; status?: string; detail?: string; root_uri?: string; message?: unknown }) {
  if (e.type === "LspStatus") {
    const language = e.language || "";
    if (e.status === "running") {
      if (clients.get(language)?.client) return; // 已连接（重复事件）
      setEntry(language, { status: "running", rootUri: e.root_uri, detail: e.detail || undefined });
      connect(language);
    } else if (e.status === "error") {
      setEntry(language, { status: "error", detail: e.detail || "启动失败", failedAt: Date.now(), client: null, listener: null });
    } else if (e.status === "stopped") {
      setEntry(language, { status: "idle", client: null, listener: null, detail: e.detail || undefined, nextId: 1, pending: new Map() });
    }
  } else if (e.type === "LspFromServer" && e.language) {
    const c = clients.get(e.language);
    if (!c) return;
    const msg = e.message as { id?: number | string; result?: unknown; error?: unknown; method?: string };
    routeJsonRpcMessage(e.language, msg); // 自己直发的请求（如跳转定义）先配对
    c.listener?.(msg); // 其余（server 请求/通知/内置客户端自己的请求响应）喂给内置客户端
  }
}

// —— daemon 桥 transport：满足 monaco 内置客户端的 IMessageTransport 结构 ——
// send → LspToServer；收件由 handleDaemonEvent 喂回 setListener 注册的回调
function makeTransport(language: string) {
  const entry = clients.get(language)!;
  return {
    get state() {
      return {
        value: { state: entry.status === "running" ? ("open" as const) : ("closed" as const), error: undefined },
        onChange: (_cb: unknown) => ({ dispose: () => {} }),
      };
    },
    async send(message: unknown) {
      sendCmd({ type: "LspToServer", language, message });
    },
    setListener(fn: ((m: unknown) => void) | null) {
      entry.listener = fn ?? null;
    },
    toString() {
      return `yharness-daemon-bridge(${language})`;
    },
  };
}

function connect(language: string) {
  const entry = clients.get(language);
  if (!entry || entry.client) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = (monaco.lsp as any).MonacoLspClient;
    entry.client = new Ctor(makeTransport(language));
  } catch (err) {
    setEntry(language, { status: "error", detail: String(err), failedAt: Date.now(), client: null });
  }
}

// 直发一个 LSP 请求（绕过内置客户端的 provider——它们的返回值必须已有 model 才能翻译回来），
// 结果原样给调用方（位置换算/打开跳转由调用方自己做）。
// 超时 8s：语言服务器冷启动/首次索引时（pyright 首个请求要等工程加载）3s 会误判超时。
function request(language: string, method: string, params: unknown): Promise<unknown> {
  const entry = clients.get(language);
  if (!entry || entry.status !== "running") return Promise.resolve(null);
  const id = DIRECT_ID_BASE + entry.nextId++;
  return new Promise((resolve) => {
    entry.pending.set(id, resolve);
    sendCmd({ type: "LspToServer", language, message: { jsonrpc: "2.0", id, method, params } });
    setTimeout(() => {
      if (entry.pending.delete(id)) resolve(null); // 超时放弃（不标错不卡 UI）
    }, 8000);
  });
}

// —— python 直连 LSP 请求 ——
// 定义/声明/类型定义/实现/引用都自己发请求：返回的 Location 转成 monaco 位置，
// 未打开的目标文件经 registerEditorOpener 走 App.openFile——「VS Code 式跳转」不要求目标已开。

interface RawLocation {
  uri?: string;
  range?: { start: { line: number; character: number } };
  targetUri?: string;
  targetSelectionRange?: { start: { line: number; character: number } };
}

// LSP Location/LocationLink（单/多）→ 相对路径位置列表（给自定义引用面板用）
export interface RefLocation {
  path: string;
  line: number;
  col: number;
}

function locationsToRefs(locs: RawLocation[]): RefLocation[] {
  const out: RefLocation[] = [];
  for (const loc of locs) {
    const uriStr = loc.uri || loc.targetUri || "";
    if (!uriStr) continue;
    const range = loc.range || loc.targetSelectionRange || { start: { line: 0, character: 0 } };
    const rel = relPathOf(monaco.Uri.parse(uriStr));
    if (rel == null) continue;
    out.push({ path: rel, line: range.start.line + 1, col: range.start.character + 1 });
  }
  return out;
}

// 直发 method 请求并归一化为 RefLocation[]（LSP 未跑/超时/空结果 → []）
export async function requestLocations(
  language: string,
  method: string,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  opts?: { includeDeclaration?: boolean }
): Promise<RefLocation[]> {
  const word = model.getWordAtPosition(position);
  if (!word) return [];
  const result = (await request(language, method, {
    textDocument: { uri: model.uri.toString(true) },
    position: {
      line: position.lineNumber - 1,
      // 点击点可能落在词的后半段；pyright/pylsp 对符号内任意字符都应答，clamp 进词内防越界
      character: Math.min(position.column, word.endColumn) - 1,
    },
    ...(opts?.includeDeclaration != null ? { context: { includeDeclaration: opts.includeDeclaration } } : {}),
  })) as RawLocation | RawLocation[] | null | undefined;
  if (!result) return [];
  return locationsToRefs(Array.isArray(result) ? result : [result]);
}

type LocationProvideName =
  | "provideDefinition"
  | "provideDeclaration"
  | "provideTypeDefinition"
  | "provideImplementation"
  | "provideReferences";

function registerLspLocationProvider(
  method: string,
  register: (lang: string, provider: never) => monaco.IDisposable,
  provide: LocationProvideName
) {
  const handler = async (
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    context?: { includeDeclaration?: boolean }
  ) => {
    const entry = clients.get("python");
    if (entry?.status !== "running") return null; // 未跑 LSP：workbench.tsx 里的 GotoDef 兜底应答（定义）
    const refs = await requestLocations("python", method, model, position, context);
    if (!refs.length) return null;
    return refs.map((r) => ({
      uri: fileUri(r.path),
      range: new monaco.Range(r.line, r.col, r.line, r.col),
    }));
  };
  register("python", { [provide]: handler } as never);
}

registerLspLocationProvider("textDocument/definition", monaco.languages.registerDefinitionProvider, "provideDefinition");
registerLspLocationProvider("textDocument/declaration", monaco.languages.registerDeclarationProvider, "provideDeclaration");
registerLspLocationProvider("textDocument/typeDefinition", monaco.languages.registerTypeDefinitionProvider, "provideTypeDefinition");
registerLspLocationProvider("textDocument/implementation", monaco.languages.registerImplementationProvider, "provideImplementation");
registerLspLocationProvider("textDocument/references", monaco.languages.registerReferenceProvider, "provideReferences");

// 响应分发：jsonrpc response id → request() 的 resolve（server 主动请求/通知走内置客户端的 listener）
export function routeJsonRpcMessage(language: string, message: { id?: number | string; result?: unknown; error?: unknown; method?: string }) {
  const entry = clients.get(language);
  if (!entry) return;
  if (message.id != null && (message.result !== undefined || message.error !== undefined) && !message.method) {
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const resolve = entry.pending.get(id);
    if (resolve) {
      entry.pending.delete(id);
      resolve(message.result);
    }
  }
}
