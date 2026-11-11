'use strict';

/**
 * 冒烟测试启动器：用 LITE_SMOKE=1 启动 Electron，
 * 自动创建窗口、跑完检查、输出截图到 test-output/ 并退出。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const electronPath = require('electron');
const root = path.join(__dirname, '..');

// 每次冒烟测试都用全新的用户数据与下载目录，避免上次会话恢复干扰断言
fs.rmSync(path.join(root, 'test-output', 'profile'), { recursive: true, force: true });
fs.rmSync(path.join(root, 'test-output', 'downloads'), { recursive: true, force: true });
fs.rmSync(path.join(root, 'test-output', 'custom-downloads'), { recursive: true, force: true });

const env = { ...process.env, LITE_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (error) => {
  console.error('[smoke] 无法启动 Electron:', error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[smoke] Electron 被信号 ${signal} 终止`);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});
