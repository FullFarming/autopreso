import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { verifyLiveToken } from "./token-verifier.js";

const MINIMUM_METRICS_TOKEN_LENGTH = 32;

export function readGatewaySecurityPolicy(environment = process.env) {
  const isProduction = environment.NODE_ENV === "production";
  const rawOrigins = [
    environment.LIVE_GATEWAY_ALLOWED_ORIGINS ?? environment.ALLOWED_ORIGINS ?? "",
    environment.CHROME_EXTENSION_ORIGIN ?? "",
  ]
    .join(",")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (isProduction && rawOrigins.length === 0) {
    throw new Error("LIVE_GATEWAY_ALLOWED_ORIGINS 환경변수가 필요합니다.");
  }
  const allowedOrigins = new Set(rawOrigins.map(canonicalOrigin));
  const allowTrustedNonBrowser = parseBoolean(
    environment.LIVE_GATEWAY_ALLOW_TRUSTED_NON_BROWSER,
    "LIVE_GATEWAY_ALLOW_TRUSTED_NON_BROWSER",
  );
  const metricsToken = environment.LIVE_GATEWAY_METRICS_TOKEN?.trim() ?? "";
  if (isProduction && metricsToken.length < MINIMUM_METRICS_TOKEN_LENGTH) {
    throw new Error("LIVE_GATEWAY_METRICS_TOKEN은 32자 이상이어야 합니다.");
  }
  return Object.freeze({
    allowedOrigins,
    allowTrustedNonBrowser,
    // Local Node clients do not send Origin. This exception cannot be reached
    // through Cloud Run because the peer address is not loopback.
    allowLoopbackWithoutOrigin: !isProduction,
    metricsToken,
  });
}

export function isAllowedWebSocketUpgrade(request, policy, { gatewaySecret, viewerSecret, now = Date.now }) {
  const rawOrigin = singleHeader(request.headers.origin);
  if (rawOrigin) {
    try {
      return policy.allowedOrigins.has(canonicalOrigin(rawOrigin));
    } catch {
      return false;
    }
  }
  if (policy.allowLoopbackWithoutOrigin && isLoopback(request.socket?.remoteAddress)) return true;
  if (!policy.allowTrustedNonBrowser || singleHeader(request.headers["x-realtime-noel-client"]) !== "desktop-main") {
    return false;
  }
  const authorization = singleHeader(request.headers.authorization);
  const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? "");
  if (!match) return false;
  try {
    return verifyLiveToken(match[1], { gatewaySecret, viewerSecret, now }).role === "HOST";
  } catch {
    return false;
  }
}

export function isMetricsRequestAuthorized(request, metricsToken) {
  if (!metricsToken) return false;
  const authorization = singleHeader(request.headers.authorization);
  const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? "");
  if (!match) return false;
  const actual = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(metricsToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function getOpaqueClientKey(request, secret, environment = process.env) {
  const forwarded = singleHeader(request.headers["x-forwarded-for"]);
  const address = isCloudRunRuntime(environment)
    ? googleProxyClientAddress(forwarded) ?? normalizeAddress(request.socket?.remoteAddress)
    : normalizeAddress(request.socket?.remoteAddress);
  return createHmac("sha256", secret).update("gateway-client\0").update(address).digest("hex");
}

function googleProxyClientAddress(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  const addresses = value.split(",").map((entry) => entry.trim());
  if (addresses.length < 2) return null;
  // Google External Application Load Balancers append two values to any
  // caller-supplied prefix: <client-ip>,<load-balancer-ip>. Values before that
  // suffix are explicitly untrusted and must never select a limiter bucket.
  const clientAddress = normalizeAddress(addresses.at(-2));
  const loadBalancerAddress = normalizeAddress(addresses.at(-1));
  return clientAddress !== "unknown" && loadBalancerAddress !== "unknown" ? clientAddress : null;
}

function isCloudRunRuntime(environment) {
  return environment.LIVE_GATEWAY_TRUST_GOOGLE_XFF_SUFFIX === "true"
    && ["K_SERVICE", "K_REVISION", "K_CONFIGURATION"].every(
      (name) => typeof environment[name] === "string" && environment[name].trim(),
    );
}

function canonicalOrigin(value) {
  const parsed = new URL(value);
  const hasRootPath = parsed.pathname === "/" || (parsed.protocol === "chrome-extension:" && parsed.pathname === "");
  if (!["https:", "http:", "chrome-extension:"].includes(parsed.protocol)
    || !hasRootPath
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) throw new Error("INVALID_GATEWAY_ORIGIN");
  if (parsed.protocol === "chrome-extension:") {
    if (!/^[a-p]{32}$/u.test(parsed.host)) throw new Error("INVALID_GATEWAY_ORIGIN");
    return `chrome-extension://${parsed.host}`;
  }
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("INVALID_GATEWAY_ORIGIN");
  }
  return parsed.origin;
}

function parseBoolean(value, name) {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized === "false") return false;
  if (normalized === "true") return true;
  throw new Error(`${name}은 true 또는 false여야 합니다.`);
}

function singleHeader(value) {
  return Array.isArray(value) ? null : value;
}

function normalizeAddress(value) {
  if (typeof value !== "string") return "unknown";
  const unwrapped = value.startsWith("::ffff:") ? value.slice(7) : value;
  return isIP(unwrapped) ? unwrapped : "unknown";
}

function isLoopback(value) {
  const normalized = normalizeAddress(value);
  return normalized === "127.0.0.1" || normalized === "::1";
}
