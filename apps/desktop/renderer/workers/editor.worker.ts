// Monaco editor worker 入口（esbuild 单独打包成 renderer/monaco-editor.worker.js）。
// 词法分析/词补全/diff 计算等编辑器基础服务跑在这里。
import "monaco-editor/editor/editor.worker.js";
