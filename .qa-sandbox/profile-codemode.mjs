// 用 CDP CPU Profiler 抓进代码模式那 4.5s 长任务的热点
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
  const timer = setTimeout(() => reject(new Error(`cdp timeout: ${method}`)), 30000);
  const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { clearTimeout(timer); ws.removeEventListener("message", on); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
  ws.addEventListener("message", on);
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => (await call("Runtime.evaluate", { expression: expr, returnByValue: true }))?.result?.value;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

await call("Page.enable", {});
await call("Page.reload", { ignoreCache: true });
await sleep(2000);
let ready = false;
for (let i = 0; i < 40; i++) { await sleep(500); try { if (await ev(`!document.querySelector('#input')?.disabled`)) { ready = true; break; } } catch {} }
console.log("conn open:", ready);
await sleep(1200);
// 是否已进过代码模式（editorMounted）？冷启动重载后必然没进过
await call("Profiler.enable", {});
await call("Profiler.setSamplingInterval", { interval: 200 });
await call("Profiler.start", {});
await ev(`(() => { const b = document.querySelector('.mode-switch'); const o = { bubbles: true, cancelable: true }; b.dispatchEvent(new MouseEvent('mousedown', o)); b.dispatchEvent(new MouseEvent('mouseup', o)); b.dispatchEvent(new MouseEvent('click', o)); return 1; })()`);
console.log("clicked, profiling...");
await sleep(9000);
const { profile } = await call("Profiler.stop", {});
// 聚合自顶 down：找叶子热点
const nodesById = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const total = profile.samples.length;
for (const s of profile.samples) self.set(s.nodeId, (self.get(s.nodeId) || 0) + 1);
const hot = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
const fmt = (n) => { const cf = n.callFrame; return `${cf.functionName || "(anon)"} @ ${(cf.url || "").split("/").pop()}:${cf.lineNumber + 1}`; };
const fmt2 = (n) => { if (!n) return "(missing-node)"; const cf = n.callFrame; return `${cf.functionName || "(anon)"} @ ${(cf.url || "").split("/").pop()}:${cf.lineNumber + 1}`; };
console.log(`samples=${total}`);
for (const [id, n] of hot) console.log(`${((n / total) * 100).toFixed(1)}%  ${fmt2(nodesById.get(id))}`);
// 父链：把最热叶子的调用链打出来
const parentOf = new Map();
for (const nd of profile.nodes) for (const c of nd.children || []) parentOf.set(c, nd.id);
console.log("--- hottest chain ---");
let cur = hot[0]?.[0];
const chain = [];
while (cur && chain.length < 18) { chain.push(fmt2(nodesById.get(cur))); cur = parentOf.get(cur); }
chain.forEach((f, i) => console.log("  ".repeat(i) + f));
fs.writeFileSync("D:/myWorkspace/AI_project/my-harness/.qa-sandbox/tmp/profile.json", JSON.stringify(profile));
process.exit(0);
