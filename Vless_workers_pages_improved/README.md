# Up Worker Improved

This folder is a separate "v2" variant of the worker so the original files stay untouched.

The main idea is simple:

- keep the original obfuscated worker exactly as it is
- add a cleaner, easier-to-tune improved worker in a new folder
- make it easy to deploy the improved version as a separate test Worker

## Files

- `_worker_plus.js`: readable core worker with cleaner routing, quieter public page, smarter DNS cache behavior, and first-byte failover checks.
- `_worker_chrome_plus.js`: wrapper that generates `fp=chrome` subscription links and keeps the improved worker deploy path clean.
- `../wrangler-vless-plus.toml`: separate Wrangler config for deploying this improved version without replacing the current Worker.

## Main behavior changes

- The public `/` page no longer prints the full UUID.
- The landing page uses a simple nginx-style status look with a flower-style background touch.
- `/status` is public only as a light health summary. Set `ADMIN_TOKEN` if you want detailed runtime status.
- DNS cache keys are based on the DNS question instead of the full packet, so cache hits work even when transaction IDs change.
- TCP handling waits briefly for the first upstream byte when there is initial payload. This helps skip weak or half-dead routes earlier.
- The improved defaults now prefer `direct-first` instead of `proxy-first`.
- The base subscription output now uses `fp=chrome` and `alpn=h3,h2,http/1.1` for more predictable client behavior.
- Optional per-IP websocket caps are available through `MAX_WS_PER_IP`.
- Optional private-address blocking is available through `BLOCK_PRIVATE_DESTINATIONS=true`.

## Why direct-first is the default

This improved worker is tuned for stability, not for forcing every connection through ProxyIP.

Recommended default:

```toml
PROXY_POLICY = "direct-first"
```

Meaning:

1. Try the real destination first.
2. Use ProxyIP only if direct connect fails.

This is safer when the website you are entering is not on Cloudflare. Using `proxy-first` can break or become unstable because ProxyIP is not a universal relay for every site or CDN.

## Recommended defaults

These are the defaults I recommend starting with:

```toml
PROXY_POLICY = "direct-first"
DOH_STRATEGY = "sequential"
DNS_CACHE_TTL_SECONDS = "300"
DNS_TCP_FALLBACK = "false"
FIRST_BYTE_TIMEOUT_MS = "2500"
MAX_WS_PER_IP = "6"
SUB_FP = "chrome"
SUB_ALPN = "h3,h2,http/1.1"
```

## Useful env vars

- `UUID`
- `PROXY_IPS`
- `PROXY_POLICY`
- `PROXY_FAIL_COOLDOWN_MS`
- `CONNECT_TIMEOUT_MS`
- `DNS_TIMEOUT_MS`
- `FIRST_BYTE_TIMEOUT_MS`
- `DOH_ENDPOINTS`
- `DOH_STRATEGY`
- `DNS_TCP_FALLBACK`
- `DNS_TCP_SERVERS`
- `DNS_CACHE_TTL_SECONDS`
- `DNS_CACHE_MAX_ENTRIES`
- `ADMIN_TOKEN`
- `MAX_WS_PER_IP`
- `BLOCK_PRIVATE_DESTINATIONS`
- `ENABLE_LOGS`
- `SUB_FP`
- `SUB_ALPN`
- `SUB_ED`

## Separate test deploy

This repo now includes a separate config file:

```text
wrangler-vless-plus.toml
```

That file points at:

```text
Vless_workers_pages_improved/_worker_chrome_plus.js
```

So you can deploy the improved version as a separate Worker without touching your current Worker.

Deploy it like this:

```bash
npx wrangler deploy -c wrangler-vless-plus.toml
```

If you want, edit the Worker name first:

```toml
name = "up-vless-worker-plus"
```

You can rename that to anything else that is still available.

## After deploy

Check health:

```bash
curl -s https://your-plus-worker.example.workers.dev/health
```

Check public status:

```bash
curl -s https://your-plus-worker.example.workers.dev/status
```

If you set `ADMIN_TOKEN`, check detailed status:

```bash
curl -s "https://your-plus-worker.example.workers.dev/status?token=YOUR_TOKEN"
```

## Subscription paths

Default hidden subscription:

```text
https://your-domain.example/{UUID}/sub
```

The wrapper file generates `fp=chrome` by default and includes ALPN by default.

To inspect generated links:

```bash
curl -s "https://your-domain.example/{UUID}/sub" | base64 -d
```

## Notes on tuning

This improved version is currently tuned more toward speed and stability than toward aggressive stealth.

That means:

- `direct-first` by default
- `sequential` DoH by default
- `fp=chrome` for generated subscriptions
- DNS TCP fallback off by default
- earlier failure detection when upstream opens but does not really respond

If you want another variant later, I can still make:

- a more stealth-focused version
- a more aggressive speed-focused version
- a stricter locked-down version with tighter runtime controls
