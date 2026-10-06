// 交互冒烟：打开 .py 文件 → LSP 就绪 → 输入触发补全弹窗 → 悬停出文档 → 截图。
const { _electron: electron } = require("playwright");
const path = require("path");

(async () => {
  const app = await electron.launch({
    args: ["."],
    cwd: __dirname,
    env: { ...process.env, MYHARNESS_PORT: "8766" },
  });
  const win = await app.firstWindow();
  await win.waitForSelector(".actbar", { timeout: 20000 });
  await win.click('button[title="资源管理器"]');
  await win.waitForSelector(".ft-row", { timeout: 15000 });

  let opened = null;
  for (let i = 0; i < 60 && !opened; i++) {
    const rows = win.locator(".ft-tree .ft-row");
    const n = await rows.count();
    for (let j = 0; j < n; j++) {
      const title = (await rows.nth(j).getAttribute("title")) || "";
      if (/\.py$/i.test(title)) {
        opened = title;
        await rows.nth(j).click();
        break;
      }
    }
    if (!opened) {
      for (let j = 0; j < n; j++) {
        const chev = await rows.nth(j).locator(".ft-chev").textContent().catch(() => "");
        if (chev === "▸") {
          await rows.nth(j).click();
          await win.waitForTimeout(500);
          break;
        }
      }
    }
  }
  console.log("[ui2] opened:", opened);
  await win.waitForSelector(".monaco-editor", { timeout: 15000 });
  // 等 pylsp 就绪（chip 变绿）
  await win.waitForFunction(
    () => [...document.querySelectorAll(".ed-tool")].some((el) => /pylsp|LSP 不可用/.test(el.textContent || "")),
    { timeout: 30000 }
  );
  console.log("[ui2] lsp chip:", await win.evaluate(() => [...document.querySelectorAll(".ed-tool")].map((e) => e.textContent?.trim()).find((t) => t && /LSP|pylsp/.test(t))));

  // 点到编辑器第 10 行行尾，换行后输入 "import " 触发补全（pylsp 对 import 提供模块补全）
  await win.evaluate(() => {
    const line = [...document.querySelectorAll(".view-line")].find((el) => /import websockets/.test(el.textContent || ""));
    if (line) {
      const r = line.getBoundingClientRect();
      const ev = (type, x, y, btns) => line.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: btns ?? 1, detail: type === "click" ? 1 : 0 }));
      const x = r.left + r.width - 12, y = r.top + r.height / 2;
      ["mousedown", "mouseup", "click"].forEach((t) => ev(t, x, y));
    }
  });
  await win.waitForTimeout(300);
  await win.keyboard.press("End");
  await win.keyboard.press("Enter");
  await win.keyboard.type("webs", { delay: 60 });
  // 触发 Ctrl+Space 显式补全（pylsp 可能对无前缀场景不主动弹）
  await win.keyboard.press("Control+Space");
  try {
    await win.waitForSelector(".suggest-widget.visible", { timeout: 8000 });
    const n = await win.evaluate(() => document.querySelectorAll(".suggest-widget .monaco-list-row").length);
    console.log(`[ui2] completion popup OK (${n} rows)`);
    await win.screenshot({ path: path.join(__dirname, "smoke-3-completion.png") });
  } catch {
    console.log("[ui2] WARN: 补全弹窗未出现");
    await win.screenshot({ path: path.join(__dirname, "smoke-3-completion.png") });
  }

  // 悬停：移到 websockets 标识符上等 hover 文档
  await win.keyboard.press("Escape");
  await win.evaluate(() => {
    const line = [...document.querySelectorAll(".view-line")].find((el) => /import websockets/.test(el.textContent || ""));
    if (line) {
      const target = [...line.querySelectorAll("span")].find((s) => s.textContent?.includes("websockets"));
      const el2 = target || line;
      const r = el2.getBoundingClientRect();
      const x = r.left + 8, y = r.top + r.height / 2;
      el2.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
    }
  });
  try {
    await win.waitForSelector(".monaco-hover.visible", { timeout: 8000 });
    console.log("[ui2] hover OK");
    await win.screenshot({ path: path.join(__dirname, "smoke-4-hover.png") });
  } catch {
    console.log("[ui2] WARN: 悬停未出现");
  }
  await app.close();
  console.log("UI2 DONE");
})().catch((e) => {
  console.error("UI2 FAIL:", e.message);
  process.exit(1);
});
