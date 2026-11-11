'use strict';

(() => {
  const api = window.lite;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const svgWrap = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

  const ICONS = {
    reload: svgWrap('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5v4.2h-4.2" />'),
    stop: svgWrap('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />'),
    lock: svgWrap('<rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V7.2a4 4 0 0 1 8 0v3.3" />'),
    warning: svgWrap(
      '<path d="M12 4.2L21 20H3z" /><path d="M12 9.6v4.4" /><circle cx="12" cy="17.1" r="0.6" fill="currentColor" stroke="none" />',
    ),
    globe: svgWrap('<circle cx="12" cy="12" r="8.2" /><path d="M3.8 12h16.4" /><path d="M12 3.8c2.4 2.3 3.7 5.2 3.7 8.2s-1.3 5.9-3.7 8.2c-2.4-2.3-3.7-5.2-3.7-8.2S9.6 6.1 12 3.8z" />'),
    file: svgWrap('<path d="M6 3.8h7l5 5V20H6z" /><path d="M13 3.8v5h5" />'),
    maximize: svgWrap('<rect x="4.4" y="4.4" width="15.2" height="15.2" rx="1.6" />'),
    restore: svgWrap('<rect x="4.2" y="7.4" width="12.4" height="12.4" rx="1.4" /><path d="M7.6 4.2h11.8v11.8" />'),
    closeSmall: svgWrap('<path d="M6 6l12 12M18 6L6 18" />'),
  };

  const ENGINE_LABELS = { bing: 'Bing', google: 'Google', duckduckgo: 'DuckDuckGo', baidu: '百度' };
  const RING_LENGTH = 2 * Math.PI * 14;

  const els = {
    chrome: $('#chrome'),
    chromeMain: $('#chrome-main'),
    tabs: $('#tabs'),
    tabstrip: $('#tabstrip'),
    back: $('#btn-back'),
    forward: $('#btn-forward'),
    reload: $('#btn-reload'),
    home: $('#btn-home'),
    omnibox: $('#omnibox'),
    urlInput: $('#url-input'),
    security: $('#security'),
    star: $('#btn-star'),
    zoom: $('#btn-zoom'),
    downloads: $('#btn-downloads'),
    downloadBadge: $('#download-badge'),
    ring: $('.dl-ring-progress'),
    incognitoBadge: $('#incognito-badge'),
    menu: $('#btn-menu'),
    bookmarksBar: $('#bookmarks-bar'),
    findbar: $('#findbar'),
    findInput: $('#find-input'),
    findCount: $('#find-count'),
    findPrev: $('#find-prev'),
    findNext: $('#find-next'),
    findClose: $('#find-close'),
    errorbar: $('#errorbar'),
    errorText: $('#error-text'),
    errorRetry: $('#error-retry'),
    errorDismiss: $('#error-dismiss'),
    progress: $('#progress'),
    newtab: $('#newtab'),
    newtabSearch: $('#nt-search'),
    newtabInput: $('#nt-input'),
    recentSection: $('#nt-recent-section'),
    recent: $('#nt-recent'),
    clearHistory: $('#clear-history'),
    ntVersion: $('#nt-version'),
    ntChrome: $('#nt-chrome'),
    ntEngine: $('#nt-engine'),
    maximizeBtn: $('[data-window="maximize"]'),
  };

  const state = {
    tabs: [],
    activeTabId: null,
    incognito: false,
    bookmarks: [],
    settings: {
      searchEngine: 'bing',
      bookmarksBar: true,
      restoreTabs: true,
      homePage: '',
      verticalTabs: false,
    },
    history: [],
    downloads: [],
    window: { maximized: false, fullscreen: false },
    platform: 'win32',
    versions: {},
  };

  let omniboxFocused = false;
  let findOpen = false;
  let findText = '';
  let dismissedErrorKey = '';
  let reportedMetricsKey = '';
  let bookmarksSignature = null;
  let previousDownloadIds = new Set();
  let previousActiveDownloads = 0;
  let bumpTimer = null;
  let dragState = null;
  let suppressClick = false;
  const tabNodes = new Map();

  const activeTab = () => state.tabs.find((tab) => tab.id === state.activeTabId) || null;

  /* ------------------------------------------------------------------ */
  /* 工具函数                                                            */
  /* ------------------------------------------------------------------ */

  function hashString(value) {
    let hash = 0;
    for (const char of String(value || '')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return hash;
  }

  const PALETTE = ['#2f6fed', '#0f9d8f', '#e2574c', '#8a5cf6', '#d9822b', '#2f9e44', '#c2478f', '#1c7ed6', '#7c8794'];

  function colorFor(seed) {
    return PALETTE[hashString(seed) % PALETTE.length];
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function letterForSeed(seed, fallback = '·') {
    const text = String(seed || '').trim();
    if (!text) return fallback;
    const char = Array.from(text)[0];
    return char ? char.toUpperCase() : fallback;
  }

  function letterForTab(tab) {
    if (!tab || !tab.url) return '新';
    return letterForSeed(hostOf(tab.url) || tab.title, '·');
  }

  function defaultFaviconFor(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return `${parsed.origin}/favicon.ico`;
    } catch {
      return '';
    }
  }

  function reportLayoutMetrics() {
    const vertical = Boolean(state.settings.verticalTabs);
    const source = vertical ? els.chromeMain : els.chrome;
    if (!source) return;
    const top = Math.ceil(source.getBoundingClientRect().height);
    const sidebar = vertical
      ? Math.ceil(els.tabstrip.getBoundingClientRect().width)
      : 0;
    if (!top) return;
    const key = `${vertical}|${top}|${sidebar}`;
    if (key === reportedMetricsKey) return;
    reportedMetricsKey = key;
    api.setLayoutMetrics({ top, sidebar, vertical });
  }

  function reportChromeHeightSoon() {
    requestAnimationFrame(() => requestAnimationFrame(reportLayoutMetrics));
  }

  function navigateFromUi(input) {
    const value = String(input || '').trim();
    if (!value) return;
    api.tabs.navigate(state.activeTabId, value);
  }

  /* ------------------------------------------------------------------ */
  /* 标签页                                                              */
  /* ------------------------------------------------------------------ */

  function createTabElement(tab) {
    const el = document.createElement('div');
    el.className = 'tab enter';
    el.dataset.id = String(tab.id);
    el.setAttribute('role', 'tab');
    el.innerHTML = `
      <span class="tab-icon"></span>
      <span class="tab-title"></span>
      <span class="tab-close" role="button" title="关闭标签页">${ICONS.closeSmall}</span>
    `;
    el.addEventListener('animationend', () => el.classList.remove('enter'), { once: true });
    return el;
  }

  function fillTabIcon(icon, tab) {
    const key = `${tab.isLoading ? 1 : 0}|${tab.favicon || ''}|${tab.url || ''}|${tab.title || ''}`;
    if (icon.dataset.key === key) return;
    icon.dataset.key = key;
    icon.className = 'tab-icon';
    icon.replaceChildren();
    icon.style.background = '';

    if (tab.isLoading) {
      const spinner = document.createElement('span');
      spinner.className = 'tab-spinner';
      icon.appendChild(spinner);
      return;
    }

    if (!tab.url) {
      const logo = document.createElement('img');
      logo.src = 'assets/logo.svg';
      logo.alt = '';
      logo.draggable = false;
      logo.addEventListener('error', () => {
        icon.replaceChildren();
        icon.classList.add('letter');
        icon.textContent = '新';
        icon.style.background = '#2f6fed';
      });
      icon.appendChild(logo);
      icon.classList.add('app-logo');
      return;
    }

    if (tab.favicon) {
      const img = document.createElement('img');
      img.src = tab.favicon;
      img.alt = '';
      img.draggable = false;
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        icon.replaceChildren();
        icon.className = 'tab-icon letter';
        icon.textContent = letterForTab(tab);
        icon.style.background = colorFor(tab.url || tab.title);
      });
      icon.appendChild(img);
      return;
    }

    icon.classList.add('letter');
    if (!tab.url) {
      icon.textContent = '新';
      icon.style.background = '#2f6fed';
    } else {
      icon.textContent = letterForTab(tab);
      icon.style.background = colorFor(tab.url || tab.title);
    }
  }

  function updateTabElement(el, tab) {
    const active = tab.id === state.activeTabId;
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', active ? 'true' : 'false');
    el.title = tab.title || '新标签页';
    const title = el.querySelector('.tab-title');
    const text = tab.title || '新标签页';
    if (title.textContent !== text) title.textContent = text;
    fillTabIcon(el.querySelector('.tab-icon'), tab);
  }

  function renderTabs() {
    const seen = new Set();
    const dragging = Boolean(dragState && dragState.started);

    state.tabs.forEach((tab, index) => {
      let el = tabNodes.get(tab.id);
      if (!el) {
        el = createTabElement(tab);
        tabNodes.set(tab.id, el);
      }
      updateTabElement(el, tab);

      if (!dragging) {
        const reference = els.tabs.children[index] || null;
        if (reference !== el) els.tabs.insertBefore(el, reference);
      }
      seen.add(tab.id);
    });

    for (const [id, el] of Array.from(tabNodes)) {
      if (seen.has(id)) continue;
      el.remove();
      tabNodes.delete(id);
    }

    if (!dragging) {
      const activeEl = tabNodes.get(state.activeTabId);
      if (activeEl) {
        requestAnimationFrame(() => activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      }
    }

    updateTabDensity();
  }

  function updateTabDensity() {
    if (state.settings.verticalTabs) {
      els.tabs.classList.remove('compact', 'tiny');
      return;
    }
    const count = state.tabs.length;
    const strip = document.getElementById('tabstrip');
    const controls = document.getElementById('window-controls');
    const newTab = document.getElementById('new-tab');
    const reserved =
      (controls ? controls.offsetWidth : 0) + (newTab ? newTab.offsetWidth : 0) + 26;
    const available = Math.max(0, (strip ? strip.clientWidth : 0) - reserved);
    const perTab = count > 0 ? available / count : 0;
    els.tabs.classList.toggle('compact', perTab > 0 && perTab < 118);
    els.tabs.classList.toggle('tiny', perTab > 0 && perTab < 76);
  }

  let densityFrame = 0;

  function scheduleTabDensity() {
    if (densityFrame) return;
    densityFrame = requestAnimationFrame(() => {
      densityFrame = 0;
      updateTabDensity();
    });
  }

  function closeTabWithAnimation(id) {
    const el = tabNodes.get(id);
    if (!el || el.classList.contains('closing')) return;
    el.classList.add('closing');
    setTimeout(() => api.tabs.close(id), 180);
  }

  function flipMoveTab(el, reference) {
    const vertical = Boolean(state.settings.verticalTabs);
    const nodes = Array.from(els.tabs.querySelectorAll('.tab'));
    const before = new Map(nodes.map((node) => [node, node.getBoundingClientRect()]));
    els.tabs.insertBefore(el, reference);
    for (const node of nodes) {
      if (node === el) continue;
      const previous = before.get(node);
      const current = node.getBoundingClientRect();
      const delta = vertical ? previous.top - current.top : previous.left - current.left;
      if (Math.abs(delta) < 1) continue;
      node.style.transition = 'none';
      node.style.transform = vertical ? `translateY(${delta}px)` : `translateX(${delta}px)`;
      requestAnimationFrame(() => {
        node.style.transition = 'transform 0.16s ease';
        node.style.transform = '';
        setTimeout(() => {
          node.style.transition = '';
        }, 200);
      });
    }
  }

  function onTabPointerDown(event) {
    if (event.button !== 0) return;
    const tabEl = event.target.closest('.tab');
    if (!tabEl || event.target.closest('.tab-close')) return;
    dragState = {
      id: Number(tabEl.dataset.id),
      el: tabEl,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    };
    document.addEventListener('pointermove', onTabPointerMove);
    document.addEventListener('pointerup', onTabPointerUp, { once: true });
    document.addEventListener('pointercancel', onTabPointerUp, { once: true });
  }

  function onTabPointerMove(event) {
    if (!dragState) return;
    if (!dragState.started) {
      if (Math.abs(event.clientX - dragState.startX) < 4 && Math.abs(event.clientY - dragState.startY) < 4) {
        return;
      }
      dragState.started = true;
      dragState.el.classList.add('dragging');
      els.tabs.classList.add('dragging');
      document.body.classList.add('tab-dragging');
    }

    const vertical = Boolean(state.settings.verticalTabs);
    const stripRect = els.tabs.getBoundingClientRect();
    if (vertical) {
      if (event.clientY < stripRect.top + 24) els.tabs.scrollTop -= 12;
      else if (event.clientY > stripRect.bottom - 24) els.tabs.scrollTop += 12;
    } else {
      if (event.clientX < stripRect.left + 24) els.tabs.scrollLeft -= 12;
      else if (event.clientX > stripRect.right - 24) els.tabs.scrollLeft += 12;
    }

    const siblings = Array.from(els.tabs.querySelectorAll('.tab')).filter((node) => node !== dragState.el);
    let reference = null;
    for (const node of siblings) {
      const rect = node.getBoundingClientRect();
      const before = vertical
        ? event.clientY < rect.top + rect.height / 2
        : event.clientX < rect.left + rect.width / 2;
      if (before) {
        reference = node;
        break;
      }
    }
    if (reference === dragState.el.nextElementSibling) return;
    if (!reference && dragState.el === els.tabs.lastElementChild) return;
    flipMoveTab(dragState.el, reference);
  }

  function onTabPointerUp() {
    document.removeEventListener('pointermove', onTabPointerMove);
    if (!dragState) return;
    const wasDragging = dragState.started;
    dragState.el.classList.remove('dragging');
    els.tabs.classList.remove('dragging');
    document.body.classList.remove('tab-dragging');
    if (wasDragging) {
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      }, 120);
      const ids = Array.from(els.tabs.querySelectorAll('.tab'))
        .map((node) => Number(node.dataset.id))
        .filter((id) => Number.isFinite(id));
      api.tabs.reorder(ids);
    }
    dragState = null;
  }

  /* ------------------------------------------------------------------ */
  /* 工具栏                                                              */
  /* ------------------------------------------------------------------ */

  function renderToolbar() {
    const tab = activeTab();
    const url = tab ? tab.url || '' : '';
    const loading = Boolean(tab && tab.isLoading);

    els.back.disabled = !tab || !tab.canGoBack;
    els.forward.disabled = !tab || !tab.canGoForward;
    els.reload.innerHTML = loading ? ICONS.stop : ICONS.reload;
    els.reload.title = loading ? '停止加载 (Esc)' : '重新加载 (Ctrl+R)';
    els.reload.setAttribute('aria-label', loading ? '停止加载' : '重新加载');

    let security = 'none';
    if (/^https:/i.test(url)) security = 'secure';
    else if (/^http:/i.test(url)) security = 'insecure';
    else if (/^file:/i.test(url)) security = 'file';
    els.security.className = `security ${security}`;
    els.security.innerHTML =
      security === 'secure'
        ? ICONS.lock
        : security === 'insecure'
          ? ICONS.warning
          : security === 'file'
            ? ICONS.file
            : ICONS.globe;
    els.security.title =
      security === 'secure'
        ? '安全连接（HTTPS）'
        : security === 'insecure'
          ? '不安全连接（HTTP）'
          : security === 'file'
            ? '本地文件'
            : '';

    if (!omniboxFocused) els.urlInput.value = url;

    const bookmarked = Boolean(url) && state.bookmarks.some((bookmark) => bookmark.url === url);
    els.star.disabled = !url;
    els.star.classList.toggle('bookmarked', bookmarked);
    els.star.title = bookmarked ? '取消收藏 (Ctrl+D)' : '收藏此页 (Ctrl+D)';
    els.star.setAttribute('aria-label', bookmarked ? '取消收藏' : '收藏此页');

    const zoom = tab && tab.zoom ? tab.zoom : 1;
    const showZoom = Math.abs(zoom - 1) > 0.001;
    els.zoom.classList.toggle('hidden', !showZoom);
    els.zoom.textContent = `${Math.round(zoom * 100)}%`;

    els.progress.classList.toggle('hidden', !(loading && url));
  }

  function renderDownloadsButton() {
    const downloads = state.downloads || [];
    const active = downloads.filter((item) => item.state === 'progressing');
    const paused = active.length > 0 && active.every((item) => item.paused);
    const currentIds = new Set(downloads.map((item) => item.id));
    const hasNew = downloads.some((item) => !previousDownloadIds.has(item.id));
    const finishedNow = previousActiveDownloads > 0 && active.length === 0 && downloads.length > 0;
    previousDownloadIds = currentIds;

    els.downloads.classList.toggle('hidden', downloads.length === 0);
    els.downloads.classList.toggle('downloading', active.length > 0);
    els.downloads.classList.toggle('paused', paused);

    let knownTotal = 0;
    let received = 0;
    for (const item of active) {
      if (item.total > 0) {
        knownTotal += item.total;
        received += Math.min(item.received, item.total);
      }
    }
    const ratio = knownTotal > 0 ? Math.min(1, received / knownTotal) : 0;
    if (els.ring) els.ring.style.strokeDashoffset = String(RING_LENGTH * (1 - ratio));

    if (active.length > 0) {
      els.downloadBadge.textContent = String(active.length);
      els.downloadBadge.classList.remove('hidden');
      els.downloads.classList.add('has-badge');
      els.downloads.title = paused
        ? `${active.length} 项下载已暂停`
        : `${active.length} 项下载进行中`;
    } else {
      els.downloadBadge.classList.add('hidden');
      els.downloads.classList.remove('has-badge');
      els.downloads.title = downloads.length ? '下载内容（已完成）' : '下载内容';
    }

    if (hasNew || finishedNow) {
      els.downloads.classList.remove('bump');
      void els.downloads.offsetWidth;
      els.downloads.classList.add('bump');
      clearTimeout(bumpTimer);
      bumpTimer = setTimeout(() => els.downloads.classList.remove('bump'), 500);
    }

    previousActiveDownloads = active.length;
  }

  function renderBookmarksBar() {
    const visible = Boolean(state.settings.bookmarksBar);
    els.bookmarksBar.classList.toggle('hidden', !visible);
    if (!visible) {
      bookmarksSignature = null;
      return;
    }

    const signature = JSON.stringify(
      state.bookmarks.map((bookmark) => [bookmark.id, bookmark.title, bookmark.url, bookmark.favicon || '']),
    );
    if (signature === bookmarksSignature) return;
    bookmarksSignature = signature;

    const fragment = document.createDocumentFragment();
    if (!state.bookmarks.length) {
      const hint = document.createElement('span');
      hint.className = 'bookmarks-empty';
      hint.textContent = '点击地址栏的 ☆ 收藏当前页面';
      fragment.appendChild(hint);
    } else {
      state.bookmarks.forEach((bookmark) => fragment.appendChild(buildBookmarkItem(bookmark)));
    }
    els.bookmarksBar.replaceChildren(fragment);
  }

  function buildSiteIcon(url, favicon, className) {
    const icon = document.createElement('span');
    icon.className = className;
    icon.textContent = letterForSeed(hostOf(url), '·');
    icon.style.background = colorFor(url);

    const source = favicon || defaultFaviconFor(url);
    if (source) {
      const img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('load', () => {
        icon.replaceChildren(img);
        icon.style.background = 'transparent';
      });
      img.addEventListener('error', () => {
        img.remove();
      });
      img.src = source;
    }
    return icon;
  }

  function buildBookmarkItem(bookmark) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bookmark';
    button.dataset.id = bookmark.id;
    button.dataset.url = bookmark.url;
    button.title = bookmark.title || bookmark.url;

    const icon = buildSiteIcon(bookmark.url, bookmark.favicon, 'bookmark-icon');

    const label = document.createElement('span');
    label.className = 'bookmark-title';
    label.textContent = bookmark.title || bookmark.url;

    button.append(icon, label);
    return button;
  }

  function renderRecent() {
    const items = state.history.filter((item) => /^https?:/i.test(item.url)).slice(0, 10);
    els.recentSection.classList.toggle('hidden', !items.length);
    if (!items.length) {
      els.recent.replaceChildren();
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'recent-item';
      btn.dataset.url = item.url;
      btn.title = item.url;
      btn.appendChild(buildSiteIcon(item.url, item.favicon, 'recent-icon'));
      const text = document.createElement('span');
      text.className = 'recent-text';
      const title = document.createElement('span');
      title.className = 'recent-title';
      title.textContent = item.title || hostOf(item.url) || item.url;
      const url = document.createElement('span');
      url.className = 'recent-url';
      url.textContent = hostOf(item.url) || item.url;
      text.append(title, url);
      btn.appendChild(text);
      fragment.appendChild(btn);
    }
    els.recent.replaceChildren(fragment);
  }

  function renderNewTab() {
    const tab = activeTab();
    const blank = !tab || !tab.url;
    els.newtab.classList.toggle('hidden', !blank);
    if (!blank) return;

    renderRecent();
    els.ntVersion.textContent = state.versions.app || '2.3.0';
    els.ntChrome.textContent = state.versions.chrome || '—';
    els.ntEngine.textContent = ENGINE_LABELS[state.settings.searchEngine] || 'Bing';
  }

  function renderWindowState() {
    document.body.classList.toggle('maximized', Boolean(state.window.maximized));
    els.maximizeBtn.innerHTML = state.window.maximized ? ICONS.restore : ICONS.maximize;
    els.maximizeBtn.title = state.window.maximized ? '还原' : '最大化';
    els.maximizeBtn.setAttribute('aria-label', state.window.maximized ? '还原' : '最大化');
  }

  function renderError() {
    const tab = activeTab();
    const error = tab && tab.error;
    if (!error) dismissedErrorKey = '';
    const key = error ? `${tab.id}|${tab.url}|${error.code}|${error.description}` : '';
    const show = Boolean(error) && key !== dismissedErrorKey;
    els.errorbar.classList.toggle('hidden', !show);
    if (show) els.errorText.textContent = error.description || '无法加载此页面';
    reportChromeHeightSoon();
  }

  function applyState(next) {
    if (!next) return;
    const previousActive = state.activeTabId;
    state.tabs = Array.isArray(next.tabs) ? next.tabs : [];
    state.activeTabId = next.activeTabId;
    state.bookmarks = Array.isArray(next.bookmarks) ? next.bookmarks : [];
    state.settings = { ...state.settings, ...(next.settings || {}) };
    state.history = Array.isArray(next.history) ? next.history : [];
    state.downloads = Array.isArray(next.downloads) ? next.downloads : [];
    state.window = next.window || state.window;
    state.platform = next.platform || state.platform;
    state.versions = next.versions || state.versions;
    state.incognito = Boolean(next.incognito);

    const themeDark = Boolean(next.theme && next.theme.dark);
    document.documentElement.dataset.theme = themeDark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = themeDark ? 'dark' : 'light';
    document.body.classList.toggle('vertical-tabs', Boolean(state.settings.verticalTabs));
    document.body.classList.toggle('incognito', state.incognito);
    els.incognitoBadge.classList.toggle('hidden', !state.incognito);

    const activeChanged = previousActive !== state.activeTabId;
    if (activeChanged && findOpen) closeFindUi();
    if (activeChanged && omniboxFocused) {
      const tab = activeTab();
      els.urlInput.value = tab ? tab.url || '' : '';
      els.urlInput.select();
    }

    renderTabs();
    renderToolbar();
    renderBookmarksBar();
    renderNewTab();
    renderDownloadsButton();
    renderWindowState();
    renderError();
    reportChromeHeightSoon();
  }

  /* ------------------------------------------------------------------ */
  /* 查找                                                                */
  /* ------------------------------------------------------------------ */

  function openFind() {
    findOpen = true;
    els.findbar.classList.remove('hidden');
    els.findInput.focus();
    els.findInput.select();
    reportChromeHeightSoon();
  }

  function closeFindUi() {
    if (!findOpen) return;
    findOpen = false;
    findText = '';
    els.findbar.classList.add('hidden');
    els.findInput.value = '';
    els.findCount.textContent = '';
    reportChromeHeightSoon();
  }

  function closeFind() {
    if (!findOpen) return;
    closeFindUi();
    api.find.stop();
  }

  function updateFindResult(result) {
    if (!findOpen || !result) return;
    if (!result.matches) els.findCount.textContent = '无结果';
    else els.findCount.textContent = `${result.active}/${result.matches}`;
  }

  /* ------------------------------------------------------------------ */
  /* 事件                                                                */
  /* ------------------------------------------------------------------ */

  function wireEvents() {
    $('#new-tab').addEventListener('click', () => api.tabs.create());

    $$('[data-window]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.window;
        if (action === 'minimize') api.window.minimize();
        else if (action === 'maximize') api.window.toggleMaximize();
        else if (action === 'close') api.window.close();
      });
    });

    $('#tabstrip').addEventListener('dblclick', (event) => {
      if (!event.target.closest('.tab, button')) api.window.toggleMaximize();
    });

    els.tabs.addEventListener('pointerdown', onTabPointerDown);

    els.tabs.addEventListener('click', (event) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const tabEl = event.target.closest('.tab');
      if (!tabEl) return;
      const id = Number(tabEl.dataset.id);
      if (event.target.closest('.tab-close')) closeTabWithAnimation(id);
      else api.tabs.select(id);
    });

    els.tabs.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      const tabEl = event.target.closest('.tab');
      if (!tabEl) return;
      event.preventDefault();
      closeTabWithAnimation(Number(tabEl.dataset.id));
    });

    els.tabs.addEventListener('contextmenu', (event) => {
      const tabEl = event.target.closest('.tab');
      if (!tabEl) return;
      event.preventDefault();
      api.tabs.menu(Number(tabEl.dataset.id), event.clientX, event.clientY);
    });

    els.tabs.addEventListener('dblclick', (event) => {
      const tabEl = event.target.closest('.tab');
      if (!tabEl || event.target.closest('.tab-close')) return;
      event.preventDefault();
      closeTabWithAnimation(Number(tabEl.dataset.id));
    });

    els.back.addEventListener('click', () => api.tabs.back(state.activeTabId));
    els.forward.addEventListener('click', () => api.tabs.forward(state.activeTabId));
    els.home.addEventListener('click', () => api.tabs.home());
    els.reload.addEventListener('click', () => {
      const tab = activeTab();
      if (tab && tab.isLoading) api.tabs.stop(tab.id);
      else api.tabs.reload(tab ? tab.id : undefined);
    });

    els.omnibox.addEventListener('submit', (event) => {
      event.preventDefault();
      navigateFromUi(els.urlInput.value);
      els.urlInput.blur();
    });

    els.urlInput.addEventListener('focus', () => {
      omniboxFocused = true;
      els.omnibox.classList.add('focused');
      const tab = activeTab();
      els.urlInput.value = tab ? tab.url || '' : '';
      els.urlInput.select();
    });

    els.urlInput.addEventListener('blur', () => {
      omniboxFocused = false;
      els.omnibox.classList.remove('focused');
      renderToolbar();
    });

    els.urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        const tab = activeTab();
        els.urlInput.value = tab ? tab.url || '' : '';
        els.urlInput.blur();
        if (tab && tab.isLoading) api.tabs.stop(tab.id);
      }
    });

    els.star.addEventListener('click', () => {
      const tab = activeTab();
      if (tab && tab.url) api.bookmarks.toggle(tab.url, tab.title, tab.favicon || '');
    });

    els.zoom.addEventListener('click', () => {
      const tab = activeTab();
      if (tab) api.tabs.resetZoom(tab.id);
    });

    els.downloads.addEventListener('click', () => api.downloads.panel());
    els.menu.addEventListener('click', () => api.menu.app());

    els.bookmarksBar.addEventListener('click', (event) => {
      const bookmark = event.target.closest('.bookmark');
      if (!bookmark || !bookmark.dataset.url) return;
      navigateFromUi(bookmark.dataset.url);
    });

    els.bookmarksBar.addEventListener('contextmenu', (event) => {
      const bookmark = event.target.closest('.bookmark');
      if (!bookmark) return;
      event.preventDefault();
      api.bookmarks.menu(bookmark.dataset.id, event.clientX, event.clientY);
    });

    els.recent.addEventListener('contextmenu', (event) => {
      const item = event.target.closest('.recent-item');
      if (!item || !item.dataset.url) return;
      event.preventDefault();
      api.history.menu(item.dataset.url, event.clientX, event.clientY);
    });

    els.clearHistory.addEventListener('click', () => api.history.clear());

    els.newtabSearch.addEventListener('submit', (event) => {
      event.preventDefault();
      navigateFromUi(els.newtabInput.value);
      els.newtabInput.blur();
    });

    els.newtab.addEventListener('click', (event) => {
      const target = event.target.closest('[data-url]');
      if (!target || !target.dataset.url) return;
      navigateFromUi(target.dataset.url);
    });

    els.findInput.addEventListener('input', () => {
      findText = els.findInput.value;
      if (!findText) {
        els.findCount.textContent = '';
        api.find.start('');
        return;
      }
      api.find.start(findText);
    });

    els.findInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        api.find.next(!event.shiftKey);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeFind();
      }
    });

    els.findPrev.addEventListener('click', () => api.find.next(false));
    els.findNext.addEventListener('click', () => api.find.next(true));
    els.findClose.addEventListener('click', () => closeFind());

    els.errorRetry.addEventListener('click', () => {
      const tab = activeTab();
      if (tab) api.tabs.reload(tab.id, true);
    });

    els.errorDismiss.addEventListener('click', () => {
      const tab = activeTab();
      if (tab && tab.error) {
        dismissedErrorKey = `${tab.id}|${tab.url}|${tab.error.code}|${tab.error.description}`;
      }
      els.errorbar.classList.add('hidden');
      reportChromeHeightSoon();
    });

    api.onState(applyState);
    api.onFocusOmnibox(() => {
      els.urlInput.focus();
      els.urlInput.select();
    });
    api.onFindOpen(() => openFind());
    api.onFindClose(() => closeFindUi());
    api.onFindResult((result) => updateFindResult(result));

    const observer = new ResizeObserver(() => reportLayoutMetrics());
    observer.observe(els.chrome);
    observer.observe(els.chromeMain);
    observer.observe(els.tabstrip);

    const tabObserver = new ResizeObserver(() => scheduleTabDensity());
    tabObserver.observe(els.tabs);
    window.addEventListener('resize', scheduleTabDensity);
  }

  async function bootstrap() {
    document.body.dataset.platform = navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32';
    wireEvents();
    try {
      const initial = await api.hydrate();
      applyState(initial);
    } catch (error) {
      console.error('[app] 初始化失败:', error && (error.stack || error.message || error));
    }
    reportLayoutMetrics();
    document.body.dataset.ready = 'true';
  }

  bootstrap();
})();
