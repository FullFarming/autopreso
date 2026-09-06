"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LiveHostParticipantActivity } from "@/lib/live-contract";
import { buildSpeakerPhotoUrl } from "../../../packages/caption-core/speaker-profile.js";
import { buildSpeakerRosterUpdate, requestSpeakerRoster, speakerRosterStatus, speakerRosterFailureState, SpeakerRosterRequestError, type SpeakerRoster, type SpeakerRosterEntry } from "./speaker-roster-client";
import styles from "./SpeakerRosterEditor.module.css";
import { ActionWithHelp } from "../ui/ActionWithHelp";

export function SpeakerRosterEditor({ sessionId, participants, disabled = false }: {
  sessionId: string; participants: readonly LiveHostParticipantActivity[]; disabled?: boolean;
}) {
  const [roster, setRoster] = useState<SpeakerRoster | null>(null);
  const [draft, setDraft] = useState<SpeakerRosterEntry | null>(null);
  const [isDirty, setDirty] = useState(false);
  const [isBusy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const requestGeneration = useRef(0);
  const lifetime = useRef<AbortController | null>(null);

  function reportFailure(reason: unknown) {
    const current = { roster, draft, isDirty };
    const next = speakerRosterFailureState(reason, current);
    if (next !== current) { setRoster(null); setDraft(null); setDirty(false); }
    setError(reason instanceof Error ? reason.message : "발언자 정보를 불러오지 못했습니다.");
  }
  async function load(signal?: AbortSignal) {
    if (pending.current) return;
    const generation = ++requestGeneration.current;
    setError("");
    try {
      const next = await requestSpeakerRoster(sessionId, undefined, signal);
      if (!signal?.aborted && generation === requestGeneration.current) { setRoster(next); setDirty(false); }
    } catch (reason) { if (!signal?.aborted && generation === requestGeneration.current) reportFailure(reason); }
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void load(controller.signal);
    return () => { controller.abort(); };
    // The host mounts a fresh editor for each logical session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  useEffect(() => {
    if (!roster || roster.revision === roster.appliedRevision || isDirty || isBusy || draft) return;
    const controller = new AbortController();
    const timer = setTimeout(() => void load(controller.signal), 3000);
    return () => { clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster, isDirty, isBusy, draft]);
  useEffect(() => {
    if (!draft || !dialog.current) return;
    const previousFocus = document.activeElement;
    dialog.current.showModal();
    return () => { if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, [Boolean(draft)]);

  function edit(entry?: SpeakerRosterEntry) {
    if (pending.current) return;
    requestGeneration.current += 1;
    setError(""); setDraft(entry ? { ...entry } : { id: crypto.randomUUID(), version: 1,
      displayName: "", company: "", department: "", photoAssetId: null, participantId: null });
  }
  async function save() {
    if (!roster || pending.current) return;
    const generation = ++requestGeneration.current;
    pending.current = true; setBusy(true); setError("");
    try {
      const next = await requestSpeakerRoster(sessionId, buildSpeakerRosterUpdate(roster), lifetime.current?.signal);
      if (lifetime.current?.signal.aborted || generation !== requestGeneration.current) return;
      setRoster(next); setDirty(false);
    } catch (reason) { if (!lifetime.current?.signal.aborted && generation === requestGeneration.current) reportFailure(reason); }
    finally { pending.current = false; setBusy(false); }
  }
  async function upload(file?: File) {
    if (!file || !draft || pending.current) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024 || file.size === 0) { setError("2MB 이하의 JPEG, PNG, WebP 사진을 선택해 주세요."); return; }
    pending.current = true; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/live-sessions/${sessionId}/speakers/photos`, { method: "POST", headers: { "content-type": file.type }, body: file, signal: lifetime.current ? AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
      if ([401, 403, 404].includes(response.status)) throw new SpeakerRosterRequestError("발언자 사진에 접근할 권한이 없습니다.", response.status);
      const result: unknown = await response.json();
      if (!response.ok || !result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("data" in result)) throw new Error("사진을 업로드하지 못했습니다.");
      const data = result.data;
      if (!data || typeof data !== "object" || !("photoAssetId" in data) || typeof data.photoAssetId !== "string") throw new Error("사진 응답이 올바르지 않습니다.");
      const photoAssetId = data.photoAssetId;
      buildSpeakerPhotoUrl(sessionId, photoAssetId);
      if (!lifetime.current?.signal.aborted) setDraft((current) => current ? { ...current, photoAssetId } : current);
    } catch (reason) { if (!lifetime.current?.signal.aborted) reportFailure(reason); }
    finally { pending.current = false; setBusy(false); }
  }
  const locked = disabled || isBusy;
  return <section className={styles.panel} aria-labelledby={`speakers-${sessionId}`}>
    <header><h2 id={`speakers-${sessionId}`}>발언자 관리</h2><button type="button" disabled={locked || !roster || roster.speakers.length >= 30} onClick={() => edit()}>발언자 추가</button></header>
    <p role="status">{error && !roster ? "발언자 정보를 확인할 수 없습니다." : speakerRosterStatus(roster, isDirty)}</p>
    {error && <p role="alert">{error}</p>}
    <ul>{roster?.speakers.map((speaker) => <li key={speaker.id}>
      <div className={styles.identity}>{speaker.photoAssetId && <img src={buildSpeakerPhotoUrl(sessionId, speaker.photoAssetId)} alt="" width={44} height={44} />}<div><strong>{speaker.displayName}</strong><p>{[speaker.company, speaker.department].filter(Boolean).join(" · ")}</p></div></div>
      <div className={styles.actions}><button type="button" disabled={locked} aria-label={`${speaker.displayName} 수정`} onClick={() => edit(speaker)}>수정</button>
        <button type="button" disabled={locked} aria-pressed={roster.activeOnsiteSpeakerId === speaker.id} onClick={() => { requestGeneration.current += 1; setRoster({ ...roster, activeOnsiteSpeakerId: roster.activeOnsiteSpeakerId === speaker.id ? null : speaker.id }); setDirty(true); }}>현장 발언자</button></div>
    </li>)}</ul>
    {roster?.speakers.length === 0 && <p>방송 전에 발언자를 등록할 수 있습니다.</p>}
    {isDirty && <p>새로고침하면 저장하지 않은 변경이 사라집니다.</p>}
    <footer><ActionWithHelp label="새로고침 도움말" help="서버에 저장된 발언자 목록을 다시 불러옵니다. 저장하지 않은 변경은 사라집니다."><button type="button" disabled={locked} aria-label={isDirty ? "변경 버리고 새로 불러오기" : "새로 불러오기"} onClick={() => { setBusy(true); void load(lifetime.current?.signal).finally(() => setBusy(false)); }}>새로고침</button></ActionWithHelp><button type="button" className={styles.primary} disabled={locked || !isDirty} onClick={() => void save()}>변경 저장</button></footer>
    {draft && typeof document !== "undefined" && createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby="speaker-editor-title" onCancel={(event) => { event.preventDefault(); if (!isBusy) setDraft(null); }}>
      <form onSubmit={(event) => { event.preventDefault(); if (!roster || locked) return; try {
        const next = { ...roster, speakers: roster.speakers.some((speaker) => speaker.id === draft.id) ? roster.speakers.map((speaker) => speaker.id === draft.id ? draft : speaker) : [...roster.speakers, draft] };
        buildSpeakerRosterUpdate(next); setRoster(next); setDirty(true); setDraft(null);
      } catch (reason) { setError(reason instanceof Error ? reason.message : "입력을 확인해 주세요."); } }}>
        <header><h2 id="speaker-editor-title">발언자 프로필</h2><button type="button" disabled={isBusy} onClick={() => setDraft(null)}>닫기</button></header>
        <div className={styles.body}>
          <label>이름<input autoFocus required maxLength={40} value={draft.displayName} disabled={locked} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
          <label>회사 (선택)<input maxLength={80} value={draft.company} disabled={locked} onChange={(event) => setDraft({ ...draft, company: event.target.value })} /></label>
          <label>부서 (선택)<input maxLength={80} value={draft.department} disabled={locked} onChange={(event) => setDraft({ ...draft, department: event.target.value })} /></label>
          <label>사진 (선택)<input type="file" accept="image/jpeg,image/png,image/webp" disabled={locked} onChange={(event) => void upload(event.target.files?.[0])} /></label>
          {draft.photoAssetId && <div className={styles.identity}><img src={buildSpeakerPhotoUrl(sessionId, draft.photoAssetId)} alt="선택한 발언자 사진" width={44} height={44} /><button type="button" disabled={locked} onClick={() => setDraft({ ...draft, photoAssetId: null })}>사진 제거</button></div>}
          <label>온라인 참여자 연결<select value={draft.participantId ?? ""} disabled={locked} onChange={(event) => setDraft({ ...draft, participantId: event.target.value || null })}><option value="">연결하지 않음</option>{participants.map((participant) => <option key={participant.participantId} value={participant.participantId}>{participant.displayName} · {participant.company || "회사 미입력"}</option>)}{draft.participantId && !participants.some((participant) => participant.participantId === draft.participantId) && <option value={draft.participantId}>기존 연결 유지</option>}</select></label>
          {error && <p role="alert">{error}</p>}
        </div><footer>{roster?.speakers.some((speaker) => speaker.id === draft.id) && <button type="button" disabled={locked} onClick={() => { setRoster({ ...roster, speakers: roster.speakers.filter((speaker) => speaker.id !== draft.id), activeOnsiteSpeakerId: roster.activeOnsiteSpeakerId === draft.id ? null : roster.activeOnsiteSpeakerId }); setDirty(true); setDraft(null); }}>목록에서 제거</button>}<button type="submit" className={styles.primary} disabled={locked}>목록에 적용</button></footer>
      </form>
    </dialog>, document.body)}
  </section>;
}
