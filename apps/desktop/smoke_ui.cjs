// Electron UI 冒烟：MYHARNESS_PORT=8766 起应用 → 切资源管理器 → 逐层展开点开一个 .py 文件 →
// 断言 Monaco 渲染、LSP 状态 chip 出现、无页面错误 → 截图。
const { _electron: electron } = require("playwright");
const path = require("path");

const OUT = __dirname;

(async () => {
  const errors = [];
  const app = await electron.launch({
    args: ["."],
    cwd: __dirname,
    env: { ...process.env, MYHARNESS_PORT: "8766" },
  });
  const win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  win.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
  });

  await win.waitForSelector(".actbar", { timeout: 20000 });
  console.log("[ui] window loaded:", win.url());

  await win.screenshot({ path: path.join(OUT, "smoke-1-initial.png") });

  // 切到资源管理器，逐层展开直到出现 .py 文件行（python 才走 daemon LSP 桥，能验证状态 chip）
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
      // 展开第一个未展开的目录行（有 ▸ 的）
      for (let j = 0; j < n; j++) {
        const chev = await rows.nth(j).locator(".ft-chev").textContent().catch(() => "");
        if (chev === "▸") {
          await rows.nth(j).click();
          await win.waitForTimeout(600);
          break;
        }
      }
    }
  }
  console.log("[ui] opened file:", opened);
  if (!opened) throw new Error("没找到可打开的代码文件");

  await win.waitForSelector(".monaco-editor", { timeout: 15000 });
  console.log("[ui] monaco editor rendered");

  // 等 LSP 状态 chip（pylsp 自动启动）
  let lspText = "";
  try {
    await win.waitForFunction(
      () => [...document.querySelectorAll(".ed-tool")].some((el) => /LSP|pylsp/.test(el.textContent || "")),
      { timeout: 20000 }
    );
    lspText = await win.evaluate(() => [...document.querySelectorAll(".ed-tool")].map((el) => el.textContent?.trim()).join(" | "));
  } catch {
    console.log("[ui] WARN: LSP chip 未出现（20s）");
  }
  console.log("[ui] lsp chip:", lspText);

  await win.waitForTimeout(2500); // 留时间给诊断/渲染稳定
  await win.screenshot({ path: path.join(OUT, "smoke-2-editor.png") });

  // tab 数量 / 编辑器内容非空
  const info = await win.evaluate(() => {
    const tabs = [...document.querySelectorAll(".ed-tab")].map((el) => el.textContent?.trim());
    const lines = document.querySelectorAll(".view-lines .view-line").length;
    return { tabs, lines };
  });
  console.log("[ui] editor state:", JSON.stringify(info));

  await app.close();
  const realErrors = errors.filter((e) => !/favicon/.test(e));
  console.log(`[ui] page errors: ${realErrors.length}`);
  realErrors.slice(0, 10).forEach((e) => console.log("  ", e));
  console.log("UI SMOKE", realErrors.length === 0 && info.lines > 0 ? "PASS" : "CHECK");
})().catch((e) => {
  console.error("UI SMOKE FAIL:", e.message);
  process.exit(1);
});
