// 深度冒烟：打开 src/harness/server/app.py → 等 pylsp → 悬停 LspManager（真实鼠标）→
// Ctrl+点击跳转定义 → 断言新 tab 打开了 lsp.py（LSP definition + editor opener + openFile 全链路）。
const { _electron: electron } = require("playwright");

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
  for (let i = 0; i < 120 && !opened; i++) {
    const rows = win.locator(".ft-tree .ft-row");
    const n = await rows.count();
    for (let j = 0; j < n; j++) {
      const title = (await rows.nth(j).getAttribute("title")) || "";
      if (/server\/app\.py$/.test(title)) {
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
          await win.waitForTimeout(400);
          break;
        }
      }
    }
  }
  console.log("[ui3] opened:", opened);
  await win.waitForSelector(".monaco-editor", { timeout: 15000 });
  await win.waitForFunction(
    () => [...document.querySelectorAll(".ed-tool")].some((el) => /pylsp/.test(el.textContent || "")),
    { timeout: 30000 }
  );
  console.log("[ui3] pylsp ready, waiting for index…");
  await win.waitForTimeout(4000); // pylsp 首次分析该文件

  // 先点进编辑器拿到焦点（真实鼠标），翻页找到 import 行（Monaco 虚拟滚动，不可视行没有 DOM）
  await win.click(".view-lines", { position: { x: 40, y: 30 } });
  await win.waitForTimeout(300);
  await win.keyboard.press("Control+Home");
  await win.waitForTimeout(200);
  for (let i = 0; i < 8; i++) {
    const hit = await win.evaluate(() => {
      const line = [...document.querySelectorAll(".view-line")].find((el) => /importLspManager/.test((el.textContent || "").replace(/\s/g, "")));
      if (!line) return null;
      // 在词元 span 里精确定位 LspManager 的横向中点（span 可能含相邻文本，按字符比例折算）
      const spans = [...line.querySelectorAll("span")];
      for (const s of spans) {
        const t = s.textContent || "";
        const i = t.indexOf("LspManager");
        if (i < 0) continue;
        const r = s.getBoundingClientRect();
        return { x: r.left + r.width * ((i + "LspManager".length / 2) / t.length), y: r.top + r.height / 2 };
      }
      return null;
    });
    if (hit) {
      var pos = hit;
      break;
    }
    await win.keyboard.press("PageDown");
    await win.waitForTimeout(350);
  }
  if (!pos) throw new Error("没找到 LspManager 所在行");
  console.log("[ui3] target word at", JSON.stringify(pos));

  // 真实鼠标悬停（分步移动，模拟人的指针轨迹）
  await win.mouse.move(pos.x - 60, pos.y - 40);
  await win.mouse.move(pos.x, pos.y, { steps: 8 });
  await win.waitForTimeout(1500);
  const hoverVisible = await win.evaluate(() => !!document.querySelector(".monaco-hover.visible"));
  console.log("[ui3] hover:", hoverVisible ? "OK" : "not shown");
  await win.screenshot({ path: __dirname + "/smoke-4-hover.png" });
  await win.mouse.move(pos.x + 40, pos.y + 60); // 移开（避免 hover 挡住点击）
  await win.waitForTimeout(600);

  // Ctrl+点击 → 跳转定义（pylsp 返回工作区内 URI → opener → openFile 打开 lsp.py）
  await win.keyboard.down("Control");
  await win.mouse.click(pos.x, pos.y);
  await win.keyboard.up("Control");
  await win.waitForTimeout(3500);
  const tabs = await win.evaluate(() => [...document.querySelectorAll(".ed-tab .ed-name")].map((el) => el.textContent?.trim()));
  console.log("[ui3] tabs after ctrl+click:", JSON.stringify(tabs));
  const ok = tabs.some((t) => t && t.includes("lsp.py"));
  await win.screenshot({ path: __dirname + "/smoke-5-gotodef.png" });
  await app.close();
  console.log("UI3", ok ? "PASS" : "CHECK");
})().catch((e) => {
  console.error("UI3 FAIL:", e.message);
  process.exit(1);
});
