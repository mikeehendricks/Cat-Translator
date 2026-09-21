'use strict';
/**
 * IP -> location, with a cache and a background queue.
 *
 * Two things this deliberately does NOT do:
 *   - it never delays a page response; lookups happen after the reply is sent
 *   - it never blocks on a slow provider: results are cached in the store, and
 *     a failure just leaves the visit marked "unknown" for a later retry.
 *
 * Providers are tried in order. The first is plain HTTPS with no API key and no
 * account (ipwho.is); the second is the classic ip-api.com free endpoint, which
 * is HTTP-only on the free tier. If a provider answers, it is remembered so the
 * order stops flapping. Set settings.geoLookup=false to keep every visitor IP
 * on the server (the IP is still logged; only the location column goes away).
 */
const PRIVATE = [
  /^10\./, /^127\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^::1$/, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i,
];

function isPrivateIp(ip) {
  if (!ip) return true;
  const bare = ip.replace(/^::ffff:/, '');
  return PRIVATE.some(re => re.test(bare));
}

function normaliseIp(raw) {
  if (!raw) return '';
  let ip = String(raw).trim().replace(/^::ffff:/, '');
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));   // [::1]:443
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  return ip.slice(0, 64);
}

const PROVIDERS = [
  {
    name: 'ipwho.is',
    url: ip => `https://ipwho.is/${encodeURIComponent(ip)}`,
    parse: j => (j && j.success !== false) ? {
      country: j.country || '', cc: j.country_code || '', region: j.region || '',
      city: j.city || '', isp: j.connection && j.connection.isp ? j.connection.isp : '',
    } : null,
  },
  {
    name: 'ip-api.com',
    url: ip => `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city,isp,query`,
    parse: j => (j && j.status === 'success') ? {
      country: j.country || '', cc: j.countryCode || '', region: j.regionName || '',
      city: j.city || '', isp: j.isp || '',
    } : null,
  },
];

const CACHE_TTL = 30 * 86400000;   // a location rarely moves; keep it a month
const MIN_INTERVAL_MS = 1200;      // stay inside the free tiers' rate limits

class Geo {
  constructor(store, cfg, log) {
    this.store = store;
    this.cfg = cfg;
    this.log = log || (() => {});
    this.busy = false;
    this.lastCall = 0;
    this.queue = [];
    this.preferred = 0;
  }

  /** Cached answer, or null. `local` for RFC1918/loopback addresses. */
  cached(ip) {
    if (!ip) return null;
    if (isPrivateIp(ip)) return { country: 'Local network', cc: 'LO', region: '', city: '', isp: '', local: true };
    const rec = this.store.data.geoCache[ip];
    if (rec && Date.now() - rec.ts < CACHE_TTL) return rec;
    return null;
  }

  /** Queue a lookup. Resolves when the answer is known (or fails) — callers are
   *  expected to have already sent their HTTP response. */
  lookup(ip) {
    const hit = this.cached(ip);
    if (hit) return Promise.resolve(hit);
    if (!ip) return Promise.resolve(null);
    return new Promise(resolve => {
      this.queue.push({ ip, resolve });
      this.pump();
    });
  }

  pump() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const job = this.queue.shift();
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - this.lastCall));
    setTimeout(async () => {
      const rec = await this.fetchOne(job.ip);
      this.lastCall = Date.now();
      this.busy = false;
      if (rec) {
        this.store.data.geoCache[job.ip] = Object.assign({ ts: Date.now() }, rec);
        this.store.dirty();
      }
      job.resolve(rec);
      this.pump();
    }, wait).unref && null;
  }

  async fetchOne(ip) {
    if (!this.store.data.settings.geoLookup) return null;
    for (let i = 0; i < PROVIDERS.length; i++) {
      const p = PROVIDERS[(this.preferred + i) % PROVIDERS.length];
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(p.url(ip), { signal: ctrl.signal, headers: { accept: 'application/json' } });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = p.parse(await res.json());
        if (parsed) {
          if (this.preferred !== (this.preferred + i) % PROVIDERS.length) {
            this.preferred = (this.preferred + i) % PROVIDERS.length;
            this.log('info', `geolocation provider: ${p.name}`);
          }
          return parsed;
        }
        throw new Error('no data');
      } catch (e) {
        this.log('warn', `geo lookup for ${ip} via ${p.name} failed: ${e.message}`);
      }
    }
    return null;
  }

  /** Used by the CLI to explain what the server can reach. */
  async probe() {
    const rec = await this.fetchOne('8.8.8.8');
    return rec || null;
  }
}

module.exports = { Geo, isPrivateIp, normaliseIp, PROVIDERS };
