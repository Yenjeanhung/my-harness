// 冒烟：运行 Python 文件链路（编辑器 ▶ 运行按钮 / 右键菜单 / 终端面板联动）+ LSP 角标渲染。
// 连 8767 的 QA daemon（workspace=python-study，跑的是带 SetWorkspace 的新内核）。
const { _electron: electron } = require("playwright");

(async () => {
  const app = await electron.launch({
    args: ["."],
    cwd: "D:/myWorkspace/AI_project/my-harness/apps/desktop",
    env: { ...process.env, MYHARNESS_PORT: "8767" },
  });
  const win = await app.firstWindow();
  win.on("console", (m) => {
    if (m.type() === "error") console.log("[console]", m.text().slice(0, 160));
  });
  await win.waitForSelector(".mode-switch", { timeout: 25000 }); // 顶栏自绘（会话模式默认，活动栏是代码模式专属）
  console.log("[q] window up:", win.url().slice(0, 80));

  await win.click('button[title*="代码模式"]');
  await win.waitForSelector(".actbar", { timeout: 10000 });
  for (let i = 0; i < 5; i++) {
    try {
      await win.click('button[title="资源管理器"]', { timeout: 5000 });
      await win.waitForSelector(".ft-row", { timeout: 6000 });
      break;
    } catch (e) {
      if (i === 4) throw e;
      console.log("[q] retry explorer click");
      await win.waitForTimeout(1500);
    }
  }
  console.log("[q] code mode + file tree");

  // 展开找 chapter_03_列表/cars.py
  let opened = false;
  for (let i = 0; i < 60 && !opened; i++) {
    const rows = win.locator(".ft-tree .ft-row");
    const n = await rows.count();
    for (let j = 0; j < n; j++) {
      const title = (await rows.nth(j).getAttribute("title")) || "";
      if (title === "chapter_03_列表/cars.py") {
        await rows.nth(j).click();
        opened = true;
        break;
      }
    }
    if (!opened) {
      for (let j = 0; j < n; j++) {
        const title = (await rows.nth(j).getAttribute("title")) || "";
        const chev = await rows.nth(j).locator(".ft-chev").textContent().catch(() => "");
        if (chev === "▸" && (title === "" || title === "chapter_03_列表")) {
          await rows.nth(j).click();
          await win.waitForTimeout(500);
          break;
        }
      }
    }
  }
  if (!opened) throw new Error("cars.py not found in tree");
  await win.waitForSelector(".monaco-editor", { timeout: 15000 });
  console.log("[q] cars.py opened");

  // 1) 工具栏出现「运行」按钮（py 文件专属）
  await win.waitForSelector('.ed-tool:has-text("运行")', { timeout: 5000 });
  console.log("[q] toolbar run button OK");

  // 2) 右键菜单含「运行 Python 文件」
  await win.click(".view-lines", { position: { x: 60, y: 30 }, button: "right" });
  await win.waitForSelector(".edmenu", { timeout: 5000 });
  const menuText = await win.locator(".edmenu").innerText();
  if (!menuText.includes("运行 Python 文件")) throw new Error("context menu missing run item:\n" + menuText);
  console.log("[q] context menu run item OK");
  await win.mouse.click(940, 120); // 关掉右键菜单（点 tab 条空白处）
  await win.waitForSelector(".edmenu", { state: "detached", timeout: 5000 }).catch(() => {});

  // 3) 点「运行」→ 终端面板打开 + 出现终端 tab（命令已写入 pty）
  await win.locator('.ed-tool:has-text("运行")').first().click();
  await win.waitForSelector(".term-panel", { timeout: 8000 });
  await win.waitForSelector(".term-tab", { timeout: 20000 });
  console.log("[q] terminal panel + tab OK");

  // 4) LSP 角标（本机可能没有 pylsp/pyright：不可用=黄色，可用=绿色名字，两态都算过）
  await win.waitForTimeout(1500);
  const chip = await win.locator(".ed-tabs .ed-tool").allInnerTexts();
  console.log("[q] chips:", JSON.stringify(chip));

  await win.waitForTimeout(9000);
  await win.screenshot({ path: "D:/myWorkspace/AI_project/my-harness/.qa-sandbox/runpy-9s.png" });
  await win.waitForTimeout(9000); // 等终端命令回显/执行（PowerShell 首启可能很慢）
  await win.screenshot({ path: "D:/myWorkspace/AI_project/my-harness/.qa-sandbox/runpy-state.png" });
  console.log("[q] screenshot saved");
  await app.close();
  console.log("SMOKE PASS");
  process.exit(0);
})().catch(async (e) => {
  console.error("SMOKE FAIL:", e && e.message ? e.message.split("\n")[0] : e);
  process.exit(1);
});
