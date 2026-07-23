import { apiError } from "@/lib/security/api-response";

export function OPTIONS() {
  return new Response(null, { status: 410 });
}

export async function POST() {
  return apiError(
    "기존 QR 페어링 로그인은 종료되었습니다.",
    "PAIRING_DISABLED",
    410,
  );
}
