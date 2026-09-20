#!/usr/bin/env node

/**
 * Leabhar launcher.
 *
 * This is the entry point the Start Menu / Desktop shortcut runs. It:
 *  1. Sets env vars so the app knows it is packaged and where its files live.
 *  2. Spawns the Next.js standalone server as a child process, teeing its
 *     output to both the console and a log file.
 *  3. Polls /api/health until the server responds, distinguishing WHY it
 *     didn't if it never does (issue #61).
 *  4. Opens the default browser.
 *  5. Stays alive until the server exits, then exits with the same code.
 *
 * The user sees a small console window. Closing it stops the server.
 */

const { spawn, exec } = require('node:child_process');
const { join, dirname } = require('node:path');
const { mkdirSync, createWriteStream } = require('node:fs');
const http = require('node:http');

const APP_ROOT = dirname(process.execPath);
// Mirrors src/lib/paths.ts's own DATA_ROOT default exactly (issue #59: the
// installer always puts the binaries in an `app` subfolder, one level below
// the user's data). Duplicated rather than imported because this script is
// a plain Node CommonJS file the launcher runs directly — it has no access
// to the TypeScript app bundle paths.ts lives in.
const DATA_ROOT = dirname(APP_ROOT);
const LOG_DIR = join(DATA_ROOT, 'logs');
const LOG_FILE = join(LOG_DIR, 'leabhar.log');

const PORT = process.env.PORT || '3000';
const URL = `http://localhost:${PORT}`;
const HEALTH_URL = `${URL}/api/health`;

process.env.LEABHAR_PACKAGED = '1';
process.env.LEABHAR_APP_ROOT = APP_ROOT;
process.env.NODE_ENV = 'production';
process.env.PORT = PORT;
process.env.HOSTNAME = '127.0.0.1';

mkdirSync(LOG_DIR, { recursive: true });
const logStream = createWriteStream(LOG_FILE, { flags: 'a' });

/** Write a launcher diagnostic line to both the console and the log file. */
function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  logStream.write(stamped + '\n');
}

/** The reassurance every failure message needs (README's own accounting-software bar). */
const DATA_SAFE_NOTICE = 'Your accounting data has not been modified.';

log(`--- Leabhar starting (pid ${process.pid}) ---`);
log(`Log file: ${LOG_FILE}`);

let serverStderr = '';
let everResponded = false;

const server = spawn(process.execPath, [join(APP_ROOT, 'server.js')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
  cwd: APP_ROOT,
});

// Tee the server's own output to both the console (preserving the existing
// UX — the user sees server output in the launcher window) and the log file.
server.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  logStream.write(chunk);
});
server.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  logStream.write(chunk);
  serverStderr += chunk.toString();
});

server.on('exit', (code) => {
  if (!everResponded) {
    if (/EADDRINUSE/.test(serverStderr)) {
      log(`Leabhar could not start: port ${PORT} is already in use by another program. `
        + `Close whatever else is using it, or set the PORT environment variable to a free one, `
        + `and try again. ${DATA_SAFE_NOTICE}`);
    } else {
      log(`Leabhar's server exited before it ever responded (exit code ${code ?? 'unknown'}). `
        + `${DATA_SAFE_NOTICE} See the log file above for details, or try again — `
        + 'a very slow first boot can look like this too.');
    }
  } else {
    log(`Leabhar's server has stopped (exit code ${code ?? 'unknown'}).`);
  }
  process.exit(code ?? 1);
});

function waitForServer(retries = 50, delayMs = 200) {
  const req = http.get(HEALTH_URL, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      // Checking the JSON body's own status, not just the HTTP status code,
      // matters here specifically: PORT is a plain env var, so if something
      // else is already listening on it (the EADDRINUSE case), the port
      // isn't necessarily unclaimed garbage — it could be another web server
      // that happily 200s an unknown path. Requiring THIS exact payload is
      // what makes "ready" mean Leabhar, not just "something answered".
      let ok = false;
      try { ok = res.statusCode === 200 && JSON.parse(body).status === 'ok'; } catch { /* not our server */ }

      if (ok) {
        everResponded = true;
        log('Leabhar is ready.');
        openBrowser();
      } else if (retries > 0) {
        setTimeout(() => waitForServer(retries - 1, delayMs), delayMs);
      } else {
        reportTimedOut();
      }
    });
  });
  req.on('error', () => {
    if (retries > 0) {
      setTimeout(() => waitForServer(retries - 1, delayMs), delayMs);
    } else {
      reportTimedOut();
    }
  });
}

function reportTimedOut() {
  log(`Leabhar did not become ready in time. ${DATA_SAFE_NOTICE} `
    + `The server process is still running (pid ${server.pid}) in case it is just slow to start — `
    + `check ${LOG_FILE} for what it's doing, or close this window to stop it and try again.`);
}

function openBrowser() {
  const cmd =
    process.platform === 'win32' ? `start "" "${URL}"` :
    process.platform === 'darwin' ? `open "${URL}"` :
    `xdg-open "${URL}"`;
  exec(cmd);
}

waitForServer();
