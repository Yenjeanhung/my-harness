// Monaco worker 入口模块是纯副作用导入（自执行 worker 引导），官方没有给它们配 .d.ts：
// 给 tsc 补模块声明，让 side-effect import 通过类型检查（esbuild 打包不受影响）。
declare module "monaco-editor/editor/editor.worker.js";
declare module "monaco-editor/languages/features/typescript/ts.worker.js";
declare module "monaco-editor/languages/features/json/json.worker.js";
declare module "monaco-editor/languages/features/css/css.worker.js";
declare module "monaco-editor/languages/features/html/html.worker.js";
