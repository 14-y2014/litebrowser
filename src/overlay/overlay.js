'use strict';

(() => {
  const api = window.overlay;
  const panel = document.getElementById('panel');

  let mode = null;
  let listEl = null;
  let emptyEl = null;
  let footerEl = null;
  let menuEntries = [];
  const rows = new Map();

  const FILE_ICON = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 3h7l5 5v12.5A1.5 1.5 0 0 1 17 22H6.5A1.5 1.5 0 0 1 5 20.5v-16A1.5 1.5 0 0 1 6.5 3z"
        fill="#ffffff" stroke="#8aa8c8" stroke-width="1.2" />
      <path d="M13.5 3v4.5a1 1 0 0 0 1 1H18" fill="#dbe8f7" stroke="#8aa8c8" stroke-width="1.2"
        stroke-linejoin="round" />
      <path d="M8.5 12.5h7M8.5 15.5h7M8.5 18.5h4.5" stroke="#8aa8c8" stroke-width="1.2"
        stroke-linecap="round" />
    </svg>
  `;
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>';
  const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';

  const formatBytes = (value) => {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  const formatSpeed = (value) => {
    const speed = Number(value) || 0;
    if (speed <= 0) return '';
    return `${formatBytes(speed)}/s`;
  };

  function applyTheme(theme) {
    const dark = Boolean(theme && theme.dark);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }

  function measure() {
    const rect = panel.getBoundingClientRect();
    api.measured({ width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
  }

  function scheduleMeasure() {
    measure();
    requestAnimationFrame(measure);
  }

  function replayAnimation() {
    panel.classList.remove('visible');
    void panel.offsetWidth;
    requestAnimationFrame(() => panel.classList.add('visible'));
  }

  /* ------------------------------------------------------------------ */
  /* 菜单                                                                */
  /* ------------------------------------------------------------------ */

  function renderMenu(payload) {
    menuEntries = [];
    if (mode !== 'menu') {
      mode = 'menu';
      rows.clear();
      listEl = null;
      emptyEl = null;
      footerEl = null;
      panel.classList.remove('downloads');
      panel.classList.add('menu');
      panel.replaceChildren();
      menuEntries = [];
    }
    panel.style.width = `${Math.max(
      180,
      Number(payload.width) || ((payload.items || []).some((item) => item.accelerator) ? 272 : 236),
    )}px`;

    const fragment = document.createDocumentFragment();
    for (const item of payload.items || []) {
      if (item.type === 'separator') {
        const separator = document.createElement('div');
        separator.className = 'menu-sep';
        fragment.appendChild(separator);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `menu-item${item.danger ? ' danger' : ''}`;
      button.disabled = item.enabled === false;

      const check = document.createElement('span');
      check.className = 'menu-check';
      check.textContent = item.checked ? '✓' : '';
      button.appendChild(check);

      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = item.label || '';
      button.appendChild(label);

      if (item.accelerator) {
        const accel = document.createElement('span');
        accel.className = 'menu-accel';
        accel.textContent = item.accelerator;
        button.appendChild(accel);
      }

      button.addEventListener('click', () => api.action(item.id));
      fragment.appendChild(button);
      if (item.enabled !== false) {
        menuEntries.push({ button, accelerator: item.accelerator || '' });
      }
    }
    panel.replaceChildren(fragment);
    scheduleMeasure();
  }

  function normalizeAcceleratorKey(key) {
    const lower = String(key || '').toLowerCase();
    return {
      arrowleft: '←',
      arrowright: '→',
      arrowup: '↑',
      arrowdown: '↓',
      delete: 'del',
      escape: 'esc',
      ' ': 'space',
    }[lower] || lower;
  }

  function matchesAccelerator(accelerator, event) {
    if (!accelerator) return false;
    const parts = accelerator.split('+').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return false;
    const key = parts.pop();
    const ctrl = parts.some((part) => /^(ctrl|cmd|command|meta)$/i.test(part));
    const alt = parts.some((part) => /^alt$/i.test(part));
    const shift = parts.some((part) => /^shift$/i.test(part));
    const ctrlDown = Boolean(event.ctrlKey || event.metaKey);
    if (ctrlDown !== ctrl || Boolean(event.altKey) !== alt || Boolean(event.shiftKey) !== shift) {
      return false;
    }
    return normalizeAcceleratorKey(event.key) === normalizeAcceleratorKey(key);
  }

  function focusMenu(direction) {
    if (!menuEntries.length) return;
    const current = menuEntries.findIndex((entry) => entry.button === document.activeElement);
    let index = current;
    if (direction === 'first') index = 0;
    else if (direction === 'last') index = menuEntries.length - 1;
    else if (current < 0) index = direction > 0 ? 0 : menuEntries.length - 1;
    else index = (current + direction + menuEntries.length) % menuEntries.length;
    menuEntries[index].button.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------ */
  /* 下载                                                                */
  /* ------------------------------------------------------------------ */

  function buildDownloadsSkeleton() {
    mode = 'downloads';
    rows.clear();
    panel.classList.remove('menu');
    panel.classList.add('downloads');
    panel.style.width = '344px';
    panel.innerHTML = `
      <div class="dl-head">
        <span class="dl-title">下载内容</span>
        <button type="button" class="dl-link" data-action="open-folder">打开下载文件夹</button>
      </div>
      <div class="dl-list"></div>
      <div class="dl-empty">暂无下载记录</div>
      <div class="dl-foot">
        <button type="button" class="dl-link" data-action="clear">清除已结束的下载</button>
      </div>
    `;
    listEl = panel.querySelector('.dl-list');
    emptyEl = panel.querySelector('.dl-empty');
    footerEl = panel.querySelector('.dl-foot');
    panel.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => api.action(button.dataset.action));
    });
  }

  function createRow(download) {
    const el = document.createElement('div');
    el.className = 'dl-row';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.dataset.id = download.id;
    el.innerHTML = `
      <span class="dl-icon"></span>
      <span class="dl-main">
        <span class="dl-top"><span class="dl-name"></span><span class="dl-pct"></span></span>
        <span class="dl-meta"></span>
        <span class="dl-track"><span class="dl-fill"></span></span>
      </span>
      <button type="button" class="dl-pause hidden" title="暂停下载"></button>
    `;
    el.addEventListener('click', (event) => {
      if (event.target.closest('.dl-pause')) return;
      if (row.download.state === 'completed') api.action(`open:${row.download.id}`);
    });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && row.download.state === 'completed') {
        api.action(`open:${row.download.id}`);
      }
    });
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      api.rowMenu(download.id, event.clientX, event.clientY);
    });
    const row = {
      el,
      download,
      icon: el.querySelector('.dl-icon'),
      iconUrl: '',
      name: el.querySelector('.dl-name'),
      pct: el.querySelector('.dl-pct'),
      meta: el.querySelector('.dl-meta'),
      fill: el.querySelector('.dl-fill'),
      pause: el.querySelector('.dl-pause'),
    };
    row.pause.addEventListener('click', (event) => {
      event.stopPropagation();
      const current = row.download;
      if (current.state !== 'progressing') return;
      api.action(`${current.paused ? 'resume' : 'pause'}:${current.id}`);
    });
    listEl.appendChild(el);
    return row;
  }

  function updateRow(row, download) {
    row.download = download;
    const done = download.state === 'completed';
    const failed = download.state === 'interrupted' || download.state === 'cancelled';
    const paused = !done && !failed && Boolean(download.paused);
    const total = Number(download.total) || 0;
    const received = Number(download.received) || 0;
    const known = total > 0;
    const percent = done ? 100 : known ? Math.min(100, Math.round((received / total) * 100)) : 0;

    row.el.classList.toggle('done', done);
    row.el.classList.toggle('failed', failed);
    row.el.classList.toggle('paused', paused);
    row.el.classList.toggle('unknown', !done && !failed && !known);
    row.el.classList.toggle('clickable', done);
    row.icon.classList.toggle('failed', failed);

    const iconSource = download.icon || '';
    if (iconSource) {
      if (row.iconUrl !== iconSource) {
        const image = document.createElement('img');
        image.src = iconSource;
        image.alt = '';
        image.draggable = false;
        row.icon.replaceChildren(image);
        row.iconUrl = iconSource;
      }
    } else if (row.iconUrl !== 'fallback') {
      row.icon.innerHTML = FILE_ICON;
      row.iconUrl = 'fallback';
    }

    row.name.textContent = download.filename || '下载文件';
    row.name.title = download.path || download.filename || '';
    row.pct.textContent = done ? '完成' : failed ? '中断' : paused ? '已暂停' : known ? `${percent}%` : '…';

    if (done) {
      row.meta.textContent = `${formatBytes(total || received)} · 已完成`;
    } else if (failed) {
      row.meta.textContent = `${formatBytes(received)} · 已中断`;
    } else if (paused) {
      row.meta.textContent = `已暂停 · ${formatBytes(received)}${known ? ` / ${formatBytes(total)}` : ''}`;
    } else {
      const speed = formatSpeed(download.speed);
      row.meta.textContent = known
        ? `${formatBytes(received)} / ${formatBytes(total)}${speed ? ` · ${speed}` : ''}`
        : `${formatBytes(received)}${speed ? ` · ${speed}` : ''}`;
    }

    if (done || failed || known) {
      row.fill.style.width = `${percent}%`;
    } else {
      row.fill.style.width = '';
    }

    const canPause = download.state === 'progressing';
    row.pause.classList.toggle('hidden', !canPause);
    if (canPause) {
      row.pause.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
      row.pause.title = paused ? '继续下载' : '暂停下载';
    }
  }

  function renderDownloads(payload) {
    if (mode !== 'downloads') buildDownloadsSkeleton();
    const downloads = Array.isArray(payload.downloads) ? payload.downloads : [];
    const seen = new Set();

    for (const download of downloads) {
      seen.add(download.id);
      let row = rows.get(download.id);
      if (!row) {
        row = createRow(download);
        rows.set(download.id, row);
      }
      updateRow(row, download);
    }

    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      row.el.remove();
      rows.delete(id);
    }

    const empty = downloads.length === 0;
    emptyEl.classList.toggle('hidden', !empty);
    footerEl.classList.toggle('hidden', empty);
    listEl.classList.toggle('hidden', empty);
    scheduleMeasure();
  }

  function render(payload) {
    if (!payload) return;
    applyTheme(payload.theme);
    if (payload.mode === 'menu') renderMenu(payload);
    else renderDownloads(payload);
  }

  api.onUpdate((payload) => {
    if (payload) render(payload);
  });

  api.onShown(() => {
    replayAnimation();
    scheduleMeasure();
  });

  api.onTheme((theme) => applyTheme(theme));

  document.addEventListener('mousedown', (event) => {
    if (!panel.contains(event.target)) api.close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      api.close();
      return;
    }
    if (mode !== 'menu' || !menuEntries.length) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusMenu(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusMenu(-1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusMenu('first');
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusMenu('last');
      return;
    }

    const focused = menuEntries.find((entry) => entry.button === document.activeElement);
    if (focused && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      focused.button.click();
      return;
    }

    for (const entry of menuEntries) {
      if (matchesAccelerator(entry.accelerator, event)) {
        event.preventDefault();
        entry.button.click();
        return;
      }
    }
  });

  document.addEventListener('contextmenu', (event) => event.preventDefault());

  api
    .data()
    .then((payload) => {
      if (payload) render(payload);
    })
    .catch(() => {});
})();
