'use strict';

/**
 * electron-builder 默认把 NSIS 安装/卸载详情隐藏（Show*Details nevershow /
 * SetDetailsPrint none）。这个脚本在打包前把模板改成显示详情，保证安装和
 * 卸载时都能看到当前解压/删除的文件和进度。
 *
 * 脚本是幂等的，每次 npm run dist 都可以安全执行。
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const templates = path.join(
  root,
  'node_modules',
  'app-builder-lib',
  'templates',
  'nsis',
);

function patchFile(name, replacements) {
  const file = path.join(templates, name);
  let text = fs.readFileSync(file, 'utf8');
  let changed = 0;

  for (const [from, to] of replacements) {
    if (text.includes(from)) {
      text = text.split(from).join(to);
      changed += 1;
    } else if (!text.includes(to)) {
      throw new Error(`NSIS 模板 ${name} 中找不到需要修改的内容: ${from}`);
    }
  }

  fs.writeFileSync(file, text);
  if (changed > 0) console.log(`[nsis-patch] ${name}: ${changed} 处已更新`);
}

patchFile('common.nsh', [
  ['ShowInstDetails nevershow', 'ShowInstDetails show'],
  ['ShowUninstDetails nevershow', 'ShowUninstDetails show'],
]);

patchFile('installSection.nsh', [
  ['SetDetailsPrint none', 'SetDetailsPrint both'],
]);

// 卸载页也自动展开详情面板
{
  const file = path.join(templates, 'assistedInstaller.nsh');
  let text = fs.readFileSync(file, 'utf8');
  if (!text.includes('un.LiteBrowserUninstallPageShow')) {
    const marker = '  !insertmacro MUI_UNPAGE_INSTFILES';
    if (!text.includes(marker)) {
      throw new Error('NSIS 模板 assistedInstaller.nsh 中找不到卸载文件页');
    }
    text = text.replace(
      marker,
      '  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.LiteBrowserUninstallPageShow\n  !insertmacro MUI_UNPAGE_INSTFILES',
    );
    fs.writeFileSync(file, text);
    console.log('[nsis-patch] assistedInstaller.nsh: 已启用卸载详情自动展开');
  }
}

console.log('[nsis-patch] 安装/卸载详情已启用');
