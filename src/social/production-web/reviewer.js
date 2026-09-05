"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const sessionKey = "ia4tube.production.session.v2";
  let intentKey = null;
  let token = sessionStorage.getItem(sessionKey), connection = null, media = [], intent = null,
    publicationId = null, submitted = false, confirmed = false, busy = false;
  function selectIntentNamespace() {
    // Claims select local storage only; every API request is authenticated and
    // authorized independently by the server. Never share intent state between
    // different product accounts in this tab.
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof claims.sub !== "string" || claims.sub !== claims.company_id) throw new Error("Entre novamente.");
    intentKey = `ia4tube.production.publication.intent.v3.${encodeURIComponent(claims.sub)}`;
    intent = null; publicationId = null; submitted = false; confirmed = false;
    try {
      const saved = JSON.parse(sessionStorage.getItem(intentKey) || "null");
      if (saved) { intent = Object.freeze(saved.intent); publicationId = saved.publicationId;
        submitted = saved.submitted === true; confirmed = saved.confirmed === true; }
    } catch { submitted = true; }
    $("intent").textContent = ""; $("publish").disabled = true;
    $("reconcile").disabled = !submitted || confirmed;
  }
  const preserveIntent = () => {
    if (!intentKey) throw new Error("Entre novamente antes de publicar.");
    sessionStorage.setItem(intentKey, JSON.stringify({ intent, publicationId, submitted, confirmed }));
  };
  const message = text => { $("status").textContent = text; };
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, redirect: "error", cache: "no-store",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
    const result = await response.json();
    if (!response.ok || result.ok !== true) {
      if (response.status === 401) { token = null; sessionStorage.removeItem(sessionKey); $("login").hidden = false; $("product").hidden = true; }
      throw new Error(result.code || "Operação indisponível. Tente entrar novamente.");
    }
    return result;
  }
  const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  async function act(fn) {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (error) { message(error.message); }
    finally { busy = false; }
  }
  function binding() {
    if (!connection || connection.state !== "connected" || connection.health !== "healthy" ||
        !connection.externalId || !Number.isSafeInteger(connection.connectionRevision)) throw new Error("Atualize a conexão antes de revisar.");
    return { expectedConnectionId: connection.connectionId, expectedExternalId: connection.externalId,
      expectedConnectionRevision: connection.connectionRevision };
  }
  async function refreshConnection() {
    connection = (await api("/v1/social/connections/instagram")).connection;
    $("connection").textContent = connection ? `${connection.username || "Nenhuma conta conectada"}\n${connection.accountType || ""}\nEstado: ${connection.state}\nSaúde: ${connection.health}\nRevisão: ${connection.connectionRevision}` : "Nenhuma conta conectada";
    $("connect").textContent = connection ? "Conectar novamente" : "Conectar Instagram";
    $("connect").disabled = connection?.state === "connected";
  }
  function showMedia() {
    const item = media.find(x => x.id === $("media").value);
    $("preview").hidden = !item;
    if (item) $("preview").src = item.thumbnailUrl;
    else $("preview").removeAttribute("src");
    $("selectedCaption").textContent = item?.caption || "";
  }
  async function refreshMedia() {
    media = (await api("/v1/social/reviewer/media")).media;
    $("media").replaceChildren(...media.map(item => {
      const option = document.createElement("option"); option.value = item.id; option.textContent = item.caption.slice(0, 90); return option;
    }));
    showMedia();
  }
  function showPublication(value) {
    const article = document.createElement("article");
    const text = document.createElement("pre");
    const labels = { published: "Publicado — confirmação recebida", sending: "Enviando", provider_confirming: "Confirmando — resultado ainda incerto" };
    text.textContent = `${labels[value.state] || value.state}\n${value.caption}\nReferência: ${value.publicationId}\nMedia ID: ${value.providerMediaId || "Aguardando confirmação"}\nHorário: ${value.publishedAt || "—"}`;
    article.append(text);
    if (value.state === "provider_confirming" && value.binding) {
      const bound = document.createElement("pre");
      bound.textContent = `Conta original: ${value.binding.externalId}\nRevisão original: ${value.binding.connectionRevision}`;
      const button = document.createElement("button");
      button.type = "button"; button.textContent = "Conferir esta publicação pendente";
      button.onclick = () => act(() => reconcileRecord(value));
      article.append(bound, button);
    }
    if (value.state === "published" && value.permalink) {
      const url = new URL(value.permalink);
      if (url.origin === "https://www.instagram.com" && /^\/p\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
        const link = document.createElement("a"); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Abrir publicação no Instagram"; article.append(link);
      }
    }
    return article;
  }
  async function refreshHistory() {
    const result = await api("/v1/social/reviewer/publications");
    $("history").replaceChildren(...result.publications.map(showPublication));
  }
  async function reconcileRecord(value) {
    const original = value.binding;
    if (!original || !original.connectionId || !original.externalId ||
        !Number.isSafeInteger(original.connectionRevision) || original.connectionRevision < 1) {
      throw new Error("Publicação sem vínculo original confiável. Não envie novamente.");
    }
    const result = await post(`/v1/social/reviewer/publications/${encodeURIComponent(value.publicationId)}/reconcile`, {
      expectedConnectionId: original.connectionId, expectedExternalId: original.externalId,
      expectedConnectionRevision: original.connectionRevision
    });
    if (publicationId === value.publicationId) {
      confirmed = result.publication.state === "published"; preserveIntent();
    }
    await refreshHistory(); message("Resultado consultado na conta original. Publicado só aparece após confirmação.");
  }
  $("loginForm").addEventListener("submit", event => { event.preventDefault(); act(async () => {
    let password = $("password").value;
    try {
      const result = await post("/auth/login", { whatsapp: $("owner").value.trim(), senha: password });
      token = result.token; sessionStorage.setItem(sessionKey, token);
    } finally { password = ""; $("password").value = ""; }
    $("login").hidden = true; $("product").hidden = false;
    await refreshConnection(); selectIntentNamespace(); await refreshMedia(); await refreshHistory(); message("Conta IA4Tube autenticada. Nenhuma operação externa foi iniciada.");
  }); });
  $("refresh").onclick = () => act(refreshConnection);
  $("historyRefresh").onclick = () => act(refreshHistory);
  $("media").onchange = showMedia;
  $("connect").onclick = () => act(async () => {
    const result = await post("/v1/social/connections/instagram/authorization", { purpose: connection ? "reconnect" : "connect" });
    const url = new URL(result.authorizationUrl);
    if (url.origin !== "https://www.instagram.com" || url.pathname !== "/oauth/authorize") throw new Error("Domínio de autorização inválido.");
    location.assign(url.href);
  });
  $("uploadForm").addEventListener("submit", event => { event.preventDefault(); act(async () => {
    const file = $("jpeg").files[0];
    if (!file || file.type !== "image/jpeg" || file.size > 8 * 1024 * 1024) throw new Error("Selecione um JPEG de até 8 MB.");
    const form = new FormData(); form.append("jpeg", file); form.append("caption", $("caption").value.trim());
    await api("/v1/social/reviewer/media", { method: "POST", body: form });
    await refreshMedia(); message("JPEG adicionado. Revise a conta e a legenda antes de publicar.");
  }); });
  $("review").onclick = () => act(async () => {
    if (submitted && !confirmed) throw new Error("A intenção anterior deve ser conferida antes de iniciar outra, mesmo se a resposta se perdeu.");
    await refreshConnection();
    if (!$("media").value) throw new Error("Selecione um JPEG.");
    intent = Object.freeze({ mediaId: $("media").value, clientRequestId: crypto.randomUUID(), ...binding() });
    publicationId = null; submitted = false; confirmed = false; preserveIntent();
    $("intent").textContent = `${connection.username}\nConta: ${intent.expectedExternalId}\nRevisão: ${intent.expectedConnectionRevision}\n${$("selectedCaption").textContent}`;
    $("publish").disabled = false; message("Intenção revisada. O envio ficará vinculado a esta conta e revisão.");
  });
  $("publish").onclick = () => act(async () => {
    if (!intent) throw new Error("Revise a intenção primeiro.");
    $("publish").disabled = true;
    submitted = true; preserveIntent(); $("reconcile").disabled = false;
    // Keep the same intent after an uncertain response; never silently create a retry.
    const result = await post("/v1/social/reviewer/publications", intent);
    publicationId = result.publication.publicationId;
    confirmed = result.publication.state === "published"; preserveIntent();
    $("reconcile").disabled = result.publication.state !== "provider_confirming";
    message(result.publication.state === "published" ? "Publicado: confirmado pelo Instagram." : "Resultado pendente. Confira o histórico, sem publicar novamente.");
    await refreshHistory();
  });
  $("reconcile").onclick = () => act(async () => {
    if (!intent || !submitted) throw new Error("Não há intenção incerta identificada.");
    const found = await api(`/v1/social/reviewer/publication-intents/${encodeURIComponent(intent.clientRequestId)}`);
    if (!found.publication) {
      // Absence is not cancellation: an earlier HTTP request might be in flight.
      message("Ainda sem resultado persistido para esta intenção. Não inicie outra publicação.");
      return;
    }
    publicationId = found.publication.publicationId;
    confirmed = found.publication.state === "published"; preserveIntent();
    if (found.publication.state !== "provider_confirming") {
      await refreshHistory(); message(confirmed ? "Publicado: confirmação recebida." : "Intenção encontrada. Confira o estado no histórico."); return;
    }
    const { expectedConnectionId, expectedExternalId, expectedConnectionRevision } = intent;
    const result = await post(`/v1/social/reviewer/publications/${encodeURIComponent(publicationId)}/reconcile`, { expectedConnectionId, expectedExternalId, expectedConnectionRevision });
    confirmed = result.publication.state === "published"; preserveIntent();
    await refreshHistory(); message("Resultado consultado. Publicado só aparece após confirmação.");
  });
  if (token) act(async () => {
    await refreshConnection(); selectIntentNamespace(); await refreshMedia(); await refreshHistory();
    $("login").hidden = true; $("product").hidden = false;
    $("reconcile").disabled = !submitted || confirmed;
    message("Sessão retomada. Nenhum OAuth ou envio foi iniciado automaticamente.");
  });
})();
