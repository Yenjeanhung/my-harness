// SCM 按钮三态截图：推送中(整行) / 提交中(主按钮转圈) / 常态(分体+徽标)
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
  const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { clearTimeout(timer); ws.removeEventListener("message", on); resolve(m.result); } };
  ws.addEventListener("message", on);
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true }))?.result?.value;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const PUSH_ICON = `<svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='M12 17V3'></path><path d='m6 9 6-6 6 6'></path><path d='M19 21H5'></path></svg>`;
const html = `
  <div class='git-commit-row pushing' style='margin-bottom:10px;'><button class='git-commit-alt push-wrap'><span class='spin'></span> 推送中…</button></div>
  <div class='git-commit-row' style='margin-bottom:10px;'><button class='git-commit' disabled><span class='spin'></span> 提交中…</button><button class='git-commit-alt push-wrap' disabled>${PUSH_ICON}</button></div>
  <div class='git-commit-row'><button class='git-commit'>✓ 提交（2）</button><button class='git-commit-alt push-wrap'>${PUSH_ICON}<b class='push-badge'>3</b></button></div>`;
const ok = await ev(`(() => {
  const old = document.getElementById('qa-scm');
  if (old) old.remove();
  const host = document.createElement('div');
  host.id = 'qa-scm';
  host.style.cssText = 'position:fixed;left:12px;top:60px;width:320px;z-index:9999;background:#181c23;border:1px solid #30363d;border-radius:10px;padding:12px;';
  host.innerHTML = ${JSON.stringify(html)};
  document.body.appendChild(host);
  return 'ok';
})()`);
console.log("inject:", ok);
await sleep(300);
const s = await call("Page.captureScreenshot", { format: "png", fromSurface: false, clip: { x: 0, y: 40, width: 360, height: 220, scale: 2 } });
fs.writeFileSync("D:/myWorkspace/AI_project/my-harness/.qa-sandbox/scm-states.png", Buffer.from(s.data, "base64"));
await ev(`document.getElementById('qa-scm')?.remove()`);
console.log("captured scm-states.png");
process.exit(0);
