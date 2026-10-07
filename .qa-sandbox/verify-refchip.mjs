// 引用卡片 QA：CodeBuddy 式输入框引用芯片（文件类型图标）端到端验证
// 流程：注入 WS 拦截（吞掉 SendMessage）→ 重载进新 bundle → 切代码模式 → 打开 PACKAGING.md
//      → 编辑器选两行 → 右键「添加到对话（引用卡片）」→ 断言芯片行 → 输入文字发送
//      → 断言拦截到的 composed 含 [引用] 代码块、气泡渲染芯片 → 清理（移除拦截并重载）
import fs from "node:fs";
const PORT = process.argv[2] || "9335";
const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const list = await r.json();
const page = list.find((t) => t.type === "page" && /index\.html/.test(t.url || ""));
if (!page) { console.error("page not found"); process.exit(1); }
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
const shot = async (name) => {
  const s = await Promise.race([call("Page.captureScreenshot", { format: "png", fromSurface: false }), sleep(8000).then(() => null)]);
  if (s) { fs.writeFileSync(`D:/myWorkspace/AI_project/my-harness/.qa-sandbox/${name}.png`, Buffer.from(s.data, "base64")); console.log("saved", name); }
};
const clickFull = (sel) => ev(`
  (() => {
    const b = document.querySelector('${sel}');
    if (!b) return "none";
    const o = { bubbles: true, cancelable: true };
    b.dispatchEvent(new MouseEvent("mousedown", o));
    b.dispatchEvent(new MouseEvent("mouseup", o));
    b.dispatchEvent(new MouseEvent("click", o));
    return "clicked";
  })()
`);

await call("Page.enable", {});
// 1) 文档启动前注入 WS 拦截：SendMessage 只记不发（本地回显照常，服务端无感知）
const injected = await call("Page.addScriptToEvaluateOnNewDocument", { source: `
  (() => {
    window.__qaSent = [];
    const Orig = window.WebSocket;
    function Patched(url, protocols) {
      const w = protocols !== undefined ? new Orig(url, protocols) : new Orig(url);
      const origSend = w.send.bind(w);
      w.send = (data) => {
        const s = typeof data === "string" ? data : "";
        if (s.includes('"SendMessage"')) { window.__qaSent.push(s.slice(0, 6000)); return; }
        return origSend(data);
      };
      return w;
    }
    Patched.prototype = Orig.prototype;
    Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = Patched;
  })()
` });
// 2) 重载进新 bundle（等导航落定再 evaluate，避免打在被销毁的旧上下文上挂死）
await call("Page.reload", { ignoreCache: true });
await sleep(2000);
// 等 conn open（#input 可用）
let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    if (await ev(`!document.querySelector('#input')?.disabled`)) { ready = true; break; }
  } catch { /* 上下文切换中，继续等 */ }
}
console.log("conn open:", ready);
// 新 bundle 证据：.ftbadge 样式类已存在
console.log("ftbadge style:", await ev(`(() => { const s = document.createElement('span'); s.className='ftbadge'; document.body.appendChild(s); const ok = getComputedStyle(s).display === 'inline-flex'; s.remove(); return ok; })()`));
// 3) 切代码模式
console.log("mode switch:", await clickFull(".mode-switch"));
// 4) 打开 PACKAGING.md（根目录文件，md 蓝色 M 徽标）；树渲染需要 ListDir 往返，轮询等行出现
let opened = "not-found";
for (let i = 0; i < 12; i++) {
  await sleep(500);
  opened = await ev(`(() => { const row = [...document.querySelectorAll('[data-ft-path]')].find(e => (e.dataset.ftPath || '') === 'PACKAGING.md'); if (!row) return "not-found"; row.click(); return "PACKAGING.md"; })()`);
  if (opened !== "not-found") break;
}
console.log("open file:", opened);
await sleep(1500);
// 5) 编辑器内选前两行：真实鼠标点击聚焦 → Ctrl+Home → Shift+↓×2
const rect = await ev(`JSON.stringify((() => { const r = document.querySelector('.ed-host')?.getBoundingClientRect(); return r ? { x: Math.round(r.left + 260), y: Math.round(r.top + 60) } : null; })())`);
if (!rect || rect === "null") { console.error("editor host not found"); process.exit(1); }
const { x, y } = JSON.parse(rect);
await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
await sleep(400);
const key = (type, opts) => call("Input.dispatchKeyEvent", { type, ...opts });
await key("keyDown", { modifiers: 2, key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
await key("keyUp", { key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
for (let i = 0; i < 2; i++) {
  await key("keyDown", { modifiers: 8, key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await key("keyUp", { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await sleep(80);
}
await sleep(300);
// 6) 右键 → 自绘菜单 → 添加到对话（引用卡片）
await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1 });
await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1 });
await sleep(400);
console.log("menu item:", await ev(`(() => { const mi = [...document.querySelectorAll('.edmenu .mi')].find(m => m.textContent.includes('添加到对话')); if (!mi) return "not-found"; const o = { bubbles: true, cancelable: true }; mi.dispatchEvent(new MouseEvent('mousedown', o)); mi.dispatchEvent(new MouseEvent('mouseup', o)); mi.dispatchEvent(new MouseEvent('click', o)); return mi.textContent; })()`));
await sleep(500);
console.log("input chips:", await ev(`JSON.stringify([...document.querySelectorAll('.composer .atchips .refchip')].map(c => ({ text: c.textContent.trim(), badge: c.querySelector('.ftbadge')?.textContent, badgeBg: c.querySelector('.ftbadge')?.style.background })))`));
await shot("refchip-input");
// 7) 输入正文并发送（Enter）
await ev(`(() => { const ta = document.querySelector('#input'); ta.focus(); document.execCommand('insertText', false, 'QA 引用卡片测试'); return true; })()`);
await sleep(300);
await ev(`(() => { const ta = document.querySelector('#input'); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); return true; })()`);
await sleep(600);
console.log("sent:", await ev(`JSON.stringify({ n: (window.__qaSent || []).length, first: (window.__qaSent || [])[0]?.slice(0, 300), hasRef: (window.__qaSent[0] || '').includes('[引用] PACKAGING.md:1-2'), hasCode: (window.__qaSent[0] || '').includes('\\u0060\\u0060\\u0060'), inputCleared: document.querySelector('#input')?.value === '', chipsCleared: document.querySelectorAll('.composer .atchips .refchip').length })`));
console.log("bubble chips:", await ev(`JSON.stringify([...document.querySelectorAll('.msg.user .refchip')].map(c => ({ text: c.textContent.trim(), badge: c.querySelector('.ftbadge')?.textContent })))`));
console.log("bubble text:", await ev(`JSON.stringify([...document.querySelectorAll('.msg.user .bubble')].map(b => b.textContent.trim()).pop())`));
await shot("refchip-bubble");
// 8) 清理：移除拦截脚本并重载（被吞的消息本地回显随重载消失，服务端本就没收到）
await call("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected.identifier });
await call("Page.reload", { ignoreCache: true });
await sleep(2500);
console.log("done");
process.exit(0);
