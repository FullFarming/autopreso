import { normalizeSpeakerProfile } from "../packages/caption-core/speaker-profile.js";
const MAX_PAGES = 400;
const MAX_LINES = 20_000;
const MAX_BYTES = 20 * 1024 * 1024;
const READ_DEADLINE_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class LiveCallArchiveError extends Error {
  constructor(code = "LIVE_ARCHIVE_INVALID") {
    super("회의 기록을 갱신하지 못했습니다. 연결을 확인한 뒤 다시 열어 주세요.");
    this.code = code;
  }
}
/** @param {unknown} value */
export function readLiveArchiveSessionId(value) {
  if (typeof value !== "string") throw new LiveCallArchiveError("INVALID_SESSION_ID");
  const id = value.startsWith("live-") ? value.slice(5) : value;
  if (!UUID.test(id)) throw new LiveCallArchiveError("INVALID_SESSION_ID");
  return id.toLowerCase();
}
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** @param {unknown} value */
function readEnvelope(value) {
  if (isRecord(value) && value.ok === false && ["HOST_LOGIN_REQUIRED", "AUTH_REQUIRED", "HTTP_401"].includes(String(value.code))) throw new LiveCallArchiveError("HOST_LOGIN_REQUIRED");
  if (isRecord(value) && value.ok === false && ["FORBIDDEN", "HTTP_403"].includes(String(value.code))) throw new LiveCallArchiveError("FORBIDDEN");
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) throw new LiveCallArchiveError("LIVE_ARCHIVE_READ_FAILED");
  return value.data;
}
/** @param {unknown} value @param {number} maximum @param {boolean} [allowEmpty] */
function text(value, maximum, allowEmpty = true) {
  if (typeof value !== "string" || Array.from(value).length > maximum || (!allowEmpty && !value.trim())) throw new LiveCallArchiveError();
  return value;
}
/** @param {unknown} value @param {boolean} [nullable] */
function timestamp(value, nullable = false) {
  if (nullable && value === null) return "";
  const result = text(value, 64, false);
  if (!Number.isFinite(Date.parse(result))) throw new LiveCallArchiveError();
  return result;
}
/** @typedef {{sessionId:string,baseUrl:string,localAppOrigin:string,hostId:string}} ArchiveContext */
/** @typedef {{at:string,sourceText:string,translatedText:string,sourceLanguage:string,targetLanguage:string,speaker:string,sourceSeq?:number,sourceUtteranceId?:string,translationSeq?:number}} ArchiveLine */
/** @typedef {{id:string,title:string,kind:string,liveSessionId:string,ownerHostId:string,startedAt:string,endedAt:string,lines:ArchiveLine[],summary:Record<string,unknown>|null}} ArchivePayload */
/**
 * @param {{requestRemote:(baseUrl:string,path:string,options:{method:"GET",timeoutMilliseconds:number})=>Promise<unknown>,importLocal:(payload:ArchivePayload,context:ArchiveContext)=>Promise<unknown>,now?:()=>number}} options
 */
export function createLiveCallArchive({ requestRemote, importLocal, now = Date.now }) {
  /** @type {Map<string,Promise<{ok:true,sourceCount:number,translationCount:number}>>} */
  const inFlight = new Map();
  /** @param {ArchiveContext} context */
  function refresh(context) {
    let sessionId;
    try { sessionId = readLiveArchiveSessionId(context.sessionId); } catch (error) { return Promise.reject(error); }
    const key = JSON.stringify([context.baseUrl, context.localAppOrigin, context.hostId, sessionId]);
    const current = inFlight.get(key);
    if (current) return current;
    if (inFlight.size >= 4) return Promise.reject(new LiveCallArchiveError("LIVE_ARCHIVE_BUSY"));
    const pending = load({ ...context, sessionId }).finally(() => { inFlight.delete(key); });
    inFlight.set(key, pending);
    return pending;
  }
  /** @param {ArchiveContext} context @returns {Promise<{ok:true,sourceCount:number,translationCount:number}>} */
  async function load(context) {
    const deadline = now() + READ_DEADLINE_MS;
    let bytes = 0;
    /** @type {ArchiveLine[]} */
    const lines = [];
    /** @param {string} path */
    async function get(path) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new LiveCallArchiveError("LIVE_ARCHIVE_TIMEOUT");
      const response = await requestRemote(context.baseUrl, path, { method: "GET", timeoutMilliseconds: Math.min(15_000, remaining) });
      if (now() >= deadline) throw new LiveCallArchiveError("LIVE_ARCHIVE_TIMEOUT");
      bytes += Buffer.byteLength(JSON.stringify(response), "utf8");
      if (bytes > MAX_BYTES) throw new LiveCallArchiveError("LIVE_ARCHIVE_TOO_LARGE");
      return readEnvelope(response);
    }
    /** @param {ArchiveLine} line */
    function append(line) {
      if (lines.length >= MAX_LINES) throw new LiveCallArchiveError("LIVE_ARCHIVE_TOO_LARGE");
      lines.push(line);
    }
    const prefix = `/api/live-records/${context.sessionId}`;
    const initial = await get(`${prefix}?language=ko`);
    const detail = readDetail(initial.detail, context.sessionId);
    const record = detail.record;
    const languages = record.languages;
    if (!Array.isArray(languages) || languages.length < 1 || languages.length > 3
      || languages.some(language => !["ko", "en", "ja"].includes(language)) || new Set(languages).size !== languages.length) throw new LiveCallArchiveError();
    let cursor = 0;
    let sourceCount = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await get(`${prefix}/transcript?afterSourceSeq=${cursor}&pageSize=50`);
      const transcript = data.transcript;
      if (!isRecord(transcript) || transcript.sessionId !== context.sessionId || !Array.isArray(transcript.items)
        || transcript.items.length > 50 || typeof transcript.hasNextPage !== "boolean") throw new LiveCallArchiveError();
      for (const item of transcript.items) {
        if (!isRecord(item) || !Number.isSafeInteger(item.sourceSeq) || typeof item.sourceSeq !== "number" || item.sourceSeq <= cursor) throw new LiveCallArchiveError();
        cursor = item.sourceSeq;
        const sourceText = text(item.effectiveText, 8_000, false);
        if (Buffer.byteLength(sourceText, "utf8") > 24_000) throw new LiveCallArchiveError("LIVE_ARCHIVE_TOO_LARGE");
        append({
          at: timestamp(item.sourceStartedAt ?? item.providerCommittedAt),
          sourceText,
          sourceSeq: cursor,
          sourceUtteranceId: text(item.sourceUtteranceId, 128, false),
          sourceLanguage: text(item.sourceLanguage, 16, false),
          speaker: text(item.speakerName ?? item.speakerLabel ?? "", 80),
          ...(item.speakerProfile ? { speakerProfile: normalizeSpeakerProfile(item.speakerProfile) } : {}),
          ...(item.speakerAttribution === "unresolved" ? { speakerAttribution: "unresolved" } : {}),
          translatedText: "", targetLanguage: "",
        });
        sourceCount += 1;
      }
      if (!transcript.hasNextPage) break;
      if (page + 1 === MAX_PAGES || transcript.items.length === 0 || transcript.nextAfterSourceSeq !== cursor) throw new LiveCallArchiveError("LIVE_ARCHIVE_PAGINATION_INVALID");
    }
    // 2026-09-01 fix: 번역은 별도 흐름이다. 시간이나 행 번호로 원문과 짝짓지 않는다.
    let translationCount = 0;
    for (const language of languages) {
      const selected = detail.selectedLanguage === language ? detail : readDetail((await get(`${prefix}?language=${language}`)).detail, context.sessionId);
      const transcript = selected.transcript;
      if (!isRecord(transcript) || transcript.language !== language || !Array.isArray(transcript.utterances)) throw new LiveCallArchiveError();
      let sequence = 0;
      for (const utterance of transcript.utterances) {
        if (!isRecord(utterance)) throw new LiveCallArchiveError();
        if (utterance.origin === "source" || utterance.translationStatus === "failed") continue;
        if (typeof utterance.seq !== "number" || !Number.isSafeInteger(utterance.seq) || utterance.seq <= sequence) throw new LiveCallArchiveError();
        sequence = utterance.seq;
        append({ at: timestamp(utterance.emittedAt), sourceText: "", sourceLanguage: "", translatedText: text(utterance.text, 8_000, false), targetLanguage: language, translationSeq: sequence, speaker: text(utterance.speaker ?? "", 80),
          ...(utterance.speakerProfile ? { speakerProfile: normalizeSpeakerProfile(utterance.speakerProfile) } : {}),
          ...(utterance.speakerAttribution === "unresolved" ? { speakerAttribution: "unresolved" } : {}),
        });
        translationCount += 1;
      }
    }
    let summary = null;
    if (detail.summary !== null) {
      if (!isRecord(detail.summary) || !isRecord(detail.summary.summary)) throw new LiveCallArchiveError();
      summary = { ...detail.summary.summary, createdAt: timestamp(detail.summary.createdAt) };
    }
    if (now() >= deadline) throw new LiveCallArchiveError("LIVE_ARCHIVE_TIMEOUT");
    const imported = await importLocal({ id: `live-${context.sessionId}`, kind: "live-call", liveSessionId: context.sessionId, ownerHostId: context.hostId,
      title: text(record.title, 200), startedAt: timestamp(record.startedAt, true), endedAt: timestamp(record.endedAt, true), lines, summary }, context);
    if (!isRecord(imported) || imported.ok !== true) throw new LiveCallArchiveError("LIVE_ARCHIVE_IMPORT_FAILED");
    return { ok: true, sourceCount, translationCount };
  }
  return { refresh };
}
/** @param {unknown} value @param {string} sessionId @returns {Record<string,unknown> & {record:Record<string,unknown>}} */
function readDetail(value, sessionId) {
  if (!isRecord(value) || !isRecord(value.record) || value.record.sessionId !== sessionId) throw new LiveCallArchiveError();
  return { ...value, record: value.record };
}
