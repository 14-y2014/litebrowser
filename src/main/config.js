'use strict';

const path = require('node:path');

const APP_NAME = 'LiteBrowser';
const APP_ID = 'com.litebrowser.fresh.20261109';
const APP_VERSION = require(path.join(__dirname, '..', '..', 'package.json')).version;

/** 页面浏览使用的持久化分区（书签/历史存在用户数据目录，与网页 Cookie 分开） */
const PARTITION = 'persist:litebrowser';

const SEARCH_ENGINES = {
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  google: { label: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  baidu: { label: '百度', url: 'https://www.baidu.com/s?wd=%s' },
};

const SEARCH_ENGINE_IDS = Object.keys(SEARCH_ENGINES);

function isNavigableUrl(url) {
  return /^(https?|file):/i.test(String(url || ''));
}

/**
 * 把地址栏输入整理成可加载的 URL：
 * 完整 URL 原样返回；localhost/IP/域名补协议；其余内容交给搜索引擎。
 */
function normalizeInput(input, settings) {
  const text = String(input == null ? '' : input).trim();
  if (!text) return '';

  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    if (/^(https?|file):/i.test(text)) return text;
    // about:blank 之类的内部页面不允许从地址栏打开
    return '';
  }

  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#].*)?$/i.test(text)) {
    return `http://${text}`;
  }

  if (
    !/\s/.test(text) &&
    /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(text) &&
    /[a-z]{2,}/i.test(text.split('/')[0].split(':')[0].split('.').pop() || '')
  ) {
    return `https://${text}`;
  }

  const engine = SEARCH_ENGINES[settings && settings.searchEngine] || SEARCH_ENGINES.bing;
  return engine.url.replace('%s', encodeURIComponent(text));
}

function buildUserAgent() {
  const platform =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return (
    `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${process.versions.chrome} Safari/537.36 LiteBrowser/${APP_VERSION}`
  );
}

function displayHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '') || parsed.protocol.replace(':', '');
  } catch {
    return '';
  }
}

module.exports = {
  APP_NAME,
  APP_ID,
  APP_VERSION,
  PARTITION,
  SEARCH_ENGINES,
  SEARCH_ENGINE_IDS,
  isNavigableUrl,
  normalizeInput,
  buildUserAgent,
  displayHost,
};
