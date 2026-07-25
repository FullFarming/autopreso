import { hmacHex } from "../security/hmac";

const ADMISSION_CODE_SPACE = 1_000_000n;

export async function deriveSessionAdmissionCode(
  sessionId: string,
  generation: number,
  pepper: string,
): Promise<string> {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("admission generation must be a non-negative safe integer");
  }
  const digest = await hmacHex(
    pepper,
    `session-admission-code\0${sessionId}\0${generation}`,
  );
  const numericCode = BigInt(`0x${digest.slice(0, 16)}`) % ADMISSION_CODE_SPACE;
  return numericCode.toString().padStart(6, "0");
}
