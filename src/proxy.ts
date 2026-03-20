export interface WorkerResponseInit extends ResponseInit {
  encodeBody?: "automatic" | "manual";
}

type EnvKeys = Pick<
  Env,
  "UPSTREAM_ORIGIN" | "ALLOWED_ORIGINS" | "BLOCK_UNAUTHENTICATED_REQUESTS"
>;

export interface WorkerEnv extends Partial<Record<keyof EnvKeys, string>> {
  BLOCK_UNAUTHENTICATED_REQUESTS?: "true" | "false";
}

interface ProxyLogContext {
  method: string;
  path: string;
  hasQuery: boolean;
  origin: string | null;
  rayId: string | null;
  upstream: string;
}

const DEFAULT_UPSTREAM_ORIGIN = "https://api.qonversion.io";
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const SENSITIVE_FORWARD_HEADERS = new Set([
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "cf-ew-via",
  "cookie",
  "forwarded",
  "true-client-ip",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);
const ALLOWED_METHODS = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
const ALLOWED_METHOD_SET = new Set(ALLOWED_METHODS.split(","));

export function createProxyRequest(request: Request, env: WorkerEnv): Request {
  const incomingUrl = new URL(request.url);
  const upstreamBase = new URL(env.UPSTREAM_ORIGIN ?? DEFAULT_UPSTREAM_ORIGIN);
  upstreamBase.pathname = incomingUrl.pathname;
  upstreamBase.search = incomingUrl.search;

  const headers = new Headers();
  for (const [name, value] of request.headers.entries()) {
    const normalizedName = name.toLowerCase();
    if (
      !HOP_BY_HOP_REQUEST_HEADERS.has(normalizedName) &&
      !SENSITIVE_FORWARD_HEADERS.has(normalizedName)
    ) {
      headers.set(name, value);
    }
  }
  headers.set("accept-encoding", "identity");

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal: request.signal,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  return new Request(upstreamBase.toString(), init);
}

function buildLogContext(request: Request, env: WorkerEnv): ProxyLogContext {
  const url = new URL(request.url);

  return {
    method: request.method,
    path: url.pathname,
    hasQuery: url.search.length > 0,
    origin: request.headers.get("Origin"),
    rayId: request.headers.get("cf-ray"),
    upstream: env.UPSTREAM_ORIGIN ?? DEFAULT_UPSTREAM_ORIGIN,
  };
}

function shouldBlockUnauthenticatedRequest(
  request: Request,
  env: WorkerEnv,
): boolean {
  const authorizationHeader = request.headers.get("Authorization")?.trim();

  return env.BLOCK_UNAUTHENTICATED_REQUESTS === "true" && !authorizationHeader;
}

export function buildCorsHeaders(
  origin: string | null,
  allowedOrigins: string | undefined,
  requestedHeaders: string | null,
): Record<string, string> | null {
  if (!origin) {
    return null;
  }

  const normalizedAllowedOrigins = (allowedOrigins ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!normalizedAllowedOrigins.includes(origin)) {
    return null;
  }

  return {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers":
      requestedHeaders ?? "authorization, content-type",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function isPreflightRequest(request: Request): boolean {
  return (
    request.method === "OPTIONS" &&
    request.headers.has("Origin") &&
    request.headers.has("Access-Control-Request-Method")
  );
}

function buildPreflightResponse(
  request: Request,
  corsHeaders: Record<string, string> | null,
): Response {
  if (!corsHeaders) {
    return new Response("Forbidden", { status: 403 });
  }

  const requestedMethod = request.headers
    .get("Access-Control-Request-Method")
    ?.trim()
    .toUpperCase();

  if (!requestedMethod || !ALLOWED_METHOD_SET.has(requestedMethod)) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const headers = new Headers(corsHeaders);
  headers.set(
    "Vary",
    appendVary(
      appendVary(headers.get("Vary"), "Access-Control-Request-Method"),
      "Access-Control-Request-Headers",
    ),
  );

  return new Response(null, {
    status: 204,
    headers,
  });
}

function appendVary(existingValue: string | null, nextValue: string): string {
  if (!existingValue) {
    return nextValue;
  }

  const values = existingValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const normalizedValues = new Set(values.map((value) => value.toLowerCase()));

  if (!normalizedValues.has(nextValue.toLowerCase())) {
    values.push(nextValue);
  }

  return values.join(", ");
}

export function buildProxyResponseInit(
  response: Response,
  corsHeaders: Record<string, string> | null,
): WorkerResponseInit {
  const headers = new Headers(response.headers);
  if (corsHeaders) {
    for (const [name, value] of Object.entries(corsHeaders)) {
      if (name.toLowerCase() === "vary") {
        headers.set("Vary", appendVary(headers.get("Vary"), value));
      } else {
        headers.set(name, value);
      }
    }
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    encodeBody: "manual",
  };
}

function applyCorsHeaders(
  response: Response,
  corsHeaders: Record<string, string> | null,
): Response {
  if (!corsHeaders) {
    return response;
  }

  return new Response(
    response.body,
    buildProxyResponseInit(response, corsHeaders),
  );
}

export async function handleProxyRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const logContext = buildLogContext(request, env);
  const corsHeaders = buildCorsHeaders(
    origin,
    env.ALLOWED_ORIGINS,
    request.headers.get("Access-Control-Request-Headers"),
  );

  if (isPreflightRequest(request)) {
    return buildPreflightResponse(request, corsHeaders);
  }

  if (shouldBlockUnauthenticatedRequest(request, env)) {
    const response = applyCorsHeaders(
      new Response("Unauthorized", { status: 401 }),
      corsHeaders,
    );
    console.warn("proxy_request_blocked", {
      ...logContext,
      status: response.status,
      reason: "missing_authorization",
    });
    return response;
  }

  const startedAt = Date.now();

  try {
    const upstreamResponse = await fetch(createProxyRequest(request, env));
    const response = applyCorsHeaders(upstreamResponse, corsHeaders);

    console.log("proxy_request", {
      ...logContext,
      durationMs: Date.now() - startedAt,
      status: response.status,
      upstreamRequestId: response.headers.get("x-request-id"),
    });

    return response;
  } catch (error) {
    const response = applyCorsHeaders(
      new Response("Bad Gateway", { status: 502 }),
      corsHeaders,
    );

    console.error("proxy_request_error", {
      ...logContext,
      durationMs: Date.now() - startedAt,
      status: response.status,
      error: error instanceof Error ? error.message : String(error),
    });

    return response;
  }
}
