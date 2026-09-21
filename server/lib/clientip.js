#!/usr/bin/env node
'use strict';
/**
 * Whose address is this, really?
 *
 * The visit log is only worth reading if the address in it belongs to the
 * visitor. Getting there means answering two questions honestly.
 *
 * 1. Which address did the request actually arrive from? Behind a reverse
 *    proxy, a CDN, or a container network, the socket address is the proxy's —
 *    127.0.0.1, a docker bridge address, a link-local 169.254.x.x. The real one
 *    is in a header, and each proxy names it differently: Cloudflare uses
 *    CF-Connecting-IP, nginx is usually configured for X-Real-IP or
 *    X-Forwarded-For, Fastly and Akamai use True-Client-IP. Those headers are
 *    also trivially forged by anyone who can reach the port directly, so they
 *    are only believed when the request came from something we trust — and "we
 *    trust it" is decided per request: a loopback or private-network peer (a
 *    proxy on this box or the LAN), or an address listed in the config.
 *
 * 2. When nothing trustworthy arrives — a plain port-80 server behind NAT, a
 *    home router, a container — the address is simply not knowable from the
 *    request. No header and no socket inspection can recover it, because the
 *    middleboxes rewrote it before we ever saw the packet. The only party that
 *    does know is the visitor's own browser, which can ask a public service
 *    "what address do you see me from?" and tell us. That is what the visitor
 *    report path is for, and it is opt-in per installation (see `reportIp`).
 *
 * Anything that comes out of here is labelled with where it came from, so the
 * panel can show its provenance rather than presenting a guess as a fact.
 */
const { isPrivateIp, normaliseIp } = require('./geo');

/* Ordered by how specific they are: a header naming the client outright beats a
   list that needs parsing. */
const HEADERS = [
  { header: 'cf-connecting-ip', source: 'cloudflare' },
  { header: 'true-client-ip', source: 'true-client-ip' },
  { header: 'x-client-ip', source: 'x-client-ip' },
  { header: 'x-real-ip', source: 'x-real-ip' },
  { header: 'x-forwarded-for', source: 'x-forwarded-for' },
  { header: 'forwarded', source: 'forwarded' },
  { header: 'x-vercel-forwarded-for', source: 'vercel' },
  { header: 'fastly-client-ip', source: 'fastly' },
];

const SOURCE_LABEL = {
  socket: 'the connection itself',
  reported: 'reported by the visitor’s browser',
  cloudflare: 'Cloudflare header',
  'true-client-ip': 'True-Client-IP header',
  'x-client-ip': 'X-Client-IP header',
  'x-real-ip': 'X-Real-IP header',
  'x-forwarded-for': 'X-Forwarded-For header',
  forwarded: 'Forwarded header',
  vercel: 'Vercel header',
  fastly: 'Fastly header',
};

/** Every candidate address in a header value, in the order they appear. */
function candidatesFrom(value, source) {
  if (!value) return [];
  const text = String(value);
  const out = [];
  for (const piece of text.split(',')) {
    let item = piece.trim();
    if (!item) continue;
    /* Forwarded: for=203.0.113.7;proto=https */
    const forMatch = /for=("?\[?[^;,"\]]+\]?"?)/i.exec(item);
    if (forMatch) item = forMatch[1].replace(/["[\]]/g, '');
    item = normaliseIp(item);
    if (item) out.push({ ip: item, source });
  }
  return out;
}

/** Is this peer allowed to speak for the client? */
function peerIsTrusted(peerIp, cfg) {
  if (!peerIp) return false;
  const bare = peerIp.replace(/^::ffff:/, '');
  if (bare === '::1' || bare === '127.0.0.1' || bare.startsWith('127.')) return true;
  if (isPrivateIp(bare)) return true;              // LAN or container network
  const list = (cfg && cfg.trustedProxies) || [];
  return list.some(entry => entry === bare || entry === '*' ||
    (entry.includes('/') && inCidr(bare, entry)));
}

/** Minimal CIDR check — IPv4 only, which is what a trustedProxies list holds. */
function inCidr(ip, cidr) {
  const [net, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!net || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (v) => v.split('.').reduce((acc, part) => (acc << 8) + (Number(part) & 255), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(net)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(net) & mask);
}

/**
 * Decide the visitor's address for one request.
 *
 *   { ip, source, private, proxied, chain }
 *
 * `ip` is the best answer available; `private` says whether that answer is an
 * address only meaningful inside a network (in which case the panel should show
 * it as such and the visit is a candidate for a visitor report).
 */
function resolve(req, cfg) {
  const peer = normaliseIp(req.socket && req.socket.remoteAddress || '');
  const mode = cfg && cfg.trustProxy;
  const trust = mode === true || (mode === 'auto' && peerIsTrusted(peer, cfg));

  const chain = [peer].filter(Boolean);
  if (trust) {
    for (const { header, source } of HEADERS) {
      const found = candidatesFrom(req.headers[header], source);
      if (!found.length) continue;
      for (const c of found) if (!chain.includes(c.ip)) chain.push(c.ip);
      /* A CDN that names the client outright is the answer. For a list, the
         rightmost public address is the one the nearest proxy added; anything
         further left was supplied by the client and can be anything at all. */
      const named = source !== 'x-forwarded-for' && source !== 'forwarded' && source !== 'vercel';
      let chosen = named ? found[0] : null;
      if (!chosen) {
        for (let i = found.length - 1; i >= 0; i--) {
          if (!isPrivateIp(found[i].ip)) { chosen = found[i]; break; }
        }
        if (!chosen) chosen = found[found.length - 1];
      }
      return {
        ip: chosen.ip,
        source: chosen.source,
        private: isPrivateIp(chosen.ip),
        proxied: true,
        peer,
        chain,
      };
    }
  }

  return { ip: peer, source: 'socket', private: isPrivateIp(peer), proxied: trust, peer, chain };
}

/**
 * Should a visitor report be requested for this visit?
 *
 * When the address we have is private, a report can only improve things. When it
 * is public, a report would merely confirm it — except behind a proxy that
 * rewrites addresses in a way we cannot see, which is not worth a third-party
 * request per visitor. So: reports are for the case they solve.
 */
function wantsReport(resolved, settings) {
  if (!settings || settings.reportVisitorIp === false) return false;
  if (settings.storeRawIp === false) return false;          // privacy mode: no addresses at all
  return !!resolved.private;
}

/** A report is only accepted if it is a real, public, routable address. */
function validateReported(raw) {
  const ip = normaliseIp(raw);
  if (!ip) return { ok: false, reason: 'empty' };
  if (ip.length > 64) return { ok: false, reason: 'too long' };
  const v4 = /^\d+\.\d+\.\d+\.\d+$/.test(ip);
  const v6 = ip.includes(':') && /^[0-9a-fA-F:.]+$/.test(ip);
  if (!v4 && !v6) return { ok: false, reason: 'not an address' };
  if (v4) {
    const parts = ip.split('.').map(Number);
    if (parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return { ok: false, reason: 'not an address' };
  }
  if (isPrivateIp(ip)) return { ok: false, reason: 'a private address is not a public one' };
  if (/^(0\.|100\.(6[4-9]|[7-9]\d|1[0-2]\d)\.|169\.254\.|192\.0\.2\.|198\.1[89]\.|198\.51\.100\.|203\.0\.113\.|224\.|23[2-9]\.|2[4-9]\d\.|255\.)/.test(ip)) {
    return { ok: false, reason: 'not a routable public address' };
  }
  return { ok: true, ip, family: v4 ? 4 : 6 };
}

module.exports = {
  resolve,
  wantsReport,
  validateReported,
  peerIsTrusted,
  inCidr,
  candidatesFrom,
  SOURCE_LABEL,
  HEADERS,
};
