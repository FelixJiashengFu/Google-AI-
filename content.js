/* 页面讲解 · 悬浮助手 — content script */
(() => {
  'use strict';
  if (window.__pageExplainerLoaded) return;
  window.__pageExplainerLoaded = true;

  const HOST_ID = '__page_explainer_host__';
  const DEFAULT_SETTINGS = {
    apiBase: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.4,
    autoExplain: true,
    selectionButton: true,
    screenshotShortcut: true
  };

  const EN_STOP = new Set(
    (
      'the a an and or but if then than that this these those is are was were be been being of to in on for with as at by from it its their his her they we you he she i not no do does did have has had will would can could should may might about into over after before more most other some such only own same so too very just also which who whom what when where why how all any both each few many much nor off once out up down while during above below between through against because until again further here there'
    ).split(/\s+/)
  );
  const CN_STOP = new Set(
    (
      '的 了 和 是 在 我 有 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 这个 那个 我们 你们 他们 它们 它 以及 但是 因为 所以 如果 虽然 而且 并且 还是 可以 可能 已经 进行 通过 对于 关于 一些 什么 怎么 如何 这些 那些 中 与 及 或 等 被 把 让 从 对 为 以 之 其 而 则 于 里 后 前 时 更 最 很 太 非常 需要 应该 能够 这种 这样 那样 一种 一直 只是 这样 那样 不是 就是 还有 没有 一个 方面 情况 问题 时间 方式 内容 主要 相关 目前 现在 今天'
    ).split(/\s+/)
  );

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    open: false,
    tab: 'page',
    page: null,
    pageUrl: '',
    pageStatus: 'idle',
    pageText: '',
    pageModel: '',
    pageError: null,
    selection: null,
    selectionStatus: 'idle',
    selectionText: '',
    selectionError: null,
    chat: [],
    chatBusy: false,
    pendingSelection: null,
    pos: null,
    toastTimer: null,
    pointer: { x: 0, y: 0 },
    shot: {
      active: false,
      busy: false,
      bitmap: null,
      box: null,
      start: null,
      dragging: false,
      overlay: null
    }
  };

  let host;
  let shadow;
  let ui = {};
  let segmenter = null;

  async function init() {
    await loadSettings();
    buildUi();
    restorePosition();
    bindEvents();
    bindScreenshotShortcut();
    watchNavigation();
    updateStatus();

    if (window.__PAGE_EXPLAINER_TEST__) {
      window.__pageExplainer = {
        open: (tab) => openPanel(tab),
        close: () => closePanel(),
        explainSelection: (text, context) => explainSelection(text, context),
        ask: (question) => sendChat(question),
        startScreenshot: (force) => startScreenshot(force),
        state,
        extractPage
      };
      if (window.__PAGE_EXPLAINER_AUTOOPEN__) {
        setTimeout(() => openPanel('page'), 60);
      }
    }
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get('settings');
      state.settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    } catch (_) {
      state.settings = { ...DEFAULT_SETTINGS };
    }
  }

  function hasKey() {
    return !!String(state.settings.apiKey || '').trim();
  }

  /* ---------------- 页面提取 ---------------- */

  function normalizeSpace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function mainRoot() {
    const selectors = [
      'article',
      'main',
      '[role="main"]',
      '#search',
      '#rso',
      '#content',
      '#main',
      '.post-content',
      '.article-content',
      '.entry-content',
      '.markdown-body'
    ];
    let best = null;
    let bestLength = 0;
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const length = normalizeSpace(node.textContent).length;
        if (length > bestLength) {
          bestLength = length;
          best = node;
        }
      }
    }
    const bodyLength = normalizeSpace(document.body ? document.body.textContent : '').length;
    if (best && bestLength >= Math.min(400, bodyLength * 0.2)) return best;
    return document.body || document.documentElement;
  }

  function isGoogleSearch() {
    if (window.__PAGE_EXPLAINER_TEST_GOOGLE__) return true;
    return /(^|\.)google\.[a-z.]+$/i.test(location.hostname) && /^\/search/.test(location.pathname);
  }

  function safeHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  }

  function extractGoogleResults() {
    if (!isGoogleSearch()) return [];
    const results = [];
    const seen = new Set();
    const headings = document.querySelectorAll('#rso h3, #search h3, #botstuff h3');
    for (const heading of headings) {
      const title = normalizeSpace(heading.textContent);
      if (!title || seen.has(title)) continue;
      const block =
        heading.closest('div[data-hveid]') ||
        heading.closest('div.g') ||
        heading.parentElement?.parentElement?.parentElement;
      if (!block) continue;
      const anchor = heading.closest('a') || block.querySelector('a[href]');
      const href = anchor && anchor.href;
      if (!href || !/^https?:/i.test(href)) continue;
      const snippetNode = block.querySelector(
        '.VwiC3b, .IsZvec, .lEBKkf, div[style*="-webkit-line-clamp"], [data-sncf]'
      );
      let snippet = normalizeSpace(snippetNode ? snippetNode.textContent : block.textContent);
      snippet = snippet.replace(title, '').trim().slice(0, 260);
      seen.add(title);
      results.push({ title, href, domain: safeHost(href), snippet });
      if (results.length >= 10) break;
    }
    return results;
  }

  function extractContent(root) {
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll(
        'script,style,noscript,template,svg,canvas,iframe,video,audio,header,footer,nav,aside,form,button,[aria-hidden="true"],[hidden]'
      )
      .forEach((node) => node.remove());

    const candidates = [...clone.querySelectorAll('p,li,blockquote,pre')];
    const leaves = candidates.filter(
      (node) => !node.querySelector('p,li,blockquote,pre')
    );
    const blocks = leaves
      .map((node) => normalizeSpace(node.textContent))
      .filter((text) => text.length > 1);

    if (!blocks.length) {
      const fallback = normalizeSpace(clone.textContent);
      return fallback ? fallback.split(/(?<=[。！？.!?])\s*/).slice(0, 200).join('\n') : '';
    }
    return blocks.join('\n').slice(0, 60000);
  }

  function extractOutline(root) {
    const outline = [];
    for (const heading of root.querySelectorAll('h1,h2,h3,h4')) {
      const text = normalizeSpace(heading.textContent);
      if (!text || text.length > 120) continue;
      outline.push({
        level: Number(heading.tagName.slice(1)) || 2,
        text,
        el: heading
      });
      if (outline.length >= 30) break;
    }
    return outline;
  }

  function tokens(text) {
    const out = [];
    const lower = String(text || '').toLowerCase();
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      if (!segmenter) segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
      for (const part of segmenter.segment(lower)) {
        if (!part.isWordLike) continue;
        const word = part.segment.trim();
        if (!word || word.length < 2) continue;
        if (/^\d+$/.test(word)) continue;
        if (EN_STOP.has(word) || CN_STOP.has(word)) continue;
        out.push(word);
      }
      return out;
    }
    for (const word of lower.match(/[a-z0-9\u4e00-\u9fa5]{2,}/g) || []) {
      if (/^\d+$/.test(word)) continue;
      if (EN_STOP.has(word) || CN_STOP.has(word)) continue;
      out.push(word);
    }
    return out;
  }

  function keyTerms(text, limit) {
    const freq = new Map();
    for (const word of tokens(text)) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }
    return [...freq.entries()]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([word, count]) => ({ word, count }));
  }

  function splitSentences(text) {
    const parts = [];
    for (const line of String(text || '').split(/\n+/)) {
      const normalized = line.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;
      const sentences = normalized.split(
        /(?<=[。！？!?；;])\s*|(?<=[.!?])\s+(?=[A-Z0-9"“])/
      );
      for (const sentence of sentences) {
        const value = sentence.trim();
        if (value.length >= 8 && value.length <= 240) parts.push(value);
      }
    }
    return parts;
  }

  function summarize(text, limit) {
    const sentences = splitSentences(text);
    if (!sentences.length) return [];
    const freq = new Map();
    for (const word of tokens(text)) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }
    const scored = sentences.map((sentence, index) => {
      const seen = new Set();
      let score = 0;
      for (const word of tokens(sentence)) {
        if (seen.has(word)) continue;
        seen.add(word);
        score += freq.get(word) || 0;
      }
      score = score / Math.sqrt(Math.max(20, sentence.length));
      if (index < 3) score *= 1.25;
      return { sentence, index, score };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .sort((a, b) => a.index - b.index)
      .map((item) => item.sentence);
  }

  function statsFor(text) {
    const compact = String(text || '').replace(/\s/g, '');
    const cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const latinWords = (text.match(/[A-Za-z][A-Za-z'-]+/g) || []).length;
    const paragraphs = text.split('\n').filter((line) => line.trim().length > 10).length;
    const minutes = text
      ? Math.max(1, Math.round(cn / 400 + latinWords / 220))
      : 0;
    return {
      chars: compact.length,
      cn,
      words: latinWords,
      paragraphs,
      minutes
    };
  }

  function extractPage() {
    const root = mainRoot();
    const text = extractContent(root);
    const results = extractGoogleResults();
    return {
      url: location.href,
      title: document.title || location.hostname,
      host: safeHost(location.href),
      text,
      results,
      outline: extractOutline(root),
      terms: keyTerms(text, 6),
      summary: results.length ? [] : summarize(text, 5),
      stats: statsFor(text)
    };
  }

  function ensurePage() {
    if (!state.page || state.pageUrl !== location.href) {
      state.page = extractPage();
      state.pageUrl = location.href;
    }
    return state.page;
  }

  function selectionContext() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return '';
    const node = selection.getRangeAt(0).commonAncestorContainer;
    let element = node.nodeType === 1 ? node : node.parentElement;
    while (element && element !== document.body) {
      const text = normalizeSpace(element.textContent);
      if (text.length > 40 && text.length <= 1600) return text;
      element = element.parentElement;
    }
    return normalizeSpace(element ? element.textContent : '').slice(0, 1200);
  }

  /* ---------------- 界面 ---------------- */

  function buildUi() {
    const stale = document.getElementById(HOST_ID);
    if (stale) stale.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block; pointer-events: none;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <div class="bubble" role="button" tabindex="0" aria-label="打开 dadada（Alt+Shift+E）">
        <span class="bubble-glyph">解</span>
        <span class="status-dot" title="本地模式"></span>
      </div>
      <div class="panel" role="dialog" aria-label="dadada" hidden>
        <header class="head">
          <div class="brand">
            <span class="logo">解</span>
            <div class="brand-text">
              <div class="title">dadada</div>
              <div class="page-title"></div>
            </div>
          </div>
          <div class="head-actions">
            <button class="icon-btn" data-act="refresh" title="重新读取页面" aria-label="重新读取页面">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z"/></svg>
            </button>
            <button class="icon-btn" data-act="settings" title="设置" aria-label="设置">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.4 4a6.6 6.6 0 0 0-.1-1.1l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.9-1.1L15.6 3h-4l-.4 2.7a7.4 7.4 0 0 0-1.9 1.1l-2.4-1-2 3.4 2 1.6a6.6 6.6 0 0 0 0 2.2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.9 1.1l.4 2.7h4l.4-2.7a7.4 7.4 0 0 0 1.9-1.1l2.4 1 2-3.4-2-1.6c.1-.3.1-.7.1-1.1Z"/></svg>
            </button>
            <button class="icon-btn" data-act="close" title="收起（Esc）" aria-label="收起">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="m6 6 12 12M18 6 6 18"/></svg>
            </button>
          </div>
        </header>
        <nav class="tabs" role="tablist">
          <button class="tab active" data-tab="page" role="tab" aria-selected="true">本页</button>
          <button class="tab" data-tab="selection" role="tab" aria-selected="false">划词</button>
          <button class="tab" data-tab="chat" role="tab" aria-selected="false">问答</button>
        </nav>
        <div class="body">
          <section class="pane" data-pane="page">
            <div class="stats" data-ref="stats"></div>
            <div data-ref="pageAi"></div>
            <div data-ref="results"></div>
            <div data-ref="outline"></div>
          </section>
          <section class="pane" data-pane="selection" hidden>
            <div class="empty" data-ref="selEmpty">
              <div class="empty-icon">
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M8 9h8M8 13h5"/></svg>
              </div>
              <div class="empty-title">选中一段文字</div>
              <p class="empty-desc">在网页上划选内容，点击浮出的「讲解」按钮，就能看到它在这页里的含义。也可以右键选择「讲解选中内容」。</p>
            </div>
            <div data-ref="selContent" hidden>
              <div class="quote" data-ref="selQuote"></div>
              <div class="meta" data-ref="selMeta"></div>
              <div data-ref="selAi"></div>
              <div class="row">
                <button class="btn ghost small" data-act="reexplain">重新讲解</button>
                <button class="btn ghost small" data-act="ask-selection">围绕这段提问</button>
              </div>
            </div>
          </section>
          <section class="pane chat-pane" data-pane="chat" hidden>
            <div class="chat-scroll" data-ref="chatScroll">
              <div class="empty chat-empty" data-ref="chatEmpty">
                <div class="empty-icon">
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M21 12a8 8 0 0 1-8 8H7l-4 3v-5.5A8 8 0 1 1 21 12Z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M8.5 11h7M8.5 14.5h4"/></svg>
                </div>
                <div class="empty-title">就这页继续问</div>
                <p class="empty-desc">${hasKey() ? '我会结合当前页面的内容回答，不需要你复制粘贴。' : '配置 AI 接口后，可以围绕这一页连续追问。'}</p>
                <div class="suggests">
                  <button class="suggest" data-suggest="这页的主要内容是什么？">这页讲了什么</button>
                  <button class="suggest" data-suggest="用更简单的说法解释这一页">说得再简单点</button>
                  <button class="suggest" data-suggest="这页有哪些值得注意的细节？">值得注意的细节</button>
                </div>
              </div>
              <div class="messages" data-ref="messages"></div>
            </div>
            <form class="composer" data-ref="composer">
              <textarea data-ref="input" rows="1" placeholder="就这一页提问…" aria-label="输入问题"></textarea>
              <button class="send" type="submit" title="发送" aria-label="发送">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2Z"/></svg>
              </button>
            </form>
          </section>
        </div>
        <footer class="foot">
          <button class="foot-status" data-act="settings">
            <span class="dot"></span>
            <span class="foot-text">本地模式</span>
          </button>
          <span class="hint">Alt+Shift+E</span>
        </footer>
      </div>
      <div class="sel-btn" hidden role="button" tabindex="0">讲解</div>
      <div class="toast" data-ref="toast" role="status" aria-live="polite"></div>
    `;

    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
      shadow.adoptedStyleSheets = [sheet];
    } catch (_) {
      const style = document.createElement('style');
      style.textContent = STYLE;
      shadow.appendChild(style);
    }

    document.documentElement.appendChild(host);

    ui = {
      bubble: shadow.querySelector('.bubble'),
      statusDot: shadow.querySelector('.status-dot'),
      panel: shadow.querySelector('.panel'),
      pageTitle: shadow.querySelector('.page-title'),
      stats: shadow.querySelector('[data-ref="stats"]'),
      pageAi: shadow.querySelector('[data-ref="pageAi"]'),
      results: shadow.querySelector('[data-ref="results"]'),
      outline: shadow.querySelector('[data-ref="outline"]'),
      selEmpty: shadow.querySelector('[data-ref="selEmpty"]'),
      selContent: shadow.querySelector('[data-ref="selContent"]'),
      selQuote: shadow.querySelector('[data-ref="selQuote"]'),
      selMeta: shadow.querySelector('[data-ref="selMeta"]'),
      selAi: shadow.querySelector('[data-ref="selAi"]'),
      chatScroll: shadow.querySelector('[data-ref="chatScroll"]'),
      chatEmpty: shadow.querySelector('[data-ref="chatEmpty"]'),
      messages: shadow.querySelector('[data-ref="messages"]'),
      composer: shadow.querySelector('[data-ref="composer"]'),
      input: shadow.querySelector('[data-ref="input"]'),
      footDot: shadow.querySelector('.foot-status .dot'),
      footText: shadow.querySelector('.foot-text'),
      selBtn: shadow.querySelector('.sel-btn'),
      toast: shadow.querySelector('.toast')
    };
  }

  /* ---------------- 位置与开关 ---------------- */

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  async function restorePosition() {
    try {
      const stored = await chrome.storage.local.get('uiPos');
      if (stored.uiPos && Number.isFinite(stored.uiPos.left)) {
        state.pos = stored.uiPos;
      }
    } catch (_) {
      /* ignore */
    }
    const size = ui.bubble.offsetWidth || 52;
    if (state.pos) {
      setBubblePosition(
        clamp(state.pos.left, 8, innerWidth - size - 8),
        clamp(state.pos.top, 8, innerHeight - size - 8)
      );
    } else {
      setBubblePosition(innerWidth - size - 22, innerHeight - size - 110);
    }
  }

  function setBubblePosition(left, top) {
    ui.bubble.style.left = Math.round(left) + 'px';
    ui.bubble.style.top = Math.round(top) + 'px';
  }

  function savePosition() {
    const rect = ui.bubble.getBoundingClientRect();
    state.pos = { left: rect.left, top: rect.top };
    try {
      chrome.storage.local.set({ uiPos: state.pos });
    } catch (_) {
      /* ignore */
    }
  }

  function positionPanel() {
    const bubbleRect = ui.bubble.getBoundingClientRect();
    const width = Math.min(392, innerWidth - 24);
    ui.panel.style.width = width + 'px';
    ui.panel.style.left = '0px';
    ui.panel.style.top = '0px';
    ui.panel.hidden = false;
    ui.panel.offsetHeight;

    let left = bubbleRect.right + 14;
    if (left + width > innerWidth - 12) left = bubbleRect.left - width - 14;
    left = clamp(left, 12, innerWidth - width - 12);

    // 以面板最大高度定位，避免内容异步增长后把底部推出视口
    const maxHeight = Math.min(innerHeight * 0.74, 720);
    let top = bubbleRect.top + bubbleRect.height / 2 - maxHeight / 2;
    top = clamp(top, 12, Math.max(12, innerHeight - maxHeight - 12));

    ui.panel.style.left = Math.round(left) + 'px';
    ui.panel.style.top = Math.round(top) + 'px';
  }

  function openPanel(tab) {
    ensurePage();
    state.open = true;
    state.tab = tab || state.tab || 'page';
    ui.panel.hidden = false;
    positionPanel();
    ui.panel.classList.add('is-open');
    ui.bubble.classList.add('is-active');
    ui.pageTitle.textContent = state.page.title;
    ui.pageTitle.title = state.page.title;
    switchTab(state.tab, false);
    renderPagePane();
    renderSelectionPane();
    renderChat();
    if (state.tab === 'page' && hasKey() && state.settings.autoExplain) {
      explainPage();
    }
    if (state.tab === 'chat') {
      setTimeout(() => ui.input.focus(), 80);
    }
  }

  function closePanel() {
    state.open = false;
    ui.panel.classList.remove('is-open');
    ui.panel.hidden = true;
    ui.bubble.classList.remove('is-active');
    hideSelectionButton();
  }

  function togglePanel() {
    if (state.open) closePanel();
    else openPanel();
  }

  function switchTab(tab, focus) {
    state.tab = tab;
    for (const button of shadow.querySelectorAll('.tab')) {
      const active = button.dataset.tab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const pane of shadow.querySelectorAll('.pane')) {
      pane.hidden = pane.dataset.pane !== tab;
    }
    if (tab === 'page') renderPagePane();
    if (tab === 'selection') renderSelectionPane();
    if (tab === 'chat') {
      renderChat();
      if (focus) setTimeout(() => ui.input.focus(), 60);
    }
  }

  /* ---------------- 渲染工具 ---------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    node.textContent = '';
  }

  function appendMarkdown(container, markdown) {
    const lines = String(markdown || '').replace(/\r/g, '').split('\n');
    let list = null;
    const resetList = () => {
      list = null;
    };
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        resetList();
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        resetList();
        const node = el('div', 'md-heading md-h' + heading[1].length);
        appendInline(node, heading[2]);
        container.appendChild(node);
        continue;
      }
      const ordered = line.match(/^(\d+)[.)]\s+(.*)$/);
      const unordered = line.match(/^[-*•]\s+(.*)$/);
      if (ordered || unordered) {
        const type = ordered ? 'ol' : 'ul';
        if (!list || list.type !== type) {
          const node = el(type, 'md-list');
          container.appendChild(node);
          list = { type, node };
        }
        const item = el('li');
        appendInline(item, ordered ? ordered[2] : unordered[1]);
        list.node.appendChild(item);
        continue;
      }
      if (/^>\s?/.test(line)) {
        resetList();
        const quote = el('blockquote', 'md-quote');
        appendInline(quote, line.replace(/^>\s?/, ''));
        container.appendChild(quote);
        continue;
      }
      resetList();
      const paragraph = el('p', 'md-p');
      appendInline(paragraph, line);
      container.appendChild(paragraph);
    }
  }

  function appendInline(container, text) {
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const token = match[0];
      if (token.startsWith('**')) {
        container.appendChild(el('strong', '', token.slice(2, -2)));
      } else {
        container.appendChild(el('code', '', token.slice(1, -1)));
      }
      lastIndex = match.index + token.length;
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function skeletonCard() {
    const card = el('div', 'card skel-card');
    const head = el('div', 'card-head');
    head.appendChild(el('span', 'badge', 'AI 讲解'));
    head.appendChild(el('span', 'muted', '正在阅读页面…'));
    card.appendChild(head);
    for (const width of [96, 88, 72]) {
      const bar = el('div', 'skel-bar');
      bar.style.width = width + '%';
      card.appendChild(bar);
    }
    return card;
  }

  function errorCard(error, retryAction) {
    const card = el('div', 'card error');
    card.appendChild(el('div', 'err-title', error.message || '讲解没有完成'));
    if (error.detail) card.appendChild(el('div', 'err-detail', error.detail));
    const row = el('div', 'row');
    if (error.code !== 'NO_KEY') {
      const retry = el('button', 'btn small', '重试');
      retry.dataset.act = retryAction;
      row.appendChild(retry);
    }
    const settings = el('button', 'btn ghost small', error.code === 'NO_KEY' ? '连接 AI' : '检查设置');
    settings.dataset.act = 'settings';
    row.appendChild(settings);
    card.appendChild(row);
    return card;
  }

  function keyChips(terms) {
    const wrap = el('div', 'terms');
    for (const term of terms) {
      wrap.appendChild(el('span', 'chip', term.word));
    }
    return wrap;
  }

  /* ---------------- 本页 ---------------- */

  function renderPagePane() {
    if (!state.page) ensurePage();
    const page = state.page;
    ui.pageTitle.textContent = page.title;
    ui.pageTitle.title = page.title;
    renderStats(page);
    renderPageAi(page);
    renderResults(page);
    renderOutline(page);
  }

  function renderStats(page) {
    clear(ui.stats);
    let items;
    if (page.results && page.results.length) {
      const domains = new Set(page.results.map((result) => result.domain).filter(Boolean));
      const snippetChars = page.results.reduce(
        (total, result) => total + (result.snippet || '').length,
        0
      );
      items = [
        [String(page.results.length), '可见结果'],
        [String(domains.size), '来源网站'],
        [Math.max(1, Math.round(snippetChars / 500)) + ' 分钟', '快速浏览']
      ];
    } else {
      const stats = page.stats;
      items = [
        [stats.chars ? stats.chars.toLocaleString('zh-CN') : '0', '字数'],
        [stats.minutes ? stats.minutes + ' 分钟' : '—', '预计阅读'],
        [String(stats.paragraphs || 0), '段落']
      ];
    }
    for (const [value, label] of items) {
      const item = el('div', 'stat');
      item.appendChild(el('div', 'stat-value', value));
      item.appendChild(el('div', 'stat-label', label));
      ui.stats.appendChild(item);
    }
  }

  function renderPageAi(page) {
    clear(ui.pageAi);

    if (state.pageStatus === 'loading') {
      ui.pageAi.appendChild(skeletonCard());
      return;
    }

    if (state.pageStatus === 'error' && state.pageError) {
      ui.pageAi.appendChild(errorCard(state.pageError, 'retry-page'));
      return;
    }

    if (state.pageStatus === 'ready' && state.pageText) {
      const card = el('div', 'card ai');
      const head = el('div', 'card-head');
      head.appendChild(el('span', 'badge accent', 'AI 讲解'));
      if (state.pageModel) head.appendChild(el('span', 'muted', state.pageModel));
      card.appendChild(head);
      const body = el('div', 'md');
      appendMarkdown(body, state.pageText);
      card.appendChild(body);
      ui.pageAi.appendChild(card);
      return;
    }

    if (!hasKey()) {
      ui.pageAi.appendChild(localSummaryCard(page));
      return;
    }

    const prompt = el('div', 'card invite');
    prompt.appendChild(el('div', 'invite-title', '让 AI 讲一遍这一页'));
    prompt.appendChild(
      el('div', 'invite-desc', '会提取正文并生成中文概览，只在点击后调用接口。')
    );
    const button = el('button', 'btn', '开始讲解');
    button.dataset.act = 'explain-page';
    prompt.appendChild(button);
    ui.pageAi.appendChild(prompt);
  }

  function localSummaryCard(page) {
    const card = el('div', 'card local');
    const head = el('div', 'card-head');
    head.appendChild(el('span', 'badge', '本地速览'));
    head.appendChild(el('span', 'muted', '无需联网'));
    card.appendChild(head);

    if (page.summary && page.summary.length) {
      const list = el('ul', 'points');
      for (const sentence of page.summary) {
        list.appendChild(el('li', '', sentence));
      }
      card.appendChild(list);
    } else if (page.results && page.results.length) {
      card.appendChild(
        el('p', 'muted', '这是搜索结果页，下方已列出可见结果的摘要。连接 AI 后可以解释这些结果在回答什么。')
      );
    } else {
      card.appendChild(el('p', 'muted', '这页没有提取到足够的正文，可能是应用界面或内容尚未加载。'));
    }

    if (page.terms && page.terms.length) {
      card.appendChild(el('div', 'mini-label', '关键词'));
      card.appendChild(keyChips(page.terms));
    }

    const foot = el('div', 'card-foot');
    foot.appendChild(el('span', 'muted', '连接 AI 后可获得逐段讲解与追问'));
    const actions = el('div', 'card-foot-actions');
    const copy = el('button', 'btn ghost small', '复制正文');
    copy.dataset.act = 'copy-page';
    const button = el('button', 'btn small', '连接 AI');
    button.dataset.act = 'settings';
    actions.appendChild(copy);
    actions.appendChild(button);
    foot.appendChild(actions);
    card.appendChild(foot);
    return card;
  }

  function renderResults(page) {
    clear(ui.results);
    if (!page.results || !page.results.length) return;
    const card = el('div', 'card results');
    const head = el('div', 'card-head');
    head.appendChild(el('span', 'badge', '结果速览'));
    head.appendChild(el('span', 'muted', page.results.length + ' 条可见结果'));
    card.appendChild(head);
    for (const result of page.results) {
      const item = el('a', 'result');
      item.href = result.href;
      item.target = '_blank';
      item.rel = 'noopener noreferrer';
      item.appendChild(el('div', 'result-title', result.title));
      item.appendChild(el('div', 'result-domain', result.domain));
      if (result.snippet) item.appendChild(el('div', 'result-snippet', result.snippet));
      card.appendChild(item);
    }
    ui.results.appendChild(card);
  }

  function renderOutline(page) {
    clear(ui.outline);
    if (page.results && page.results.length) return;
    if (!page.outline || !page.outline.length) return;
    const card = el('div', 'card outline');
    const head = el('div', 'card-head');
    head.appendChild(el('span', 'badge', '页面结构'));
    head.appendChild(el('span', 'muted', page.outline.length + ' 个标题'));
    card.appendChild(head);
    for (const heading of page.outline) {
      const item = el('button', 'outline-item');
      item.style.paddingLeft = (heading.level - 1) * 10 + 'px';
      item.appendChild(el('span', 'outline-dot'));
      item.appendChild(el('span', 'outline-text', heading.text));
      item.addEventListener('click', () => {
        try {
          heading.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          heading.el.style.setProperty('outline', '2px solid rgba(124,108,255,.85)', 'important');
          setTimeout(() => heading.el.style.removeProperty('outline'), 1200);
        } catch (_) {
          /* ignore */
        }
      });
      card.appendChild(item);
    }
    ui.outline.appendChild(card);
  }

  /* ---------------- 划词 ---------------- */

  function renderSelectionPane() {
    const hasSelection = !!state.selection;
    ui.selEmpty.hidden = hasSelection;
    ui.selContent.hidden = !hasSelection;
    if (!hasSelection) return;

    ui.selQuote.textContent = state.selection.text;
    const length = state.selection.text.replace(/\s/g, '').length;
    ui.selMeta.textContent = `来自「${state.page ? state.page.title : document.title}」· ${length} 字`;

    clear(ui.selAi);
    if (state.selectionStatus === 'loading') {
      ui.selAi.appendChild(skeletonCard());
      return;
    }
    if (state.selectionStatus === 'error' && state.selectionError) {
      ui.selAi.appendChild(errorCard(state.selectionError, 'retry-selection'));
      return;
    }
    if (state.selectionStatus === 'ready' && state.selectionText) {
      const card = el('div', 'card ai');
      const head = el('div', 'card-head');
      head.appendChild(el('span', 'badge accent', 'AI 讲解'));
      card.appendChild(head);
      const body = el('div', 'md');
      appendMarkdown(body, state.selectionText);
      card.appendChild(body);
      ui.selAi.appendChild(card);
      return;
    }
    if (!hasKey()) {
      const card = el('div', 'card local');
      const head = el('div', 'card-head');
      head.appendChild(el('span', 'badge', '本地分析'));
      head.appendChild(el('span', 'muted', '无需联网'));
      card.appendChild(head);
      const terms = keyTerms(state.selection.text + ' ' + (state.selection.context || ''), 6);
      if (terms.length) {
        card.appendChild(el('div', 'mini-label', '关键词'));
        card.appendChild(keyChips(terms));
      }
      card.appendChild(
        el(
          'p',
          'muted',
          '本地模式只做结构分析。连接 AI 后会解释这段话的含义、术语，并结合上下文说明它意味着什么。'
        )
      );
      const foot = el('div', 'card-foot');
      const button = el('button', 'btn small', '连接 AI');
      button.dataset.act = 'settings';
      foot.appendChild(button);
      card.appendChild(foot);
      ui.selAi.appendChild(card);
    }
  }

  async function explainSelection(text, context) {
    const value = normalizeSpace(text || '');
    if (!value) return;
    state.selection = {
      text: value.slice(0, 3000),
      context: normalizeSpace(context || selectionContext()).slice(0, 1600)
    };
    state.selectionStatus = 'idle';
    state.selectionText = '';
    state.selectionError = null;
    openPanel('selection');
    renderSelectionPane();

    if (!hasKey()) {
      state.selectionStatus = 'local';
      renderSelectionPane();
      return;
    }

    state.selectionStatus = 'loading';
    renderSelectionPane();
    const page = ensurePage();
    const url = location.href;
    const result = await askAI('selection', {
      title: page.title,
      url: page.url,
      text: state.selection.text,
      context: state.selection.context
    });
    if (url !== location.href || !state.selection) return;
    if (result.ok) {
      state.selectionText = result.text;
      state.selectionStatus = 'ready';
    } else {
      state.selectionError = result;
      state.selectionStatus = 'error';
    }
    renderSelectionPane();
  }

  async function explainPage(force) {
    if (!state.page) ensurePage();
    if (state.pageStatus === 'loading') return;
    if (!force && (state.pageStatus === 'ready' || state.pageStatus === 'local')) return;
    if (!hasKey()) {
      state.pageStatus = 'local';
      renderPageAi(state.page);
      return;
    }
    const url = location.href;
    state.pageStatus = 'loading';
    state.pageError = null;
    renderPageAi(state.page);
    const page = state.page;
    const result = await askAI('page', {
      title: page.title,
      url: page.url,
      text: page.text,
      outline: page.outline.map((h) => '  '.repeat(h.level - 1) + h.text),
      results: page.results,
      stats: page.stats
    });
    if (url !== location.href) return;
    if (result.ok) {
      state.pageText = result.text;
      state.pageModel = result.model || '';
      state.pageStatus = 'ready';
    } else {
      state.pageError = result;
      state.pageStatus = 'error';
    }
    renderPageAi(page);
  }

  function refreshPage() {
    state.page = null;
    state.pageStatus = 'idle';
    state.pageText = '';
    state.pageError = null;
    ensurePage();
    renderPagePane();
    renderSelectionPane();
    if (hasKey() && state.settings.autoExplain) explainPage(true);
  }

  /* ---------------- 问答 ---------------- */

  function renderChat() {
    const desc = ui.chatEmpty.querySelector('.empty-desc');
    if (desc) {
      desc.textContent = hasKey()
        ? '我会结合当前页面的内容回答，不需要你复制粘贴。'
        : '配置 AI 接口后，可以围绕这一页连续追问；也可以先用「复制正文」把内容带去 ZCode。';
    }
    if (!hasKey()) {
      ui.chatEmpty.hidden = false;
    }
    ui.composer.classList.toggle('is-disabled', !hasKey());
    ui.input.disabled = !hasKey();
    clear(ui.messages);
    for (const message of state.chat) {
      ui.messages.appendChild(chatBubble(message.role, message.content));
    }
    if (state.chatBusy) {
      const typing = el('div', 'msg assistant typing');
      typing.appendChild(el('span', 'dot'));
      typing.appendChild(el('span', 'dot'));
      typing.appendChild(el('span', 'dot'));
      ui.messages.appendChild(typing);
    }
    ui.chatEmpty.hidden = state.chat.length > 0 || state.chatBusy;
    scrollChatToBottom();
  }

  function chatBubble(role, content) {
    const wrap = el('div', 'msg ' + (role === 'assistant' ? 'assistant' : 'user'));
    const bubble = el('div', 'msg-body');
    if (role === 'assistant') appendMarkdown(bubble, content);
    else bubble.textContent = content;
    wrap.appendChild(bubble);
    return wrap;
  }

  function scrollChatToBottom() {
    requestAnimationFrame(() => {
      ui.chatScroll.scrollTop = ui.chatScroll.scrollHeight;
    });
  }

  async function sendChat(question) {
    const value = normalizeSpace(question || '');
    if (!value || state.chatBusy) return;
    if (!hasKey()) {
      switchTab('page', false);
      const card = ui.pageAi.querySelector('.invite, .local');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    ensurePage();
    state.chat.push({ role: 'user', content: value });
    state.chatBusy = true;
    renderChat();
    ui.input.value = '';
    autoGrowInput();

    const history = state.chat.slice(0, -1);
    const url = location.href;
    const page = state.page;
    const result = await askAI('chat', {
      title: page.title,
      url: page.url,
      text: page.text,
      outline: page.outline.map((h) => '  '.repeat(h.level - 1) + h.text),
      results: page.results,
      selection: state.selection ? state.selection.text : '',
      history,
      question: value
    });

    if (url !== location.href) {
      state.chatBusy = false;
      renderChat();
      return;
    }
    state.chatBusy = false;
    if (result.ok) {
      state.chat.push({ role: 'assistant', content: result.text });
    } else {
      state.chat.push({
        role: 'assistant',
        content: `> ${result.message || '请求失败'}${result.detail ? '\n>\n> ' + result.detail : ''}`
      });
    }
    renderChat();
  }

  function autoGrowInput() {
    ui.input.style.height = 'auto';
    ui.input.style.height = Math.min(ui.input.scrollHeight, 108) + 'px';
  }

    /* ---------------- 截图与 ChatGPT 粘贴 ---------------- */

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function dataUrlToBlob(dataUrl) {
    const comma = String(dataUrl).indexOf(',');
    if (comma < 0) throw new Error('invalid data url');
    const meta = dataUrl.slice(0, comma);
    const base64 = dataUrl.slice(comma + 1);
    const mimeMatch = /data:([^;]+)/.exec(meta);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeMatch ? mimeMatch[1] : 'image/png' });
  }

  function showToast(message, duration) {
    if (!ui.toast || !message) return;
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => ui.toast.classList.remove('show'), duration || 3000);
  }

  function sendRuntime(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, message: '扩展连接中断，请刷新页面后重试' });
            return;
          }
          resolve(response || { ok: false, message: '没有收到响应' });
        });
      } catch (error) {
        resolve({
          ok: false,
          message: '扩展连接中断，请刷新页面后重试',
          detail: String(error && error.message ? error.message : error)
        });
      }
    });
  }

  function isEditableTarget(target) {
    const node = target && target.nodeType === 1 ? target : target && target.parentElement;
    if (!node) return false;
    if (node.closest('input, textarea, select, button, [role="button"], [contenteditable]:not([contenteditable="false"])')) {
      return true;
    }
    return false;
  }

  async function copyBlobToClipboard(blob) {
    try {
      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return true;
      }
    } catch (_) {
      /* 继续尝试 execCommand */
    }
    try {
      const url = URL.createObjectURL(blob);
      const image = document.createElement('img');
      image.src = url;
      image.style.cssText =
        'position:fixed;left:0;top:0;opacity:0;pointer-events:none;max-width:none;z-index:0;';
      document.body.appendChild(image);
      await new Promise((resolve) => {
        image.onload = resolve;
        image.onerror = resolve;
        setTimeout(resolve, 800);
      });
      const range = document.createRange();
      range.selectNode(image);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const ok = document.execCommand('copy');
      selection.removeAllRanges();
      image.remove();
      URL.revokeObjectURL(url);
      return ok;
    } catch (_) {
      return false;
    }
  }

  async function startScreenshot(force) {
    if (state.shot.active || state.shot.busy) return;
    if (!force && !state.settings.screenshotShortcut) return;
    state.shot.busy = true;
    hideSelectionButton();
    const previousVisibility = host.style.visibility;
    host.style.visibility = 'hidden';
    try {
      await sleep(90);
      const result = await sendRuntime({ type: 'capture-visible-tab' });
      if (!result || !result.ok || !result.dataUrl) {
        showToast((result && result.message) || '截图失败，请重试');
        return;
      }
      host.style.visibility = previousVisibility || '';
      await showShotOverlay(result.dataUrl);
    } catch (error) {
      showToast('截图失败：' + String(error && error.message ? error.message : error));
    } finally {
      host.style.visibility = previousVisibility || '';
      state.shot.busy = false;
    }
  }

  function cancelScreenshot(showMessage) {
    const current = state.shot;
    if (current.overlay) current.overlay.remove();
    if (current.bitmap && typeof current.bitmap.close === 'function') {
      try {
        current.bitmap.close();
      } catch (_) {
        /* ignore */
      }
    }
    state.shot = {
      active: false,
      busy: false,
      bitmap: null,
      box: null,
      start: null,
      dragging: false,
      overlay: null
    };
    if (showMessage) showToast('已取消截图');
  }

  async function showShotOverlay(dataUrl) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
    } catch (_) {
      showToast('无法解析截图数据');
      return;
    }

    cancelScreenshot(false);

    const overlay = el('div', 'shot');
    const canvas = el('canvas', 'shot-canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) {
      showToast('无法显示截图');
      return;
    }
    context.drawImage(bitmap, 0, 0);
    const box = el('div', 'shot-box');
    const size = el('div', 'shot-size');
    const hint = el('div', 'shot-hint', '拖动鼠标选择区域 · Esc 取消');
    const cursor = el('div', 'shot-cursor');
    const pointer = state.pointer && state.pointer.x ? state.pointer : { x: innerWidth / 2, y: innerHeight / 2 };
    cursor.style.left = pointer.x + 'px';
    cursor.style.top = pointer.y + 'px';
    overlay.appendChild(canvas);
    overlay.appendChild(box);
    overlay.appendChild(size);
    overlay.appendChild(cursor);
    overlay.appendChild(hint);

    state.shot = {
      active: true,
      busy: false,
      bitmap,
      box: null,
      start: null,
      dragging: false,
      overlay
    };

    let origin = null;

    const update = (x1, y1, x2, y2) => {
      const x = Math.min(x1, x2);
      const y = Math.min(y1, y2);
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);
      state.shot.box = { x, y, w: width, h: height };
      box.style.display = 'block';
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      box.style.width = width + 'px';
      box.style.height = height + 'px';
      size.textContent = Math.round(width) + ' × ' + Math.round(height);
      size.style.display = 'block';
      size.style.left = Math.min(innerWidth - 96, x + width + 6) + 'px';
      size.style.top = Math.min(innerHeight - 28, y + height + 6) + 'px';
    };

    overlay.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      state.shot.dragging = true;
      origin = {
        x: clamp(event.clientX, 0, innerWidth),
        y: clamp(event.clientY, 0, innerHeight)
      };
      hint.style.display = 'none';
      cursor.style.display = 'none';
      update(origin.x, origin.y, origin.x, origin.y);
      try {
        overlay.setPointerCapture(event.pointerId);
      } catch (_) {
        /* ignore */
      }
    });

    overlay.addEventListener('pointermove', (event) => {
      if (!state.shot.dragging || !origin) return;
      update(
        origin.x,
        origin.y,
        clamp(event.clientX, 0, innerWidth),
        clamp(event.clientY, 0, innerHeight)
      );
    });

    const finish = (event) => {
      if (!state.shot.dragging) return;
      state.shot.dragging = false;
      if (origin) {
        update(
          origin.x,
          origin.y,
          clamp(event.clientX, 0, innerWidth),
          clamp(event.clientY, 0, innerHeight)
        );
      }
      const rect = state.shot.box;
      if (rect && rect.w >= 6 && rect.h >= 6) {
        finishShot();
      } else {
        box.style.display = 'none';
        size.style.display = 'none';
        hint.style.display = 'block';
      }
    };

    overlay.addEventListener('pointerup', finish);
    overlay.addEventListener('pointercancel', finish);
    shadow.appendChild(overlay);
  }

  async function finishShot() {
    const bitmap = state.shot.bitmap;
    const box = state.shot.box;
    if (!bitmap || !box) {
      cancelScreenshot(false);
      return;
    }
    const scaleX = bitmap.width / innerWidth;
    const scaleY = bitmap.height / innerHeight;
    const sourceX = clamp(Math.round(box.x * scaleX), 0, bitmap.width - 1);
    const sourceY = clamp(Math.round(box.y * scaleY), 0, bitmap.height - 1);
    const sourceWidth = clamp(Math.round(box.w * scaleX), 1, bitmap.width - sourceX);
    const sourceHeight = clamp(Math.round(box.h * scaleY), 1, bitmap.height - sourceY);

    const canvas = document.createElement('canvas');
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      cancelScreenshot(false);
      showToast('截图生成失败');
      return;
    }
    context.drawImage(
      bitmap,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight
    );
    cancelScreenshot(false);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      showToast('截图生成失败');
      return;
    }
    const copied = await copyBlobToClipboard(blob);
    showToast(copied ? '截图已复制，正在切换到 ChatGPT…' : '正在切换到 ChatGPT…', 2200);

    let dataUrl = '';
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch (_) {
      /* ignore */
    }
    if (!dataUrl) {
      showToast(copied ? '截图已复制，请手动粘贴' : '截图生成失败');
      return;
    }

    const result = await sendRuntime({ type: 'paste-to-chatgpt', dataUrl });
    if (!result || !result.ok) {
      showToast((result && result.message) || (copied ? '自动粘贴失败，截图已复制' : '自动粘贴失败'));
      return;
    }
    if (result.pasted) {
      showToast('截图已粘贴到 ChatGPT', 2600);
    } else {
      showToast(
        copied ? '截图已复制，请在 ChatGPT 输入框按 ⌘V 粘贴' : '自动粘贴失败，请手动粘贴',
        4200
      );
    }
  }

  async function waitForComposer(timeout) {
    const selectors = [
      '#prompt-textarea',
      'form [contenteditable="true"]',
      '[contenteditable="true"][data-testid="prompt-textarea"]',
      'form textarea'
    ];
    const started = Date.now();
    while (Date.now() - started < timeout) {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node && node.getClientRects().length > 0 && !node.disabled && !node.readOnly) {
          return node;
        }
      }
      await sleep(200);
    }
    return null;
  }

  function composerSnapshot(scope) {
    return {
      images: new Set([...scope.querySelectorAll('img')].map((image) => image.src)),
      attachments: scope.querySelectorAll(
        '[data-testid*="attachment"], [class*="attachment"]'
      ).length
    };
  }

  function hasNewComposerImage(scope, before) {
    for (const image of scope.querySelectorAll('img')) {
      if ((image.src.startsWith('blob:') || image.src.startsWith('data:')) && !before.images.has(image.src)) {
        return true;
      }
    }
    return (
      scope.querySelectorAll('[data-testid*="attachment"], [class*="attachment"]').length >
      before.attachments
    );
  }

  async function pasteImageMessage(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') {
      return { ok: false, message: '截图数据无效' };
    }
    let blob;
    try {
      blob = dataUrlToBlob(dataUrl);
    } catch (_) {
      return { ok: false, message: '截图数据无效' };
    }

    const composer = await waitForComposer(6000);
    if (!composer) {
      showToast('没有找到 ChatGPT 输入框，请手动粘贴', 4200);
      return { ok: true, pasted: false, reason: 'NO_COMPOSER' };
    }

    composer.focus();
    const file = new File([blob], 'screenshot-' + Date.now() + '.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const scope = composer.closest('form') || composer.parentElement || document.body;
    const before = composerSnapshot(scope);

    try {
      const event = new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
        composed: true
      });
      if (!event.clipboardData) {
        Object.defineProperty(event, 'clipboardData', { value: transfer });
      }
      composer.dispatchEvent(event);
    } catch (_) {
      /* 继续尝试 drop */
    }
    await sleep(900);
    let pasted = hasNewComposerImage(scope, before);

    if (!pasted) {
      try {
        const rect = composer.getBoundingClientRect();
        const dropTransfer = new DataTransfer();
        dropTransfer.items.add(file);
        composer.dispatchEvent(
          new DragEvent('dragover', {
            dataTransfer: dropTransfer,
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
          })
        );
        composer.dispatchEvent(
          new DragEvent('drop', {
            dataTransfer: dropTransfer,
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
          })
        );
      } catch (_) {
        /* ignore */
      }
      await sleep(900);
      pasted = hasNewComposerImage(scope, before);
    }

    showToast(pasted ? '截图已粘贴，按 Enter 发送' : '截图已就绪，请在输入框按 ⌘V 粘贴', 4200);
    return { ok: true, pasted };
  }

  function bindScreenshotShortcut() {
    let lastSpaceAt = 0;
    let lastSpaceScroll = 0;

    document.addEventListener(
      'mousemove',
      (event) => {
        state.pointer = { x: event.clientX, y: event.clientY };
      },
      { passive: true, capture: true }
    );

    document.addEventListener(
      'keydown',
      (event) => {
        if (state.shot.active) {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancelScreenshot(true);
          }
          return;
        }

        if (
          event.altKey &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          event.code === 'KeyS'
        ) {
          event.preventDefault();
          startScreenshot(true);
          return;
        }

        if (!state.settings.screenshotShortcut) return;
        if (event.code !== 'Space' || event.repeat) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const path = event.composedPath ? event.composedPath() : [];
        if (path.includes(host) || isEditableTarget(event.target)) {
          lastSpaceAt = 0;
          return;
        }

        const now = performance.now();
        if (now - lastSpaceAt < 420) {
          event.preventDefault();
          const scrollTarget = lastSpaceScroll;
          lastSpaceAt = 0;
          if (Math.abs(window.scrollY - scrollTarget) > 1) {
            window.scrollTo(0, scrollTarget);
          }
          setTimeout(() => startScreenshot(true), 30);
        } else {
          lastSpaceAt = now;
          lastSpaceScroll = window.scrollY;
        }
      },
      true
    );
  }

  /* ---------------- 与后台通信 ---------------- */

  function askAI(kind, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'ai', kind, payload }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              ok: false,
              code: 'DISCONNECTED',
              message: '扩展连接中断，请刷新页面后重试'
            });
            return;
          }
          resolve(response || { ok: false, code: 'EMPTY', message: '没有收到返回内容' });
        });
      } catch (error) {
        resolve({
          ok: false,
          code: 'DISCONNECTED',
          message: '扩展连接中断，请刷新页面后重试',
          detail: String(error && error.message ? error.message : error)
        });
      }
    });
  }

  function openSettings() {
    try {
      chrome.runtime.openOptionsPage();
    } catch (_) {
      /* ignore */
    }
  }

  function updateStatus() {
    const connected = hasKey();
    ui.statusDot.title = connected
      ? 'AI 已连接：' + (state.settings.model || '')
      : '本地模式：配置 AI 后可逐段讲解';
    ui.statusDot.classList.toggle('online', connected);
    ui.footDot.classList.toggle('online', connected);
    ui.footText.textContent = connected
      ? 'AI · ' + (state.settings.model || '已连接')
      : '本地模式 · 点此连接 AI';
  }

  /* ---------------- 划词按钮 ---------------- */

  function showSelectionButton(rect) {
    ui.selBtn.hidden = false;
    const left = clamp(rect.left + rect.width / 2, 52, innerWidth - 52);
    let top = rect.top - 8;
    let below = false;
    if (top < 44) {
      top = rect.bottom + 8;
      below = true;
    }
    ui.selBtn.classList.toggle('below', below);
    ui.selBtn.style.left = Math.round(left) + 'px';
    ui.selBtn.style.top = Math.round(top) + 'px';
  }

  function hideSelectionButton() {
    ui.selBtn.hidden = true;
    state.pendingSelection = null;
  }

  function repositionSelectionButton() {
    if (!state.pendingSelection) return;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) {
      hideSelectionButton();
      return;
    }
    const text = normalizeSpace(selection.toString());
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!text || !rect || (!rect.width && !rect.height)) {
      hideSelectionButton();
      return;
    }
    state.pendingSelection.text = text.slice(0, 3000);
    showSelectionButton(rect);
  }

  function captureSelection() {
    if (!state.settings.selectionButton) return;
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) return;
    const text = normalizeSpace(selection.toString());
    if (text.length < 4 || text.length > 3000) {
      hideSelectionButton();
      return;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    state.pendingSelection = {
      text,
      context: selectionContext(),
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
    };
    showSelectionButton(rect);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch (_) {
        return false;
      }
    }
  }

  function flashButton(button, text) {
    const original = button.textContent;
    button.textContent = text;
    button.disabled = true;
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1200);
  }

  /* ---------------- 事件 ---------------- */

  function bindEvents() {
    let drag = null;

    ui.bubble.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = ui.bubble.getBoundingClientRect();
      drag = {
        startX: event.clientX,
        startY: event.clientY,
        originLeft: rect.left,
        originTop: rect.top,
        moved: false,
        pointerId: event.pointerId
      };
      try {
        ui.bubble.setPointerCapture(event.pointerId);
      } catch (_) {
        /* ignore */
      }
    });

    ui.bubble.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
      if (!drag.moved) return;
      const size = ui.bubble.offsetWidth || 52;
      setBubblePosition(
        clamp(drag.originLeft + dx, 8, innerWidth - size - 8),
        clamp(drag.originTop + dy, 8, innerHeight - size - 8)
      );
    });

    const endDrag = (event) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      try {
        ui.bubble.releasePointerCapture(event.pointerId);
      } catch (_) {
        /* ignore */
      }
      if (moved) {
        savePosition();
        if (state.open) positionPanel();
      } else {
        togglePanel();
      }
    };
    ui.bubble.addEventListener('pointerup', endDrag);
    ui.bubble.addEventListener('pointercancel', () => {
      drag = null;
    });

    ui.bubble.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        togglePanel();
      }
    });

    shadow.addEventListener('click', async (event) => {
      const tabButton = event.target.closest?.('[data-tab]');
      if (tabButton) {
        switchTab(tabButton.dataset.tab, true);
        return;
      }
      const suggest = event.target.closest?.('[data-suggest]');
      if (suggest) {
        sendChat(suggest.dataset.suggest);
        return;
      }
      const actionButton = event.target.closest?.('[data-act]');
      if (!actionButton) return;
      const action = actionButton.dataset.act;
      if (action === 'close') closePanel();
      else if (action === 'settings') openSettings();
      else if (action === 'refresh') refreshPage();
      else if (action === 'explain-page') explainPage(true);
      else if (action === 'retry-page') explainPage(true);
      else if (action === 'retry-selection') {
        if (state.selection) explainSelection(state.selection.text, state.selection.context);
      } else if (action === 'reexplain') {
        if (state.selection) explainSelection(state.selection.text, state.selection.context);
      } else if (action === 'copy-page') {
        const page = ensurePage();
        const text = `${page.title}\n${page.url}\n\n${page.text}`;
        const copied = await copyText(text);
        flashButton(actionButton, copied ? '已复制' : '复制失败');
      } else if (action === 'ask-selection') {
        switchTab('chat', true);
        if (state.selection) {
          ui.input.value = '围绕我选中的这段内容，再展开讲讲：' + state.selection.text.slice(0, 80);
          autoGrowInput();
          ui.input.focus();
        }
      }
    });

    ui.selBtn.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    ui.selBtn.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        ui.selBtn.click();
      }
    });
    ui.selBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const pending = state.pendingSelection;
      hideSelectionButton();
      if (pending) explainSelection(pending.text, pending.context);
    });

    document.addEventListener('mouseup', (event) => {
      const path = event.composedPath ? event.composedPath() : [];
      if (path.includes(host)) return;
      setTimeout(captureSelection, 10);
    });

    document.addEventListener('mousedown', (event) => {
      const path = event.composedPath ? event.composedPath() : [];
      if (!path.includes(host)) hideSelectionButton();
    });

    ui.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      sendChat(ui.input.value);
    });

    ui.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendChat(ui.input.value);
      }
    });
    ui.input.addEventListener('input', autoGrowInput);

    document.addEventListener(
      'keydown',
      (event) => {
        if (state.shot.active) return;
        if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyE') {
          event.preventDefault();
          togglePanel();
        } else if (event.key === 'Escape') {
          if (state.shot.active) return;
          if (!ui.selBtn.hidden) hideSelectionButton();
          else if (state.open) closePanel();
        }
      },
      true
    );

    window.addEventListener('resize', () => {
      const size = ui.bubble.offsetWidth || 52;
      const rect = ui.bubble.getBoundingClientRect();
      if (rect.left > innerWidth - size - 8 || rect.top > innerHeight - size - 8) {
        setBubblePosition(
          clamp(rect.left, 8, innerWidth - size - 8),
          clamp(rect.top, 8, innerHeight - size - 8)
        );
      }
      if (state.open) positionPanel();
      repositionSelectionButton();
    });

    window.addEventListener('scroll', hideSelectionButton, true);

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) {
          state.settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
          updateStatus();
          renderChat();
          renderPageAi(state.page || {});
        }
      });
    } catch (_) {
      /* ignore */
    }

    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'ping') {
          sendResponse({ ok: true });
          return;
        }
        if (message.type === 'open-panel') {
          openPanel(message.tab || 'page');
        } else if (message.type === 'explain-selection') {
          explainSelection(message.text || window.getSelection()?.toString() || '');
        } else if (message.type === 'paste-image') {
          pasteImageMessage(message.dataUrl).then((result) => sendResponse(result));
          return true;
        }
      });
    } catch (_) {
      /* ignore */
    }
  }

  function watchNavigation() {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      state.page = null;
      state.pageUrl = '';
      state.pageStatus = 'idle';
      state.pageText = '';
      state.pageError = null;
      state.selection = null;
      state.selectionStatus = 'idle';
      state.selectionText = '';
      state.chat = [];
      state.chatBusy = false;
      if (state.open) {
        ensurePage();
        ui.pageTitle.textContent = state.page.title;
        renderPagePane();
        renderSelectionPane();
        renderChat();
      }
    }, 1200);
  }

  const STYLE = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      display: block;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
      --ios-blue: #0A84FF;
      --ios-blue-deep: #007AFF;
      --ios-indigo: #5E5CE6;
      --ios-purple: #BF5AF2;
      --ios-pink: #FF375F;
      --ios-teal: #64D2FF;
      --ios-green: #30D158;
      --ios-orange: #FF9F0A;
      --label: #1C1C1E;
      --secondary: #636366;
      --tertiary: #8E8E93;
      --separator: rgba(60, 60, 67, .12);
      --fill: rgba(120, 120, 128, .12);
      --card: #FFFFFF;
      --bg: #F2F2F7;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button { font-family: inherit; }
    button:focus-visible, .sel-btn:focus-visible { outline: 2px solid rgba(10, 132, 255, .65); outline-offset: 2px; }
    .bubble {
      pointer-events: auto;
      position: fixed;
      width: 56px;
      height: 56px;
      border-radius: 17px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      cursor: grab;
      background: linear-gradient(145deg, #5AC8FA 0%, #0A84FF 38%, #5E5CE6 72%, #BF5AF2 100%);
      border: .5px solid rgba(255, 255, 255, .55);
      box-shadow:
        0 12px 28px rgba(10, 132, 255, .32),
        0 2px 6px rgba(0, 0, 0, .12),
        inset 0 1px 0 rgba(255, 255, 255, .45);
      transition: transform .18s cubic-bezier(.2, .9, .3, 1.2), box-shadow .18s ease;
      user-select: none;
      touch-action: none;
      overflow: hidden;
    }
    .bubble::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: radial-gradient(80% 60% at 30% 0%, rgba(255, 255, 255, .38), transparent 62%);
      pointer-events: none;
    }
    .bubble:hover {
      transform: scale(1.06);
      box-shadow:
        0 16px 34px rgba(10, 132, 255, .4),
        0 2px 8px rgba(0, 0, 0, .14),
        inset 0 1px 0 rgba(255, 255, 255, .5);
    }
    .bubble:active, .bubble.is-active { transform: scale(.95); cursor: grabbing; }
    .bubble-glyph {
      position: relative;
      font-size: 27px;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0;
      color: #fff;
      text-shadow: 0 1px 3px rgba(0, 0, 0, .18);
      transform: translateY(-1px);
    }
    .bubble .status-dot {
      position: absolute;
      right: 2px;
      bottom: 2px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #C7C7CC;
      border: 2px solid #fff;
      z-index: 1;
    }
    .bubble .status-dot.online { background: var(--ios-green); }
    .panel {
      pointer-events: auto;
      position: fixed;
      display: flex;
      flex-direction: column;
      max-height: min(74vh, 720px);
      background: rgba(250, 250, 252, .92);
      border: .5px solid rgba(255, 255, 255, .8);
      border-radius: 24px;
      box-shadow:
        0 24px 60px rgba(0, 0, 0, .22),
        0 2px 8px rgba(0, 0, 0, .08),
        inset 0 0 0 .5px rgba(0, 0, 0, .04);
      color: var(--label);
      overflow: hidden;
      backdrop-filter: blur(30px) saturate(180%);
      -webkit-backdrop-filter: blur(30px) saturate(180%);
      animation: pe-in .22s cubic-bezier(.2, .9, .25, 1.1);
    }
    .panel[hidden] { display: none; }
    @keyframes pe-in { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 14px 14px 10px 16px;
      flex: none;
    }
    .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .logo {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      background: linear-gradient(145deg, #5AC8FA, #0A84FF 45%, #5E5CE6);
      box-shadow:
        0 4px 10px rgba(10, 132, 255, .24),
        inset 0 1px 0 rgba(255, 255, 255, .45);
      flex: none;
    }
    .brand-text { min-width: 0; }
    .title { font-size: 15px; font-weight: 650; letter-spacing: -.2px; line-height: 1.3; color: var(--label); }
    .page-title {
      font-size: 11px;
      color: var(--tertiary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 220px;
      line-height: 1.4;
      margin-top: 1px;
    }
    .head-actions { display: flex; gap: 1px; flex: none; }
    .icon-btn {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--tertiary);
      cursor: pointer;
      transition: background .15s ease, color .15s ease;
    }
    .icon-btn:hover { background: var(--fill); color: var(--label); }
    .tabs {
      display: flex;
      gap: 2px;
      margin: 0 14px 10px;
      padding: 3px;
      background: rgba(120, 120, 128, .12);
      border-radius: 10px;
      border: 0;
      flex: none;
    }
    .tab {
      flex: 1;
      height: 30px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--secondary);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0;
      cursor: pointer;
      transition: background .15s ease, color .15s ease, box-shadow .15s ease;
    }
    .tab:hover { color: var(--label); background: transparent; }
    .tab.active {
      color: var(--label);
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .12), 0 0 0 .5px rgba(0, 0, 0, .04);
    }
    .tab.active::after { display: none; }
    .body { overflow: hidden; display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
    .pane { overflow-y: auto; padding: 0 14px 14px; display: flex; flex-direction: column; gap: 10px; flex: 1 1 auto; min-height: 0; }
    .pane[hidden] { display: none; }
    .pane::-webkit-scrollbar, .chat-scroll::-webkit-scrollbar { width: 8px; }
    .pane::-webkit-scrollbar-thumb, .chat-scroll::-webkit-scrollbar-thumb {
      background: rgba(120, 120, 128, .28);
      border-radius: 99px;
      border: 2px solid transparent;
      background-clip: content-box;
    }
    .stats { display: flex; gap: 8px; flex: none; }
    .stat {
      flex: 1;
      padding: 10px 11px 9px;
      border-radius: 14px;
      border: 0;
      min-width: 0;
      color: #fff;
      background: linear-gradient(145deg, #5AC8FA, #0A84FF);
      box-shadow: 0 6px 16px rgba(10, 132, 255, .2), inset 0 1px 0 rgba(255, 255, 255, .3);
    }
    .stat:nth-child(2) {
      background: linear-gradient(145deg, #BF5AF2, #5E5CE6);
      box-shadow: 0 6px 16px rgba(94, 92, 230, .2), inset 0 1px 0 rgba(255, 255, 255, .3);
    }
    .stat:nth-child(3) {
      background: linear-gradient(145deg, #30D158, #0ACF83);
      box-shadow: 0 6px 16px rgba(48, 209, 88, .2), inset 0 1px 0 rgba(255, 255, 255, .3);
    }
    .stat-value { font-size: 15px; font-weight: 700; letter-spacing: -.2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; font-variant-numeric: tabular-nums; }
    .stat-label { font-size: 10.5px; color: rgba(255, 255, 255, .88); margin-top: 1px; }
    .card {
      border-radius: 16px;
      padding: 12px 14px;
      background: var(--card);
      border: .5px solid rgba(60, 60, 67, .1);
      box-shadow: 0 2px 8px rgba(0, 0, 0, .04);
      font-size: 12.5px;
      line-height: 1.65;
      color: var(--label);
    }
    .card.ai {
      border: 1px solid transparent;
      background: linear-gradient(#fff, #fff) padding-box, linear-gradient(135deg, rgba(10, 132, 255, .58), rgba(191, 90, 242, .52)) border-box;
      box-shadow: 0 6px 18px rgba(10, 132, 255, .08);
    }
    .card.error { background: #FFF2F2; border-color: rgba(255, 55, 95, .28); }
    .card.invite { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
    .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0;
      color: var(--ios-blue-deep);
      background: rgba(10, 132, 255, .1);
      border: 0;
      padding: 3px 8px;
      border-radius: 6px;
    }
    .badge.accent { color: #9B4FD0; background: rgba(191, 90, 242, .1); }
    .muted { color: var(--tertiary); font-size: 11px; }
    .md { font-size: 12.5px; line-height: 1.68; color: #3A3A3C; }
    .md > :first-child { margin-top: 0; }
    .md > :last-child { margin-bottom: 0; }
    .md-heading { font-weight: 650; color: var(--label); margin: 10px 0 4px; font-size: 12.5px; letter-spacing: -.1px; }
    .md-h1 { font-size: 13.5px; }
    .md-p { margin: 0 0 6px; }
    .md-list { margin: 2px 0 7px; padding-left: 17px; }
    .md-list li { margin: 2px 0; }
    .md-list li::marker { color: var(--ios-blue); }
    .md-quote {
      margin: 6px 0 7px;
      padding: 7px 10px;
      border-left: 3px solid var(--ios-blue);
      background: var(--bg);
      border-radius: 6px;
      color: var(--secondary);
    }
    .md code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      background: var(--bg);
      color: var(--ios-indigo);
      padding: 1px 5px;
      border-radius: 5px;
    }
    .md strong { color: var(--label); font-weight: 650; }
    .points { margin: 0; padding-left: 17px; }
    .points li { margin: 4px 0; }
    .points li::marker { color: var(--ios-blue); }
    .terms { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
    .chip {
      font-size: 10.5px;
      color: #3A3A3C;
      background: var(--bg);
      border: 0;
      border-radius: 6px;
      padding: 3px 8px;
    }
    .mini-label { font-size: 10.5px; color: var(--tertiary); margin: 8px 0 4px; }
    .card-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 10px;
      padding-top: 9px;
      border-top: .5px solid var(--separator);
    }
    .card-foot-actions { display: flex; gap: 6px; flex: none; }
    .btn {
      border: 0;
      border-radius: 10px;
      padding: 6px 13px;
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: 0;
      color: #fff;
      background: var(--ios-blue);
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(10, 132, 255, .24);
      transition: background .15s ease, transform .1s ease;
      flex: none;
    }
    .btn:hover { background: var(--ios-blue-deep); }
    .btn:active { transform: translateY(1px); }
    .btn.small { padding: 4px 10px; font-size: 11px; border-radius: 8px; }
    .btn.ghost {
      background: var(--fill);
      color: var(--label);
      box-shadow: none;
    }
    .btn.ghost:hover { background: rgba(120, 120, 128, .18); }
    .invite-title { font-size: 12.5px; font-weight: 650; color: var(--label); }
    .invite-desc { font-size: 11px; color: var(--tertiary); margin: 1px 0 8px; }
    .err-title { font-weight: 650; color: #D70015; font-size: 12.5px; }
    .err-detail { color: #C34A4A; font-size: 11px; margin-top: 3px; word-break: break-word; }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 9px; }
    .skel-card { overflow: hidden; }
    .skel-bar {
      height: 9px;
      border-radius: 5px;
      margin: 8px 0;
      background: linear-gradient(90deg, rgba(120, 120, 128, .1) 25%, rgba(120, 120, 128, .2) 37%, rgba(120, 120, 128, .1) 63%);
      background-size: 400% 100%;
      animation: pe-shimmer 1.3s ease infinite;
    }
    @keyframes pe-shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
    .result { display: block; padding: 8px 0 9px; border-top: .5px solid var(--separator); text-decoration: none; color: inherit; }
    .result:first-of-type { border-top: 0; padding-top: 2px; }
    .result-title { font-size: 12px; font-weight: 600; color: var(--ios-blue-deep); line-height: 1.45; }
    .result:hover .result-title { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    .result-domain { font-size: 10px; color: var(--tertiary); margin-top: 2px; }
    .result-snippet { font-size: 11px; color: var(--secondary); margin-top: 3px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .outline-item {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      width: 100%;
      text-align: left;
      border: 0;
      background: transparent;
      color: var(--secondary);
      padding: 6px 7px;
      border-radius: 8px;
      font-size: 11.5px;
      line-height: 1.45;
      cursor: pointer;
    }
    .outline-item:hover { background: var(--bg); color: var(--label); }
    .outline-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--ios-blue); margin-top: 5px; flex: none; }
    .outline-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .quote {
      border-left: 3px solid var(--ios-blue);
      background: var(--bg);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.65;
      color: #3A3A3C;
      max-height: 132px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .meta { font-size: 10.5px; color: var(--tertiary); margin: 6px 2px 2px; }
    .empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 26px 16px 10px; }
    .empty-icon {
      width: 46px;
      height: 46px;
      border-radius: 14px;
      display: grid;
      place-items: center;
      color: var(--ios-blue);
      background: linear-gradient(135deg, rgba(10, 132, 255, .12), rgba(191, 90, 242, .12));
      border: 0;
      margin-bottom: 10px;
    }
    .empty-title { font-size: 13.5px; font-weight: 650; color: var(--label); }
    .empty-desc { font-size: 11.5px; color: var(--tertiary); line-height: 1.65; margin: 5px 0 0; max-width: 280px; }
    .suggests { display: flex; flex-direction: column; gap: 6px; width: 100%; margin-top: 14px; }
    .suggest {
      border: 0;
      background: var(--bg);
      color: #3A3A3C;
      border-radius: 10px;
      padding: 8px 11px;
      font-size: 11.5px;
      text-align: left;
      cursor: pointer;
    }
    .suggest:hover { background: rgba(10, 132, 255, .1); color: var(--ios-blue-deep); }
    .chat-pane { padding: 0; gap: 0; overflow: hidden; }
    .chat-scroll { flex: 1 1 auto; overflow-y: auto; padding: 2px 14px 4px; min-height: 0; }
    .messages { display: flex; flex-direction: column; gap: 8px; }
    .msg { display: flex; }
    .msg.user { justify-content: flex-end; }
    .msg-body {
      max-width: 88%;
      border-radius: 18px;
      padding: 8px 12px;
      font-size: 12px;
      line-height: 1.62;
      word-break: break-word;
    }
    .msg.assistant .msg-body {
      background: var(--bg);
      color: var(--label);
      border-bottom-left-radius: 6px;
    }
    .msg.user .msg-body {
      background: var(--ios-blue);
      color: #fff;
      border-bottom-right-radius: 6px;
    }
    .msg.user .msg-body .md { color: #fff; }
    .msg.user .msg-body .md strong { color: #fff; }
    .msg-body .md { font-size: 12px; }
    .msg-body .md-p { margin-bottom: 5px; }
    .typing { display: inline-flex; gap: 4px; padding: 10px 13px; }
    .typing .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--tertiary); animation: pe-blink 1.1s infinite ease-in-out; }
    .typing .dot:nth-child(2) { animation-delay: .15s; }
    .typing .dot:nth-child(3) { animation-delay: .3s; }
    @keyframes pe-blink { 0%, 80%, 100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
    .composer {
      flex: none;
      display: flex;
      align-items: flex-end;
      gap: 7px;
      margin: 0 12px 12px;
      padding: 6px 6px 6px 14px;
      background: var(--bg);
      border: .5px solid rgba(60, 60, 67, .08);
      border-radius: 20px;
    }
    .composer textarea {
      flex: 1;
      resize: none;
      border: 0;
      background: transparent;
      color: var(--label);
      padding: 6px 0;
      font-family: inherit;
      font-size: 12px;
      line-height: 1.6;
      max-height: 108px;
      outline: none;
    }
    .composer textarea::placeholder { color: var(--tertiary); }
    .composer.is-disabled { opacity: .55; }
    .send {
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #fff;
      background: var(--ios-blue);
      cursor: pointer;
      flex: none;
      box-shadow: 0 2px 6px rgba(10, 132, 255, .3);
    }
    .send:hover { background: var(--ios-blue-deep); }
    .foot {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 14px 8px;
      border-top: .5px solid var(--separator);
      background: transparent;
    }
    .foot-status { display: flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--tertiary); font-size: 10.5px; padding: 2px 0; cursor: pointer; }
    .foot-status:hover { color: var(--label); }
    .foot .dot { width: 6px; height: 6px; border-radius: 50%; background: #C7C7CC; }
    .foot .dot.online { background: var(--ios-green); box-shadow: 0 0 0 3px rgba(48, 209, 88, .14); }
    .hint { font-size: 10px; color: var(--tertiary); letter-spacing: .1px; }
    .sel-btn {
      pointer-events: auto;
      position: fixed;
      transform: translate(-50%, -100%);
      height: 30px;
      padding: 0 14px;
      border-radius: 999px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: .2px;
      background: var(--ios-blue);
      border: .5px solid rgba(255, 255, 255, .4);
      box-shadow: 0 6px 18px rgba(10, 132, 255, .38), 0 1px 3px rgba(0, 0, 0, .12);
      cursor: pointer;
      user-select: none;
      animation: pe-pop .16s cubic-bezier(.2, .9, .3, 1.2);
      white-space: nowrap;
    }
    .sel-btn.below { transform: translate(-50%, 0); }
    .sel-btn[hidden] { display: none; }
    @keyframes pe-pop { from { opacity: 0; transform: translate(-50%, -92%) scale(.9); } to { opacity: 1; transform: translate(-50%, -100%) scale(1); } }
    .toast {
      position: fixed;
      left: 50%;
      bottom: 26px;
      transform: translate(-50%, 10px);
      max-width: min(420px, calc(100vw - 32px));
      padding: 10px 16px;
      border-radius: 14px;
      background: rgba(255, 255, 255, .95);
      border: .5px solid rgba(0, 0, 0, .08);
      border-left: 3px solid var(--ios-blue);
      color: var(--label);
      font-size: 12px;
      line-height: 1.5;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .18);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      opacity: 0;
      pointer-events: none;
      transition: opacity .2s ease, transform .2s ease;
      z-index: 2147483000;
      text-align: center;
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
    .shot {
      position: fixed;
      inset: 0;
      pointer-events: auto;
      cursor: crosshair;
      user-select: none;
      z-index: 2147482000;
      background: #000;
    }
    .shot-canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    .shot-box {
      position: absolute;
      display: none;
      border: 1px solid rgba(255, 255, 255, .95);
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, .45), 0 0 0 1px rgba(0, 0, 0, .3);
      pointer-events: none;
    }
    .shot-box::after {
      content: "";
      position: absolute;
      inset: -2px;
      border: 1.5px solid var(--ios-blue);
      border-radius: 1px;
    }
    .shot-hint {
      position: fixed;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      padding: 7px 15px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .94);
      border: .5px solid rgba(0, 0, 0, .08);
      color: var(--label);
      font-size: 11.5px;
      letter-spacing: .1px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, .2);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      pointer-events: none;
      z-index: 2147483001;
      white-space: nowrap;
    }
    .shot-cursor {
      position: absolute;
      width: 20px;
      height: 20px;
      margin: -10px 0 0 -10px;
      border: 1.5px solid var(--ios-blue);
      border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, .9), 0 0 0 5px rgba(10, 132, 255, .2);
      pointer-events: none;
      z-index: 2147483001;
    }
    .shot-cursor::before, .shot-cursor::after {
      content: "";
      position: absolute;
      background: rgba(255, 255, 255, .95);
      box-shadow: 0 0 0 1px rgba(0, 0, 0, .35);
    }
    .shot-cursor::before { left: 50%; top: -5px; width: 1px; height: 30px; transform: translateX(-50%); }
    .shot-cursor::after { top: 50%; left: -5px; height: 1px; width: 30px; transform: translateY(-50%); }
    .shot-size {
      position: absolute;
      display: none;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, .95);
      border: .5px solid rgba(0, 0, 0, .08);
      color: var(--label);
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
      box-shadow: 0 3px 10px rgba(0, 0, 0, .15);
      pointer-events: none;
      z-index: 2147483001;
    }
    @media (prefers-reduced-motion: reduce) {
      .bubble, .panel, .sel-btn, .skel-bar, .typing .dot { animation: none !important; transition: none !important; }
    }
  `;
  init();
})();
