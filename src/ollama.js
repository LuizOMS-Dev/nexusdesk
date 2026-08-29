"use strict";

function base() {
  return (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

async function status() {
  try {
    const res = await fetch(base() + "/api/tags", { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.models || []).map((m) => m.name);
  } catch (_) {
    return null;
  }
}

async function generate(model, prompt, timeoutMs) {
  const res = await fetch(base() + "/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.timeout(timeoutMs || 120000),
  });
  const j = await res.json();
  return j.response || "";
}

async function pull(name) {
  const res = await fetch(base() + "/api/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, stream: false }),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!res.ok) throw new Error("pull falhou: HTTP " + res.status);
  return res.json();
}

async function ensureModel() {
  const wanted = process.env.OLLAMA_PULL || "llama3.2";
  const models = await status();
  if (models && models.length) return models;
  try {
    console.log("ollama: baixando", wanted);
    await pull(wanted);
    return await status();
  } catch (e) {
    console.error("ollama pull:", e.message);
    return null;
  }
}

module.exports = { base, status, generate, pull, ensureModel };
