'use client';
import { useEffect, useRef } from 'react';
import { z } from 'zod';
const renewalResponse = z.object({ ok: z.literal(true), data: z.object({ expiresAt: z.string().datetime(), version: z.number().int().positive().optional() }) });

export function useLiveAccessRenewal(input: {
  sessionId: string | null; active: boolean; audience: 'host' | 'viewer';
  onRenew?: (value: { expiresAt: string; version?: number }) => void;
  onError: (message: string) => void;
}) {
  const callbacks = useRef(input);
  callbacks.current = input;
  useEffect(() => {
    if (!input.sessionId || !input.active) return;
    const sessionId = input.sessionId;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renew = async () => {
      try {
        const response = await fetch(`/api/live-sessions/${encodeURIComponent(sessionId)}/access?audience=${input.audience}`, {
          method: 'POST', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) throw new Error('세션 접근을 연장하지 못했습니다. 로그인과 네트워크 연결을 확인해 주세요.');
        const parsed = renewalResponse.safeParse(await response.json());
        if (!parsed.success) throw new Error('세션 접근 연장 응답을 확인하지 못했습니다.');
        if (!controller.signal.aborted) callbacks.current.onRenew?.(parsed.data.data);
      } catch (error: unknown) {
        if (!controller.signal.aborted) callbacks.current.onError(error instanceof Error ? error.message : '세션 접근 연장에 실패했습니다.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void renew(); }, 5 * 60_000);
      }
    };
    void renew();
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [input.sessionId, input.active, input.audience]);
}
