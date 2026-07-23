import { createHmac, timingSafeEqual } from "node:crypto";

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
  const secret = claims.role === "HOST" ? gatewaySecret : claims.role === "VIEWER" ? viewerSecret : "";
  if (!secret) throw new Error("UNAUTHORIZED");
  const expected = createHmac("sha256", secret).update(encoded).digest("hex");
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) throw new Error("UNAUTHORIZED");
  if (claims.role === "HOST") {
    const nowSeconds = Math.floor(now() / 1_000);
    if (claims.aud !== "media-gateway" || claims.exp <= nowSeconds || claims.iat > nowSeconds + 30 || claims.exp - claims.iat > 900) throw new Error("UNAUTHORIZED");
  } else if (claims.expiresAt <= now() || claims.issuedAt > now() + 30_000 || claims.expiresAt - claims.issuedAt > 21_600_000) {
    throw new Error("UNAUTHORIZED");
  }
  return claims;
}
