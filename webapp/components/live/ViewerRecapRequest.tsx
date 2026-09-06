"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { viewerMessages } from "@/lib/system-language/viewer-messages";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { readRecapRequest, saveRecapRequest, type ViewerRecapRequest } from "./recap-request-client";

export interface ViewerRecapClient {
  read: typeof readRecapRequest;
  save: typeof saveRecapRequest;
}
const requestClient: ViewerRecapClient = { read: readRecapRequest, save: saveRecapRequest };

export function ViewerRecapRequest({ sessionId, email, isExpired, client = requestClient }: { sessionId: string; email: string; isExpired: boolean; client?: ViewerRecapClient }) {
  const t = useSystemText(viewerMessages);
  const noticeId = useId();
  const [request, setRequest] = useState<ViewerRecapRequest | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRef<string | null>(null);
  const isSavingRef = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setIsLoading(true); setError("");
    try { const saved = await client.read(sessionId); if (current === generation.current) setRequest(saved); }
    catch { if (current === generation.current) setError("수신 신청 내역을 확인하지 못했어요. 다시 확인해 주세요."); }
    finally { if (current === generation.current) setIsLoading(false); }
  }, [sessionId, client]);
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);
  async function submit() {
    if (isSavingRef.current || isExpired || request?.status === "requested") return;
    isSavingRef.current = true; setIsSaving(true); setError("");
    requestKey.current ??= crypto.randomUUID();
    const current = generation.current;
    try { const saved = await client.save(sessionId, requestKey.current); if (current === generation.current) setRequest(saved); }
    catch { if (current === generation.current) setError("수신 신청을 저장하지 못했어요. 다시 시도해 주세요."); }
    finally { isSavingRef.current = false; if (current === generation.current) setIsSaving(false); }
  }
  return <section className="viewer-recap-request" aria-label={t("회의 이메일 수신 신청")} aria-busy={isSaving || isLoading}>
    <div id={noticeId}>
      <p>{t("받을 이메일")} <strong>{email}</strong></p>
      <p>{t("버튼을 누르면 이 회의의 요약·원문 이메일 수신에 동의해요.")}</p>
      <p className="viewer-muted">{t("마케팅 수신 동의는 포함되지 않아요.")}</p>
    </div>
    {error && <p role="alert">{t(error)}</p>}
    {error && !isSaving && <button type="button" className="viewer-text-button" onClick={() => void load()}>{t("신청 내역 다시 확인")}</button>}
    <button type="button" className="viewer-recap-cta" aria-describedby={noticeId}
      disabled={isExpired || isLoading || isSaving || !email || request?.status === "requested"}
      onClick={() => void submit()}>
      {isSaving ? t("신청 저장 중…") : request?.status === "requested" ? t("이메일 수신 신청 완료") : t("요약·원문 받기")}
    </button>
    <p role="status" aria-live="polite">{request?.status === "requested" ? t("이메일 수신 신청이 완료됐어요. 현재는 신청만 저장하며 이메일은 발송하지 않아요.") : ""}</p>
  </section>;
}
