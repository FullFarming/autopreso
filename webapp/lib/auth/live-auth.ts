import type { NextRequest } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "../session";
import { assertHostApproved } from "./profile-status-cache";
import { LIVE_GATEWAY_TOKEN_SECRET, LIVE_VIEWER_TOKEN_SECRET } from "../security/config";
import { hmacHex, timingSafeEqual } from "../security/hmac";

export const VIEWER_GRANT_COOKIE = "rnw_viewer_grant";
export const RECAP_GRANT_COOKIE = "rnw_recap_grant";
const VIEWER_GRANT_TTL_MS = 6 * 60 * 60 * 1000;
// 2026-08-31 fix: 이 TTL은 신원 복구 봉투다. 기록 권한은 DB의 종료 시각+6시간으로 별도 검증한다.
export const RECAP_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GATEWAY_TOKEN_TTL_MS = 15 * 60 * 1000;
const VIEWER_GATEWAY_TICKET_TTL_SECONDS = 60;
const DATABASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RANDOM_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VIEWER_GATEWAY_TICKET_KEYS = ["aud", "exp", "grantId", "iat", "jti", "role", "sessionId", "sub"];

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

/** Short-lived credential for the gateway's internal engine endpoint (auth
 *  console spec §9). Session-bound and never accepted on a WebSocket lane. */
export interface AdminGatewayClaims {
  role: "ADMIN";
  sub: string;
  sessionId: string;
  aud: "media-gateway";
  iat: number;
  exp: number;
}

export interface ViewerGatewayTicketClaims {
  role: "VIEWER";
  sub: string;
  grantId: string;
  sessionId: string;
  aud: "live-gateway-viewer";
  jti: string;
  iat: number;
  exp: number;
}

export interface RecapGrantClaims {
  role: "RECAP";
  sessionId: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
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
    && Number.isSafeInteger(claims.issuedAt)
    && Number.isSafeInteger(claims.expiresAt);
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

function isViewerGatewayTicketClaims(value: unknown): value is ViewerGatewayTicketClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Record<string, unknown>;
  const keys = Object.keys(claims).sort();
  return keys.length === VIEWER_GATEWAY_TICKET_KEYS.length
    && keys.every((key, index) => key === VIEWER_GATEWAY_TICKET_KEYS[index])
    && claims.role === "VIEWER"
    && claims.aud === "live-gateway-viewer"
    && typeof claims.sub === "string"
    && DATABASE_UUID_PATTERN.test(claims.sub)
    && typeof claims.grantId === "string"
    && DATABASE_UUID_PATTERN.test(claims.grantId)
    && typeof claims.sessionId === "string"
    && DATABASE_UUID_PATTERN.test(claims.sessionId)
    && typeof claims.jti === "string"
    && RANDOM_UUID_V4_PATTERN.test(claims.jti)
    && Number.isSafeInteger(claims.iat)
    && Number.isSafeInteger(claims.exp);
}

function isRecapGrantClaims(value: unknown): value is RecapGrantClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Record<string, unknown>;
  return claims.role === "RECAP"
    && typeof claims.sessionId === "string"
    && typeof claims.userId === "string"
    && Number.isSafeInteger(claims.issuedAt)
    && Number.isSafeInteger(claims.expiresAt);
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
  expiresAt: number = now + VIEWER_GRANT_TTL_MS,
): Promise<{ token: string; claims: ViewerGrantClaims }> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + VIEWER_GRANT_TTL_MS) {
    throw new AuthenticationError("시청자 인증 만료 시각이 올바르지 않습니다.");
  }
  const claims: ViewerGrantClaims = {
    role: "VIEWER",
    ...input,
    issuedAt: now,
    expiresAt,
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
  if (value.issuedAt > now + 30_000 || value.expiresAt <= now || value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > VIEWER_GRANT_TTL_MS) {
    throw new AuthenticationError("시청자 인증이 만료되었습니다.");
  }
  return value;
}

export async function createViewerGatewayTicket(
  input: Pick<ViewerGrantClaims, "grantId" | "sessionId" | "userId">,
  now: number = Date.now(),
): Promise<{ token: string; claims: ViewerGatewayTicketClaims }> {
  if (!DATABASE_UUID_PATTERN.test(input.grantId)
    || !DATABASE_UUID_PATTERN.test(input.sessionId)
    || !DATABASE_UUID_PATTERN.test(input.userId)) {
    throw new AuthenticationError("시청자 게이트웨이 인증 정보가 올바르지 않습니다.");
  }
  const issuedAt = Math.floor(now / 1_000);
  const claims: ViewerGatewayTicketClaims = {
    role: "VIEWER",
    sub: input.userId,
    grantId: input.grantId,
    sessionId: input.sessionId,
    aud: "live-gateway-viewer",
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + VIEWER_GATEWAY_TICKET_TTL_SECONDS,
  };
  return { token: await signClaims(LIVE_VIEWER_TOKEN_SECRET, claims), claims };
}

export async function verifyViewerGatewayTicket(
  token: string | null | undefined,
  now: number = Date.now(),
): Promise<ViewerGatewayTicketClaims> {
  if (!token) throw new AuthenticationError("시청자 게이트웨이 인증이 필요합니다.");
  const value = await verifySignedClaims(LIVE_VIEWER_TOKEN_SECRET, token);
  if (!isViewerGatewayTicketClaims(value)) {
    throw new AuthenticationError("시청자 게이트웨이 인증 정보가 올바르지 않습니다.");
  }
  const nowSeconds = Math.floor(now / 1_000);
  if (value.iat > nowSeconds + 30
    || value.exp <= nowSeconds
    || value.exp <= value.iat
    || value.exp - value.iat > VIEWER_GATEWAY_TICKET_TTL_SECONDS) {
    throw new AuthenticationError("시청자 게이트웨이 인증이 만료되었습니다.");
  }
  return value;
}

export async function createRecapGrantToken(
  input: Pick<RecapGrantClaims, "sessionId" | "userId">,
  now: number = Date.now(),
): Promise<{ token: string; claims: RecapGrantClaims }> {
  const claims: RecapGrantClaims = {
    role: "RECAP",
    ...input,
    issuedAt: now,
    expiresAt: now + RECAP_GRANT_TTL_MS,
  };
  return { token: await signClaims(LIVE_VIEWER_TOKEN_SECRET, claims), claims };
}

export async function verifyRecapGrantToken(
  token: string | null | undefined,
  now: number = Date.now(),
): Promise<RecapGrantClaims> {
  if (!token) throw new AuthenticationError("회의록 인증이 필요합니다.");
  const value = await verifySignedClaims(LIVE_VIEWER_TOKEN_SECRET, token);
  if (!isRecapGrantClaims(value)) throw new AuthenticationError("회의록 인증 정보가 올바르지 않습니다.");
  if (value.issuedAt > now + 30_000
    || value.expiresAt <= now
    || value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > RECAP_GRANT_TTL_MS) {
    throw new AuthenticationError("회의록 인증이 만료되었습니다.");
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

export const ADMIN_GATEWAY_TOKEN_TTL_MS = 60_000;

/** Mints the ADMIN token `pushEngineToGateway` sends. Signed with the same
 *  gateway secret as HOST tokens; the gateway verifies role, audience, the
 *  60 s lifetime, and that `sessionId` matches the path. */
export async function createAdminGatewayToken({ hostId, sessionId, now = Date.now() }: {
  hostId: string;
  sessionId: string;
  now?: number;
}): Promise<{ token: string; claims: AdminGatewayClaims }> {
  if (!hostId || !sessionId) throw new AuthorizationError("관리자 게이트웨이 토큰 입력이 올바르지 않습니다.");
  const iat = Math.floor(now / 1000);
  const claims: AdminGatewayClaims = {
    role: "ADMIN",
    sub: hostId,
    sessionId,
    aud: "media-gateway",
    iat,
    exp: iat + ADMIN_GATEWAY_TOKEN_TTL_MS / 1000,
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
    await assertHostApproved(hostId);
    return { hostId };
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("호스트 인증 정보가 올바르지 않습니다.");
  }
}
