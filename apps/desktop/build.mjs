// esbuild 打包渲染进程：app.jsx -> bundle.js（无 dev server，产物本地引用）
import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["renderer/app.jsx"],
  bundle: true,
  outfile: "renderer/bundle.js",
  jsx: "automatic",
  minify: true,
  logLevel: "info",
});
console.log("renderer bundled -> renderer/bundle.js");
