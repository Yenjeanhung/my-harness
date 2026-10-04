// 打包前置：把 PyInstaller 产物拷进项目内（electron-builder 的 extraResources 引用项目内路径最稳）
const fs = require("fs");
const path = require("path");

const src = path.resolve(__dirname, "../../packaging/dist/harness-server.exe");
const destDir = path.resolve(__dirname, "build");
const dest = path.join(destDir, "harness-server.exe");

if (!fs.existsSync(src)) {
  console.error(`[prepkg] missing sidecar: ${src}`);
  console.error("[prepkg] run the PyInstaller step first — see PACKAGING.md step 1");
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`[prepkg] ${src} -> ${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
