// 打包前置：把 PyInstaller 产物拷进项目内（electron-builder 的 extraResources 引用项目内路径最稳）
// sidecar 为 onedir 目录（dist/harness-server/，入口 exe 在顶层、依赖在 _internal/）：
// 免 onefile 每次启动解压 100MB+ 的冷启动（桌面端「等待连接」空窗的主因），杀毒误报率也更低。
// 兼容两种产物位置：packaging/dist（历史约定）与仓库根 dist（PACKAGING.md 第 1 步的实际输出），取较新者。
// 注意：拷贝前请先按 PACKAGING.md 验证产物 /health 的 version 与 package.json 一致——
// 曾发生过「构建期间源码还在改，sidecar 打出半成品版本」的事故。
const fs = require("fs");
const path = require("path");

const exeCandidates = [
  path.resolve(__dirname, "../../packaging/dist/harness-server/harness-server.exe"),
  path.resolve(__dirname, "../../dist/harness-server/harness-server.exe"),
];
const srcExe = exeCandidates.filter((f) => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const src = srcExe && path.dirname(srcExe);
const destDir = path.resolve(__dirname, "build");
const dest = path.join(destDir, "harness-server");

// 整目录精确同步：manifest（相对路径→大小+mtime）不一致就清空重拷，顺带清掉源里已消失的残留文件
function dirManifest(root, prefix = "") {
  const out = {};
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) Object.assign(out, dirManifest(path.join(root, ent.name), rel));
    else {
      const st = fs.statSync(path.join(root, ent.name));
      out[rel] = `${st.size}:${Math.round(st.mtimeMs)}`;
    }
  }
  return out;
}

if (!src) {
  console.error(`[prepkg] missing sidecar: looked in\n  ${exeCandidates.join("\n  ")}`);
  console.error("[prepkg] run the PyInstaller step first — see PACKAGING.md step 1");
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
// 产物没变就不重复拷 100MB+：比对整目录 manifest（PyInstaller 每次重建 mtime 必变，足够可靠）
if (
  fs.existsSync(dest) &&
  JSON.stringify(dirManifest(src)) === JSON.stringify(dirManifest(dest))
) {
  console.log(`[prepkg] sidecar 未变化，跳过拷贝：${dest}`);
} else {
  fs.rmSync(dest, { recursive: true, force: true });
  // preserveTimestamps：保持与源 mtime 一致，下次 pack 的 manifest 比对才能命中「未变化跳过」
  fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true });
  console.log(`[prepkg] ${src} -> ${dest}（onedir 整目录）`);
}
// 历史 onefile 单文件残留：新链路不再使用，清掉免得被打进包里
const legacyExe = path.join(destDir, "harness-server.exe");
if (fs.existsSync(legacyExe)) {
  fs.rmSync(legacyExe, { force: true });
  console.log(`[prepkg] 已清理历史 onefile：${legacyExe}`);
}

// rg.exe（ripgrep）：工作台搜索的加速依赖，随包分发到 resources/bin。
// 来源优先 PATH 上的 rg（`where rg`），找不到只告警不失败——daemon 会退回 Python 遍历搜索。
const rgDir = path.join(destDir, "rg");
fs.mkdirSync(rgDir, { recursive: true });
const rgDest = path.join(rgDir, process.platform === "win32" ? "rg.exe" : "rg");
let rgSrc = null;
try {
  const { execSync } = require("child_process");
  const hit = execSync(process.platform === "win32" ? "where rg" : "which rg", { encoding: "utf-8" })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (hit && fs.existsSync(hit)) rgSrc = hit;
} catch {}
if (rgSrc) {
  fs.copyFileSync(rgSrc, rgDest);
  console.log(`[prepkg] ${rgSrc} -> ${rgDest}`);
} else {
  console.warn("[prepkg] rg not found on PATH — packaged app will fall back to slow Python search");
}
