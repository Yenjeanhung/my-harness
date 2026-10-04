// Electron 主进程：确保 my-harness daemon 在跑（附着已有 → 内嵌 sidecar → PATH 上的 harness），
// 再打开窗口。渲染进程是纯 Web 页面，连 ws://127.0.0.1:<port>/ws —— 与 CLI 共用同一协议。
const { app, BrowserWindow, dialog, Menu } = require("electron");
const { spawn, exec } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.MYHARNESS_PORT || "8765";
const HTTP_BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const APP_VERSION = app.getVersion(); // 与 Python 端 harness.__version__ 保持同步
let sidecar = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probeHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${HTTP_BASE}/health`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
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
  // 仅在版本握手失败（旧 daemon / 未知服务占口）时调用
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise((resolve) => {
    exec(`netstat -ano | findstr LISTENING | findstr :${port}`, (err, stdout) => {
      const pids = new Set();
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

async function ensureServer() {
  const h = await probeHealth();
  if (h.ok) {
    if (h.version === APP_VERSION) return "attached";
    // 版本不匹配（含旧版无 version 字段）：清掉旧 daemon，用内嵌 sidecar 重启
    await killPortListeners(PORT);
    await sleep(800);
    staleRestarted = true;
  }
  const attempts = [];
  if (process.resourcesPath) {
    const f = path.join(process.resourcesPath, "harness-server.exe");
    if (fs.existsSync(f)) attempts.push({ file: f, args: ["--port", PORT] });
  }
  attempts.push({
    cmd: process.platform === "win32" ? "harness.exe" : "harness",
    args: ["serve", "--port", PORT],
  });
  for (const a of attempts) {
    try {
      sidecar = spawn(a.file || a.cmd, a.args, { stdio: "ignore" });
      sidecar.on("error", () => {});
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

let staleRestarted = false;

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // 去掉默认菜单栏（File/Edit/View/...）
  const serverState = await ensureServer();
  if (serverState === "unavailable") {
    dialog.showMessageBox({
      type: "warning",
      message: "my-harness daemon 未找到",
      detail:
        "未能连接或启动 harness serve。\n请确认 `harness` 在 PATH 中（pip install -e .），" +
        "或重新打包以内嵌 harness-server.exe。",
    });
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 880,
    backgroundColor: "#111318",
    title: "My-Harness",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { ws: WS_URL, server: serverState },
  });
});

app.on("window-all-closed", () => {
  if (sidecar) sidecar.kill();
  app.quit();
});
