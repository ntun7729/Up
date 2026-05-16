# Up Worker Quickstart

This branch adds a safer Wrangler-friendly Worker for the `s5http_wkpgs` Cloudflare Socks5/HTTP helper.

## What changed

- Added `wrangler.toml` so the Worker can be deployed with Wrangler.
- Moved runtime configuration to Cloudflare environment variables/secrets.
- Added `/health` and `/status` endpoints.
- Added stricter `host:port` validation.
- Added connection timeout handling.
- Preserved the existing WebSocket protocol used by the local helper script.

## Deploy with Wrangler

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

After deployment, open:

```text
https://your-worker-name.your-subdomain.workers.dev/health
```

You should see JSON with `ok: true`.

## Recommended secret

Set a token so only your local helper can open the WebSocket tunnel:

```bash
wrangler secret put TOKEN
```

Use the same token value in your local helper configuration.

## Optional variables

Edit `wrangler.toml` or set variables in the Cloudflare dashboard.

| Variable | Example | Purpose |
| --- | --- | --- |
| `PYIP_LIST` | `pyip.ygkkk.dpdns.org` | Comma-separated fallback proxy IP/domain list. |
| `ACCESS_PATH` | `/my-secret-path` | Optional path lock for WebSocket access. |
| `CONNECT_TIMEOUT_MS` | `5000` | Timeout for each direct/fallback connection attempt. |
| `DISABLE_DIRECT` | `false` | If `true`, only use fallback proxy hosts. |
| `ENABLE_LOGS` | `false` | Enable minimal structured logs for debugging. |

## Compatibility note

The local helper protocol is unchanged:

```text
CONNECT:host:port|firstFrame|PYIP=optional-fallback-host
DATA:payload
PING
CLOSE
```

That means existing helper behavior should continue to work, but configuration is now safer and easier to deploy.
