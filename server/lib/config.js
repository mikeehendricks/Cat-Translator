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
  trustProxy: false,              // true when nginx sets X-Forwarded-For / X-Forwarded-Proto
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
  if (env.MEOW_TRUST_PROXY) cfg.trustProxy = env.MEOW_TRUST_PROXY === '1' || env.MEOW_TRUST_PROXY === 'true';
  if (env.MEOW_RESTART_MODE) cfg.restartMode = env.MEOW_RESTART_MODE;

  if (cli.host) cfg.host = cli.host;
  if (cli.port) cfg.port = Number(cli.port);
  if (cli.appDir) cfg.appDir = cli.appDir;
  if (cli.dataDir) cfg.dataDir = cli.dataDir;
  if (cli.trustProxy !== undefined) cfg.trustProxy = cli.trustProxy === true || cli.trustProxy === 'true';
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
