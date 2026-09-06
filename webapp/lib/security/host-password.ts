import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { isKnownInsecureSecret } from "./config";

const HASH_PREFIX = "scrypt-v1";
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const HASH_PATTERN = /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/u;

/** @throws 비밀번호 해시 설정의 형식이나 버전이 유효하지 않을 때. */
export function assertValidHostPasswordHash(passwordHash: string): void {
  if (passwordHash.length !== 171 || !HASH_PATTERN.test(passwordHash)) {
    throw new Error("호스트 비밀번호 해시 설정이 올바르지 않습니다.");
  }
}

function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** @throws 비밀번호 정책을 만족하지 않거나 키 유도에 실패했을 때. */
export async function createHostPasswordHash(password: string): Promise<string> {
  if (password.length < 10 || password.length > 256 || password.includes("\0") || isKnownInsecureSecret(password)) {
    throw new Error("호스트 비밀번호는 10~256자의 안전한 값이어야 합니다.");
  }
  const salt = randomBytes(16);
  const key = await derivePasswordKey(password, salt);
  return `${HASH_PREFIX}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** @throws 해시 설정이 유효하지 않거나 키 유도에 실패했을 때. */
export async function verifyHostPassword(password: string, passwordHash: string): Promise<boolean> {
  assertValidHostPasswordHash(passwordHash);
  // 2026-08-31 fix: scrypt's HMAC padding can equate short passwords with NUL suffixes.
  if (password.length < 1 || password.length > 256 || password.includes("\0")) return false;
  const [, saltHex, keyHex] = passwordHash.split("$");
  const key = await derivePasswordKey(password, Buffer.from(saltHex, "hex"));
  return timingSafeEqual(key, Buffer.from(keyHex, "hex"));
}
