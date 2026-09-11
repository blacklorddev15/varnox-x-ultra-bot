// ============================================================
//   helper-varnox-status.js
//   Reports this bot host to the VARNOX X ULTRA pairing portal, so a bot that is
//   running stops showing as OFFLINE on the website dashboard.
//
//   Why it was needed: the portal's dashboard only knew about sessions that were
//   paired *through the website* (varnox_sessions rows written by the pairing
//   loop). The bot's own always-on session was never recorded, and nothing ever
//   pinged /api/heartbeat, so every server tile stayed dead and the status pill
//   read OFFLINE no matter how long the bot had been up.
//
//   What it does, twice, independently:
//     1. POST /api/heartbeat every ~45s  -> this host's tile goes ONLINE on the
//        dashboard. The portal flips it back to OFFLINE after 2 minutes of
//        silence, so a crashed bot stops looking alive by itself.
//     2. Refreshes the varnox_sessions rows for sockets that are really
//        connected -> that is what the "Online now" counter reads.
//
//   Nothing else in the bot has to change: helper-varnox-neon.js starts this when
//   it boots, and if this file is absent the require is caught and the bot runs
//   exactly as before.
//
//   Optional hosting variables:
//     VARNOX_SERVER_ID    1 | 2 | 3   which server tile this host is (default 1)
//     VARNOX_SERVER_NAME  label for the tile (default "Server <id>")
//     VARNOX_PORTAL_URL   override the portal address
//     VARNOX_STATUS_MS    heartbeat interval in ms (default 45000, min 15000)
// ============================================================
'use strict';

const DEFAULTS = {
  portal: 'https://varnox-x-ultra-pair.vercel.app',
  server: 1,
  name: '',
  intervalMs: 45000,
  timeoutMs: 12000,
};

/** POST JSON with global fetch when available, falling back to https for old Node. */
function postJson(url, payload, timeoutMs) {
  const body = JSON.stringify(payload);

  if (typeof fetch === 'function') {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller ? controller.signal : undefined,
    })
      .then(async (r) => ({ status: r.status, text: await r.text().catch(() => '') }))
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  }

  return new Promise((resolve, reject) => {
    const mod = require(url.startsWith('http:') ? 'http' : 'https');
    const target = new URL(url);
    const req = mod.request(
      {
        hostname: target.hostname,
        port: target.port || undefined,
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          text += d;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, text }));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('heartbeat timed out')));
    req.write(body);
    req.end();
  });
}

/** Read a WhatsApp number out of a Baileys socket, whichever way it is exposed. */
function phoneOf(sock) {
  if (!sock) return '';
  if (sock.__waNum) return String(sock.__waNum);
  const id = String((sock.user && sock.user.id) || '');
  return id.split(':')[0].split('@')[0] || '';
}

/** A socket counts as live when it is paired and its websocket is not known-closed. */
function isLive(sock) {
  if (!sock || !sock.user) return false;
  if (sock.ws && sock.ws.isOpen === false) return false;
  return true;
}

/**
 * Start reporting. Returns a stop() function.
 * opts: { getSockets, recordSession, portal, server, name, intervalMs, log }
 */
function startStatusReporter(opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts);
  const portal = String((process.env.VARNOX_PORTAL_URL || cfg.portal || '')).replace(/\/+$/, '');
  const server = Number(process.env.VARNOX_SERVER_ID || cfg.server || 1) || 1;
  const name = String(process.env.VARNOX_SERVER_NAME || cfg.name || `Server ${server}`);
  const intervalMs = Math.max(15000, Number(process.env.VARNOX_STATUS_MS || cfg.intervalMs) || 45000);
  const log = typeof cfg.log === 'function' ? cfg.log : (...a) => console.log('[VARNOX-STATUS]', ...a);
  const warn = typeof cfg.warn === 'function' ? cfg.warn : (...a) => console.warn('[VARNOX-STATUS]', ...a);

  if (!portal) {
    log('no portal URL configured - status reporting disabled');
    return () => {};
  }

  let stopped = false;
  let lastWarnAt = 0;

  async function tick() {
    if (stopped) return;

    // 1) Tell the dashboard this host is alive.
    try {
      const res = await postJson(`${portal}/api/heartbeat`, { server, name }, cfg.timeoutMs);
      if (res.status !== 200 && Date.now() - lastWarnAt > 60000) {
        lastWarnAt = Date.now();
        warn(`heartbeat rejected (HTTP ${res.status}): ${String(res.text).slice(0, 140)}`);
      }
    } catch (e) {
      if (Date.now() - lastWarnAt > 60000) {
        lastWarnAt = Date.now();
        warn('heartbeat failed:', (e && e.message) || e);
      }
    }

    // 2) Keep the session rows fresh so "Online now" reflects reality.
    try {
      const sockets = typeof cfg.getSockets === 'function' ? cfg.getSockets() : null;
      if (sockets && typeof cfg.recordSession === 'function') {
        for (const [sid, sock] of sockets) {
          try {
            await cfg.recordSession(sid, phoneOf(sock), isLive(sock) ? 'connected' : 'disconnected');
          } catch (_) {
            /* one bad socket must never stop the loop */
          }
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  // First report a few seconds after boot, then on a steady interval.
  const firstTimer = setTimeout(tick, 4000);
  const timer = setInterval(tick, intervalMs);
  if (firstTimer.unref) firstTimer.unref();
  if (timer.unref) timer.unref();

  log(`reporting to ${portal} as "${name}" every ${Math.round(intervalMs / 1000)}s`);

  return function stop() {
    stopped = true;
    clearTimeout(firstTimer);
    clearInterval(timer);
  };
}

module.exports = { startStatusReporter, postJson };
