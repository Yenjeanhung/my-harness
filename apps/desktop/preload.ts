// 预加载脚本：给渲染进程暴露最小桌面能力（原生文件夹选择 / 项目列表 / 切换项目 / 内嵌终端）。
// 渲染进程保持 contextIsolation，唯一入口是 window.myharness。
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("myharness", {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("pick-folder"),
  getProjects: (): Promise<{ current: string | null; recent: string[] }> =>
    ipcRenderer.invoke("get-projects"),
  openProject: (p: string): Promise<string> => ipcRenderer.invoke("open-project", p),
  // —— 内嵌终端（node-pty 会话）——
  termCreate: (cols: number, rows: number): Promise<{ id: number; cwd: string; title: string }> =>
    ipcRenderer.invoke("term-create", cols, rows),
  termInput: (id: number, data: string): void => ipcRenderer.send("term-input", id, data),
  termResize: (id: number, cols: number, rows: number): void =>
    ipcRenderer.send("term-resize", id, cols, rows),
  termKill: (id: number): void => ipcRenderer.send("term-kill", id),
  termOnData: (cb: (id: number, data: string) => void): void => {
    ipcRenderer.on("term-data", (_e, id: number, data: string) => cb(id, data));
  },
  termOnExit: (cb: (id: number, exitCode: number) => void): void => {
    ipcRenderer.on("term-exit", (_e, id: number, code: number) => cb(id, code));
  },
});
