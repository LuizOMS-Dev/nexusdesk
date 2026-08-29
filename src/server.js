"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const organizer = require("./modules/organizer");
const mail = require("./modules/mail");
const rag = require("./modules/rag");
const ollama = require("./ollama");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, "..", "renderer");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

const sse = new Set();

function broadcast(channel, payload) {
  const chunk = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sse) {
    try {
      res.write(chunk);
    } catch (_) {}
  }
}

function send(res, status, body, headers) {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

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

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  if (p === "/health" && method === "GET") {
    return send(res, 200, { ok: true });
  }

  if (p === "/api/events" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");
    sse.add(res);
    req.on("close", () => sse.delete(res));
    return;
  }

  if (p === "/api/config" && method === "GET") return send(res, 200, config.get());
  if (p === "/api/config" && method === "POST") {
    const patch = await readBody(req);
    return send(res, 200, config.update(patch));
  }

  if (p === "/api/organizer/status" && method === "GET") {
    return send(res, 200, {
      enabled: config.get().organizer.enabled,
      watchDir: config.get().organizer.watchDir,
      history: organizer.getHistory(60),
      stats: organizer.getStats(),
    });
  }
  if (p === "/api/organizer/enabled" && method === "POST") {
    const { on } = await readBody(req);
    return send(res, 200, { ok: organizer.setEnabled(on, broadcast) });
  }
  if (p === "/api/organizer/scan" && method === "POST") {
    const r = await organizer.scanAndOrganize();
    return send(res, 200, { ...r, history: organizer.getHistory(60), stats: organizer.getStats() });
  }
  if (p === "/api/organizer/history" && method === "GET") {
    return send(res, 200, { history: organizer.getHistory(60), stats: organizer.getStats() });
  }
  if (p === "/api/organizer/undo" && method === "POST") {
    const { id } = await readBody(req);
    return send(res, 200, organizer.undoMove(id));
  }
  if (p === "/api/organizer/watchDir" && method === "POST") {
    const { folder } = await readBody(req);
    if (!folder) return send(res, 200, null);
    config.update({ organizer: { watchDir: folder } });
    if (config.get().organizer.enabled) organizer.setEnabled(true, broadcast);
    return send(res, 200, JSON.stringify(folder), { "Content-Type": "application/json; charset=utf-8" });
  }

  if (p === "/api/mail/connect" && method === "POST") {
    const creds = await readBody(req);
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
      return send(res, 200, { ok: true, count: messages.length, messages });
    } catch (e) {
      return send(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === "/api/mail/inbox" && method === "GET") {
    try {
      const cfg = config.get().mail;
      if (!cfg.saved) return send(res, 200, { ok: false, error: "conta não configurada" });
      const messages = await mail.listInbox(cfg, 20);
      return send(res, 200, { ok: true, messages });
    } catch (e) {
      return send(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === "/api/mail/draft" && method === "POST") {
    const msg = await readBody(req);
    const text = await mail.generateDraft(msg, config.get().mail.name || config.get().mail.user);
    return send(res, 200, JSON.stringify(text), { "Content-Type": "application/json; charset=utf-8" });
  }
  if (p === "/api/mail/send" && method === "POST") {
    try {
      await mail.sendMail(config.get().mail, await readBody(req));
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 200, { ok: false, error: e.message });
    }
  }

  if (p === "/api/rag/folder" && method === "POST") {
    const { path: folder } = await readBody(req);
    return send(res, 200, addRagFolder(folder));
  }
  if (p === "/api/rag/folder/remove" && method === "POST") {
    const { path: folder } = await readBody(req);
    const folders = config.get().rag.folders.filter((x) => x !== folder);
    config.update({ rag: { folders } });
    return send(res, 200, folders);
  }
  if (p === "/api/rag/index" && method === "POST") {
    try {
      const stats = await rag.buildIndex((prog) => broadcast("rag:progress", prog));
      return send(res, 200, { ok: true, stats });
    } catch (e) {
      return send(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === "/api/rag/ask" && method === "POST") {
    try {
      return send(res, 200, await rag.ask((await readBody(req)).q));
    } catch (e) {
      return send(res, 200, { answer: "erro: " + e.message, sources: [], mode: "error" });
    }
  }
  if (p === "/api/rag/info" && method === "GET") return send(res, 200, rag.getIndexInfo());
  if (p === "/api/rag/ollama" && method === "GET") return send(res, 200, await ollama.status());

  send(res, 404, { error: "not found" });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return send(res, 403, "forbidden");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "not found");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

function bootDirs() {
  try {
    fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
  } catch (_) {}
  const watch = config.get().organizer.watchDir;
  try {
    fs.mkdirSync(watch, { recursive: true });
  } catch (_) {}
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/health" || url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

bootDirs();
if (config.get().organizer.enabled) organizer.setEnabled(true, broadcast);

server.listen(PORT, "0.0.0.0", () => {
  console.log("NexusDesk web em http://0.0.0.0:" + PORT);
  ollama.ensureModel().then((m) => {
    if (m && m.length) console.log("ollama:", m.join(", "));
    else console.log("ollama: indisponível (busca extrativa continua)");
  });
});
