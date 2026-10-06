// esbuild 打包：main.ts -> main.cjs（Electron 主进程）、preload.ts -> preload.cjs（IPC 桥）、
// renderer/app.tsx -> renderer/bundle.js（渲染进程，ESM+代码分包：Monaco 语言包按需分块加载）+
// renderer/monaco-*.worker.js（Monaco 的 5 个语言服务 worker，独立单文件包）。
// 无 dev server，产物本地引用；类型检查用 `npm run typecheck`（tsc --noEmit）。
import esbuild from "esbuild";
import fs from "fs";

// Windows 下打包时常有瞬时文件锁（正在运行的应用正从 renderer/ 读文件、杀软扫描），
// 表现为 writeFileSync 抛 UNKNOWN/EBUSY/EPERM，esbuild 自带写入还会报 "user-mapped section"。
// 三层防护：① 内容没变就不写（重复 pack 的常见路径直接跳过）；② 指数退避重试；③ 仍失败给明确指引。
// 所有 esbuild 产物统一 write:false 收进内存后经这里落盘（esbuild 自己写文件没有重试）。
function writeAtomic(p, data) {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  if (fs.existsSync(p) && fs.readFileSync(p).equals(buf)) return; // 未变化：跳过写入
  for (let i = 0; ; i++) {
    try {
      fs.writeFileSync(p, buf);
      return;
    } catch (e) {
      const transient = ["UNKNOWN", "EBUSY", "EPERM", "EACCES"].includes(e.code) || /user-mapped|mapped section/i.test(String(e.message));
      if (!transient || i >= 4) {
        console.error(
          `\n[build] 写入 ${p} 失败（${e.code}）：文件被其他进程占用。\n` +
          `  正在运行的 Y Harness / 杀软可能锁着它——关掉应用（或任务管理器结束 Y Harness.exe）后重试 npm run pack。`
        );
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * 2 ** i); // 同步 sleep
    }
  }
}

// esbuild write:false 产物落盘：outputFiles[].path 是按 outdir/outfile 解析好的绝对路径
async function buildWrite(cfg) {
  const result = await esbuild.build({ ...cfg, write: false, logLevel: "silent" });
  let written = 0;
  for (const f of result.outputFiles) {
    const before = fs.existsSync(f.path) ? fs.readFileSync(f.path) : null;
    writeAtomic(f.path, f.contents);
    if (!before || !before.equals(Buffer.from(f.contents))) written++;
  }
  return { total: result.outputFiles.length, written };
}

const { written: mainWritten } = await buildWrite({
  entryPoints: ["main.ts"],
  outfile: "main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "@lydell/node-pty"], // pty 是原生模块：保持 require 运行时解析，不进 bundle
});
console.log(`main.cjs 已写入（变化 ${mainWritten} 个文件）`);

const { written: preloadWritten } = await buildWrite({
  entryPoints: ["preload.ts"],
  outfile: "preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
console.log(`preload.cjs 已写入（变化 ${preloadWritten} 个文件）`);

// Monaco worker：五个语言服务各自打成单文件经典脚本（iife 自包含，经 new Worker(url) 加载）。
// 与主包分开构建，避免 code-splitting 把 worker 拆出需要再 import 的分块。
const workerEntries = {
  "monaco-editor.worker": "renderer/workers/editor.worker.ts",
  "monaco-ts.worker": "renderer/workers/ts.worker.ts",
  "monaco-json.worker": "renderer/workers/json.worker.ts",
  "monaco-css.worker": "renderer/workers/css.worker.ts",
  "monaco-html.worker": "renderer/workers/html.worker.ts",
};
const { total: workerTotal, written: workerWritten } = await buildWrite({
  entryPoints: workerEntries,
  outdir: "renderer",
  bundle: true,
  platform: "browser",
  format: "iife",
  minify: true,
});
console.log(`monaco workers 已写入（变化 ${workerWritten}/${workerTotal} 个文件）`);

// 渲染进程主包：ESM + splitting——Monaco 的语言语法定义（register.js loader）是动态 import，
// splitting 让每个语言语法成为独立分块按需加载，首屏只带编辑器内核。
// Monaco 的样式经 JS import 被 esbuild 收进 renderer/bundle.css（与入口同名自动产出）。
const { total: rendererTotal, written: rendererWritten } = await buildWrite({
  entryPoints: ["renderer/app.tsx"],
  outdir: "renderer",
  entryNames: "bundle",
  chunkNames: "chunk-[hash]",
  bundle: true,
  jsx: "automatic",
  minify: true,
  format: "esm",
  splitting: true,
  loader: { ".ttf": "file" }, // codicon 图标字体 → 独立资产文件（renderer/codicon-*.ttf）
});
console.log(`renderer 已写入（变化 ${rendererWritten}/${rendererTotal} 个文件，未变化的 chunk 直接跳过）`);

// xterm 的 css 追加进 bundle.css（electron-builder files 里带上）
writeAtomic("renderer/bundle.css", fs.readFileSync("renderer/bundle.css", "utf8") + fs.readFileSync("node_modules/@xterm/xterm/css/xterm.css", "utf8"));
// ESM 分包会把部分 Monaco 样式拆进 chunk-*.css（动态分块的 CSS 浏览器不会自动加载）：
// 把 link 注入 index.html 的标记区（每次构建按 hash 重写）
{
  const htmlPath = "renderer/index.html";
  const html = fs.readFileSync(htmlPath, "utf8");
  const cssChunks = fs.readdirSync("renderer").filter((f) => /^chunk-.+\.css$/.test(f));
  const links = cssChunks.map((f) => `<link rel="stylesheet" href="./${f}" />`).join("\n    ");
  const next = html.replace(/(<!-- chunk-css-start -->)[\s\S]*?(<!-- chunk-css-end -->)/, `$1\n    ${links}\n    $2`);
  writeAtomic(htmlPath, next);
  if (cssChunks.length) console.log(`chunk css linked into index.html: ${cssChunks.join(", ")}`);
}
console.log("main -> main.cjs, renderer bundled (ESM) -> renderer/bundle.js + chunks, monaco workers -> renderer/monaco-*.worker.js");
