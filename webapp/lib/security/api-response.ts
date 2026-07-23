import { NextResponse } from "next/server";

export function apiSuccess<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function apiError(
  error: string,
  code: string,
  status: number,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json({ ok: false, error, code }, { status, headers });
}
