# Subscription and runtime query overrides

This is a recoverable wrapper-only upgrade. The core obfuscated tunnel Worker remains unchanged.

## Default subscription

```text
https://your-domain/{UUID}/sub
```

The default output uses 10 Cloudflare IP candidates and `fp=chrome`.

## Subscription-only overrides

These change generated node links only.

| Query | Example | Purpose |
| --- | --- | --- |
| `ips` or `ip` | `?ips=ip1,ip2,ip3` | Replace the default Cloudflare IP candidates shown in subscription links. |
| `count` | `?count=5` | Limit how many IPs are emitted. |
| `port` or `ports` | `?ports=443,8443` | Generate nodes for selected client entry ports. |
| `fp` | `?fp=chrome` | Set TLS fingerprint in generated links. |
| `host` | `?host=example.com` | Override WebSocket Host header in generated links. |
| `sni` | `?sni=example.com` | Override TLS SNI in generated links. |
| `ed` | `?ed=2048` | Override early-data value inside the generated WebSocket path. |
| `name` | `?name=SG` | Prefix generated node names. |
| `wspath` or `ws_path` | `?wspath=/UUID?ed=2048` | Fully override the generated WebSocket path. |

## Runtime WebSocket overrides

These are embedded into the generated WebSocket path and applied when the client connects.

| Query | Example | Runtime effect |
| --- | --- | --- |
| `pyip`, `proxyip`, `proxy_ips` | `?pyip=pyip.example.com` | Override `PROXY_IPS` for that node. |
| `proxyPolicy`, `proxy_policy`, `policy` | `?policy=direct-first` | Override `PROXY_POLICY` for that node. |
| `doh`, `dohs` | `?doh=https://dns.google/dns-query` | Override DoH endpoints for UDP/53 DNS. |
| `dohStrategy`, `doh_strategy` | `?dohStrategy=sequential` | Override DoH strategy. |
| `dnsTcp`, `dns_tcp` | `?dnsTcp=false` | Override DNS-over-TCP fallback. |
| `timeout`, `connectTimeout`, `connect_timeout` | `?timeout=10000` | Override TCP connect timeout. |
| `dnsTimeout`, `dns_timeout` | `?dnsTimeout=5000` | Override DNS timeout. |
| `cache`, `dnsCache`, `dns_cache_ttl` | `?cache=60` | Override DNS cache TTL seconds. |

## Examples

Use your tested best Cloudflare entry IPs:

```text
https://your-domain/{UUID}/sub?ips=104.16.1.1,104.17.2.2,172.64.3.3&count=3
```

Generate multiple entry ports:

```text
https://your-domain/{UUID}/sub?ports=443,8443,2053
```

Generate nodes that use a different runtime ProxyIP fallback:

```text
https://your-domain/{UUID}/sub?pyip=pyip.example.com&policy=direct-first
```

Generate nodes that disable ProxyIP entirely by using direct-first and no custom pyip:

```text
https://your-domain/{UUID}/sub?policy=direct-first
```

Generate nodes with custom DoH and timeout:

```text
https://your-domain/{UUID}/sub?doh=https://dns.google/dns-query&dohStrategy=sequential&timeout=10000
```

## Environment overrides

You can also set these in `wrangler-vless.toml`:

```toml
BEST_CF_IPS = "104.16.1.1,104.17.2.2,172.64.3.3"
SUB_PORTS = "443"
SUB_FP = "chrome"
SUB_COUNT = "10"
SUB_NAME = "Up-VLESS"
SUB_ED = "2048"
```

## Recovery

This wrapper is designed to be recoverable:

- The core obfuscated Worker is not changed.
- Default `/sub` still works.
- If a generated variant is bad, remove the query parameters or redeploy the previous stable Worker.

## Important limitation

The Worker cannot test ping or speed from your phone/device to Cloudflare IPs. It runs on Cloudflare's edge, not on your device. For true best-IP selection, test IPs on your device/network, then pass them using `ips=` or `BEST_CF_IPS`.
