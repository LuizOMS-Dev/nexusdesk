"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = process.env.NEXUSDESK_HOME || path.join(os.homedir(), ".nexusdesk");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  organizer: {
    watchDir: process.env.WATCH_DIR || path.join(os.homedir(), "Downloads"),
    enabled: false,
    categories: {
      Imagens: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".ico", ".heic"],
      "Vídeos": [".mp4", ".mkv", ".avi", ".mov", ".webm", ".wmv", ".flv", ".m4v"],
      Documentos: [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md", ".rtf", ".odt", ".csv"],
      "Áudio": [".mp3", ".wav", ".flac", ".ogg", ".m4a", ".wma", ".aac"],
      Compactados: [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"],
      Programas: [".exe", ".msi", ".bat", ".apk", ".dmg", ".iso", ".appx"],
      Códigos: [".js", ".ts", ".py", ".java", ".c", ".cpp", ".cs", ".html", ".css", ".json", ".xml", ".yml", ".sh", ".ps1"],
      Outros: [],
    },
    askBeforeMove: false,
  },
  mail: {
    imapHost: "",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 465,
    user: "",
    password: "",
    name: "",
    saved: false,
  },
  rag: {
    folders: [],
    indexedAt: null,
    stats: null,
  },
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    cache = deepMerge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch (_) {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

function save(cfg) {
  cache = cfg || cache;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cache, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("config save:", e.message);
    return false;
  }
}

function get() {
  return load();
}

function update(patch) {
  const cfg = load();
  const next = deepMerge(cfg, patch);
  save(next);
  return next;
}

function deepMerge(target, src) {
  for (const k of Object.keys(src || {})) {
    if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k])) {
      target[k] = target[k] && typeof target[k] === "object" ? target[k] : {};
      deepMerge(target[k], src[k]);
    } else {
      target[k] = src[k];
    }
  }
  return target;
}

module.exports = { get, update, save, CONFIG_DIR };
