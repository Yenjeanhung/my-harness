"use strict";

// preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("myharness", {
  pickFolder: () => import_electron.ipcRenderer.invoke("pick-folder"),
  getProjects: () => import_electron.ipcRenderer.invoke("get-projects"),
  openProject: (p) => import_electron.ipcRenderer.invoke("open-project", p)
});
