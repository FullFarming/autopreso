import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { readHostLoginConfig } from "./host-login-config";
import { createHostPasswordHash, verifyHostPassword } from "./host-password";

test("salted host password hashes verify the exact password and reject a different one", async () => {
  const password = randomBytes(24).toString("base64url");
  const passwordHash = await createHostPasswordHash(password);
  const otherHash = await createHostPasswordHash(password);
  assert.match(passwordHash, /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/u);
  assert.notEqual(passwordHash, otherHash);
  assert.equal(await verifyHostPassword(password, passwordHash), true);
  assert.equal(await verifyHostPassword(`${password}!`, passwordHash), false);
  assert.equal(await verifyHostPassword(`${password}\0`, passwordHash), false);
});

test("a configured hash enables login without retaining or accepting a legacy plaintext password", async () => {
  const password = randomBytes(24).toString("base64url");
  const passwordHash = await createHostPasswordHash(password);
  const legacyPassword = randomBytes(24).toString("base64url");
  const config = readHostLoginConfig({
    NODE_ENV: "production",
    ADMIN_USER_IDS: "test-admin",
    ADMIN_PASSWORD: legacyPassword,
    ADMIN_PASSWORD_HASH: passwordHash,
  });
  assert.equal(config.isEnabled, true);
  assert.equal(config.userIds.has("test-admin"), true);
  assert.equal(config.password, "");
  assert.equal(config.passwordHash, passwordHash);
  assert.equal(await verifyHostPassword(password, passwordHash), true);
  assert.equal(await verifyHostPassword(legacyPassword, passwordHash), false);
  assert.equal(readHostLoginConfig({
    NODE_ENV: "production",
    ADMIN_USER_IDS: "test-admin",
    ADMIN_PASSWORD_HASH: passwordHash,
  }).isEnabled, true);
});

test("malformed configured hashes fail closed even when legacy credentials are valid", async () => {
  const invalidHashes = ["", " ", "scrypt-v1", `scrypt-v1$${"0".repeat(32)}$${"g".repeat(128)}`,
    `scrypt-v2$${"0".repeat(32)}$${"a".repeat(128)}`, `scrypt-v1$${"0".repeat(32)}$${"a".repeat(128)}\n`];
  for (const passwordHash of invalidHashes) {
    assert.throws(() => readHostLoginConfig({
      NODE_ENV: "development",
      ADMIN_USER_IDS: "test-admin",
      ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
      ADMIN_PASSWORD_HASH: passwordHash,
    }), /비밀번호 해시/u);
    await assert.rejects(verifyHostPassword("invalid-test-input", passwordHash), /비밀번호 해시/u);
  }
});

test("a valid hash still requires an explicit user allowlist", async () => {
  const passwordHash = await createHostPasswordHash(randomBytes(24).toString("base64url"));
  assert.deepEqual(readHostLoginConfig({ NODE_ENV: "development", ADMIN_PASSWORD_HASH: passwordHash }), {
    isEnabled: false, password: "", userIds: new Set<string>(),
  });
  assert.throws(() => readHostLoginConfig({ NODE_ENV: "production", ADMIN_PASSWORD_HASH: passwordHash }), /강한 호스트 로그인/u);
});

test("hash generation rejects passwords outside the existing configured policy", async () => {
  for (const password of ["", "short", "replace-with-a-long-password", "x".repeat(257), `${"x".repeat(20)}\0`]) {
    await assert.rejects(createHostPasswordHash(password), /비밀번호/u);
  }
});
