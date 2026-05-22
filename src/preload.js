const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("organizer", {
  chooseFolder: () => ipcRenderer.invoke("folder:choose"),
  scanFolder: (folderPath) => ipcRenderer.invoke("folder:scan", folderPath),
  executePlan: (folderPath, plan) => ipcRenderer.invoke("plan:execute", { folderPath, plan })
});
