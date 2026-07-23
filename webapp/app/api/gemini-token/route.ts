import { apiError } from "@/lib/security/api-response";

export async function POST() {
  return apiError(
    "브라우저용 Gemini 장기 키 발급은 종료되었습니다. 라이브 게이트웨이를 사용해 주세요.",
    "DIRECT_GEMINI_KEY_DISABLED",
    410,
  );
}
