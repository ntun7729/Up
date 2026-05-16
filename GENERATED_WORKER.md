# Generated obfuscated Worker

This repo can build separate generated deploy files without touching the current working Worker files.

## Source files kept stable

These remain the source of truth:

```text
Vless_workers_pages/_worker混淆.js
Vless_workers_pages/_worker_chrome_obf.js
wrangler-vless.toml
```

## Generated files

The GitHub Action creates:

```text
Vless_workers_pages/_worker_core_generated.js
Vless_workers_pages/_worker_chrome_obf_generated.js
wrangler-vless-generated.toml
```

The generated Wrangler config points to:

```toml
main = "Vless_workers_pages/_worker_chrome_obf_generated.js"
```

## How to build from GitHub

1. Open the repository on GitHub.
2. Go to **Actions**.
3. Choose **Build generated Worker**.
4. Click **Run workflow**.
5. Wait for it to finish.
6. Pull the generated files locally:

```bash
git checkout main
git pull
```

## Deploy generated Worker

Deploy under a separate Worker name first.

```bash
cp wrangler-vless-generated.toml wrangler-vless-generated-test.toml
nano wrangler-vless-generated-test.toml
```

Change:

```toml
name = "up-vless-worker"
```

To:

```toml
name = "up-vless-generated-test"
```

Deploy:

```bash
npx wrangler deploy -c wrangler-vless-generated-test.toml
```

## Validate

```bash
curl -s https://YOUR-GENERATED-WORKER.workers.dev/health
curl -s https://YOUR-GENERATED-WORKER.workers.dev/status
curl -s "https://YOUR-GENERATED-WORKER.workers.dev/86c50e3a-5b87-49dd-bd20-03c7f2735e40/sub" | base64 -d | head
```

## Recovery

If generated deploy has problems, use the normal stable config again:

```bash
npx wrangler deploy -c wrangler-vless.toml
```

The generated build does not replace the current working source files.
