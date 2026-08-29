"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config");

let watcher = null;
let pending = new Set();
let history = [];
const HISTORY_MAX = 500;
const HISTORY_FILE = path.join(config.CONFIG_DIR, "history.json");
const SKIP_NAMES = /^(desktop\.ini|thumbs\.db)$/i;
const SKIP_EXT = /\.(crdownload|part|tmp|download|opdownload|partial|!ut)$/i;

function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    if (Array.isArray(raw)) history = raw.slice(0, HISTORY_MAX);
  } catch (_) {}
}

function saveHistory() {
  try {
    fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, HISTORY_MAX)), "utf8");
  } catch (_) {}
}

loadHistory();

function shouldOrganize(filePath) {
  const cfg = config.get().organizer;
  if (path.resolve(path.dirname(filePath)) !== path.resolve(cfg.watchDir)) return false;
  const name = path.basename(filePath);
  if (!name || name.startsWith(".")) return false;
  if (SKIP_NAMES.test(name) || SKIP_EXT.test(name)) return false;
  if (!path.extname(name)) return false;
  return true;
}

function classify(fileName, categories) {
  const ext = path.extname(fileName).toLowerCase();
  for (const [cat, exts] of Object.entries(categories)) {
    if (cat === "Outros") continue;
    if (exts.includes(ext)) return cat;
  }
  return "Outros";
}

function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let i = 2; i < 1000; i++) {
    dest = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(dest)) return dest;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fileStable(filePath) {
  try {
    const a = fs.statSync(filePath);
    await sleep(400);
    const b = fs.statSync(filePath);
    return a.size === b.size && a.size > 0 && a.mtimeMs === b.mtimeMs;
  } catch (_) {
    return false;
  }
}

async function moveWithRetry(src, destDir) {
  const name = path.basename(src);
  const dest = uniqueDest(destDir, name);
  if (!dest) throw new Error("não foi possível gerar destino único");
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.renameSync(src, dest);
      return dest;
    } catch (e) {
      const fatal = e.code === "EXDEV" || e.code === "EPERM";
      try {
        if (fatal || attempt >= 3) {
          fs.copyFileSync(src, dest);
          if (fs.statSync(dest).size === fs.statSync(src).size) {
            fs.unlinkSync(src);
          } else {
            fs.unlinkSync(dest);
            throw new Error("cópia incompleta");
          }
          return dest;
        }
      } catch (_) {}
      await sleep(700 * (attempt + 1));
    }
  }
  throw new Error("arquivo bloqueado por outro processo");
}

async function moveFile(filePath) {
  const cfg = config.get().organizer;
  const cat = classify(path.basename(filePath), cfg.categories);
  const destDir = path.join(cfg.watchDir, cat);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    let stable = false;
    for (let i = 0; i < 15; i++) {
      if (!fs.existsSync(filePath)) return null;
      if (await fileStable(filePath)) {
        stable = true;
        break;
      }
    }
    if (!stable || !fs.existsSync(filePath)) return null;
    const dest = await moveWithRetry(filePath, destDir);
    const entry = {
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      at: Date.now(),
      file: path.basename(dest),
      from: filePath,
      to: dest,
      category: cat,
      size: (() => { try { return fs.statSync(dest).size; } catch (_) { return 0; } })(),
      undone: false,
    };
    history.unshift(entry);
    if (history.length > HISTORY_MAX) history.pop();
    saveHistory();
    return entry;
  } catch (e) {
    console.error("moveFile:", e.message);
    return null;
  }
}

function scanAndOrganize() {
  const cfg = config.get().organizer;
  const results = [];
  let entries = [];
  try {
    entries = fs.readdirSync(cfg.watchDir, { withFileTypes: true });
  } catch (e) {
    return Promise.resolve({ moved: [], error: e.message });
  }

  const jobs = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const full = path.join(cfg.watchDir, ent.name);
    if (!shouldOrganize(full)) continue;
    jobs.push(moveFile(full));
  }
  return Promise.all(jobs).then((rs) => ({
    moved: rs.filter(Boolean),
    error: null,
  }));
}

function startWatch(broadcast) {
  const cfg = config.get().organizer;
  stopWatch();
  try {
    watcher = fs.watch(cfg.watchDir, { persistent: true, recursive: false }, (_evt, fileName) => {
      if (!fileName || pending.has(fileName)) return;
      const full = path.join(cfg.watchDir, fileName);
      if (!shouldOrganize(full)) return;
      let st;
      try {
        st = fs.statSync(full);
      } catch (_) {
        return;
      }
      if (!st.isFile()) return;
      pending.add(fileName);
      setTimeout(() => {
        pending.delete(fileName);
        moveFile(full).then((entry) => {
          if (entry && broadcast) broadcast("organizer:moved", entry);
        });
      }, 1200);
    });
    return true;
  } catch (e) {
    console.error("watch:", e.message);
    watcher = null;
    return false;
  }
}

function stopWatch() {
  if (watcher) {
    try {
      watcher.close();
    } catch (_) {}
    watcher = null;
  }
}

function setEnabled(on, broadcast) {
  config.update({ organizer: { enabled: !!on } });
  if (on) return startWatch(broadcast);
  stopWatch();
  return true;
}

function undoMove(id) {
  const entry = history.find((h) => h.id === id && !h.undone);
  if (!entry) return { ok: false, error: "movimentação não encontrada ou já desfeita" };
  try {
    if (!fs.existsSync(entry.to)) return { ok: false, error: "arquivo não está mais na pasta de destino" };
    fs.renameSync(entry.to, entry.from);
    entry.undone = true;
    saveHistory();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function getHistory(limit = 100) {
  return history.slice(0, limit);
}

function getStats() {
  const byCat = {};
  let totalSize = 0;
  for (const h of history) {
    if (h.undone) continue;
    byCat[h.category] = (byCat[h.category] || 0) + 1;
    totalSize += h.size || 0;
  }
  return { total: Object.values(byCat).reduce((a, b) => a + b, 0), byCat, totalSize };
}

module.exports = { startWatch, stopWatch, setEnabled, scanAndOrganize, undoMove, getHistory, getStats, classify };
