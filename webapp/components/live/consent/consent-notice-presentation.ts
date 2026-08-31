import type { ConsentNoticePresentation } from "./ParticipantConsentFields";

export const PARTICIPANT_CONSENT_NOTICES = {
  privacy: {
    version: "privacy-v1",
    text: "세션 참여, 본인 확인, 자막 제공을 위해 입력 정보를 처리합니다.",
  },
  summaryDelivery: {
    version: "summary-delivery-v1",
    text: "완성된 세션 요약을 입력한 이메일로 전달하기 위한 선택 동의입니다.",
  },
  marketing: {
    version: "marketing-v1",
    text: "서비스 소식과 안내를 받기 위한 선택 동의입니다.",
  },
} as const satisfies Record<string, ConsentNoticePresentation>;
