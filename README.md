# Up

A Cloudflare Workers VLESS-over-WebSocket project focused on simple deployment, stable defaults, and recoverable configuration.

This fork currently prioritizes the VLESS Worker deployment at:

```text
Vless_workers_pages/_worker_chrome_obf.js
```

The wrapper keeps the core Worker obfuscated, generates `fp=chrome` subscription links, and supports subscription/runtime query overrides without changing the core tunnel code.

## Current stable behavior

- VLESS over WebSocket + TLS.
- Wrangler deployment supported through `wrangler-vless.toml`.
- Subscription endpoint at `/{UUID}/sub`.
- Generated links use `fp=chrome` by default.
- `PROXY_POLICY = "direct-first"` by default.
- ProxyIP is treated as fallback, not as a universal relay.
- UDP support is focused on DNS over UDP/53 through DoH-style handling in the Worker.
- Runtime overrides can be embedded in the generated WebSocket path.
- The current deploy entrypoint is a wrapper, so most subscription changes are recoverable.

## Important notes

### ProxyIP behavior

ProxyIP is **not** the same as the VLESS server IP.

The client connects to a Cloudflare entry IP/domain. The Worker then connects outward to target sites. ProxyIP is only a helper/fallback for that outbound side.

Recommended default:

```toml
PROXY_POLICY = "direct-first"
```

Meaning:

1. Try the real target directly first.
2. Use ProxyIP only if direct connect fails.

This was more stable in testing than `proxy-first`. `proxy-first` can be unstable because ProxyIP is not a universal relay for every CDN/site.

### Fingerprint behavior

Use:

```text
fp=chrome
```

Avoid:

```text
fp=randomized
```

`fp=randomized` was unstable or unusable in testing with the client. The subscription wrapper now emits `fp=chrome` by default.

### UDP behavior

Cloudflare Workers JavaScript does not expose arbitrary raw UDP sockets. This project focuses on the useful VLESS UDP case: DNS on UDP/53.

For stability, the default Wrangler config keeps DNS-over-TCP fallback off:

```toml
DNS_TCP_FALLBACK = "false"
```

## Files you usually care about

| File | Purpose |
| --- | --- |
| `wrangler-vless.toml` | Main Wrangler deployment config. |
| `Vless_workers_pages/_worker_chrome_obf.js` | Deploy entrypoint. Generates `fp=chrome` subscriptions and applies overrides. |
| `Vless_workers_pages/_worker混淆.js` | Core obfuscated Worker. |
| `tools/cf-ip-checker.sh` | Termux/proot-friendly Cloudflare entry IP checker. |

## Quick deploy

Install/login Wrangler first:

```bash
npx wrangler login
```

Deploy:

```bash
npx wrangler deploy -c wrangler-vless.toml
```

Wrangler will print your Worker URL, for example:

```text
https://up-vless-worker.example.workers.dev
```

## Deploy as a separate test Worker

To avoid replacing your working Worker, copy the config and change only the Worker name.

```bash
cp wrangler-vless.toml wrangler-vless-test.toml
nano wrangler-vless-test.toml
```

Change:

```toml
name = "up-vless-worker"
```

To something else:

```toml
name = "up-vless-test"
```

Deploy the test Worker:

```bash
npx wrangler deploy -c wrangler-vless-test.toml
```

Your production Worker remains untouched.

## Recommended `wrangler-vless.toml`

```toml
name = "up-vless-worker"
main = "Vless_workers_pages/_worker_chrome_obf.js"
compatibility_date = "2026-01-20"

[vars]
UUID = "86c50e3a-5b87-49dd-bd20-03c7f2735e40"

# ProxyIP is fallback-only. It works best as help for Cloudflare-hosted targets,
# not as a universal relay for every CDN/site.
PROXY_IPS = "pyip.ygkkk.dpdns.org"

# Stable default.
PROXY_POLICY = "direct-first"
PROXY_FAIL_COOLDOWN_MS = "120000"

DOH_ENDPOINTS = "https://cloudflare-dns.com/dns-query,https://dns.google/dns-query,https://dns.quad9.net/dns-query"
DOH_STRATEGY = "sequential"
DNS_CACHE_TTL_SECONDS = "60"
DNS_TCP_FALLBACK = "false"
DNS_TCP_SERVERS = "1.1.1.1:53,8.8.8.8:53,9.9.9.9:53"

CONNECT_TIMEOUT_MS = "10000"
DNS_TIMEOUT_MS = "5000"
ENABLE_LOGS = "false"
```

## Health and status checks

After deploy:

```bash
curl -s https://your-worker.example.workers.dev/health
```

```bash
curl -s https://your-worker.example.workers.dev/status
```

Expected status should include values like:

```json
{
  "proxyPolicy": "direct-first",
  "uuidConfigured": true
}
```

## Subscription URL

Default subscription:

```text
https://your-domain.example/86c50e3a-5b87-49dd-bd20-03c7f2735e40/sub
```

Example using a custom domain:

```text
https://example.com/86c50e3a-5b87-49dd-bd20-03c7f2735e40/sub
```

To inspect decoded links:

```bash
curl -s "https://your-domain.example/86c50e3a-5b87-49dd-bd20-03c7f2735e40/sub" | base64 -d
```

Check fingerprint:

```bash
curl -s "https://your-domain.example/86c50e3a-5b87-49dd-bd20-03c7f2735e40/sub" \
  | base64 -d \
  | grep -o "fp=[^&]*" \
  | head
```

Expected:

```text
fp=chrome
```

## Subscription query overrides

These change generated subscription links.

| Query | Example | Purpose |
| --- | --- | --- |
| `ips` or `ip` | `?ips=104.16.1.1,104.17.2.2` | Replace generated Cloudflare entry IPs. |
| `count` | `?count=3` | Limit number of generated IPs. |
| `port` or `ports` | `?ports=443,8443,2053` | Generate selected entry ports. |
| `fp` | `?fp=chrome` | Change generated TLS fingerprint. |
| `host` | `?host=example.com` | Override WebSocket Host in generated links. |
| `sni` | `?sni=example.com` | Override TLS SNI in generated links. |
| `ed` | `?ed=2048` | Override early-data value in generated path. |
| `name` | `?name=SG` | Prefix node names. |
| `wspath` or `ws_path` | `?wspath=/UUID?ed=2048` | Fully override generated WebSocket path. |

Example:

```text
https://your-domain.example/{UUID}/sub?ips=104.16.1.1,104.17.2.2&count=2
```

Multiple ports:

```text
https://your-domain.example/{UUID}/sub?ports=443,8443,2053&name=Test
```

## Runtime WebSocket path overrides

These values are embedded into the generated WebSocket path and applied when the client connects.

| Query | Example | Runtime effect |
| --- | --- | --- |
| `pyip`, `proxyip`, `proxy_ips` | `?pyip=pyip.example.com` | Override `PROXY_IPS` for that generated node. |
| `proxyPolicy`, `proxy_policy`, `policy` | `?policy=direct-first` | Override `PROXY_POLICY`. |
| `doh`, `dohs` | `?doh=https://dns.google/dns-query` | Override DoH endpoint list. |
| `dohStrategy`, `doh_strategy` | `?dohStrategy=sequential` | Override DoH strategy. |
| `dnsTcp`, `dns_tcp` | `?dnsTcp=false` | Override DNS TCP fallback. |
| `timeout`, `connectTimeout`, `connect_timeout` | `?timeout=10000` | Override TCP connect timeout. |
| `dnsTimeout`, `dns_timeout` | `?dnsTimeout=5000` | Override DNS timeout. |
| `cache`, `dnsCache`, `dns_cache_ttl` | `?cache=60` | Override DNS cache TTL. |

Example using a custom runtime ProxyIP fallback:

```text
https://your-domain.example/{UUID}/sub?pyip=pyip.example.com&policy=direct-first
```

Expected decoded link path contains:

```text
/UUID?ed=2048&pyip=pyip.example.com&policy=direct-first
```

Verify encoded path:

```bash
curl -s "https://your-domain.example/{UUID}/sub?pyip=pyip.example.com&policy=direct-first" \
  | base64 -d \
  | grep -o "path=[^#]*" \
  | head
```

## Cloudflare IP candidates

The Worker cannot test ping or speed from your phone/network. It runs on Cloudflare's edge, so it cannot know which entry IP is fastest for you.

Use your own tested IPs with:

```text
/sub?ips=104.16.1.1,104.17.2.2,172.64.3.3&count=3
```

Or set them in `wrangler-vless.toml`:

```toml
BEST_CF_IPS = "104.16.1.1,104.17.2.2,172.64.3.3"
SUB_COUNT = "3"
```

## Termux/proot Cloudflare IP checker

The repo includes a lightweight checker:

```text
tools/cf-ip-checker.sh
```

It uses `curl --connect-to` to test HTTPS reachability to your Worker/custom domain through candidate Cloudflare IPs. This preserves the correct domain, SNI, and Host behavior while forcing the TCP connection to a chosen IP.

Install basic tools in Termux/proot if needed:

```bash
pkg install curl coreutils grep sed gawk
```

Run a basic test:

```bash
bash tools/cf-ip-checker.sh -d worker.example.com
```

Run against multiple HTTPS ports:

```bash
bash tools/cf-ip-checker.sh -d worker.example.com --ports 443,8443,2053 -n 10
```

Print a ready subscription URL with the best IPs:

```bash
bash tools/cf-ip-checker.sh \
  -d worker.example.com \
  --uuid 86c50e3a-5b87-49dd-bd20-03c7f2735e40 \
  -n 10
```

Use your own candidate file:

```bash
cat > my-ips.txt <<'EOF'
104.16.1.1
104.17.2.2
172.64.3.3
EOF

bash tools/cf-ip-checker.sh -d worker.example.com -f my-ips.txt -n 3
```

The script outputs:

- a sorted table of working IPs
- `cf-ip-results.csv`
- a comma-separated best IP list
- optionally a ready `/sub?ips=...` URL

## Custom domain example

If your Worker is routed through:

```text
https://worker.example.com
```

Then your subscription URL is:

```text
https://worker.example.com/86c50e3a-5b87-49dd-bd20-03c7f2735e40/sub
```

Runtime ProxyIP override example:

```text
https://worker.example.com/86c50e3a-5b87-49dd-bd20-03c7f2735e40/sub?pyip=pyip.example.com&policy=direct-first
```

## Updating your deployed Worker

```bash
cd ~/Up
git checkout main
git pull
npx wrangler deploy -c wrangler-vless.toml
```

## Recovering from a bad test

If a query-generated node is bad, remove the query parameters and use the normal subscription:

```text
https://your-domain.example/{UUID}/sub
```

If a test Worker is bad, deploy your stable config again:

```bash
git checkout main
npx wrangler deploy -c wrangler-vless.toml
```

If you deployed under another Worker name, your original Worker remains safe.

## Troubleshooting

### `fp=randomized` does not work

Use `fp=chrome`. The wrapper emits `fp=chrome` by default.

### Connection drops every few seconds

Use the stable default:

```toml
PROXY_POLICY = "direct-first"
```

Avoid forcing `proxy-first` unless you know your ProxyIP is stable for your target sites.

### `pyip` does not appear in generated links

Make sure your local repo has the latest `main`:

```bash
git checkout main
git pull
npx wrangler deploy -c wrangler-vless.toml
```

Then test:

```bash
curl -s "https://your-domain.example/{UUID}/sub?pyip=pyip.example.com&policy=direct-first" | base64 -d | grep -o "path=[^#]*" | head
```

### `/health` works but client cannot connect

Check:

- UUID matches your client.
- Subscription uses `fp=chrome`.
- Host/SNI match your Worker domain or custom domain.
- `PROXY_POLICY` is `direct-first`.
- Your client imported the latest subscription.

## Project scope

This fork is meant to be simple and recoverable. It avoids a large admin panel for now. Most new behavior should happen in the wrapper or config first, so a bad experiment does not break the core obfuscated Worker.

## Disclaimer

Use this project only where permitted by your local laws, Cloudflare's terms, and your network policies. This repository is provided for educational and personal infrastructure experimentation.
