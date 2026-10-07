// 代码模式加载性能测量：WS 流量时间戳 + longtask 观察 + DOM 就绪时刻，拆出瓶颈段
import fs from "node:fs";
const PORT = process.argv[2] || "9222";
const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const list = await r.json();
const page = list.find((t) => t.type === "page" && /index\.html/.test(t.url || ""));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener("open", res));
let mid = 0;
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++mid;
  const timer = setTimeout(() => reject(new Error(`cdp timeout: ${method}`)), 8000);
  const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { clearTimeout(timer); ws.removeEventListener("message", on); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
  ws.addEventListener("message", on);
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true }))?.result?.value;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

await call("Page.enable", {});
// 注入：WS 全量流量日志 + longtask 记录（点击后由 __qaMark 分段）
await call("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__wslog = [];
  window.__longtasks = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longtasks.push({ s: Math.round(e.startTime), d: Math.round(e.duration), n: e.name }); }).observe({ entryTypes: ['longtask'] }); } catch {}
  const Orig = window.WebSocket;
  function Patched(url, protocols) {
    const w = protocols !== undefined ? new Orig(url, protocols) : new Orig(url);
    const origSend = w.send.bind(w);
    w.send = (data) => {
      try { const m = JSON.parse(data); window.__wslog.push({ t: Math.round(performance.now()), dir: 'SEND', type: m.type }); } catch {}
      return origSend(data);
    };
    let onmsg = null;
    Object.defineProperty(w, 'onmessage', {
      get() { return onmsg; },
      set(fn) { onmsg = fn; w.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); window.__wslog.push({ t: Math.round(performance.now()), dir: 'RECV', type: m.type, n: (m.entries || m.sessions || m.files || []).length || undefined }); } catch {} fn.call(w, e); }); },
    });
    return w;
  }
  Patched.prototype = Orig.prototype;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Patched;
` });
await call("Page.reload", { ignoreCache: true });
await sleep(2000);
let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try { if (await ev(`!document.querySelector('#input')?.disabled`)) { ready = true; break; } } catch {}
}
console.log("conn open:", ready);
await sleep(1500); // 等启动期流量落定
await ev(`window.__wslog.length = 0; window.__longtasks.length = 0;`);
// 记录基线并点击切换
const t0 = await ev(`(window.__t0 = Math.round(performance.now()), window.__t0)`);
await ev(`(() => { const b = document.querySelector('.mode-switch'); const o = { bubbles: true, cancelable: true }; b.dispatchEvent(new MouseEvent('mousedown', o)); b.dispatchEvent(new MouseEvent('mouseup', o)); b.dispatchEvent(new MouseEvent('click', o)); return 1; })()`);
// 轮询 DOM 就绪
let rows = 0, tRows = 0;
for (let i = 0; i < 60; i++) {
  await sleep(200);
  rows = await ev(`document.querySelectorAll('[data-ft-path]').length`);
  if (rows > 0) { tRows = await ev(`Math.round(performance.now())`); break; }
}
console.log(JSON.stringify({ t0, tRows, clickToRowsMs: tRows - t0, rows }));
// 等附加目录列表都回来
await sleep(1500);
const log = await ev(`JSON.stringify({ ws: window.__wslog, lt: window.__longtasks })`);
const { ws: traffic, lt } = JSON.parse(log);
const rel = traffic.filter((e) => e.t >= t0 - 200).map((e) => ({ ...e, dt: e.t - t0 }));
console.log("--- WS traffic after click (dt ms, dir, type, n) ---");
for (const e of rel) console.log(`${String(e.dt).padStart(6)} ${e.dir} ${e.type}${e.n != null ? " n=" + e.n : ""}`);
console.log("--- longtasks (start dt, dur) ---");
for (const e of lt.filter((x) => x.s >= t0 - 500)) console.log(`start=${Math.round(e.s - t0)}ms dur=${e.d}ms`);
fs.writeFileSync("D:/myWorkspace/AI_project/my-harness/.qa-sandbox/tmp/codemode-perf.json", JSON.stringify({ rel, lt }, null, 1));
process.exit(0);
