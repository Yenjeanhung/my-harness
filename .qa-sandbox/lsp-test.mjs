// LSP 桥 e2e：模拟渲染层修复后的行为——
// 1) LspStart python → LspStatus running（daemon 探测到 pylsp/pyright）
// 2) 并发发两个请求：initialize(id=1，模拟内置 MonacoLspClient) + textDocument/definition(id=1000001，
//    模拟修复后的直发请求) —— daemon 是哑管道，两个响应都应原样转发回来；
//    高位 id 保证渲染层配对不会拿到 initialize 的 capabilities
// 3) definition 应返回 src/harness/loop/react.py 的位置（ReActLoop 的定义处）
import fs from "node:fs";
const ws = new WebSocket("ws://127.0.0.1:8791/ws");
let step = 0;
const timeout = setTimeout(() => {
  console.error("FAIL: 超时（30s）——最后步骤:", step);
  process.exit(1);
}, 30000);

ws.onopen = () => {
  step = 1;
  ws.send(JSON.stringify({ type: "LspStart", language: "python" }));
};

const sendLsp = (message) => ws.send(JSON.stringify({ type: "LspToServer", language: "python", message }));

ws.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (e.type === "LspStatus") {
    if (e.status === "running") {
      console.log("LspStatus running:", e.detail);
      step = 2;
      const doc = { uri: "file:///D:/myWorkspace/AI_project/my-harness/examples/quickstart.py" };
      // 同时发：id=1（内置客户端风格）与 id=1000001（修复后的直发风格）
      sendLsp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: null, rootUri: "file:///D:/myWorkspace/AI_project/my-harness", capabilities: {} } });
    } else if (e.status === "error") {
      console.error("FAIL: LspStatus error:", e.detail);
      process.exit(1);
    }
  } else if (e.type === "LspFromServer") {
    const m = e.message || {};
    if (m.id === 1) {
      step = 3;
      const caps = m.result && m.result.capabilities;
      console.log("initialize 响应到达（capabilities:", caps ? Object.keys(caps).length + " 项" : "无", "）");
      // 与内置 MonacoLspClient 相同的握手收尾：initialized 通知 + didOpen
      sendLsp({ jsonrpc: "2.0", method: "initialized", params: {} });
      const text = fs.readFileSync("D:/myWorkspace/AI_project/my-harness/examples/quickstart.py", "utf8");
      sendLsp({
        jsonrpc: "2.0", method: "textDocument/didOpen",
        params: { textDocument: { uri: "file:///D:/myWorkspace/AI_project/my-harness/examples/quickstart.py", languageId: "python", version: 1, text } },
      });
      // didOpen 之后再发功能请求（模拟真实时序：页面加载 → 用户 Ctrl+点击）
      setTimeout(() => {
        const doc = { uri: "file:///D:/myWorkspace/AI_project/my-harness/examples/quickstart.py" };
        sendLsp({
          jsonrpc: "2.0", id: 1000001, method: "textDocument/definition",
          params: { textDocument: doc, position: { line: 13, character: 33 } }, // line14 col34 = ReActLoop
        });
        sendLsp({ jsonrpc: "2.0", id: 1000002, method: "textDocument/references", params: { textDocument: doc, position: { line: 13, character: 33 }, context: { includeDeclaration: true } } });
        sendLsp({ jsonrpc: "2.0", id: 1000003, method: "textDocument/definition", params: { textDocument: doc, position: { line: 10, character: 22 } } }); // pathlib.Path
        sendLsp({ jsonrpc: "2.0", id: 1000004, method: "textDocument/hover", params: { textDocument: doc, position: { line: 13, character: 33 } } });
      }, 800);
    }
    if (m.id === 1000001) {
      const loc = Array.isArray(m.result) ? m.result[0] : m.result;
      if (loc && (loc.uri || loc.targetUri)) {
        const uri = loc.uri || loc.targetUri;
        const ln = (loc.range || loc.targetSelectionRange).start.line + 1;
        console.log(`PASS: definition(ReActLoop) → ${decodeURIComponent(uri)}:${ln}`);
      } else {
        console.log("definition(ReActLoop) → 空", JSON.stringify(m.result).slice(0, 80));
      }
    }
    if (m.id === 1000002) {
      const n = Array.isArray(m.result) ? m.result.length : 0;
      console.log(`references(id=1000002) → ${n} 处`);
    }
    if (m.id === 1000003) {
      const loc = Array.isArray(m.result) ? m.result[0] : m.result;
      console.log("definition(Path) →", loc && loc.uri ? decodeURIComponent(loc.uri) + ":" + ((loc.range || {}).start?.line + 1) : JSON.stringify(m.result).slice(0, 120));
    }
    if (m.id === 1000004) {
      console.log("hover(ReActLoop) →", m.result && m.result.contents ? JSON.stringify(m.result.contents).slice(0, 160) : JSON.stringify(m.result).slice(0, 120));
      clearTimeout(timeout);
      ws.close();
      process.exit(0);
    }
  }
};
ws.onerror = (err) => {
  console.error("FAIL: ws 错误", err.message || err);
  process.exit(1);
};
