import { createHmac, timingSafeEqual } from "node:crypto";

const PAIR_SECRET = (() => {
  const value = process.env.PAIR_SECRET?.trim();
  if (process.env.NODE_ENV === "production" && (!value || value.length < 32)) {
    throw new Error("PAIR_SECRET must be configured with at least 32 characters");
  }
  return value ?? "local-pair-secret-change-before-production";
})();

export function verifyPairSig(token: string, exp: string, sig: string): boolean {
  if (!token || !exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = createHmac("sha256", PAIR_SECRET).update(`${token}:${exp}`).digest("hex").slice(0, 16);
  const expectedBytes = Buffer.from(expected, "utf8");
  const signatureBytes = Buffer.from(sig, "utf8");
  return expectedBytes.length === signatureBytes.length && timingSafeEqual(expectedBytes, signatureBytes);
}
