// 修复效果测量：第 1 次进代码模式 vs 会话⇄代码往返，各阶段的树就绪耗时 + 长任务
const PORT = process.argv[2] || "9222";
const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const list = await r.json();
const page = list.find((t) => t.type === "page" && /index\.html/.test(t.url || ""));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener("open", res));
let mid = 0;
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++mid;
  const timer = setTimeout(() => reject(new Error(`cdp timeout: ${method}`)), 10000);
  const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { clearTimeout(timer); ws.removeEventListener("message", on); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
  ws.addEventListener("message", on);
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true }))?.result?.value;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const clickMode = () => ev(`(() => { const b = document.querySelector('.mode-switch'); const o = { bubbles: true, cancelable: true }; b.dispatchEvent(new MouseEvent('mousedown', o)); b.dispatchEvent(new MouseEvent('mouseup', o)); b.dispatchEvent(new MouseEvent('click', o)); return 1; })()`);
const waitRows = async () => {
  const t0 = await ev(`Math.round(performance.now())`);
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    const n = await ev(`document.querySelectorAll('[data-ft-path]').length`);
    if (n > 0) return { ms: (await ev(`Math.round(performance.now())`)) - t0, rows: n };
  }
  return { ms: -1, rows: 0 };
};

await call("Page.enable", {});
await call("Page.reload", { ignoreCache: true });
await sleep(2000);
let ready = false;
for (let i = 0; i < 40; i++) { await sleep(500); try { if (await ev(`!document.querySelector('#input')?.disabled`)) { ready = true; break; } } catch {} }
console.log("conn open:", ready);
await sleep(1000);
await ev(`window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ entryTypes: ['longtask'] }); } catch {}`);

const run = async (label) => {
  await ev(`window.__lt.length = 0`);
  const t = Date.now();
  await clickMode();
  const rr = await waitRows();
  console.log(`${label}: 树就绪 ${rr.ms}ms (rows=${rr.rows}), 墙钟 ${Date.now() - t}ms, 长任务: ${JSON.stringify(await ev(`JSON.stringify(window.__lt)`))}`);
};
await run("① 首次进代码模式(冷 reload 后)");
// 往返：回会话 → 再进代码
await clickMode(); // 回会话模式
await sleep(700);
await run("② 会话→代码 第 2 次");
await clickMode();
await sleep(700);
await run("③ 会话→代码 第 3 次");
process.exit(0);
