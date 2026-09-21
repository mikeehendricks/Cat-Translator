'use strict';
/**
 * Restarting ourselves.
 *
 * Three situations, one behaviour ("stop, and come back with the new code"):
 *   - under systemd (Restart=always)  -> exit 0, systemd starts us again
 *   - standalone (dev, or docker)     -> spawn a detached copy of ourselves and
 *                                        exit; the child waits for the port
 *   - never                          -> we still swap files, but say so
 *
 * The port is the tricky bit for the standalone case: the child cannot bind
 * until the parent has fully released it, so the child retries for a while
 * before giving up.
 */
const { spawn } = require('node:child_process');
const net = require('node:net');

function underSystemd() {
  return !!(process.env.INVOCATION_ID || process.env.JOURNAL_STREAM || process.env.NOTIFY_SOCKET);
}

function mode(cfg) {
  if (cfg.restartMode === 'systemd') return 'systemd';
  if (cfg.restartMode === 'exec') return 'exec';
  if (cfg.restartMode === 'off') return 'off';
  return underSystemd() ? 'systemd' : 'exec';
}

function describe(cfg) {
  const m = mode(cfg);
  return {
    mode: m,
    underSystemd: underSystemd(),
    detail: m === 'systemd'
      ? 'systemd restarts the service after a clean exit (Restart=always)'
      : m === 'exec'
        ? 'a detached replacement process takes over once the port is free'
        : 'restarts are disabled in the configuration',
  };
}

/* Guards against two restart requests arriving from the same action (an update
   plus its follow-up call, say). It is deliberately time-based: an earlier
   version latched a boolean forever, which silently swallowed every restart
   after the first one — including a rollback. */
let lastScheduled = 0;

function schedule(cfg, store, delayMs, reason) {
  const m = mode(cfg);
  if (m === 'off') return false;
  if (Date.now() - lastScheduled < 5000) return false;
  lastScheduled = Date.now();
  try { store.save(); } catch (e) {}

  setTimeout(() => {
    console.log(`[restart] ${reason || 'requested'} — restarting in ${m} mode`);
    if (m === 'systemd') {
      process.exit(0);
    } else {
      const args = process.argv.slice(1).filter(a => !a.startsWith('--restart'));
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        detached: true,
        stdio: 'ignore',
        env: Object.assign({}, process.env, { MEOW_SUPERVISED: '1' }),
      });
      child.unref();
      process.exit(0);
    }
  }, Math.max(200, delayMs || 1200));
  if (setTimeout(() => {}, 0).unref) { /* keep timers from holding the loop open elsewhere */ }
  return true;
}

/** Used by the supervised child: wait until the port can be bound. */
function waitForPort(cfg, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  return new Promise(resolve => {
    const attempt = () => {
      const srv = net.createServer();
      srv.once('error', err => {
        srv.close();
        if (Date.now() > deadline) return resolve(false);
        setTimeout(attempt, 400);
      });
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(cfg.port, cfg.host);
    };
    attempt();
  });
}

module.exports = { schedule, mode, describe, underSystemd, waitForPort };
