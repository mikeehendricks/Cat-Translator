'use strict';
/**
 * Visit statistics: recording and summarising.
 *
 * A "visit" here is a page view of the app itself (not admin activity, not
 * static assets), which is the honest definition of "site user statistics".
 * Admin actions live in the audit log instead.
 *
 * Privacy switch: settings.storeRawIp=false replaces the address with a salted
 * hash, so unique visitors can still be counted and repeat behaviour still
 * reconstructable, but no address is kept on disk. Location lookups need the
 * raw address, so they run before hashing and only the resolved country/city is
 * retained.
 */
const crypto = require('node:crypto');
const { isPrivateIp, normaliseIp } = require('./geo');

const BOT_RE = /(bot|crawler|spider|crawling|curl|wget|python-requests|headless|monitor|uptime|pingdom|facebookexternalhit|slurp|bingpreview|semrush|ahrefs|mj12|dotbot|petalbot)/i;

function visitorHash(ip, ua) {
  return crypto.createHash('sha256').update(`visit:${ip}|${ua || ''}`).digest('hex').slice(0, 20);
}

function deviceOf(ua) {
  const s = ua || '';
  if (BOT_RE.test(s)) return 'bot';
  if (/iPad|Tablet|PlayBook|Silk/i.test(s)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(s)) return 'mobile';
  return 'desktop';
}

function dayKey(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function record(store, { ip, path, ua, ref, proxied }) {
  const clean = normaliseIp(ip);
  const t = Date.now();
  const device = deviceOf(ua);
  const hash = visitorHash(clean, ua);
  const geo = null;                                  // filled in when the lookup lands
  const entry = {
    t,
    ip: store.data.settings.storeRawIp ? clean : '',
    hash,
    path: String(path || '/').slice(0, 200),
    ref: String(ref || '').slice(0, 300),
    ua: String(ua || '').slice(0, 300),
    device,
    geo,
    proxied: !!proxied,
  };
  store.data.visits.push(entry);
  if (store.data.visits.length > 60000) store.data.visits.splice(0, store.data.visits.length - 60000);

  const key = dayKey(t);
  const day = store.data.dayStats[key] || (store.data.dayStats[key] = { hits: 0, uniques: 0, seen: {}, countries: {} });
  day.hits += 1;
  if (!day.seen[hash]) { day.seen[hash] = 1; day.uniques += 1; }
  /* keep the per-day unique-visitor set from growing without bound */
  if (Object.keys(day.seen).length > 5000) day.seen = {};

  store.dirty();
  return entry;
}

/** Attach the resolved location to the visit row and to the day counters. */
function attachGeo(store, entry, geo) {
  if (!entry || !geo) return;
  entry.geo = { country: geo.country || '', cc: geo.cc || '', region: geo.region || '', city: geo.city || '', isp: geo.isp || '', local: !!geo.local };
  const day = store.data.dayStats[dayKey(entry.t)];
  if (day && geo.country) {
    const label = geo.local ? 'Local network' : geo.country;
    day.countries[label] = (day.countries[label] || 0) + 1;
  }
  store.dirty();
}

const within = (t, from, to) => t >= from && t < to;

function summarize(store, opts) {
  opts = opts || {};
  const now = Date.now();
  const days = opts.days || 30;
  const from = now - days * 86400000;
  const today = dayKey(now);
  const yStart = new Date(); yStart.setHours(0, 0, 0, 0);
  const visits = store.data.visits.filter(v => within(v.t, from, now + 1));

  const uniq = new Set(visits.map(v => v.hash));
  const uniqToday = new Set(store.data.visits.filter(v => v.t >= yStart.getTime()).map(v => v.hash));
  const countries = {}, cities = {}, paths = {}, referrers = {}, devices = {}, browsers = {};
  const byIp = {};
  for (const v of visits) {
    const c = v.geo ? (v.geo.local ? 'Local network' : (v.geo.country || 'unknown')) : 'pending';
    countries[c] = (countries[c] || 0) + 1;
    if (v.geo && v.geo.city) cities[`${v.geo.city}, ${v.geo.country}`] = (cities[`${v.geo.city}, ${v.geo.country}`] || 0) + 1;
    paths[v.path] = (paths[v.path] || 0) + 1;
    const ref = v.ref ? safeHost(v.ref) : '(direct)';
    referrers[ref] = (referrers[ref] || 0) + 1;
    devices[v.device] = (devices[v.device] || 0) + 1;
    if (v.ip) byIp[v.ip] = (byIp[v.ip] || 0) + 1;
    const b = browserOf(v.ua);
    browsers[b] = (browsers[b] || 0) + 1;
  }

  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(now - i * 86400000);
    const d = store.data.dayStats[key];
    series.push({ day: key, hits: d ? d.hits : 0, uniques: d ? d.uniques : 0 });
  }

  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, n: v }));

  return {
    generatedAt: now,
    windowDays: days,
    totals: {
      allTime: store.data.visits.length,
      inWindow: visits.length,
      today: store.data.visits.filter(v => v.t >= yStart.getTime()).length,
      uniquesInWindow: uniq.size,
      uniquesToday: uniqToday.size,
      distinctIps: Object.keys(byIp).length,
      firstSeen: store.data.visits.length ? store.data.visits[0].t : null,
      lastSeen: store.data.visits.length ? store.data.visits[store.data.visits.length - 1].t : null,
    },
    series,
    countries: top(countries, 12),
    cities: top(cities, 8),
    paths: top(paths, 8),
    referrers: top(referrers, 8),
    devices: top(devices, 6),
    browsers: top(browsers, 6),
    topVisitors: top(byIp, 8),
  };
}

function safeHost(ref) {
  try { return new URL(ref).host || '(direct)'; } catch (e) { return String(ref).slice(0, 60); }
}

function browserOf(ua) {
  const s = ua || '';
  if (BOT_RE.test(s)) return 'bot';
  if (/Edg\//.test(s)) return 'Edge';
  if (/OPR\/|Opera/.test(s)) return 'Opera';
  if (/Firefox\//.test(s)) return 'Firefox';
  if (/Chrome\//.test(s)) return 'Chrome';
  if (/Safari\//.test(s)) return 'Safari';
  return 'other';
}

/** Filtered, paginated rows for the admin table. */
function query(store, opts) {
  const { day, country, ip, q, limit = 200, offset = 0, bots = true } = opts || {};
  let rows = store.data.visits.slice().reverse();
  if (day) rows = rows.filter(v => dayKey(v.t) === day);
  if (country) rows = rows.filter(v => (v.geo && (v.geo.local ? 'Local network' : v.geo.country) === country));
  if (ip) rows = rows.filter(v => v.ip === ip || v.hash === ip);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(v => [v.ip, v.path, v.ua, v.ref, v.geo && v.geo.city, v.geo && v.geo.country]
      .filter(Boolean).some(x => String(x).toLowerCase().includes(needle)));
  }
  if (!bots) rows = rows.filter(v => v.device !== 'bot');
  const total = rows.length;
  return { total, offset, limit, rows: rows.slice(offset, offset + Math.min(limit, 1000)) };
}

function csv(rows) {
  const head = ['time_iso', 'unix', 'ip', 'country', 'country_code', 'region', 'city', 'isp', 'device', 'path', 'referrer', 'user_agent', 'visitor_hash'];
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.join(',')];
  for (const v of rows) {
    const g = v.geo || {};
    lines.push([
      new Date(v.t).toISOString(), Math.floor(v.t / 1000), v.ip, g.country, g.cc, g.region, g.city, g.isp,
      v.device, v.path, v.ref, v.ua, v.hash,
    ].map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = { record, attachGeo, summarize, query, csv, deviceOf, browserOf, dayKey, visitorHash, isPrivateIp };
