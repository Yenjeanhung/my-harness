// Markdown → HTML：助手消息与编辑器 md 预览共用（GFM + breaks，输出前最小净化）
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

export function mdRender(text: string): string {
  const html = marked.parse(text || "");
  return String(html)
    .replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, "");
}
