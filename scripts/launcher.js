#!/usr/bin/env node

/**
 * Leabhar launcher.
 *
 * This is the entry point the Start Menu / Desktop shortcut runs. It:
 *  1. Sets env vars so the app knows it is packaged and where its files live.
 *  2. Spawns the Next.js standalone server as a child process.
 *  3. Polls localhost:3000 until the server responds.
 *  4. Opens the default browser.
 *  5. Stays alive until the server exits, then exits with the same code.
 *
 * The user sees a small console window. Closing it stops the server.
 */

const { spawn, exec } = require('node:child_process');
const { join, dirname } = require('node:path');
const http = require('node:http');

const APP_ROOT = dirname(process.execPath);
const PORT = process.env.PORT || '3000';
const URL = `http://localhost:${PORT}`;

process.env.LEABHAR_PACKAGED = '1';
process.env.LEABHAR_APP_ROOT = APP_ROOT;
process.env.NODE_ENV = 'production';
process.env.PORT = PORT;
process.env.HOSTNAME = '127.0.0.1';

const server = spawn(process.execPath, [join(APP_ROOT, 'server.js')], {
  stdio: 'inherit',
  env: process.env,
  cwd: APP_ROOT,
});

server.on('exit', (code) => {
  process.exit(code ?? 1);
});

function waitForServer(retries = 50, delayMs = 200) {
  const req = http.get(URL, (res) => {
    res.resume();
    if (res.statusCode && res.statusCode < 500) {
      openBrowser();
    } else if (retries > 0) {
      setTimeout(() => waitForServer(retries - 1, delayMs), delayMs);
    }
  });
  req.on('error', () => {
    if (retries > 0) {
      setTimeout(() => waitForServer(retries - 1, delayMs), delayMs);
    }
  });
}

function openBrowser() {
  const cmd =
    process.platform === 'win32' ? `start "" "${URL}"` :
    process.platform === 'darwin' ? `open "${URL}"` :
    `xdg-open "${URL}"`;
  exec(cmd);
}

waitForServer();
