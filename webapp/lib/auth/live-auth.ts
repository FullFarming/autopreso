import type { NextRequest } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "../session";
import { LIVE_GATEWAY_TOKEN_SECRET, LIVE_VIEWER_TOKEN_SECRET } from "../security/config";
import { hmacHex, timingSafeEqual } from "../security/hmac";

export const VIEWER_GRANT_COOKIE = "rnw_viewer_grant";
const VIEWER_GRANT_TTL_MS = 6 * 60 * 60 * 1000;
const GATEWAY_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface ViewerGrantClaims {
  role: "VIEWER";
  grantId: string;
  sessionId: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface GatewayClaims {
  role: "HOST";
  sub: string;
  sessionId: string;
  aud: "media-gateway";
  iat: number;
  exp: number;
}

export class AuthenticationError extends Error {}
export class AuthorizationError extends Error {}

function encodePayload(payload: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodePayload(encoded: string): unknown {
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function signClaims(secret: string, claims: object): Promise<string> {
  const encoded = encodePayload(claims);
  const signature = await hmacHex(secret, encoded);
  return `${encoded}.${signature}`;
}

async function verifySignedClaims(secret: string, token: string): Promise<unknown> {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) throw new AuthenticationError("인증 토큰이 올바르지 않습니다.");
  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = await hmacHex(secret, encoded);
  if (!timingSafeEqual(signature, expected)) {
    throw new AuthenticationError("인증 토큰이 변조되었습니다.");
  }
  try {
    return decodePayload(encoded);
  } catch {
    throw new AuthenticationError("인증 토큰을 해석할 수 없습니다.");
  }
}

function isViewerGrantClaims(value: unknown): value is ViewerGrantClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Record<string, unknown>;
  return claims.role === "VIEWER"
    && typeof claims.grantId === "string"
    && typeof claims.sessionId === "string"
    && typeof claims.userId === "string"
    && typeof claims.issuedAt === "number"
    && typeof claims.expiresAt === "number";
}

function isGatewayClaims(value: unknown): value is GatewayClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Record<string, unknown>;
  return claims.role === "HOST"
    && claims.aud === "media-gateway"
    && typeof claims.sessionId === "string"
    && typeof claims.sub === "string"
    && typeof claims.iat === "number"
    && typeof claims.exp === "number";
}

export function getBearerToken(request: Pick<NextRequest, "headers">): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  return match?.[1] ?? null;
}

export async function createViewerGrantToken(
  input: Pick<ViewerGrantClaims, "grantId" | "sessionId" | "userId">,
  now: number = Date.now(),
): Promise<{ token: string; claims: ViewerGrantClaims }> {
  const claims: ViewerGrantClaims = {
    role: "VIEWER",
    ...input,
    issuedAt: now,
    expiresAt: now + VIEWER_GRANT_TTL_MS,
  };
  return { token: await signClaims(LIVE_VIEWER_TOKEN_SECRET, claims), claims };
}

export async function verifyViewerGrantToken(
  token: string | null | undefined,
  now: number = Date.now(),
): Promise<ViewerGrantClaims> {
  if (!token) throw new AuthenticationError("시청자 인증이 필요합니다.");
  const value = await verifySignedClaims(LIVE_VIEWER_TOKEN_SECRET, token);
  if (!isViewerGrantClaims(value)) throw new AuthenticationError("시청자 인증 정보가 올바르지 않습니다.");
  if (value.issuedAt > now + 30_000 || value.expiresAt <= now || value.expiresAt - value.issuedAt > VIEWER_GRANT_TTL_MS) {
    throw new AuthenticationError("시청자 인증이 만료되었습니다.");
  }
  return value;
}

export async function createGatewayToken(
  sessionId: string,
  hostId: string,
  now: number = Date.now(),
): Promise<{ token: string; claims: GatewayClaims }> {
  const claims: GatewayClaims = {
    role: "HOST",
    sub: hostId,
    sessionId,
    aud: "media-gateway",
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + GATEWAY_TOKEN_TTL_MS) / 1000),
  };
  return { token: await signClaims(LIVE_GATEWAY_TOKEN_SECRET, claims), claims };
}

export async function verifyGatewayToken(
  token: string | null | undefined,
  now: number = Date.now(),
): Promise<GatewayClaims> {
  if (!token) throw new AuthenticationError("게이트웨이 인증이 필요합니다.");
  const value = await verifySignedClaims(LIVE_GATEWAY_TOKEN_SECRET, token);
  if (!isGatewayClaims(value)) throw new AuthenticationError("게이트웨이 인증 정보가 올바르지 않습니다.");
  const nowSeconds = Math.floor(now / 1000);
  if (value.iat > nowSeconds + 30 || value.exp <= nowSeconds || value.exp - value.iat > GATEWAY_TOKEN_TTL_MS / 1000) {
    throw new AuthenticationError("게이트웨이 인증이 만료되었습니다.");
  }
  return value;
}

export async function requireHost(request: Pick<NextRequest, "cookies">): Promise<{ hostId: string }> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token))) throw new AuthenticationError("호스트 로그인이 필요합니다.");
  if (!token) throw new AuthenticationError("호스트 로그인이 필요합니다.");
  const separator = token.lastIndexOf(".");
  try {
    const payload = atob(token.slice(0, separator));
    const [hostId] = payload.split("|");
    if (!hostId) throw new Error("missing host id");
    return { hostId };
  } catch {
    throw new AuthenticationError("호스트 인증 정보가 올바르지 않습니다.");
  }
}
