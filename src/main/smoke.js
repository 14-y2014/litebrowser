'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const APP_VERSION = require('../../package.json').version;

async function waitFor(predicate, timeout = 6000, interval = 100) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return true;
    await delay(interval);
  }
  return false;
}

module.exports = function runSmoke(win, api = {}) {
  const outDir = path.join(process.cwd(), 'test-output');
  const listWindows = typeof api.getWindows === 'function' ? api.getWindows : () => [win];
  const customDir = path.join(outDir, 'custom-downloads');
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(customDir, { recursive: true, force: true });

  const log = (...args) => console.log('[smoke]', ...args);
  const checks = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), detail });
    log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  };

  const chromeWc = win.chrome.webContents;
  chromeWc.on('console-message', (event) => {
    log(`renderer: ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  chromeWc.on('preload-error', (_event, preloadPath, error) => {
    log('preload-error', preloadPath, error && error.message);
  });

  const overlayEval = async (code) => {
    const wc = win.overlay && win.overlay.win && !win.overlay.win.isDestroyed()
      ? win.overlay.win.webContents
      : null;
    if (!wc) return null;
    return wc.executeJavaScript(code);
  };

  setTimeout(async () => {
    let failureCount = 0;
    try {
      if (win.win && win.win.isMinimized()) win.win.restore();
      win.focusWindow();
      await delay(200);
      const dom = await chromeWc.executeJavaScript(`(() => ({
        ready: document.body.dataset.ready,
        chromeHeight: Math.ceil(document.getElementById('chrome').getBoundingClientRect().height),
        tabCount: document.querySelectorAll('.tab').length,
        newTabVisible: !document.getElementById('newtab').classList.contains('hidden'),
        tileCount: document.querySelectorAll('.tile').length,
        hasShortcuts: Boolean(document.getElementById('nt-shortcuts')),
        logoLoaded: (() => {
          const img = document.querySelector('.nt-logo');
          return Boolean(img && img.complete && img.naturalWidth > 0);
        })(),
        engine: (document.getElementById('nt-engine') || {}).textContent || ''
      }))()`);
      log('DOM', JSON.stringify(dom));

      check('界面已初始化', dom.ready === 'true', dom.ready);
      check('初始只有一个标签页', dom.tabCount === 1, dom.tabCount);
      check('新标签页可见', dom.newTabVisible === true);
      check('起始页不展示常用网站卡片', dom.tileCount === 0 && dom.hasShortcuts === false, {
        tileCount: dom.tileCount,
        hasShortcuts: dom.hasShortcuts,
      });
      check('应用图标已加载', dom.logoLoaded === true);
      const tabLogo = await chromeWc.executeJavaScript(`(() => {
        const img = document.querySelector('.tab.active .tab-icon.app-logo img');
        return Boolean(img && img.getAttribute('src').includes('logo.svg'));
      })()`);
      check('起始页标签使用 LiteBrowser 图标', tabLogo === true);
      check('渲染进程上报了 chrome 高度', win.chromeHeight > 60, win.chromeHeight);
      check(
        '用户数据独立存放',
        win.store.file.includes(`${path.sep}data${path.sep}`) &&
          app.getPath('sessionData').endsWith(`${path.sep}browser-data`),
        { store: win.store.file, sessionData: app.getPath('sessionData') },
      );
      check('相同站点共享渲染进程已启用', app.commandLine.hasSwitch('process-per-site') === true);
      check('垂直标签页默认关闭', win.store.data.settings.verticalTabs === false);
      check('启动时恢复标签页默认开启', win.store.data.settings.restoreTabs === true);

      const { buildAppMenu, buildDownloadsMenu } = require('./menus');
      try {
        const appMenu = buildAppMenu(win);
        check('应用菜单可构建', appMenu.items.length > 10, appMenu.items.length);
        const downloadsMenu = buildDownloadsMenu(win);
        check('下载菜单可构建', downloadsMenu.items.length >= 2, downloadsMenu.items.length);
      } catch (error) {
        check('菜单可构建', false, error && error.message);
      }

      const pressChrome = (keyCode, modifiers = []) => {
        chromeWc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        chromeWc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      };

      win.setSetting('verticalTabs', true);
      await delay(700);
      const verticalInfo = await chromeWc.executeJavaScript(`(() => ({
        bodyClass: document.body.classList.contains('vertical-tabs'),
        tabstripWidth: Math.round(document.getElementById('tabstrip').getBoundingClientRect().width),
        mainHeight: Math.round(document.getElementById('chrome-main').getBoundingClientRect().height),
        tabsDirection: getComputedStyle(document.getElementById('tabs')).flexDirection
      }))()`);
      check(
        '垂直标签页布局生效',
        verticalInfo.bodyClass === true &&
          verticalInfo.tabstripWidth >= 200 &&
          verticalInfo.mainHeight > 40 &&
          verticalInfo.tabsDirection === 'column',
        verticalInfo,
      );
      check(
        '垂直标签页让出左侧页面区域',
        win.layoutVertical === true && win.pageLeft() >= 200,
        { vertical: win.layoutVertical, left: win.pageLeft(), top: win.pageTop() },
      );
      fs.writeFileSync(
        path.join(outDir, 'vertical-tabs.png'),
        (await win.chrome.webContents.capturePage()).toPNG(),
      );
      win.setSetting('verticalTabs', false);
      await delay(600);
      const horizontalInfo = await chromeWc.executeJavaScript(`(() => ({
        bodyClass: document.body.classList.contains('vertical-tabs'),
        tabsDirection: getComputedStyle(document.getElementById('tabs')).flexDirection
      }))()`);
      check(
        '垂直标签页可以关闭',
        horizontalInfo.bodyClass === false &&
          horizontalInfo.tabsDirection === 'row' &&
          win.layoutVertical === false &&
          win.pageLeft() === 0,
        horizontalInfo,
      );

      pressChrome('T', ['control']);
      await delay(450);
      check('Ctrl+T 新建标签页', win.tabs.length === 2, win.tabs.length);
      const blankInfo = await chromeWc.executeJavaScript(`(() => ({
        url: document.getElementById('url-input').value,
        newTabVisible: !document.getElementById('newtab').classList.contains('hidden')
      }))()`);
      check('新建标签页不携带链接', blankInfo.url === '', blankInfo.url);
      check('新建标签页显示起始页', blankInfo.newTabVisible === true);

      const orderBefore = win.tabs.map((tab) => tab.id);
      const dragged = await chromeWc.executeJavaScript(`(() => {
        const tabs = Array.from(document.querySelectorAll('.tab'));
        if (tabs.length < 2) return false;
        const first = tabs[0];
        const second = tabs[1];
        const firstRect = first.getBoundingClientRect();
        const secondRect = second.getBoundingClientRect();
        const point = (x) => ({
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: firstRect.top + 12,
          button: 0,
          buttons: 1,
          pointerId: 7,
          pointerType: 'mouse',
          isPrimary: true
        });
        first.dispatchEvent(new PointerEvent('pointerdown', point(firstRect.left + 20)));
        document.dispatchEvent(new PointerEvent('pointermove', point(secondRect.right - 12)));
        document.dispatchEvent(new PointerEvent('pointermove', point(secondRect.right + 30)));
        document.dispatchEvent(new PointerEvent('pointerup', point(secondRect.right + 30)));
        return true;
      })()`);
      await delay(500);
      check(
        '拖拽标签页可调整顺序',
        dragged === true && win.tabs[0].id === orderBefore[1] && win.tabs[1].id === orderBefore[0],
        win.tabs.map((tab) => tab.id),
      );
      const domOrder = await chromeWc.executeJavaScript(
        `[...document.querySelectorAll('.tab')].map((el) => Number(el.dataset.id))`,
      );
      check(
        '标签页顺序同步到界面',
        JSON.stringify(domOrder) === JSON.stringify(win.tabs.map((tab) => tab.id)),
        domOrder,
      );

      const clickedClose = await chromeWc.executeJavaScript(`(() => {
        const button = document.querySelector('.tab.active .tab-close');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      await delay(450);
      check('点击标签页关闭按钮', clickedClose === true && win.tabs.length === 1, win.tabs.length);

      fs.writeFileSync(
        path.join(outDir, 'chrome-newtab.png'),
        (await chromeWc.capturePage()).toPNG(),
      );

      // 本地测试服务：普通页面、第二页、慢速下载文件
      const testFavicon =
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%232f6fed'/%3E%3Ctext x='16' y='23' font-size='20' fill='white' text-anchor='middle'%3EL%3C/text%3E%3C/svg%3E";
      const pageHtml =
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>LiteBrowser 测试页</title>' +
        `<link rel="icon" href="${testFavicon}">` +
        '<style>body{margin:0;height:100vh;display:grid;place-items:center;font-family:system-ui;' +
        'background:linear-gradient(140deg,#eef4ff,#ffffff)}h1{font-size:32px;color:#1f2937}' +
        'p{color:#64748b}</style></head><body><div style="text-align:center">' +
        '<h1>LiteBrowser 页面视图正常</h1><p>WebContentsView · 多标签 · 布局测试</p></div></body></html>';
      const page2Html =
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>LiteBrowser 第二页</title>' +
        `<link rel="icon" href="${testFavicon}">` +
        '<style>body{font-family:system-ui;background:#f5f7fb;padding:40px}</style></head><body>' +
        '<h1>LiteBrowser 第二页</h1><p>用于验证标签历史持久化。</p></body></html>';
      const slowSize = 40 * 20000;
      const server = http.createServer((request, response) => {
        if (request.url === '/slow.bin') {
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(slowSize),
          });
          let sent = 0;
          const timer = setInterval(() => {
            if (sent >= 40) {
              clearInterval(timer);
              response.end();
              return;
            }
            response.write(Buffer.alloc(20000, 7));
            sent += 1;
          }, 70);
          response.on('close', () => clearInterval(timer));
          return;
        }
        const html = request.url === '/page2' ? page2Html : pageHtml;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const origin = `http://127.0.0.1:${server.address().port}`;
      const pageUrl = `${origin}/`;
      const page2Url = `${origin}/page2`;
      const slowUrl = `${origin}/slow.bin`;

      win.createTab('');
      const pageTab = win.tabs[win.tabs.length - 1];
      await chromeWc.executeJavaScript(`(() => {
        const input = document.getElementById('url-input');
        input.focus();
        input.value = ${JSON.stringify(pageUrl)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return input.value;
      })()`);
      chromeWc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      chromeWc.sendInputEvent({ type: 'char', keyCode: '\r' });
      chromeWc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await waitFor(() => pageTab.url === pageUrl, 4000);
      if (pageTab.url !== pageUrl) {
        win.selectTab(pageTab.id);
        await chromeWc.executeJavaScript(`(() => {
          const input = document.getElementById('url-input');
          input.focus();
          input.value = ${JSON.stringify(pageUrl)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        chromeWc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        chromeWc.sendInputEvent({ type: 'char', keyCode: '\r' });
        chromeWc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        await waitFor(() => pageTab.url === pageUrl, 4000);
      }
      await waitFor(() => pageTab.title === 'LiteBrowser 测试页', 5000);

      check('地址栏回车可导航', pageTab.url === pageUrl, pageTab.url);
      check('页面视图已创建', Boolean(pageTab.view), Boolean(pageTab.view));
      check('页面标题已更新', pageTab.title === 'LiteBrowser 测试页', pageTab.title);
      check(
        '布局：页面从 chrome 下方开始',
        pageTab.view && pageTab.view.getBounds().y === win.chromeHeight,
        pageTab.view && pageTab.view.getBounds(),
      );

      const pageWc = pageTab.view.webContents;
      log('tab count after page load', win.tabs.length);

      // 主题：深色 / 浅色 / 跟随系统，并传给网站
      win.setSetting('theme', 'dark');
      await delay(600);
      const darkUi = await chromeWc.executeJavaScript(`({
        attr: document.documentElement.dataset.theme,
        dark: matchMedia('(prefers-color-scheme: dark)').matches
      })`);
      const pageDark = await pageWc.executeJavaScript(`matchMedia('(prefers-color-scheme: dark)').matches`);
      check('深色主题应用到界面', darkUi.attr === 'dark', darkUi);
      check('深色主题传给网站', pageDark === true, pageDark);

      // 深色界面截图：查找栏 / 错误提示，便于检查对比度
      win.openFind();
      await delay(500);
      fs.writeFileSync(
        path.join(outDir, 'chrome-dark-find.png'),
        (await chromeWc.capturePage()).toPNG(),
      );
      win.closeFind();
      await delay(300);
      const activeTabForError = win.getTab(win.activeId);
      if (activeTabForError) {
        activeTabForError.error = { code: -105, description: '无法访问此网站。' };
        win.broadcast();
        await delay(400);
        fs.writeFileSync(
          path.join(outDir, 'chrome-dark-error.png'),
          (await chromeWc.capturePage()).toPNG(),
        );
        activeTabForError.error = null;
        win.broadcast();
        await delay(300);
      }

      win.setSetting('theme', 'light');
      await delay(600);
      const lightUi = await chromeWc.executeJavaScript(
        `document.documentElement.dataset.theme`,
      );
      const pageLight = await pageWc.executeJavaScript(`matchMedia('(prefers-color-scheme: dark)').matches`);
      check('浅色主题应用到界面', lightUi === 'light', lightUi);
      check('浅色主题传给网站', pageLight === false, pageLight);
      win.setSetting('theme', 'system');
      await delay(500);
      check('主题默认可跟随系统', win.serialize().theme.source === 'system', win.serialize().theme);

      // 标签历史持久化
      win.loadUrl(pageTab, page2Url);
      await delay(1200);
      win.persistSession();
      const savedSpec = win.store.data.session.tabs.find(
        (tab) => tab.entries.some((entry) => entry.url === page2Url),
      );
      check(
        '标签历史写入会话',
        Boolean(savedSpec && savedSpec.entries.length >= 2 && savedSpec.index >= 1),
        savedSpec,
      );
      if (savedSpec) {
        win.createRestoredTab(savedSpec);
        await delay(1000);
        const restoredTab = win.tabs[win.tabs.length - 1];
        const restoredHistory = restoredTab.view && !restoredTab.view.webContents.isDestroyed()
          ? restoredTab.view.webContents.navigationHistory
          : null;
        check(
          '标签页历史可以恢复',
          Boolean(restoredHistory && restoredHistory.canGoBack()),
          restoredHistory
            ? restoredHistory.getAllEntries().map((entry) => entry.url)
            : null,
        );
        check(
          '相同站点标签共享渲染进程',
          pageWc.getProcessId() === restoredTab.view.webContents.getProcessId(),
          {
            pagePid: pageWc.getProcessId(),
            restoredPid: restoredTab.view.webContents.getProcessId(),
          },
        );
        win.closeTab(restoredTab.id);
        await delay(400);
        win.selectTab(pageTab.id);
        await delay(300);
        log('tab count after history restore', win.tabs.length);
      }

      // 下载：自定义目录
      win.setSetting('downloadDir', customDir);
      await delay(250);
      const downloadUrl = `data:text/plain;charset=utf-8,${encodeURIComponent('LiteBrowser download smoke test')}`;
      pageWc.downloadURL(downloadUrl);
      await delay(1300);
      const smallDownload = win.downloads.find(
        (item) => item.filename === 'download.txt' && item.state === 'completed',
      );
      check(
        '自定义下载目录生效',
        Boolean(smallDownload && smallDownload.path.startsWith(customDir)),
        smallDownload && smallDownload.path,
      );
      check(
        '下载文件写入自定义目录',
        Boolean(
          smallDownload &&
            fs.existsSync(smallDownload.path) &&
            fs.statSync(smallDownload.path).size > 0,
        ),
        smallDownload && smallDownload.path,
      );

      // 慢速下载：暂停 / 继续 / 进度环
      pageWc.downloadURL(slowUrl);
      await delay(800);
      const slowDownload = win.downloads.find((item) => item.url === slowUrl);
      check('慢速下载已开始', Boolean(slowDownload && slowDownload.state === 'progressing'));
      if (slowDownload) {
        const ringInfo = await chromeWc.executeJavaScript(`(() => {
          const button = document.getElementById('btn-downloads');
          const ring = document.querySelector('.dl-ring-progress');
          return {
            hidden: button.classList.contains('hidden'),
            downloading: button.classList.contains('downloading'),
            offset: ring ? parseFloat(getComputedStyle(ring).strokeDashoffset) : -1
          };
        })()`);
        check(
          '下载按钮显示进度环',
          ringInfo.hidden === false && ringInfo.downloading === true && ringInfo.offset > 0,
          ringInfo,
        );
        fs.writeFileSync(
          path.join(outDir, 'chrome-downloads.png'),
          (await chromeWc.capturePage()).toPNG(),
        );

        win.showDownloadsBubble();
        await delay(800);
        const activeRowInfo = await overlayEval(`(() => {
          const row = [...document.querySelectorAll('.dl-row')].find(
            (el) => el.querySelector('.dl-name').textContent === 'slow.bin'
          );
          if (!row) return null;
          return {
            clickable: row.classList.contains('clickable'),
            hasPause: Boolean(row.querySelector('.dl-pause:not(.hidden)'))
          };
        })()`);
        check(
          '下载中的文件禁止打开',
          Boolean(activeRowInfo && activeRowInfo.clickable === false),
          activeRowInfo,
        );
        check(
          '下载中显示暂停按钮',
          Boolean(activeRowInfo && activeRowInfo.hasPause === true),
          activeRowInfo,
        );
        const activeMenuDispatched = await overlayEval(`(() => {
          const row = [...document.querySelectorAll('.dl-row')].find(
            (el) => el.querySelector('.dl-name').textContent === 'slow.bin'
          );
          if (!row) return false;
          const rect = row.getBoundingClientRect();
          row.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + 30,
            clientY: rect.top + 12
          }));
          return true;
        })()`);
        await delay(800);
        const activeMenuLabels = win.overlay.mode === 'menu'
          ? await overlayEval(`[...document.querySelectorAll('.menu-label')].map((el) => el.textContent)`)
          : [];
        check('下载中右键事件', activeMenuDispatched === true);
        check(
          '下载中右键菜单项',
          ['重新下载', '复制下载地址', '在列表中删除', '取消并删除'].every((label) =>
            activeMenuLabels.includes(label),
          ),
          activeMenuLabels,
        );
        win.overlay.hide();
        await delay(300);

        win.pauseDownload(slowDownload.id);
        await delay(500);
        check(
          '下载支持暂停',
          slowDownload.paused === true,
          { paused: slowDownload.paused, state: slowDownload.state },
        );
        win.resumeDownload(slowDownload.id);
        await delay(300);
        for (let i = 0; i < 60 && slowDownload.state !== 'completed'; i += 1) {
          await delay(200);
        }
        check('下载支持继续', slowDownload.state === 'completed', slowDownload.state);
        check(
          '慢速下载文件完整',
          fs.existsSync(slowDownload.path) &&
            fs.statSync(slowDownload.path).size === slowSize,
          slowDownload.path,
        );
      }

      // 下载气泡 + 右键菜单
      win.showDownloadsBubble();
      await delay(900);
      const bubbleOpen = win.overlay.isVisible() && win.overlay.mode === 'downloads';
      const bubbleRows = bubbleOpen
        ? await overlayEval(`document.querySelectorAll('.dl-row').length`)
        : 0;
      check('下载气泡打开', bubbleOpen === true);
      check('下载气泡显示下载记录', bubbleRows >= 2, bubbleRows);
      if (bubbleOpen) {
        fs.writeFileSync(
          path.join(outDir, 'overlay-downloads.png'),
          (await win.overlay.win.webContents.capturePage()).toPNG(),
        );
      }
      const rowMenuDispatched = await overlayEval(`(() => {
        const row = [...document.querySelectorAll('.dl-row')].find(
          (el) => el.querySelector('.dl-name').textContent === 'download.txt'
        );
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 30,
          clientY: rect.top + 12
        }));
        return true;
      })()`);
      await delay(800);
      const rowMenuOpen = win.overlay.mode === 'menu' && win.overlay.isVisible();
      const rowMenuLabels = rowMenuOpen
        ? await overlayEval(`[...document.querySelectorAll('.menu-label')].map((el) => el.textContent)`)
        : [];
      check('下载项右键事件', rowMenuDispatched === true);
      check('下载项右键菜单打开', rowMenuOpen === true);
      check(
        '已完成下载菜单项',
        ['重新下载', '复制下载地址', '打开文件所在的文件夹', '在列表中删除', '删除文件'].every(
          (label) => rowMenuLabels.includes(label),
        ),
        rowMenuLabels,
      );
      if (rowMenuOpen) {
        await overlayEval(
          `[...document.querySelectorAll('.menu-item')].find((el) => el.textContent.includes('重新下载')).click()`,
        );
        await delay(1600);
      }
      const redownloaded = win.downloads.find(
        (item) => item.filename === 'download.txt' && item.state === 'completed',
      );
      check('重新下载可以创建新任务', Boolean(redownloaded), redownloaded && redownloaded.id);
      const smallPath = smallDownload ? smallDownload.path : '';
      if (redownloaded) {
        win.deleteDownloadFile(redownloaded.id);
        await delay(300);
        check('删除下载文件', !fs.existsSync(smallPath), smallPath);
      }
      if (slowDownload) win.removeDownloadFromList(slowDownload.id);
      await delay(300);
      check('在列表中删除下载项', win.downloads.length === 0, win.downloads.length);
      win.overlay.hide();
      await delay(300);

      // 历史记录：网站图标 / 右键删除 / 一键清空
      const historyBlankTab = win.tabs.find((tab) => !tab.url);
      if (historyBlankTab) {
        win.selectTab(historyBlankTab.id);
        await delay(1000);
        const historyInfo = await chromeWc.executeJavaScript(`(() => {
          const items = [...document.querySelectorAll('.recent-item')];
          const image = items[0] ? items[0].querySelector('img') : null;
          return {
            count: items.length,
            heading: (document.querySelector('#nt-recent-section h2') || {}).textContent || '',
            hasImage: Boolean(image),
            imageLoaded: Boolean(image && image.complete && image.naturalWidth > 0)
          };
        })()`);
        check('历史记录显示网站图标', historyInfo.count >= 1 && historyInfo.hasImage === true, historyInfo);
        check(
          '历史记录保存网站图标',
          win.store.data.history.some((item) => item.favicon && item.favicon.startsWith('data:image')),
          win.store.data.history.map((item) => ({ url: item.url, favicon: Boolean(item.favicon) })),
        );
        check('历史记录标题正确', historyInfo.heading === '历史记录', historyInfo.heading);
        fs.writeFileSync(
          path.join(outDir, 'chrome-history.png'),
          (await chromeWc.capturePage()).toPNG(),
        );

        const historyMenuDispatched = await chromeWc.executeJavaScript(`(() => {
          const item = document.querySelector('.recent-item');
          if (!item) return false;
          const rect = item.getBoundingClientRect();
          item.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + 20,
            clientY: rect.top + 10
          }));
          return true;
        })()`);
        await delay(800);
        const historyMenuOpen = win.overlay.mode === 'menu' && win.overlay.isVisible();
        const historyMenuLabels = historyMenuOpen
          ? await overlayEval(`[...document.querySelectorAll('.menu-label')].map((el) => el.textContent)`)
          : [];
        check('历史记录右键事件', historyMenuDispatched === true);
        check(
          '历史记录右键菜单可删除',
          historyMenuOpen === true && historyMenuLabels.includes('删除这条记录'),
          historyMenuLabels,
        );
        const historyBeforeDelete = win.store.data.history.length;
        if (historyMenuOpen) {
          await overlayEval(
            `[...document.querySelectorAll('.menu-item')].find((el) => el.textContent.includes('删除这条记录')).click()`,
          );
          await delay(450);
        }
        check(
          '右键删除单条历史记录',
          win.store.data.history.length === historyBeforeDelete - 1,
          win.store.data.history.length,
        );

        await chromeWc.executeJavaScript(`document.getElementById('clear-history').click()`);
        await delay(500);
        const historyCleared = await chromeWc.executeJavaScript(
          `document.getElementById('nt-recent-section').classList.contains('hidden')`,
        );
        check('一键清空历史记录', win.store.data.history.length === 0 && historyCleared === true, {
          remaining: win.store.data.history.length,
          hidden: historyCleared,
        });
        win.selectTab(pageTab.id);
        await delay(400);
      }

      // 书签 + 网站图标
      const faviconData =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      win.toggleBookmark('https://example.com', 'Example Domain', faviconData);
      await delay(250);
      const storedBookmark = win.store.data.bookmarks.find((item) => item.url === 'https://example.com');
      check('书签保存网站图标', Boolean(storedBookmark && storedBookmark.favicon === faviconData));
      const bookmarkIconVisible = await chromeWc.executeJavaScript(
        `Boolean(document.querySelector('#bookmarks-bar .bookmark img'))`,
      );
      check('收藏项显示网站图标', bookmarkIconVisible === true);

      // 带图标书签的起始页截图
      win.toggleBookmark('https://www.bing.com', 'Bing', 'https://www.bing.com/favicon.ico');
      win.toggleBookmark('https://github.com', 'GitHub', 'https://github.com/favicon.ico');
      win.toggleBookmark('https://www.bilibili.com', '哔哩哔哩', 'https://www.bilibili.com/favicon.ico');
      await delay(1500);
      const blankTab = win.tabs.find((tab) => !tab.url);
      if (blankTab) {
        win.clearHistory();
        win.selectTab(blankTab.id);
        await delay(600);
        const faviconCount = await chromeWc.executeJavaScript(`Array.from(
          document.querySelectorAll('#bookmarks-bar .bookmark img')
        ).filter((img) => img.complete && img.naturalWidth > 0).length`);
        check('收藏项网站图标加载', faviconCount >= 2, faviconCount);
        fs.writeFileSync(
          path.join(outDir, 'chrome-bookmarks.png'),
          (await chromeWc.capturePage()).toPNG(),
        );
        win.selectTab(pageTab.id);
        await delay(500);
      }
      const docBookmarkUrls = new Set([
        'https://www.bing.com',
        'https://github.com',
        'https://www.bilibili.com',
      ]);
      win.store.data.bookmarks = win.store.data.bookmarks.filter(
        (item) => !docBookmarkUrls.has(item.url),
      );
      win.broadcast();
      await delay(500);

      // 书签右键菜单删除
      if (storedBookmark) {
        const dispatched = await chromeWc.executeJavaScript(`(() => {
          const el = [...document.querySelectorAll('#bookmarks-bar .bookmark')].find(
            (item) => item.dataset.url === 'https://example.com'
          );
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + 22,
            clientY: rect.top + 10
          }));
          return true;
        })()`);
        await delay(800);
        const menuOpen = win.overlay.isVisible();
        const menuItemCount = await overlayEval(`document.querySelectorAll('.menu-item').length`);
        check('收藏项右键事件触发菜单', dispatched === true);
        check('收藏项右键菜单打开', menuOpen === true);
        check('收藏项菜单渲染完整', menuItemCount === 4, menuItemCount);
        const menuAccels = await overlayEval(`Array.from(
          document.querySelectorAll('.menu-item .menu-accel')
        ).map((node) => node.textContent)`);
        check(
          '右键菜单显示键盘快捷键',
          Array.isArray(menuAccels) && menuAccels.includes('Ctrl+C') && menuAccels.includes('Del'),
          menuAccels,
        );
        if (menuOpen) {
          fs.writeFileSync(
            path.join(outDir, 'overlay-menu.png'),
            (await win.overlay.win.webContents.capturePage()).toPNG(),
          );
          const acceleratorHandled = await overlayEval(`(() => {
            const event = new KeyboardEvent('keydown', {
              key: 'Delete',
              bubbles: true,
              cancelable: true
            });
            document.dispatchEvent(event);
            return event.defaultPrevented;
          })()`);
          check('右键菜单快捷键可执行', acceleratorHandled === true, acceleratorHandled);
          await delay(450);
        }
        check(
          '右键菜单可以删除书签',
          !win.store.data.bookmarks.some((item) => item.url === 'https://example.com'),
        );
      }

      // 网页右键菜单
      win.showPageContextMenu(pageTab, {
        x: 320,
        y: 220,
        linkURL: '',
        srcURL: '',
        mediaType: 'none',
        selectionText: '',
        isEditable: false,
        editFlags: {},
      });
      await delay(800);
      const pageMenuOpen = win.overlay.isVisible();
      const pageMenuCount = pageMenuOpen
        ? await overlayEval(`document.querySelectorAll('.menu-item').length`)
        : 0;
      check('网页右键菜单打开', pageMenuOpen === true);
      check('网页右键菜单有可选项', pageMenuCount >= 3, pageMenuCount);
      win.overlay.hide();
      await delay(300);

      // 内嵌开发者工具
      log('devtools target', JSON.stringify({
        activeId: win.activeId,
        pageTabId: pageTab.id,
        tabs: win.tabs.map((tab) => ({ id: tab.id, url: tab.url, hasView: Boolean(tab.view) })),
      }));
      const windowWidth = win.win.getContentSize()[0];
      win.toggleDevTools();
      await delay(2500);
      const devView = pageTab.devToolsView;
      if (devView) {
        for (let i = 0; i < 10 && devView.webContents.isLoading(); i += 1) await delay(200);
        await delay(400);
      }
      const pageBoundsWithDevtools = pageTab.view.getBounds();
      const devBounds = devView ? devView.getBounds() : null;
      if (devView) {
        fs.writeFileSync(
          path.join(outDir, 'devtools-view.png'),
          (await devView.webContents.capturePage()).toPNG(),
        );
      }
      check('开发者工具已打开', pageTab.devToolsOpen === true && Boolean(devView));
      check(
        '开发者工具嵌在窗口内',
        Boolean(
          devBounds &&
            devBounds.x === pageBoundsWithDevtools.width &&
            devBounds.width > 300 &&
            pageBoundsWithDevtools.width < windowWidth,
        ),
        { pageBounds: pageBoundsWithDevtools, devBounds },
      );
      win.toggleDevTools();
      await waitFor(() => pageTab.devToolsOpen === false && pageTab.devToolsView === null, 5000);
      check('开发者工具可关闭', pageTab.devToolsOpen === false && pageTab.devToolsView === null);
      check('关闭后页面恢复全宽', pageTab.view.getBounds().width === windowWidth);

      win.setSetting('verticalTabs', true);
      await waitFor(() => win.layoutVertical === true && win.pageLeft() >= 200, 5000);
      const verticalPageBounds = pageTab.view.getBounds();
      check(
        '垂直标签页下页面区域正确',
        verticalPageBounds.x >= 200 &&
          verticalPageBounds.y === win.pageTop() &&
          verticalPageBounds.width === windowWidth - 220,
        verticalPageBounds,
      );
      win.setSetting('verticalTabs', false);
      await waitFor(() => win.layoutVertical === false && win.pageLeft() === 0, 5000);

      // 标签页压缩
      log('tab count before compression', win.tabs.length);
      const extraTabs = [];
      for (let i = 0; i < 9; i += 1) extraTabs.push(win.createTab(''));
      await delay(700);
      const tabLayout = await chromeWc.executeJavaScript(`(() => {
        const tabs = [...document.querySelectorAll('.tab')];
        const widths = tabs.map((tab) => Math.round(tab.getBoundingClientRect().width));
        const closeEl = document.querySelector('.tab:not(.active) .tab-close');
        return {
          widths,
          count: tabs.length,
          compact: document.getElementById('tabs').classList.contains('compact'),
          hiddenClose: closeEl ? getComputedStyle(closeEl).display === 'none' : false
        };
      })()`);
      check(
        '标签页超宽时压缩宽度',
        tabLayout.count >= 10 &&
          Math.max(...tabLayout.widths) < 216 &&
          Math.min(...tabLayout.widths) > 0,
        tabLayout.widths,
      );
      check(
        '压缩时隐藏部分关闭按钮',
        tabLayout.compact === true && tabLayout.hiddenClose === true,
        tabLayout,
      );
      extraTabs.forEach((id) => win.closeTab(id));
      await delay(600);
      win.selectTab(pageTab.id);
      await delay(300);

      // 书签增删
      win.toggleBookmark('https://example.org', 'Example Org', '');
      check(
        '书签已添加',
        win.store.data.bookmarks.some((item) => item.url === 'https://example.org'),
      );
      win.toggleBookmark('https://example.org', 'Example Org', '');
      check(
        '书签已移除',
        !win.store.data.bookmarks.some((item) => item.url === 'https://example.org'),
      );

      // 标签页关闭与恢复
      const beforeClose = win.tabs.length;
      win.closeTab(pageTab.id);
      check('关闭标签页后数量减少', win.tabs.length === beforeClose - 1, win.tabs.length);
      win.reopenClosedTab();
      check('可恢复关闭的标签页', win.tabs.length === beforeClose, win.tabs.length);

      win.selectTab(win.tabs[0].id);
      await delay(300);

      // 无痕窗口
      if (typeof api.createIncognitoWindow === 'function') {
        const normalCount = listWindows().length;
        const incognito = api.createIncognitoWindow();
        await delay(1200);
        const incognitoWc = incognito.chrome.webContents;
        const incognitoInfo = await incognitoWc.executeJavaScript(`(() => ({
          badge: !document.getElementById('incognito-badge').classList.contains('hidden'),
          bodyClass: document.body.classList.contains('incognito'),
          engine: document.getElementById('nt-engine').textContent,
          newTabVisible: !document.getElementById('newtab').classList.contains('hidden')
        }))()`);
        check(
          '无痕窗口已创建',
          incognito.incognito === true &&
            listWindows().length === normalCount + 1 &&
            incognito.store.file === '' &&
            incognito.partition === 'incognito',
          { incognito: incognito.incognito, file: incognito.store.file },
        );
        check(
          '无痕窗口默认使用 DuckDuckGo',
          incognito.store.data.settings.searchEngine === 'duckduckgo' &&
            incognitoInfo.engine === 'DuckDuckGo',
          incognitoInfo.engine,
        );
        check(
          '无痕窗口不恢复标签页',
          incognito.store.data.settings.restoreTabs === false &&
            incognito.store.data.history.length === 0,
        );
        check(
          '无痕窗口有独立标识',
          incognitoInfo.badge === true &&
            incognitoInfo.bodyClass === true &&
            incognitoInfo.newTabVisible === true &&
            incognito.win.getTitle().includes('无痕'),
          incognitoInfo,
        );
        fs.writeFileSync(
          path.join(outDir, 'incognito.png'),
          (await incognitoWc.capturePage()).toPNG(),
        );
        incognito.closeWindow();
        await delay(700);
        check(
          '无痕窗口可以关闭',
          incognito._destroyed === true && listWindows().length === normalCount,
          { destroyed: incognito._destroyed, windows: listWindows().length },
        );
      }

      // 2048 离线小游戏
      win.openGamePage();
      await delay(1400);
      const gameTab = win.tabs.find((tab) => tab.url.startsWith('file://'));
      const gameInfo = gameTab && gameTab.view
        ? await gameTab.view.webContents.executeJavaScript(`(() => ({
            title: document.title,
            cells: document.querySelectorAll('#grid .cell').length,
            tiles: document.querySelectorAll('#grid .cell[data-value="2"], #grid .cell[data-value="4"]').length,
            score: document.getElementById('score').textContent
          }))()`)
        : null;
      check(
        '2048 小游戏可以打开',
        Boolean(gameTab) && gameInfo && gameInfo.title === '2048',
        gameInfo,
      );
      check(
        '2048 棋盘与初始方块正常',
        Boolean(gameInfo) && gameInfo.cells === 16 && gameInfo.tiles === 2,
        gameInfo,
      );
      if (gameTab) {
        const gameKeyboard = await gameTab.view.webContents.executeJavaScript(`(() => {
          const snapshot = () => Array.from(document.querySelectorAll('#grid .cell'))
            .map((cell) => cell.getAttribute('data-value')).join(',');
          const states = [snapshot()];
          for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']) {
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key,
              bubbles: true,
              cancelable: true
            }));
            states.push(snapshot());
          }
          return {
            distinct: new Set(states).size,
            score: document.getElementById('score').textContent
          };
        })()`);
        check(
          '2048 方向键可以移动方块',
          gameKeyboard.distinct > 1 || Number(gameKeyboard.score) > 0,
          gameKeyboard,
        );
        fs.writeFileSync(
          path.join(outDir, 'game-2048.png'),
          (await gameTab.view.webContents.capturePage()).toPNG(),
        );
        win.closeTab(gameTab.id);
        await delay(400);
      }

      // 双击关闭标签页
      const doubleClickTab = win.createTab('');
      await delay(400);
      const beforeDoubleClick = win.tabs.length;
      const dispatchedDoubleClick = await chromeWc.executeJavaScript(`(() => {
        const tab = document.querySelector('.tab.active');
        if (!tab) return false;
        tab.dispatchEvent(new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          view: window
        }));
        return true;
      })()`);
      await delay(600);
      check(
        '双击标签页可以关闭',
        dispatchedDoubleClick === true && win.tabs.length === beforeDoubleClick - 1,
        { dispatched: dispatchedDoubleClick, tabs: win.tabs.length },
      );
      check('双击关闭的标签页已移除', !win.tabs.some((tab) => tab.id === doubleClickTab));

      win.toggleMaximize();
      await delay(500);
      check('窗口可最大化', win.win.isMaximized() === true, win.win.isMaximized());
      win.toggleMaximize();
      await delay(500);
      check('窗口可还原', win.win.isMaximized() === false, win.win.isMaximized());

      const snapshot = win.serialize();
      check(
        '状态快照包含正确版本号',
        snapshot.versions.app === APP_VERSION,
        snapshot.versions.app,
      );
      check('状态快照包含标签页数据', snapshot.tabs.length >= 1, snapshot.tabs.length);

      failureCount = checks.filter((item) => !item.passed).length;
    } catch (error) {
      failureCount += 1;
      log('ERROR', error && (error.stack || error.message));
    }

    log(`SUMMARY ${checks.length - failureCount}/${checks.length} passed, failures=${failureCount}`);
    try {
      win.store.flush();
    } catch {
      /* ignore */
    }
    setTimeout(() => app.exit(failureCount ? 1 : 0), 150);
  }, 2400);
};
