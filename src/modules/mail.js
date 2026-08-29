"use strict";

const tls = require("tls");
const net = require("net");
const ollama = require("../ollama");

/* ═══════════════════════ UTILITÁRIOS MIME ═══════════════════════ */

function decodeRfc2047(str) {
  if (!str) return "";
  return str.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs, enc, data) => {
    try {
      let buf;
      if (enc.toLowerCase() === "b") {
        buf = Buffer.from(data, "base64");
      } else {
        const qp = data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h) =>
          String.fromCharCode(parseInt(h, 16))
        );
        buf = Buffer.from(qp, "binary");
      }
      return buf.toString(/8859|latin/i.test(cs) ? "latin1" : "utf8");
    } catch (_) {
      return data;
    }
  });
}

function qpDecode(text) {
  return text
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseHeaders(text) {
  const headers = {};
  const lines = text.split(/\r?\n/);
  let lastKey = null;
  for (const line of lines) {
    if (/^\s/.test(line) && lastKey) {
      headers[lastKey] += " " + line.trim();
    } else {
      const idx = line.indexOf(":");
      if (idx > 0) {
        lastKey = line.slice(0, idx).trim().toLowerCase();
        headers[lastKey] = line.slice(idx + 1).trim();
      }
    }
  }
  return headers;
}

function getCharset(contentType) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || "");
  return m ? m[1].toLowerCase() : "utf-8";
}

function bufToString(buf, charset) {
  try {
    return buf.toString(/8859|latin/i.test(charset) ? "latin1" : "utf8");
  } catch (_) {
    return buf.toString("utf8");
  }
}

function splitBuffer(buf, sepStr) {
  const sep = Buffer.from(sepStr, "binary");
  const parts = [];
  let start = 0;
  let idx;
  while ((idx = buf.indexOf(sep, start)) !== -1) {
    parts.push(buf.subarray(start, idx));
    start = idx + sep.length;
  }
  parts.push(buf.subarray(start));
  return parts;
}

function decodeBody(headers, bodyBuf) {
  const cte = (headers["content-transfer-encoding"] || "").toLowerCase();
  const charset = getCharset(headers["content-type"]);
  if (cte === "base64") {
    return bufToString(
      Buffer.from(bodyBuf.toString("ascii").replace(/[^A-Za-z0-9+/=]/g, ""), "base64"),
      charset
    );
  }
  if (cte === "quoted-printable") {
    return bufToString(Buffer.from(qpDecode(bodyBuf.toString("binary")), "binary"), charset);
  }
  return bufToString(bodyBuf, charset);
}

function extractTextFromPart(headers, bodyBuf) {
  const ctype = (headers["content-type"] || "").toLowerCase();
  if (ctype.startsWith("multipart/")) {
    const m = /boundary="?([^";]+)"?/i.exec(headers["content-type"] || "");
    if (!m) return null;
    let htmlFallback = null;
    for (const part of splitBuffer(bodyBuf, "--" + m[1])) {
      let text = part;
      let divIdx = text.indexOf("\r\n\r\n");
      let sepLen = 4;
      if (divIdx === -1) {
        divIdx = text.indexOf("\n\n");
        sepLen = 2;
      }
      const ph = parseHeaders(text.subarray(0, divIdx).toString("binary"));
      const pb = text.subarray(divIdx + sepLen);
      const innerCtype = (ph["content-type"] || "").toLowerCase();
      const inner = extractTextFromPart(ph, pb);
      if (!inner) continue;
      if (innerCtype.startsWith("text/plain") || !innerCtype.startsWith("text/html")) return inner;
      htmlFallback = htmlFallback || inner;
    }
    return htmlFallback;
  }
  if (ctype && !ctype.startsWith("text/")) return null;
  let text = decodeBody(headers, bodyBuf);
  if (ctype.startsWith("text/html")) text = htmlToText(text);
  return text && text.trim() ? text : null;
}

function parseRawEmail(rawBuf) {
  let divIdx = rawBuf.indexOf("\r\n\r\n");
  let sepLen = 4;
  if (divIdx === -1) {
    divIdx = rawBuf.indexOf("\n\n");
    sepLen = 2;
  }
  if (divIdx === -1) return { subject: "(sem assunto)", from: "", date: "", text: "" };
  const headers = parseHeaders(rawBuf.subarray(0, divIdx).toString("binary"));
  const bodyBuf = rawBuf.subarray(divIdx + sepLen);

  const addrMatch = (s) => {
    s = decodeRfc2047(s || "");
    const m = /"?([^"<]*)"?\s*<([^>]+)>/.exec(s);
    return m ? { name: (m[1] || "").trim() || m[2], email: m[2].trim() } : { name: s.trim(), email: s.trim() };
  };

  return {
    subject: decodeRfc2047(headers.subject) || "(sem assunto)",
    from: addrMatch(headers.from),
    to: addrMatch(headers.to),
    date: headers.date || "",
    text: extractTextFromPart(headers, bodyBuf) || "(mensagem sem texto legível)",
  };
}

function imapQuote(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/* ═══════════════════════ CLIENTE IMAP ═══════════════════════ */

class ImapClient {
  constructor(host, port) {
    this.host = host;
    this.port = port || 993;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.units = [];
    this.pendingLine = "";
    this.pendingLitNeed = 0;
    this.litCounter = 0;
    this.tagN = 0;
    this.waiters = [];
    this.dead = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this._reject = reject;
      this.socket = tls.connect({ host: this.host, port: this.port, servername: this.host }, () => {
        this.socket.setTimeout(120000);
        resolve();
      });
      this.socket.setTimeout(25000, () => this._fail(new Error("timeout de conexão IMAP")));
      this.socket.on("error", (e) => this._fail(e));
      this.socket.on("data", (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        try {
          this._process();
        } catch (e) {
          this._fail(e);
        }
      });
    });
  }

  _fail(e) {
    if (this.dead) return;
    this.dead = true;
    if (this._reject) {
      const r = this._reject;
      this._reject = null;
      r(e);
    }
    for (const w of this.waiters.splice(0)) {
      try {
        w.reject(e);
      } catch (_) {}
    }
    try {
      this.socket.destroy();
    } catch (_) {}
  }

  waitGreeting() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        fn(v);
      };
      const check = () => {
        const t = this._joinedText().trimStart();
        if (/^\* (OK|PREAUTH)/i.test(t)) {
          finish(resolve, t.split("\n")[0]);
          return true;
        }
        if (/^\* BYE/i.test(t)) {
          finish(reject, new Error("servidor recusou: " + t.split("\n")[0]));
          return true;
        }
        return false;
      };
      this.waiters.push({ check, resolve: (v) => finish(resolve, v), reject: (e) => finish(reject, e) });
      if (check()) this.waiters = this.waiters.filter((w) => w.check !== check);
      setTimeout(() => finish(reject, new Error("sem saudação do servidor")), 15000);
    });
  }

  _process() {
    for (;;) {
      if (this.pendingLitNeed > 0) {
        if (this.buf.length < this.pendingLitNeed) break;
        const id = `L${++this.litCounter}`;
        const data = Buffer.from(this.buf.subarray(0, this.pendingLitNeed));
        this.units.push({ type: "literal", id, data });
        this.buf = this.buf.subarray(this.pendingLitNeed);
        this.pendingLitNeed = 0;
        continue;
      }
      const nl = this.buf.indexOf("\r\n");
      if (nl === -1) break;
      const seg = this.buf.subarray(0, nl).toString("binary");
      this.buf = this.buf.subarray(nl + 2);
      this.pendingLine += seg + "\n";
      const m = /\{(\d+)\}\n$/.exec(this.pendingLine);
      if (m) {
        this.pendingLitNeed = parseInt(m[1], 10);
        if (this.pendingLitNeed > 8 * 1024 * 1024) {
          this._fail(new Error("mensagem IMAP grande demais"));
          return;
        }
        this.pendingLine = this.pendingLine.replace(/\{\d+\}\n$/, "");
        this.units.push({ type: "line", text: this.pendingLine });
        this.pendingLine = "";
      } else {
        this.units.push({ type: "line", text: this.pendingLine });
        this.pendingLine = "";
      }
    }
    this._checkWaiters();
  }

  _joinedText() {
    let out = "";
    for (const u of this.units) if (u.type === "line") out += u.text;
    if (this.pendingLine) out += this.pendingLine;
    return out;
  }

  _checkWaiters() {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      let done = false;
      let error;
      try {
        done = w.check();
      } catch (e) {
        error = e;
      }
      if (done || error) {
        this.waiters.splice(i, 1);
        if (error) w.reject(error);
      }
    }
  }

  command(cmd, timeoutMs) {
    const tag = `A${String(++this.tagN).padStart(4, "0")}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        fn(v);
      };
      const check = () => {
        const text = this._joinedText();
        const re = new RegExp(`^${tag} (OK|NO|BAD)([^\\n]*)`, "im");
        const m = re.exec(text);
        if (!m) return false;
        if (m[1] === "OK") finish(resolve, text);
        else finish(reject, new Error(`IMAP ${m[1]}: ${m[2].trim()}`));
        return true;
      };
      this.waiters.push({ check, resolve: (v) => finish(resolve, v), reject: (e) => finish(reject, e) });
      try {
        this.socket.write(`${tag} ${cmd}\r\n`);
      } catch (e) {
        finish(reject, e);
        return;
      }
      setTimeout(() => finish(reject, new Error("tempo esgotado no comando IMAP: " + cmd.slice(0, 40))), timeoutMs || 60000);
    });
  }

  takeUnits() {
    const snapshot = { lines: this._joinedText(), literals: [] };
    for (const u of this.units) if (u.type === "literal") snapshot.literals.push(u.data);
    this.units = [];
    return snapshot;
  }

  logout() {
    try {
      if (this.socket && !this.dead) this.socket.write("A9999 LOGOUT\r\n");
    } catch (_) {}
    setTimeout(() => {
      try {
        this.socket.destroy();
      } catch (_) {}
    }, 300);
  }
}

async function listInbox(cfg, limit = 20) {
  const client = new ImapClient(cfg.imapHost, cfg.imapPort);
  try {
    await client.connect();
    await client.waitGreeting();
    await client.command(`LOGIN "${imapQuote(cfg.user)}" "${imapQuote(cfg.password)}"`, 25000);
    client.takeUnits();
    await client.command("SELECT INBOX", 25000);
    client.takeUnits();

    let ids = [];
    try {
      const searchRes = await client.command("UID SEARCH ALL", 25000);
      const m = /^\* SEARCH (.*)$/im.exec(searchRes);
      ids = m && m[1].trim() ? m[1].trim().split(/\s+/).filter(Boolean) : [];
    } catch (_) {}

    const newest = ids.slice(-limit).reverse();
    const messages = [];

    for (const uid of newest) {
      try {
        client.takeUnits();
        await client.command(`UID FETCH ${uid} (BODY.PEEK[])`);
        const snap = client.takeUnits();
        let raw = null;
        for (const u of snap.literals) {
          if (!raw || u.length > raw.length) raw = u;
        }
        if (!raw) continue;
        const parsed = parseRawEmail(raw);
        parsed.seq = Number(uid);
        messages.push(parsed);
      } catch (_) {}
    }
    return messages;
  } finally {
    client.logout();
  }
}

/* ═══════════════════════ CLIENTE SMTP ═══════════════════════ */

class SmtpClient {
  constructor(host, port) {
    this.host = host;
    this.port = port || 465;
    this.socket = null;
    this.buf = "";
    this.waiters = [];
    this.ready = null;
  }

  _onError(e) {
    const r = this.ready;
    if (r) {
      this.ready = null;
      r.reject(e);
    }
    for (const w of this.waiters.splice(0)) {
      try {
        w.reject(e);
      } catch (_) {}
    }
  }

  _bind(socket) {
    this.socket = socket;
    this.socket.setEncoding("binary");
    this.socket.setTimeout(45000, () => this._onError(new Error("timeout SMTP")));
    this.socket.on("error", (e) => this._onError(e));
    this.socket.on("data", (d) => this._feed(d));
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ready = { resolve, reject };
      if (this.port === 465) {
        this._bind(tls.connect({ host: this.host, port: this.port, servername: this.host }));
      } else {
        this._bind(net.connect({ host: this.host, port: this.port }));
      }
    });
  }

  _feed(d) {
    this.buf += d;
    let idx;
    while ((idx = this.buf.indexOf("\r\n")) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) continue;
      if (m[2] === "-") continue;
      const res = { code: parseInt(m[1], 10), text: m[3], line };
      if (this.ready) {
        const r = this.ready;
        this.ready = null;
        if (res.code === 220) r.resolve(res);
        else r.reject(new Error("SMTP saudação: " + res.code));
      } else if (this.waiters.length) {
        this.waiters.shift().resolve(res);
      }
    }
  }

  cmd(line, minOk, maxOk) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        fn(v);
      };
      this.waiters.push({
        resolve: (res) => {
          if (res.code >= minOk && res.code <= (maxOk ?? minOk)) finish(resolve, res);
          else finish(reject, new Error(`SMTP ${res.code}: ${res.text.split("\n")[0]}`));
        },
        reject: (e) => finish(reject, e),
      });
      try {
        this.socket.write(line + "\r\n", "binary");
      } catch (e) {
        finish(reject, e);
        return;
      }
      setTimeout(() => finish(reject, new Error("tempo esgotado no SMTP")), 30000);
    });
  }

  startTls() {
    return new Promise((resolve, reject) => {
      const raw = this.socket;
      raw.removeAllListeners("data");
      raw.removeAllListeners("error");
      raw.setTimeout(0);
      const secure = tls.connect({ socket: raw, host: this.host, servername: this.host }, () => {
        this._bind(secure);
        resolve();
      });
      secure.on("error", reject);
    });
  }

  end() {
    setTimeout(() => {
      try {
        this.socket.destroy();
      } catch (_) {}
    }, 400);
  }
}

async function smtpAuth(smtp, cfg) {
  try {
    await smtp.cmd("AUTH LOGIN", 300, 399);
    await smtp.cmd(Buffer.from(cfg.user).toString("base64"), 300, 399);
    await smtp.cmd(Buffer.from(cfg.password).toString("base64"), 200, 299);
  } catch (_) {
    const plain = Buffer.from(`\0${cfg.user}\0${cfg.password}`).toString("base64");
    await smtp.cmd("AUTH PLAIN " + plain, 200, 299);
  }
}

async function sendMail(cfg, { to, subject, text }) {
  const smtp = new SmtpClient(cfg.smtpHost, cfg.smtpPort);
  await smtp.connect();
  await smtp.cmd("EHLO nexusdesk.local", 200, 399);
  if (Number(cfg.smtpPort) !== 465) {
    await smtp.cmd("STARTTLS", 200, 399);
    await smtp.startTls();
    await smtp.cmd("EHLO nexusdesk.local", 200, 399);
  }
  await smtpAuth(smtp, cfg);

  await smtp.cmd(`MAIL FROM:<${cfg.user}>`, 200, 299);
  await smtp.cmd(`RCPT TO:<${to}>`, 200, 299);
  await smtp.cmd("DATA", 300, 399);

  const headers =
    `From: ${cfg.name || cfg.user} <${cfg.user}>\r\n` +
    `To: ${to}\r\n` +
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=\r\n` +
    `Date: ${new Date().toUTCString()}\r\n` +
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@nexusdesk>\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `\r\n`;

  const b64Body = Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");

  const payload = headers + b64Body + "\r\n.";
  smtp.socket.write(payload + "\r\n", "binary");
  await new Promise((resolve, reject) => {
    let settled = false;
    smtp.waiters.push({
      resolve: (res) => {
        if (settled) return;
        settled = true;
        res.code >= 200 && res.code < 300 ? resolve(res) : reject(new Error("SMTP " + res.code));
      },
      reject: (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      },
    });
    setTimeout(() => reject(new Error("timeout ao enviar corpo")), 30000);
  });
  smtp.cmd("QUIT", 200, 299).catch(() => {});
  smtp.end();
  return true;
}

/* ═══════════════════════ GERADOR DE RESPOSTAS ═══════════════════════ */

function firstName(nameOrEmail) {
  const n = (nameOrEmail || "").split("@")[0].split(/[.\s_-]/)[0];
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function templateDraft(msg, myName) {
  const body = (msg.text || "").toLowerCase();
  const subj = (msg.subject || "").toLowerCase();
  const person = firstName(msg.from?.name || msg.from?.email || "");
  const hasQ = /\?/.test(msg.text || "");

  let intentLines;
  if (/reuni|call|meet|agenda|horári|disponib/.test(body + subj)) {
    intentLines = [
      "Sobre a reunião: minha agenda está aberta nas manhãs desta semana.",
      "Se preferir, me envie dois ou três horários que funcionam para você e eu confirmo na sequência.",
    ];
  } else if (/orçament|preç|valor|cotaç|budget|proposta/.test(body + subj)) {
    intentLines = [
      "Agradeço pelo contato referente ao orçamento.",
      "Vou consolidar os detalhes solicitados e retorno em seguida com os valores e prazos atualizados.",
    ];
  } else if (/prazo|deadline|urgente|entrega/.test(body + subj)) {
    intentLines = [
      "Entendi o prazo mencionado e já estou organizando o que é necessário para cumpri-lo.",
      "Caso haja qualquer risco de atraso, aviso com antecedência com uma nova estimativa.",
    ];
  } else if (/obrigad|agradeç|thanks/.test(body + subj)) {
    intentLines = ["Fico feliz em ajudar! Se precisar de qualquer outra coisa, estarei à disposição."];
  } else if (hasQ) {
    intentLines = [
      "Respondendo à sua pergunta:",
      msg.text.split("?")[0].slice(0, 80).trim() + "? — verifiquei aqui e te trago a resposta completa abaixo.",
    ];
  } else {
    intentLines = [
      "Recebi sua mensagem e agradeço o contato.",
      "Vou analisar com atenção e retorno com mais detalhes em breve.",
    ];
  }

  return (
    `Olá ${person}, tudo bem?\n\n` +
    intentLines.join("\n\n") +
    `\n\nFico à disposição para o que precisar.\n\n` +
    `Atenciosamente,\n${myName || ""}`
  );
}

async function generateDraft(msg, myName) {
  const fallback = templateDraft(msg, myName);
  const models = await ollama.status();
  if (!models || !models.length) return fallback;
  const prompt =
    `Escreva um e-mail de resposta profissional em português do Brasil.\n` +
    `Remetente: ${msg.from?.name || ""} <${msg.from?.email || ""}>\n` +
    `Assunto: ${msg.subject || ""}\n` +
    `Mensagem:\n${(msg.text || "").slice(0, 4000)}\n\n` +
    `Assine como: ${myName || ""}\n` +
    `Apenas o corpo do e-mail, sem assunto e sem markdown.`;
  try {
    const answer = await ollama.generate(models[0], prompt, 60000);
    return (answer || "").trim() || fallback;
  } catch (_) {
    return fallback;
  }
}

module.exports = { listInbox, sendMail, generateDraft, parseRawEmail, ImapClient, SmtpClient };
