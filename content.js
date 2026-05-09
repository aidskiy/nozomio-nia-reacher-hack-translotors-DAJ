(function () {
  const API_BASE = "https://nvh9k4xn.us-west.insforge.app";
  const TOKEN_KEY = "insforge_tokens";
  const PANEL_ID = "ell-panel";

  const dictionary = {
    approximately: "about",
    demonstrate: "show",
    difficult: "hard",
    however: "but",
    important: "key / needed",
    indicate: "show",
    purchase: "buy",
    significant: "important",
    substantial: "large / important",
    utilize: "use"
  };

  let pendingRange = null;
  let pendingWord = "";
  let session = null;
  let words = [];
  let authView = "signin";
  let authMessage = "";
  let pendingVerificationEmail = null;
  let mutationObserver = null;
  let highlightDebounce = null;

  init();

  async function init() {
    injectPanel();
    await restoreSession();
    if (session) {
      try { await loadWords(); } catch (err) { console.warn("Reader Helper load failed", err); }
      highlightActiveWords(document.body);
      startHighlightObserver();
    }
    renderPanel();

    document.addEventListener("mouseup", handleSelection);
    document.addEventListener("dblclick", handleDoubleClick);
  }

  // --- Auth ---

  async function restoreSession() {
    const stored = await chrome.storage.local.get(TOKEN_KEY);
    const tokens = stored[TOKEN_KEY];
    if (!tokens || !tokens.accessToken) return;

    const res = await apiFetch("/api/auth/sessions/current", { token: tokens.accessToken });
    if (res.ok) {
      const body = await res.json();
      session = { ...tokens, user: body.user };
      return;
    }

    if (tokens.refreshToken) {
      const refreshed = await refreshSession(tokens.refreshToken);
      if (refreshed) return;
    }

    await clearSession();
  }

  async function refreshSession(refreshToken) {
    const res = await apiFetch("/api/auth/refresh?client_type=desktop", {
      method: "POST",
      body: { refreshToken }
    });
    if (!res.ok) return false;
    const body = await res.json();
    await persistSession({
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      user: body.user
    });
    return true;
  }

  async function persistSession(s) {
    session = s;
    await chrome.storage.local.set({
      [TOKEN_KEY]: { accessToken: s.accessToken, refreshToken: s.refreshToken }
    });
  }

  async function clearSession() {
    session = null;
    words = [];
    stopHighlightObserver();
    removeAllHighlightsFromPage();
    await chrome.storage.local.remove(TOKEN_KEY);
  }

  async function signUp(email, password) {
    const res = await apiFetch("/api/auth/users?client_type=desktop", {
      method: "POST",
      body: { email, password }
    });
    const body = await safeJson(res);
    if (!res.ok) throw new Error(extractError(body) || "Sign up failed");

    if (body.requireEmailVerification) {
      pendingVerificationEmail = email;
      authView = "verify";
      authMessage = `We sent a 6-digit code to ${email}.`;
      return;
    }

    await persistSession({
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      user: body.user
    });
    await loadWords();
    highlightActiveWords(document.body);
    startHighlightObserver();
  }

  async function signIn(email, password) {
    const res = await apiFetch("/api/auth/sessions?client_type=desktop", {
      method: "POST",
      body: { email, password }
    });
    const body = await safeJson(res);
    if (!res.ok) throw new Error(extractError(body) || "Sign in failed");
    await persistSession({
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      user: body.user
    });
    await loadWords();
    highlightActiveWords(document.body);
    startHighlightObserver();
  }

  async function verifyEmail(email, otp) {
    const res = await apiFetch("/api/auth/email/verify?client_type=desktop", {
      method: "POST",
      body: { email, otp }
    });
    const body = await safeJson(res);
    if (!res.ok) throw new Error(extractError(body) || "Verification failed");

    if (body.accessToken) {
      await persistSession({
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        user: body.user
      });
      await loadWords();
      highlightSavedWords();
    } else {
      authView = "signin";
      authMessage = "Email verified. Please sign in.";
    }
    pendingVerificationEmail = null;
  }

  async function resendVerification(email) {
    const res = await apiFetch("/api/auth/email/send-verification", {
      method: "POST",
      body: { email }
    });
    if (!res.ok) {
      const body = await safeJson(res);
      throw new Error(extractError(body) || "Could not resend code");
    }
  }

  async function signOut() {
    try { await apiFetch("/api/auth/logout", { method: "POST", token: session && session.accessToken }); } catch (_) {}
    await clearSession();
    authView = "signin";
    authMessage = "Signed out.";
  }

  // --- Words API ---

  async function loadWords() {
    const res = await apiFetch("/api/database/records/words?order=created_at.desc", {
      token: session.accessToken
    });
    if (!res.ok) throw new Error("Failed to load words");
    words = await res.json();
  }

  async function addWordRemote(word) {
    const existing = words.find((w) => w.word === word);
    if (existing) {
      if (!existing.is_active) {
        const res = await apiFetch(`/api/database/records/words?id=eq.${encodeURIComponent(existing.id)}`, {
          method: "PATCH",
          token: session.accessToken,
          body: { is_active: true }
        });
        if (!res.ok) throw new Error("Failed to update word");
        existing.is_active = true;
      }
      return existing;
    }

    const def = getDefinition(word);
    const res = await apiFetch("/api/database/records/words", {
      method: "POST",
      token: session.accessToken,
      prefer: "return=representation",
      body: [{ word, definition: def === "Definition coming soon." ? null : def }]
    });
    if (!res.ok) throw new Error("Failed to save word");
    const body = await res.json();
    const created = body[0];
    words.unshift(created);
    return created;
  }

  async function deactivateWordRemote(wordRow) {
    const res = await apiFetch(`/api/database/records/words?id=eq.${encodeURIComponent(wordRow.id)}`, {
      method: "PATCH",
      token: session.accessToken,
      body: { is_active: false }
    });
    if (!res.ok) throw new Error("Failed to remove word");
    wordRow.is_active = false;
  }

  // --- Selection / marking ---

  function handleSelection(event) {
    if (!session) return;
    if (isExtensionElement(event.target)) return;

    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : "";
    const word = cleanWord(selectedText);
    if (!word || !selection || selection.rangeCount === 0) return;

    pendingRange = selection.getRangeAt(0).cloneRange();
    pendingWord = word;
    renderPanel();
  }

  function handleDoubleClick(event) {
    if (!session) return;
    if (isExtensionElement(event.target)) return;

    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : "";
    const word = cleanWord(selectedText);
    if (!word || !selection || selection.rangeCount === 0) return;

    pendingRange = selection.getRangeAt(0).cloneRange();
    pendingWord = word;
    markPendingWord();
  }


  async function markPendingWord() {
    if (!session || !pendingWord || !pendingRange) return;
    const word = pendingWord;
    const range = pendingRange;

    pendingRange = null;
    pendingWord = "";

    try {
      await addWordRemote(word);
      wrapRange(range, word);
      clearSelection();
      highlightActiveWords(document.body);
      renderPanel();
    } catch (err) {
      console.warn("Reader Helper mark failed", err);
      alert(`Could not save "${word}": ${err.message}`);
    }
  }

  // --- Panel rendering ---

  function injectPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "Reader Helper");
    document.body.appendChild(panel);
  }

  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (session) renderSignedInPanel(panel);
    else renderAuthPanel(panel);
  }

  function renderAuthPanel(panel) {
    const isSignUp = authView === "signup";
    const isVerify = authView === "verify";
    const heading = isVerify ? "Verify your email" : isSignUp ? "Create your account" : "Sign in";
    const subtitle = isVerify
      ? "Enter the 6-digit code we emailed you."
      : "Reader Helper saves your unknown words to your account.";

    panel.innerHTML = `
      <div class="ell-panel-header">
        <h2 class="ell-panel-title">Reader Helper</h2>
      </div>
      <p class="ell-panel-subtitle">${escapeHtml(subtitle)}</p>
      <h3 class="ell-section-title">${escapeHtml(heading)}</h3>
      ${authMessage ? `<p class="ell-auth-message">${escapeHtml(authMessage)}</p>` : ""}
      ${isVerify ? renderVerifyForm() : renderCredentialsForm(isSignUp)}
      ${isVerify ? "" : renderAuthSwitch(isSignUp)}
    `;

    if (isVerify) {
      panel.querySelector('[data-action="verify"]').addEventListener("click", onVerifySubmit);
      panel.querySelector('[data-action="resend"]').addEventListener("click", onResend);
      panel.querySelector('[data-action="back"]').addEventListener("click", () => {
        pendingVerificationEmail = null;
        authView = "signin";
        authMessage = "";
        renderPanel();
      });
    } else {
      panel.querySelector('[data-action="submit"]').addEventListener("click", onAuthSubmit);
      panel.querySelector('[data-action="switch"]').addEventListener("click", () => {
        authView = isSignUp ? "signin" : "signup";
        authMessage = "";
        renderPanel();
      });
    }
  }

  function renderCredentialsForm(isSignUp) {
    return `
      <form class="ell-auth-form" onsubmit="return false;">
        <label class="ell-field">
          <span>Email</span>
          <input type="email" data-field="email" autocomplete="email" required />
        </label>
        <label class="ell-field">
          <span>Password</span>
          <input type="password" data-field="password" autocomplete="${isSignUp ? "new-password" : "current-password"}" minlength="6" required />
        </label>
        <button class="ell-button" type="button" data-action="submit">${isSignUp ? "Sign up" : "Sign in"}</button>
      </form>
    `;
  }

  function renderVerifyForm() {
    return `
      <form class="ell-auth-form" onsubmit="return false;">
        <label class="ell-field">
          <span>6-digit code</span>
          <input type="text" data-field="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required />
        </label>
        <button class="ell-button" type="button" data-action="verify">Verify</button>
        <button class="ell-button ell-button-secondary" type="button" data-action="resend">Resend code</button>
        <button class="ell-link-button" type="button" data-action="back">Use a different email</button>
      </form>
    `;
  }

  function renderAuthSwitch(isSignUp) {
    return `
      <p class="ell-auth-switch">
        ${isSignUp ? "Already have an account?" : "New here?"}
        <button class="ell-link-button" type="button" data-action="switch">${isSignUp ? "Sign in" : "Create one"}</button>
      </p>
    `;
  }

  async function onAuthSubmit() {
    const panel = document.getElementById(PANEL_ID);
    const email = panel.querySelector('[data-field="email"]').value.trim();
    const password = panel.querySelector('[data-field="password"]').value;
    if (!email || !password) {
      authMessage = "Email and password are required.";
      renderPanel();
      return;
    }

    authMessage = "Working...";
    renderPanel();

    try {
      if (authView === "signup") await signUp(email, password);
      else await signIn(email, password);
      authMessage = "";
      renderPanel();
    } catch (err) {
      authMessage = err.message;
      renderPanel();
    }
  }

  async function onVerifySubmit() {
    const panel = document.getElementById(PANEL_ID);
    const otp = panel.querySelector('[data-field="otp"]').value.trim();
    if (!pendingVerificationEmail || !/^[0-9]{6}$/.test(otp)) {
      authMessage = "Enter the 6-digit code from your email.";
      renderPanel();
      return;
    }

    authMessage = "Verifying...";
    renderPanel();
    try {
      await verifyEmail(pendingVerificationEmail, otp);
      authMessage = "";
      renderPanel();
    } catch (err) {
      authMessage = err.message;
      renderPanel();
    }
  }

  async function onResend() {
    if (!pendingVerificationEmail) return;
    authMessage = "Sending...";
    renderPanel();
    try {
      await resendVerification(pendingVerificationEmail);
      authMessage = "Code resent.";
    } catch (err) {
      authMessage = err.message;
    }
    renderPanel();
  }

  function renderSignedInPanel(panel) {
    const wordsOnPage = getWordsOnPage();
    const activeOnPage = words.filter((w) => w.is_active && wordsOnPage.has(w.word));

    panel.innerHTML = `
      <div class="ell-panel-header">
        <h2 class="ell-panel-title">Reader Helper</h2>
        <button class="ell-button ell-button-secondary" type="button" data-action="replace">Replace</button>
      </div>
      <p class="ell-panel-subtitle">Signed in as ${escapeHtml(session.user.email)}.
        <button class="ell-link-button" type="button" data-action="signout">Sign out</button>
      </p>
      <p class="ell-panel-subtitle">Select text on the page, then click <em>Mark unknown</em>. (Double-click a single word to mark instantly.)</p>
      ${renderPendingSection()}
      <section class="ell-section">
        <h3 class="ell-section-title">Unknown Words on This Page</h3>
        ${renderUnknownWords(activeOnPage)}
      </section>
    `;

    panel.querySelector('[data-action="replace"]').addEventListener("click", replaceHardWordsOnPage);
    panel.querySelector('[data-action="signout"]').addEventListener("click", async () => {
      await signOut();
      renderPanel();
    });
    const markBtn = panel.querySelector('[data-action="mark-pending"]');
    if (markBtn) {
      // mousedown preventDefault keeps the page selection alive while the click registers
      markBtn.addEventListener("mousedown", (e) => e.preventDefault());
      markBtn.addEventListener("click", markPendingWord);
    }
    const clearBtn = panel.querySelector('[data-action="clear-pending"]');
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        pendingRange = null;
        pendingWord = "";
        renderPanel();
      });
    }
    panel.querySelectorAll("[data-remove-word]").forEach((button) => {
      button.addEventListener("click", () => removeActiveWord(button.dataset.removeWord));
    });
  }

  function renderPendingSection() {
    if (!pendingWord) return "";
    return `
      <section class="ell-section ell-pending-section">
        <h3 class="ell-section-title">Selected</h3>
        <p class="ell-pending-text">"${escapeHtml(pendingWord)}"</p>
        <div class="ell-pending-actions">
          <button class="ell-button ell-button-mark" type="button" data-action="mark-pending">Mark unknown</button>
          <button class="ell-button ell-button-secondary" type="button" data-action="clear-pending">Clear</button>
        </div>
      </section>
    `;
  }

  function getWordsOnPage() {
    const onPage = new Set();
    document.querySelectorAll(".ell-highlight[data-ell-word]").forEach((el) => {
      const w = el.dataset.ellWord;
      if (w) onPage.add(w);
    });
    return onPage;
  }

  function renderUnknownWords(rows) {
    if (rows.length === 0) return '<p class="ell-empty">No marked words on this page.</p>';
    const items = rows.map((row) => `
      <li class="ell-word-item">
        <span>
          <span class="ell-word">${escapeHtml(row.word)}</span>
          <span class="ell-definition">${escapeHtml(row.definition || getDefinition(row.word))}</span>
        </span>
        <button class="ell-remove-button" type="button" data-remove-word="${escapeHtml(row.word)}" aria-label="Remove ${escapeHtml(row.word)}">x</button>
      </li>
    `);
    return `<ul class="ell-word-list">${items.join("")}</ul>`;
  }

async function removeActiveWord(word) {
    const row = words.find((w) => w.word === word);
    if (!row) return;
    try {
      await deactivateWordRemote(row);
      document.querySelectorAll(`.ell-highlight[data-ell-word="${cssEscape(word)}"]`).forEach((node) => {
        node.replaceWith(document.createTextNode(node.textContent));
      });
      renderPanel();
    } catch (err) {
      console.warn("Reader Helper remove failed", err);
      alert(err.message);
    }
  }

  // --- Highlighting / replacement ---

  async function replaceHardWordsOnPage() {
    if (!session) return;
    const active = words.filter((w) => w.is_active);
    if (active.length === 0) return;

    const button = document.querySelector(`#${PANEL_ID} [data-action="replace"]`);
    const originalLabel = button ? button.textContent : "Replace";
    if (button) {
      button.disabled = true;
      button.textContent = "Replacing...";
    }

    try {
      const items = active.map((row) => ({
        word: row.word,
        context: getWordContext(row.word)
      }));

      const res = await apiFetch("/functions/replace-words", {
        method: "POST",
        token: session.accessToken,
        body: { items }
      });
      if (!res.ok) {
        const errBody = await safeJson(res);
        console.warn("Reader Helper replace-words error body:", errBody);
        const baseMsg = extractError(errBody) || `Replace failed (HTTP ${res.status})`;
        const diag = errBody
          ? `\n\nDiagnostic:\nai_body_keys: ${JSON.stringify(errBody.ai_body_keys)}\nai_body_preview: ${(errBody.ai_body_preview || "").slice(0, 800)}\nraw: ${(errBody.raw || "").slice(0, 400)}`
          : "";
        throw new Error(baseMsg + diag);
      }

      const payload = await res.json();
      const replacements = payload.replacements || {};

      let appliedCount = 0;
      for (const row of active) {
        const replacement = replacements[row.word];
        if (!replacement) continue;
        if (normalizeWord(replacement) === normalizeWord(row.word)) continue;

        document.querySelectorAll(`.ell-highlight[data-ell-word="${cssEscape(row.word)}"]`).forEach((node) => {
          node.textContent = replacement;
          node.title = `${row.word}: ${replacement}`;
          node.classList.add("ell-replaced");
          appliedCount++;
        });
        row.definition = replacement;
      }

      if (button) {
        button.textContent = appliedCount > 0 ? `Replaced ${appliedCount}` : "No replacements";
        setTimeout(() => {
          if (!button.isConnected) return;
          button.disabled = false;
          button.textContent = originalLabel;
        }, 2000);
      }
    } catch (err) {
      console.warn("Reader Helper replace failed", err);
      if (button) {
        button.disabled = false;
        button.textContent = originalLabel;
      }
      alert(`Replace failed: ${err.message}`);
    }
  }

  function getWordContext(word) {
    const node = document.querySelector(`.ell-highlight[data-ell-word="${cssEscape(word)}"]`);
    if (!node) return "";

    const blockTags = new Set(["P", "LI", "TD", "TH", "BLOCKQUOTE", "ARTICLE", "SECTION", "DIV"]);
    let block = node;
    while (block && block !== document.body && !blockTags.has(block.tagName)) {
      block = block.parentElement;
    }
    if (!block || block === document.body) block = node.parentElement || node;

    const text = (block.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (text.length <= 600) return text;

    const lower = text.toLowerCase();
    const idx = lower.indexOf(word.toLowerCase());
    if (idx === -1) return text.slice(0, 600);

    const start = Math.max(0, idx - 250);
    const end = Math.min(text.length, idx + word.length + 250);
    let snippet = text.slice(start, end);
    if (start > 0) snippet = "..." + snippet;
    if (end < text.length) snippet = snippet + "...";
    return snippet;
  }

  function highlightActiveWords(root) {
    const active = words.filter((w) => w.is_active).map((w) => w.word);
    if (active.length === 0 || !root) return;
    const scope = root.nodeType === Node.ELEMENT_NODE ? root : document.body;
    if (!scope) return;

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (isExtensionElement(parent)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(".ell-highlight")) return NodeFilter.FILTER_REJECT;
        if (parent.closest("script, style, textarea, input, select, option, code, pre")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((node) => highlightWordsInTextNode(node, active));
  }

  function startHighlightObserver() {
    if (mutationObserver || !document.body) return;
    mutationObserver = new MutationObserver((mutations) => {
      const interesting = mutations.some((m) =>
        Array.from(m.addedNodes).some((n) => {
          if (n.nodeType !== Node.ELEMENT_NODE && n.nodeType !== Node.TEXT_NODE) return false;
          const el = n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement;
          if (!el) return false;
          if (isExtensionElement(el)) return false;
          if (el.closest && el.closest(".ell-highlight")) return false;
          return true;
        })
      );
      if (!interesting) return;

      if (highlightDebounce) clearTimeout(highlightDebounce);
      highlightDebounce = setTimeout(() => {
        highlightDebounce = null;
        if (!mutationObserver) return;
        mutationObserver.disconnect();
        try {
          highlightActiveWords(document.body);
          renderPanel();
        } finally {
          if (mutationObserver) {
            mutationObserver.observe(document.body, { childList: true, subtree: true });
          }
        }
      }, 250);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopHighlightObserver() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (highlightDebounce) {
      clearTimeout(highlightDebounce);
      highlightDebounce = null;
    }
  }

  function highlightWordsInTextNode(textNode, wordList) {
    const text = textNode.nodeValue;
    const patternStr = wordList
      .map((w) => escapeRegExp(w).replace(/ /g, "\\s+"))
      .join("|");
    const pattern = new RegExp(`\\b(${patternStr})\\b`, "gi");
    if (!pattern.test(text)) return;

    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      fragment.appendChild(createHighlight(match[0]));
      lastIndex = pattern.lastIndex;
    }
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    textNode.replaceWith(fragment);
  }

  function wrapRange(range, word) {
    const selectedText = range.toString();
    if (!selectedText.trim()) return;
    const highlight = createHighlight(selectedText);
    try {
      range.deleteContents();
      range.insertNode(highlight);
    } catch (error) {
      console.warn("Reader Helper could not highlight this selection.", error);
    }
  }

  function createHighlight(text) {
    const normalizedWord = normalizeWord(text);
    const span = document.createElement("span");
    span.className = "ell-highlight";
    span.dataset.ellWord = normalizedWord;
    span.title = `${normalizedWord}: ${getDefinition(normalizedWord)}`;
    span.textContent = text;
    return span;
  }

  function removeAllHighlightsFromPage() {
    document.querySelectorAll(".ell-highlight").forEach((node) => {
      node.replaceWith(document.createTextNode(node.textContent));
    });
  }

  // --- Helpers ---

  async function apiFetch(path, { method = "GET", token, body, prefer } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (prefer) headers["Prefer"] = prefer;
    const init = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${API_BASE}${path}`, init);
  }

  async function safeJson(res) {
    try { return await res.json(); } catch (_) { return null; }
  }

  function extractError(body) {
    if (!body) return null;
    return body.message || body.error || (body.errors && body.errors[0] && body.errors[0].message) || null;
  }

  function getDefinition(word) {
    return dictionary[normalizeWord(word)] || "Definition coming soon.";
  }

  function cleanWord(text) {
    if (!text) return "";
    const collapsed = String(text)
      .replace(/\s+/g, " ")
      .toLowerCase()
      .trim()
      .replace(/^[\s,.;:!?(){}\[\]"'`]+|[\s,.;:!?(){}\[\]"'`]+$/g, "");
    return collapsed;
  }

  function normalizeWord(word) {
    return String(word)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[\s,.;:!?(){}\[\]"'`]+|[\s,.;:!?(){}\[\]"'`]+$/g, "");
  }

  function clearSelection() {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  }

  function isExtensionElement(element) {
    return Boolean(element && element.closest && element.closest(`#${PANEL_ID}`));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return value.replace(/"/g, '\\"');
  }
})();
