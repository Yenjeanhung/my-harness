// UI 事件协议类型（与 PROTOCOL.md 对应）：服务端 → 渲染进程的 WsEvent、渲染进程 → 服务端的 WsCommand。
// Python 侧改协议时同步改这里，所有消息收发点由编译器保证字段一致。

// 权限模式 / 思考档位（协议枚举值，与内核一致）
export type PermMode = "plan" | "default" | "acceptEdits" | "dontAsk" | "bypass";
export type ThinkLevel = "off" | "low" | "high" | "max";

export interface Img {
  media_type: string;
  data: string; // base64
}

// —— 共享数据结构 ——

export interface SessionInfo {
  session_id: string;
  title?: string;
  last_active: string;
  events: number;
  pinned?: boolean;
  group?: string;
}

export interface ContentResult {
  session_id: string;
  title?: string;
  snippet: string;
}

export interface ModelEntry {
  model: string;
  api_base?: string;
  has_key: boolean;
  active: boolean;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface SettingsState {
  model: string;
  has_api_key: boolean;
  api_base?: string;
  server_version?: string;
  permission_mode?: PermMode;
  thinking?: ThinkLevel;
  models: ModelEntry[];
}

export interface SessionCostData {
  session_id: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number | null;
}

export interface StatsState {
  sessions: number;
  messages: number;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd?: number | null;
  db_bytes: number;
  data_dir?: string;
}

export interface MemBlock {
  label: string;
  chars: number;
  limit: number;
  value?: string;
}

export interface MemFile {
  path: string;
  size: number;
}

export interface McpServerInfo {
  name: string;
  status: string;
  transport: string;
  source: string;
  target: string;
  tools: number;
}

export interface SkillInfo {
  name: string;
  description?: string;
  source?: string;
}

export interface PermissionRequest {
  request_id: string;
  tool: string;
  reason: string;
}

export interface ModelTestResult {
  status: "ok" | "fail" | "error";
  ok: boolean;
  model?: string;
  latency_ms?: number;
  reply?: string;
  error?: string;
}

// 历史回放条目（History 事件），kind 与服务端事件库一致
export interface HistoryEntry {
  kind: string;
  text?: string;
  tool?: string;
  args?: unknown;
  images?: Img[];
  seq?: number;
}

// —— 服务端 → 渲染进程 ——

export type WsEvent =
  | { type: "SessionCreated"; session_id: string; mode?: PermMode }
  | { type: "SessionResumed"; session_id: string }
  | { type: "SessionList"; sessions?: SessionInfo[]; groups?: string[] }
  | { type: "History"; items?: HistoryEntry[] }
  | { type: "ContentSearchResult"; results?: ContentResult[] }
  | ({ type: "Settings" } & SettingsState)
  | { type: "ModelSet"; model: string; has_api_key: boolean; models?: ModelEntry[] }
  | ({ type: "ModelTestResult" } & ModelTestResult)
  | ({ type: "SessionCost" } & SessionCostData)
  | ({ type: "Stats" } & StatsState)
  | { type: "MemoryList"; blocks?: MemBlock[]; files?: MemFile[] }
  | { type: "MemoryFileContent"; path: string; content: string }
  | { type: "McpList"; servers?: McpServerInfo[] }
  | { type: "SkillList"; skills?: SkillInfo[] }
  | { type: "ImageSaved"; path: string; media_type: string; data: string }
  | { type: "WorkspaceFile"; path: string; content: string; truncated?: boolean }
  | { type: "LintResult"; path: string; req?: number; diagnostics: { line: number; col: number; end_line: number; end_col: number; message: string; severity: "error" | "warning" | "info" }[] }
  | { type: "GotoDefResult"; req?: number; name: string; file: string | null; line: number | null }
  | { type: "RunStarted" }
  | { type: "ReasoningDelta"; text: string }
  | { type: "TokenDelta"; text: string }
  | { type: "ToolCallArgs"; call_id: string; tool: string; args_text: string }
  | { type: "ToolCallStarted"; call_id?: string; tool: string; args?: unknown }
  | { type: "ToolCallOutput"; call_id: string; tool: string; text: string }
  | {
      type: "Usage";
      session_id?: string;
      input_tokens: number;
      output_tokens: number;
      context_tokens?: number; // 当前上下文规模（最后一轮 input tokens）
      context_window?: number; // 上下文窗口上限
      static_tokens?: number; // 静态前缀估算（系统提示词+工具 schema）
    }
  | {
      type: "ContextInfo";
      session_id?: string;
      context_tokens: number;
      context_window: number;
      static_tokens: number;
    }
  // —— 工作台（IDE）——
  | { type: "DirListing"; path: string; entries: { name: string; kind: "file" | "dir"; size: number; mtime: number }[] }
  | { type: "FileContent"; path: string; content: string; binary: boolean; truncated: boolean; size: number }
  | { type: "FileSaved"; path: string; size: number }
  | { type: "FileBase"; path: string; content: string }
  | {
      type: "SearchResult";
      query: string;
      results: { path: string; line: number; col: number; text: string }[];
      files?: string[];
      total: number;
      truncated: boolean;
    }
  | { type: "GitStatus"; repo: boolean; branch: string; files: { path: string; code: string; xy?: string }[] }
  | { type: "GitDiff"; path: string; diff: string }
  | { type: "GitDone"; op: "stage" | "unstage" | "commit"; ok: boolean; message: string }
  | { type: "GitCommitMsg"; ok: boolean; message?: string; error?: string }
  | { type: "ToolCallResult"; call_id?: string; tool: string; is_error?: boolean; chars?: number; preview?: string }
  | { type: "Notice"; text: string }
  | ({ type: "PermissionRequest" } & PermissionRequest)
  | {
      type: "RunFinished";
      answer?: string;
      duration_ms?: number;
      usage?: Usage;
      cost_usd?: number | null;
      last_seq?: number | null;
    }
  | { type: "Error"; error?: string };

// —— 渲染进程 → 服务端 ——

export type WsCommand =
  | { type: "CreateSession" }
  | { type: "ResumeSession"; session_id: string }
  | { type: "ListSessions" }
  | { type: "SendMessage"; session_id?: string | null; text: string; images?: Img[] }
  | { type: "CancelRun"; session_id: string }
  | { type: "ForkSession"; session_id: string; upto_seq: number }
  | { type: "GetSettings" }
  | { type: "SetModel"; model: string; api_base?: string; api_key?: string }
  | { type: "SwitchModel"; model: string }
  | { type: "DeleteModelConfig"; model: string }
  | { type: "TestModel"; model: string; api_key?: string; api_base?: string }
  | { type: "SetPermissionMode"; mode: PermMode }
  | { type: "SetThinking"; level: ThinkLevel }
  | { type: "RespondPermission"; request_id: string; answer: "yes" | "always" | "no" }
  | { type: "GetSessionCost"; session_id: string }
  | { type: "GetStats" }
  | { type: "OpenDataDir" }
  | { type: "SearchContent"; query: string; limit: number }
  | { type: "UploadImage"; data_url: string }
  | { type: "ReadWorkspaceFile"; path: string }
  | { type: "LintCheck"; path: string; text: string; req: number }
  | { type: "GotoDef"; name: string; path: string; req: number }
  | { type: "ListMemory"; session_id?: string | null }
  | { type: "ReadMemoryFile"; path: string }
  | { type: "DeleteMemoryBlock"; session_id?: string | null; label: string }
  | { type: "DeleteMemoryFile"; path: string }
  | { type: "ListMcp" }
  | {
      type: "AddMcpServer";
      name: string;
      transport: "stdio" | "http";
      command: string;
      args: string;
      url: string;
    }
  | { type: "RemoveMcpServer"; name: string }
  | { type: "ListSkills" }
  // —— 工作台（IDE）——
  | { type: "ListDir"; path: string }
  | { type: "ReadFile"; path: string }
  | { type: "WriteWorkspaceFile"; path: string; content: string }
  | { type: "CreateEntry"; path: string; kind: "file" | "dir" }
  | { type: "MoveEntry"; path: string; to: string }
  | { type: "DeleteEntry"; path: string }
  | { type: "SearchWorkspace"; query: string; is_regex?: boolean; max?: number }
  | { type: "GitStatus" }
  | { type: "GitDiff"; path: string }
  | { type: "GitStage"; path: string }
  | { type: "GitStageAll" }
  | { type: "GitUnstage"; path: string }
  | { type: "GitCommit"; message: string; all?: boolean }
  | { type: "GitGenMsg" }
  | { type: "GitFileBase"; path: string }
  | { type: "RenameSession"; session_id: string; title: string }
  | { type: "DeleteSession"; session_id: string }
  | { type: "PinSession"; session_id: string; pinned: boolean }
  | { type: "CreateSessionGroup"; name: string }
  | { type: "RenameSessionGroup"; name: string; new_name: string }
  | { type: "DeleteSessionGroup"; name: string }
  | { type: "SetSessionGroup"; session_id: string; group: string };

// Electron preload（preload.cjs）暴露的桌面能力；在纯浏览器环境（如调试）下不存在
declare global {
  interface Window {
    myharness?: {
      pickFolder(): Promise<string | null>;
      getProjects(): Promise<{ current: string | null; recent: string[] }>;
      openProject(p: string): Promise<string>;
      // —— 内嵌终端（node-pty 会话，渲染端 xterm.js 交互）——
      termCreate(cols: number, rows: number): Promise<{ id: number; cwd: string; title: string; error?: string }>;
      termInput(id: number, data: string): void;
      termResize(id: number, cols: number, rows: number): void;
      termKill(id: number): void;
      termOnData(cb: (id: number, data: string) => void): void;
      termOnExit(cb: (id: number, exitCode: number) => void): void;
    };
  }
}
