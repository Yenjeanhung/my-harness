// esbuild 打包：main.ts -> main.cjs（Electron 主进程）、preload.ts -> preload.cjs（IPC 桥）、
// renderer/app.tsx -> renderer/bundle.js（渲染进程）。
// 无 dev server，产物本地引用；类型检查用 `npm run typecheck`（tsc --noEmit）。
import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["main.ts"],
  outfile: "main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "@lydell/node-pty"], // pty 是原生模块：保持 require 运行时解析，不进 bundle
  logLevel: "info",
});

await esbuild.build({
  entryPoints: ["preload.ts"],
  outfile: "preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  logLevel: "info",
});

// xterm 的 css 直接拷成 renderer/bundle.css（electron-builder files 里带上）
import fs from "fs";

await esbuild.build({
  entryPoints: ["renderer/app.tsx"],
  outfile: "renderer/bundle.js",
  bundle: true,
  jsx: "automatic",
  minify: true,
  logLevel: "info",
});
fs.copyFileSync(
  "node_modules/@xterm/xterm/css/xterm.css",
  "renderer/bundle.css"
);
console.log("main -> main.cjs, renderer bundled -> renderer/bundle.js");
