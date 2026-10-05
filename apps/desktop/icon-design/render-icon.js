// 图标构建：icon.html（1024px 透明底）→ Electron 截图 → icon-1024.png → Pillow 生成全尺寸 build/icon.ico
// 用法：1) npx electron icon-design/render-icon.js   2) venv python icon-design/make-ico.py
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    transparent: true,
    frame: false,
  });
  await win.loadFile(path.join(__dirname, "icon.html"));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const out = path.join(__dirname, "icon-1024.png");
  fs.writeFileSync(out, img.toPNG());
  console.log("saved", out);
  app.exit(0);
});
