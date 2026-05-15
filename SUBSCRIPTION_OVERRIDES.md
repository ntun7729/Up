# Subscription query overrides

This is a recoverable subscription-only upgrade. It changes generated subscription links, not the core tunnel logic.

## Default subscription

```text
https://your-domain/{UUID}/sub
```

The default output uses 10 Cloudflare IP candidates and `fp=chrome`.

## Query overrides

You can override subscription output without editing code.

| Query | Example | Purpose |
| --- | --- | --- |
| `ips` or `ip` | `?ips=ip1,ip2,ip3` | Replace the default Cloudflare IP candidates. |
| `count` | `?count=5` | Limit how many IPs are emitted. |
| `port` or `ports` | `?ports=443,8443` | Generate nodes for selected ports. |
| `fp` | `?fp=chrome` | Set TLS fingerprint in generated links. |
| `host` | `?host=example.com` | Override WebSocket host header. |
| `sni` | `?sni=example.com` | Override TLS SNI. |
| `ed` | `?ed=2048` | Override early-data value inside path. |
| `path` | `?path=/UUID?ed=2048` | Override WebSocket path. |
| `name` | `?name=SG` | Prefix generated node names. |

## Examples

Use your tested best IPs:

```text
https://your-domain/{UUID}/sub?ips=104.16.1.1,104.17.2.2,172.64.3.3&count=3
```

Generate multiple ports:

```text
https://your-domain/{UUID}/sub?ports=443,8443,2053
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

## Important limitation

The Worker cannot test ping or speed from your phone/device to Cloudflare IPs. It runs on Cloudflare's edge, not on your device. For true best-IP selection, test IPs on your device/network, then pass them using `ips=` or `BEST_CF_IPS`.
