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
- `ALLOWED_PATH_PATTERNS`: optional comma-separated path allowlist for requests the proxy is allowed to forward. Defaults to `/v3/*`. Supports exact paths like `/v3/health`, prefix patterns ending in `*` like `/v3/*`, and a literal `*` to allow any path.
- `BLOCK_UNAUTHENTICATED_REQUESTS`: when `true`, reject non-`OPTIONS` requests that do not include `Authorization`.

`ALLOWED_ORIGINS` format details:

- Use exact origins, not URLs with paths.
- Include the protocol, for example `https://app.example.com`.
- Include the port when needed, for example `http://localhost:4000`.
- Do not include a trailing slash.
- Separate multiple origins with commas.
- `*` is supported to allow any origin.
- Pattern wildcards such as `*.example.com` or `https://*.example.com` are not supported.
- Requests with no `Origin` header are still allowed, so non-browser clients are not blocked.
- Requests with an `Origin` header that is not allowed are rejected with `403`, including non-preflight requests.

Examples:

```txt
ALLOWED_ORIGINS=https://app.example.com,http://localhost:4000
```

```txt
ALLOWED_ORIGINS=*
```

`ALLOWED_PATH_PATTERNS` format details:

- Use request paths only, not full URLs.
- Exact paths are supported, for example `/v3/health`.
- Prefix patterns are supported when they end in `*`, for example `/api/*`.
- A literal `*` allows any path.
- Mid-pattern wildcards such as `/v*/users` are not supported.
- Separate multiple patterns with commas.

Examples:

```txt
ALLOWED_PATH_PATTERNS=/api/*
```

```txt
ALLOWED_PATH_PATTERNS=/v3/health,/v3/identities/*
```

Default:

```txt
ALLOWED_PATH_PATTERNS=/v3/*
```

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
curl -i "https://your-alias.example.com/v3/products"
```

Preflight request:

```bash
curl -i -X OPTIONS "https://your-alias.example.com/v3/products" \
  -H "Origin: https://app.example.com" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: content-type, authorization"
```

## Next Phase

If you need large numbers of alternate domains or customer-owned vanity domains, keep the proxy code unchanged and move the deployment model toward wildcard routing or Cloudflare for SaaS.
