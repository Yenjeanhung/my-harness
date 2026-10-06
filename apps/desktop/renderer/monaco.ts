// Monaco 编辑器内核（IDE-DESIGN.md M6：CodeMirror 6 → Monaco/VS Code 内核）。
// 这里集中管三件事：worker 加载、主题、文件 → model 注册表（URI = file://<workspaceRoot>/<relPath>，
// 语言服务器按 URI 匹配工作区文件，built-in LSP 客户端据此自动同步 didOpen/didChange）。
// 注意 monaco 0.57 的 exports 映射：深层导入不带 esm/vs 前缀（"monaco-editor/editor/..."）；
// TS 语言服务 API 挂在 monaco.typescript 命名空间（旧的 languages.typescript 已弃用）。
import * as monaco from "monaco-editor";

export { monaco };

// —— worker：esbuild 把每个 worker 打成单文件（renderer/monaco-*.worker.js），
// 按.monaco 的 label 分发；必须在语言服务首次用到前装好 ——
const WORKER_FILES: Record<string, string> = {
  typescript: "monaco-ts.worker.js",
  javascript: "monaco-ts.worker.js",
  json: "monaco-json.worker.js",
  css: "monaco-css.worker.js",
  scss: "monaco-css.worker.js",
  less: "monaco-css.worker.js",
  html: "monaco-html.worker.js",
  handlebars: "monaco-html.worker.js",
  razor: "monaco-html.worker.js",
};

self.MonacoEnvironment = {
  getWorker(_moduleId: unknown, label: string) {
    const file = WORKER_FILES[label] || "monaco-editor.worker.js";
    return new Worker(new URL(file, document.baseURI).href, { name: `monaco-${label}` });
  },
};

// —— 主题：沿用原 CodeMirror 观感（#0d1017 底、Consolas、GitHub 暗色系）——
monaco.editor.defineTheme("yharness-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "8b949e", fontStyle: "italic" },
    { token: "keyword", foreground: "ff7b72" },
    { token: "string", foreground: "a5d6ff" },
    { token: "number", foreground: "79c0ff" },
    { token: "type", foreground: "ffa657" },
    { token: "function", foreground: "d2a8ff" },
    { token: "variable", foreground: "d7dae0" },
  ],
  colors: {
    "editor.background": "#0d1017",
    "editor.foreground": "#d7dae0",
    "editorLineNumber.foreground": "#484f58",
    "editorLineNumber.activeForeground": "#8b949e",
    "editor.lineHighlightBackground": "#161b2288",
    "editor.selectionBackground": "#264f78",
    "editorInactiveSelection": "#3a4d63",
    "editorGutter.background": "#0d1017",
    "editorWidget.background": "#161921",
    "editorWidget.border": "#30363d",
    "editorSuggestWidget.background": "#161921",
    "editorSuggestWidget.selectedBackground": "#1f2733",
    "editorHoverWidget.background": "#161921",
    "editorOverviewRuler.border": "#262a33",
    "minimap.background": "#0d1017",
    "scrollbarSlider.background": "#2f374080",
    "scrollbarSlider.hoverBackground": "#444d56aa",
    // 右键菜单（不定义这些 token 时 menu.background 为透明，菜单底下会透出编辑器文字）
    "menu.background": "#161921",
    "menu.foreground": "#d7dae0",
    "menu.border": "#30363d",
    "menu.separatorBackground": "#30363d",
    "menu.selectionBackground": "#1f2733",
    "menu.selectionForeground": "#ffffff",
    "menubar.selectionBackground": "#1f2733",
    "list.hoverBackground": "#1f2733",
    "list.activeSelectionBackground": "#1f2733",
    "list.focusBackground": "#1f2733",
  },
});

// TS/JS：浏览器内 tsserver（monaco 内嵌），按打开的 model 做跨文件补全。
// JSX/允许 js/宽松 resolve——工作台定位是「能看懂大多数项目」，不做完整 tsconfig 解析。
// 诊断屏蔽模块解析类错误码（浏览器里没有 node_modules/@types，Node/Electron 项目的
// import "electron"、process 等必然报错，全是噪音）——保留真正的类型/语法错误。
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    module: monaco.typescript.ModuleKind.ESNext,
    jsx: monaco.typescript.JsxEmit.React,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    skipLibCheck: true,
  });
  defaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [2307, 2792, 2304, 2580, 2584, 7016],
  });
  defaults.setEagerModelSync(true);
}

// —— 工作区根（绝对路径）：daemon /health 的 workspace，LSP 事件也会带 ——
let workspaceRoot: string | null = null;
let workspaceRootUri: monaco.Uri | null = null;

export function setWorkspaceRoot(absDir: string | null | undefined) {
  if (!absDir || workspaceRoot) return; // 只认第一个（会话中途切项目会整页重载）
  workspaceRoot = absDir.replace(/[\\/]+$/, "");
  workspaceRootUri = monaco.Uri.file(workspaceRoot);
}

// 相对路径 → file:// URI（无根时退化为私有 scheme，纯浏览器调试也能用）
export function fileUri(relPath: string): monaco.Uri {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (workspaceRootUri) return workspaceRootUri.with({ path: `${workspaceRootUri.path}/${rel}` });
  return monaco.Uri.parse(`yharness-file:///${rel}`);
}

// file:// URI（绝对路径）→ 工作区相对路径；不在工作区内返回 null。
// LSP 没跑时 lsp.ts 的 relPathOf 没有客户端 rootUri 可用，靠这里兜底换算（跳转定义依赖）。
export function relPathOfWorkspaceUri(uri: monaco.Uri): string | null {
  if (!workspaceRoot || uri.scheme !== "file") return null;
  const p = decodeURIComponent(uri.path).replace(/^\/+/, "");
  const root = `${workspaceRoot.replace(/\\/g, "/")}/`;
  return p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length) : null;
}

// —— model 注册表：每个打开的文件一个 model，切 tab 复用（VS Code 同构）——
const models = new Map<string, monaco.editor.ITextModel>();

export function langIdFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (["ts", "mts", "cts"].includes(ext)) return "typescript";
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return "javascript";
  if (ext === "json") return "json";
  if (["css"].includes(ext)) return "css";
  if (["scss"].includes(ext)) return "scss";
  if (["less"].includes(ext)) return "less";
  if (["html", "htm"].includes(ext)) return "html";
  if (["py", "pyw"].includes(ext)) return "python";
  if (["md", "markdown"].includes(ext)) return "markdown";
  if (["yaml", "yml"].includes(ext)) return "yaml";
  if (["sh", "bash", "bat", "cmd"].includes(ext)) return "shell";
  if (["go"].includes(ext)) return "go";
  if (["rs"].includes(ext)) return "rust";
  if (["java"].includes(ext)) return "java";
  if (["c", "h"].includes(ext)) return "c";
  if (["cpp", "hpp", "cc", "hh"].includes(ext)) return "cpp";
  if (["toml", "ini", "cfg"].includes(ext)) return "ini";
  if (["xml", "svg"].includes(ext)) return "xml";
  if (["sql"].includes(ext)) return "sql";
  if (["rb"].includes(ext)) return "ruby";
  if (["php"].includes(ext)) return "php";
  return "plaintext";
}

// 取/建文件的 model；text 为磁盘基线。语言服务器（built-in LSP 客户端）监听 model 生命周期自动同步。
export function modelFor(path: string, text: string): monaco.editor.ITextModel {
  let m = models.get(path);
  if (m && !m.isDisposed()) return m;
  m = monaco.editor.createModel(text, langIdFor(path), fileUri(path));
  models.set(path, m);
  m.onWillDispose(() => models.delete(path));
  return m;
}

export function getModel(path: string): monaco.editor.ITextModel | null {
  const m = models.get(path);
  return m && !m.isDisposed() ? m : null;
}

// 文件的所有编辑器都关闭时释放 model（VS Code 同语义：无编辑器持有的文本模型即释放，脏缓冲由调用方负责先行判断）。
// 注意：须先移除注册表条目再 dispose——onWillDispose 里也有一份删除，先 dispose 会拿不到 key。
export function disposeFileModel(path: string) {
  const m = models.get(path);
  if (!m) return;
  models.delete(path);
  m.dispose();
}

// 语言服务按扩展名归类（LSP 自动启动判断用）：目前只有 python 走 daemon 桥，
// TS/JS/JSON/CSS/HTML 用 monaco 内嵌服务，无需外部服务器。
export function lspLanguageFor(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (["py", "pyw"].includes(ext)) return "python";
  return null;
}

// —— 诊断汇总：daemon lint / built-in LSP / monaco 内建校验都汇进 marker 服务，
// 报错总览条与 F8 跳转只读这一个源 ——
export interface RulerDiag {
  line: number;
  endLine: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export function markersOf(uri: monaco.Uri): RulerDiag[] {
  return monaco.editor
    .getModelMarkers({ resource: uri })
    .sort((a, b) => a.startLineNumber - b.startLineNumber)
    .map((m) => ({
      line: m.startLineNumber,
      endLine: m.endLineNumber,
      severity: m.severity >= monaco.MarkerSeverity.Error ? "error" : m.severity >= monaco.MarkerSeverity.Warning ? "warning" : "info",
      message: m.message,
    }));
}

// 编辑器通用选项（主编辑器 / diff 共用观感）
export const baseEditorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: "yharness-dark",
  automaticLayout: true, // 宿主 display:none 切换 / 分栏拖拽后自动重测，替代 CM 时代的 requestMeasure 自愈
  fontSize: 13,
  lineHeight: 20,
  fontFamily: "Consolas, 'Cascadia Mono', monospace",
  minimap: { enabled: true, renderCharacters: false },
  scrollBeyondLastLine: true,
  smoothScrolling: true,
  cursorBlinking: "smooth",
  renderWhitespace: "selection",
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: true },
  padding: { top: 6 },
  stickyScroll: { enabled: true },
};
