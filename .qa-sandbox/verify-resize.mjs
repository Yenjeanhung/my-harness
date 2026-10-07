// 输入框高度拖拽 QA v2：先清 localStorage → 拖上手柄 ↑/↓ → 双击复位；每步前重取手柄位置 + mouseMoved 预热
import fs from "node:fs";
const PORT = process.argv[2] || "9222";
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
const mouse = async (type, x, y, opts = {}) => call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: opts.clickCount || 1, ...(type === "mousePressed" ? { buttons: 1 } : type === "mouseReleased" ? { buttons: 0 } : {}) });
// 手柄中心（每次交互前重取）+ 按下前先 move 过去预热命中
const handle = async () => JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelector('.composer-resize')?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })())`));
const drag = async (dx, dy) => {
  const { x, y } = await handle();
  await mouse("mouseMoved", x, y);
  await mouse("mousePressed", x, y);
  for (const [mx, my] of [[x + dx / 3, y + dy / 3], [x + (2 * dx) / 3, y + (2 * dy) / 3], [x + dx, y + dy]]) await mouse("mouseMoved", Math.round(mx), Math.round(my));
  await mouse("mouseReleased", x + dx, y + dy);
};
const dbl = async () => {
  const { x, y } = await handle();
  await mouse("mouseMoved", x, y);
  await mouse("mousePressed", x, y, { clickCount: 2 });
  await mouse("mouseReleased", x, y, { clickCount: 2 });
};
const taH = () => ev(`Math.round(document.querySelector('#input').getBoundingClientRect().height)`);
const stored = () => ev(`localStorage.getItem('yh.composerH')`);

await call("Page.enable", {});
await call("Page.reload", { ignoreCache: true });
await sleep(2000);
let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try { if (await ev(`!document.querySelector('#input')?.disabled`)) { ready = true; break; } } catch {}
}
console.log("conn open:", ready);
console.log("mode switch:", await clickFull(".mode-switch"));
await sleep(900);
// 清掉历史手值，回到自动态基线
await ev(`localStorage.removeItem('yh.composerH')`);
await sleep(200);
const before = await taH();
console.log("baseline auto:", before, "| stored:", await stored());
await drag(0, -140);
await sleep(300);
const up = await taH();
console.log("after drag up 140:", up, "| delta:", up - before, "| stored:", await stored());
await shot("resize-up");
await drag(0, 80);
await sleep(300);
const down = await taH();
console.log("after drag down 80:", down, "| delta:", down - up, "| stored:", await stored());
await dbl();
await sleep(300);
console.log("after dblclick:", await taH(), "| stored:", await stored());
// 留一个加高手势 + 多行内容，截图给用户看效果
await drag(0, -120);
await sleep(300);
await ev(`(() => { const ta = document.querySelector('#input'); ta.focus(); document.execCommand('insertText', false, '第一行\\n第二行\\n第三行'); return true; })()`);
await sleep(300);
console.log("final:", await ev(`JSON.stringify({ h: Math.round(document.querySelector('#input').getBoundingClientRect().height), stored: localStorage.getItem('yh.composerH') })`));
await shot("resize-final");
process.exit(0);
