import assert from "node:assert/strict";
import test from "node:test";

import { deriveSessionAdmissionCode } from "./admission-code";

test("session admission code is fixed for one session generation", async () => {
  const first = await deriveSessionAdmissionCode(
    "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
    0,
    "test-pepper",
  );
  const retry = await deriveSessionAdmissionCode(
    "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
    0,
    "test-pepper",
  );
  assert.match(first, /^\d{6}$/u);
  assert.equal(retry, first);
});

test("session admission code is domain-separated by session and generation", async () => {
  const base = await deriveSessionAdmissionCode(
    "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
    0,
    "test-pepper",
  );
  const nextSession = await deriveSessionAdmissionCode(
    "0192d0f4-9f72-7a36-91f5-6a76ef736f42",
    0,
    "test-pepper",
  );
  const nextGeneration = await deriveSessionAdmissionCode(
    "0192d0f4-9f72-7a36-91f5-6a76ef736f41",
    1,
    "test-pepper",
  );
  assert.notEqual(nextSession, base);
  assert.notEqual(nextGeneration, base);
});

test("session admission code rejects unsafe generations", async () => {
  await assert.rejects(
    deriveSessionAdmissionCode("0192d0f4-9f72-7a36-91f5-6a76ef736f41", -1, "test-pepper"),
    /generation/u,
  );
});
