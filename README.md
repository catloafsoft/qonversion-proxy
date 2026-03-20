# Qonversion Transparent Proxy Worker

Cloudflare Worker that proxies requests to `https://api.qonversion.io` as transparently as possible while allowing controlled CORS behavior for browser clients.

## Behavior

- Preserves request method, path, query string, and body stream.
- Forwards request headers with `Host`, hop-by-hop transport headers, client IP forwarding headers, and cookies stripped.
- Streams upstream responses back with original status and headers.
- Only changes response behavior for configured CORS handling.
- Forces `Accept-Encoding: identity` upstream so responses match the direct Qonversion API behavior.

## Configuration

Wrangler variables in `wrangler.jsonc`:

- `UPSTREAM_ORIGIN`: upstream Qonversion endpoint. Defaults to `https://api.qonversion.io`.
- `ALLOWED_ORIGINS`: comma-separated browser origin allowlist for CORS responses. Set to `*` to allow any origin. The Worker never sends `Access-Control-Allow-Credentials` because this proxy is intended for bearer-token clients, not cookie-based auth.
- `BLOCK_UNAUTHENTICATED_REQUESTS`: when `true`, reject non-`OPTIONS` requests that do not include `Authorization`.

## Logging

The Worker emits structured logs for:

- `proxy_request`: successful upstream requests
- `proxy_request_error`: upstream failures
- `proxy_request_blocked`: requests rejected by the unauthenticated-request guard

To reduce log leakage, logs include the request path and whether a query string existed, but do not log the raw query string.

## Add Alias Hostnames

Edit `routes` in `wrangler.jsonc` and add one custom domain per hostname you control:

```jsonc
"routes": [
  { "pattern": "qonversion-proxy.example.com", "custom_domain": true },
  { "pattern": "qproxy.example.net", "custom_domain": true }
]
```

Cloudflare will create the DNS record and certificate for each custom domain when you deploy.

## Local Development

```bash
pnpm install
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run dev
```

## Deploy

```bash
pnpm run deploy
```

## Manual Checks

Normal proxy request:

```bash
curl -i "https://your-alias.example.com/v1/products"
```

Preflight request:

```bash
curl -i -X OPTIONS "https://your-alias.example.com/v1/products" \
  -H "Origin: https://app.example.com" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: content-type, authorization"
```

## Next Phase

If you need large numbers of alternate domains or customer-owned vanity domains, keep the proxy code unchanged and move the deployment model toward wildcard routing or Cloudflare for SaaS.
