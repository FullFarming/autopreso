type SecurityEnvironment = Readonly<Record<string, string | undefined>>;

interface SecurityHeaderInput {
  nonce: string;
  pathname: string;
  environment?: SecurityEnvironment;
}

const WATCH_PATHS = new Set(["/watch", "/m/watch", "/m/watch/demo"]);
const NONCE_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/u;

function parseSupabaseSources(value: string | undefined, isProduction: boolean): string[] {
  const configured = value?.trim();
  if (!configured) return [];
  const parsed = new URL(configured);
  const isRootPath = parsed.pathname === "/" || parsed.pathname === "";
  const isProductionOrigin = parsed.protocol === "https:"
    && /^[a-z0-9-]+\.supabase\.co$/u.test(parsed.hostname)
    && !parsed.port;
  const isLocalDevelopmentOrigin = !isProduction
    && parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    && parsed.port === "54321";
  if (!isRootPath || parsed.username || parsed.password || parsed.search || parsed.hash
    || (!isProductionOrigin && !isLocalDevelopmentOrigin)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be an exact allowed project origin");
  }

  const websocket = new URL(parsed.origin);
  websocket.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return [parsed.origin, websocket.origin];
}

function parseGatewaySource(value: string | undefined, isProduction: boolean): string[] {
  const configured = value?.trim();
  if (!configured) return [];
  const parsed = new URL(configured);
  const isSecure = parsed.protocol === "wss:";
  const isLocalDevelopment = !isProduction
    && parsed.protocol === "ws:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if ((!isSecure && !isLocalDevelopment) || parsed.pathname !== "/live"
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("NEXT_PUBLIC_LIVE_GATEWAY_URL must be an exact /live WebSocket endpoint");
  }
  return [parsed.origin];
}

function frameAncestors(pathname: string, environment: SecurityEnvironment): string {
  const extensionOrigin = environment.CHROME_EXTENSION_ORIGIN?.trim() ?? "";
  if (WATCH_PATHS.has(pathname) && /^chrome-extension:\/\/[a-p]{32}$/u.test(extensionOrigin)) {
    return `'self' ${extensionOrigin}`;
  }
  return "'self'";
}

export function buildContentSecurityPolicy({
  nonce,
  pathname,
  environment = process.env,
}: SecurityHeaderInput): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error("CSP nonce is invalid");
  const isProduction = environment.NODE_ENV === "production";
  const connectSources = new Set([
    "'self'",
    ...parseSupabaseSources(environment.NEXT_PUBLIC_SUPABASE_URL, isProduction),
    ...parseGatewaySource(environment.NEXT_PUBLIC_LIVE_GATEWAY_URL, isProduction),
  ]);
  const scriptSources = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  const styleSources = ["'self'", `'nonce-${nonce}'`];
  if (!isProduction) {
    scriptSources.push("'unsafe-eval'");
    styleSources.push("'unsafe-inline'");
  }

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `style-src ${styleSources.join(" ")}`,
    // 2026-08-22 security: React still emits six bounded style attributes for
    // speaker palette and caption zoom. This exception cannot execute script;
    // style elements remain nonce-bound and script-src stays strict.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src ${[...connectSources].join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    `frame-ancestors ${frameAncestors(pathname, environment)}`,
    "manifest-src 'self'",
  ];
  if (isProduction) directives.push("upgrade-insecure-requests");
  return `${directives.join("; ")};`;
}

export function createPermissionsPolicy(pathname: string): string {
  const microphone = WATCH_PATHS.has(pathname) || pathname === "/admin" ? "(self)" : "()";
  return `camera=(), geolocation=(), microphone=${microphone}, payment=(), usb=(), browsing-topics=()`;
}

export function securityHeadersForRequest({
  nonce,
  pathname,
  environment = process.env,
}: SecurityHeaderInput): Headers {
  const headers = new Headers({
    "content-security-policy": buildContentSecurityPolicy({ nonce, pathname, environment }),
    "permissions-policy": createPermissionsPolicy(pathname),
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-permitted-cross-domain-policies": "none",
  });
  if (environment.NODE_ENV === "production") {
    headers.set("strict-transport-security", "max-age=31536000");
  }
  return headers;
}
