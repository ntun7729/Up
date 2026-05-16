import worker from "./_worker_plus.js";

const DEFAULT_UUID = "86c50e3a-5b87-49dd-bd20-03c7f2735e40";
const DEFAULT_IPS = [
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
const DEFAULT_PORTS = ["443"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const uuid = normalizeUuid(
      env?.UUID || env?.uuid || env?.USER_ID || env?.userID || DEFAULT_UUID,
    );
    const path = normalizePath(url.pathname);

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (path === `/${uuid}/sub` || path === `/sub/${uuid}`)
    ) {
      return new Response(buildChromeSubscription(url, uuid, env || {}), {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow, noarchive",
        },
      });
    }

    return worker.fetch(request, env, ctx);
  },
};

function buildChromeSubscription(url, uuid, env) {
  const host = getParam(url, "host") || url.hostname;
  const sni = getParam(url, "sni") || host;
  const fingerprint = sanitizeFingerprint(getParam(url, "fp") || env.SUB_FP || "chrome");
  const alpn = sanitizeAlpn(getParam(url, "alpn") || env.SUB_ALPN || "h3,h2,http/1.1");
  const earlyData = getParam(url, "ed") || env.SUB_ED || "2048";
  const name = getParam(url, "name") || env.SUB_NAME || "Up-V2-Chrome";
  const count = clampInteger(getParam(url, "count") || env.SUB_COUNT || "10", 1, 30, 10);
  const ips = parseList(getParam(url, "ips") || getParam(url, "ip") || env.BEST_CF_IPS || env.CF_IPS, DEFAULT_IPS).slice(0, count);
  const ports = parseList(getParam(url, "ports") || getParam(url, "port") || env.SUB_PORTS, DEFAULT_PORTS).filter(isValidPort);
  const path = encodeURIComponent(buildWsPath(url, uuid, earlyData));

  const lines = [];
  for (const ip of ips) {
    for (const port of ports) {
      lines.push(
        `vless://${uuid}@${ip}:${port}?encryption=none&security=tls&sni=${sni}&fp=${fingerprint}${alpn ? `&alpn=${alpn}` : ""}&type=ws&host=${host}&path=${path}#${encodeURIComponent(
          `${name}-${ip}-${port}`,
        )}`,
      );
    }
  }

  return btoa(lines.join("\n"));
}

function buildWsPath(url, uuid, earlyData) {
  const explicitPath = getParam(url, "wspath") || getParam(url, "ws_path") || getParam(url, "path");
  if (explicitPath) {
    return explicitPath;
  }

  const params = new URLSearchParams();
  params.set("ed", earlyData);
  return `/${uuid}?${params.toString()}`;
}

function getParam(url, key) {
  return (url.searchParams.get(key) || "").trim();
}

function sanitizeFingerprint(value) {
  const normalized = String(value || "chrome").trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(normalized) ? normalized : "chrome";
}

function sanitizeAlpn(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || ["0", "false", "off", "none", "disable", "disabled"].includes(normalized)) {
    return "";
  }
  return /^[a-z0-9.,/_-]{1,64}$/.test(normalized) ? normalized : "h3,h2,http/1.1";
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
    : DEFAULT_UUID;
}

function parseList(value, fallback = []) {
  const items = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback.slice();
}

function isValidPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}
