'use strict';

const { Menu, clipboard } = require('electron');
const {
  APP_NAME,
  APP_VERSION,
  SEARCH_ENGINES,
  SEARCH_ENGINE_IDS,
  isNavigableUrl,
  normalizeInput,
} = require('./config');

function buildAppMenu(win) {
  const settings = win.store.data.settings;
  const activeTab = win.getTab(win.activeId);
  const activeUrl = activeTab && activeTab.url;

  const searchMenu = SEARCH_ENGINE_IDS.map((id) => ({
    label: SEARCH_ENGINES[id].label,
    type: 'radio',
    checked: settings.searchEngine === id,
    click: () => win.setSetting('searchEngine', id),
  }));

  const themeMenu = [
    {
      label: '跟随系统',
      type: 'radio',
      checked: settings.theme === 'system',
      click: () => win.setSetting('theme', 'system'),
    },
    {
      label: '浅色',
      type: 'radio',
      checked: settings.theme === 'light',
      click: () => win.setSetting('theme', 'light'),
    },
    {
      label: '深色',
      type: 'radio',
      checked: settings.theme === 'dark',
      click: () => win.setSetting('theme', 'dark'),
    },
  ];

  const template = [
    { label: '新建标签页', click: () => win.createTab('') },
    {
      label: '新建无痕窗口',
      accelerator: 'CmdOrCtrl+Shift+N',
      registerAccelerator: false,
      click: () => win.newIncognitoWindow(),
    },
    {
      label: '重新打开关闭的标签页',
      enabled: win.closedTabs.length > 0,
      click: () => win.reopenClosedTab(),
    },
    { type: 'separator' },
    {
      label: '书签栏',
      type: 'checkbox',
      checked: !!settings.bookmarksBar,
      click: (item) => win.setSetting('bookmarksBar', item.checked),
    },
    { label: '查找…', click: () => win.openFind() },
    {
      label: '缩放',
      submenu: [
        { label: '放大', click: () => win.zoomBy(1) },
        { label: '缩小', click: () => win.zoomBy(-1) },
        { label: '重置为 100%', click: () => win.resetZoom() },
      ],
    },
    {
      label: '全屏',
      type: 'checkbox',
      checked: !!win.win && win.win.isFullScreen(),
      click: () => win.toggleFullscreen(),
    },
    {
      label: activeTab && activeTab.devToolsOpen ? '关闭开发者工具' : '开发者工具',
      enabled: Boolean(activeTab && activeTab.view),
      click: () => win.toggleDevTools(),
    },
    { type: 'separator' },
    { label: '下载内容', click: () => win.showDownloadsBubble() },
    { label: '2048 小游戏', click: () => win.openGamePage() },
    {
      label: '设置',
      submenu: [
        { label: '外观', submenu: themeMenu },
        { label: '搜索引擎', submenu: searchMenu },
        {
          label: settings.downloadDir
            ? `当前下载位置：${settings.downloadDir.length > 42 ? `…${settings.downloadDir.slice(-40)}` : settings.downloadDir}`
            : '当前下载位置：系统默认',
          enabled: false,
        },
        { label: '下载文件夹…', click: () => win.chooseDownloadDir() },
        {
          label: '使用系统默认下载文件夹',
          enabled: !!settings.downloadDir,
          click: () => win.setSetting('downloadDir', ''),
        },
        { type: 'separator' },
        {
          label: '垂直标签页',
          type: 'checkbox',
          checked: !!settings.verticalTabs,
          click: (item) => win.setSetting('verticalTabs', item.checked),
        },
        {
          label: '启动时恢复上次的标签页',
          type: 'checkbox',
          checked: !!settings.restoreTabs,
          click: (item) => win.setSetting('restoreTabs', item.checked),
        },
        { type: 'separator' },
        {
          label: '将当前页面设为主页',
          enabled: !!activeUrl,
          click: () => activeTab && win.setSetting('homePage', activeTab.url),
        },
        {
          label: '使用新标签页作为主页',
          enabled: !!settings.homePage,
          click: () => win.setSetting('homePage', ''),
        },
        { type: 'separator' },
        { label: '清空历史记录', click: () => win.clearHistory() },
        { label: '清空 Cookie 和浏览记录', click: () => win.clearCookiesAndHistory() },
      ],
    },
    { type: 'separator' },
    { label: `关于 ${APP_NAME} ${APP_VERSION}`, click: () => win.showAbout() },
    { label: '退出', click: () => win.closeWindow() },
  ];

  return Menu.buildFromTemplate(template);
}

/**
 * 网页右键菜单：返回自绘菜单所需的条目和动作表。
 * @returns {{items: Array, actions: Map<string, Function>}}
 */
function buildPageMenu(win, tab, params) {
  const view = tab && tab.view;
  const wc = view && !view.webContents.isDestroyed() ? view.webContents : null;
  const actions = new Map();
  const items = [];

  if (!wc) return { items, actions };

  const add = (id, label, handler, extra = {}) => {
    actions.set(id, handler);
    items.push({ id, label, ...extra });
  };
  const separator = () => items.push({ type: 'separator' });

  const history = wc.navigationHistory;
  add('back', '后退', () => win.back(tab.id), {
    enabled: Boolean(history && history.canGoBack()),
    accelerator: 'Alt+←',
  });
  add('forward', '前进', () => win.forward(tab.id), {
    enabled: Boolean(history && history.canGoForward()),
    accelerator: 'Alt+→',
  });
  add('reload', '重新加载', () => win.reload(tab.id), { accelerator: 'Ctrl+R' });
  separator();

  if (params.linkURL && isNavigableUrl(params.linkURL)) {
    add('open-link', '在新标签页中打开链接', () => win.createTab(params.linkURL));
    add('copy-link', '复制链接地址', () => clipboard.writeText(params.linkURL), {
      accelerator: 'Ctrl+C',
    });
    separator();
  }

  if (params.mediaType === 'image' && params.srcURL) {
    add('open-image', '在新标签页中打开图片', () => win.createTab(params.srcURL));
    add('save-image', '图片另存为…', () => wc.downloadURL(params.srcURL));
    add('copy-image', '复制图片', () => wc.copyImageAt(params.x, params.y));
    separator();
  }

  if (params.selectionText) {
    const text = params.selectionText.trim();
    const label = text.length > 22 ? `${text.slice(0, 22)}…` : text;
    const engine = SEARCH_ENGINES[win.store.data.settings.searchEngine] || SEARCH_ENGINES.bing;
    add('copy-selection', '复制', () => wc.copy(), { accelerator: 'Ctrl+C' });
    add(
      'search-selection',
      `使用 ${engine.label} 搜索 “${label}”`,
      () => win.createTab(normalizeInput(text, win.store.data.settings)),
    );
    separator();
  }

  if (params.isEditable) {
    const flags = params.editFlags || {};
    add('cut', '剪切', () => wc.cut(), { enabled: flags.canCut !== false, accelerator: 'Ctrl+X' });
    add('copy', '复制', () => wc.copy(), { enabled: flags.canCopy !== false, accelerator: 'Ctrl+C' });
    add('paste', '粘贴', () => wc.paste(), { enabled: flags.canPaste !== false, accelerator: 'Ctrl+V' });
    add('select-all', '全选', () => wc.selectAll(), { accelerator: 'Ctrl+A' });
    separator();
  } else if (!params.selectionText) {
    add('select-all', '全选', () => wc.selectAll(), { accelerator: 'Ctrl+A' });
    separator();
  }

  add('inspect', '检查元素', () => win.inspectElementInTab(tab, params.x, params.y), {
    accelerator: 'F12',
  });

  return { items, actions };
}

function buildDownloadsMenu(win) {
  return Menu.buildFromTemplate([
    { label: '打开下载文件夹', click: () => win.openDownloadsFolder() },
    { label: '清除已结束的下载', click: () => win.clearDownloads() },
  ]);
}

module.exports = { buildAppMenu, buildPageMenu, buildDownloadsMenu };
