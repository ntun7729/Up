import { connect } from 'cloudflare:sockets';

let userID = '86c50e3a-5b87-49dd-bd20-03c7f2735e40';
const proxyIPs = ['pyip.ygkkk.dpdns.org'];

const VERSION = 'up-vless-stable-2026-05-15';
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const ADDRESS_TYPE_IPV4 = 1;
const ADDRESS_TYPE_DOMAIN = 2;
const ADDRESS_TYPE_IPV6 = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 6000;
const MAX_CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query',
  'https://dns.quad9.net/dns-query',
];

export default {
  async fetch(request, env, ctx) {
    const cfg = loadConfig(env, request);
    const url = new URL(request.url);

    try {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        return handleVlessWebSocket(request, cfg);
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        return handleHttp(request, url, cfg);
      }

      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD' },
      });
    } catch (error) {
      log(cfg, 'fetch_error', { message: error?.message || String(error) });
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

function handleHttp(request, url, cfg) {
  const path = normalizePath(url.pathname);

  if (path === '/health') {
    return jsonResponse({
      ok: true,
      service: 'up-vless-worker',
      version: VERSION,
      timestamp: new Date().toISOString(),
    });
  }

  if (path === '/status') {
    return jsonResponse({
      ok: true,
      version: VERSION,
      uuidConfigured: Boolean(cfg.uuid),
      proxyFallbackCount: cfg.proxyIPs.length,
      udpMode: cfg.udpMode,
      dnsEndpoints: cfg.dohEndpoints.length,
      connectTimeoutMs: cfg.connectTimeoutMs,
      timestamp: new Date().toISOString(),
    });
  }

  const uuidPath = '/' + cfg.uuid;
  if (path === '/' || path === uuidPath) {
    return new Response(renderHome(url, cfg), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  if (path === uuidPath + '/sub' || path === '/sub/' + cfg.uuid) {
    return new Response(buildSubscription(url, cfg), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  return new Response('Not Found', { status: 404 });
}

async function handleVlessWebSocket(request, cfg) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let address = '';
  let portWithRandomLog = '';
  const remoteSocketWrapper = { value: null };
  let udpHandler = null;

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, cfg);

  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (udpHandler) {
        await udpHandler(chunk);
        return;
      }

      if (remoteSocketWrapper.value) {
        const writer = remoteSocketWrapper.value.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      const vless = processVlessHeader(chunk, cfg.uuid);
      if (vless.hasError) {
        throw new Error(vless.message);
      }

      address = vless.addressRemote;
      portWithRandomLog = `${vless.portRemote}--${Math.random()} ${vless.isUDP ? 'udp' : 'tcp'} `;
      const vlessResponseHeader = new Uint8Array([vless.version[0], 0]);
      const rawClientData = chunk.slice(vless.rawDataIndex);

      if (vless.isUDP) {
        if (vless.portRemote !== 53) {
          throw new Error('UDP proxy is only supported for DNS on port 53');
        }
        udpHandler = await handleUDPOutBound(webSocket, vlessResponseHeader, cfg);
        await udpHandler(rawClientData);
        return;
      }

      await handleTCPOutBound(
        remoteSocketWrapper,
        address,
        vless.portRemote,
        rawClientData,
        webSocket,
        vlessResponseHeader,
        cfg,
      );
    },
    close() {
      safeCloseWebSocket(webSocket);
    },
    abort(reason) {
      log(cfg, 'ws_stream_abort', { address, portWithRandomLog, reason: String(reason) });
      safeCloseWebSocket(webSocket);
    },
  })).catch((error) => {
    log(cfg, 'ws_stream_error', { address, portWithRandomLog, message: error?.message || String(error) });
    safeCloseWebSocket(webSocket);
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, cfg) {
  async function connectAndWrite(address, port) {
    const tcpSocket = connect({ hostname: address, port });
    if (tcpSocket.opened) {
      await withTimeout(tcpSocket.opened, cfg.connectTimeoutMs, 'TCP connect timeout');
    }
    remoteSocketWrapper.value = tcpSocket;
    const writer = tcpSocket.writable.getWriter();
    if (rawClientData?.byteLength > 0) {
      await writer.write(rawClientData);
    }
    writer.releaseLock();
    return tcpSocket;
  }

  async function retryWithProxyIPs() {
    let lastError;
    for (const proxyIP of cfg.proxyIPs) {
      try {
        log(cfg, 'tcp_retry_proxyip', { port: portRemote });
        const tcpSocket = await connectAndWrite(proxyIP, portRemote);
        tcpSocket.closed.catch(() => {}).finally(() => safeCloseWebSocket(webSocket));
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, cfg);
        return;
      } catch (error) {
        lastError = error;
        log(cfg, 'tcp_proxyip_failed', { message: error?.message || String(error) });
      }
    }
    throw lastError || new Error('All proxy IP retries failed');
  }

  if (cfg.disableDirect) {
    await retryWithProxyIPs();
    return;
  }

  try {
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retryWithProxyIPs, cfg);
  } catch (error) {
    log(cfg, 'tcp_direct_failed', { message: error?.message || String(error) });
    await retryWithProxyIPs();
  }
}

function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, cfg) {
  let remoteChunkCount = 0;
  let header = vlessResponseHeader;

  remoteSocket.readable.pipeTo(new WritableStream({
    async write(chunk) {
      remoteChunkCount++;
      if (webSocket.readyState !== WS_READY_STATE_OPEN) {
        throw new Error('WebSocket is not open');
      }
      if (header) {
        webSocket.send(await new Blob([header, chunk]).arrayBuffer());
        header = null;
      } else {
        webSocket.send(chunk);
      }
    },
  })).catch((error) => {
    log(cfg, 'remote_pipe_error', { message: error?.message || String(error) });
    safeCloseWebSocket(webSocket);
  }).finally(() => {
    if (remoteChunkCount === 0 && retry) {
      retry().catch((error) => {
        log(cfg, 'remote_retry_failed', { message: error?.message || String(error) });
        safeCloseWebSocket(webSocket);
      });
    }
  });
}

async function handleUDPOutBound(webSocket, vlessResponseHeader, cfg) {
  let responseHeader = vlessResponseHeader;

  return async function processUDPChunk(chunk) {
    const packets = parseVlessUDPPackets(chunk);

    for (const packet of packets) {
      const dnsResponse = await queryDNS(packet, cfg);
      if (!dnsResponse || webSocket.readyState !== WS_READY_STATE_OPEN) continue;

      const size = dnsResponse.byteLength;
      const sizeHeader = new Uint8Array([(size >> 8) & 0xff, size & 0xff]);
      const payload = responseHeader
        ? await new Blob([responseHeader, sizeHeader, dnsResponse]).arrayBuffer()
        : await new Blob([sizeHeader, dnsResponse]).arrayBuffer();
      responseHeader = null;
      webSocket.send(payload);
    }
  };
}

function parseVlessUDPPackets(chunk) {
  const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  const packets = [];
  let offset = 0;

  while (offset + 2 <= data.byteLength) {
    const length = (data[offset] << 8) | data[offset + 1];
    offset += 2;
    if (length <= 0 || offset + length > data.byteLength) {
      break;
    }
    packets.push(data.slice(offset, offset + length));
    offset += length;
  }

  if (!packets.length && data.byteLength > 0) {
    packets.push(data);
  }

  return packets;
}

async function queryDNS(queryPacket, cfg) {
  let lastError;

  for (const endpoint of cfg.dohEndpoints) {
    try {
      const response = await withTimeout(fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/dns-message',
          'accept': 'application/dns-message',
        },
        body: queryPacket,
      }), cfg.dnsTimeoutMs, 'DNS query timeout');

      if (!response.ok) {
        throw new Error(`DoH returned ${response.status}`);
      }

      return await response.arrayBuffer();
    } catch (error) {
      lastError = error;
      log(cfg, 'dns_query_failed', { endpoint, message: error?.message || String(error) });
    }
  }

  throw lastError || new Error('DNS query failed');
}

function processVlessHeader(vlessBuffer, expectedUUID) {
  if (vlessBuffer.byteLength < 24) {
    return { hasError: true, message: 'invalid data' };
  }

  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  const receivedUUID = stringifyUUID(new Uint8Array(vlessBuffer.slice(1, 17)));
  if (receivedUUID !== expectedUUID.toLowerCase()) {
    return { hasError: true, message: 'invalid user' };
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const commandIndex = 18 + optLength;
  const command = new Uint8Array(vlessBuffer.slice(commandIndex, commandIndex + 1))[0];

  let isUDP = false;
  if (command === 1) {
    isUDP = false;
  } else if (command === 2) {
    isUDP = true;
  } else {
    return { hasError: true, message: `unsupported command: ${command}` };
  }

  const portIndex = commandIndex + 1;
  const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
  const addressTypeIndex = portIndex + 2;
  const addressType = new Uint8Array(vlessBuffer.slice(addressTypeIndex, addressTypeIndex + 1))[0];
  let addressLength = 0;
  let addressValueIndex = addressTypeIndex + 1;
  let addressRemote = '';

  switch (addressType) {
    case ADDRESS_TYPE_IPV4:
      addressLength = 4;
      addressRemote = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case ADDRESS_TYPE_DOMAIN:
      addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressRemote = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case ADDRESS_TYPE_IPV6: {
      addressLength = 16;
      const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressRemote = ipv6.join(':');
      break;
    }
    default:
      return { hasError: true, message: `invalid address type: ${addressType}` };
  }

  if (!addressRemote) {
    return { hasError: true, message: 'empty remote address' };
  }

  return {
    hasError: false,
    addressRemote,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    version,
    isUDP,
  };
}

function makeReadableWebSocketStream(webSocket, earlyDataHeader, cfg) {
  let readableStreamCancel = false;

  return new ReadableStream({
    start(controller) {
      webSocket.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        const data = event.data;
        if (typeof data === 'string') {
          controller.enqueue(new TextEncoder().encode(data));
        } else {
          controller.enqueue(data);
        }
      });

      webSocket.addEventListener('close', () => {
        safeCloseWebSocket(webSocket);
        if (!readableStreamCancel) controller.close();
      });

      webSocket.addEventListener('error', (error) => {
        controller.error(error);
      });

      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    cancel(reason) {
      readableStreamCancel = true;
      log(cfg, 'readable_stream_cancel', { reason: String(reason) });
      safeCloseWebSocket(webSocket);
    },
  });
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { earlyData: null, error: null };
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const array = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: array.buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
}

function loadConfig(env = {}, request) {
  const uuid = normalizeUUID(firstNonEmpty(env.UUID, env.uuid, env.USER_ID, env.userID, userID));
  if (!uuid) {
    throw new Error('A valid UUID is required');
  }

  return {
    uuid,
    proxyIPs: parseCSV(firstNonEmpty(env.PROXY_IPS, env.proxyIPs, env.PROXYIP, env.proxyip), proxyIPs),
    connectTimeoutMs: clamp(parseIntSafe(firstNonEmpty(env.CONNECT_TIMEOUT_MS, env.connectTimeoutMs), DEFAULT_CONNECT_TIMEOUT_MS), 1000, MAX_CONNECT_TIMEOUT_MS),
    dnsTimeoutMs: clamp(parseIntSafe(firstNonEmpty(env.DNS_TIMEOUT_MS, env.dnsTimeoutMs), 5000), 1000, MAX_CONNECT_TIMEOUT_MS),
    dohEndpoints: parseCSV(firstNonEmpty(env.DOH_ENDPOINTS, env.dohEndpoints), DEFAULT_DOH_ENDPOINTS),
    disableDirect: parseBool(firstNonEmpty(env.DISABLE_DIRECT, env.disableDirect), false),
    logs: parseBool(firstNonEmpty(env.ENABLE_LOGS, env.enableLogs), false),
    udpMode: 'dns-over-https',
    requestHost: request.headers.get('Host') || '',
  };
}

function buildSubscription(url, cfg) {
  const host = url.hostname;
  const addresses = parseCSV('', [host, '104.16.0.0', '104.17.0.0', '104.18.0.0', '104.19.0.0', '104.20.0.0', '104.21.0.0']);
  const path = encodeURIComponent('/' + cfg.uuid + '?ed=2048');
  const links = [];

  for (const address of addresses) {
    links.push(`vless://${cfg.uuid}@${address}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=${path}#${encodeURIComponent('Up-VLESS-' + address)}`);
  }

  return btoa(links.join('\n'));
}

function renderHome(url, cfg) {
  const origin = url.origin;
  const subUrl = `${origin}/${cfg.uuid}/sub`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Up VLESS Worker</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1020;color:#e5e7eb;margin:0;padding:32px}
main{max-width:760px;margin:auto;background:#111827;border:1px solid #263247;border-radius:16px;padding:28px;box-shadow:0 18px 60px rgba(0,0,0,.35)}
h1{margin-top:0}.ok{color:#86efac}code{background:#020617;border:1px solid #243244;border-radius:8px;padding:2px 6px;color:#93c5fd;word-break:break-all}.card{background:#0f172a;border:1px solid #243244;border-radius:12px;padding:14px;margin:14px 0}
</style>
</head>
<body><main>
<h1><span class="ok">OK</span> Up VLESS Worker</h1>
<p>The Worker is running. Use a VLESS WebSocket TLS client with your UUID.</p>
<div class="card"><b>UUID:</b> <code>${escapeHTML(cfg.uuid)}</code></div>
<div class="card"><b>Subscription:</b> <code>${escapeHTML(subUrl)}</code></div>
<div class="card"><b>UDP:</b> DNS over HTTPS relay for UDP/53 is enabled.</div>
<div class="card"><b>Health:</b> <code>/health</code> | <b>Status:</b> <code>/status</code></div>
</main></body></html>`;
}

function normalizeUUID(value) {
  const uuid = String(value || '').trim().toLowerCase();
  return isValidUUID(uuid) ? uuid : '';
}

function isValidUUID(uuid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid);
}

function stringifyUUID(bytes) {
  const hex = [];
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function parseCSV(value, fallback = []) {
  const list = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? list : fallback.slice();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

function normalizePath(pathname) {
  let path = pathname || '/';
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close(1000, 'closed');
    }
  } catch {}
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timer = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeoutId));
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseIntSafe(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseBool(value, fallback) {
  if (value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function log(cfg, event, data = {}) {
  if (!cfg.logs) return;
  try {
    console.log(JSON.stringify({ event, ...data, time: new Date().toISOString() }));
  } catch {}
}
