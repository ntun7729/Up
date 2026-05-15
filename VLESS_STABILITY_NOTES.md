# VLESS Worker stability upgrade

This branch replaces `Vless_workers_pages/_worker混淆.js` with a clean, readable Worker implementation.

## What changed

- Replaced the obfuscated Worker with readable JavaScript.
- Preserved VLESS over WebSocket behavior.
- Added `/health` and `/status` endpoints.
- Added direct TCP connection with ProxyIP fallback.
- Added connection timeout handling.
- Added UDP/53 DNS relay through DNS-over-HTTPS.
- Added simple Base64 subscription route at `/{UUID}/sub`.
- Added `wrangler-vless.toml` for direct Wrangler deployment.

## Deploy

```bash
wrangler deploy -c wrangler-vless.toml
```

Then open:

```text
https://your-worker.workers.dev/health
```

Expected result:

```json
{
  "ok": true,
  "service": "up-vless-worker"
}
```

## Configuration

Set these in `wrangler-vless.toml` or in Cloudflare dashboard variables.

| Variable | Purpose |
| --- | --- |
| `UUID` | Your VLESS UUID. |
| `PROXY_IPS` | Comma-separated ProxyIP fallback hosts. |
| `DOH_ENDPOINTS` | Comma-separated DNS-over-HTTPS endpoints for UDP/53. |
| `CONNECT_TIMEOUT_MS` | TCP connect timeout. |
| `DNS_TIMEOUT_MS` | DNS-over-HTTPS timeout. |
| `DISABLE_DIRECT` | Set to `true` to always use ProxyIP fallback. |
| `ENABLE_LOGS` | Set to `true` only while debugging. |

## UDP support scope

Cloudflare Workers do not provide raw UDP sockets. This Worker supports the common VLESS UDP DNS case by translating UDP/53 DNS packets to DNS-over-HTTPS. Non-DNS UDP is intentionally rejected.

## Subscription

After deployment, open:

```text
https://your-worker.workers.dev/{UUID}/sub
```

The response is a Base64 VLESS subscription.
