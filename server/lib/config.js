'use strict';
/**
 * System configuration.
 *
 * Split of responsibilities:
 *   /etc/meow-translator/config.json  (this file)  -> how the service runs:
 *        host, port, paths, proxy trust, restart mode. Needs root to edit.
 *   <dataDir>/store.json              (store.js)   -> everything the admin
 *        panel can change at runtime: credentials, visits, settings, versions.
 *
 * Environment variables and command-line flags override the file, which is how
 * the test suite runs the whole thing on a throwaway port and directory.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  host: '0.0.0.0',                // reachable from outside; use 127.0.0.1 to keep it local
  port: 80,                       // the web port; the unit grants CAP_NET_BIND_SERVICE for it
  appDir: '/opt/meow-translator', // code + the single-file app; replaced by updates
  dataDir: '/var/lib/meow-translator', // store.json, backups, update staging — never touched by updates
  configPath: '/etc/meow-translator/config.json',
  /* Who may speak for the visitor:
       'auto'  — believe the forwarding headers only when the request came from
                 loopback or a private address, i.e. a proxy on this machine or
                 the LAN. A direct connection from the internet is never trusted,
                 so the headers cannot be forged by a visitor.
       true    — believe them from anywhere (put the app behind a proxy you trust)
       false   — ignore them entirely and log the socket address
     The headers are what tell us the visitor's real address behind nginx,
     Cloudflare, or a container network. */
  trustProxy: 'auto',
  restartMode: 'auto',            // auto | systemd | exec  (see lib/restart.js)
  sessionHours: 12,
  maxVisitRows: 50000,            // hard cap on stored visit rows, oldest dropped first
  logRequests: false,
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = m[2] !== undefined ? m[2] : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return out;
}

function load(argv) {
  const cli = parseArgs(argv || process.argv.slice(2));
  const configPath = cli.configPath || process.env.MEOW_CONFIG || DEFAULTS.configPath;
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[config] ignoring unreadable ${configPath}: ${e.message}`);
  }
  const cfg = Object.assign({}, DEFAULTS, file, { configPath });

  const env = process.env;
  if (env.MEOW_HOST) cfg.host = env.MEOW_HOST;
  if (env.MEOW_PORT) cfg.port = Number(env.MEOW_PORT);
  if (env.MEOW_APP_DIR) cfg.appDir = env.MEOW_APP_DIR;
  if (env.MEOW_DATA_DIR) cfg.dataDir = env.MEOW_DATA_DIR;
  if (env.MEOW_TRUST_PROXY) {
    const raw = String(env.MEOW_TRUST_PROXY).toLowerCase();
    cfg.trustProxy = raw === 'auto' ? 'auto' : (raw === '1' || raw === 'true');
  }
  if (env.MEOW_RESTART_MODE) cfg.restartMode = env.MEOW_RESTART_MODE;

  if (cli.host) cfg.host = cli.host;
  if (cli.port) cfg.port = Number(cli.port);
  if (cli.trustedProxies) cfg.trustedProxies = String(cli.trustedProxies).split(',').map(x => x.trim()).filter(Boolean);
  if (cli.appDir) cfg.appDir = cli.appDir;
  if (cli.dataDir) cfg.dataDir = cli.dataDir;
  if (cli.trustProxy !== undefined) {
    const raw = String(cli.trustProxy).toLowerCase();
    cfg.trustProxy = raw === 'auto' ? 'auto' : (cli.trustProxy === true || raw === 'true');
  }
  if (cli.restartMode) cfg.restartMode = cli.restartMode;

  cfg.port = Math.max(1, Math.min(65535, Number(cfg.port) || DEFAULTS.port));
  cfg.appDir = path.resolve(cfg.appDir);
  cfg.dataDir = path.resolve(cfg.dataDir);
  cfg.versionsDir = path.join(cfg.dataDir, 'versions');
  cfg.stagingDir = path.join(cfg.dataDir, 'staging');
  cfg.storePath = path.join(cfg.dataDir, 'store.json');
  cfg.appHtml = path.join(cfg.appDir, 'cat-translator.html');
  cfg.versionFile = path.join(cfg.appDir, 'VERSION');
  return cfg;
}

function installedVersion(cfg) {
  try {
    return fs.readFileSync(cfg.versionFile, 'utf8').trim();
  } catch (e) {
    return '0.0.0-unknown';
  }
}

module.exports = { load, parseArgs, DEFAULTS, installedVersion };
