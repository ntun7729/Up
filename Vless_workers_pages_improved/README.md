# Up Worker Improved

This folder is a separate "v2" variant of the worker so the original files stay untouched.

Files:

- `_worker_plus.js`: readable core worker with cleaner routing, quieter public page, better DNS cache keys, and first-byte failover for weak outbound paths.
- `_worker_chrome_plus.js`: Chrome-flavored subscription wrapper for cleaner generated links.

What changed:

- The public `/` page no longer prints the UUID by default.
- `/status` is public only as a light health summary. Set `ADMIN_TOKEN` to unlock detailed runtime status.
- DNS cache keys now use the DNS question instead of the whole packet, so cache hits work across different transaction IDs.
- TCP connect flow now waits briefly for the first upstream byte when there is initial payload, which helps skip dead or weak proxy paths.
- Added optional connection caps per client IP with `MAX_WS_PER_IP`.
- Added optional private-destination blocking with `BLOCK_PRIVATE_DESTINATIONS=true`.
- The landing page uses a simple nginx-like status style with a small flower motif.

Useful env vars:

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

Suggested starting values:

- `PROXY_POLICY=proxy-first`
- `FIRST_BYTE_TIMEOUT_MS=2500`
- `DNS_CACHE_TTL_SECONDS=300`
- `MAX_WS_PER_IP=6`
- `ADMIN_TOKEN=<set your own token>`
