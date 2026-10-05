"use strict";

// preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("myharness", {
  pickFolder: () => import_electron.ipcRenderer.invoke("pick-folder"),
  getProjects: () => import_electron.ipcRenderer.invoke("get-projects"),
  openProject: (p) => import_electron.ipcRenderer.invoke("open-project", p),
  // —— 内嵌终端（node-pty 会话）——
  termCreate: (cols, rows) => import_electron.ipcRenderer.invoke("term-create", cols, rows),
  termInput: (id, data) => import_electron.ipcRenderer.send("term-input", id, data),
  termResize: (id, cols, rows) => import_electron.ipcRenderer.send("term-resize", id, cols, rows),
  termKill: (id) => import_electron.ipcRenderer.send("term-kill", id),
  termOnData: (cb) => {
    import_electron.ipcRenderer.on("term-data", (_e, id, data) => cb(id, data));
  },
  termOnExit: (cb) => {
    import_electron.ipcRenderer.on("term-exit", (_e, id, code) => cb(id, code));
  }
});
