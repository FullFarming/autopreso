import { LiveRecordsError } from "../live-records/errors";
import { recapRequestInputSchema, type HostRecapRequest, type RecapRequest, type RecapRequestInput, type RecordExportSnapshot } from "./contract";

export interface LiveRecapStore {
  request(sessionId: string, userId: string, input: RecapRequestInput): Promise<RecapRequest>;
  readRequest(sessionId: string, userId: string): Promise<RecapRequest | null>;
  readRecipients(sessionId: string, hostId: string): Promise<{ requests: HostRecapRequest[] }>;
  readExportSnapshot(sessionId: string, hostId: string): Promise<RecordExportSnapshot>;
}

export class LiveRecapService {
  private readonly store: LiveRecapStore;

  constructor(store: LiveRecapStore) { this.store = store; }

  async request(sessionId: string, userId: string, input: unknown): Promise<RecapRequest> {
    const parsed = recapRequestInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new LiveRecordsError("수신 신청 안내를 확인한 뒤 다시 신청해 주세요.", "INVALID_RECAP_REQUEST", 400);
    }
    const request = await this.store.request(sessionId, userId, parsed.data);
    assertRequestSession(request, sessionId);
    return request;
  }

  async readRequest(sessionId: string, userId: string): Promise<RecapRequest | null> {
    const request = await this.store.readRequest(sessionId, userId);
    if (request) assertRequestSession(request, sessionId);
    return request;
  }

  async readRecipients(sessionId: string, hostId: string): Promise<{ requests: HostRecapRequest[] }> {
    const result = await this.store.readRecipients(sessionId, hostId);
    for (const request of result.requests) assertRequestSession(request, sessionId);
    return result;
  }

  async readExportSnapshot(sessionId: string, hostId: string): Promise<RecordExportSnapshot> {
    const snapshot = await this.store.readExportSnapshot(sessionId, hostId);
    if (snapshot.session.id !== sessionId) throw invalidRecord();
    let previousSeq = 0;
    const participantIds = new Set(snapshot.participants.map((participant) => participant.id));
    if (participantIds.size !== snapshot.participants.length
      || new Set(snapshot.utterances.map((utterance) => utterance.id)).size !== snapshot.utterances.length
      || new Set(snapshot.recordingGaps.map((gap) => gap.id)).size !== snapshot.recordingGaps.length
      || new Set(snapshot.requests.map((request) => request.id)).size !== snapshot.requests.length) throw invalidRecord();
    for (const utterance of snapshot.utterances) {
      if (utterance.seq <= previousSeq) throw invalidRecord();
      previousSeq = utterance.seq;
    }
    for (const request of snapshot.requests) {
      assertRequestSession(request, sessionId);
      if (!participantIds.has(request.participantId)) throw invalidRecord();
    }
    return snapshot;
  }
}

function assertRequestSession(request: RecapRequest, sessionId: string): void {
  if (request.sessionId !== sessionId) throw invalidRecord();
}

function invalidRecord(): LiveRecordsError {
  return new LiveRecordsError("회의 기록 응답을 확인할 수 없습니다.", "RECAP_INVALID_RESPONSE", 502);
}
