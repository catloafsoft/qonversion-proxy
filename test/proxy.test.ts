import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCorsHeaders,
  buildProxyResponseInit,
  createProxyRequest,
  getAllowedMethods,
  handleProxyRequest,
  isAllowedPath,
  isAllowedMethod,
  isAllowedOrigin,
} from "../src/proxy";

const originalFetch = globalThis.fetch;
const noop = () => undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("createProxyRequest", () => {
  it("rewrites only origin while preserving method, path, query, body, and allowed headers", async () => {
    const request = new Request(
      "https://proxy.example.com/v1/users?id=42&include=products",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-custom-header": "abc123",
          authorization: "Bearer token",
          host: "proxy.example.com",
          connection: "keep-alive",
          "transfer-encoding": "chunked",
        },
        body: JSON.stringify({ hello: "world" }),
      },
    );

    const upstream = createProxyRequest(request, {
      UPSTREAM_ORIGIN: "https://api.qonversion.io",
      ALLOWED_ORIGINS: "",
    });

    expect(upstream.url).toBe(
      "https://api.qonversion.io/v1/users?id=42&include=products",
    );
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("content-type")).toBe("application/json");
    expect(upstream.headers.get("x-custom-header")).toBe("abc123");
    expect(upstream.headers.get("authorization")).toBe("Bearer token");
    expect(upstream.headers.get("accept-encoding")).toBe("identity");
    expect(upstream.headers.has("host")).toBe(false);
    expect(upstream.headers.has("connection")).toBe(false);
    expect(upstream.headers.has("transfer-encoding")).toBe(false);
    await expect(upstream.text()).resolves.toBe('{"hello":"world"}');
  });

  it("overrides inbound accept-encoding so upstream matches direct endpoint behavior", () => {
    const request = new Request("https://proxy.example.com/v3/test", {
      headers: {
        "accept-encoding": "gzip, br",
      },
    });

    const upstream = createProxyRequest(request, {
      UPSTREAM_ORIGIN: "https://api.qonversion.io",
      ALLOWED_ORIGINS: "",
    });

    expect(upstream.headers.get("accept-encoding")).toBe("identity");
  });

  it("propagates the inbound abort signal to the upstream request", () => {
    const controller = new AbortController();
    const request = new Request("https://proxy.example.com/v3/test", {
      signal: controller.signal,
    });

    const upstream = createProxyRequest(request, {
      UPSTREAM_ORIGIN: "https://api.qonversion.io",
      ALLOWED_ORIGINS: "",
    });

    controller.abort();

    expect(upstream.signal.aborted).toBe(true);
  });

  it("strips spoofable proxy headers and cookies before forwarding upstream", () => {
    const request = new Request("https://proxy.example.com/v3/test", {
      headers: {
        authorization: "Bearer token",
        cookie: "session=secret",
        forwarded: "for=1.2.3.4",
        "true-client-ip": "1.2.3.4",
        "x-forwarded-for": "1.2.3.4",
      },
    });

    const upstream = createProxyRequest(request, {
      UPSTREAM_ORIGIN: "https://api.qonversion.io",
      ALLOWED_ORIGINS: "",
      BLOCK_UNAUTHENTICATED_REQUESTS: "false",
    });

    expect(upstream.headers.get("authorization")).toBe("Bearer token");
    expect(upstream.headers.has("cookie")).toBe(false);
    expect(upstream.headers.has("forwarded")).toBe(false);
    expect(upstream.headers.has("true-client-ip")).toBe(false);
    expect(upstream.headers.has("x-forwarded-for")).toBe(false);
  });
});

describe("buildCorsHeaders", () => {
  it("returns allow headers only for configured origins", () => {
    const headers = buildCorsHeaders(
      "https://app.example.com",
      "https://app.example.com, https://admin.example.com",
      undefined,
      "content-type, authorization",
    );

    expect(headers).toEqual({
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Origin": "https://app.example.com",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    });
  });

  it("returns null when the origin is missing or not allowed", () => {
    expect(
      buildCorsHeaders(null, "https://app.example.com", undefined, null),
    ).toBeNull();
    expect(
      buildCorsHeaders(
        "https://blocked.example.com",
        "https://app.example.com",
        undefined,
        null,
      ),
    ).toBeNull();
  });

  it("supports wildcard origins without credentials for bearer-token clients", () => {
    const headers = buildCorsHeaders(
      "http://localhost:4000",
      "*",
      undefined,
      "content-type, authorization",
    );

    expect(headers).toEqual({
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": "86400",
      Vary: "Access-Control-Request-Method, Access-Control-Request-Headers",
    });
  });

  it("uses configured methods instead of the default allowlist", () => {
    const headers = buildCorsHeaders(
      "https://app.example.com",
      "https://app.example.com",
      "GET,POST,PATCH,OPTIONS",
      "content-type, authorization",
    );

    expect(headers?.["Access-Control-Allow-Methods"]).toBe(
      "GET,POST,PATCH,OPTIONS",
    );
  });
});

describe("allowed methods helpers", () => {
  it("defaults to GET, POST, OPTIONS", () => {
    expect(getAllowedMethods(undefined)).toEqual(["GET", "POST", "OPTIONS"]);
  });

  it("normalizes configured methods and enforces them case-insensitively", () => {
    expect(getAllowedMethods("get, post, patch , options")).toEqual([
      "GET",
      "POST",
      "PATCH",
      "OPTIONS",
    ]);
    expect(isAllowedMethod("patch", "GET,POST,PATCH,OPTIONS")).toBe(true);
    expect(isAllowedMethod("DELETE", "GET,POST,PATCH,OPTIONS")).toBe(false);
  });
});

describe("isAllowedPath", () => {
  it("allows all paths when no path patterns are configured", () => {
    expect(isAllowedPath("/v3/identities/123", undefined)).toBe(true);
    expect(isAllowedPath("/v3/identities/123", "")).toBe(true);
  });

  it("supports exact path matches and trailing wildcard prefixes", () => {
    expect(isAllowedPath("/api/users", "/api/users,/v3/*")).toBe(true);
    expect(isAllowedPath("/v3/identities/123", "/api/users,/v3/*")).toBe(true);
    expect(isAllowedPath("/v2/identities/123", "/api/users,/v3/*")).toBe(false);
  });

  it("supports wildcard passthrough with a literal star", () => {
    expect(isAllowedPath("/anything", "*")).toBe(true);
  });
});

describe("isAllowedOrigin", () => {
  it("allows requests with no origin header", () => {
    expect(isAllowedOrigin(null, "https://app.example.com")).toBe(true);
  });

  it("supports explicit origin allowlists and wildcard mode", () => {
    expect(
      isAllowedOrigin(
        "https://app.example.com",
        "https://app.example.com,https://admin.example.com",
      ),
    ).toBe(true);
    expect(
      isAllowedOrigin(
        "https://blocked.example.com",
        "https://app.example.com,https://admin.example.com",
      ),
    ).toBe(false);
    expect(isAllowedOrigin("https://blocked.example.com", "*")).toBe(true);
  });
});

describe("buildProxyResponseInit", () => {
  it("uses manual body encoding when rewrapping an upstream response", () => {
    const init = buildProxyResponseInit(
      new Response("{}", {
        status: 200,
        headers: {
          "content-encoding": "gzip",
          "content-type": "application/json",
        },
      }),
      {
        "Access-Control-Allow-Origin": "https://app.example.com",
        Vary: "Origin",
      },
    );
    const headers = new Headers(init.headers);

    expect(init.status).toBe(200);
    expect(headers.get("content-encoding")).toBe("gzip");
    expect(headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    );
    expect(init.encodeBody).toBe("manual");
  });

  it("does not duplicate vary headers when casing differs", () => {
    const init = buildProxyResponseInit(
      new Response("{}", {
        status: 200,
        headers: {
          vary: "origin",
        },
      }),
      {
        Vary: "Origin",
      },
    );
    const headers = new Headers(init.headers);

    expect(headers.get("vary")).toBe("origin");
  });
});

describe("worker.fetch", () => {
  it("answers preflight requests from allowed origins without contacting upstream", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v1/check", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type, authorization",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "https://app.example.com",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "content-type, authorization",
    );
    expect(response.headers.get("Vary")).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
  });

  it("rejects preflight requests from disallowed origins", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v1/check", {
        method: "OPTIONS",
        headers: {
          origin: "https://blocked.example.com",
          "access-control-request-method": "GET",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "https://app.example.com",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it("rejects non-preflight requests from disallowed origins", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(noop);
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v3/identities/123", {
        headers: {
          authorization: "Bearer token",
          origin: "https://blocked.example.com",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "https://app.example.com",
        ALLOWED_PATH_PATTERNS: "/v3/*",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(warnSpy).toHaveBeenCalledWith(
      "proxy_request_blocked",
      expect.objectContaining({
        path: "/v3/identities/123",
        reason: "origin_not_allowed",
        status: 403,
      }),
    );
  });

  it("still allows non-browser requests with no origin header", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("ok"));
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v3/identities/123", {
        headers: {
          authorization: "Bearer token",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "https://app.example.com",
        ALLOWED_PATH_PATTERNS: "/v3/*",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it("rejects requests whose path does not match the configured allowlist", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(noop);
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v3/identities/123", {
        headers: {
          authorization: "Bearer token",
          origin: "http://localhost:4000",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "*",
        ALLOWED_PATH_PATTERNS: "/api/*",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(warnSpy).toHaveBeenCalledWith(
      "proxy_request_blocked",
      expect.objectContaining({
        path: "/v3/identities/123",
        reason: "path_not_allowed",
        status: 404,
      }),
    );
  });

  it("rejects preflight requests whose path does not match the configured allowlist", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v3/identities/123", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:4000",
          "access-control-request-method": "GET",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "*",
        ALLOWED_PATH_PATTERNS: "/api/*",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects preflight requests for methods outside the allowlist", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v1/check", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-method": "TRACE",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "https://app.example.com",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(405);
  });

  it("rejects non-preflight requests for methods outside the allowlist", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(noop);
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v3/identities/123", {
        method: "PATCH",
        headers: {
          authorization: "Bearer token",
          origin: "http://localhost:4000",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "*",
        ALLOWED_PATH_PATTERNS: "/v3/*",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(405);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(warnSpy).toHaveBeenCalledWith(
      "proxy_request_blocked",
      expect.objectContaining({
        path: "/v3/identities/123",
        reason: "method_not_allowed",
        status: 405,
      }),
    );
  });

  it("allows configured non-default methods when explicitly enabled", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("ok"));
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v3/identities/123", {
        method: "PATCH",
        headers: {
          authorization: "Bearer token",
          origin: "http://localhost:4000",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "*",
        ALLOWED_PATH_PATTERNS: "/v3/*",
        ALLOWED_METHODS: "GET,POST,PATCH,OPTIONS",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET,POST,PATCH,OPTIONS",
    );
  });

  it("forwards non-preflight options requests upstream transparently", async () => {
    const fetchSpy = vi.fn<typeof fetch>(
      async (request: Request | URL | string) => {
        const actualRequest =
          request instanceof Request ? request : new Request(request);

        expect(actualRequest.method).toBe("OPTIONS");
        expect(actualRequest.url).toBe("https://api.qonversion.io/v1/check");

        return new Response(null, {
          status: 200,
          headers: {
            allow: "GET, POST, OPTIONS",
          },
        });
      },
    );
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v1/check", {
        method: "OPTIONS",
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "https://app.example.com",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("allow")).toBe("GET, POST, OPTIONS");
  });

  it("passes upstream status, headers, body, and CORS headers through for allowed origins", async () => {
    const fetchSpy = vi.fn<typeof fetch>(
      async (request: Request | URL | string) => {
        const actualRequest =
          request instanceof Request ? request : new Request(request);

        expect(actualRequest.url).toBe(
          "https://api.qonversion.io/v1/products?platform=ios",
        );
        expect(actualRequest.headers.get("host")).toBeNull();
        expect(actualRequest.headers.get("x-device-id")).toBe("device-123");
        expect(actualRequest.headers.get("authorization")).toBe("Bearer token");

        return new Response("streamed-body", {
          status: 202,
          headers: {
            "content-type": "application/json",
            "x-upstream-version": "1",
          },
        });
      },
    );
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v1/products?platform=ios", {
        method: "GET",
        headers: {
          authorization: "Bearer token",
          origin: "https://app.example.com",
          "x-device-id": "device-123",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "https://app.example.com",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("streamed-body");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-upstream-version")).toBe("1");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    );
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("returns wildcard cors headers without credentials when configured", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("ok"));
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v1/status", {
        headers: {
          authorization: "Bearer token",
          origin: "http://localhost:4000",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "*",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(
      false,
    );
    expect(response.headers.get("Vary")).toBe(
      "Access-Control-Request-Method, Access-Control-Request-Headers",
    );
  });

  it("does not emit allow-credentials for explicitly allowlisted origins", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("ok"));
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v1/status", {
        headers: {
          authorization: "Bearer token",
          origin: "https://app.example.com",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "https://app.example.com",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    );
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(
      false,
    );
  });

  it("does not add CORS headers when the request has no origin header", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("ok"));
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v1/status"),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "https://app.example.com",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(response.headers.has("Vary")).toBe(false);
  });

  it("logs request and response metadata for successful proxy calls", async () => {
    const fetchSpy = vi.fn<typeof fetch>(
      async () =>
        new Response("ok", {
          status: 201,
          headers: {
            "x-request-id": "upstream-request-id",
          },
        }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(noop);
    globalThis.fetch = fetchSpy;

    await handleProxyRequest(
      new Request("https://proxy.example.com/v1/status?platform=ios", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          origin: "https://app.example.com",
          "cf-ray": "edge-ray-id",
        },
        body: JSON.stringify({ ping: true }),
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "https://app.example.com",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      "proxy_request",
      expect.objectContaining({
        method: "POST",
        path: "/v1/status",
        hasQuery: true,
        origin: "https://app.example.com",
        rayId: "edge-ray-id",
        status: 201,
        upstreamRequestId: "upstream-request-id",
      }),
    );
  });

  it("logs request metadata when the upstream call fails", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => {
      throw new Error("network broke");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(noop);
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v1/status", {
        headers: {
          "cf-ray": "edge-ray-id",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(response.status).toBe(502);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "proxy_request_error",
      expect.objectContaining({
        method: "GET",
        path: "/v1/status",
        hasQuery: false,
        rayId: "edge-ray-id",
        status: 502,
        error: "network broke",
      }),
    );
  });

  it("can reject unauthenticated requests before proxying when the guard is enabled", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v3/test"),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "",
        BLOCK_UNAUTHENTICATED_REQUESTS: "true",
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });

  it("treats blank authorization as unauthenticated when the guard is enabled", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v3/test", {
        headers: {
          authorization: "   ",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "",
        BLOCK_UNAUTHENTICATED_REQUESTS: "true",
      },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });

  it("preserves cors headers on local unauthorized responses for allowed origins", async () => {
    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v3/test", {
        headers: {
          origin: "https://app.example.com",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "https://app.example.com",
        BLOCK_UNAUTHENTICATED_REQUESTS: "true",
      },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    );
  });

  it("preserves cors headers on local bad gateway responses for allowed origins", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => {
      throw new Error("network broke");
    });
    globalThis.fetch = fetchSpy;

    const response = await handleProxyRequest(
      new Request("https://proxy.example.com/v1/status", {
        headers: {
          authorization: "Bearer token",
          origin: "https://app.example.com",
        },
      }),
      {
        UPSTREAM_ORIGIN: "https://api.qonversion.io",
        ALLOWED_ORIGINS: "https://app.example.com",
        BLOCK_UNAUTHENTICATED_REQUESTS: "false",
      },
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    );
  });
});
