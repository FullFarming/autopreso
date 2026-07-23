import { apiError } from "@/lib/security/api-response";

export function OPTIONS() {
  return new Response(null, { status: 410 });
}

export async function GET() {
  return apiError(
    "API 키 동기화 기능은 종료되었습니다. 서버 게이트웨이를 사용해 주세요.",
    "PAIR_KEY_SYNC_DISABLED",
    410,
  );
}
