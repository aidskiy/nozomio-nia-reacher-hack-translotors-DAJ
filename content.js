(function () {
  const UNKNOWN_KEY = "unknownWords";
  const LIBRARY_KEY = "wordLibrary";
  const PANEL_ID = "ell-panel";
  const MARK_BUTTON_ID = "ell-mark-button";

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

  init();

  function init() {
    injectPanel();
    injectMarkButton();
    highlightSavedWords();
    renderPanel();

    document.addEventListener("mouseup", handleSelection);
    document.addEventListener("dblclick", handleDoubleClick);
    document.addEventListener("click", hideMarkButtonWhenClickingAway);
  }

  function handleSelection(event) {
    if (isExtensionElement(event.target)) return;

    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : "";
    const word = cleanWord(selectedText);

    if (!word || !selection || selection.rangeCount === 0) {
      return;
    }

    pendingRange = selection.getRangeAt(0).cloneRange();
    pendingWord = word;
    showMarkButton(event.pageX, event.pageY);
  }

  function handleDoubleClick(event) {
    if (isExtensionElement(event.target)) return;

    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : "";
    const word = cleanWord(selectedText);

    if (!word || !selection || selection.rangeCount === 0) {
      return;
    }

    pendingRange = selection.getRangeAt(0).cloneRange();
    pendingWord = word;
    markPendingWord();
  }

  function hideMarkButtonWhenClickingAway(event) {
    const markButton = document.getElementById(MARK_BUTTON_ID);
    if (!markButton || event.target === markButton || isExtensionElement(event.target)) {
      return;
    }

    markButton.style.display = "none";
  }

  function injectMarkButton() {
    if (document.getElementById(MARK_BUTTON_ID)) return;

    const button = document.createElement("button");
    button.id = MARK_BUTTON_ID;
    button.type = "button";
    button.textContent = "Mark unknown";
    button.addEventListener("click", markPendingWord);
    document.body.appendChild(button);
  }

  function showMarkButton(pageX, pageY) {
    const button = document.getElementById(MARK_BUTTON_ID);
    if (!button) return;

    button.style.left = `${pageX + 8}px`;
    button.style.top = `${pageY + 8}px`;
    button.style.display = "block";
  }

  function markPendingWord() {
    if (!pendingWord || !pendingRange) return;

    addWord(pendingWord);
    wrapRange(pendingRange, pendingWord);
    clearSelection();
    pendingRange = null;
    pendingWord = "";

    const button = document.getElementById(MARK_BUTTON_ID);
    if (button) button.style.display = "none";
    renderPanel();
  }

  function injectPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "English learner word helper");
    document.body.appendChild(panel);
  }

  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const unknownWords = getStoredWords(UNKNOWN_KEY);
    const libraryWords = getStoredWords(LIBRARY_KEY);

    panel.innerHTML = `
      <div class="ell-panel-header">
        <h2 class="ell-panel-title">Reader Helper</h2>
        <button class="ell-button ell-button-secondary" type="button" data-action="replace">Replace</button>
      </div>
      <p class="ell-panel-subtitle">Double-click a word, or select text and choose Mark unknown.</p>
      <section class="ell-section">
        <h3 class="ell-section-title">Unknown Words</h3>
        ${renderUnknownWords(unknownWords)}
      </section>
      <section class="ell-section">
        <h3 class="ell-section-title">Library</h3>
        ${renderLibrary(libraryWords)}
      </section>
    `;

    panel.querySelector('[data-action="replace"]').addEventListener("click", replaceHardWordsOnPage);
    panel.querySelectorAll("[data-remove-word]").forEach((button) => {
      button.addEventListener("click", () => removeWord(button.dataset.removeWord));
    });
  }

  function renderUnknownWords(words) {
    if (words.length === 0) {
      return '<p class="ell-empty">No words marked yet.</p>';
    }

    const items = words.map((word) => `
      <li class="ell-word-item">
        <span>
          <span class="ell-word">${escapeHtml(word)}</span>
          <span class="ell-definition">${escapeHtml(getDefinition(word))}</span>
        </span>
        <button class="ell-remove-button" type="button" data-remove-word="${escapeHtml(word)}" aria-label="Remove ${escapeHtml(word)}">x</button>
      </li>
    `);

    return `<ul class="ell-word-list">${items.join("")}</ul>`;
  }

  function renderLibrary(words) {
    if (words.length === 0) {
      return '<p class="ell-empty">Your saved words will appear here.</p>';
    }

    const items = words.map((word) => `<li class="ell-library-chip">${escapeHtml(word)}</li>`);
    return `<ul class="ell-library-list">${items.join("")}</ul>`;
  }

  function addWord(word) {
    const normalizedWord = normalizeWord(word);
    const unknownWords = addUnique(getStoredWords(UNKNOWN_KEY), normalizedWord);
    const libraryWords = addUnique(getStoredWords(LIBRARY_KEY), normalizedWord);

    saveWords(UNKNOWN_KEY, unknownWords);
    saveWords(LIBRARY_KEY, libraryWords);
  }

  function removeWord(word) {
    const normalizedWord = normalizeWord(word);
    const words = getStoredWords(UNKNOWN_KEY).filter((item) => item !== normalizedWord);
    saveWords(UNKNOWN_KEY, words);

    document.querySelectorAll(`.ell-highlight[data-ell-word="${cssEscape(normalizedWord)}"]`).forEach((node) => {
      node.replaceWith(document.createTextNode(node.textContent));
    });

    renderPanel();
  }

  function replaceHardWordsOnPage() {
    const words = getStoredWords(UNKNOWN_KEY);

    words.forEach((word) => {
      const replacement = dictionary[word];
      if (!replacement) return;

      document.querySelectorAll(`.ell-highlight[data-ell-word="${cssEscape(word)}"]`).forEach((node) => {
        node.textContent = replacement.split("/")[0].trim();
        node.title = `${word}: ${getDefinition(word)}`;
      });
    });
  }

  function highlightSavedWords() {
    const words = getStoredWords(UNKNOWN_KEY);
    if (words.length === 0 || !document.body) return;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (isExtensionElement(node.parentElement)) return NodeFilter.FILTER_REJECT;
        if (node.parentElement.closest("script, style, textarea, input, select, option")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    textNodes.forEach((node) => highlightWordsInTextNode(node, words));
  }

  function highlightWordsInTextNode(textNode, words) {
    const text = textNode.nodeValue;
    const pattern = new RegExp(`\\b(${words.map(escapeRegExp).join("|")})\\b`, "gi");
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

  function getDefinition(word) {
    return dictionary[normalizeWord(word)] || "Definition coming soon.";
  }

  function getStoredWords(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value.map(normalizeWord).filter(Boolean) : [];
    } catch (error) {
      return [];
    }
  }

  function saveWords(key, words) {
    localStorage.setItem(key, JSON.stringify(words));
  }

  function addUnique(words, word) {
    return words.includes(word) ? words : [...words, word];
  }

  function cleanWord(text) {
    const match = text.match(/[A-Za-z][A-Za-z'-]*/);
    return match ? normalizeWord(match[0]) : "";
  }

  function normalizeWord(word) {
    return String(word).trim().toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
  }

  function clearSelection() {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  }

  function isExtensionElement(element) {
    return Boolean(element && element.closest && element.closest(`#${PANEL_ID}, #${MARK_BUTTON_ID}`));
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
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }

    return value.replace(/"/g, '\\"');
  }
})();
