// Per-viewer subtitle channel hub.
//
// The subtitle pipeline historically fanned identical bytes to every WebSocket
// client; a viewer could not pick "their" language. This hub adds three things
// without changing that default:
//   1. a monotonically increasing `seq` on every lane message (partial /
//      committed / clear) so clients can order and dedupe independently,
//   2. per-client language subscriptions (`subtitle:subscribe`) that filter
//      lane messages server-side — clients that never subscribe still receive
//      everything (full backward compatibility),
//   3. a live-lane snapshot per (source, targetLanguage) so a late-joining or
//      re-subscribing viewer paints the current line immediately instead of
//      waiting for the next partial.

import { randomUUID } from "node:crypto";

import { isSupportedSubtitleLanguage, normalizeSubtitleLanguageCode } from "./subtitle-languages.js";

const LANE_MESSAGE_TYPES = new Set(["subtitle:partial", "subtitle:committed"]);
const RETIRED_TRANSLATED_AUDIO_MESSAGE_TYPES = new Set(["subtitle:translated-audio", "subtitle:audio-control"]);
const LIVE_CALL_DISPLAY_HISTORY_LIMIT = 8;

export function isRetiredTranslatedAudioMessage(message) {
  return RETIRED_TRANSLATED_AUDIO_MESSAGE_TYPES.has(message?.type);
}

function laneKey(message) {
  return `${message.source ?? ""}\u0000${message.targetLanguage ?? ""}`;
}

export function createSubtitleChannelHub({
  now = Date.now,
  maximumSnapshotEventsPerLane = LIVE_CALL_DISPLAY_HISTORY_LIMIT,
} = {}) {
  if (!Number.isSafeInteger(maximumSnapshotEventsPerLane) || maximumSnapshotEventsPerLane < 1) {
    throw new Error("INVALID_SUBTITLE_SNAPSHOT_HISTORY_LIMIT");
  }
  let seq = 0;
  const streamId = randomUUID();
  /** @type {Map<string, any>} last line per (source, targetLanguage) */
  const lanes = new Map();
  /** @type {Array<any>} bounded canonical Live Call state replayed by every display */
  const liveCallDisplayTimeline = [];
  let activeLiveCallSessionId = "";
  /** @type {WeakMap<object, Set<string>|null>} client → subscribed languages (null/absent = all) */
  const subscriptions = new WeakMap();

  return {
    // Stamp + track a subtitle broadcast. Returns the message to actually send.
    ingest(message) {
      if (!message || typeof message !== "object") return message;
      if (LANE_MESSAGE_TYPES.has(message.type)) {
        seq += 1;
        const stamped = {
          ...message,
          seq,
          streamId,
          ...(message.source === "live-call" ? { displayTimestamp: now() } : {}),
        };
        lanes.set(laneKey(stamped), stamped);
        if (stamped.source === "live-call") {
          const key = laneKey(stamped);
          for (let index = liveCallDisplayTimeline.length - 1; index >= 0; index -= 1) {
            const prior = liveCallDisplayTimeline[index];
            if (laneKey(prior) !== key || prior.type !== "subtitle:partial") continue;
            liveCallDisplayTimeline.splice(index, 1);
          }
          liveCallDisplayTimeline.push(stamped);
          while (liveCallDisplayTimeline.length > maximumSnapshotEventsPerLane) {
            liveCallDisplayTimeline.shift();
          }
        }
        return stamped;
      }
      if (message.type === "subtitle:clear") {
        seq += 1;
        lanes.delete(laneKey(message));
        if (message.source === "live-call") {
          const key = laneKey(message);
          for (let index = liveCallDisplayTimeline.length - 1; index >= 0; index -= 1) {
            if (laneKey(liveCallDisplayTimeline[index]) === key) liveCallDisplayTimeline.splice(index, 1);
          }
        }
        return { ...message, seq, streamId };
      }
      if (message.type === "subtitle:status" && (message.status === "idle" || message.status === "connecting")) {
        lanes.clear();
        liveCallDisplayTimeline.length = 0;
        activeLiveCallSessionId = "";
      }
      return message;
    },

    // Whether this client should receive this (already-ingested) message.
    shouldSend(client, message) {
      // Caption contract v2 has no translated-audio lane. Keep this fail-closed
      // guard while old desktop processes can still reconnect during upgrade.
      if (isRetiredTranslatedAudioMessage(message)) return false;
      const targetLanguage = message?.targetLanguage;
      if (typeof targetLanguage !== "string" || !targetLanguage) return true;
      const subscribed = subscriptions.get(client);
      if (!subscribed) return true;
      return subscribed.has(targetLanguage);
    },

    // languages: array of language codes, or null/empty to receive all.
    // Junk-only lists fall back to receive-all so a typo never blackholes a viewer.
    subscribe(client, languages) {
      const normalized = (Array.isArray(languages) ? languages : [])
        .map((language) => normalizeSubtitleLanguageCode(language))
        .filter((language) => isSupportedSubtitleLanguage(language));
      subscriptions.set(client, normalized.length > 0 ? new Set(normalized) : null);
      return this.snapshotFor(client);
    },

    snapshotFor(client) {
      const subscribed = subscriptions.get(client) ?? null;
      const visible = [...lanes.values()].filter((line) => !subscribed || subscribed.has(line.targetLanguage));
      const events = liveCallDisplayTimeline
        .filter((line) => !subscribed || subscribed.has(line.targetLanguage))
        .slice()
        .sort((left, right) => left.seq - right.seq);
      return {
        type: "subtitle:snapshot",
        seq,
        streamId,
        liveSessionId: activeLiveCallSessionId,
        lanes: visible,
        events,
      };
    },

    setLiveCallSession(sessionId) {
      const normalized = typeof sessionId === "string" ? sessionId.trim().slice(0, 240) : "";
      if (!normalized) throw new Error("LIVE_CALL_SESSION_REQUIRED");
      if (activeLiveCallSessionId && activeLiveCallSessionId !== normalized) {
        liveCallDisplayTimeline.length = 0;
        for (const [key, line] of lanes) {
          if (line.source === "live-call") lanes.delete(key);
        }
      }
      activeLiveCallSessionId = normalized;
    },

    clearLiveCallSession(sessionId) {
      if (sessionId && sessionId !== activeLiveCallSessionId) return false;
      activeLiveCallSessionId = "";
      liveCallDisplayTimeline.length = 0;
      for (const [key, line] of lanes) {
        if (line.source === "live-call") lanes.delete(key);
      }
      return true;
    },

    removeClient(client) {
      subscriptions.delete(client);
    },
  };
}
