const { app, BrowserWindow } = require("electron");
const path = require("path");
const src = process.argv[2] || "preview.html";
const out = process.argv[3] || src.replace(/\.html$/, ".png");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 920 });
  await win.loadFile(path.join(__dirname, src));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  require("fs").writeFileSync(path.join(__dirname, out), img.toPNG());
  console.log("saved", out);
  app.exit(0);
});
