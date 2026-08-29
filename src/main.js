"use strict";

const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
app.setName("NexusDesk");
const path = require("path");
const fs = require("fs");
const config = require("./config");
const organizer = require("./modules/organizer");
const mail = require("./modules/mail");
const rag = require("./modules/rag");

let win = null;

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#2a221b",
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#2a221b",
      symbolColor: "#c4a574",
      height: 40,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
    icon: undefined,
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => (win = null));
}

/* ═════════════════ IPC: CONFIG ═════════════════ */
ipcMain.handle("config:get", () => config.get());
ipcMain.handle("config:update", (_e, patch) => config.update(patch));

/* ═════════════════ IPC: ORGANIZER ═════════════════ */
ipcMain.handle("organizer:status", () => ({
  enabled: config.get().organizer.enabled,
  watchDir: config.get().organizer.watchDir,
  history: organizer.getHistory(60),
  stats: organizer.getStats(),
}));
ipcMain.handle("organizer:setEnabled", (_e, on) => organizer.setEnabled(on, broadcast));
ipcMain.handle("organizer:scanNow", async () => {
  const res = await organizer.scanAndOrganize();
  return { ...res, history: organizer.getHistory(60), stats: organizer.getStats() };
});
ipcMain.handle("organizer:getHistory", () => ({ history: organizer.getHistory(60), stats: organizer.getStats() }));
ipcMain.handle("organizer:undo", (_e, id) => organizer.undoMove(id));
ipcMain.handle("organizer:chooseFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return null;
  const folder = r.filePaths[0];
  config.update({ organizer: { watchDir: folder } });
  if (config.get().organizer.enabled) organizer.setEnabled(true, broadcast);
  return folder;
});

/* ═════════════════ IPC: MAIL ═════════════════ */
ipcMain.handle("mail:connect", async (_e, creds) => {
  try {
    config.update({
      mail: {
        imapHost: creds.imapHost,
        imapPort: Number(creds.imapPort) || 993,
        smtpHost: creds.smtpHost,
        smtpPort: Number(creds.smtpPort) || 465,
        user: creds.user,
        password: creds.password,
        name: creds.name || "",
        saved: true,
      },
    });
    const messages = await mail.listInbox(config.get().mail, 20);
    return { ok: true, count: messages.length, messages };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("mail:fetchInbox", async () => {
  try {
    const cfg = config.get().mail;
    if (!cfg.saved) return { ok: false, error: "conta não configurada" };
    const messages = await mail.listInbox(cfg, 20);
    return { ok: true, messages };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("mail:generateDraft", (_e, msg) => mail.generateDraft(msg, config.get().mail.name || config.get().mail.user));

ipcMain.handle("mail:send", async (_e, payload) => {
  try {
    await mail.sendMail(config.get().mail, payload);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ═════════════════ IPC: RAG ═════════════════ */
function addRagFolder(folder) {
  if (!folder) return config.get().rag.folders;
  try {
    const st = fs.statSync(folder);
    if (!st.isDirectory()) folder = path.dirname(folder);
  } catch (_) {
    return config.get().rag.folders;
  }
  const folders = [...new Set([...config.get().rag.folders, folder])];
  config.update({ rag: { folders } });
  return folders;
}

ipcMain.handle("rag:addFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return null;
  return addRagFolder(r.filePaths[0]);
});
ipcMain.handle("rag:addPath", (_e, folder) => addRagFolder(folder));
ipcMain.handle("rag:removeFolder", (_e, f) => {
  const folders = config.get().rag.folders.filter((x) => x !== f);
  config.update({ rag: { folders } });
  return folders;
});
ipcMain.handle("rag:index", async () => {
  try {
    const stats = await rag.buildIndex((p) => broadcast("rag:progress", p));
    return { ok: true, stats };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("rag:ask", async (_e, q) => {
  try {
    return await rag.ask(q);
  } catch (e) {
    return { answer: "erro: " + e.message, sources: [], mode: "error" };
  }
});
ipcMain.handle("rag:info", () => rag.getIndexInfo());
ipcMain.handle("rag:ollama", () => rag.ollamaStatus());

/* ═════════════════ BOOT ═════════════════ */
app.whenReady().then(() => {
  if (config.get().organizer.enabled) organizer.setEnabled(true, broadcast);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => organizer.stopWatch());
app.on("window-all-closed", () => app.quit());
