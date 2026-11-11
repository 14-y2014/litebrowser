'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const {
  BaseWindow,
  WebContentsView,
  app,
  clipboard,
  dialog,
  nativeTheme,
  screen,
  session,
  shell,
} = require('electron');

const {
  APP_NAME,
  APP_ID,
  APP_VERSION,
  PARTITION,
  isNavigableUrl,
  normalizeInput,
  displayHost,
} = require('./config');
const { buildAppMenu, buildPageMenu } = require('./menus');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');
const APP_ICON = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(__dirname, '..', '..', 'build', 'icon.ico');

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const DEBUG = process.env.LITE_DEBUG === '1';
const debug = (...args) => {
  if (DEBUG) console.log('[litebrowser]', ...args);
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isOnScreen(bounds) {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  return screen.getAllDisplays().some(({ workArea }) => {
    return (
      bounds.x + bounds.width > workArea.x + 40 &&
      bounds.x < workArea.x + workArea.width - 40 &&
      bounds.y + 30 > workArea.y &&
      bounds.y < workArea.y + workArea.height - 20
    );
  });
}

function uniqueFilePath(dir, filename) {
  const parsed = path.parse(filename);
  let candidate = path.join(dir, filename);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

function friendlyError(code, description) {
  switch (code) {
    case -105:
      return '找不到服务器，请检查网址或网络连接。';
    case -106:
      return '网络已断开，请检查网络连接后重试。';
    case -102:
      return '连接被拒绝，目标服务器没有响应。';
    case -118:
    case -7:
      return '连接超时，请稍后重试。';
    case -202:
    case -200:
      return '网站的安全证书有问题，无法安全访问。';
    case -501:
      return '页面使用了不安全的加密方式，已被阻止。';
    default:
      return description ? `无法加载此页面（${description}）` : '无法加载此页面。';
  }
}

class LiteWindow {
  constructor(store, overlay, options = {}) {
    this.store = store;
    this.overlay = overlay || null;
    this.incognito = Boolean(options.incognito);
    this.partition = options.partition || PARTITION;
    this.onNewIncognito = options.onNewIncognito || null;
    this.onClosed = options.onClosed || null;
    this.onFocus = options.onFocus || null;
    this.win = null;
    this.chrome = null;
    this.tabs = [];
    this.activeId = null;
    this.tabSeq = 0;
    this.chromeHeight = 118;
    this.layoutVertical = Boolean(store.data.settings.verticalTabs);
    this.layoutTop = this.layoutVertical ? 122 : this.chromeHeight;
    this.layoutLeft = this.layoutVertical ? 220 : 0;
    this.normalBounds = null;
    this.boundsTimer = null;
    this.sessionSaveTimer = null;
    this.broadcastTimer = null;
    this.closedTabs = [];
    this.downloads = [];
    this.downloadSeq = 0;
    this.lastDownloadBroadcast = 0;
    this.findActive = false;
    this.findText = '';
    this.pendingDownload = null;
    this._destroyed = false;
  }

  themeInfo() {
    return {
      source: this.store.data.settings.theme,
      dark: nativeTheme.shouldUseDarkColors,
    };
  }

  windowBackground() {
    return nativeTheme.shouldUseDarkColors ? '#1b1c1f' : '#f4f5f7';
  }

  applyWindowTheme() {
    if (!this.win || this.win.isDestroyed()) return;
    const background = this.windowBackground();
    try {
      this.win.setBackgroundColor(background);
    } catch {
      /* ignore */
    }
    if (this.chrome) this.chrome.setBackgroundColor(background);
  }

  applyTaskbarIdentity() {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      this.win.setIcon(APP_ICON);
    } catch (error) {
      debug('setIcon failed', error.message);
    }
  }

  onThemeUpdated() {
    this.applyWindowTheme();
    this.broadcast();
    if (this.overlay && this.overlay.isVisible()) {
      this.overlay.updateTheme(this.themeInfo());
    }
  }

  /* ------------------------------------------------------------------ */
  /* 窗口与视图                                                          */
  /* ------------------------------------------------------------------ */

  create() {
    const saved = this.store.data.window;
    const width = clamp(saved.width || 1280, 960, 10000);
    const height = clamp(saved.height || 820, 600, 10000);
    const useSavedPosition = isOnScreen({ x: saved.x, y: saved.y, width, height });
    const options = {
      width,
      height,
      minWidth: 900,
      minHeight: 560,
      frame: false,
      show: false,
      title: this.incognito ? `${APP_NAME}（无痕）` : APP_NAME,
      backgroundColor: this.windowBackground(),
      icon: APP_ICON,
    };
    if (useSavedPosition) {
      options.x = saved.x;
      options.y = saved.y;
    }

    const win = new BaseWindow(options);
    try {
      win.setIcon(APP_ICON);
    } catch (error) {
      debug('setIcon failed', error.message);
    }
    this.win = win;

    if (!useSavedPosition) {
      const { workArea } = screen.getPrimaryDisplay();
      win.setBounds({
        x: Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2)),
        y: Math.round(workArea.y + Math.max(0, (workArea.height - height) / 2)),
        width,
        height,
      });
    }

    const chrome = new WebContentsView({
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: false,
      },
    });
    chrome.setBackgroundColor(this.windowBackground());
    win.contentView.addChildView(chrome);
    this.chrome = chrome;

    const chromeWc = chrome.webContents;
    chromeWc.on('did-finish-load', () => {
      this.broadcast();
      if (!win.isDestroyed() && !win.isVisible()) win.show();
      this.applyTaskbarIdentity();
      this.focusOmnibox();
    });
    chromeWc.on('did-fail-load', (_event, code, description) => {
      console.error(`[chrome] 界面加载失败: ${code} ${description}`);
    });
    chromeWc.on('render-process-gone', (_event, details) => {
      console.error('[chrome] 渲染进程退出:', details.reason);
      if (!win.isDestroyed() && details.reason !== 'clean-exit') {
        chromeWc.reload();
      }
    });
    chromeWc.setWindowOpenHandler(() => ({ action: 'deny' }));
    chromeWc.on('will-navigate', (event) => event.preventDefault());
    chromeWc.on('before-input-event', (event, input) => this.handleShortcut(event, input));

    chrome.webContents.loadFile(path.join(RENDERER_DIR, 'index.html'));

    win.on('focus', () => {
      if (this.onFocus) this.onFocus();
    });
    win.on('resize', () => {
      this.hideOverlay();
      this.layout();
      this.scheduleBoundsSave();
    });
    win.on('move', () => {
      this.hideOverlay();
      this.scheduleBoundsSave();
    });
    win.on('minimize', () => this.hideOverlay());
    win.on('maximize', () => {
      this.layout();
      this.broadcast();
    });
    win.on('unmaximize', () => {
      this.layout();
      this.broadcast();
    });
    win.on('enter-full-screen', () => {
      this.layout();
      this.broadcast();
    });
    win.on('leave-full-screen', () => {
      this.layout();
      this.broadcast();
    });
    win.on('close', () => {
      if (this.sessionSaveTimer) {
        clearTimeout(this.sessionSaveTimer);
        this.sessionSaveTimer = null;
      }
      this.persistSession();
      this.store.flush();
    });
    win.on('closed', () => {
      this._destroyed = true;
      this.win = null;
      this.chrome = null;
      this.tabs = [];
      if (this.sessionSaveTimer) {
        clearTimeout(this.sessionSaveTimer);
        this.sessionSaveTimer = null;
      }
      if (this.onClosed) this.onClosed();
    });

    if (saved.maximized) win.maximize();

    this.restoreSession();
  }

  restoreSession() {
    const settings = this.store.data.settings;
    const session = this.store.data.session;
    if (this.incognito || !settings.restoreTabs) {
      this.createTab('', { activate: true, focusOmnibox: false });
      return;
    }
    const restoredTabs = (session.tabs || []).filter(
      (tab) => tab && tab.entries && tab.entries.length,
    );
    debug('restoreSession', 'historyTabs', restoredTabs.length, 'urls', (session.urls || []).length);

    if (restoredTabs.length) {
      restoredTabs.forEach((spec) => this.createRestoredTab(spec));
      const index = clamp(session.activeIndex || 0, 0, this.tabs.length - 1);
      if (this.tabs[index]) this.selectTab(this.tabs[index].id, { focusPage: false });
      return;
    }

    const urls = settings.restoreTabs ? session.urls || [] : [];
    if (urls.length) {
      urls.forEach((url) => this.createTab(url, { activate: false }));
      const index = clamp(session.activeIndex || 0, 0, this.tabs.length - 1);
      this.selectTab(this.tabs[index].id, { focusPage: false });
    } else {
      this.createTab('', { activate: true, focusOmnibox: false });
    }
  }

  createRestoredTab(spec) {
    const tabId = this.createTab('', { activate: false, focusOmnibox: false });
    const tab = this.getTab(tabId);
    if (!tab || !spec.entries.length) return;
    const entries = spec.entries.map((entry) => ({
      url: entry.url,
      title: entry.title || '',
    }));
    const index = clamp(spec.index || 0, 0, entries.length - 1);
    tab.url = entries[index].url;
    tab.title = entries[index].title || displayHost(tab.url) || '正在加载…';
    this.ensureView(tab);
    try {
      tab.view.webContents.navigationHistory.restore({ entries, index });
    } catch (error) {
      console.error('[restore] 恢复标签历史失败:', error.message);
      this.loadUrl(tab, entries[index].url, { background: true });
    }
    this.layout();
    this.broadcast();
  }

  layout() {
    if (!this.win || this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    const blank = this.isBlankActive();
    const vertical = this.layoutVertical;
    const top = clamp(vertical ? this.layoutTop : this.chromeHeight, 40, height);
    const left = vertical ? clamp(this.layoutLeft, 0, Math.min(600, width - 100)) : 0;

    if (this.chrome) {
      const chromeHeight = vertical || blank ? height : Math.min(height, top);
      this.chrome.setBounds({ x: 0, y: 0, width, height: chromeHeight });
    }

    const activeTab = this.getTab(this.activeId);
    const devtoolsVisible = Boolean(
      !blank && activeTab && activeTab.view && activeTab.devToolsOpen && activeTab.devToolsView,
    );
    const availableWidth = Math.max(0, width - left);
    const devtoolsWidth = devtoolsVisible ? this.devToolsWidth(availableWidth) : 0;
    const pageWidth = Math.max(0, availableWidth - devtoolsWidth);
    const pageHeight = Math.max(0, height - top);

    for (const tab of this.tabs) {
      if (tab.view) {
        const active = tab.id === this.activeId && !blank;
        if (active) {
          tab.view.setBounds({ x: left, y: top, width: pageWidth, height: pageHeight });
        }
        tab.view.setVisible(active);
      }
      if (tab.devToolsView) {
        const visible = devtoolsVisible && tab === activeTab;
        if (visible) {
          tab.devToolsView.setBounds({
            x: left + pageWidth,
            y: top,
            width: devtoolsWidth,
            height: pageHeight,
          });
        }
        tab.devToolsView.setVisible(visible);
      }
    }
  }

  setLayoutMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return;
    const vertical = Boolean(metrics.vertical);
    const top = clamp(Math.round(Number(metrics.top) || 0), 40, 600);
    const left = vertical ? clamp(Math.round(Number(metrics.sidebar) || 0), 0, 600) : 0;
    this.layoutVertical = vertical;
    this.layoutTop = top;
    this.layoutLeft = left;
    if (!vertical) this.chromeHeight = top;
    this.layout();
  }

  pageTop() {
    return this.layoutVertical ? this.layoutTop : this.chromeHeight;
  }

  pageLeft() {
    return this.layoutVertical ? this.layoutLeft : 0;
  }

  devToolsWidth(width) {
    return Math.round(Math.min(640, Math.max(340, width * 0.36)));
  }

  setChromeHeight(height) {
    const next = clamp(Math.round(Number(height) || 0), 64, 400);
    if (next === this.chromeHeight) return;
    this.chromeHeight = next;
    this.layout();
  }

  isBlankActive() {
    const tab = this.getTab(this.activeId);
    return !tab || !tab.url;
  }

  /* ------------------------------------------------------------------ */
  /* 标签页                                                              */
  /* ------------------------------------------------------------------ */

  getTab(id) {
    return this.tabs.find((tab) => tab.id === id) || null;
  }

  createTab(url = '', options = {}) {
    const tab = {
      id: ++this.tabSeq,
      url: '',
      title: '新标签页',
      favicon: '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      zoom: 1,
      error: null,
      view: null,
      devToolsOpen: false,
      devToolsView: null,
    };
    this.tabs.push(tab);
    if (options.activate !== false) this.activeId = tab.id;
    if (url) {
      const normalized = isNavigableUrl(url) ? url : normalizeInput(url, this.store.data.settings);
      if (normalized) this.loadUrl(tab, normalized, { background: options.activate === false });
    }
    this.broadcast();
    this.layout();
    if (options.activate !== false && options.focusOmnibox !== false && !tab.url) {
      this.focusOmnibox();
    }
    this.scheduleSessionSave();
    return tab.id;
  }

  closeTab(id) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const tab = this.tabs[index];
    if (tab.url) {
      this.closedTabs.unshift({ url: tab.url, title: tab.title });
      this.closedTabs = this.closedTabs.slice(0, 12);
    }
    this.destroyTabView(tab);
    this.tabs.splice(index, 1);

    if (this.activeId === id) {
      const next = this.tabs[index] || this.tabs[index - 1];
      if (next) {
        this.selectTab(next.id, { focusPage: false });
      } else {
        this.activeId = null;
        this.createTab('', { activate: true, focusOmnibox: true });
        return;
      }
    }
    this.broadcast();
    this.layout();
    this.scheduleSessionSave();
  }

  closeActiveTab() {
    if (this.activeId != null) this.closeTab(this.activeId);
  }

  reopenClosedTab() {
    const entry = this.closedTabs.shift();
    if (!entry) return;
    this.createTab(entry.url, { activate: true });
  }

  selectTab(id, options = {}) {
    const tab = this.getTab(id);
    if (!tab) return;
    if (this.overlay) this.overlay.hide();
    const changed = this.activeId !== id;
    this.activeId = id;
    if (this.findActive && changed) this.closeFind();
    this.broadcast();
    this.layout();
    if (options.focusPage !== false) {
      if (tab.view) {
        if (this.win && !this.win.isDestroyed()) this.win.focus();
        tab.view.webContents.focus();
      } else if (options.focusOmnibox !== false) {
        this.focusOmnibox();
      }
    }
    this.scheduleSessionSave();
  }

  cycleTab(direction) {
    if (this.tabs.length < 2) return;
    const index = this.tabs.findIndex((tab) => tab.id === this.activeId);
    const next = (index + direction + this.tabs.length) % this.tabs.length;
    this.selectTab(this.tabs[next].id);
  }

  selectTabAt(index) {
    const tab = this.tabs[index];
    if (tab) this.selectTab(tab.id);
  }

  reorderTabs(ids) {
    if (!Array.isArray(ids)) return;
    const byId = new Map(this.tabs.map((tab) => [tab.id, tab]));
    const ordered = [];
    for (const id of ids) {
      const tab = byId.get(Number(id));
      if (tab && !ordered.includes(tab)) ordered.push(tab);
    }
    if (ordered.length !== this.tabs.length) return;
    this.tabs = ordered;
    this.broadcast();
    this.scheduleSessionSave();
  }

  ensureView(tab) {
    if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view;
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: true,
        safeDialogs: true,
        backgroundThrottling: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    if (this.win && !this.win.isDestroyed()) this.win.contentView.addChildView(view);
    tab.view = view;
    if (tab.zoom && tab.zoom !== 1) view.webContents.setZoomFactor(tab.zoom);
    this.wireTab(tab, view.webContents);
    return view;
  }

  wireTab(tab, wc) {
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (isNavigableUrl(url)) {
        this.createTab(url, { activate: disposition !== 'background-tab' });
      } else if (/^(mailto|tel|magnet):/i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    wc.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      if (isNavigableUrl(url)) {
        tab.url = url;
        tab.error = null;
        tab.favicon = '';
        tab.title = displayHost(url) || '正在加载…';
      }
      this.broadcast();
    });

    wc.on('did-navigate', (_event, url) => {
      tab.url = url;
      tab.error = null;
      this.refreshNav(tab);
      this.recordVisit(tab);
      this.broadcast();
      this.scheduleSessionSave();
    });

    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      this.refreshNav(tab);
      this.recordVisit(tab);
      this.broadcast();
      this.scheduleSessionSave();
    });

    wc.on('did-start-loading', () => {
      tab.isLoading = true;
      this.broadcast();
    });

    wc.on('did-stop-loading', () => {
      tab.isLoading = false;
      this.refreshNav(tab);
      this.broadcast();
    });

    wc.on('page-title-updated', (_event, title) => {
      if (title && title.trim()) {
        tab.title = title.trim();
        this.touchHistoryTitle(tab.url, tab.title);
        this.broadcast();
        this.scheduleSessionSave();
      }
    });

    wc.on('page-favicon-updated', (_event, favicons) => {
      if (Array.isArray(favicons) && favicons.length) {
        tab.favicon = favicons[favicons.length - 1];
        this.updateBookmarkFavicon(tab.url, tab.favicon);
        this.updateHistoryFavicon(tab.url, tab.favicon);
        this.broadcast();
      }
    });

    wc.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      tab.isLoading = false;
      tab.error = { code, description: friendlyError(code, description), url: validatedUrl };
      this.refreshNav(tab);
      this.broadcast();
    });

    wc.on('render-process-gone', (_event, details) => {
      tab.isLoading = false;
      tab.error = { code: 0, description: `页面进程意外退出（${details.reason}），请刷新重试。` };
      this.broadcast();
    });

    wc.on('context-menu', (_event, params) => {
      this.showPageContextMenu(tab, params);
    });

    wc.on('devtools-opened', () => {
      tab.devToolsOpen = true;
      this.layout();
      this.broadcast();
    });

    wc.on('devtools-closed', () => {
      if (!tab.devToolsOpen && !tab.devToolsView) return;
      tab.devToolsOpen = false;
      this.disposeDevToolsView(tab);
      this.layout();
      this.broadcast();
    });

    wc.on('found-in-page', (_event, result) => {
      this.send('find:result', {
        matches: result.matches,
        active: result.activeMatchOrdinal,
        final: result.finalUpdate,
      });
    });

    wc.on('before-input-event', (event, input) => this.handleShortcut(event, input));

    wc.on('will-navigate', (event, url) => {
      if (!isNavigableUrl(url) && !/^about:blank$/i.test(url)) {
        event.preventDefault();
        if (/^(mailto|tel|magnet|ms-settings):/i.test(url)) shell.openExternal(url).catch(() => {});
      }
    });

    wc.on('enter-html-full-screen', () => {
      if (this.win && !this.win.isDestroyed()) this.win.setFullScreen(true);
    });
    wc.on('leave-html-full-screen', () => {
      if (this.win && !this.win.isDestroyed()) this.win.setFullScreen(false);
    });
  }

  destroyTabView(tab) {
    this.disposeDevToolsView(tab);
    const view = tab.view;
    tab.view = null;
    if (!view) return;
    try {
      if (this.win && !this.win.isDestroyed()) this.win.contentView.removeChildView(view);
    } catch {
      /* 视图可能已随窗口销毁 */
    }
    const wc = view.webContents;
    if (wc && !wc.isDestroyed()) {
      try {
        wc.close();
      } catch {
        /* ignore */
      }
    }
  }

  wcOf(id) {
    const tab = this.getTab(id);
    if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return null;
    return tab.view.webContents;
  }

  refreshNav(tab) {
    const wc = this.wcOf(tab.id);
    if (!wc) {
      tab.canGoBack = false;
      tab.canGoForward = false;
      return;
    }
    const history = wc.navigationHistory;
    tab.canGoBack = history ? history.canGoBack() : false;
    tab.canGoForward = history ? history.canGoForward() : false;
  }

  /* ------------------------------------------------------------------ */
  /* 导航                                                                */
  /* ------------------------------------------------------------------ */

  loadUrl(tab, url, options = {}) {
    if (!tab || !url) return;
    debug('loadUrl', url, 'tab', tab.id);
    this.ensureView(tab);
    tab.url = url;
    tab.error = null;
    tab.title = displayHost(url) || '正在加载…';
    tab.favicon = '';
    this.broadcast();
    if (!options.background) this.layout();
    const wc = tab.view.webContents;
    wc.loadURL(url).catch((error) => {
      if (error && error.code === 'ERR_ABORTED') return;
      console.error('[page] 加载失败:', error && error.message);
    });
  }

  navigate(input, tabId = this.activeId) {
    const tab = this.getTab(tabId);
    if (!tab) return;
    const url = normalizeInput(input, this.store.data.settings);
    debug('navigate', JSON.stringify(input), '->', url, 'tab', tab.id);
    if (!url) return;
    if (tab.id !== this.activeId) this.selectTab(tab.id, { focusPage: false });
    this.loadUrl(tab, url);
  }

  back(tabId = this.activeId) {
    const wc = this.wcOf(tabId);
    if (!wc) return;
    const history = wc.navigationHistory;
    if (history ? history.canGoBack() : false) history.goBack();
  }

  forward(tabId = this.activeId) {
    const wc = this.wcOf(tabId);
    if (!wc) return;
    const history = wc.navigationHistory;
    if (history ? history.canGoForward() : false) history.goForward();
  }

  reload(tabId = this.activeId, ignoreCache = false) {
    const wc = this.wcOf(tabId);
    if (!wc) return;
    const tab = this.getTab(tabId);
    if (tab) tab.error = null;
    if (ignoreCache) wc.reloadIgnoringCache();
    else wc.reload();
    this.broadcast();
  }

  stop(tabId = this.activeId) {
    const wc = this.wcOf(tabId);
    if (wc) wc.stop();
    const tab = this.getTab(tabId);
    if (tab) {
      tab.isLoading = false;
      this.broadcast();
    }
  }

  goHome() {
    const tab = this.getTab(this.activeId);
    if (!tab) return;
    const homePage = this.store.data.settings.homePage;
    if (homePage) {
      this.navigate(homePage, tab.id);
    } else {
      this.resetToNewTab(tab);
    }
  }

  resetToNewTab(tab) {
    this.destroyTabView(tab);
    tab.url = '';
    tab.title = '新标签页';
    tab.favicon = '';
    tab.isLoading = false;
    tab.canGoBack = false;
    tab.canGoForward = false;
    tab.error = null;
    tab.zoom = 1;
    this.broadcast();
    this.layout();
    this.focusOmnibox();
    this.scheduleSessionSave();
  }

  /* ------------------------------------------------------------------ */
  /* 缩放 / 查找 / 开发者工具                                             */
  /* ------------------------------------------------------------------ */

  zoomBy(direction, tabId = this.activeId) {
    const tab = this.getTab(tabId);
    if (!tab || !tab.view) return;
    const current = tab.zoom || 1;
    let index = ZOOM_STEPS.findIndex((step) => step >= current - 0.001);
    if (index === -1) index = ZOOM_STEPS.length - 1;
    index = clamp(index + direction, 0, ZOOM_STEPS.length - 1);
    tab.zoom = ZOOM_STEPS[index];
    tab.view.webContents.setZoomFactor(tab.zoom);
    this.broadcast();
  }

  resetZoom(tabId = this.activeId) {
    const tab = this.getTab(tabId);
    if (!tab || !tab.view) return;
    tab.zoom = 1;
    tab.view.webContents.setZoomFactor(1);
    this.broadcast();
  }

  openFind() {
    if (this.findActive) {
      this.send('ui:find-open');
      return;
    }
    this.findActive = true;
    this.send('ui:find-open');
  }

  closeFind() {
    const wc = this.wcOf(this.activeId);
    if (wc) wc.stopFindInPage('clearSelection');
    this.findText = '';
    if (!this.findActive) return;
    this.findActive = false;
    this.send('ui:find-close');
  }

  toggleFind() {
    if (this.findActive) this.closeFind();
    else this.openFind();
  }

  findInPage(text, options = {}) {
    const wc = this.wcOf(this.activeId);
    if (!wc) return;
    const query = String(text || '');
    this.findText = query;
    if (!query) {
      wc.stopFindInPage('clearSelection');
      return;
    }
    wc.findInPage(query, {
      forward: options.forward !== false,
      findNext: !!options.findNext,
      matchCase: false,
    });
  }

  stopFind() {
    const wc = this.wcOf(this.activeId);
    if (wc) wc.stopFindInPage('clearSelection');
    this.findText = '';
  }

  toggleDevTools() {
    const tab = this.getTab(this.activeId);
    if (!tab || !tab.view) {
      this.focusOmnibox();
      return;
    }
    if (tab.devToolsOpen) this.closeDevTools(tab);
    else this.openDevTools(tab);
  }

  openDevTools(tab) {
    if (!tab || !tab.view) return;
    const pageWc = tab.view.webContents;
    if (pageWc.isDestroyed()) return;

    if (!tab.devToolsView || tab.devToolsView.webContents.isDestroyed()) {
      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      view.setBackgroundColor('#202124');
      if (this.win && !this.win.isDestroyed()) this.win.contentView.addChildView(view);
      tab.devToolsView = view;
      try {
        pageWc.setDevToolsWebContents(view.webContents);
      } catch (error) {
        console.error('[devtools] 设置容器失败:', error.message);
        this.disposeDevToolsView(tab);
        return;
      }
    }

    tab.devToolsOpen = true;
    try {
      pageWc.openDevTools({ mode: 'detach', activate: false });
    } catch (error) {
      console.error('[devtools] 打开失败:', error.message);
      tab.devToolsOpen = false;
      this.disposeDevToolsView(tab);
    }
    this.layout();
    this.broadcast();
  }

  closeDevTools(tab) {
    if (!tab) return;
    tab.devToolsOpen = false;
    const pageWc = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
    if (pageWc) {
      try {
        pageWc.closeDevTools();
      } catch {
        /* 渲染进程可能已退出 */
      }
    }
    this.disposeDevToolsView(tab);
    this.layout();
    this.broadcast();
  }

  disposeDevToolsView(tab) {
    const view = tab.devToolsView;
    tab.devToolsView = null;
    if (!view) return;
    try {
      if (this.win && !this.win.isDestroyed()) this.win.contentView.removeChildView(view);
    } catch {
      /* 窗口可能已销毁 */
    }
    if (view.webContents && !view.webContents.isDestroyed()) {
      try {
        view.webContents.close();
      } catch {
        /* ignore */
      }
    }
  }

  inspectElementInTab(tab, x, y) {
    if (!tab || !tab.view) return;
    const wc = tab.view.webContents;
    this.openDevTools(tab);
    const inspect = () => {
      if (!wc.isDestroyed()) {
        try {
          wc.inspectElement(x, y);
        } catch {
          /* ignore */
        }
      }
    };
    if (wc.isDevToolsOpened()) {
      inspect();
    } else {
      wc.once('devtools-opened', () => setTimeout(inspect, 180));
      setTimeout(inspect, 900);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 自绘菜单                                                            */
  /* ------------------------------------------------------------------ */

  showPageContextMenu(tab, params) {
    if (!this.overlay || !this.win) return;
    const menu = buildPageMenu(this, tab, params);
    if (!menu.items.length) return;
    const bounds = this.win.getContentBounds();
    const x = bounds.x + this.pageLeft() + Math.round(params.x);
    const y = bounds.y + this.pageTop() + Math.round(params.y);
    this.overlay.owner = this;
    this.overlay.showMenu({
      items: menu.items,
      theme: this.themeInfo(),
      x,
      y,
      onAction: (id) => {
        const action = menu.actions.get(id);
        if (action) action();
      },
      onHide: () => this.focusActiveContent(),
    });
  }

  showBookmarkMenu(bookmark, clientX, clientY) {
    if (!this.overlay || !this.win || !bookmark) return;
    this.overlay.owner = this;
    const bounds = this.win.getContentBounds();
    const items = [
      { id: 'open', label: '打开书签', accelerator: 'Enter' },
      { id: 'open-new', label: '在新标签页中打开' },
      { id: 'copy', label: '复制链接地址', accelerator: 'Ctrl+C' },
      { type: 'separator' },
      { id: 'delete', label: '删除书签', danger: true, accelerator: 'Del' },
    ];
    this.overlay.showMenu({
      items,
      theme: this.themeInfo(),
      x: bounds.x + Math.round(clientX),
      y: bounds.y + Math.round(clientY),
      onAction: (id) => {
        if (id === 'open') {
          this.navigate(bookmark.url);
        } else if (id === 'open-new') {
          this.createTab(bookmark.url);
        } else if (id === 'copy') {
          clipboard.writeText(bookmark.url);
        } else if (id === 'delete') {
          this.removeBookmark(bookmark.id);
        }
      },
      onHide: () => this.focusActiveContent(),
    });
  }

  showTabMenu(tab, clientX, clientY) {
    if (!this.overlay || !this.win || !tab) return;
    this.overlay.owner = this;
    const bounds = this.win.getContentBounds();
    const items = [
      { id: 'new', label: '新建标签页', accelerator: 'Ctrl+T' },
      { id: 'reload', label: '重新加载', enabled: Boolean(tab.url), accelerator: 'Ctrl+R' },
      { id: 'duplicate', label: '复制标签页', enabled: Boolean(tab.url) },
      { id: 'copy-url', label: '复制网址', enabled: Boolean(tab.url), accelerator: 'Ctrl+C' },
      { type: 'separator' },
      { id: 'close', label: '关闭标签页', accelerator: 'Ctrl+W' },
      { id: 'close-others', label: '关闭其他标签页', enabled: this.tabs.length > 1 },
    ];
    this.overlay.showMenu({
      items,
      theme: this.themeInfo(),
      x: bounds.x + Math.round(clientX),
      y: bounds.y + Math.round(clientY),
      onAction: (id) => {
        if (id === 'new') this.createTab('');
        else if (id === 'reload') this.reload(tab.id, true);
        else if (id === 'duplicate') this.createTab(tab.url);
        else if (id === 'copy-url') clipboard.writeText(tab.url);
        else if (id === 'close') this.closeTab(tab.id);
        else if (id === 'close-others') this.closeOtherTabs(tab.id);
      },
      onHide: () => this.focusActiveContent(),
    });
  }

  closeOtherTabs(keepId) {
    const keep = this.getTab(keepId);
    if (!keep) return;
    for (const tab of [...this.tabs]) {
      if (tab.id !== keepId) this.closeTab(tab.id);
    }
    this.selectTab(keepId);
  }

  /* ------------------------------------------------------------------ */
  /* 下载气泡                                                            */
  /* ------------------------------------------------------------------ */

  downloadsPayload() {
    return this.downloads.map((item) => ({
      id: item.id,
      filename: item.filename,
      path: item.path,
      url: item.url || '',
      state: item.state,
      received: item.received,
      total: item.total,
      speed: item.speed || 0,
      paused: !!item.paused,
      icon: item.icon || '',
    }));
  }

  showDownloadsBubble() {
    if (!this.overlay || !this.win) return;
    debug('showDownloadsBubble');
    const bounds = this.win.getContentBounds();
    this.overlay.owner = this;
    this.overlay.showDownloads({
      downloads: this.downloadsPayload(),
      theme: this.themeInfo(),
      right: bounds.x + bounds.width - 10,
      y: bounds.y + this.pageTop() + 4,
      onAction: (id) => {
        if (id === 'open-folder') this.openDownloadsFolder();
        else if (id === 'clear') this.clearDownloads();
        else if (id.startsWith('pause:')) this.pauseDownload(id.slice(6));
        else if (id.startsWith('resume:')) this.resumeDownload(id.slice(7));
        else if (id.startsWith('open:')) this.openDownload(id.slice(5));
      },
      onHide: () => this.focusActiveContent(),
    });
  }

  clearDownloads() {
    this.downloads = this.downloads.filter(
      (item) => item.state === 'progressing' || item.state === 'paused',
    );
    this.broadcast();
    if (this.overlay && this.overlay.mode === 'downloads') {
      this.overlay.updateDownloads(this.downloadsPayload());
    }
  }

  focusActiveContent() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.focus();
    const tab = this.getTab(this.activeId);
    if (tab && tab.view && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.focus();
    } else {
      this.focusOmnibox();
    }
  }

  hideOverlay() {
    if (this.overlay && this.overlay.isVisible()) this.overlay.hide();
  }

  openUserDataFolder() {
    if (this.incognito || !this.store.file) return;
    shell.openPath(path.dirname(this.store.file));
  }

  /* ------------------------------------------------------------------ */
  /* 设置 / 书签 / 历史                                                   */
  /* ------------------------------------------------------------------ */

  setSetting(key, value) {
    const settings = this.store.data.settings;
    if (!(key in settings)) return;
    if (key === 'searchEngine') {
      const { SEARCH_ENGINE_IDS } = require('./config');
      if (!SEARCH_ENGINE_IDS.includes(value)) return;
    } else if (key === 'homePage') {
      const text = String(value || '').trim();
      settings.homePage = text && isNavigableUrl(text) ? text : '';
      this.store.touch();
      this.broadcast();
      return;
    } else if (key === 'theme') {
      if (!['system', 'light', 'dark'].includes(value)) return;
      settings.theme = value;
      nativeTheme.themeSource = value;
      this.applyWindowTheme();
      this.store.touch();
      this.broadcast();
      if (this.overlay && this.overlay.isVisible()) this.overlay.updateTheme(this.themeInfo());
      return;
    } else if (key === 'downloadDir') {
      const text = String(value || '').trim();
      settings.downloadDir = text && path.isAbsolute(text) ? text : '';
      this.store.touch();
      this.broadcast();
      return;
    } else if (key === 'verticalTabs') {
      settings.verticalTabs = !!value;
      this.layoutVertical = settings.verticalTabs;
      this.layoutLeft = settings.verticalTabs ? 220 : 0;
      if (settings.verticalTabs && !this.layoutTop) this.layoutTop = 122;
      this.store.touch();
      this.broadcast();
      this.layout();
      return;
    } else {
      value = !!value;
    }
    settings[key] = value;
    this.store.touch();
    this.broadcast();
  }

  async chooseDownloadDir() {
    const result = await dialog.showOpenDialog({
      title: '选择下载文件夹',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: this.downloadFolder(),
    });
    if (result.canceled || !result.filePaths.length) return;
    this.setSetting('downloadDir', result.filePaths[0]);
  }

  downloadFolder() {
    const configured = this.store.data.settings.downloadDir;
    if (configured) {
      try {
        fs.mkdirSync(configured, { recursive: true });
        return configured;
      } catch {
        /* 回退到系统下载目录 */
      }
    }
    return app.getPath('downloads');
  }

  toggleBookmark(url, title, favicon = '') {
    const bookmarks = this.store.data.bookmarks;
    const existing = bookmarks.findIndex((bm) => bm.url === url);
    if (existing !== -1) {
      bookmarks.splice(existing, 1);
    } else if (url && isNavigableUrl(url)) {
      bookmarks.unshift({
        id: `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        url,
        title: (title || displayHost(url) || url).slice(0, 300),
        favicon:
          typeof favicon === 'string' && /^(https?|data|file):/i.test(favicon)
            ? favicon.slice(0, 4000)
            : '',
        createdAt: Date.now(),
      });
      if (bookmarks.length > 500) bookmarks.length = 500;
    }
    this.store.touch();
    this.broadcast();
    return bookmarks.some((bm) => bm.url === url);
  }

  updateBookmarkFavicon(url, favicon) {
    if (!url || typeof favicon !== 'string' || !favicon) return;
    const bookmark = this.store.data.bookmarks.find((bm) => bm.url === url);
    if (!bookmark || bookmark.favicon === favicon) return;
    bookmark.favicon = favicon.slice(0, 4000);
    this.store.touch();
  }

  removeBookmark(id) {
    const bookmarks = this.store.data.bookmarks;
    const index = bookmarks.findIndex((bm) => bm.id === id);
    if (index === -1) return;
    bookmarks.splice(index, 1);
    this.store.touch();
    this.broadcast();
  }

  recordVisit(tab) {
    if (this.incognito) return;
    if (!tab.url || !/^https?:/i.test(tab.url)) return;
    const history = this.store.data.history;
    const existing = history.findIndex((item) => item.url === tab.url);
    if (existing !== -1) history.splice(existing, 1);
    history.unshift({
      url: tab.url,
      title: tab.title || '',
      favicon: tab.favicon || '',
      time: Date.now(),
    });
    if (history.length > 300) history.length = 300;
    this.store.touch();
  }

  updateHistoryFavicon(url, favicon) {
    if (!url || typeof favicon !== 'string' || !favicon) return;
    const entry = this.store.data.history.find((item) => item.url === url);
    if (!entry || entry.favicon === favicon) return;
    entry.favicon = favicon.slice(0, 4000);
    this.store.touch();
  }

  removeHistoryEntry(url) {
    const history = this.store.data.history;
    const next = history.filter((item) => item.url !== url);
    if (next.length === history.length) return;
    this.store.data.history = next;
    this.store.touch();
    this.broadcast();
  }

  showHistoryMenu(entry, clientX, clientY) {
    if (!this.overlay || !this.win || !entry) return;
    this.overlay.owner = this;
    const bounds = this.win.getContentBounds();
    const items = [
      { id: 'open', label: '打开', accelerator: 'Enter' },
      { id: 'open-new', label: '在新标签页中打开' },
      { id: 'copy', label: '复制链接地址', accelerator: 'Ctrl+C' },
      { type: 'separator' },
      { id: 'delete', label: '删除这条记录', danger: true, accelerator: 'Del' },
    ];
    this.overlay.showMenu({
      items,
      theme: this.themeInfo(),
      x: bounds.x + Math.round(clientX),
      y: bounds.y + Math.round(clientY),
      onAction: (id) => {
        if (id === 'open') this.navigate(entry.url);
        else if (id === 'open-new') this.createTab(entry.url);
        else if (id === 'copy') clipboard.writeText(entry.url);
        else if (id === 'delete') this.removeHistoryEntry(entry.url);
      },
      onHide: () => this.focusActiveContent(),
    });
  }

  touchHistoryTitle(url, title) {
    const entry = this.store.data.history.find((item) => item.url === url);
    if (!entry) return;
    if (entry.title === title) return;
    entry.title = title;
    this.store.touch();
  }

  clearHistory() {
    this.store.data.history = [];
    this.store.touch();
    this.broadcast();
  }

  async clearCookiesAndHistory() {
    const result = await dialog.showMessageBox(this.win, {
      type: 'warning',
      title: '清空 Cookie 和浏览记录',
      message: '确定要清空所有 Cookie 和浏览记录吗？',
      detail: '书签和已下载的文件不会受影响。',
      buttons: ['取消', '清空'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return;

    try {
      const pageSession = session.fromPartition(this.partition);
      await pageSession.clearStorageData({
        storages: [
          'cookies',
          'localstorage',
          'indexdb',
          'websql',
          'serviceworkers',
          'cachestorage',
        ],
      });
      await pageSession.clearCache();
    } catch (error) {
      console.error('[privacy] 清理 Cookie/缓存失败:', error && error.message);
    }

    this.store.data.history = [];
    this.store.touch();
    this.broadcast();
  }

  /* ------------------------------------------------------------------ */
  /* 下载                                                                */
  /* ------------------------------------------------------------------ */

  handleDownload(item) {
    const dir = this.downloadFolder();
    const filename = item.getFilename() || 'download';
    let filePath = path.join(dir, filename);

    const pending = this.pendingDownload;
    this.pendingDownload = null;
    if (pending && pending.url === item.getURL() && pending.path) {
      filePath = pending.path;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      } catch {
        /* ignore */
      }
    } else {
      try {
        filePath = uniqueFilePath(dir, filename);
      } catch {
        /* 使用默认保存位置 */
      }
    }
    try {
      item.setSavePath(filePath);
    } catch {
      /* ignore */
    }

    const record = {
      id: `dl-${++this.downloadSeq}`,
      filename: path.basename(filePath),
      path: filePath,
      url: item.getURL(),
      state: 'progressing',
      received: 0,
      total: item.getTotalBytes(),
      speed: 0,
      paused: false,
      item,
      icon: '',
      startedAt: Date.now(),
    };
    this.downloads.unshift(record);
    this.downloads = this.downloads.slice(0, 20);
    this.loadDownloadIcon(record);

    let lastTick = Date.now();
    let lastBytes = 0;

    const update = () => {
      const now = Date.now();
      const bytes = item.getReceivedBytes();
      const elapsed = now - lastTick;
      if (elapsed > 120) {
        record.speed = Math.max(0, Math.round(((bytes - lastBytes) / elapsed) * 1000));
        lastTick = now;
        lastBytes = bytes;
      }
      record.received = bytes;
      const total = item.getTotalBytes();
      if (total > 0) record.total = total;
      if (!item.isPaused()) record.paused = false;
      const nowBroadcast = Date.now();
      if (nowBroadcast - this.lastDownloadBroadcast < 250) return;
      this.lastDownloadBroadcast = nowBroadcast;
      this.broadcast();
    };

    item.on('updated', (_event, state) => {
      record.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      update();
    });

    item.once('done', (_event, state) => {
      record.state = state;
      record.received = item.getReceivedBytes();
      record.speed = 0;
      record.paused = false;
      record.item = null;
      this.broadcast();
      this.loadDownloadIcon(record);
    });

    this.broadcast();
  }

  /** 读取 Windows 为该文件分配的图标（与资源管理器一致），失败时界面用文档图标兜底 */
  async loadDownloadIcon(record) {
    if (!record || !record.path) return;
    try {
      const image = await app.getFileIcon(record.path, { size: 'normal' });
      if (!image || image.isEmpty()) return;
      record.icon = image.toDataURL();
      if (this.downloads.includes(record)) this.broadcast();
    } catch {
      /* 文件尚未落盘或系统无法读取图标时保持兜底图标 */
    }
  }

  findDownload(id) {
    return this.downloads.find((record) => record.id === id) || null;
  }

  openDownload(id) {
    const record = this.findDownload(id);
    if (!record) return;
    if (record.state !== 'completed') return;
    if (fs.existsSync(record.path)) shell.openPath(record.path);
  }

  openDownloadsFolder() {
    shell.openPath(this.downloadFolder());
  }

  pauseDownload(id) {
    const record = this.findDownload(id);
    if (!record || !record.item) return;
    try {
      record.item.pause();
      record.paused = true;
      record.speed = 0;
    } catch {
      /* ignore */
    }
    this.broadcast();
  }

  resumeDownload(id) {
    const record = this.findDownload(id);
    if (!record || !record.item) return;
    try {
      record.item.resume();
      record.paused = false;
    } catch {
      /* ignore */
    }
    this.broadcast();
  }

  removeDownloadFromList(id) {
    const record = this.findDownload(id);
    if (!record) return;
    this.downloads = this.downloads.filter((item) => item.id !== id);
    this.broadcast();
  }

  cancelAndDeleteDownload(id) {
    const record = this.findDownload(id);
    if (!record) return;
    const filePath = record.path;
    if (record.item) {
      try {
        record.item.cancel();
      } catch {
        /* ignore */
      }
      record.item = null;
    }
    this.downloads = this.downloads.filter((item) => item.id !== id);
    this.broadcast();
    setTimeout(() => {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* 文件可能尚未释放 */
      }
    }, 600);
  }

  deleteDownloadFile(id) {
    const record = this.findDownload(id);
    if (!record) return;
    try {
      fs.rmSync(record.path, { force: true });
    } catch {
      /* ignore */
    }
    this.downloads = this.downloads.filter((item) => item.id !== id);
    this.broadcast();
  }

  revealDownload(id) {
    const record = this.findDownload(id);
    if (!record) return;
    if (fs.existsSync(record.path)) shell.showItemInFolder(record.path);
    else this.openDownloadsFolder();
  }

  triggerDownload(url) {
    const tab = this.tabs.find(
      (item) => item.view && !item.view.webContents.isDestroyed(),
    );
    if (tab) {
      tab.view.webContents.downloadURL(url);
      return;
    }
    if (!this.win || this.win.isDestroyed()) return;
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    view.setVisible(false);
    view.webContents.downloadURL(url);
    setTimeout(() => {
      try {
        if (this.win && !this.win.isDestroyed()) this.win.contentView.removeChildView(view);
      } catch {
        /* ignore */
      }
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }, 2500);
  }

  redownloadDownload(id) {
    const record = this.findDownload(id);
    if (!record || !record.url) return;
    const { url, path: savePath } = record;
    if (record.item) {
      try {
        record.item.cancel();
      } catch {
        /* ignore */
      }
      record.item = null;
    }
    this.downloads = this.downloads.filter((item) => item.id !== id);
    this.pendingDownload = { url, path: savePath };
    this.broadcast();
    setTimeout(() => this.triggerDownload(url), 400);
  }

  showDownloadMenu(id, clientX, clientY) {
    const record = this.findDownload(id);
    debug('showDownloadMenu', id, record && record.state, clientX, clientY);
    if (!record || !this.overlay || !this.overlay.win || this.overlay.win.isDestroyed()) return;

    const active = record.state === 'progressing' || record.state === 'paused';
    const items = [];
    const actions = new Map();
    const add = (actionId, label, handler, extra = {}) => {
      actions.set(actionId, handler);
      items.push({ id: actionId, label, ...extra });
    };

    if (active) {
      add(record.paused ? 'resume' : 'pause', record.paused ? '继续下载' : '暂停下载', () =>
        record.paused ? this.resumeDownload(id) : this.pauseDownload(id));
      add('redownload', '重新下载', () => this.redownloadDownload(id));
      add('copy-url', '复制下载地址', () => clipboard.writeText(record.url || ''), {
        accelerator: 'Ctrl+C',
      });
      add('remove', '在列表中删除', () => this.removeDownloadFromList(id));
      items.push({ type: 'separator' });
      add('cancel-delete', '取消并删除', () => this.cancelAndDeleteDownload(id), { danger: true });
    } else {
      add('redownload', '重新下载', () => this.redownloadDownload(id));
      add('copy-url', '复制下载地址', () => clipboard.writeText(record.url || ''), {
        accelerator: 'Ctrl+C',
      });
      add('reveal', '打开文件所在的文件夹', () => this.revealDownload(id));
      add('remove', '在列表中删除', () => this.removeDownloadFromList(id));
      items.push({ type: 'separator' });
      add('delete-file', '删除文件', () => this.deleteDownloadFile(id), { danger: true });
    }

    const bounds = this.overlay.win.getContentBounds();
    this.overlay.owner = this;
    this.overlay.showMenu({
      items,
      theme: this.themeInfo(),
      x: bounds.x + Math.round(clientX),
      y: bounds.y + Math.round(clientY),
      onAction: (actionId) => {
        const action = actions.get(actionId);
        if (action) action();
      },
      onHide: () => this.focusActiveContent(),
    });
  }

  /* ------------------------------------------------------------------ */
  /* 窗口操作                                                            */
  /* ------------------------------------------------------------------ */

  minimize() {
    if (this.win) this.win.minimize();
  }

  toggleMaximize() {
    if (!this.win) return;
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
  }

  closeWindow() {
    if (this.win) this.win.close();
  }

  toggleFullscreen() {
    if (!this.win) return;
    this.win.setFullScreen(!this.win.isFullScreen());
  }

  isFullScreen() {
    return !!this.win && this.win.isFullScreen();
  }

  focusOmnibox() {
    this.send('ui:focus-omnibox');
  }

  newIncognitoWindow() {
    if (this.onNewIncognito) this.onNewIncognito();
  }

  openGamePage() {
    const gamePath = path.join(__dirname, '..', 'games', '2048', 'index.html');
    this.createTab(pathToFileURL(gamePath).href);
  }

  focusWindow() {
    if (!this.win) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
  }

  showAbout() {
    const { dialog } = require('electron');
    dialog.showMessageBox({
      type: 'info',
      title: `关于 ${APP_NAME}`,
      message: `${APP_NAME}`,
      detail:
        `一个轻量的多标签浏览器。\n\n` +
        `版本:  ${APP_VERSION}\n` +
        `Chromium ${process.versions.chrome}\n\n` +
        `此浏览器基于 Chromium 开源项目及其他 开源软件。\n` +
        `© 2026 爱玩批处理的cmd。保留所有权利。\n`,
      buttons: ['确定'],
      noLink: true,
    });
  }

  showAppMenu() {
    buildAppMenu(this).popup({ window: this.win });
  }

  showDownloadsMenu() {
    this.showDownloadsBubble();
  }

  openExternal(url) {
    if (/^https?:/i.test(String(url || ''))) shell.openExternal(url).catch(() => {});
  }

  /* ------------------------------------------------------------------ */
  /* 状态同步                                                            */
  /* ------------------------------------------------------------------ */

  serialize() {
    return {
      tabs: this.tabs.map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title || '新标签页',
        favicon: tab.favicon,
        isLoading: tab.isLoading,
        canGoBack: tab.canGoBack,
        canGoForward: tab.canGoForward,
        zoom: tab.zoom,
        error: tab.error,
      })),
      activeTabId: this.activeId,
      incognito: this.incognito,
      bookmarks: this.store.data.bookmarks,
      settings: this.store.data.settings,
      history: this.store.data.history.slice(0, 12),
      downloads: this.downloads.map((item) => ({
        id: item.id,
        filename: item.filename,
        path: item.path,
        state: item.state,
        received: item.received,
        total: item.total,
      })),
      window: {
        maximized: !!this.win && this.win.isMaximized(),
        fullscreen: !!this.win && this.win.isFullScreen(),
      },
      theme: this.themeInfo(),
      platform: process.platform,
      versions: { app: APP_VERSION, electron: process.versions.electron, chrome: process.versions.chrome },
    };
  }

  broadcast() {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.send('state', this.serialize());
      if (this.overlay) this.overlay.updateDownloads(this.downloadsPayload());
    }, 16);
  }

  send(channel, payload) {
    const wc = this.chrome && this.chrome.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send(channel, payload);
  }

  handleShortcut(event, input) {
    if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return;
    const key = String(input.key || '');
    const lower = key.toLowerCase();
    const ctrl = input.control || input.meta;
    const shift = input.shift;
    const alt = input.alt;
    if (!ctrl && !alt && !shift && key === 'F11') {
      event.preventDefault();
      this.toggleFullscreen();
      return;
    }
    if (key === 'F12' || (ctrl && shift && lower === 'i')) {
      event.preventDefault();
      this.toggleDevTools();
      return;
    }
    if (key === 'F5') {
      event.preventDefault();
      this.reload(this.activeId, shift);
      return;
    }
    if (key === 'Escape') {
      if (this.isFullScreen()) {
        event.preventDefault();
        this.win.setFullScreen(false);
        return;
      }
      if (this.findActive) {
        event.preventDefault();
        this.closeFind();
      }
      return;
    }
    if (key === 'F6' || (ctrl && lower === 'l')) {
      event.preventDefault();
      this.focusOmnibox();
      return;
    }
    if (alt && key === 'ArrowLeft') {
      event.preventDefault();
      this.back();
      return;
    }
    if (alt && key === 'ArrowRight') {
      event.preventDefault();
      this.forward();
      return;
    }
    if (alt && key === 'Home') {
      event.preventDefault();
      this.goHome();
      return;
    }
    if (!ctrl) return;

    if (lower === 't' && !shift) {
      event.preventDefault();
      this.createTab('');
      return;
    }
    if (lower === 't' && shift) {
      event.preventDefault();
      this.reopenClosedTab();
      return;
    }
    if (lower === 'w' && !shift) {
      event.preventDefault();
      this.closeActiveTab();
      return;
    }
    if (lower === 'n' && shift) {
      event.preventDefault();
      this.newIncognitoWindow();
      return;
    }
    if (lower === 'r') {
      event.preventDefault();
      this.reload(this.activeId, shift);
      return;
    }
    if (lower === 'f') {
      event.preventDefault();
      this.toggleFind();
      return;
    }
    if (lower === 'd' && !shift) {
      event.preventDefault();
      const tab = this.getTab(this.activeId);
      if (tab && tab.url) this.toggleBookmark(tab.url, tab.title);
      return;
    }
    if (lower === 'b' && shift) {
      event.preventDefault();
      this.setSetting('bookmarksBar', !this.store.data.settings.bookmarksBar);
      return;
    }
    if (key === 'Tab') {
      event.preventDefault();
      this.cycleTab(shift ? -1 : 1);
      return;
    }
    if (key === '+' || key === '=' || key === 'Add') {
      event.preventDefault();
      this.zoomBy(1);
      return;
    }
    if (key === '-' || key === 'Subtract') {
      event.preventDefault();
      this.zoomBy(-1);
      return;
    }
    if (key === '0') {
      event.preventDefault();
      this.resetZoom();
      return;
    }
    if (/^[1-9]$/.test(key)) {
      event.preventDefault();
      if (key === '9') this.selectTabAt(this.tabs.length - 1);
      else this.selectTabAt(Number(key) - 1);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 持久化                                                              */
  /* ------------------------------------------------------------------ */

  /** 标签页/导航变化后延迟保存，避免应用被更新程序直接结束而丢失标签页历史 */
  scheduleSessionSave() {
    if (this.incognito) return;
    if (this.sessionSaveTimer) clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = setTimeout(() => {
      this.sessionSaveTimer = null;
      if (!this.win || this.win.isDestroyed()) return;
      this.persistSession();
      this.store.flush();
    }, 900);
  }

  scheduleBoundsSave() {
    if (this.boundsTimer) clearTimeout(this.boundsTimer);
    this.boundsTimer = setTimeout(() => {
      this.boundsTimer = null;
      this.captureBounds();
      this.store.touch();
    }, 350);
  }

  captureBounds() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.isMaximized() || this.win.isFullScreen()) {
      if (this.normalBounds) {
        this.store.data.window = { ...this.normalBounds, maximized: true };
      } else {
        this.store.data.window.maximized = true;
      }
      return;
    }
    const bounds = this.win.getBounds();
    this.normalBounds = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
    this.store.data.window = { ...this.normalBounds, maximized: false };
  }

  persistSession() {
    if (this.incognito) return;
    if (!this.win || this.win.isDestroyed()) return;
    this.captureBounds();
    this.store.data.window.maximized = this.win.isMaximized();

    const savedTabs = [];
    let activeIndex = 0;

    for (const tab of this.tabs) {
      let entries = [];
      let index = 0;
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        try {
          const history = tab.view.webContents.navigationHistory;
          const allEntries = history.getAllEntries() || [];
          entries = allEntries
            .filter((entry) => entry && typeof entry.url === 'string' && /^(https?|file):/i.test(entry.url))
            .map((entry) => ({ url: entry.url, title: entry.title || '' }));
          index = clamp(history.getActiveIndex() || 0, 0, Math.max(0, entries.length - 1));
        } catch {
          entries = [];
        }
      }
      if (!entries.length && tab.url) {
        entries = [{ url: tab.url, title: tab.title || '' }];
        index = 0;
      }
      if (!entries.length) continue;
      if (entries.length > 50) {
        const drop = entries.length - 50;
        entries = entries.slice(drop);
        index = clamp(index - drop, 0, entries.length - 1);
      }
      if (tab.id === this.activeId) activeIndex = savedTabs.length;
      savedTabs.push({ entries, index });
    }

    const urls = this.tabs
      .map((tab) => tab.url)
      .filter((url) => url === '' || /^(https?|file):/i.test(url))
      .slice(0, 12);

    this.store.data.session = {
      tabs: savedTabs.slice(0, 12),
      urls,
      activeIndex,
    };
    this.store.touch();
  }
}

module.exports = { LiteWindow };
