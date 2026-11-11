'use strict';

const { app, ipcMain, session, Menu, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL, fileURLToPath } = require('node:url');

const { Store, DEFAULT_STATE } = require('./store');
const { LiteWindow } = require('./window');
const { OverlayWindow } = require('./overlay');
const { APP_NAME, APP_ID, PARTITION, buildUserAgent } = require('./config');

const INCOGNITO_PARTITION = 'incognito';

app.setName(APP_NAME);
const APP_USER_MODEL_ID = process.env.LITE_APP_USER_MODEL_ID || APP_ID;
if (APP_USER_MODEL_ID !== '__none__') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// 相同站点的标签页共享渲染进程，减少多标签内存占用
app.commandLine.appendSwitch('process-per-site');

if (process.env.LITE_SMOKE === '1') {
  const sandboxDir = path.join(process.cwd(), 'test-output');
  app.setPath('userData', path.join(sandboxDir, 'profile'));
  app.setPath('downloads', path.join(sandboxDir, 'downloads'));
  fs.mkdirSync(path.join(sandboxDir, 'downloads'), { recursive: true });
} else if (process.env.LITE_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.LITE_USER_DATA));
} else {
  // 固定到 %APPDATA%\LiteBrowser，重新打包/覆盖安装后 Cookie、历史与标签页仍然保留
  app.setPath('userData', path.join(app.getPath('appData'), 'LiteBrowser'));
}

// 浏览器数据（Cookie、缓存、站点设置）与 LiteBrowser 自己的存档分开存放
app.setPath('sessionData', path.join(app.getPath('userData'), 'browser-data'));

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  /** @type {Store | null} */
  let store = null;
  /** @type {OverlayWindow | null} */
  let overlay = null;
  /** @type {LiteWindow | null} */
  let liteWin = null;
  /** @type {Set<LiteWindow>} */
  const windows = new Set();
  /** @type {Map<number, LiteWindow>} */
  const chromeOwners = new Map();
  let lastActiveWindow = null;
  const configuredSessions = new Set();
  const pendingOpenFiles = [];

  /** 从命令行参数中提取通过文件关联打开的 HTML 文件。 */
  function collectHtmlTargets(argv, cwd = process.cwd()) {
    const targets = [];
    for (const raw of argv || []) {
      if (typeof raw !== 'string') continue;
      const value = raw.trim().replace(/^"|"$/g, '');
      if (!value || value.startsWith('-')) continue;

      let filePath = null;
      if (/^file:/i.test(value)) {
        try {
          const parsed = new URL(value);
          if (parsed.protocol !== 'file:') continue;
          filePath = fileURLToPath(parsed);
        } catch {
          continue;
        }
      } else {
        filePath = path.resolve(cwd || process.cwd(), value);
      }

      if (!/\.html?$/i.test(filePath)) continue;
      try {
        if (!fs.statSync(filePath).isFile()) continue;
      } catch {
        continue;
      }
      const url = pathToFileURL(filePath).href;
      if (!targets.includes(url)) targets.push(url);
    }
    return targets;
  }

  function primaryWindow() {
    if (liteWin && !liteWin._destroyed) return liteWin;
    for (const win of windows) {
      if (!win.incognito) return win;
    }
    return windows.values().next().value || null;
  }

  function openHtmlTargets(targets, options = {}) {
    if (!targets || !targets.length) return false;
    const win = primaryWindow();
    if (!win) return false;
    const active = win.getTab(win.activeId);
    const replaceBlank =
      Boolean(options.replaceBlank) && win.tabs.length === 1 && active && !active.url;
    targets.forEach((url, index) => {
      if (index === 0 && replaceBlank) win.navigate(url);
      else win.createTab(url);
    });
    win.focusWindow();
    return true;
  }

  function setupSession(partition) {
    if (configuredSessions.has(partition)) return;
    configuredSessions.add(partition);

    const ses = session.fromPartition(partition);
    ses.setUserAgent(buildUserAgent());

    // 轻量浏览器默认拒绝敏感权限，只放行全屏与指针锁定。
    const allowed = new Set(['fullscreen', 'pointerLock']);
    ses.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(allowed.has(permission));
    });
    ses.setPermissionCheckHandler((_webContents, permission) => allowed.has(permission));

    ses.on('will-download', (_event, item, webContents) => {
      const owner = findWindowForContents(webContents) || lastActiveWindow;
      if (owner) owner.handleDownload(item);
    });
  }

  function findWindowForContents(webContents) {
    if (!webContents) return null;
    for (const win of windows) {
      if (win.chrome && win.chrome.webContents === webContents) return win;
      for (const tab of win.tabs) {
        if (tab.view && tab.view.webContents === webContents) return win;
      }
    }
    return null;
  }

  function createIncognitoStore(baseStore) {
    const data = JSON.parse(JSON.stringify(DEFAULT_STATE));
    data.settings = {
      ...baseStore.data.settings,
      searchEngine: 'duckduckgo',
      restoreTabs: false,
      bookmarksBar: false,
      homePage: '',
    };
    data.window = { ...baseStore.data.window };
    if (Number.isFinite(data.window.x)) data.window.x += 36;
    if (Number.isFinite(data.window.y)) data.window.y += 36;
    data.bookmarks = [];
    data.history = [];
    data.session = { tabs: [], urls: [], activeIndex: 0 };
    return {
      data,
      file: '',
      touch() {},
      flush() {},
    };
  }

  function handleWindowClosed(win) {
    windows.delete(win);
    if (win._chromeWebContentsId) chromeOwners.delete(win._chromeWebContentsId);
    if (overlay && overlay.owner === win) {
      overlay.hide();
      overlay.owner = null;
    }
    if (lastActiveWindow === win) {
      lastActiveWindow = windows.values().next().value || null;
    }
    if (!windows.size) {
      if (overlay) {
        overlay.destroy();
        overlay = null;
      }
      app.quit();
      return;
    }
    if (win.incognito && ![...windows].some((item) => item.incognito)) {
      session.fromPartition(INCOGNITO_PARTITION).clearStorageData().catch(() => {});
    }
  }

  function createWindow(options = {}) {
    const incognito = Boolean(options.incognito);
    const winStore = incognito ? createIncognitoStore(store) : store;
    const partition = incognito ? INCOGNITO_PARTITION : PARTITION;
    setupSession(partition);

    const win = new LiteWindow(winStore, overlay, {
      incognito,
      partition,
      onNewIncognito: () => createWindow({ incognito: true }),
      onClosed: () => handleWindowClosed(win),
      onFocus: () => {
        lastActiveWindow = win;
      },
    });
    windows.add(win);
    win.create();
    win._chromeWebContentsId = win.chrome ? win.chrome.webContents.id : null;
    if (win._chromeWebContentsId) chromeOwners.set(win._chromeWebContentsId, win);
    lastActiveWindow = win;
    return win;
  }

  function toTabId(id) {
    const value = Number(id);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  function registerIpc() {
    const targetFor = (event) => chromeOwners.get(event.sender.id) || null;

    const handle = (channel, fn) => {
      ipcMain.handle(channel, (event, ...args) => {
        const win = targetFor(event);
        if (!win) throw new Error(`untrusted sender: ${channel}`);
        return fn(win, ...args);
      });
    };

    const on = (channel, fn) => {
      ipcMain.on(channel, (event, ...args) => {
        const win = targetFor(event);
        if (!win) return;
        fn(win, ...args);
      });
    };

    handle('lite:hydrate', (win) => win.serialize());

    handle('lite:tab:create', (win) => win.createTab(''));
    handle('lite:tab:close', (win, id) => win.closeTab(toTabId(id)));
    handle('lite:tab:select', (win, id) => win.selectTab(toTabId(id)));
    handle('lite:tab:reorder', (win, ids) => win.reorderTabs(ids));
    handle('lite:tab:menu', (win, id, x, y) => {
      const tab = win.getTab(toTabId(id));
      if (tab) win.showTabMenu(tab, Number(x) || 0, Number(y) || 0);
    });
    handle('lite:tab:navigate', (win, _id, input) => {
      win.navigate(String(input == null ? '' : input));
    });
    handle('lite:tab:back', (win) => win.back());
    handle('lite:tab:forward', (win) => win.forward());
    handle('lite:tab:reload', (win, _id, hard) => win.reload(undefined, Boolean(hard)));
    handle('lite:tab:stop', (win) => win.stop());
    handle('lite:tab:home', (win) => win.goHome());
    handle('lite:tab:zoom', (win, _id, direction) =>
      win.zoomBy(Number(direction) >= 0 ? 1 : -1));
    handle('lite:tab:reset-zoom', (win) => win.resetZoom());

    handle('lite:find:start', (win, text) => {
      win.findActive = true;
      win.findInPage(String(text == null ? '' : text));
    });
    handle('lite:find:next', (win, forward) => {
      win.findInPage(win.findText, { findNext: true, forward: forward !== false });
    });
    handle('lite:find:stop', (win) => win.stopFind());
    handle('lite:find:close', (win) => win.closeFind());

    on('lite:chrome:height', (win, height) => win.setChromeHeight(height));
    on('lite:layout:metrics', (win, metrics) => win.setLayoutMetrics(metrics));

    handle('lite:window:minimize', (win) => win.minimize());
    handle('lite:window:toggle-maximize', (win) => win.toggleMaximize());
    handle('lite:window:close', (win) => win.closeWindow());
    handle('lite:window:toggle-fullscreen', (win) => win.toggleFullscreen());
    handle('lite:window:new-incognito', (win) => win.newIncognitoWindow());

    handle('lite:bookmark:toggle', (win, url, title, favicon) =>
      win.toggleBookmark(String(url || ''), String(title || ''), String(favicon || '')));
    handle('lite:bookmark:menu', (win, id, x, y) => {
      const bookmark = win.store.data.bookmarks.find((item) => item.id === String(id));
      if (bookmark) win.showBookmarkMenu(bookmark, Number(x) || 0, Number(y) || 0);
    });
    handle('lite:bookmark:remove', (win, id) => win.removeBookmark(String(id)));
    handle('lite:settings:set', (win, key, value) => {
      if (typeof key === 'string') win.setSetting(key, value);
    });
    handle('lite:history:clear', (win) => win.clearHistory());
    handle('lite:history:remove', (win, url) => win.removeHistoryEntry(String(url || '')));
    handle('lite:history:menu', (win, url, x, y) => {
      const entry = win.store.data.history.find((item) => item.url === String(url));
      if (entry) win.showHistoryMenu(entry, Number(x) || 0, Number(y) || 0);
    });

    handle('lite:menu:app', (win) => win.showAppMenu());
    handle('lite:menu:downloads', (win) => win.showDownloadsBubble());
    handle('lite:downloads:panel', (win) => win.showDownloadsBubble());
    handle('lite:downloads:clear', (win) => win.clearDownloads());
    handle('lite:download:open', (win, id) => win.openDownload(String(id)));
    handle('lite:userdata:open', (win) => win.openUserDataFolder());
    handle('lite:open-external', (win, url) => win.openExternal(String(url || '')));
    handle('lite:app:about', (win) => win.showAbout());
    handle('lite:game:open', (win) => win.openGamePage());
  }

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const targets = collectHtmlTargets(argv, workingDirectory);
    if (!app.isReady()) {
      pendingOpenFiles.push(...targets);
      return;
    }
    if (targets.length) {
      if (!windows.size) liteWin = createWindow();
      if (openHtmlTargets(targets, { replaceBlank: false })) return;
      pendingOpenFiles.push(...targets);
    }
    if (lastActiveWindow) lastActiveWindow.focusWindow();
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    const targets = collectHtmlTargets([filePath], path.dirname(filePath));
    if (!targets.length) return;
    if (app.isReady() && windows.size) {
      openHtmlTargets(targets, { replaceBlank: false });
    } else {
      pendingOpenFiles.push(...targets);
    }
  });

  app.whenReady().then(() => {
    if (APP_USER_MODEL_ID !== '__none__') app.setAppUserModelId(APP_USER_MODEL_ID);
    store = new Store();
    nativeTheme.themeSource = store.data.settings.theme;
    if (process.env.LITE_DEBUG === '1') {
      console.log(
        '[litebrowser] store:', store.file,
        'session:', JSON.stringify(store.data.session),
        'bookmarks:', store.data.bookmarks.length,
      );
    }

    overlay = new OverlayWindow();
    Menu.setApplicationMenu(null);
    registerIpc();

    const startupTargets = collectHtmlTargets(process.argv.slice(1), process.cwd());
    liteWin = createWindow();
    if (startupTargets.length) {
      openHtmlTargets(startupTargets, { replaceBlank: true });
    }
    if (pendingOpenFiles.length) {
      openHtmlTargets([...new Set(pendingOpenFiles)], { replaceBlank: false });
      pendingOpenFiles.length = 0;
    }

    nativeTheme.on('updated', () => {
      for (const win of windows) win.onThemeUpdated();
    });

    ipcMain.on('lite:downloads:row-menu', (event, id, x, y) => {
      if (overlay && overlay.isOverlay(event.sender) && overlay.owner) {
        overlay.owner.showDownloadMenu(String(id), Number(x) || 0, Number(y) || 0);
      }
    });

    if (process.env.LITE_SMOKE === '1') {
      require('./smoke')(liteWin, {
        createIncognitoWindow: () => createWindow({ incognito: true }),
        getWindows: () => [...windows],
      });
    }
  });

  app.on('window-all-closed', () => {
    if (!windows.size) app.quit();
  });

  app.on('before-quit', () => {
    try {
      for (const win of windows) {
        if (!win.incognito) win.persistSession();
      }
      if (store) store.flush();
      if (overlay) overlay.destroy();
    } catch {
      /* 退出时忽略持久化错误 */
    }
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.on('activate', () => {
    if (!windows.size) liteWin = createWindow();
    else if (lastActiveWindow) lastActiveWindow.focusWindow();
  });
}
