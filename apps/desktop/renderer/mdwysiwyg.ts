// Typora 式所见即所得（Tiptap/ProseMirror 封装）：在渲染表面直接编辑，输入即渲染。
// markdown 单向序列化回源缓冲（monaco model），保存链路复用既有 Ctrl+S。
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "tiptap-markdown";

export interface Wysiwyg {
  refresh(markdown: string): void; // 外部改动（Agent 改盘重载）整体覆盖
  getMarkdown(): string;
  destroy(): void;
}

const mdOf = (ed: Editor): string =>
  ((ed.storage as Record<string, { getMarkdown(): string }>).markdown ?? { getMarkdown: () => "" }).getMarkdown();

export function createWysiwyg(host: HTMLElement, markdown: string, onChange: (md: string) => void): Wysiwyg {
  const editor = new Editor({
    element: host,
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false }), // 编辑态点击不开链接（预览阅读态由静态预览负责）
      Image,
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, linkify: true }),
    ],
    content: markdown,
    onUpdate: () => onChange(mdOf(editor)),
  });
  // QA 调试钩子（lesson 41 模式）：CDP 驱动 PM 事务验证「 onUpdate→序列化→model」全链
  (window as unknown as Record<string, unknown>).__yhWysiwyg = editor;
  return {
    refresh(md) {
      editor.commands.setContent(md, false);
    },
    getMarkdown() {
      return mdOf(editor);
    },
    destroy() {
      editor.destroy();
    },
  };
}
