import type { AuthoritativeTranscriptItem, LiveRecordParticipant, LiveRecordSelectedSummary } from "@/lib/live-records/service";
import { RECAP_NOTICE_VERSION, type HostRecapRequest, type RecordExportSnapshot, type RecordingGap } from "@/lib/live-recap/contract";
import type { LiveRecordDetailPresentation } from "../live-record-types";

const sessionId = "10000000-0000-4000-8000-000000000001";
const fixtureId = (index: number) => `20000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const names = ["김민지", "이준호", "박서연", "최현우", "정수빈", "오지훈", "한지우", "윤서진", "강유진"];
const companies = ["한빛투자", "미래증권", "세움자산운용", "라온리서치", "이음파트너스"];
const consent = { accepted: true, decidedAt: "2026-08-31T05:02:00.000Z", noticeVersion: RECAP_NOTICE_VERSION };

export const demoParticipants: LiveRecordParticipant[] = Array.from({ length: 45 }, (_, index) => ({
  participantId: fixtureId(index + 1), displayName: `${names[index % names.length]}${index >= names.length ? ` ${Math.floor(index / names.length) + 1}` : ""}`,
  email: `participant${index + 1}@example.com`, company: companies[index % companies.length], department: "리서치팀", jobTitle: "연구원",
  joinedAt: "2026-08-31T04:00:00.000Z", lastSeenAt: "2026-08-31T05:00:00.000Z", isPresent: false,
  summaryConsentAt: consent.decidedAt, utteranceCount: index % 3, speakingSeconds: index * 4, lastSpokeAt: null,
  consents: { privacy: consent, summaryDelivery: consent, marketing: { accepted: false, decidedAt: consent.decidedAt, noticeVersion: "marketing-v1" } },
}));

export const demoRequests: HostRecapRequest[] = demoParticipants.map((participant, index) => ({
  id: fixtureId(index + 101), sessionId, participantId: participant.participantId, displayName: participant.displayName,
  email: participant.email || "", company: participant.company, department: participant.department, jobTitle: participant.jobTitle,
  requestedAt: new Date(Date.parse("2026-08-31T05:02:00.000Z") + index * 60_000).toISOString(), noticeVersion: RECAP_NOTICE_VERSION,
  consentAcceptedAt: consent.decidedAt, cancelledAt: null, status: "requested", revision: 1,
}));

const sampleOriginals = [
  "오늘은 2026년 2분기 실적과 하반기 사업 계획을 공유하겠습니다.",
  "이번 분기에는 핵심 제품의 사용성과 고객 지원 경험을 개선하는 데 집중했습니다.",
  "고객의 실제 사용 흐름을 기준으로 우선순위를 정하고, 중요한 개선부터 단계적으로 적용했습니다.",
  "하반기에는 안정적인 서비스 운영과 해외 고객 지원을 함께 강화하겠습니다.",
  "이어서 참여자 여러분의 질문을 받겠습니다. 자세한 내용은 회의 원문에서도 확인하실 수 있습니다.",
];
export const demoOriginals: AuthoritativeTranscriptItem[] = Array.from({ length: 75 }, (_, index) => ({
  sourceUtteranceId: fixtureId(index + 201), sourceSeq: index + 1, utteranceKey: `demo-source-${index + 1}`,
  rawText: sampleOriginals[index % sampleOriginals.length], normalizedText: sampleOriginals[index % sampleOriginals.length],
  effectiveText: sampleOriginals[index % sampleOriginals.length], sourceLanguage: "ko", speakerRole: "host",
  speakerLabel: "진행자", speakerName: "김현우", speakerDepartment: "경영지원", speakerJobTitle: "담당자", participantId: null,
  sourceStartedAt: new Date(Date.parse("2026-08-31T04:00:00.000Z") + index * 30_000).toISOString(),
  sourceEndedAt: new Date(Date.parse("2026-08-31T04:00:15.000Z") + index * 30_000).toISOString(),
  providerCommittedAt: "2026-08-31T05:00:00.000Z", sttProvider: "local-demo", sttModel: null, translationModel: null,
  pipelineConfigFingerprint: null, glossaryFingerprint: null, correctionRevision: 0, correctedAt: null, translations: [],
}));

export const demoSummary: LiveRecordSelectedSummary = {
  language: "ko", createdAt: "2026-08-31T05:01:00.000Z", summary: {
    title: "2026년 2분기 실적 발표", overview: "핵심 제품의 사용성과 고객 지원 경험을 개선했습니다. 하반기에는 안정적인 운영과 해외 고객 지원을 강화합니다.",
    chapters: [{ title: "2분기 주요 성과", summary: "실제 고객 사용 흐름을 바탕으로 제품의 개선 우선순위를 정했습니다." },
      { title: "하반기 운영 계획", summary: "서비스 안정성과 다국어 고객 지원을 함께 강화하기로 했습니다." }],
    decisions: ["핵심 사용 흐름 개선을 우선합니다.", "해외 고객 지원 범위를 확대합니다."],
    actionItems: [{ description: "하반기 실행 계획을 공유합니다.", owner: "사업 담당자", due: "다음 정기 회의" }],
    speakerHighlights: [{ speaker: "김현우", highlight: "사용성과 안정성을 함께 높이는 데 집중하겠습니다." }],
    participationStats: [],
  },
};

export const demoRecordingGaps: RecordingGap[] = [{
  id: "40000000-0000-4000-8000-000000000001", startedAt: "2026-08-31T04:38:00.000Z",
  endedAt: "2026-08-31T04:41:00.000Z", reason: "no_viewers",
}];

export const demoRecord: LiveRecordDetailPresentation = {
  id: sessionId, title: demoSummary.summary.title, scheduledAt: "2026-08-31T04:00:00.000Z",
  status: { label: "종료", state: "ok" }, languages: ["ko"], participantCount: demoParticipants.length,
  summaryState: { label: "요약 완료", state: "ok" }, syncState: "disabled",
  lanes: [{ id: "translation:ko", language: "ko", kind: "translation", label: "한국어" }], topics: [], participants: [],
  syncMessage: "외부 동기화 없음 · 로컬 예시", deletedAt: null,
};

export const demoExportSnapshot: RecordExportSnapshot = {
  snapshotId: "30000000-0000-4000-8000-000000000001", generatedAt: "2026-08-31T06:00:00.000Z",
  session: { id: sessionId, title: demoRecord.title, status: "stopped", scheduledAt: demoRecord.scheduledAt, endedAt: "2026-08-31T05:00:00.000Z", languages: ["ko"] },
  participants: demoParticipants.map((participant) => ({ id: participant.participantId, displayName: participant.displayName,
    email: participant.email, company: participant.company, department: participant.department, jobTitle: participant.jobTitle, joinedAt: participant.joinedAt })),
  utterances: demoOriginals.map((item) => ({ id: item.sourceUtteranceId, seq: item.sourceSeq, speaker: item.speakerName || "진행자",
    language: item.sourceLanguage, startedAt: item.sourceStartedAt, endedAt: item.sourceEndedAt, text: item.effectiveText, topicTitle: null })),
  summaries: [{ language: "ko", status: "ready", createdAt: demoSummary.createdAt, summary: { ...demoSummary.summary } }],
  requests: demoRequests,
  recordingGaps: demoRecordingGaps,
};
