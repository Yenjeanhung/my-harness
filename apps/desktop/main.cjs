"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// main.ts
var import_electron = require("electron");
var import_child_process = require("child_process");
var import_http = __toESM(require("http"));
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_url = require("url");
var PORT = process.env.MYHARNESS_PORT || "8765";
var HTTP_BASE = `http://127.0.0.1:${PORT}`;
var WS_URL = `ws://127.0.0.1:${PORT}/ws`;
var APP_VERSION = import_electron.app.getVersion();
var sidecar = null;
var staleRestarted = false;
var win = null;
import_electron.protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
function installAppProtocol() {
  const rendererRoot = import_path.default.resolve(__dirname, "renderer");
  import_electron.protocol.handle("app", (request) => {
    try {
      const u = new URL(request.url);
      let rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
      if (!rel) rel = "index.html";
      const resolved = import_path.default.resolve(rendererRoot, rel);
      if (!resolved.startsWith(rendererRoot + import_path.default.sep) && resolved !== rendererRoot) {
        return new Response("forbidden", { status: 403 });
      }
      return import_electron.net.fetch((0, import_url.pathToFileURL)(resolved).toString());
    } catch (e) {
      return new Response(`bad request: ${e instanceof Error ? e.message : e}`, { status: 400 });
    }
  });
}
var projectsFile = () => import_path.default.join(import_electron.app.getPath("userData"), "projects.json");
function loadProjects() {
  try {
    const j = JSON.parse(import_fs.default.readFileSync(projectsFile(), "utf8"));
    return { current: j.current || null, recent: Array.isArray(j.recent) ? j.recent : [] };
  } catch {
    return { current: null, recent: [] };
  }
}
function saveProjects(p) {
  import_fs.default.mkdirSync(import_path.default.dirname(projectsFile()), { recursive: true });
  import_fs.default.writeFileSync(projectsFile(), JSON.stringify(p, null, 2), "utf8");
}
var serverStartup = null;
async function restartServerWithWorkspace(ws) {
  if (sidecar) {
    try {
      sidecar.kill();
    } catch {
    }
    sidecar = null;
  } else {
    await killPortListeners(PORT);
  }
  await sleep(1e3);
  for (let i = 0; i < 10 && (await probeHealth()).ok; i++) await sleep(300);
  const state = await ensureServer(ws);
  return state;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var normalizePath = (p) => import_path.default.normalize(p).replace(/[\\/]+$/, "").toLowerCase();
function probeHealth() {
  return new Promise((resolve) => {
    const req = import_http.default.get(`${HTTP_BASE}/health`, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          resolve({
            ok: res.statusCode === 200,
            version: j.version || null,
            workspace: j.workspace || null
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
async function serverMatches(ws) {
  const h = await probeHealth();
  return !!(h.ok && h.version === APP_VERSION && h.workspace && normalizePath(h.workspace) === normalizePath(ws));
}
function killPortListeners(port) {
  if (process.platform !== "win32") return Promise.resolve();
  const sys32 = () => import_path.default.join(process.env.windir || process.env.SystemRoot || "C:\\Windows", "System32");
  return new Promise((resolve) => {
    (0, import_child_process.exec)(`"${sys32()}\\netstat.exe" -ano | findstr LISTENING | findstr :${port}`, (err, stdout) => {
      const pids = /* @__PURE__ */ new Set();
      (stdout || "").split("\n").forEach((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[3] === "LISTENING") pids.add(parts[4]);
      });
      const arr = [...pids];
      if (!arr.length) return resolve();
      let done = 0;
      arr.forEach(
        (pid) => (0, import_child_process.exec)(`"${sys32()}\\taskkill.exe" /F /PID ${pid}`, () => {
          if (++done === arr.length) resolve();
        })
      );
    });
  });
}
var gitCmdDir;
var regExe = () => import_path.default.join(process.env.windir || process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
var execP = (cmd, timeout) => new Promise((resolve) => {
  (0, import_child_process.exec)(cmd, { encoding: "utf8", timeout }, (err, stdout) => resolve(err ? "" : stdout || ""));
});
var dirExists = (p) => import_fs.default.promises.access(p).then(() => true, () => false);
async function findGitCmdDir() {
  if (gitCmdDir !== void 0) return gitCmdDir;
  gitCmdDir = null;
  const isWin = process.platform === "win32";
  const exe = isWin ? "git.exe" : "git";
  const has = (dir) => dirExists(import_path.default.join(dir, exe));
  for (const d of (process.env.PATH || "").split(import_path.default.delimiter)) {
    if (await has(d)) return null;
  }
  const candidates = [];
  if (isWin) {
    const regOut = await execP(
      `"${regExe()}" query "HKLM\\SOFTWARE\\GitForWindows" /v InstallPath 2>nul & "${regExe()}" query "HKCU\\SOFTWARE\\GitForWindows" /v InstallPath 2>nul`,
      3e3
    );
    for (const m of regOut.matchAll(/REG_SZ\s+(.+)/g)) {
      const p = m[1].trim();
      if (p) candidates.push(import_path.default.join(p, "cmd"));
    }
    for (const key of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
      const out = await execP(`"${regExe()}" query "${key}" /v Path`, 3e3);
      const m = out.match(/REG_SZ\s+(.+)/);
      for (const entry of (m?.[1] || "").split(";")) {
        const p = entry.trim();
        if (!p) continue;
        candidates.push(p, import_path.default.join(p, "cmd"));
      }
    }
    for (const L of "DEFGHIJKLMNOPQRSTUVWXYZC".split("")) {
      const root = `${L}:\\`;
      if (!await dirExists(root)) continue;
      candidates.push(import_path.default.join(root, "Git", "cmd"));
      try {
        for (const d of await import_fs.default.promises.readdir(root, { withFileTypes: true })) {
          if (d.isDirectory()) candidates.push(import_path.default.join(root, d.name, "Git", "cmd"));
        }
      } catch {
      }
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
  if (gitCmdDir) console.log(`[main] PATH \u4E0A\u6CA1\u6709 git\uFF0C\u5DF2\u8865\uFF1A${gitCmdDir}`);
  return gitCmdDir;
}
async function daemonEnv() {
  const env = { ...process.env };
  const isWin = process.platform === "win32";
  if (isWin && !(env.PATH || "").trim()) {
    const winDir = env.windir || env.SystemRoot || "C:\\Windows";
    env.PATH = [
      import_path.default.join(winDir, "System32"),
      winDir,
      import_path.default.join(winDir, "System32", "WindowsPowerShell", "v1.0")
    ].join(import_path.default.delimiter);
  }
  const candidates = [
    [process.resourcesPath ? import_path.default.join(process.resourcesPath, "bin") : "", isWin ? "rg.exe" : "rg"],
    [import_path.default.join(__dirname, "build", "rg"), isWin ? "rg.exe" : "rg"]
  ];
  const git = await findGitCmdDir();
  if (git) candidates.push([git, isWin ? "git.exe" : "git"]);
  for (const [dir, exe] of candidates) {
    if (dir && import_fs.default.existsSync(import_path.default.join(dir, exe))) {
      env.PATH = dir + import_path.default.delimiter + (env.PATH || "");
    }
  }
  return env;
}
async function ensureServer(workspace) {
  const h = await probeHealth();
  if (h.ok) {
    if (h.version === APP_VERSION) return "attached";
    await killPortListeners(PORT);
    await sleep(800);
    staleRestarted = true;
  }
  const wsArgs = workspace ? ["--workspace", workspace] : [];
  const attempts = [];
  if (process.resourcesPath) {
    const dirExe = import_path.default.join(process.resourcesPath, "harness-server", "harness-server.exe");
    const fileExe = import_path.default.join(process.resourcesPath, "harness-server.exe");
    if (import_fs.default.existsSync(dirExe)) attempts.push({ file: dirExe, args: ["--port", PORT, ...wsArgs] });
    if (import_fs.default.existsSync(fileExe)) attempts.push({ file: fileExe, args: ["--port", PORT, ...wsArgs] });
  }
  attempts.push({
    cmd: process.platform === "win32" ? "harness.exe" : "harness",
    args: ["serve", "--port", PORT, ...wsArgs]
  });
  for (const a of attempts) {
    const cmd = a.file || a.cmd;
    if (!cmd) continue;
    try {
      const child = (0, import_child_process.spawn)(cmd, a.args, { stdio: "ignore", env: await daemonEnv() });
      child.on("error", () => {
      });
      sidecar = child;
    } catch {
      sidecar = null;
      continue;
    }
    for (let i = 0; i < 110; i++) {
      await sleep(i < 40 ? 250 : 500);
      const hh = await probeHealth();
      if (hh.ok) return staleRestarted ? "restarted" : "started";
    }
    try {
      sidecar.kill();
    } catch {
    }
    sidecar = null;
  }
  return "unavailable";
}
var ptys = /* @__PURE__ */ new Map();
var ptySeq = 1;
var terminalWorkspace = null;
function currentWorkspace() {
  return terminalWorkspace || loadProjects().current || import_electron.app.getPath("home");
}
import_electron.ipcMain.handle("term-create", async (_e, cols, rows) => {
  let nodePty;
  try {
    nodePty = await import("@lydell/node-pty");
  } catch (err) {
    return { error: `\u7EC8\u7AEF\u6A21\u5757\u52A0\u8F7D\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}` };
  }
  const id = ptySeq++;
  const cwd = currentWorkspace();
  const shell2 = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "zsh" : "bash";
  const shellArgs = process.platform === "win32" ? ["-NoLogo"] : [];
  let pty;
  try {
    pty = nodePty.spawn(shell2, shellArgs, {
      name: "xterm-256color",
      cols: Math.max(20, Math.min(cols || 80, 500)),
      rows: Math.max(5, Math.min(rows || 24, 200)),
      cwd,
      env: process.env
    });
  } catch (err) {
    return { error: `\u7EC8\u7AEF\u542F\u52A8\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}` };
  }
  ptys.set(id, pty);
  pty.onData((d) => {
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send("term-data", id, d);
      } catch {
      }
    }
  });
  pty.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send("term-exit", id, exitCode);
      } catch {
      }
    }
  });
  return { id, cwd, title: import_path.default.basename(cwd) || "\u7EC8\u7AEF" };
});
import_electron.ipcMain.on("term-input", (_e, id, data) => {
  ptys.get(id)?.write(data);
});
import_electron.ipcMain.on("term-resize", (_e, id, cols, rows) => {
  try {
    ptys.get(id)?.resize(Math.max(10, cols), Math.max(4, rows));
  } catch {
  }
});
import_electron.ipcMain.on("term-kill", (_e, id) => {
  const p = ptys.get(id);
  if (p) {
    try {
      p.kill();
    } catch {
    }
    ptys.delete(id);
  }
});
import_electron.ipcMain.handle("py-cmd", () => {
  const ws = currentWorkspace();
  const sub = process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  const p = import_path.default.join(ws, ...sub);
  return import_fs.default.existsSync(p) ? p : "python";
});
function rendererUrl(query) {
  const qs = new URLSearchParams(query).toString();
  return `app://bundle/index.html?${qs}`;
}
import_electron.app.whenReady().then(async () => {
  import_electron.Menu.setApplicationMenu(null);
  installAppProtocol();
  const oldData = import_path.default.join(import_electron.app.getPath("appData"), "my-harness-desktop");
  const newData = import_electron.app.getPath("userData");
  try {
    if (import_path.default.resolve(oldData) !== import_path.default.resolve(newData) && import_fs.default.existsSync(import_path.default.join(oldData, "projects.json")) && !import_fs.default.existsSync(import_path.default.join(newData, "projects.json"))) {
      import_fs.default.mkdirSync(newData, { recursive: true });
      import_fs.default.copyFileSync(import_path.default.join(oldData, "projects.json"), import_path.default.join(newData, "projects.json"));
    }
  } catch {
  }
  import_electron.ipcMain.handle("pick-folder", async () => {
    if (!win) return null;
    const r = await import_electron.dialog.showOpenDialog(win, {
      title: "\u9009\u62E9\u9879\u76EE\u6587\u4EF6\u5939",
      properties: ["openDirectory", "createDirectory"]
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  import_electron.ipcMain.handle("get-projects", () => loadProjects());
  import_electron.ipcMain.handle("show-in-folder", (_e, rel) => {
    const rootDir = terminalWorkspace || loadProjects().current || import_electron.app.getPath("home");
    const abs = import_path.default.resolve(rootDir, String(rel || ""));
    if (!import_fs.default.existsSync(abs)) return "missing";
    import_electron.shell.showItemInFolder(abs);
    return "ok";
  });
  import_electron.ipcMain.handle("open-project", async (_e, p) => {
    if (!p || !import_fs.default.existsSync(p) || !import_fs.default.statSync(p).isDirectory()) return "invalid";
    if (serverStartup) {
      try {
        await serverStartup;
      } catch {
      }
      serverStartup = null;
    }
    const st = loadProjects();
    const same = st.current === p;
    if (!same) {
      st.current = p;
      st.recent = [p, ...st.recent.filter((x) => x !== p)].slice(0, 8);
      saveProjects(st);
      terminalWorkspace = p;
    }
    const state = await serverMatches(p) ? "attached" : await restartServerWithWorkspace(p);
    try {
      await win?.loadURL(rendererUrl({ ws: WS_URL, server: state, root: p }));
    } catch {
    }
    return state;
  });
  const iconPath = import_path.default.join(__dirname, "build", "icon.ico");
  win = new import_electron.BrowserWindow({
    width: 1280,
    height: 880,
    backgroundColor: "#111318",
    title: "Y Harness",
    // CodeBuddy 式自绘顶栏：隐藏系统标题栏，网页延伸到顶（顶栏内放面板开关）；
    // 右上角最小化/最大化/关闭仍由系统 WCO 绘制，height 必须与 .titlebar 的 CSS 高度一致
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#111318", symbolColor: "#c9d1d9", height: 36 },
    ...import_fs.default.existsSync(iconPath) ? { icon: iconPath } : {},
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: import_path.default.join(__dirname, "preload.cjs")
    }
  });
  const projects = loadProjects();
  terminalWorkspace = projects.current;
  win.loadURL(rendererUrl({ ws: WS_URL, server: "starting", root: projects.current || "" }));
  const startup = projects.current ? (async () => await serverMatches(projects.current) ? "attached" : await restartServerWithWorkspace(projects.current))() : ensureServer();
  serverStartup = startup;
  const serverState = await startup.finally(() => {
    if (serverStartup === startup) serverStartup = null;
  });
  if (serverState === "unavailable") {
    import_electron.dialog.showMessageBox({
      type: "warning",
      message: "my-harness daemon \u672A\u627E\u5230",
      detail: "\u672A\u80FD\u8FDE\u63A5\u6216\u542F\u52A8 harness serve\u3002\n\u8BF7\u786E\u8BA4 `harness` \u5728 PATH \u4E2D\uFF08pip install -e .\uFF09\uFF0C\u6216\u91CD\u65B0\u6253\u5305\u4EE5\u5185\u5D4C harness-server.exe\u3002"
    });
  }
  if (!win.isDestroyed()) {
    try {
      await win.loadURL(rendererUrl({ ws: WS_URL, server: serverState, root: projects.current || "" }));
    } catch {
    }
  }
});
import_electron.app.on("window-all-closed", () => {
  for (const p of ptys.values()) {
    try {
      p.kill();
    } catch {
    }
  }
  ptys.clear();
  if (sidecar) sidecar.kill();
  import_electron.app.quit();
});
