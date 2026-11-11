'use strict';

const path = require('node:path');
const { BrowserWindow, ipcMain, screen } = require('electron');

const PRELOAD_PATH = path.join(__dirname, '..', 'overlay', 'preload.js');
const OVERLAY_HTML = path.join(__dirname, '..', 'overlay', 'index.html');
const DEBUG = process.env.LITE_DEBUG === '1';
const debug = (...args) => {
  if (DEBUG) console.log('[overlay]', ...args);
};

function overlayBackground(theme) {
  return theme && theme.dark ? '#232529' : '#ffffff';
}

/**
 * 自绘浮层：右键菜单与下载气泡都渲染在这个无边框窗口中。
 * 窗口按内容尺寸创建，避免透明窗口在部分 Windows 环境下露出黑底。
 */
class OverlayWindow {
  constructor() {
    this.win = null;
    this.payload = null;
    this.anchor = null;
    this.onAction = null;
    this.onHide = null;
    this.mode = null;
    this.ready = false;
    this.onAction = null;
    this.onHide = null;
    this.owner = null;
    this.shownAt = 0;

    ipcMain.handle('lite:overlay:data', (event) => {
      return this.isOverlay(event.sender) ? this.payload : null;
    });
    ipcMain.on('lite:overlay:measured', (event, size) => {
      if (this.isOverlay(event.sender)) this.place(size);
    });
    ipcMain.on('lite:overlay:action', (event, id) => {
      if (!this.isOverlay(event.sender)) return;
      const action = this.onAction;
      this.hide();
      if (action) action(String(id));
    });
    ipcMain.on('lite:overlay:close', (event) => {
      if (this.isOverlay(event.sender)) this.hide();
    });
  }

  isOverlay(sender) {
    return Boolean(this.win && !this.win.isDestroyed() && sender === this.win.webContents);
  }

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return;
    const win = new BrowserWindow({
      width: 380,
      height: 440,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      thickFrame: false,
      backgroundColor: '#ffffff',
      title: 'LiteBrowserOverlay',
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setMenuBarVisibility(false);
    debug('window created');
    win.on('blur', () => {
      // 刚显示时焦点切换可能触发瞬时的 blur，忽略以免菜单刚出现就消失
      if (Date.now() - this.shownAt < 300) {
        debug('ignore early blur');
        return;
      }
      debug('blur -> hide');
      this.hide();
    });
    win.on('closed', () => {
      this.win = null;
      this.ready = false;
      this.mode = null;
    });
    win.webContents.on('did-finish-load', () => {
      this.ready = true;
    });
    win.webContents.on('console-message', (event) => {
      if (DEBUG) console.log('[overlay-renderer]', event.message);
    });
    win.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error('[overlay] preload error', preloadPath, error && error.message);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('[overlay] renderer gone:', details.reason);
    });
    win.loadFile(OVERLAY_HTML);
    this.win = win;
    this.ready = false;
  }

  showMenu({ items, width = 0, x, y, theme, onAction, onHide }) {
    this.show(
      { mode: 'menu', items, width, theme: theme || { source: 'system', dark: false } },
      { type: 'point', x, y },
      onAction,
      onHide,
    );
  }

  showDownloads({ downloads, right, y, theme, onAction, onHide }) {
    this.show(
      {
        mode: 'downloads',
        downloads: Array.isArray(downloads) ? downloads : [],
        theme: theme || { source: 'system', dark: false },
      },
      { type: 'top-right', right, y },
      onAction,
      onHide,
    );
  }

  show(payload, anchor, onAction, onHide) {
    this.payload = payload;
    this.anchor = anchor;
    this.onAction = onAction || null;
    this.onHide = onHide || null;
    this.mode = payload.mode;
    debug('show', payload.mode, 'ready=', this.ready, 'visible=', this.isVisible(), 'anchor=', JSON.stringify(anchor));
    this.ensureWindow();
    if (this.ready) {
      this.win.webContents.send('lite:overlay:update', this.payload);
      if (this.win.isVisible()) this.reveal();
    }
  }

  place(size) {
    if (!this.win || this.win.isDestroyed() || !this.anchor) return;
    const panelWidth = Math.max(120, Math.ceil(Number(size && size.width) || 240));
    const panelHeight = Math.max(40, Math.ceil(Number(size && size.height) || 200));
    const totalWidth = panelWidth;
    const totalHeight = panelHeight;
    const point = {
      x: this.anchor.type === 'top-right' ? this.anchor.right : this.anchor.x,
      y: this.anchor.y,
    };
    const display = screen.getDisplayNearestPoint({
      x: Math.round(point.x || 0),
      y: Math.round(point.y || 0),
    });
    const area = display.workArea;

    let x = this.anchor.type === 'top-right' ? this.anchor.right - panelWidth : this.anchor.x;
    let y = this.anchor.y;

    const maxX = Math.max(area.x, area.x + area.width - totalWidth);
    const maxY = Math.max(area.y, area.y + area.height - totalHeight);
    x = Math.min(Math.max(x, area.x), maxX);
    y = Math.min(Math.max(y, area.y), maxY);

    const bounds = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.ceil(totalWidth),
      height: Math.ceil(totalHeight),
    };
    if (this.win.setBackgroundColor) {
      this.win.setBackgroundColor(overlayBackground(this.payload && this.payload.theme));
    }
    const current = this.win.getBounds();
    if (
      current.x !== bounds.x ||
      current.y !== bounds.y ||
      current.width !== bounds.width ||
      current.height !== bounds.height
    ) {
      this.win.setBounds(bounds);
    }

    if (!this.win.isVisible()) {
      debug('show window at', JSON.stringify(bounds), 'size', panelWidth, panelHeight);
      this.shownAt = Date.now();
      this.win.show();
      this.win.focus();
      this.reveal();
    } else {
      debug('resize window', JSON.stringify(bounds));
    }
  }

  reveal() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('lite:overlay:shown');
  }

  hide() {
    if (!this.win || this.win.isDestroyed()) {
      this.mode = null;
      return;
    }
    const wasVisible = this.win.isVisible();
    debug('hide', 'wasVisible=', wasVisible);
    if (wasVisible) this.win.hide();
    this.mode = null;
    const onHide = this.onHide;
    this.onHide = null;
    this.onAction = null;
    if (wasVisible && onHide) onHide();
  }

  updateDownloads(downloads) {
    if (this.mode !== 'downloads') return;
    this.payload = { ...this.payload, downloads };
    if (this.ready && this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('lite:overlay:update', this.payload);
    }
  }

  updateTheme(theme) {
    if (!this.payload) return;
    this.payload = { ...this.payload, theme };
    if (this.win && !this.win.isDestroyed() && this.win.setBackgroundColor) {
      this.win.setBackgroundColor(overlayBackground(theme));
    }
    if (this.ready && this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('lite:overlay:theme', theme);
    }
  }

  isVisible() {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
    this.ready = false;
    this.mode = null;
  }

  close() {
    this.hide();
  }
}

module.exports = { OverlayWindow };
