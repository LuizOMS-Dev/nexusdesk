"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.nexus;
  if (!api) return;

  const PRESETS = {
    gmail: { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465 },
    outlook: { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com", smtpPort: 587 },
    yahoo: { imapHost: "imap.mail.yahoo.com", imapPort: 993, smtpHost: "smtp.mail.yahoo.com", smtpPort: 465 },
  };

  let orgHistory = [];
  let selectedMail = null;
  let mailTried = false;
  let cfgCache = null;

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toast(msg, kind) {
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(1) + " GB";
  }

  function relTime(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return "agora";
    if (s < 3600) return Math.floor(s / 60) + " min";
    if (s < 86400) return Math.floor(s / 3600) + " h";
    return new Date(ts).toLocaleString("pt-BR");
  }

  function showView(name) {
    document.querySelectorAll(".nav-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === name);
    });
    document.querySelectorAll(".view").forEach((v) => {
      v.classList.toggle("active", v.id === "view-" + name);
    });
    if (name === "mail" && !mailTried) {
      mailTried = true;
      refreshMail(false);
    }
  }

  document.getElementById("nav").addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-item");
    if (btn) showView(btn.dataset.view);
  });

  /* ═══════════════ ORGANIZER ═══════════════ */

  function renderStats(stats) {
    stats = stats || { total: 0, byCat: {}, totalSize: 0 };
    $("stTotal").textContent = String(stats.total || 0);
    $("stSize").textContent = fmtBytes(stats.totalSize);
    const cats = Object.entries(stats.byCat || {});
    $("stCats").innerHTML = cats.length
      ? cats.map(([k, v]) => `<span class="pill" data-cat="${esc(k)}">${esc(k)} ${v}</span>`).join(" ")
      : "<em>nenhuma categoria ainda</em>";
    const n = orgHistory.filter((h) => !h.undone).length;
    $("badgeDownloads").hidden = n === 0;
    $("badgeDownloads").textContent = String(n);
    $("btnUndo").disabled = !orgHistory.some((h) => !h.undone);
  }

  function renderFeed() {
    const ul = $("orgFeed");
    if (!orgHistory.length) {
      ul.innerHTML = '<li class="empty-line">a vigilância capturará novos arquivos aqui…</li>';
      return;
    }
    ul.innerHTML = orgHistory
      .map(
        (h) => `<li class="${h.undone ? "undone" : ""}" data-id="${esc(h.id)}">
          <span class="pill" data-cat="${esc(h.category)}">${esc(h.category)}</span>
          <span class="file-name" title="${esc(h.to)}">${esc(h.file)}</span>
          <span class="when">${relTime(h.at)}</span>
          <button class="linkish" data-undo="${esc(h.id)}" ${h.undone ? "disabled" : ""}>desfazer</button>
        </li>`
      )
      .join("");
  }

  function applyOrgStatus(st) {
    orgHistory = st.history || [];
    $("orgToggle").classList.toggle("on", !!st.enabled);
    $("watchDir").textContent = st.watchDir || "";
    $("setWatchDir").textContent = st.watchDir || "—";
    renderStats(st.stats);
    renderFeed();
  }

  async function loadOrganizer() {
    const st = await api.organizer.getStatus();
    applyOrgStatus(st);
  }

  $("orgToggle").addEventListener("click", async () => {
    const next = !$("orgToggle").classList.contains("on");
    const ok = await api.organizer.setEnabled(next);
    if (next && ok === false) {
      toast("não foi possível vigiar a pasta", "err");
      $("orgToggle").classList.remove("on");
      return;
    }
    $("orgToggle").classList.toggle("on", next);
    toast(next ? "vigília ligada" : "vigília pausada");
  });

  $("btnScanNow").addEventListener("click", async () => {
    $("btnScanNow").disabled = true;
    $("btnScanNow").textContent = "organizando…";
    try {
      const res = await api.organizer.scanNow();
      orgHistory = res.history || orgHistory;
      renderStats(res.stats);
      renderFeed();
      const n = (res.moved || []).length;
      toast(n ? n + " arquivo(s) organizado(s)" : "nada para organizar");
      if (res.error) toast(res.error, "err");
    } catch (e) {
      toast(e.message || "falha ao organizar", "err");
    } finally {
      $("btnScanNow").disabled = false;
      $("btnScanNow").textContent = "Organizar agora";
    }
  });

  async function undoId(id) {
    const res = await api.organizer.undo(id);
    if (!res.ok) {
      toast(res.error || "não foi possível desfazer", "err");
      return;
    }
    const st = await api.organizer.getHistory();
    orgHistory = st.history || [];
    renderStats(st.stats);
    renderFeed();
    toast("movimentação desfeita");
  }

  $("btnUndo").addEventListener("click", async () => {
    const last = orgHistory.find((h) => !h.undone);
    if (last) await undoId(last.id);
  });

  $("orgFeed").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-undo]");
    if (btn) undoId(btn.getAttribute("data-undo"));
  });

  api.organizer.onMoved((entry) => {
    orgHistory.unshift(entry);
    renderFeed();
    api.organizer.getHistory().then((st) => {
      orgHistory = st.history || orgHistory;
      renderStats(st.stats);
      renderFeed();
    });
  });

  async function chooseWatch() {
    const folder = await api.organizer.chooseFolder();
    if (folder) {
      $("watchDir").textContent = folder;
      $("setWatchDir").textContent = folder;
      toast("pasta monitorada atualizada");
    }
  }
  $("btnChooseWatch").addEventListener("click", chooseWatch);

  /* ═══════════════ MAIL ═══════════════ */

  function setMailConnected(on, label) {
    $("mailDot").classList.toggle("on", on);
    const chip = $("mailStatusChip");
    chip.textContent = label || (on ? "conectado" : "desconectado");
    chip.className = "chip" + (on ? " ok" : "");
  }

  function fillMailForm(mail) {
    if (!mail) return;
    $("mUser").value = mail.user || "";
    $("mName").value = mail.name || "";
    $("mPass").value = mail.password || "";
    $("mImapHost").value = mail.imapHost || "";
    $("mImapPort").value = mail.imapPort || 993;
    $("mSmtpHost").value = mail.smtpHost || "";
    $("mSmtpPort").value = mail.smtpPort || 465;
  }

  function credsFromForm() {
    return {
      user: $("mUser").value.trim(),
      name: $("mName").value.trim(),
      password: $("mPass").value,
      imapHost: $("mImapHost").value.trim(),
      imapPort: Number($("mImapPort").value) || 993,
      smtpHost: $("mSmtpHost").value.trim(),
      smtpPort: Number($("mSmtpPort").value) || 465,
    };
  }

  function renderInbox(messages) {
    const ul = $("inboxList");
    $("mailCount").textContent = messages.length ? messages.length + " msgs" : "";
    if (!messages.length) {
      ul.innerHTML = '<li class="empty-line">caixa vazia</li>';
      return;
    }
    ul.innerHTML = messages
      .map(
        (m, i) => `<li data-i="${i}">
          <span class="from">${esc(m.from?.name || m.from?.email || "—")}</span>
          <span class="subj">${esc(m.subject || "(sem assunto)")}</span>
          <span class="date">${esc(m.date || "")}</span>
        </li>`
      )
      .join("");
    ul.querySelectorAll("li[data-i]").forEach((li) => {
      li.addEventListener("click", () => selectMail(messages[Number(li.dataset.i)], li));
    });
  }

  function selectMail(msg, li) {
    selectedMail = msg;
    document.querySelectorAll(".inbox li").forEach((x) => x.classList.remove("active"));
    if (li) li.classList.add("active");
    $("rdSubject").textContent = msg.subject || "(sem assunto)";
    $("rdFrom").textContent = (msg.from?.name || "") + " <" + (msg.from?.email || "") + ">";
    $("rdBody").textContent = msg.text || "";
    $("replyTo").value = msg.from?.email || "";
    $("draftText").value = "";
    $("btnGenDraft").disabled = false;
    $("sendStatus").textContent = "";
  }

  async function refreshMail(showErr) {
    const cfg = cfgCache || (await api.getConfig());
    if (!cfg.mail?.saved) {
      $("mailForm").hidden = false;
      $("mailSplit").hidden = true;
      setMailConnected(false, "desconectado");
      return;
    }
    $("mailStatusChip").textContent = "carregando…";
    const res = await api.mail.fetchInbox();
    if (!res.ok) {
      setMailConnected(false, "falhou");
      $("mailForm").hidden = false;
      if (showErr !== false) toast(res.error || "falha IMAP", "err");
      return;
    }
    setMailConnected(true, cfg.mail.user || "conectado");
    $("mailForm").hidden = true;
    $("mailSplit").hidden = false;
    renderInbox(res.messages || []);
  }

  $("mailStatusChip").addEventListener("click", () => {
    $("mailForm").hidden = !$("mailForm").hidden;
  });

  document.querySelectorAll(".preset").forEach((b) => {
    b.addEventListener("click", () => {
      const p = PRESETS[b.dataset.preset];
      if (!p) return;
      $("mImapHost").value = p.imapHost;
      $("mImapPort").value = p.imapPort;
      $("mSmtpHost").value = p.smtpHost;
      $("mSmtpPort").value = p.smtpPort;
    });
  });

  $("btnMailConnect").addEventListener("click", async () => {
    const creds = credsFromForm();
    if (!creds.user || !creds.password || !creds.imapHost) {
      toast("preencha e-mail, senha e IMAP", "err");
      return;
    }
    $("btnMailConnect").disabled = true;
    $("btnMailConnect").textContent = "conectando…";
    try {
      const res = await api.mail.connect(creds);
      if (!res.ok) {
        toast(res.error || "falha ao conectar", "err");
        setMailConnected(false, "falhou");
        return;
      }
      cfgCache = await api.getConfig();
      $("mailForm").hidden = true;
      $("mailSplit").hidden = false;
      if (res.messages) renderInbox(res.messages);
      else await refreshMail(true);
      setMailConnected(true, creds.user);
      $("setMail").textContent = creds.user;
      toast("caixa carregada", "ok");
    } finally {
      $("btnMailConnect").disabled = false;
      $("btnMailConnect").textContent = "Conectar e abrir a caixa";
    }
  });

  $("btnRefreshMail").addEventListener("click", () => refreshMail(true));

  $("btnGenDraft").addEventListener("click", async () => {
    if (!selectedMail) return;
    $("btnGenDraft").disabled = true;
    $("btnGenDraft").textContent = "gerando…";
    try {
      const draft = await api.mail.generateDraft(selectedMail);
      $("draftText").value = typeof draft === "string" ? draft : draft?.text || "";
    } catch (e) {
      toast(e.message || "falha ao gerar rascunho", "err");
    } finally {
      $("btnGenDraft").disabled = false;
      $("btnGenDraft").textContent = "Gerar rascunho";
    }
  });

  $("btnSendReply").addEventListener("click", async () => {
    const to = $("replyTo").value.trim();
    const text = $("draftText").value.trim();
    if (!to || !text) {
      toast("destinatário e texto são obrigatórios", "err");
      return;
    }
    $("btnSendReply").disabled = true;
    $("sendStatus").textContent = "enviando…";
    try {
      const subject = selectedMail?.subject
        ? (/^re:/i.test(selectedMail.subject) ? selectedMail.subject : "Re: " + selectedMail.subject)
        : "Resposta";
      const res = await api.mail.send({ to, subject, text });
      if (!res.ok) {
        $("sendStatus").textContent = res.error || "falha SMTP";
        toast(res.error || "falha ao enviar", "err");
      } else {
        $("sendStatus").textContent = "enviado";
        toast("e-mail enviado", "ok");
      }
    } finally {
      $("btnSendReply").disabled = false;
    }
  });

  /* ═══════════════ RAG ═══════════════ */

  function renderFolders(folders) {
    const ul = $("folderList");
    if (!folders || !folders.length) {
      ul.innerHTML = '<li class="empty-line">nenhuma pasta ainda</li>';
      return;
    }
    ul.innerHTML = folders
      .map(
        (f) => `<li>
          <span class="path mono" title="${esc(f)}">${esc(f)}</span>
          <button class="linkish" data-rm="${esc(f)}">remover</button>
        </li>`
      )
      .join("");
  }

  function renderIdx(info) {
    if (!info) {
      $("idxStats").textContent = "índice vazio";
      return;
    }
    $("idxStats").textContent =
      `${info.files || 0} arquivos · ${info.chunks || 0} trechos · ${info.terms || 0} termos` +
      (info.inMemory ? " · em memória" : " · no disco, reindexe para carregar");
  }

  function addChat(role, text, sources) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    div.textContent = text;
    if (sources && sources.length) {
      const s = document.createElement("span");
      s.className = "src";
      s.textContent = "fontes: " + sources.map((x) => x.file + (x.score ? " (" + x.score + ")" : "")).join(" · ");
      div.appendChild(s);
    }
    $("chatLog").appendChild(div);
    $("chatLog").scrollTop = $("chatLog").scrollHeight;
  }

  async function refreshRag() {
    const cfg = cfgCache || (await api.getConfig());
    renderFolders(cfg.rag?.folders || []);
    renderIdx(await api.rag.info());
    const models = await api.rag.ollama();
    const chip = $("ollamaChip");
    if (models && models.length) {
      chip.textContent = "Ollama · " + models[0];
      chip.className = "chip ok";
    } else {
      chip.textContent = "Ollama offline · modo extrativo";
      chip.className = "chip warn";
    }
  }

  $("btnAddFolder").addEventListener("click", async () => {
    const folders = await api.rag.addFolder();
    if (folders) {
      if (cfgCache) cfgCache.rag.folders = folders;
      renderFolders(folders);
    }
  });

  $("folderList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-rm]");
    if (!btn) return;
    const folders = await api.rag.removeFolder(btn.getAttribute("data-rm"));
    if (cfgCache) cfgCache.rag.folders = folders;
    renderFolders(folders);
  });

  $("btnIndex").addEventListener("click", async () => {
    $("btnIndex").disabled = true;
    $("ragProgress").hidden = false;
    $("ragProgressFill").style.width = "4%";
    $("idxStats").textContent = "indexando…";
    try {
      const res = await api.rag.index();
      if (!res.ok) {
        toast(res.error || "falha ao indexar", "err");
        $("idxStats").textContent = res.error || "falha";
      } else {
        renderIdx({ ...res.stats, inMemory: true });
        toast("índice pronto", "ok");
      }
    } finally {
      $("btnIndex").disabled = false;
      $("ragProgress").hidden = true;
      $("ragProgressFill").style.width = "0%";
    }
  });

  api.rag.onProgress((p) => {
    if (!p || !p.total) return;
    const pct = Math.max(4, Math.round((p.step / p.total) * 100));
    $("ragProgressFill").style.width = pct + "%";
    $("idxStats").textContent = `indexando ${p.step}/${p.total} · ${p.file || ""}`;
  });

  $("chatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("chatText").value.trim();
    if (!q) return;
    $("chatText").value = "";
    addChat("user", q);
    addChat("bot", "buscando…");
    const pending = $("chatLog").lastElementChild;
    try {
      const res = await api.rag.ask(q);
      pending.remove();
      addChat("bot", res.answer || "(sem resposta)", res.sources);
    } catch (err) {
      pending.textContent = "erro: " + (err.message || err);
    }
  });

  const dropPanel = document.querySelector(".folders-panel");
  ["dragenter", "dragover"].forEach((ev) => {
    dropPanel.addEventListener(ev, (e) => {
      e.preventDefault();
      dropPanel.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropPanel.addEventListener(ev, (e) => {
      e.preventDefault();
      dropPanel.classList.remove("drag");
    });
  });
  dropPanel.addEventListener("drop", async (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length || !api.pathOf) return;
    let folders = null;
    for (const f of files) {
      try {
        const p = api.pathOf(f);
        if (p) folders = await api.rag.addFolderPath(p);
      } catch (_) {}
    }
    if (folders) {
      if (cfgCache) cfgCache.rag.folders = folders;
      renderFolders(folders);
      toast("pasta adicionada");
    }
  });

  /* ═══════════════ SETTINGS / BOOT ═══════════════ */

  function renderLegend(categories) {
    const box = $("catLegend");
    if (!box || !categories) return;
    box.innerHTML = Object.keys(categories)
      .map((k) => `<span class="pill" data-cat="${esc(k)}">${esc(k)}</span>`)
      .join("");
  }

  async function boot() {
    cfgCache = await api.getConfig();
    fillMailForm(cfgCache.mail);
    $("setMail").textContent = cfgCache.mail?.saved ? cfgCache.mail.user : "não configurada";
    renderLegend(cfgCache.organizer?.categories);
    await loadOrganizer();
    await refreshRag();
    if (cfgCache.mail?.saved) setMailConnected(false, "salvo · clique em E-mail");
  }

  boot().catch((e) => toast(e.message || "falha ao iniciar", "err"));
})();
