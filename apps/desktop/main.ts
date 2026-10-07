// Electron 主进程：确保 my-harness daemon 在跑（附着已有 → 内嵌 sidecar → PATH 上的 harness），
// 再打开窗口。渲染进程是纯 Web 页面，连 ws://127.0.0.1:<port>/ws —— 与 CLI 共用同一协议。
// 源码是 main.ts，main.cjs 由 build.mjs 编译产出。
import { app, BrowserWindow, dialog, Menu, ipcMain, protocol, net, shell } from "electron";
import { spawn, exec, execSync } from "child_process";
import type { ChildProcess } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import type { IPty } from "@lydell/node-pty";

const PORT = process.env.MYHARNESS_PORT || "8765";
const HTTP_BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const APP_VERSION = app.getVersion(); // 与 Python 端 harness.__version__ 保持同步
let sidecar: ChildProcess | null = null;
let staleRestarted = false;
let win: BrowserWindow | null = null;

// —— 渲染页自定义协议（app://）——
// Monaco 的语言服务 worker 必须同源加载；file:// 下 origin 为 null，Worker 加载受限制。
// 注册成 standard+secure 后 app://bundle/... 与 http 语义一致：worker、module script、相对路径全部正常。
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// app://bundle/<path> → renderer/<path>（net.fetch(file://) 自动按扩展名给 MIME）
function installAppProtocol() {
  const rendererRoot = path.resolve(__dirname, "renderer");
  protocol.handle("app", (request) => {
    try {
      const u = new URL(request.url);
      let rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
      if (!rel) rel = "index.html";
      const resolved = path.resolve(rendererRoot, rel);
      if (!resolved.startsWith(rendererRoot + path.sep) && resolved !== rendererRoot) {
        return new Response("forbidden", { status: 403 });
      }
      return net.fetch(pathToFileURL(resolved).toString());
    } catch (e) {
      return new Response(`bad request: ${e instanceof Error ? e.message : e}`, { status: 400 });
    }
  });
}

// —— 项目（工作区）状态：userData/projects.json，跨启动记忆最近项目 ——
interface ProjectsState {
  current: string | null;
  recent: string[];
}
const projectsFile = () => path.join(app.getPath("userData"), "projects.json");
function loadProjects(): ProjectsState {
  try {
    const j = JSON.parse(fs.readFileSync(projectsFile(), "utf8")) as ProjectsState;
    return { current: j.current || null, recent: Array.isArray(j.recent) ? j.recent : [] };
  } catch {
    return { current: null, recent: [] };
  }
}
function saveProjects(p: ProjectsState) {
  fs.mkdirSync(path.dirname(projectsFile()), { recursive: true });
  fs.writeFileSync(projectsFile(), JSON.stringify(p, null, 2), "utf8");
}
// 切项目：渲染层先向 daemon 发 SetWorkspace 进程内热切换（秒级），成功后 daemon 的
// /health 已指向新工作区 → open-project 里 serverMatches 命中直接附着，不再重启。
// 这里保留的重启路径只在 daemon 不在跑/版本不匹配/旧 daemon 不认识 SetWorkspace 时兜底。
// 每个项目仍有独立的记忆库/AGENT.md/skills（热切换时由 daemon 进程内重建，语义一致）
// 注意：调用方（open-project）须先等 serverStartup 落定——启动期的后台 ensureServer 与这里的杀/启互斥
let serverStartup: Promise<string> | null = null;
async function restartServerWithWorkspace(ws: string): Promise<string> {
  if (sidecar) {
    try {
      sidecar.kill();
    } catch {}
    sidecar = null;
  } else {
    await killPortListeners(PORT); // 附着的外部 daemon：按端口清
  }
  await sleep(1000); // 等端口释放
  for (let i = 0; i < 10 && (await probeHealth()).ok; i++) await sleep(300);
  const state = await ensureServer(ws);
  return state;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Health {
  ok: boolean;
  version: string | null;
  workspace: string | null;
}

const normalizePath = (p: string) => path.normalize(p).replace(/[\\/]+$/, "").toLowerCase();

function probeHealth(): Promise<Health> {
  return new Promise((resolve) => {
    const req = http.get(`${HTTP_BASE}/health`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(body) as { version?: string; workspace?: string };
          resolve({
            ok: res.statusCode === 200,
            version: j.version || null,
            workspace: j.workspace || null,
          });
        } catch {
          resolve({ ok: false, version: null, workspace: null });
        }
      });
    });
    req.on("error", () => resolve({ ok: false, version: null, workspace: null }));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve({ ok: false, version: null, workspace: null });
    });
  });
}

// daemon 已在跑、版本匹配、且工作区就是目标项目 → 无需重启（启动秒开 / 重试同项目不折腾）
async function serverMatches(ws: string): Promise<boolean> {
  const h = await probeHealth();
  return !!(h.ok && h.version === APP_VERSION && h.workspace && normalizePath(h.workspace) === normalizePath(ws));
}

function killPortListeners(port: string): Promise<void> {
  // 仅在版本握手失败（旧 daemon / 未知服务占口）时调用
  if (process.platform !== "win32") return Promise.resolve();
  const sys32 = () => path.join(process.env.windir || process.env.SystemRoot || "C:\\Windows", "System32");
  return new Promise((resolve) => {
    // System32 绝对路径：应用被空 PATH 环境拉起时 cmd 解析不到裸的 netstat/taskkill
    exec(`"${sys32()}\\netstat.exe" -ano | findstr LISTENING | findstr :${port}`, (err, stdout) => {
      const pids = new Set<string>();
      (stdout || "").split("\n").forEach((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[3] === "LISTENING") pids.add(parts[4]);
      });
      const arr = [...pids];
      if (!arr.length) return resolve();
      let done = 0;
      arr.forEach((pid) =>
        exec(`"${sys32()}\\taskkill.exe" /F /PID ${pid}`, () => {
          if (++done === arr.length) resolve();
        })
      );
    });
  });
}

interface SpawnAttempt {
  file?: string;
  cmd?: string;
  args: string[];
}

// rg（ripgrep）随包分发：打包后在 resources/bin，开发时在 build/rg。
// git：双击启动（Explorer 环境）时 PATH 里可能没有 git（自定义安装盘符/终端 profile 注入），
// daemon 的 SCM 全靠它——注册表 GitForWindows\InstallPath + 常见目录探测，命中就前插进 daemon PATH。
let gitCmdDir: string | null | undefined; // undefined=未探测
// reg.exe 用绝对路径：正是「PATH 为空/被裁剪」的场景才需要补 git，而那时 cmd 解析不到裸的 `reg`
const regExe = () =>
  path.join(process.env.windir || process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
// 探测必须异步（exec + fs.promises）：同步版会在主进程里串行跑注册表查询 + 全盘目录扫描，
// 冷启动阶段把整个进程卡住数秒——窗口都出不来（「打开代码窗口卡一会」的主因之一）
const execP = (cmd: string, timeout: number) =>
  new Promise<string>((resolve) => {
    exec(cmd, { encoding: "utf8", timeout }, (err, stdout) => resolve(err ? "" : stdout || ""));
  });
const dirExists = (p: string) => fs.promises.access(p).then(() => true, () => false);
async function findGitCmdDir(): Promise<string | null> {
  if (gitCmdDir !== undefined) return gitCmdDir;
  gitCmdDir = null;
  const isWin = process.platform === "win32";
  const exe = isWin ? "git.exe" : "git";
  const has = (dir: string) => dirExists(path.join(dir, exe));
  // 1) 当前 PATH 已能解析（终端里启动应用的常见情形）：不折腾
  for (const d of (process.env.PATH || "").split(path.delimiter)) {
    if (await has(d)) return null;
  }
  const candidates: string[] = [];
  if (isWin) {
    // 2) Git for Windows 安装器写的注册表 InstallPath
    const regOut = await execP(
      `"${regExe()}" query "HKLM\\SOFTWARE\\GitForWindows" /v InstallPath 2>nul & "${regExe()}" query "HKCU\\SOFTWARE\\GitForWindows" /v InstallPath 2>nul`,
      3000
    );
    for (const m of regOut.matchAll(/REG_SZ\s+(.+)/g)) {
      const p = m[1].trim();
      if (p) candidates.push(path.join(p, "cmd"));
    }
    // 3) 注册表里的用户/系统 PATH（Explorer 进程环境是启动快照，装完 git 不重启就看不到）
    for (const key of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
      const out = await execP(`"${regExe()}" query "${key}" /v Path`, 3000);
      const m = out.match(/REG_SZ\s+(.+)/);
      for (const entry of (m?.[1] || "").split(";")) {
        const p = entry.trim();
        if (!p) continue;
        candidates.push(p, path.join(p, "cmd"));
      }
    }
    // 4) 兜底：各盘符浅层扫描 X:\Git\cmd 与 X:\<一级目录>\Git\cmd（覆盖解压版自定义位置）
    for (const L of "DEFGHIJKLMNOPQRSTUVWXYZC".split("")) {
      const root = `${L}:\\`;
      if (!(await dirExists(root))) continue;
      candidates.push(path.join(root, "Git", "cmd"));
      try {
        for (const d of await fs.promises.readdir(root, { withFileTypes: true })) {
          if (d.isDirectory()) candidates.push(path.join(root, d.name, "Git", "cmd"));
        }
      } catch {}
    }
  } else {
    candidates.push("/usr/bin", "/usr/local/bin", "/opt/homebrew/bin");
  }
  for (const c of candidates) {
    if (await has(c)) {
      gitCmdDir = c;
      break;
    }
  }
  if (gitCmdDir) console.log(`[main] PATH 上没有 git，已补：${gitCmdDir}`);
  return gitCmdDir;
}

async function daemonEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const isWin = process.platform === "win32";
  // 应用可能被空 PATH 的进程拉起（自动化/计划任务）：给 daemon 垫上系统目录底，
  // 否则它连 cmd/powershell 一族子进程都起不来
  if (isWin && !(env.PATH || "").trim()) {
    const winDir = env.windir || env.SystemRoot || "C:\\Windows";
    env.PATH = [
      path.join(winDir, "System32"),
      winDir,
      path.join(winDir, "System32", "WindowsPowerShell", "v1.0"),
    ].join(path.delimiter);
  }
  const candidates: [string, string][] = [
    [process.resourcesPath ? path.join(process.resourcesPath, "bin") : "", isWin ? "rg.exe" : "rg"],
    [path.join(__dirname, "build", "rg"), isWin ? "rg.exe" : "rg"],
  ];
  const git = await findGitCmdDir();
  if (git) candidates.push([git, isWin ? "git.exe" : "git"]); // SCM：daemon 进程也要能找到 git
  for (const [dir, exe] of candidates) {
    if (dir && fs.existsSync(path.join(dir, exe))) {
      env.PATH = dir + path.delimiter + (env.PATH || "");
    }
  }
  return env;
}

async function ensureServer(workspace?: string | null): Promise<"attached" | "started" | "restarted" | "unavailable"> {
  const h = await probeHealth();
  if (h.ok) {
    if (h.version === APP_VERSION) return "attached";
    // 版本不匹配（含旧版无 version 字段）：清掉旧 daemon，用内嵌 sidecar 重启
    await killPortListeners(PORT);
    await sleep(800);
    staleRestarted = true;
  }
  const wsArgs = workspace ? ["--workspace", workspace] : [];
  const attempts: SpawnAttempt[] = [];
  if (process.resourcesPath) {
    // onedir 目录版（常规产物，免解压、冷启动快）优先；单文件 onefile 兜底兼容旧安装包
    const dirExe = path.join(process.resourcesPath, "harness-server", "harness-server.exe");
    const fileExe = path.join(process.resourcesPath, "harness-server.exe");
    if (fs.existsSync(dirExe)) attempts.push({ file: dirExe, args: ["--port", PORT, ...wsArgs] });
    if (fs.existsSync(fileExe)) attempts.push({ file: fileExe, args: ["--port", PORT, ...wsArgs] });
  }
  attempts.push({
    cmd: process.platform === "win32" ? "harness.exe" : "harness",
    args: ["serve", "--port", PORT, ...wsArgs],
  });
  for (const a of attempts) {
    const cmd = a.file || a.cmd;
    if (!cmd) continue;
    try {
      const child = spawn(cmd, a.args, { stdio: "ignore", env: await daemonEnv() });
      child.on("error", () => {});
      sidecar = child;
    } catch {
      sidecar = null;
      continue;
    }
    // 就绪轮询：前期密（daemon 起来立刻放行）、后期疏（onefile sidecar 冷启动实测可到 20s）
    for (let i = 0; i < 110; i++) {
      await sleep(i < 40 ? 250 : 500);
      const hh = await probeHealth();
      if (hh.ok) return staleRestarted ? "restarted" : "started";
    }
    try {
      sidecar.kill();
    } catch {}
    sidecar = null;
  }
  return "unavailable";
}

// —— 内嵌终端：node-pty(Windows=ConPTY) 会话，渲染端 xterm.js 交互；工作区跟随当前项目 ——
const ptys = new Map<number, IPty>();
let ptySeq = 1;
let terminalWorkspace: string | null = null; // 拉起 daemon 时知道的项目工作区

function currentWorkspace(): string {
  return terminalWorkspace || loadProjects().current || app.getPath("home");
}

ipcMain.handle("term-create", async (_e, cols: number, rows: number) => {
  // 延迟加载原生模块：缺失/损坏时只让终端报错，不拖垮整个应用
  let nodePty: typeof import("@lydell/node-pty");
  try {
    nodePty = await import("@lydell/node-pty");
  } catch (err) {
    return { error: `终端模块加载失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  const id = ptySeq++;
  const cwd = currentWorkspace();
  const shell =
    process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "zsh" : "bash";
  const shellArgs = process.platform === "win32" ? ["-NoLogo"] : [];
  let pty: IPty;
  try {
    pty = nodePty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: Math.max(20, Math.min(cols || 80, 500)),
      rows: Math.max(5, Math.min(rows || 24, 200)),
      cwd,
      env: process.env as Record<string, string>,
    });
  } catch (err) {
    return { error: `终端启动失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  ptys.set(id, pty);
  // 窗口可能在终端还有输出时被关掉：销毁后 webContents.send 会抛
  // "Object has been destroyed" 并炸掉主进程（pty 回调里抛出即 uncaught）
  pty.onData((d) => {
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send("term-data", id, d);
      } catch {}
    }
  });
  pty.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send("term-exit", id, exitCode);
      } catch {}
    }
  });
  return { id, cwd, title: path.basename(cwd) || "终端" };
});
ipcMain.on("term-input", (_e, id: number, data: string) => {
  ptys.get(id)?.write(data);
});
ipcMain.on("term-resize", (_e, id: number, cols: number, rows: number) => {
  try {
    ptys.get(id)?.resize(Math.max(10, cols), Math.max(4, rows));
  } catch {}
});
ipcMain.on("term-kill", (_e, id: number) => {
  const p = ptys.get(id);
  if (p) {
    try {
      p.kill();
    } catch {}
    ptys.delete(id);
  }
});

// Python 解释器解析（「运行 Python 文件 / 安装语言服务器」往终端写的命令用它拼）：
// 工作区 .venv 优先（与 daemon 侧 LSP 的解析同思路，项目环境天然匹配），否则 PATH 上的 python
ipcMain.handle("py-cmd", () => {
  const ws = currentWorkspace();
  const sub = process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  const p = path.join(ws, ...sub);
  return fs.existsSync(p) ? p : "python";
});

// app://bundle/index.html?ws=...&server=...（query 经 URLSearchParams 编码，ws:// 里的斜杠不会破 URL）
// root=当前项目绝对路径：渲染层拿它拼 Monaco model 的 file:// URI（/health 有 CORS 拦截，不走 HTTP）
function rendererUrl(query: Record<string, string>): string {
  const qs = new URLSearchParams(query).toString();
  return `app://bundle/index.html?${qs}`;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // 去掉默认菜单栏（File/Edit/View/...）
  installAppProtocol();

  // 产品改名（My-Harness→Y Harness）后 userData 目录会变：把旧目录的 projects.json 迁过来
  const oldData = path.join(app.getPath("appData"), "my-harness-desktop");
  const newData = app.getPath("userData");
  try {
    if (
      path.resolve(oldData) !== path.resolve(newData) &&
      fs.existsSync(path.join(oldData, "projects.json")) &&
      !fs.existsSync(path.join(newData, "projects.json"))
    ) {
      fs.mkdirSync(newData, { recursive: true });
      fs.copyFileSync(path.join(oldData, "projects.json"), path.join(newData, "projects.json"));
    }
  } catch {}

  // —— 项目 IPC：原生选文件夹 / 读取最近项目 / 切换项目（daemon 热切换优先，重启兜底）——
  ipcMain.handle("pick-folder", async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: "选择项目文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle("get-projects", () => loadProjects());
  // 文件树右键「在资源管理器中显示」：相对路径按当前项目根解析，explorer 里定位并选中
  ipcMain.handle("show-in-folder", (_e, rel: string) => {
    const rootDir = terminalWorkspace || loadProjects().current || app.getPath("home");
    const abs = path.resolve(rootDir, String(rel || ""));
    if (!fs.existsSync(abs)) return "missing";
    shell.showItemInFolder(abs);
    return "ok";
  });
  ipcMain.handle("open-project", async (_e, p: string) => {
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return "invalid";
    // 启动期的后台 daemon 拉起还没落定：先等它（否则杀/启与启动循环竞态）
    if (serverStartup) {
      try {
        await serverStartup;
      } catch {}
      serverStartup = null;
    }
    const st = loadProjects();
    const same = st.current === p;
    if (!same) {
      st.current = p;
      st.recent = [p, ...st.recent.filter((x) => x !== p)].slice(0, 8);
      saveProjects(st);
      terminalWorkspace = p; // 新开的终端 tab 跟随新项目
    }
    // daemon 已在跑对的工作区/版本 → 直接附着（同项目秒开；渲染层 SetWorkspace 热切换
    // 成功后也命中这里，不再重启）。不匹配才带新工作区重启兜底。无论哪种，页面都要重开——
    // 旧 query 里的 root/serverState 已过期，loadURL 带最新状态重开。
    const state = (await serverMatches(p)) ? "attached" : await restartServerWithWorkspace(p);
    try {
      // reload 会保留旧 query（serverState 文本过期）；loadURL 带最新状态重开
      await win?.loadURL(rendererUrl({ ws: WS_URL, server: state, root: p }));
    } catch {
      /* 窗口销毁竞态 */
    }
    return state;
  });

  // 启动即开窗：daemon 就绪要几秒到二十几秒（onefile sidecar 冷启动），同步等它 =
  // 双击后死等半个分钟才见窗口（「打开代码窗口卡一会」的主因）。先出窗（页面自带 2s 重连，
  // daemon 起来自动接上），ensureServer 并行在后台跑，就绪后带最终状态重开一次页面。
  const iconPath = path.join(__dirname, "build", "icon.ico");
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    backgroundColor: "#111318",
    title: "Y Harness",
    // CodeBuddy 式自绘顶栏：隐藏系统标题栏，网页延伸到顶（顶栏内放面板开关）；
    // 右上角最小化/最大化/关闭仍由系统 WCO 绘制，height 必须与 .titlebar 的 CSS 高度一致
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#111318", symbolColor: "#c9d1d9", height: 36 },
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  const projects = loadProjects();
  terminalWorkspace = projects.current;
  win.loadURL(rendererUrl({ ws: WS_URL, server: "starting", root: projects.current || "" }));

  // daemon 拉起/附着（后台）：记住了项目就按该项目拉，已在跑对的工作区且版本匹配则直接附着。
  // promise 存进 serverStartup：open-project 若在启动期间被调用，先等这里落定再杀/启，避免竞态
  const startup: Promise<string> = projects.current
    ? (async () => ((await serverMatches(projects.current!)) ? "attached" : await restartServerWithWorkspace(projects.current!)))()
    : ensureServer();
  serverStartup = startup;
  const serverState = await startup.finally(() => {
    if (serverStartup === startup) serverStartup = null;
  });
  if (serverState === "unavailable") {
    dialog.showMessageBox({
      type: "warning",
      message: "my-harness daemon 未找到",
      detail:
        "未能连接或启动 harness serve。\n请确认 `harness` 在 PATH 中（pip install -e .），" +
        "或重新打包以内嵌 harness-server.exe。",
    });
  }
  // 就绪后把页面换成带最终 daemon 状态的 URL（此刻页面还停在「等待连接」，没有用户状态可丢）
  if (!win.isDestroyed()) {
    try {
      await win.loadURL(rendererUrl({ ws: WS_URL, server: serverState, root: projects.current || "" }));
    } catch {
      /* 窗口销毁竞态 */
    }
  }
});

app.on("window-all-closed", () => {
  for (const p of ptys.values()) {
    try {
      p.kill();
    } catch {}
  }
  ptys.clear();
  if (sidecar) sidecar.kill();
  app.quit();
});
