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
var PORT = process.env.MYHARNESS_PORT || "8765";
var HTTP_BASE = `http://127.0.0.1:${PORT}`;
var WS_URL = `ws://127.0.0.1:${PORT}/ws`;
var APP_VERSION = import_electron.app.getVersion();
var sidecar = null;
var staleRestarted = false;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function probeHealth() {
  return new Promise((resolve) => {
    const req = import_http.default.get(`${HTTP_BASE}/health`, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          resolve({ ok: res.statusCode === 200, version: j.version || null });
        } catch {
          resolve({ ok: false, version: null });
        }
      });
    });
    req.on("error", () => resolve({ ok: false, version: null }));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve({ ok: false, version: null });
    });
  });
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
async function ensureServer() {
  const h = await probeHealth();
  if (h.ok) {
    if (h.version === APP_VERSION) return "attached";
    await killPortListeners(PORT);
    await sleep(800);
    staleRestarted = true;
  }
  const attempts = [];
  if (process.resourcesPath) {
    const f = import_path.default.join(process.resourcesPath, "harness-server.exe");
    if (import_fs.default.existsSync(f)) attempts.push({ file: f, args: ["--port", PORT] });
  }
  attempts.push({
    cmd: process.platform === "win32" ? "harness.exe" : "harness",
    args: ["serve", "--port", PORT]
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
import_electron.app.whenReady().then(async () => {
  import_electron.Menu.setApplicationMenu(null);
  const serverState = await ensureServer();
  if (serverState === "unavailable") {
    import_electron.dialog.showMessageBox({
      type: "warning",
      message: "my-harness daemon \u672A\u627E\u5230",
      detail: "\u672A\u80FD\u8FDE\u63A5\u6216\u542F\u52A8 harness serve\u3002\n\u8BF7\u786E\u8BA4 `harness` \u5728 PATH \u4E2D\uFF08pip install -e .\uFF09\uFF0C\u6216\u91CD\u65B0\u6253\u5305\u4EE5\u5185\u5D4C harness-server.exe\u3002"
    });
  }
  const win = new import_electron.BrowserWindow({
    width: 1280,
    height: 880,
    backgroundColor: "#111318",
    title: "My-Harness",
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(import_path.default.join(__dirname, "renderer", "index.html"), {
    query: { ws: WS_URL, server: serverState }
  });
});
import_electron.app.on("window-all-closed", () => {
  if (sidecar) sidecar.kill();
  import_electron.app.quit();
});
