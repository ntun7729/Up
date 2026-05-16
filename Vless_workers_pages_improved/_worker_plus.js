import { connect } from "cloudflare:sockets";

const DEFAULT_UUID = "86c50e3a-5b87-49dd-bd20-03c7f2735e40";
const DEFAULT_VERSION = "up-v2-2026-05-16";
const DEFAULT_PROXY_IPS = ["pyip.ygkkk.dpdns.org"];
const DEFAULT_DOH_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/dns-query",
  "https://dns.quad9.net/dns-query",
];
const DEFAULT_DNS_TCP_SERVERS = ["1.1.1.1:53", "8.8.8.8:53", "9.9.9.9:53"];
const DEFAULT_SUB_IPS = [
  "104.16.0.0",
  "104.17.0.0",
  "104.18.0.0",
  "104.19.0.0",
  "104.20.0.0",
  "104.21.0.0",
  "172.64.0.0",
  "172.65.0.0",
  "172.66.0.0",
  "172.67.0.0",
];

const WS_OPEN = 1;
const WS_CLOSING = 2;
const CMD_TCP = 1;
const CMD_UDP = 2;
const ATYP_IPV4 = 1;
const ATYP_DOMAIN = 2;
const ATYP_IPV6 = 3;

const dnsCache = new Map();
const proxyCooldowns = new Map();
const activeSessionsByIp = new Map();

let preferredDohEndpoint = "";

export default {
  async fetch(request, env) {
    const config = buildConfig(env || {}, request);
    const url = new URL(request.url);

    try {
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        return await handleWebSocket(request, config);
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }

      return handleHttpRequest(url, request, config);
    } catch (error) {
      logEvent(config, "fetch_error", {
        message: error?.message || String(error),
      });
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

function handleHttpRequest(url, request, config) {
  const path = normalizePath(url.pathname);
  const hiddenPath = `/${config.uuid}`;
  const headers = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };

  if (path === "/health") {
    return json(
      {
        ok: true,
        service: "up-v2-worker",
        version: config.version,
        timestamp: new Date().toISOString(),
      },
      200,
      headers,
    );
  }

  if (path === "/status") {
    return json(buildStatusPayload(request, config), 200, headers);
  }

  if (path === "/" || path === "/index.html") {
    return new Response(renderLandingPage(url, config), {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  if (path === hiddenPath) {
    return new Response(renderProfilePage(url, config), {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  if (path === `${hiddenPath}/sub` || path === `/sub/${config.uuid}`) {
    return new Response(buildBaseSubscription(url, config), {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  if (path === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      status: 200,
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new Response("Not Found", { status: 404, headers });
}

async function handleWebSocket(request, config) {
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!tryOpenSession(clientIp, config.maxWsPerIp)) {
    return new Response("Too Many Connections", { status: 429 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const state = {
    clientIp,
    outboundSocket: null,
    udpRelay: null,
    closed: false,
  };

  const incoming = makeWebSocketReadable(
    server,
    request.headers.get("sec-websocket-protocol") || "",
    config,
  );

  incoming
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          if (state.closed) {
            return;
          }

          if (state.udpRelay) {
            await state.udpRelay(chunk);
            return;
          }

          if (state.outboundSocket) {
            const writer = state.outboundSocket.writable.getWriter();
            try {
              await writer.write(toUint8Array(chunk));
            } finally {
              writer.releaseLock();
            }
            return;
          }

          const parsed = parseVlessRequest(chunk, config.uuid);
          if (parsed.error) {
            throw new Error(parsed.message);
          }

          if (config.blockPrivateDestinations && isPrivateDestination(parsed.host, parsed.addressType)) {
            throw new Error("Private destinations are blocked by policy");
          }

          const responseHeader = new Uint8Array([parsed.version, 0]);
          const initialPayload = toUint8Array(chunk).slice(parsed.payloadOffset);

          if (parsed.isUdp) {
            if (parsed.port !== 53) {
              throw new Error("UDP is only enabled for DNS on port 53");
            }
            state.udpRelay = createDnsRelay(server, responseHeader, config);
            if (initialPayload.byteLength) {
              await state.udpRelay(initialPayload);
            }
            return;
          }

          state.outboundSocket = await connectOutbound(
            parsed.host,
            parsed.port,
            initialPayload,
            server,
            responseHeader,
            config,
          );
        },
        close() {
          closeState(state, server);
        },
        abort(reason) {
          logEvent(config, "ws_abort", { reason: String(reason) });
          closeState(state, server);
        },
      }),
    )
    .catch((error) => {
      logEvent(config, "ws_error", {
        message: error?.message || String(error),
      });
      closeState(state, server);
    });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

async function connectOutbound(host, port, initialPayload, webSocket, responseHeader, config) {
  const candidates = buildConnectCandidates(host, port, config);
  if (!candidates.length) {
    throw new Error("No available outbound candidates");
  }

  let lastError = null;

  for (const candidate of candidates) {
    let socket = null;
    try {
      logEvent(config, "tcp_try", {
        kind: candidate.kind,
        host: candidate.hostname,
        port: candidate.port,
      });

      socket = connect({
        hostname: candidate.hostname,
        port: candidate.port,
      });
      if (socket.opened) {
        await withTimeout(socket.opened, config.connectTimeoutMs, "TCP connect timeout");
      }

      if (initialPayload.byteLength) {
        const writer = socket.writable.getWriter();
        try {
          await writer.write(initialPayload);
        } finally {
          writer.releaseLock();
        }
      }

      await startOutboundPump(socket, webSocket, responseHeader, config, initialPayload.byteLength > 0);
      socket.closed.catch(() => {}).finally(() => safeCloseWebSocket(webSocket));
      return socket;
    } catch (error) {
      lastError = error;
      if (candidate.kind === "proxy") {
        markProxyCooldown(candidate.id, config.proxyFailCooldownMs);
      }
      logEvent(config, "tcp_fail", {
        kind: candidate.kind,
        host: candidate.hostname,
        port: candidate.port,
        message: error?.message || String(error),
      });
      safeCloseSocket(socket);
    }
  }

  throw lastError || new Error("All outbound connection attempts failed");
}

async function startOutboundPump(socket, webSocket, responseHeader, config, waitForFirstByte) {
  const reader = socket.readable.getReader();
  let header = responseHeader;

  if (waitForFirstByte && config.firstByteTimeoutMs > 0) {
    const first = await withTimeout(
      reader.read(),
      config.firstByteTimeoutMs,
      "First byte timeout",
    );

    if (first.done || !first.value || first.value.byteLength === 0) {
      reader.releaseLock();
      throw new Error("Upstream closed before sending data");
    }

    if (webSocket.readyState !== WS_OPEN) {
      reader.releaseLock();
      throw new Error("WebSocket is not open");
    }

    webSocket.send(concatArrayBuffers(header, first.value));
    header = null;
  }

  pumpReadableToWebSocket(reader, webSocket, header, config);
}

function pumpReadableToWebSocket(reader, webSocket, header, config) {
  let prefixed = false;

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }
        if (webSocket.readyState !== WS_OPEN) {
          throw new Error("WebSocket is not open");
        }

        if (!prefixed && header) {
          webSocket.send(concatArrayBuffers(header, value));
          prefixed = true;
        } else {
          webSocket.send(value);
        }
      }
    } catch (error) {
      logEvent(config, "pipe_error", {
        message: error?.message || String(error),
      });
    } finally {
      try {
        reader.releaseLock();
      } catch {}
      safeCloseWebSocket(webSocket);
    }
  })();
}

function createDnsRelay(webSocket, responseHeader, config) {
  let header = responseHeader;

  return async function relay(chunk) {
    const packets = parseUdpFrames(chunk, config);
    for (const packet of packets) {
      let response;
      try {
        response = await resolveDnsPacket(packet, config);
      } catch (error) {
        logEvent(config, "dns_error", {
          message: error?.message || String(error),
        });
        response = makeDnsFailureResponse(packet);
      }

      if (webSocket.readyState !== WS_OPEN) {
        return;
      }

      const framed = prefixWithLength(response);
      if (header) {
        webSocket.send(concatArrayBuffers(header, framed));
        header = null;
      } else {
        webSocket.send(framed);
      }
    }
  };
}

async function resolveDnsPacket(packet, config) {
  const key = buildDnsCacheKey(packet);
  if (key) {
    const cached = dnsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      logEvent(config, "dns_cache_hit", { key });
      return rewriteDnsTransactionId(packet, cached.response);
    }
    if (cached) {
      dnsCache.delete(key);
    }
  }

  let response = null;
  if (config.dohStrategy === "race") {
    response = await queryDohRace(packet, config);
  } else {
    response = await queryDohSequential(packet, config);
  }

  if (!response && config.dnsTcpFallback) {
    response = await queryDnsTcp(packet, config);
  }
  if (!response) {
    throw new Error("All DNS upstreams failed");
  }

  if (key && config.dnsCacheTtlSeconds > 0) {
    while (dnsCache.size >= config.dnsCacheMaxEntries) {
      const oldestKey = dnsCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      dnsCache.delete(oldestKey);
    }
    dnsCache.set(key, {
      expiresAt: Date.now() + config.dnsCacheTtlSeconds * 1000,
      response: cloneArrayBuffer(response),
    });
  }

  return response;
}

async function queryDohRace(packet, config) {
  const endpoints = orderDohEndpoints(config);
  const controllers = [];
  let settled = false;

  try {
    return await new Promise((resolve) => {
      let remaining = endpoints.length;

      for (const endpoint of endpoints) {
        const controller = new AbortController();
        controllers.push(controller);
        const startedAt = Date.now();

        fetchDoh(endpoint, packet, config.dnsTimeoutMs, controller.signal)
          .then((response) => {
            if (!settled) {
              settled = true;
              preferredDohEndpoint = endpoint;
              logEvent(config, "doh_win", {
                endpoint,
                latencyMs: Date.now() - startedAt,
              });
              resolve(response);
            }
          })
          .catch((error) => {
            logEvent(config, "doh_fail", {
              endpoint,
              message: error?.message || String(error),
            });
          })
          .finally(() => {
            remaining -= 1;
            if (remaining === 0 && !settled) {
              settled = true;
              resolve(null);
            }
          });
      }
    });
  } finally {
    for (const controller of controllers) {
      try {
        controller.abort();
      } catch {}
    }
  }
}

async function queryDohSequential(packet, config) {
  for (const endpoint of orderDohEndpoints(config)) {
    const startedAt = Date.now();
    try {
      const response = await fetchDoh(endpoint, packet, config.dnsTimeoutMs);
      preferredDohEndpoint = endpoint;
      logEvent(config, "doh_ok", {
        endpoint,
        latencyMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      logEvent(config, "doh_fail", {
        endpoint,
        message: error?.message || String(error),
      });
    }
  }
  return null;
}

async function fetchDoh(endpoint, packet, timeoutMs, signal) {
  const response = await withTimeout(
    fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/dns-message",
        accept: "application/dns-message",
      },
      body: packet,
      signal,
    }),
    timeoutMs,
    "DNS query timeout",
  );

  if (!response.ok) {
    throw new Error(`DoH returned ${response.status}`);
  }
  return await response.arrayBuffer();
}

async function queryDnsTcp(packet, config) {
  let lastError = null;
  for (const server of config.dnsTcpServers) {
    const target = parseHostPort(server, 53);
    let socket = null;
    try {
      socket = connect({ hostname: target.hostname, port: target.port });
      if (socket.opened) {
        await withTimeout(socket.opened, config.dnsTimeoutMs, "DNS TCP connect timeout");
      }

      const writer = socket.writable.getWriter();
      try {
        const packetBytes = toUint8Array(packet);
        await writer.write(prefixWithLength(packetBytes));
      } finally {
        writer.releaseLock();
      }

      const response = await withTimeout(readDnsTcpResponse(socket), config.dnsTimeoutMs, "DNS TCP read timeout");
      safeCloseSocket(socket);
      logEvent(config, "dns_tcp_ok", { server });
      return response;
    } catch (error) {
      lastError = error;
      logEvent(config, "dns_tcp_fail", {
        server,
        message: error?.message || String(error),
      });
      safeCloseSocket(socket);
    }
  }
  throw lastError || new Error("DNS TCP fallback failed");
}

async function readDnsTcpResponse(socket) {
  const reader = socket.readable.getReader();
  const chunks = [];
  let length = 0;
  let expected = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      chunks.push(value);
      length += value.byteLength;
      const buffer = mergeChunks(chunks, length);

      if (expected === null && buffer.byteLength >= 2) {
        expected = (buffer[0] << 8) | buffer[1];
      }

      if (expected !== null && buffer.byteLength >= expected + 2) {
        return buffer.slice(2, expected + 2).buffer;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  throw new Error("DNS TCP response ended early");
}

function buildStatusPayload(request, config) {
  const admin = isAdminRequest(request, config);
  if (!admin) {
    return {
      ok: true,
      service: "up-v2-worker",
      version: config.version,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    ok: true,
    service: "up-v2-worker",
    version: config.version,
    proxyPolicy: config.proxyPolicy,
    proxyCount: config.proxyIps.length,
    proxyFailCooldownMs: config.proxyFailCooldownMs,
    preferredDohEndpoint: preferredDohEndpoint || null,
    dohStrategy: config.dohStrategy,
    dohEndpoints: config.dohEndpoints,
    dnsCacheEntries: dnsCache.size,
    dnsCacheTtlSeconds: config.dnsCacheTtlSeconds,
    dnsTcpFallback: config.dnsTcpFallback,
    dnsTcpServers: config.dnsTcpServers,
    connectTimeoutMs: config.connectTimeoutMs,
    dnsTimeoutMs: config.dnsTimeoutMs,
    firstByteTimeoutMs: config.firstByteTimeoutMs,
    maxWsPerIp: config.maxWsPerIp,
    blockPrivateDestinations: config.blockPrivateDestinations,
    timestamp: new Date().toISOString(),
  };
}

function buildBaseSubscription(url, config) {
  const hostname = url.hostname;
  const path = encodeURIComponent(`/${config.uuid}?ed=2048`);
  const ips = dedupeList([hostname, ...DEFAULT_SUB_IPS]);
  const lines = [];

  for (const ip of ips) {
    lines.push(
      `vless://${config.uuid}@${ip}:443?encryption=none&security=tls&sni=${hostname}&fp=randomized&type=ws&host=${hostname}&path=${path}#${encodeURIComponent(
        `Up-V2-${ip}`,
      )}`,
    );
  }

  return btoa(lines.join("\n"));
}

function renderLandingPage(url, config) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Up Gateway</title>
  <style>
    :root {
      --bg: #f4f8f1;
      --panel: #ffffff;
      --line: #d6e6d2;
      --text: #1e2b21;
      --muted: #5e6d63;
      --brand: #009639;
      --brand-deep: #006b2a;
      --petal: rgba(0, 150, 57, 0.08);
      --shadow: 0 18px 50px rgba(18, 55, 29, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, Arial, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 12% 18%, var(--petal) 0 70px, transparent 71px),
        radial-gradient(circle at 18% 12%, var(--petal) 0 70px, transparent 71px),
        radial-gradient(circle at 24% 18%, var(--petal) 0 70px, transparent 71px),
        radial-gradient(circle at 18% 24%, var(--petal) 0 70px, transparent 71px),
        linear-gradient(180deg, #f9fcf8 0%, var(--bg) 100%);
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .shell {
      width: min(920px, 100%);
      background: var(--panel);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      border-radius: 20px;
      overflow: hidden;
    }
    .topbar {
      padding: 16px 22px;
      background: linear-gradient(180deg, #f2f8ef 0%, #edf6ea 100%);
      border-bottom: 1px solid var(--line);
      color: var(--brand-deep);
      font-size: 14px;
    }
    .hero {
      padding: 40px 28px 24px;
      display: grid;
      gap: 18px;
    }
    h1 {
      margin: 0;
      font-size: clamp(32px, 6vw, 54px);
      line-height: 1.02;
      letter-spacing: 0;
      color: var(--brand-deep);
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.6;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
      padding: 0 28px 28px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
      background: linear-gradient(180deg, #ffffff 0%, #f8fbf7 100%);
    }
    .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 10px;
    }
    .value {
      color: var(--text);
      font-size: 15px;
      line-height: 1.5;
      word-break: break-word;
    }
    .accent {
      color: var(--brand);
      font-weight: 700;
    }
    .footer {
      padding: 18px 28px 28px;
      color: var(--muted);
      font-size: 13px;
      border-top: 1px solid var(--line);
      background: #fbfdfb;
    }
    code {
      font-family: Consolas, "Courier New", monospace;
      background: #f2f7f1;
      color: var(--brand-deep);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 2px 6px;
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">up gateway / ${escapeHtml(config.version)}</div>
    <section class="hero">
      <h1>Welcome to Up Gateway</h1>
      <p>
        This worker is online, tuned for steadier DNS handling, cleaner failover,
        and a quieter public surface. The public page stays simple; the profile
        and subscription live behind your UUID path.
      </p>
    </section>
    <section class="grid">
      <article class="card">
        <div class="label">Health</div>
        <div class="value"><span class="accent">OK</span> / <code>/health</code></div>
      </article>
      <article class="card">
        <div class="label">Status</div>
        <div class="value">Public summary at <code>/status</code>. Add an admin token for detailed runtime data.</div>
      </article>
      <article class="card">
        <div class="label">Profile</div>
        <div class="value">Hidden profile page: <code>/${maskUuid(config.uuid)}</code></div>
      </article>
      <article class="card">
        <div class="label">Subscription</div>
        <div class="value">Kept behind the UUID path instead of being advertised on the front page.</div>
      </article>
    </section>
    <div class="footer">
      nginx-style simplicity, with a small flower motif and less accidental exposure.
    </div>
  </main>
</body>
</html>`;
}

function renderProfilePage(url, config) {
  const origin = url.origin;
  const subUrl = `${origin}/${config.uuid}/sub`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Up Gateway Profile</title>
  <style>
    :root {
      --bg: #07120a;
      --panel: #0d1c11;
      --panel-soft: #122617;
      --line: #22472c;
      --text: #e6f3e8;
      --muted: #9cc2a1;
      --brand: #44d16f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      padding: 24px;
      display: grid;
      place-items: center;
      color: var(--text);
      font-family: "Segoe UI", Tahoma, Arial, sans-serif;
      background:
        radial-gradient(circle at 80% 18%, rgba(68, 209, 111, 0.16) 0 90px, transparent 91px),
        radial-gradient(circle at 86% 12%, rgba(68, 209, 111, 0.12) 0 90px, transparent 91px),
        radial-gradient(circle at 92% 18%, rgba(68, 209, 111, 0.16) 0 90px, transparent 91px),
        radial-gradient(circle at 86% 24%, rgba(68, 209, 111, 0.12) 0 90px, transparent 91px),
        linear-gradient(180deg, #09140b 0%, var(--bg) 100%);
    }
    .shell {
      width: min(960px, 100%);
      border: 1px solid var(--line);
      border-radius: 22px;
      overflow: hidden;
      background: linear-gradient(180deg, var(--panel) 0%, #09130c 100%);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
    }
    .hero {
      padding: 28px;
      border-bottom: 1px solid var(--line);
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(30px, 5vw, 50px);
      line-height: 1.04;
      color: #f2fff4;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.6;
      font-size: 15px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 14px;
      padding: 24px 28px 28px;
    }
    .card {
      background: linear-gradient(180deg, var(--panel-soft) 0%, #0d1b11 100%);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
    }
    .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 8px;
    }
    .value {
      line-height: 1.6;
      word-break: break-word;
    }
    code {
      font-family: Consolas, "Courier New", monospace;
      display: inline-block;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 3px 7px;
      color: #e8fff0;
    }
    .good { color: var(--brand); font-weight: 700; }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <h1>Up Worker Profile</h1>
      <p>
        This path is intentionally quieter than the old public landing page, but it still gives
        you the subscription endpoint and the runtime profile that matters for day-to-day use.
      </p>
    </section>
    <section class="grid">
      <article class="card">
        <div class="label">UUID</div>
        <div class="value"><code>${escapeHtml(config.uuid)}</code></div>
      </article>
      <article class="card">
        <div class="label">Subscription</div>
        <div class="value"><code>${escapeHtml(subUrl)}</code></div>
      </article>
      <article class="card">
        <div class="label">Proxy Policy</div>
        <div class="value"><span class="good">${escapeHtml(config.proxyPolicy)}</span></div>
      </article>
      <article class="card">
        <div class="label">DNS</div>
        <div class="value">DoH ${escapeHtml(config.dohStrategy)} with TCP fallback ${config.dnsTcpFallback ? "enabled" : "disabled"}.</div>
      </article>
      <article class="card">
        <div class="label">Timeouts</div>
        <div class="value">Connect <code>${config.connectTimeoutMs}ms</code>, DNS <code>${config.dnsTimeoutMs}ms</code>, first-byte <code>${config.firstByteTimeoutMs}ms</code></div>
      </article>
      <article class="card">
        <div class="label">Safety</div>
        <div class="value">${config.blockPrivateDestinations ? "Private-address blocking is on." : "Private-address blocking is off."}</div>
      </article>
    </section>
  </main>
</body>
</html>`;
}

function buildConfig(env, request) {
  const uuid = normalizeUuid(
    firstDefined(env.UUID, env.uuid, env.USER_ID, env.userID, DEFAULT_UUID),
  );
  if (!uuid) {
    throw new Error("A valid UUID is required");
  }

  return {
    version: DEFAULT_VERSION,
    uuid,
    proxyIps: parseList(firstDefined(env.PROXY_IPS, env.proxyIps, env.PROXYIP, env.proxyip), DEFAULT_PROXY_IPS),
    proxyPolicy: parseEnum(
      firstDefined(env.PROXY_POLICY, env.proxyPolicy, env.DISABLE_DIRECT === "true" ? "proxy-only" : ""),
      ["proxy-first", "proxy-only", "direct-first"],
      DEFAULT_PROXY_IPS.length ? "proxy-first" : "direct-first",
    ),
    proxyFailCooldownMs: clampInteger(firstDefined(env.PROXY_FAIL_COOLDOWN_MS, env.proxyFailCooldownMs), 0, 900000, 120000),
    connectTimeoutMs: clampInteger(firstDefined(env.CONNECT_TIMEOUT_MS, env.connectTimeoutMs), 1000, 30000, 6000),
    dnsTimeoutMs: clampInteger(firstDefined(env.DNS_TIMEOUT_MS, env.dnsTimeoutMs), 1000, 30000, 5000),
    firstByteTimeoutMs: clampInteger(firstDefined(env.FIRST_BYTE_TIMEOUT_MS, env.firstByteTimeoutMs), 0, 15000, 2500),
    dnsCacheTtlSeconds: clampInteger(firstDefined(env.DNS_CACHE_TTL_SECONDS, env.dnsCacheTtlSeconds), 0, 3600, 300),
    dnsCacheMaxEntries: clampInteger(firstDefined(env.DNS_CACHE_MAX_ENTRIES, env.dnsCacheMaxEntries), 32, 2048, 512),
    dohEndpoints: parseList(firstDefined(env.DOH_ENDPOINTS, env.dohEndpoints), DEFAULT_DOH_ENDPOINTS),
    dohStrategy: parseEnum(firstDefined(env.DOH_STRATEGY, env.dohStrategy), ["race", "sequential"], "race"),
    dnsTcpFallback: parseBoolean(firstDefined(env.DNS_TCP_FALLBACK, env.dnsTcpFallback), true),
    dnsTcpServers: parseList(firstDefined(env.DNS_TCP_SERVERS, env.dnsTcpServers), DEFAULT_DNS_TCP_SERVERS),
    enableLogs: parseBoolean(firstDefined(env.ENABLE_LOGS, env.enableLogs), false),
    adminToken: firstDefined(env.ADMIN_TOKEN, env.adminToken),
    maxWsPerIp: clampInteger(firstDefined(env.MAX_WS_PER_IP, env.maxWsPerIp), 1, 64, 6),
    blockPrivateDestinations: parseBoolean(
      firstDefined(env.BLOCK_PRIVATE_DESTINATIONS, env.blockPrivateDestinations),
      false,
    ),
    host: request.headers.get("Host") || "",
  };
}

function parseVlessRequest(chunk, expectedUuid) {
  const bytes = toUint8Array(chunk);
  if (bytes.byteLength < 24) {
    return { error: true, message: "invalid data" };
  }

  const version = bytes[0];
  const uuid = formatUuidBytes(bytes.slice(1, 17));
  if (uuid !== expectedUuid) {
    return { error: true, message: "invalid user" };
  }

  const optionsLength = bytes[17];
  const commandIndex = 18 + optionsLength;
  if (bytes.byteLength < commandIndex + 4) {
    return { error: true, message: "invalid header length" };
  }

  const command = bytes[commandIndex];
  let isUdp = false;
  if (command === CMD_TCP) {
    isUdp = false;
  } else if (command === CMD_UDP) {
    isUdp = true;
  } else {
    return { error: true, message: `unsupported command: ${command}` };
  }

  const port = new DataView(bytes.buffer, bytes.byteOffset + commandIndex + 1, 2).getUint16(0);
  const addressType = bytes[commandIndex + 3];
  let cursor = commandIndex + 4;
  let host = "";

  if (addressType === ATYP_IPV4) {
    if (bytes.byteLength < cursor + 4) {
      return { error: true, message: "invalid IPv4 address length" };
    }
    host = Array.from(bytes.slice(cursor, cursor + 4)).join(".");
    cursor += 4;
  } else if (addressType === ATYP_DOMAIN) {
    const domainLength = bytes[cursor];
    cursor += 1;
    if (bytes.byteLength < cursor + domainLength) {
      return { error: true, message: "invalid domain length" };
    }
    host = new TextDecoder().decode(bytes.slice(cursor, cursor + domainLength));
    cursor += domainLength;
  } else if (addressType === ATYP_IPV6) {
    if (bytes.byteLength < cursor + 16) {
      return { error: true, message: "invalid IPv6 address length" };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 16);
    const parts = [];
    for (let i = 0; i < 8; i += 1) {
      parts.push(view.getUint16(i * 2).toString(16));
    }
    host = parts.join(":");
    cursor += 16;
  } else {
    return { error: true, message: `invalid address type: ${addressType}` };
  }

  if (!host) {
    return { error: true, message: "empty remote address" };
  }

  return {
    error: false,
    version,
    host,
    port,
    isUdp,
    addressType,
    payloadOffset: cursor,
  };
}

function makeWebSocketReadable(webSocket, earlyDataHeader, config) {
  let canceled = false;

  return new ReadableStream({
    start(controller) {
      webSocket.addEventListener("message", (event) => {
        if (canceled) {
          return;
        }
        const data = event.data;
        controller.enqueue(
          typeof data === "string" ? new TextEncoder().encode(data) : data,
        );
      });

      webSocket.addEventListener("close", () => {
        safeCloseWebSocket(webSocket);
        if (!canceled) {
          controller.close();
        }
      });

      webSocket.addEventListener("error", (error) => {
        controller.error(error);
      });

      const earlyData = decodeEarlyData(earlyDataHeader);
      if (earlyData.error) {
        controller.error(earlyData.error);
        return;
      }
      if (earlyData.data) {
        controller.enqueue(earlyData.data);
      }
    },
    cancel(reason) {
      canceled = true;
      logEvent(config, "read_cancel", { reason: String(reason) });
      safeCloseWebSocket(webSocket);
    },
  });
}

function decodeEarlyData(header) {
  if (!header) {
    return { data: null, error: null };
  }

  try {
    const normalized = header.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(normalized);
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    return { data: bytes.buffer, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

function buildConnectCandidates(host, port, config) {
  const direct = [
    {
      kind: "direct",
      hostname: host,
      port,
      id: `direct:${host}:${port}`,
    },
  ];

  const proxies = config.proxyIps
    .map((entry) => {
      const parsed = parseHostPort(entry, port);
      return {
        kind: "proxy",
        hostname: parsed.hostname,
        port: parsed.port,
        id: `proxy:${parsed.hostname}:${parsed.port}`,
      };
    })
    .filter((candidate) => candidate.hostname);

  const availableProxies = proxies.filter((candidate) => !isProxyCoolingDown(candidate.id));
  const proxyPool = availableProxies.length ? availableProxies : proxies;

  if (config.proxyPolicy === "proxy-only") {
    return proxyPool;
  }
  if (config.proxyPolicy === "direct-first") {
    return [...direct, ...proxyPool];
  }
  return [...proxyPool, ...direct];
}

function markProxyCooldown(id, cooldownMs) {
  if (cooldownMs > 0) {
    proxyCooldowns.set(id, Date.now() + cooldownMs);
  }
}

function isProxyCoolingDown(id) {
  const until = proxyCooldowns.get(id);
  if (!until) {
    return false;
  }
  if (Date.now() > until) {
    proxyCooldowns.delete(id);
    return false;
  }
  return true;
}

function parseUdpFrames(chunk, config) {
  const bytes = toUint8Array(chunk);
  const packets = [];
  let offset = 0;

  while (offset + 2 <= bytes.byteLength) {
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;

    if (length <= 0 || offset + length > bytes.byteLength) {
      logEvent(config, "udp_bad_len", {
        length,
        remaining: bytes.byteLength - offset,
      });
      break;
    }

    packets.push(bytes.slice(offset, offset + length));
    offset += length;
  }

  if (!packets.length && bytes.byteLength > 0) {
    packets.push(bytes);
  }

  return packets;
}

function buildDnsCacheKey(packet) {
  const bytes = toUint8Array(packet);
  if (bytes.byteLength < 12) {
    return null;
  }

  const flags = (bytes[2] << 8) | bytes[3];
  const isResponse = Boolean(flags & 0x8000);
  const questionCount = (bytes[4] << 8) | bytes[5];
  if (isResponse || questionCount < 1) {
    return null;
  }

  let offset = 12;
  const labels = [];
  while (offset < bytes.byteLength) {
    const length = bytes[offset];
    offset += 1;
    if (length === 0) {
      break;
    }
    if (length > 63 || offset + length > bytes.byteLength) {
      return null;
    }
    labels.push(new TextDecoder().decode(bytes.slice(offset, offset + length)).toLowerCase());
    offset += length;
  }

  if (offset + 4 > bytes.byteLength) {
    return null;
  }

  const qtype = (bytes[offset] << 8) | bytes[offset + 1];
  const qclass = (bytes[offset + 2] << 8) | bytes[offset + 3];
  return `${labels.join(".")}|${qtype}|${qclass}`;
}

function rewriteDnsTransactionId(queryPacket, responsePacket) {
  const query = toUint8Array(queryPacket);
  const response = toUint8Array(responsePacket).slice();
  if (query.byteLength >= 2 && response.byteLength >= 2) {
    response[0] = query[0];
    response[1] = query[1];
  }
  return response.buffer;
}

function makeDnsFailureResponse(packet) {
  const query = toUint8Array(packet);
  const response = new Uint8Array(12);
  response[0] = query[0] || 0;
  response[1] = query[1] || 0;
  response[2] = 0x81;
  response[3] = 0x82;
  return response.buffer;
}

function orderDohEndpoints(config) {
  if (preferredDohEndpoint && config.dohEndpoints.includes(preferredDohEndpoint)) {
    return [preferredDohEndpoint, ...config.dohEndpoints.filter((item) => item !== preferredDohEndpoint)];
  }
  return config.dohEndpoints.slice();
}

function isAdminRequest(request, config) {
  if (!config.adminToken) {
    return false;
  }
  const url = new URL(request.url);
  const token =
    request.headers.get("X-Admin-Token") ||
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("token") ||
    "";
  return token === config.adminToken;
}

function isPrivateDestination(host, addressType) {
  if (addressType === ATYP_DOMAIN) {
    return false;
  }
  if (addressType === ATYP_IPV4) {
    const parts = host.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false;
    }
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }
  const normalized = host.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

function tryOpenSession(ip, max) {
  const current = activeSessionsByIp.get(ip) || 0;
  if (current >= max) {
    return false;
  }
  activeSessionsByIp.set(ip, current + 1);
  return true;
}

function closeState(state, webSocket) {
  if (state.closed) {
    return;
  }
  state.closed = true;
  releaseSession(state.clientIp);
  safeCloseSocket(state.outboundSocket);
  safeCloseWebSocket(webSocket);
}

function releaseSession(ip) {
  const current = activeSessionsByIp.get(ip) || 0;
  if (current <= 1) {
    activeSessionsByIp.delete(ip);
  } else {
    activeSessionsByIp.set(ip, current - 1);
  }
}

function safeCloseWebSocket(webSocket) {
  try {
    if (webSocket && (webSocket.readyState === WS_OPEN || webSocket.readyState === WS_CLOSING)) {
      webSocket.close(1000, "closed");
    }
  } catch {}
}

function safeCloseSocket(socket) {
  try {
    socket?.close();
  } catch {}
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function normalizePath(pathname) {
  let path = pathname || "/";
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path;
}

function normalizeUuid(value) {
  const uuid = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)
    ? uuid
    : "";
}

function formatUuidBytes(bytes) {
  const parts = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${parts.slice(0, 4).join("")}-${parts.slice(4, 6).join("")}-${parts.slice(6, 8).join("")}-${parts.slice(8, 10).join("")}-${parts.slice(10, 16).join("")}`;
}

function parseHostPort(value, defaultPort) {
  const raw = String(value || "").trim();
  if (!raw) {
    return { hostname: "", port: defaultPort };
  }

  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end > 0) {
      const hostname = raw.slice(1, end);
      const port = raw[end + 1] === ":" ? clampInteger(raw.slice(end + 2), 1, 65535, defaultPort) : defaultPort;
      return { hostname, port };
    }
  }

  const lastColon = raw.lastIndexOf(":");
  if (lastColon > 0 && !raw.slice(0, lastColon).includes(":")) {
    const maybePort = Number(raw.slice(lastColon + 1));
    if (Number.isInteger(maybePort) && maybePort > 0 && maybePort <= 65535) {
      return {
        hostname: raw.slice(0, lastColon),
        port: maybePort,
      };
    }
  }

  return { hostname: raw, port: defaultPort };
}

function parseList(value, fallback = []) {
  const items = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback.slice();
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseEnum(value, allowed, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

function firstDefined(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return "";
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value || []);
}

function prefixWithLength(value) {
  const bytes = toUint8Array(value);
  const prefixed = new Uint8Array(bytes.byteLength + 2);
  prefixed[0] = (bytes.byteLength >> 8) & 0xff;
  prefixed[1] = bytes.byteLength & 0xff;
  prefixed.set(bytes, 2);
  return prefixed.buffer;
}

function mergeChunks(chunks, totalLength) {
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function concatArrayBuffers(left, right) {
  const a = toUint8Array(left);
  const b = toUint8Array(right);
  const output = new Uint8Array(a.byteLength + b.byteLength);
  output.set(a, 0);
  output.set(b, a.byteLength);
  return output.buffer;
}

function cloneArrayBuffer(value) {
  return toUint8Array(value).slice().buffer;
}

function dedupeList(items) {
  return [...new Set(items.filter(Boolean))];
}

function maskUuid(uuid) {
  return `${uuid.slice(0, 8)}...${uuid.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function logEvent(config, event, payload = {}) {
  if (!config.enableLogs) {
    return;
  }
  try {
    console.log(
      JSON.stringify({
        event,
        ...payload,
        time: new Date().toISOString(),
      }),
    );
  } catch {}
}
