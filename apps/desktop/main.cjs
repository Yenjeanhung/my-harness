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
var nodePty = __toESM(require("@lydell/node-pty"));
var PORT = process.env.MYHARNESS_PORT || "8765";
var HTTP_BASE = `http://127.0.0.1:${PORT}`;
var WS_URL = `ws://127.0.0.1:${PORT}/ws`;
var APP_VERSION = import_electron.app.getVersion();
var sidecar = null;
var staleRestarted = false;
var win = null;
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
  return new Promise((resolve) => {
    (0, import_child_process.exec)(`netstat -ano | findstr LISTENING | findstr :${port}`, (err, stdout) => {
      const pids = /* @__PURE__ */ new Set();
      (stdout || "").split("\n").forEach((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[3] === "LISTENING") pids.add(parts[4]);
      });
      const arr = [...pids];
      if (!arr.length) return resolve();
      let done = 0;
      arr.forEach(
        (pid) => (0, import_child_process.exec)(`taskkill /F /PID ${pid}`, () => {
          if (++done === arr.length) resolve();
        })
      );
    });
  });
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
    const f = import_path.default.join(process.resourcesPath, "harness-server.exe");
    if (import_fs.default.existsSync(f)) attempts.push({ file: f, args: ["--port", PORT, ...wsArgs] });
  }
  attempts.push({
    cmd: process.platform === "win32" ? "harness.exe" : "harness",
    args: ["serve", "--port", PORT, ...wsArgs]
  });
  for (const a of attempts) {
    const cmd = a.file || a.cmd;
    if (!cmd) continue;
    try {
      const child = (0, import_child_process.spawn)(cmd, a.args, { stdio: "ignore" });
      child.on("error", () => {
      });
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
import_electron.ipcMain.handle("term-create", (_e, cols, rows) => {
  const id = ptySeq++;
  const cwd = currentWorkspace();
  const shell = process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "zsh" : "bash";
  const shellArgs = process.platform === "win32" ? ["-NoLogo"] : [];
  const pty = nodePty.spawn(shell, shellArgs, {
    name: "xterm-256color",
    cols: Math.max(20, Math.min(cols || 80, 500)),
    rows: Math.max(5, Math.min(rows || 24, 200)),
    cwd,
    env: process.env
  });
  ptys.set(id, pty);
  pty.onData((d) => win?.webContents.send("term-data", id, d));
  pty.onExit(({ exitCode }) => {
    ptys.delete(id);
    win?.webContents.send("term-exit", id, exitCode);
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
import_electron.app.whenReady().then(async () => {
  import_electron.Menu.setApplicationMenu(null);
  import_electron.ipcMain.handle("pick-folder", async () => {
    if (!win) return null;
    const r = await import_electron.dialog.showOpenDialog(win, {
      title: "\u9009\u62E9\u9879\u76EE\u6587\u4EF6\u5939",
      properties: ["openDirectory", "createDirectory"]
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  import_electron.ipcMain.handle("get-projects", () => loadProjects());
  import_electron.ipcMain.handle("open-project", async (_e, p) => {
    if (!p || !import_fs.default.existsSync(p) || !import_fs.default.statSync(p).isDirectory()) return "invalid";
    const st = loadProjects();
    const same = st.current === p;
    if (!same) {
      st.current = p;
      st.recent = [p, ...st.recent.filter((x) => x !== p)].slice(0, 8);
      saveProjects(st);
      terminalWorkspace = p;
    }
    const state = same && await serverMatches(p) ? "attached" : await restartServerWithWorkspace(p);
    try {
      await win?.loadFile(import_path.default.join(__dirname, "renderer", "index.html"), {
        query: { ws: WS_URL, server: state }
      });
    } catch {
    }
    return state;
  });
  const projects = loadProjects();
  terminalWorkspace = projects.current;
  let serverState;
  if (projects.current) {
    serverState = await serverMatches(projects.current) ? "attached" : await restartServerWithWorkspace(projects.current);
  } else {
    serverState = await ensureServer();
  }
  if (serverState === "unavailable") {
    import_electron.dialog.showMessageBox({
      type: "warning",
      message: "my-harness daemon \u672A\u627E\u5230",
      detail: "\u672A\u80FD\u8FDE\u63A5\u6216\u542F\u52A8 harness serve\u3002\n\u8BF7\u786E\u8BA4 `harness` \u5728 PATH \u4E2D\uFF08pip install -e .\uFF09\uFF0C\u6216\u91CD\u65B0\u6253\u5305\u4EE5\u5185\u5D4C harness-server.exe\u3002"
    });
  }
  win = new import_electron.BrowserWindow({
    width: 1280,
    height: 880,
    backgroundColor: "#111318",
    title: "My-Harness",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: import_path.default.join(__dirname, "preload.cjs")
    }
  });
  win.loadFile(import_path.default.join(__dirname, "renderer", "index.html"), {
    query: { ws: WS_URL, server: serverState }
  });
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
