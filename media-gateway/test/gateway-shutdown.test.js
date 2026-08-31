import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { installGatewayShutdown } from "../src/gateway-shutdown.js";

function fakeProcess() {
  const processRef = new EventEmitter();
  const exits = [];
  const errors = [];
  processRef.exit = (code) => { exits.push(code); };
  processRef.stderr = { write: (message) => { errors.push(message); } };
  return { processRef, exits, errors };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} closes the gateway once and exits successfully only after cleanup`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const processState = fakeProcess();
    const closeResult = deferred();
    let closeCount = 0;
    installGatewayShutdown({ close() { closeCount += 1; return closeResult.promise; } }, processState.processRef);
    processState.processRef.emit(signal);
    processState.processRef.emit("SIGTERM");
    processState.processRef.emit("SIGINT");
    await flushPromises();
    assert.equal(closeCount, 1);
    assert.deepEqual(processState.exits, []);
    closeResult.resolve();
    await flushPromises();
    assert.deepEqual(processState.exits, [0]);
    assert.deepEqual(processState.errors, []);
    context.mock.timers.tick(10_000);
    processState.processRef.emit(signal);
    assert.deepEqual(processState.exits, [0]);
  });
}

for (const lateOutcome of ["resolve", "reject"]) {
  test(`eight-second timeout wins over a late close ${lateOutcome}`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const processState = fakeProcess();
    const closeResult = deferred();
    installGatewayShutdown({ close: () => closeResult.promise }, processState.processRef);
    processState.processRef.emit("SIGTERM");
    await flushPromises();
    context.mock.timers.tick(7_999);
    assert.deepEqual(processState.exits, []);
    context.mock.timers.tick(1);
    assert.deepEqual(processState.exits, [1]);
    assert.deepEqual(processState.errors, ["MEDIA_GATEWAY_SHUTDOWN_TIMEOUT\n"]);
    closeResult[lateOutcome](new Error("sensitive-audio-and-token"));
    await flushPromises();
    processState.processRef.emit("SIGINT");
    assert.deepEqual(processState.exits, [1]);
    assert.deepEqual(processState.errors, ["MEDIA_GATEWAY_SHUTDOWN_TIMEOUT\n"]);
  });
}

for (const isSynchronous of [false, true]) {
  test(`close ${isSynchronous ? "throw" : "rejection"} exits once with a fixed safe error code`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const processState = fakeProcess();
    installGatewayShutdown({ close() {
      const failure = new Error("PRIVATE_TRANSCRIPT apiKey=secret-value");
      if (isSynchronous) throw failure;
      return Promise.reject(failure);
    } }, processState.processRef);
    processState.processRef.emit("SIGINT");
    await flushPromises();
    assert.deepEqual(processState.exits, [1]);
    assert.deepEqual(processState.errors, ["MEDIA_GATEWAY_SHUTDOWN_FAILED\n"]);
    context.mock.timers.tick(8_000);
    assert.deepEqual(processState.exits, [1]);
  });
}

test("entrypoint installs cleanup without invoking any meeting-stop transition", async () => {
  const entrypoint = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const shutdown = await readFile(new URL("../src/gateway-shutdown.js", import.meta.url), "utf8");
  assert.match(entrypoint, /startMediaGateway\(\)\.then\(\(gateway\) => \{\s*installGatewayShutdown\(gateway\)/u);
  assert.doesNotMatch(shutdown, /setSessionStatus|markStopped|\.stop\(|"stopped"/u);
});
