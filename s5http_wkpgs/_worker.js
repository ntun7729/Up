import { connect } from 'cloudflare:sockets';

const DEFAULT_PYIP = ['pyip.ygkkk.dpdns.org'];
const DEFAULT_TOKEN = '';
const VERSION = 'up-safe-2026-05-15';
const WS_OPEN = 1;
const WS_CLOSING = 2;
const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const cfg = config(env);
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    try {
      if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
        return httpResponse(request, url, cfg);
      }

      if (cfg.path && cleanPath(url.pathname) !== cfg.path) {
        return new Response('Not Found', { status: 404 });
      }

      if (cfg.token && request.headers.get('Sec-WebSocket-Protocol') !== cfg.token) {
        return new Response('Unauthorized', { status: 401 });
      }

      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.binaryType = 'arraybuffer';
      handleSession(server, cfg).catch(() => closeWs(server));

      const init = { status: 101, webSocket: client };
      if (cfg.token) init.headers = { 'Sec-WebSocket-Protocol': cfg.token };
      return new Response(null, init);
    } catch (err) {
      if (cfg.logs) console.log(JSON.stringify({ event: 'fetch_error', message: err.message }));
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

function httpResponse(request, url, cfg) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const path = cleanPath(url.pathname);
  if (path === '/health') {
    return json({ ok: true, service: 'up-cf-worker', version: VERSION, time: new Date().toISOString() });
  }

  if (path === '/status') {
    return json({
      ok: true,
      version: VERSION,
      tokenRequired: Boolean(cfg.token),
      accessPath: cfg.path || '/',
      proxyFallbackCount: cfg.pyip.length,
      connectTimeoutMs: cfg.timeout,
      directDisabled: cfg.disableDirect,
    });
  }

  if (path === '/' || (cfg.path && path === cfg.path)) {
    return new Response(page(cfg), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  return new Response('WebSocket upgrade required', { status: 426 });
}

async function handleSession(ws, cfg) {
  let remoteSocket;
  let remoteWriter;
  let remoteReader;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { remoteWriter?.releaseLock(); } catch {}
    try { remoteReader?.releaseLock(); } catch {}
    try { remoteSocket?.close(); } catch {}
    remoteSocket = remoteWriter = remoteReader = null;
    closeWs(ws);
  };

  async function pumpRemote() {
    try {
      while (!closed && remoteReader) {
        const { done, value } = await remoteReader.read();
        if (done || ws.readyState !== WS_OPEN) break;
        if (value?.byteLength) ws.send(value);
      }
    } catch {}
    if (!closed) {
      try { ws.send('CLOSE'); } catch {}
      cleanup();
    }
  }

  async function connectRemote(targetAddr, firstFrame, clientPyip) {
    const { host, port } = parseTarget(targetAddr);
    const fallback = Array.isArray(clientPyip) && clientPyip.length ? clientPyip : cfg.pyip;
    const attempts = cfg.disableDirect ? fallback : [null, ...fallback];
    let lastError;

    for (let i = 0; i < attempts.length; i++) {
      const candidate = attempts[i];
      try {
        remoteSocket = connect({ hostname: candidate || host, port });
        if (remoteSocket.opened) await timeout(remoteSocket.opened, cfg.timeout, 'Remote connection timed out');
        remoteWriter = remoteSocket.writable.getWriter();
        remoteReader = remoteSocket.readable.getReader();
        if (firstFrame) await remoteWriter.write(encoder.encode(firstFrame));
        ws.send('CONNECTED');
        pumpRemote();
        return;
      } catch (err) {
        lastError = err;
        try { remoteWriter?.releaseLock(); } catch {}
        try { remoteReader?.releaseLock(); } catch {}
        try { remoteSocket?.close(); } catch {}
        remoteSocket = remoteWriter = remoteReader = null;
        if (cfg.logs) console.log(JSON.stringify({ event: 'connect_failed', attempt: i + 1, direct: !candidate, message: err.message }));
      }
    }

    throw lastError || new Error('Remote connection failed');
  }

  ws.addEventListener('message', async (event) => {
    if (closed) return;
    try {
      const data = event.data;
      if (typeof data === 'string') {
        if (data.startsWith('CONNECT:')) {
          const parts = data.substring(8).split('|');
          await connectRemote(parts[0] || '', parts[1] ?? '', parseClientPyip(parts[2], cfg.maxClientPyip));
        } else if (data.startsWith('DATA:')) {
          if (remoteWriter) await remoteWriter.write(encoder.encode(data.substring(5)));
        } else if (data === 'PING') {
          if (ws.readyState === WS_OPEN) ws.send('PONG');
        } else if (data === 'CLOSE') {
          cleanup();
        }
      } else if (data instanceof ArrayBuffer && remoteWriter) {
        await remoteWriter.write(new Uint8Array(data));
      }
    } catch (err) {
      try { ws.send('ERROR:' + err.message); } catch {}
      cleanup();
    }
  });

  ws.addEventListener('close', cleanup);
  ws.addEventListener('error', cleanup);
}

function config(env = {}) {
  const token = first(env.TOKEN, env.token, DEFAULT_TOKEN);
  const pyip = csv(first(env.PYIP_LIST, env.PYIP, env.pyip), DEFAULT_PYIP);
  return {
    token,
    pyip,
    path: accessPath(first(env.ACCESS_PATH, env.CUSTOM_PATH, env.access_path, env.custom_path)),
    timeout: clamp(int(first(env.CONNECT_TIMEOUT_MS, env.connect_timeout_ms), 5000), 1000, 30000),
    maxClientPyip: clamp(int(first(env.MAX_CLIENT_PYIP, env.max_client_pyip), 8), 1, 20),
    disableDirect: bool(first(env.DISABLE_DIRECT, env.disable_direct), false),
    logs: bool(first(env.ENABLE_LOGS, env.enable_logs), false),
  };
}

function parseTarget(addr) {
  if (!addr || typeof addr !== 'string' || addr.length > 512) throw new Error('Invalid target address');
  let host;
  let portText;
  if (addr.startsWith('[')) {
    const end = addr.indexOf(']');
    if (end < 0 || addr[end + 1] !== ':') throw new Error('Invalid IPv6 target format');
    host = addr.slice(1, end);
    portText = addr.slice(end + 2);
  } else {
    const sep = addr.lastIndexOf(':');
    if (sep <= 0 || sep === addr.length - 1) throw new Error('Target must be host:port');
    host = addr.slice(0, sep);
    portText = addr.slice(sep + 1);
  }
  const port = Number(portText);
  if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid target host or port');
  return { host, port };
}

function parseClientPyip(value, max) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text.toUpperCase().startsWith('PYIP=')) return null;
  const out = text.slice(5).split(',').map(x => x.trim()).filter(validProxyHost).slice(0, max);
  return out.length ? out : null;
}

function csv(value, fallback) {
  const out = String(value || '').split(',').map(x => x.trim()).filter(validProxyHost);
  return out.length ? out : fallback.slice();
}

function validProxyHost(host) {
  if (!host || host.length > 255 || /\s/.test(host)) return false;
  if (host.startsWith('[') && host.endsWith(']')) return validHost(host.slice(1, -1));
  return validHost(host);
}

function validHost(host) {
  return Boolean(host && host.length <= 253 && !/\s/.test(host) && !/[\\/]/.test(host));
}

function accessPath(value) {
  if (!value) return '';
  const p = cleanPath(String(value));
  if (p === '/' || p.includes('..')) return '';
  return p;
}

function cleanPath(value) {
  let p = value || '/';
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function timeout(promise, ms, message) {
  let id;
  const timer = new Promise((_, reject) => { id = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(id));
}

function closeWs(ws) {
  try {
    if (ws.readyState === WS_OPEN || ws.readyState === WS_CLOSING) ws.close(1000, 'Server closed');
  } catch {}
}

function json(data) {
  return new Response(JSON.stringify(data, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function page(cfg) {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Up Worker</title><body style="font-family:system-ui;background:#0b1020;color:#e5e7eb;padding:32px"><main style="max-width:720px;margin:auto;background:#111827;border:1px solid #243244;border-radius:16px;padding:28px"><h1>Up Worker is running</h1><p>This endpoint is ready for the Cloudflare Socks5/HTTP local proxy helper.</p><p><b>Access path:</b> <code>' + escapeHtml(cfg.path || '/') + '</code></p><p><b>Token required:</b> <code>' + (cfg.token ? 'yes' : 'no') + '</code></p><p>Health: <code>/health</code> | Status: <code>/status</code></p></main></body>';
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function first(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

function int(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function bool(value, fallback) {
  if (value === '') return fallback;
  const v = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return fallback;
}
