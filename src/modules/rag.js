"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const config = require("../config");
const ollama = require("../ollama");

/* ═══════════════════════ TOKENIZAÇÃO ═══════════════════════ */

const STOPWORDS = new Set(
  "a o os as de da do das dos e é no na nos nas em por para com sem sob sobre um uma uns umas que qual quais quando onde como porque se ao aos à às isso isto aquilo seu sua seus suas meu minha teu tua ele ela eles elas nós vós você vocês the of and to in is for on with as by at from or an be this that it".split(
    " "
  )
);

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/* ═══════════════════════ EXTRAÇÃO DE TEXTO ═══════════════════════ */

function pdfExtract(buf) {
  const chunks = [];
  const raw = buf.toString("binary");
  let idx = 0;
  while (true) {
    const s = raw.indexOf("stream", idx);
    if (s === -1) break;
    let dataStart = s + 6;
    if (raw[dataStart] === "\r") dataStart++;
    if (raw[dataStart] === "\n") dataStart++;
    const e = raw.indexOf("endstream", dataStart);
    if (e === -1) break;
    const slice = buf.subarray(dataStart, e);
    let text = null;
    try {
      text = zlib.inflateSync(slice).toString("binary");
    } catch (_) {
      try {
        text = zlib.inflateRawSync(slice).toString("binary");
      } catch (_) {}
    }
    if (!text) {
      if (!/FlateDecode/.test(raw.slice(Math.max(0, s - 200), s))) text = slice.toString("binary");
    }
    if (text && /(BT|Tj|TJ)/.test(text)) chunks.push(text);
    idx = e + 9;
  }
  let out = "";
  const src = chunks.join("\n");
  out = src
    .replace(/\((?:\\.|[^\\()])*\)/g, (m) =>
      m
        .slice(1, -1)
        .replace(/\\([nrtbf()\\])/g, (_x, c) => ({ n: "\n", r: "", t: " ", b: "", f: "" }[c] ?? c))
        .replace(/\\[0-7]{1,3}/g, " ")
    )
    .replace(/(TJ|Tj|ET|BT|Td|TD|Tm|Tf)/g, "\n")
    .replace(/\n{2,}/g, "\n");
  return out.replace(/[^\S\n]{2,}/g, " ").trim();
}

function zipInflateEntry(filePath, entryName) {
  const buf = fs.readFileSync(filePath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return "";
  const cdOff = buf.readUInt32LE(eocd + 16);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = cdOff;
  const cdEnd = Math.min(buf.length, cdOff + cdSize);
  while (p < cdEnd - 46) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== entryName) continue;
    if (localOff + 30 > buf.length) return "";
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) return data.toString("utf8");
    if (method === 8) return zlib.inflateRawSync(data).toString("utf8");
    return "";
  }
  return "";
}

function docxExtract(filePath) {
  try {
    const xml = zipInflateEntry(filePath, "word/document.xml");
    if (!xml) return "";
    return xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "");
  } catch (_) {
    return "";
  }
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    const st = fs.statSync(filePath);
    if (st.size > 15 * 1024 * 1024) return "";
    if (ext === ".pdf") {
      const buf = fs.readFileSync(filePath);
      if (/\/Encrypt\b/.test(buf.toString("binary").slice(0, 2000))) return "";
      return pdfExtract(buf);
    }
    if (ext === ".docx") return await docxExtract(filePath);
    if ([".txt", ".md", ".json", ".csv", ".log"].includes(ext) || isCodeExt(ext)) {
      return fs.readFileSync(filePath, "utf8");
    }
    return "";
  } catch (_) {
    return "";
  }
}

const CODE_EXTS = new Set([
  ".js", ".ts", ".py", ".java", ".c", ".cpp", ".cs", ".go", ".rb", ".rs", ".php",
  ".html", ".css", ".xml", ".yml", ".yaml", ".sh", ".ps1", ".sql", ".ini", ".toml",
]);
function isCodeExt(ext) {
  return CODE_EXTS.has(ext);
}

/* ═══════════════════════ CHUNKING ═══════════════════════ */

function chunkText(text, target = 700, overlap = 120) {
  const clean = text.replace(/\s+\n/g, "\n").trim();
  if (!clean) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + target, clean.length);
    if (end < clean.length) {
      const brk = clean.lastIndexOf("\n", end);
      const dot = clean.lastIndexOf(". ", end);
      if (brk > start + target * 0.5) end = brk + 1;
      else if (dot > start + target * 0.5) end = dot + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece.length > 40) chunks.push(piece);
    if (end >= clean.length) break;
    start = end - overlap;
  }
  return chunks;
}

/* ═══════════════════════ ÍNDICE BM25 ═══════════════════════ */

let index = null;
const INDEX_FILE = path.join(config.CONFIG_DIR, "rag-index.json");

function loadPersisted() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    if (raw && Array.isArray(raw.docs) && raw.docs.length) index = raw;
  } catch (_) {}
}

function saveIndex() {
  if (!index) return;
  try {
    fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index), "utf8");
  } catch (e) {
    console.error("rag save:", e.message);
  }
}

loadPersisted();

async function buildIndex(onProgress) {
  const ragCfg = config.get().rag;
  const docs = [];
  const EXTS = new Set([".txt", ".md", ".pdf", ".docx", ".csv", ".json", ".log", ...CODE_EXTS]);

  const folders = ragCfg.folders.filter((f) => {
    try {
      return fs.statSync(f).isDirectory();
    } catch (_) {
      return false;
    }
  });

  let filesScanned = 0;
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of ents) {
      if (ent.name.startsWith(".") || ent.name.startsWith("$")) continue;
      if (["node_modules", "AppData", "__pycache__", ".git"].includes(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (EXTS.has(path.extname(ent.name).toLowerCase())) {
        try {
          if (fs.statSync(full).size <= 15 * 1024 * 1024) files.push(full);
        } catch (_) {}
      }
    }
  };
  folders.forEach((f) => walk(f, 0));

  for (let i = 0; i < files.length; i++) {
    const fp = files[i];
    if (onProgress && i % 5 === 0) onProgress({ step: i, total: files.length, file: path.basename(fp) });
    const text = await extractText(fp);
    if (!text || text.length < 60) continue;
    const pieces = chunkText(text);
    pieces.forEach((piece, ci) => {
      docs.push({
        id: `${fp}#${ci}`,
        file: path.basename(fp),
        filePath: fp,
        chunk: ci,
        text: piece.slice(0, 1200),
        tokens: tokenize(piece),
      });
    });
  }

  // estatísticas BM25
  const N = docs.length;
  const df = {};
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.tokens.length;
    const seen = new Set(d.tokens);
    for (const t of seen) df[t] = (df[t] || 0) + 1;
  }
  const avgLen = N ? totalLen / N : 0;

  index = {
    docs: docs.map((d) => ({ ...d })),
    df,
    avgLen,
    builtAt: Date.now(),
  };

  config.update({
    rag: {
      indexedAt: Date.now(),
      stats: { files: files.length, chunks: N, terms: Object.keys(df).length },
    },
  });

  saveIndex();
  return index ? { files: files.length, chunks: N, terms: Object.keys(df).length } : null;
}

function bm25Search(query, k = 6) {
  if (!index || !index.docs.length) return [];
  const k1 = 1.4;
  const b = 0.72;
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];

  const scores = new Map();
  for (const d of index.docs) {
    const tf = {};
    for (const t of d.tokens) tf[t] = (tf[t] || 0) + 1;
    let score = 0;
    for (const qt of qTokens) {
      const f = tf[qt];
      if (!f) continue;
      const idf = Math.log((index.docs.length - (index.df[qt] || 0) + 0.5) / ((index.df[qt] || 0) + 0.5) + 1);
      score +=
        idf *
        ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.tokens.length / (index.avgLen || 1)))));
    }
    if (score > 0) scores.set(d, score);
  }

  return [...scores.entries()]
    .sort((a, b2) => b2[1] - a[1])
    .slice(0, k)
    .map(([d, score]) => ({
      file: d.file,
      filePath: d.filePath,
      chunk: d.chunk,
      text: d.text,
      score: Math.round(score * 100) / 100,
    }));
}

function ollamaStatus() {
  return ollama.status();
}

/* ═══════════════════════ RESPOSTAS ═══════════════════════ */

async function ask(question) {
  if (!question || !question.trim()) return { answer: "digite uma pergunta.", sources: [], mode: "none" };
  const results = bm25Search(question, 6);
  const sources = results.map((r) => ({ file: r.file, chunk: r.chunk, snippet: r.text.slice(0, 180), score: r.score }));

  if (!results.length) {
    return {
      answer:
        index && index.docs.length
          ? "Não encontrei nada nos documentos indexados sobre isso. Tente reformular com outros termos."
          : "O índice está vazio. Adicione uma pasta na aba RAG e clique em Indexar.",
      sources: [],
      mode: "empty",
    };
  }

  const models = await ollamaStatus();
  if (models && models.length) {
    const context = results.map((r, i) => `[${i + 1}] (${r.file})\n${r.text}`).join("\n\n---\n\n");
    const prompt =
      `Você é um assistente que responde APENAS com base nos trechos fornecidos.\n` +
      `Responda em português do Brasil, de forma direta. Se a resposta não estiver nos trechos, diga que não encontrou.\n\n` +
      `Trechos:\n${context}\n\nPergunta: ${question}\n\nResposta:`;
    try {
      const answer = await ollama.generate(models[0], prompt);
      return { answer: answer.trim(), sources, mode: `ollama:${models[0]}` };
    } catch (_) {
      /* cai no modo extrativo */
    }
  }

  const top = results[0];
  const lines = [
    `Com base nos documentos indexados, encontrei ${results.length} trecho(s) relevante(s):`,
    "",
    `📌 "${top.text.slice(0, 400)}${top.text.length > 400 ? "…" : ""}"`,
    `   — ${top.file}`,
  ];
  if (results.length > 1) {
    lines.push("", `Também há conteúdo relacionado em: ${[...new Set(results.slice(1).map((r) => r.file))].join(", ")}.`);
  }
  lines.push("", "(instale o Ollama com um modelo local para respostas geradas por IA)");
  return { answer: lines.join("\n"), sources, mode: "extrativo" };
}

function getIndexInfo() {
  if (!index) {
    const st = config.get().rag.stats;
    return st ? { ...st, inMemory: false } : null;
  }
  return {
    files: [...new Set(index.docs.map((d) => d.filePath))].length,
    chunks: index.docs.length,
    terms: Object.keys(index.df).length,
    inMemory: true,
  };
}

module.exports = { buildIndex, ask, getIndexInfo, bm25Search, ollamaStatus, tokenize };
