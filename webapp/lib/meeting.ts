"use client";

// 회의 모드 realtime fanout: Supabase Realtime broadcast + presence only —
// no database tables. The speaker's device runs the translation channels and
// broadcasts one aggregated utterance per spoken line; every participant
// renders texts[myLanguage].

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

import { detectLanguage, type LanguageCode } from "./languageDetect";

export interface MeetingParticipant {
  key: string;
  name: string;
  language: LanguageCode;
  /** The participant's chosen subtitle color (hex). */
  color: string;
}

export interface MeetingUtterance {
  type: "utterance";
  id: string;
  speaker: string;
  speakerKey: string;
  /** Speaker's chosen color, carried so every viewer renders it consistently. */
  color?: string;
  sourceLang?: LanguageCode;
  /** Per-language texts; the speaker's own language carries the original transcript. */
  texts: Partial<Record<LanguageCode, string>>;
  at: number;
}

/** Default subtitle palette — distinct, legible on the light editorial canvas. */
export const MEETING_COLORS = [
  "#0a84ff", // blue
  "#ff453a", // red
  "#30b06e", // green
  "#bf5af2", // purple
  "#ff9f0a", // orange
  "#ff2d92", // pink
  "#00b8c4", // teal
  "#a2845e", // brown
];

/** Stable default color for a participant key, before they pick one. */
export function defaultColorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return MEETING_COLORS[hash % MEETING_COLORS.length];
}

/** Many phones scanning the same desktop QR derive the same meeting room from
 *  its pair token — walkie-talkie style, no manual code entry. */
export function meetingCodeFromPairToken(token: string): string {
  return normalizeRoomCode(token);
}

export type MeetingConnectionStatus = "connecting" | "subscribed" | "reconnecting" | "closed";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export function isMeetingConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

let client: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!isMeetingConfigured()) {
    throw new Error("회의 모드를 사용하려면 Supabase 환경변수가 필요합니다.");
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}

// Room codes avoid easily-confused glyphs (0/O, 1/I/L).
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateRoomCode(): string {
  let code = "";
  const random = new Uint32Array(6);
  crypto.getRandomValues(random);
  for (let i = 0; i < 6; i += 1) {
    code += ROOM_CODE_ALPHABET[random[i] % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

export interface MeetingRoomHandle {
  sendUtterance(utterance: MeetingUtterance): void;
  leave(): void;
}

export function joinMeetingRoom({
  code,
  name,
  language,
  color,
  participantKey,
  onUtterance,
  onParticipants,
  onJoin,
  onLeave,
  onStatus,
}: {
  code: string;
  name: string;
  language: LanguageCode;
  color: string;
  participantKey: string;
  onUtterance: (utterance: MeetingUtterance) => void;
  onParticipants: (participants: MeetingParticipant[]) => void;
  onJoin: (participants: MeetingParticipant[]) => void;
  onLeave: (participants: MeetingParticipant[]) => void;
  onStatus: (status: MeetingConnectionStatus) => void;
}): MeetingRoomHandle {
  const supabase = getSupabaseClient();
  // broadcast.self so the speaker renders their own committed lines through
  // the exact same path as everyone else.
  const channel: RealtimeChannel = supabase.channel(`meeting:${code}`, {
    config: {
      broadcast: { self: true },
      presence: { key: participantKey },
    },
  });

  function presenceToParticipants(): MeetingParticipant[] {
    const state = channel.presenceState<{ name: string; language: LanguageCode; color: string }>();
    const participants: MeetingParticipant[] = [];
    for (const [key, metas] of Object.entries(state)) {
      const meta = metas[0];
      if (!meta) continue;
      participants.push({
        key,
        name: String((meta as any).name ?? "익명"),
        language: ((meta as any).language ?? "ko") as LanguageCode,
        color: String((meta as any).color ?? defaultColorForKey(key)),
      });
    }
    participants.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    return participants;
  }

  function metasToParticipants(metas: Array<Record<string, unknown>>, key: string): MeetingParticipant[] {
    return metas.map((meta) => ({
      key,
      name: String(meta.name ?? "익명"),
      language: (meta.language ?? "ko") as LanguageCode,
      color: String(meta.color ?? defaultColorForKey(key)),
    }));
  }

  channel
    .on("broadcast", { event: "utterance" }, ({ payload }) => {
      if (!payload || typeof payload !== "object") return;
      const utterance = payload as MeetingUtterance;
      if (!utterance.texts || typeof utterance.texts !== "object") return;
      onUtterance(utterance);
    })
    .on("presence", { event: "sync" }, () => {
      onParticipants(presenceToParticipants());
    })
    .on("presence", { event: "join" }, ({ key, newPresences }) => {
      onJoin(metasToParticipants(newPresences as any, key));
    })
    .on("presence", { event: "leave" }, ({ key, leftPresences }) => {
      onLeave(metasToParticipants(leftPresences as any, key));
    });

  onStatus("connecting");
  channel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      onStatus("subscribed");
      try {
        await channel.track({ name, language, color });
      } catch {
        // presence track failure surfaces as a missing chip; non-fatal
      }
      return;
    }
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      // supabase-js retries the join automatically; flag the UI meanwhile.
      onStatus("reconnecting");
      return;
    }
    if (status === "CLOSED") onStatus("closed");
  });

  return {
    sendUtterance(utterance: MeetingUtterance) {
      void channel.send({ type: "broadcast", event: "utterance", payload: utterance });
    },
    leave() {
      void channel.untrack().catch(() => undefined);
      void getSupabaseClient().removeChannel(channel);
    },
  };
}

// ---------------------------------------------------------------------------
// Utterance aggregator: the speech engine commits one line per target-language
// channel at slightly different times. Collect commits for the same spoken
// utterance within a short window, then flush a single { texts } payload.
// ---------------------------------------------------------------------------

const AGGREGATE_WINDOW_MS = 1600;

export interface UtteranceAggregator {
  add(commit: { targetLanguage: LanguageCode; sourceText: string; translatedText: string }): void;
  flushNow(): void;
  dispose(): void;
}

export function createUtteranceAggregator({
  speakerLanguage,
  onFlush,
}: {
  speakerLanguage: LanguageCode;
  onFlush: (utterance: { sourceLang?: LanguageCode; texts: Partial<Record<LanguageCode, string>> }) => void;
}): UtteranceAggregator {
  let pending: {
    texts: Partial<Record<LanguageCode, string>>;
    sourceText: string;
  } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    const current = pending;
    pending = null;
    if (!current) return;
    const detected = detectLanguage(current.sourceText);
    const sourceLang = detected === "unknown" ? speakerLanguage : detected;
    const texts = { ...current.texts };
    // The speaker's own language carries the original transcript (channels
    // suppress same-language output, so this never overwrites a translation).
    if (current.sourceText && !texts[sourceLang]) texts[sourceLang] = current.sourceText;
    if (Object.keys(texts).length === 0) return;
    onFlush({ sourceLang, texts });
  }

  return {
    add({ targetLanguage, sourceText, translatedText }) {
      if (!pending) {
        pending = { texts: {}, sourceText: "" };
        timer = setTimeout(flush, AGGREGATE_WINDOW_MS);
      }
      if (translatedText) pending.texts[targetLanguage] = translatedText;
      if (sourceText.length > pending.sourceText.length) pending.sourceText = sourceText;
    },
    flushNow: flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

// ── Deprecated phone↔desktop link ───────────────────────────────────────────
// @deprecated The authenticated Live viewer replaces this local pairing path.
// Keep it for this compatibility cycle, but do not issue or consume login-derived
// browser cookies for pairing.
export interface LinkLine {
  partial: boolean;
  translatedText: string;
  sourceText: string;
  targetLanguage: string;
  speaker?: string;
}

const PAIR_STORAGE_KEY = "rnw_pair_v1";
export const PAIR_TTL_MS = 6 * 60 * 60 * 1000; // QR pairing auto-expires after 6h

export function setPairToken(token: string): void {
  try { localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify({ token, at: Date.now() })); } catch {}
}

export function getPairToken(): string {
  try {
    const raw = localStorage.getItem(PAIR_STORAGE_KEY);
    if (!raw) return "";
    const { token, at } = JSON.parse(raw);
    if (typeof token !== "string" || Date.now() - Number(at) > PAIR_TTL_MS) {
      localStorage.removeItem(PAIR_STORAGE_KEY);
      return "";
    }
    return token;
  } catch { return ""; }
}

function linkChannelFromCookie(): string {
  const token = getPairToken();
  return token ? `pair:${token}` : "";
}

let linkChannel: RealtimeChannel | null = null;
let linkChannelName = "";

export function publishToLinkChannel(line: LinkLine): void {
  if (!isMeetingConfigured()) return;
  const name = linkChannelFromCookie();
  if (!name) return;
  if (!linkChannel || linkChannelName !== name) {
    linkChannel?.unsubscribe();
    linkChannelName = name;
    linkChannel = getSupabaseClient().channel(name);
    linkChannel.subscribe();
  }
  void linkChannel.send({ type: "broadcast", event: "line", payload: line });
}
