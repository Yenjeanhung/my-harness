// Electron 主进程：确保 my-harness daemon 在跑（附着已有 → 内嵌 sidecar → PATH 上的 harness），
// 再打开窗口。渲染进程是纯 Web 页面，连 ws://127.0.0.1:<port>/ws —— 与 CLI 共用同一协议。
// 源码是 main.ts，main.cjs 由 build.mjs 编译产出。
import { app, BrowserWindow, dialog, Menu, ipcMain, shell } from "electron";
import { spawn, exec, execSync } from "child_process";
import type { ChildProcess } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";
import type { IPty } from "@lydell/node-pty";

const PORT = process.env.MYHARNESS_PORT || "8765";
const HTTP_BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const APP_VERSION = app.getVersion(); // 与 Python 端 harness.__version__ 保持同步
let sidecar: ChildProcess | null = null;
let staleRestarted = false;
let win: BrowserWindow | null = null;

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
// 切项目 = 带新 --workspace 重启 daemon（每个项目独立记忆库/AGENT.md/skills，ZCode 同思路）
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
  return new Promise((resolve) => {
    exec(`netstat -ano | findstr LISTENING | findstr :${port}`, (err, stdout) => {
      const pids = new Set<string>();
      (stdout || "").split("\n").forEach((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[3] === "LISTENING") pids.add(parts[4]);
      });
      const arr = [...pids];
      if (!arr.length) return resolve();
      let done = 0;
      arr.forEach((pid) =>
        exec(`taskkill /F /PID ${pid}`, () => {
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
function findGitCmdDir(): string | null {
  if (gitCmdDir !== undefined) return gitCmdDir;
  gitCmdDir = null;
  const isWin = process.platform === "win32";
  const exe = isWin ? "git.exe" : "git";
  const has = (dir: string) => !!dir && fs.existsSync(path.join(dir, exe));
  // 1) 当前 PATH 已能解析（终端里启动应用的常见情形）：不折腾
  if ((process.env.PATH || "").split(path.delimiter).some(has)) return null;
  const candidates: string[] = [];
  if (isWin) {
    // 2) Git for Windows 安装器写的注册表 InstallPath
    try {
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\GitForWindows" /v InstallPath 2>nul & reg query "HKCU\\SOFTWARE\\GitForWindows" /v InstallPath 2>nul',
        { encoding: "utf8", timeout: 3000 }
      );
      for (const m of out.matchAll(/REG_SZ\s+(.+)/g)) {
        const p = m[1].trim();
        if (p) candidates.push(path.join(p, "cmd"));
      }
    } catch {}
    // 3) 注册表里的用户/系统 PATH（Explorer 进程环境是启动快照，装完 git 不重启就看不到）
    for (const key of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
      try {
        const out = execSync(`reg query "${key}" /v Path`, { encoding: "utf8", timeout: 3000 });
        const m = out.match(/REG_SZ\s+(.+)/);
        for (const entry of (m?.[1] || "").split(";")) {
          const p = entry.trim();
          if (!p) continue;
          candidates.push(p, path.join(p, "cmd"));
        }
      } catch {}
    }
    // 4) 兜底：各盘符浅层扫描 X:\Git\cmd 与 X:\<一级目录>\Git\cmd（覆盖解压版自定义位置）
    for (const L of "DEFGHIJKLMNOPQRSTUVWXYZC".split("")) {
      const root = `${L}:\\`;
      if (!fs.existsSync(root)) continue;
      candidates.push(path.join(root, "Git", "cmd"));
      try {
        for (const d of fs.readdirSync(root, { withFileTypes: true })) {
          if (d.isDirectory()) candidates.push(path.join(root, d.name, "Git", "cmd"));
        }
      } catch {}
    }
  } else {
    candidates.push("/usr/bin", "/usr/local/bin", "/opt/homebrew/bin");
  }
  gitCmdDir = candidates.find(has) || null;
  if (gitCmdDir) console.log(`[main] PATH 上没有 git，已补：${gitCmdDir}`);
  return gitCmdDir;
}

function daemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const isWin = process.platform === "win32";
  const candidates: [string, string][] = [
    [process.resourcesPath ? path.join(process.resourcesPath, "bin") : "", isWin ? "rg.exe" : "rg"],
    [path.join(__dirname, "build", "rg"), isWin ? "rg.exe" : "rg"],
  ];
  const git = findGitCmdDir();
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
    const f = path.join(process.resourcesPath, "harness-server.exe");
    if (fs.existsSync(f)) attempts.push({ file: f, args: ["--port", PORT, ...wsArgs] });
  }
  attempts.push({
    cmd: process.platform === "win32" ? "harness.exe" : "harness",
    args: ["serve", "--port", PORT, ...wsArgs],
  });
  for (const a of attempts) {
    const cmd = a.file || a.cmd;
    if (!cmd) continue;
    try {
      const child = spawn(cmd, a.args, { stdio: "ignore", env: daemonEnv() });
      child.on("error", () => {});
      sidecar = child;
    } catch {
      sidecar = null;
      continue;
    }
    for (let i = 0; i < 60; i++) {
      await sleep(500);
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
  pty.onData((d) => win?.webContents.send("term-data", id, d));
  pty.onExit(({ exitCode }) => {
    ptys.delete(id);
    win?.webContents.send("term-exit", id, exitCode);
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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // 去掉默认菜单栏（File/Edit/View/...）

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

  // —— 项目 IPC：原生选文件夹 / 读取最近项目 / 切换项目（重启 daemon）——
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
    const st = loadProjects();
    const same = st.current === p;
    if (!same) {
      st.current = p;
      st.recent = [p, ...st.recent.filter((x) => x !== p)].slice(0, 8);
      saveProjects(st);
      terminalWorkspace = p; // 新开的终端 tab 跟随新项目
    }
    // 同一项目且 daemon 已在跑对的工作区/版本：不重启，只刷窗口；
    // 否则带新工作区重启 daemon。无论哪种，页面都要重开——
    // 旧页面可能卡在「连接断开」（切项目杀了 daemon，且渲染层此前没有自动重连）。
    const state = same && (await serverMatches(p)) ? "attached" : await restartServerWithWorkspace(p);
    try {
      // reload 会保留旧 query（serverState 文本过期）；loadFile 带最新状态重开
      await win?.loadFile(path.join(__dirname, "renderer", "index.html"), {
        query: { ws: WS_URL, server: state },
      });
    } catch {
      /* 窗口销毁竞态 */
    }
    return state;
  });

  // 启动：记住了项目就按该项目拉 daemon（已在跑对的工作区且版本匹配则直接附着），否则沿用默认
  const projects = loadProjects();
  terminalWorkspace = projects.current;
  let serverState: string;
  if (projects.current) {
    serverState = (await serverMatches(projects.current))
      ? "attached"
      : await restartServerWithWorkspace(projects.current);
  } else {
    serverState = await ensureServer();
  }
  if (serverState === "unavailable") {
    dialog.showMessageBox({
      type: "warning",
      message: "my-harness daemon 未找到",
      detail:
        "未能连接或启动 harness serve。\n请确认 `harness` 在 PATH 中（pip install -e .），" +
        "或重新打包以内嵌 harness-server.exe。",
    });
  }
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
  win.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { ws: WS_URL, server: serverState },
  });
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
