// 打包前置：把 PyInstaller 产物拷进项目内（electron-builder 的 extraResources 引用项目内路径最稳）
// 兼容两种产物位置：packaging/dist（历史约定）与仓库根 dist（PACKAGING.md 第 1 步的实际输出），取较新者。
// 注意：拷贝前请先按 PACKAGING.md 验证产物 /health 的 version 与 package.json 一致——
// 曾发生过「构建期间源码还在改，sidecar 打出半成品版本」的事故。
const fs = require("fs");
const path = require("path");

const candidates = [
  path.resolve(__dirname, "../../packaging/dist/harness-server.exe"),
  path.resolve(__dirname, "../../dist/harness-server.exe"),
];
const src = candidates
  .filter((f) => fs.existsSync(f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const destDir = path.resolve(__dirname, "build");
const dest = path.join(destDir, "harness-server.exe");

if (!src) {
  console.error(`[prepkg] missing sidecar: looked in\n  ${candidates.join("\n  ")}`);
  console.error("[prepkg] run the PyInstaller step first — see PACKAGING.md step 1");
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`[prepkg] ${src} -> ${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
