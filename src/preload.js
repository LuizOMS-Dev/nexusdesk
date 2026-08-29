"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("nexus", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  updateConfig: (patch) => ipcRenderer.invoke("config:update", patch),
  pathOf: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (_) {
      return null;
    }
  },

  organizer: {
    getStatus: () => ipcRenderer.invoke("organizer:status"),
    setEnabled: (on) => ipcRenderer.invoke("organizer:setEnabled", on),
    scanNow: () => ipcRenderer.invoke("organizer:scanNow"),
    getHistory: () => ipcRenderer.invoke("organizer:getHistory"),
    undo: (id) => ipcRenderer.invoke("organizer:undo", id),
    chooseFolder: () => ipcRenderer.invoke("organizer:chooseFolder"),
    onMoved: (cb) => ipcRenderer.on("organizer:moved", (_e, entry) => cb(entry)),
  },

  mail: {
    connect: (creds) => ipcRenderer.invoke("mail:connect", creds),
    fetchInbox: () => ipcRenderer.invoke("mail:fetchInbox"),
    generateDraft: (msg) => ipcRenderer.invoke("mail:generateDraft", msg),
    send: (payload) => ipcRenderer.invoke("mail:send", payload),
  },

  rag: {
    addFolder: () => ipcRenderer.invoke("rag:addFolder"),
    addFolderPath: (f) => ipcRenderer.invoke("rag:addPath", f),
    removeFolder: (f) => ipcRenderer.invoke("rag:removeFolder", f),
    index: () => ipcRenderer.invoke("rag:index"),
    ask: (q) => ipcRenderer.invoke("rag:ask", q),
    info: () => ipcRenderer.invoke("rag:info"),
    ollama: () => ipcRenderer.invoke("rag:ollama"),
    onProgress: (cb) => ipcRenderer.on("rag:progress", (_e, p) => cb(p)),
  },
});
