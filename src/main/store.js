'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { SEARCH_ENGINE_IDS } = require('./config');

const DEFAULT_STATE = {
  schema: 1,
  window: { width: 1280, height: 820, x: null, y: null, maximized: false },
  settings: {
    searchEngine: 'bing',
    bookmarksBar: true,
    restoreTabs: true,
    homePage: '',
    downloadDir: '',
    theme: 'system',
    verticalTabs: false,
  },
  bookmarks: [],
  history: [],
  session: { tabs: [], urls: [], activeIndex: 0 },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 用默认值补齐旧版本/损坏的存档，数组不合并 */
function fillDefaults(defaults, value) {
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : clone(defaults);
  if (defaults && typeof defaults === 'object') {
    const out = {};
    for (const key of Object.keys(defaults)) {
      out[key] = fillDefaults(defaults[key], value && typeof value === 'object' ? value[key] : undefined);
    }
    return out;
  }
  return value === undefined || value === null ? defaults : value;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitize(state) {
  const out = fillDefaults(DEFAULT_STATE, state);

  if (!SEARCH_ENGINE_IDS.includes(out.settings.searchEngine)) out.settings.searchEngine = 'bing';
  out.settings.bookmarksBar = !!out.settings.bookmarksBar;
  out.settings.restoreTabs = !!out.settings.restoreTabs;
  out.settings.homePage = typeof out.settings.homePage === 'string' ? out.settings.homePage : '';
  out.settings.theme = ['system', 'light', 'dark'].includes(out.settings.theme)
    ? out.settings.theme
    : 'system';
  out.settings.verticalTabs = !!out.settings.verticalTabs;
  out.settings.downloadDir =
    typeof out.settings.downloadDir === 'string' &&
    out.settings.downloadDir &&
    path.isAbsolute(out.settings.downloadDir)
      ? out.settings.downloadDir
      : '';

  out.window.width = clampNumber(out.window.width, 960, 10000, 1280);
  out.window.height = clampNumber(out.window.height, 600, 10000, 820);
  out.window.x = Number.isFinite(out.window.x) ? Math.round(out.window.x) : null;
  out.window.y = Number.isFinite(out.window.y) ? Math.round(out.window.y) : null;
  out.window.maximized = !!out.window.maximized;

  out.bookmarks = (Array.isArray(out.bookmarks) ? out.bookmarks : [])
    .filter((bm) => bm && typeof bm.url === 'string' && /^(https?|file):/i.test(bm.url))
    .slice(0, 500)
    .map((bm, index) => ({
      id: typeof bm.id === 'string' && bm.id ? bm.id : `bm-${Date.now().toString(36)}-${index}`,
      url: bm.url,
      title: typeof bm.title === 'string' && bm.title.trim() ? bm.title.trim().slice(0, 300) : bm.url,
      favicon:
        typeof bm.favicon === 'string' && /^(https?|data|file):/i.test(bm.favicon) ? bm.favicon.slice(0, 4000) : '',
      createdAt: Number.isFinite(bm.createdAt) ? bm.createdAt : Date.now(),
    }));

  const seen = new Set();
  out.history = (Array.isArray(out.history) ? out.history : [])
    .filter((item) => item && typeof item.url === 'string' && /^https?:/i.test(item.url))
    .filter((item) => (seen.has(item.url) ? false : (seen.add(item.url), true)))
    .slice(0, 300)
    .map((item) => ({
      url: item.url,
      title: typeof item.title === 'string' ? item.title.slice(0, 300) : '',
      favicon:
        typeof item.favicon === 'string' && /^(https?|data|file):/i.test(item.favicon)
          ? item.favicon.slice(0, 4000)
          : '',
      time: Number.isFinite(item.time) ? item.time : Date.now(),
    }));

  out.session.urls = (Array.isArray(out.session.urls) ? out.session.urls : [])
    .filter((url) => typeof url === 'string')
    .slice(0, 12);
  out.session.activeIndex = clampNumber(out.session.activeIndex, 0, 11, 0);
  out.session.tabs = (Array.isArray(out.session.tabs) ? out.session.tabs : [])
    .slice(0, 12)
    .map((tab) => {
      const entries = (Array.isArray(tab && tab.entries) ? tab.entries : [])
        .filter((entry) => entry && typeof entry.url === 'string' && /^(https?|file):/i.test(entry.url))
        .slice(-50)
        .map((entry) => ({
          url: entry.url,
          title: typeof entry.title === 'string' ? entry.title.slice(0, 300) : '',
        }));
      return {
        entries,
        index: entries.length ? clampNumber(tab && tab.index, 0, entries.length - 1, 0) : 0,
      };
    })
    .filter((tab) => tab.entries.length > 0);

  return out;
}

class Store {
  constructor(filePath) {
    const userData = app.getPath('userData');
    const defaultFile = path.join(userData, 'data', 'litebrowser-store.json');
    this.file = filePath || defaultFile;
    this.legacyFile = path.join(userData, 'litebrowser-store.json');
    this.migrateLegacy();
    this.data = this.read();
    this.timer = null;
  }

  /** 旧版本把存档放在 userData 根目录，发现后迁移到单独的 data 目录 */
  migrateLegacy() {
    try {
      if (this.file === this.legacyFile) return;
      if (fs.existsSync(this.file) || !fs.existsSync(this.legacyFile)) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.copyFileSync(this.legacyFile, this.file);
    } catch (error) {
      console.error('[store] 迁移旧数据失败:', error.message);
    }
  }

  read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      return sanitize(JSON.parse(raw));
    } catch {
      return sanitize(null);
    }
  }

  /** 标记有改动，稍后合并写入磁盘 */
  touch() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 400);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('[store] 保存失败:', error.message);
    }
  }
}

module.exports = { Store, DEFAULT_STATE };
