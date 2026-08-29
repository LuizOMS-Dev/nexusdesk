"use strict";

(() => {
  if (window.nexus) return;
  document.documentElement.classList.add("is-web");

  async function req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  function askPath(title) {
    return window.prompt(title || "Caminho da pasta no servidor") || null;
  }

  const moved = [];
  const progress = [];
  try {
    const es = new EventSource("/api/events");
    es.addEventListener("organizer:moved", (e) => {
      const d = JSON.parse(e.data);
      moved.forEach((cb) => cb(d));
    });
    es.addEventListener("rag:progress", (e) => {
      const d = JSON.parse(e.data);
      progress.forEach((cb) => cb(d));
    });
  } catch (_) {}

  window.nexus = {
    getConfig: () => req("GET", "/api/config"),
    updateConfig: (patch) => req("POST", "/api/config", patch),
    pathOf: () => null,
    organizer: {
      getStatus: () => req("GET", "/api/organizer/status"),
      setEnabled: async (on) => {
        const r = await req("POST", "/api/organizer/enabled", { on });
        return r && r.ok;
      },
      scanNow: () => req("POST", "/api/organizer/scan", {}),
      getHistory: () => req("GET", "/api/organizer/history"),
      undo: (id) => req("POST", "/api/organizer/undo", { id }),
      chooseFolder: async () => {
        const folder = askPath("Pasta vigiada (caminho no servidor)");
        if (!folder) return null;
        return req("POST", "/api/organizer/watchDir", { folder });
      },
      onMoved: (cb) => moved.push(cb),
    },
    mail: {
      connect: (creds) => req("POST", "/api/mail/connect", creds),
      fetchInbox: () => req("GET", "/api/mail/inbox"),
      generateDraft: (msg) => req("POST", "/api/mail/draft", msg),
      send: (payload) => req("POST", "/api/mail/send", payload),
    },
    rag: {
      addFolder: async () => {
        const folder = askPath("Pasta para indexar (caminho no servidor)");
        if (!folder) return null;
        return req("POST", "/api/rag/folder", { path: folder });
      },
      addFolderPath: (f) => req("POST", "/api/rag/folder", { path: f }),
      removeFolder: (f) => req("POST", "/api/rag/folder/remove", { path: f }),
      index: () => req("POST", "/api/rag/index", {}),
      ask: (q) => req("POST", "/api/rag/ask", { q }),
      info: () => req("GET", "/api/rag/info"),
      ollama: () => req("GET", "/api/rag/ollama"),
      onProgress: (cb) => progress.push(cb),
    },
  };
})();
