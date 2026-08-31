import { createHmac, timingSafeEqual } from "node:crypto";

const VIEWER_AUDIENCE = "live-gateway-viewer";
const VIEWER_TICKET_MAX_SECONDS = 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const JTI_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const VIEWER_CLAIM_KEYS = ["aud", "exp", "grantId", "iat", "jti", "role", "sessionId", "sub"];

export function verifyLiveToken(token, { gatewaySecret, viewerSecret, now = Date.now }) {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) throw new Error("UNAUTHORIZED");
  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  let claims;
  try {
    claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("UNAUTHORIZED");
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error("UNAUTHORIZED");
  const secret = claims.role === "HOST" ? gatewaySecret : claims.role === "VIEWER" ? viewerSecret : "";
  if (!secret) throw new Error("UNAUTHORIZED");
  const expected = createHmac("sha256", secret).update(encoded).digest("hex");
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw new Error("UNAUTHORIZED");
  if (claims.role === "HOST") {
    const nowSeconds = Math.floor(now() / 1_000);
    if (claims.aud !== "media-gateway" || claims.exp <= nowSeconds || claims.iat > nowSeconds + 30 || claims.exp - claims.iat > 900) throw new Error("UNAUTHORIZED");
    return claims;
  }
  const nowSeconds = Math.floor(now() / 1_000);
  const keys = Object.keys(claims).sort();
  if (keys.length !== VIEWER_CLAIM_KEYS.length
    || keys.some((key, index) => key !== VIEWER_CLAIM_KEYS[index])
    || claims.aud !== VIEWER_AUDIENCE
    || !UUID_PATTERN.test(claims.sub)
    || !UUID_PATTERN.test(claims.grantId)
    || !UUID_PATTERN.test(claims.sessionId)
    || !JTI_PATTERN.test(claims.jti)
    || !Number.isSafeInteger(claims.iat)
    || !Number.isSafeInteger(claims.exp)
    || claims.exp <= nowSeconds
    || claims.iat > nowSeconds + 30
    || claims.exp <= claims.iat
    || claims.exp - claims.iat > VIEWER_TICKET_MAX_SECONDS) throw new Error("UNAUTHORIZED");
  return { ...claims, userId: claims.sub };
}
