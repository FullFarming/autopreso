import type { LiveRecordDetail } from "@/lib/live-records/service";
import type { LiveRecordListPage } from "@/lib/live-records/service";
import type { AuthoritativeTranscriptPage } from "@/lib/live-records/service";
import { recapRecipientsSchema, recordingGapsSchema, type HostRecapRequest, type RecordingGap } from "../../../lib/live-recap/contract";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readEnvelope(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || typeof payload.ok !== "boolean") throw new Error("응답을 확인할 수 없습니다.");
  if (!payload.ok) throw new Error(typeof payload.error === "string" ? payload.error : "요청을 완료할 수 없습니다.");
  if (!isRecord(payload.data)) throw new Error("응답을 확인할 수 없습니다.");
  return payload.data;
}

export async function fetchLiveRecordPage(page: number, search: string): Promise<LiveRecordListPage> {
  const params = new URLSearchParams({ page: String(page), pageSize: "20" });
  if (search) params.set("search", search);
  const data = await readEnvelope(await fetch(`/api/live-records?${params}`, { cache: "no-store" }));
  if (!isRecord(data.page) || !Array.isArray(data.page.items)
    || typeof data.page.page !== "number" || typeof data.page.total !== "number"
    || typeof data.page.pageSize !== "number" || typeof data.page.hasNextPage !== "boolean") {
    throw new Error("기록 목록을 확인할 수 없습니다.");
  }
  return data.page as unknown as LiveRecordListPage;
}

export async function fetchLiveRecordDetail(sessionId: string, language?: string, signal?: AbortSignal): Promise<LiveRecordDetail> {
  const params = new URLSearchParams();
  if (language) params.set("language", language);
  const suffix = params.size ? `?${params}` : "";
  const data = await readEnvelope(await fetch(`/api/live-records/${encodeURIComponent(sessionId)}${suffix}`, { cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) }));
  if (!isRecord(data.detail) || !isRecord(data.detail.record) || !isRecord(data.detail.transcript)
    || !Array.isArray(data.detail.transcript.utterances) || !Array.isArray(data.detail.topics)
    || !Array.isArray(data.detail.participants) || typeof data.detail.selectedLanguage !== "string") {
    throw new Error("기록 상세를 확인할 수 없습니다.");
  }
  return data.detail as unknown as LiveRecordDetail;
}

export async function deleteLiveRecord(sessionId: string): Promise<void> {
  await readEnvelope(await fetch(`/api/live-records/${encodeURIComponent(sessionId)}`, { method: "DELETE" }));
}

export async function restoreLiveRecord(sessionId: string): Promise<void> {
  await readEnvelope(await fetch(`/api/live-records/${encodeURIComponent(sessionId)}/restore`, { method: "POST" }));
}

export async function retryLiveRecordSync(sessionId: string): Promise<void> {
  await readEnvelope(await fetch(`/api/live-records/${encodeURIComponent(sessionId)}/sheet-sync/retry`, { method: "POST" }));
}

export async function fetchLiveRecordOriginals(sessionId: string, afterSourceSeq = 0, signal?: AbortSignal): Promise<AuthoritativeTranscriptPage & { recordingGaps: RecordingGap[] }> {
  const params = new URLSearchParams({ afterSourceSeq: String(afterSourceSeq), pageSize: "50" });
  const data = await readEnvelope(await fetch(`/api/live-records/${encodeURIComponent(sessionId)}/transcript?${params}`, { cache: "no-store", signal }));
  if (!isRecord(data.transcript) || !Array.isArray(data.transcript.items)
    || typeof data.transcript.hasNextPage !== "boolean"
    || !(data.transcript.nextAfterSourceSeq === null || Number.isSafeInteger(data.transcript.nextAfterSourceSeq))) {
    throw new Error("원문 기록을 확인할 수 없습니다.");
  }
  const gaps = recordingGapsSchema.safeParse({ recordingGaps: data.transcript.recordingGaps });
  if (!gaps.success) {
    throw new Error("원문의 기록 구간을 확인할 수 없습니다.");
  }
  return { ...data.transcript as unknown as AuthoritativeTranscriptPage, recordingGaps: gaps.data.recordingGaps };
}

export async function fetchLiveRecordRecipients(sessionId: string, signal?: AbortSignal): Promise<HostRecapRequest[]> {
  const data = await readEnvelope(await fetch(`/api/live-records/${encodeURIComponent(sessionId)}/recipients`, { cache: "no-store", signal }));
  const parsed = recapRecipientsSchema.safeParse(data);
  if (!parsed.success) throw new Error("수신 신청자 명단을 확인할 수 없습니다.");
  return parsed.data.requests;
}

export async function fetchLiveRecordExport(sessionId: string): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch(`/api/live-records/${encodeURIComponent(sessionId)}/export`, { cache: "no-store" });
  if (!response.ok) {
    await readEnvelope(response);
    throw new Error("Excel 파일을 준비하지 못했습니다.");
  }
  if (!response.headers.get("Content-Type")?.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) {
    throw new Error("Excel 파일을 확인할 수 없습니다. 다시 시도해 주세요.");
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encodedName = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  const quotedName = /filename="([^"]+)"/iu.exec(disposition)?.[1];
  let fileName = quotedName || "라이브콜-전체기록.xlsx";
  if (encodedName) {
    try { fileName = decodeURIComponent(encodedName); }
    catch { throw new Error("Excel 파일 이름을 확인할 수 없습니다."); }
  }
  fileName = fileName.replace(/[\\/\u0000-\u001f\u007f]/gu, "_");
  return { blob: await response.blob(), fileName };
}
