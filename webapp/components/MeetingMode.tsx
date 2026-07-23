"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { LanguageCode } from "@/lib/languageDetect";
import {
  generateRoomCode,
  getPairToken,
  isMeetingConfigured,
  joinMeetingRoom,
  meetingCodeFromPairToken,
  normalizeRoomCode,
  defaultColorForKey,
  MEETING_COLORS,
  type MeetingConnectionStatus,
  type MeetingParticipant,
  type MeetingRoomHandle,
  type MeetingUtterance,
} from "@/lib/meeting";
import { createTranslationEngine, type TranslationEngine } from "@/lib/engine";
import { loadSettings } from "@/lib/settings";

const LANGUAGE_LABELS: Record<LanguageCode, string> = { ko: "한국어", en: "English", ja: "日本語" };

function loginName(): string {
  const match = document.cookie.match(/(?:^|; )rnw_name=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/**
 * @deprecated 기존 참가자별 PTT 회의 모드입니다. LiveHostDashboard의 서버 화자 분리
 * Meeting 모드로 대체되어 UI에서는 노출하지 않으며, 다음 제거 사이클까지 보존합니다.
 */
export default function MeetingMode({
  onSubtitle,
}: {
  /** Feeds the shared live-subtitle surfaces (mobile big view + PiP). */
  onSubtitle: (text: string, speaker: string) => void;
}) {
  const keyRef = useRef(`p-${Math.random().toString(36).slice(2, 10)}`);
  const [stage, setStage] = useState<"entry" | "room">("entry");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<LanguageCode>("ko");
  const [color, setColor] = useState(() => defaultColorForKey(keyRef.current));
  const [pairCode, setPairCode] = useState("");
  const [status, setStatus] = useState<MeetingConnectionStatus>("closed");
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]);
  const [feed, setFeed] = useState<{ id: string; speaker: string; text: string; color: string; mine: boolean }[]>([]);
  const [talking, setTalking] = useState(false);
  const [error, setError] = useState("");

  const roomRef = useRef<MeetingRoomHandle | null>(null);
  const engineRef = useRef<TranslationEngine | null>(null);
  const participantsRef = useRef<MeetingParticipant[]>([]);
  const languageRef = useRef<LanguageCode>("ko");
  const colorRef = useRef(color);
  const lastPointerType = useRef("mouse");
  const lastUtteranceRef = useRef<MeetingUtterance | null>(null);

  useEffect(() => setName(loginName()), []);
  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { participantsRef.current = participants; }, [participants]);
  // Walkie-talkie: if this phone arrived via the desktop QR, offer one-tap join
  // into the shared room derived from that pair token.
  useEffect(() => { setPairCode(meetingCodeFromPairToken(getPairToken())); }, []);

  const enter = useCallback((roomCode: string) => {
    if (!isMeetingConfigured()) { setError("회의 모드를 사용하려면 Supabase 환경변수가 필요합니다."); return; }
    const normalized = normalizeRoomCode(roomCode);
    if (normalized.length < 4) { setError("방 코드를 확인하세요."); return; }
    if (!name.trim()) { setError("이름을 입력하세요."); return; }
    setError("");
    setCode(normalized);
    roomRef.current = joinMeetingRoom({
      code: normalized,
      name: name.trim(),
      language,
      color: colorRef.current,
      participantKey: keyRef.current,
      onUtterance: (utterance) => {
        // Each viewer sees ONLY their chosen language; fall back to any
        // available text while the per-language commits are still trickling in.
        const text = utterance.texts[languageRef.current]
          ?? Object.values(utterance.texts).find(Boolean) ?? "";
        if (!text) return;
        const entry = {
          id: utterance.id, speaker: utterance.speaker, text,
          color: utterance.color || defaultColorForKey(utterance.speakerKey),
          mine: utterance.speakerKey === keyRef.current,
        };
        // The speaker re-broadcasts the same utterance id as per-language
        // commits trickle in — update the existing line instead of appending.
        setFeed((lines) => {
          const index = lines.findIndex((line) => line.id === utterance.id);
          if (index >= 0) {
            const next = [...lines];
            next[index] = entry;
            return next;
          }
          return [...lines.slice(-199), entry];
        });
        onSubtitle(text, utterance.speaker);
      },
      onParticipants: setParticipants,
      onJoin: setParticipants,
      onLeave: setParticipants,
      onStatus: setStatus,
    });
    setStage("room");
  }, [language, name, onSubtitle]);

  const stopTalking = useCallback(async () => {
    setTalking(false);
    const engine = engineRef.current;
    engineRef.current = null;
    if (engine) await engine.stop().catch(() => {});
  }, []);

  const startTalking = useCallback(async () => {
    if (talking || status !== "subscribed") return;
    setError("");
    const settings = loadSettings();
    // Translate into every language present in the room (mine included — my
    // own column carries the cleaned transcript for same-language listeners).
    const targets = Array.from(new Set([languageRef.current, ...participantsRef.current.map((p) => p.language)]));
    const engine = createTranslationEngine({
      inputMode: "mic",
      languagePair: settings.languagePair,
      targetLanguages: targets,
      engine: settings.engine,
      tone: settings.tone,
      glossary: settings.glossary,
      domain: settings.domain,
      emit: (event) => {
        if (event.type === "committed" && event.translatedText) {
          // Group per-target commits of the same moment into one utterance.
          const recent = lastUtteranceRef.current;
          const bucket = recent && Date.now() - recent.at < 2500 ? recent : undefined;
          const utterance: MeetingUtterance = bucket ?? {
            type: "utterance", id: `${keyRef.current}-${Date.now()}`, speaker: name.trim() || "익명",
            speakerKey: keyRef.current, color: colorRef.current, texts: {}, at: Date.now(),
          };
          utterance.texts[event.targetLanguage] = event.translatedText;
          if (event.sourceText) utterance.texts[languageRef.current] ??= event.sourceText;
          lastUtteranceRef.current = utterance;
          roomRef.current?.sendUtterance(utterance);
        }
        if (event.type === "error") setError(event.message);
      },
    });
    engineRef.current = engine;
    setTalking(true);
    try { await engine.start(); } catch (startError: any) {
      setError(startError?.message ?? "마이크를 시작할 수 없습니다.");
      await stopTalking();
    }
  }, [name, status, stopTalking, talking]);

  const leave = useCallback(async () => {
    await stopTalking();
    roomRef.current?.leave();
    roomRef.current = null;
    setStage("entry");
    setFeed([]);
    setParticipants([]);
  }, [stopTalking]);

  useEffect(() => () => { void stopTalking(); roomRef.current?.leave(); }, [stopTalking]);

  if (stage === "entry") {
    return (
      <div className="glass mx-auto max-w-md p-6">
        <h2 className="display mb-2 text-2xl">회의 모드</h2>
        <p className="mb-4 text-sm text-cw-grey">한 방에 여러 명이 접속해, 각자 고른 언어로만 자막을 봅니다. 발언은 이름·색으로 구분됩니다.</p>

        {pairCode && (
          <button onClick={() => enter(pairCode)}
            className="accent-btn mb-4 w-full px-4 py-3 font-semibold">
            📡 이 QR 회의 참여 — {pairCode}
          </button>
        )}

        <label className="mb-1 block text-sm text-cw-grey75">이름 (자막에 표시)</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: Noel"
          className="glass-input mb-3" />

        <label className="mb-1 block text-sm text-cw-grey75">내 언어 (자막 수신 언어)</label>
        <select value={language} onChange={(e) => setLanguage(e.target.value as LanguageCode)}
          className="glass-input mb-3">
          {(Object.keys(LANGUAGE_LABELS) as LanguageCode[]).map((lang) => (
            <option key={lang} value={lang}>{LANGUAGE_LABELS[lang]}</option>
          ))}
        </select>

        <label className="mb-1 block text-sm text-cw-grey75">내 자막 색 (발언 구분)</label>
        <div className="mb-4 flex flex-wrap gap-2">
          {MEETING_COLORS.map((swatch) => (
            <button key={swatch} type="button" aria-label={`색 ${swatch}`} onClick={() => setColor(swatch)}
              className={`h-8 w-8 rounded-full transition ${color === swatch ? "ring-2 ring-cw-ink ring-offset-2" : "opacity-80 hover:opacity-100"}`}
              style={{ background: swatch }} />
          ))}
        </div>

        <button onClick={() => enter(generateRoomCode())}
          className="glass-btn mb-3 w-full px-4 py-3 font-semibold">
          새 방 만들기
        </button>
        <div className="flex gap-2">
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="방 코드로 참여"
            className="glass-input flex-1 uppercase" />
          <button onClick={() => enter(code)}
            className="nowrap glass-btn px-5 font-medium">
            참여
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-cw-darkRed">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4">
      <div className="glass flex items-center justify-between px-5 py-3">
        <button onClick={() => navigator.clipboard?.writeText(code)} title="탭하여 복사"
          className="nowrap font-mono text-lg font-bold tracking-widest text-cw-ink">{code}</button>
        <div className="flex flex-wrap items-center gap-2">
          {participants.map((participant) => (
            <span key={participant.key} className="nowrap inline-flex items-center gap-1.5 rounded-full border border-cw-hairline bg-cw-surface px-3 py-1 text-xs text-cw-grey">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: participant.color }} />
              {participant.name} · {LANGUAGE_LABELS[participant.language]}
            </span>
          ))}
          <span className={`h-2 w-2 rounded-full ${status === "subscribed" ? "bg-cw-green" : "bg-cw-yellow"}`} />
          <button onClick={leave} className="nowrap ml-1 text-xs text-cw-grey75 underline">나가기</button>
        </div>
      </div>

      <div className="glass flex-1 space-y-2 overflow-y-auto p-4">
        {feed.length === 0 && <p className="text-center text-sm text-cw-grey50">발언 버튼을 누르고 말하면 참가자 각자의 언어로 표시됩니다.</p>}
        {feed.map((line, index) => (
          <div key={`${line.id}-${index}`}
            className={`max-w-[85%] rounded-2xl px-4 py-2 ${line.mine ? "ml-auto" : ""}`}
            style={{ background: `${line.color}1f`, borderLeft: `3px solid ${line.color}` }}>
            <span className="mr-2 text-xs font-semibold" style={{ color: line.color }}>{line.speaker}:</span>
            <span className="text-cw-ink">{line.text}</span>
          </div>
        ))}
      </div>

      {status !== "subscribed" && <p className="text-center text-xs text-cw-yellow">연결 중… 발언은 연결 후 가능합니다.</p>}
      {error && <p className="text-center text-sm text-cw-darkRed">{error}</p>}

      <button
        onPointerDown={(e) => { lastPointerType.current = e.pointerType; if (e.pointerType !== "mouse") void startTalking(); }}
        onPointerUp={(e) => { if (e.pointerType !== "mouse") void stopTalking(); }}
        // Touch fires a synthetic click after pointerup; ignore it so a tap
        // doesn't re-start talking and leave the mic stuck on. Mouse = toggle.
        onClick={() => { if (lastPointerType.current !== "mouse") return; if (talking) void stopTalking(); else void startTalking(); }}
        disabled={status !== "subscribed"}
        className={`mx-auto mb-2 flex h-20 w-20 items-center justify-center rounded-full border text-sm font-bold transition
          ${talking ? "ptt-active border-cw-red bg-cw-red text-white" : "border-cw-hairlineStrong bg-white/70 text-cw-ink hover:bg-white"}
          disabled:opacity-40`}>
        {talking ? "말하는 중" : "발언"}
      </button>
      <p className="mb-1 text-center text-[11px] text-cw-grey50">모바일: 누르고 있는 동안 발언 · PC: 클릭으로 시작/종료</p>
    </div>
  );
}
