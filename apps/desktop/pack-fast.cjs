// 增量便携打包（秒级，替代 electron-builder 的 dir 目标）：
// - Electron 运行时只在首次/升级时拷贝进 out/y-harness-portable/，之后逐文件比对跳过；
// - 应用产物（main.cjs / renderer/*）以 resources/app 普通目录放置，不用 asar；
//   这些是纯 JS/HTML，应用运行中也能覆盖 —— 常见迭代（改代码→重打包→重启应用）不撞文件锁；
// - exe 用硬链接自 electron.exe，rcedit 打一次图标/版本信息（stamp 记录，不变不重打）；
// - 产物目录可直接双击 "Y Harness.exe" 运行，也可整体压缩分发。
// 用法：npm run pack（= build.mjs + prepkg.cjs + 本脚本）
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = __dirname;
const OUT = path.join(ROOT, "out", "y-harness-portable");
const RES = path.join(OUT, "resources");
const APP = path.join(RES, "app");
const ELECTRON_DIST = path.join(ROOT, "node_modules", "electron", "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

let copied = 0;
let skipped = 0;

function same(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.size === sb.size && sa.mtimeMs === sb.mtimeMs;
  } catch {
    return false;
  }
}

function copyIfChanged(src, dest) {
  if (same(src, dest)) {
    skipped++;
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  copied++;
}

function copyDirIncremental(src, dest, skipNames = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipNames.includes(name.name)) continue;
    const s = path.join(src, name.name);
    const d = path.join(dest, name.name);
    if (name.isDirectory()) copyDirIncremental(s, d, skipNames);
    else copyIfChanged(s, d);
  }
}

function fatal(msg) {
  console.error(`[pack] ${msg}`);
  process.exit(1);
}

async function main() {
const t0 = Date.now();

// 1) Electron 运行时：增量同步（electron.exe 单独处理成 "Y Harness.exe"，不重复拷 180MB）
if (!fs.existsSync(path.join(ELECTRON_DIST, "electron.exe"))) {
  fatal(`Electron 运行时缺失：${ELECTRON_DIST}\n  先跑 npm install`);
}
copyDirIncremental(ELECTRON_DIST, OUT, ["electron.exe", "LICENSE", "LICENSES.chromium.html", "version"]);

// 2) "Y Harness.exe"：硬链接 electron.exe（秒出，省 180MB 拷贝）；版本或图标变了才重建 + rcedit
const exe = path.join(OUT, `${pkg.productName || pkg.name}.exe`);
const electronVer = require(path.join(ROOT, "node_modules", "electron", "package.json")).version;
const iconSrc = path.join(ROOT, "build", "icon.ico");
const iconSig = fs.existsSync(iconSrc) ? `${fs.statSync(iconSrc).size}-${Math.round(fs.statSync(iconSrc).mtimeMs)}` : "none";
const stampFile = path.join(RES, ".pack-stamp.json");
const stamp = { electron: electronVer, icon: iconSig, version: pkg.version };
const stampOld = (() => {
  try { return JSON.parse(fs.readFileSync(stampFile, "utf8")); } catch { return null; }
})();
if (!stampOld || stampOld.electron !== stamp.electron || stampOld.icon !== stamp.icon || stampOld.version !== stamp.version) {
  try {
    fs.mkdirSync(RES, { recursive: true });
    if (fs.existsSync(exe)) fs.rmSync(exe, { force: true });
    try {
      fs.linkSync(path.join(ELECTRON_DIST, "electron.exe"), exe);
    } catch {
      fs.copyFileSync(path.join(ELECTRON_DIST, "electron.exe"), exe); // 跨盘等场景退回真拷贝
    }
    copied++;
    // 图标/版本信息：rcedit 可用则打上；失败只告警（exe 保留 Electron 图标，不影响运行）
    try {
      const rc = require("rcedit");
      const rcedit = rc.rcedit || rc; // 兼容默认导出/命名导出两种形态
      await rcedit(exe, {
        icon: iconSrc,
        "file-version": pkg.version,
        "product-version": pkg.version,
        "version-string": { ProductName: pkg.productName, FileDescription: pkg.description },
      });
      console.log("[pack] exe 图标与版本信息已写入（rcedit）");
    } catch (e) {
      console.warn(`[pack] rcedit 不可用，exe 用默认图标：${e.message}`);
    }
    fs.writeFileSync(stampFile, JSON.stringify(stamp));
  } catch (e) {
    fatal(`重建 exe 失败（应用正在运行？先退出再打包）：${e.message}`);
  }
} else {
  skipped++;
}

// 3) resources/app：主进程/预加载/渲染产物 + 窗口图标 + node-pty 原生模块（普通目录，不用 asar）
copyIfChanged(path.join(ROOT, "main.cjs"), path.join(APP, "main.cjs"));
copyIfChanged(path.join(ROOT, "preload.cjs"), path.join(APP, "preload.cjs"));
for (const f of ["index.html", "bundle.js", "bundle.css"]) {
  copyIfChanged(path.join(ROOT, "renderer", f), path.join(APP, "renderer", f));
}
if (fs.existsSync(iconSrc)) copyIfChanged(iconSrc, path.join(APP, "build", "icon.ico"));
fs.writeFileSync(
  path.join(APP, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, productName: pkg.productName, main: "main.cjs" }, null, 2)
);
copyDirIncremental(path.join(ROOT, "node_modules", "@lydell"), path.join(APP, "node_modules", "@lydell"));

// 4) sidecar 与 rg（extraResources 的等价物）：变了才拷；被运行中的应用锁住时警告并继续
//    （界面迭代不需要新 sidecar；退出应用后下次 pack 会自动补上）
const sidecar = path.join(ROOT, "build", "harness-server.exe");
if (fs.existsSync(sidecar)) {
  const dest = path.join(RES, "harness-server.exe");
  if (same(sidecar, dest)) {
    skipped++;
  } else {
    try {
      fs.copyFileSync(sidecar, dest);
      copied++;
    } catch {
      console.warn("[pack] sidecar 新版暂未放入（旧版正被运行中的应用锁着）：退出应用后再跑一次 npm run pack 完成更新");
    }
  }
} else {
  console.warn("[pack] build/harness-server.exe 不存在：包里没有内嵌 daemon，启动会走 PATH 上的 harness");
}
const rg = path.join(ROOT, "build", "rg", process.platform === "win32" ? "rg.exe" : "rg");
if (fs.existsSync(rg)) copyIfChanged(rg, path.join(RES, "bin", path.basename(rg)));

console.log(
  `[pack] 完成：${OUT}\n` +
  `[pack] 拷贝 ${copied} 个文件，跳过 ${skipped} 个未变化文件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s` +
  (copied > 0 ? "（改了渲染层的话，运行中的应用 Ctrl+R 重载即可看到新界面）" : "")
);
}

main().catch((e) => fatal(e.stack || e.message));
