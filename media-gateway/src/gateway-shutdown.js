// 2026-08-31 fix: keep cleanup inside Cloud Run's termination grace period.
// Cloud Run allows 10 seconds between SIGTERM and SIGKILL; leave two seconds
// for process teardown after the existing gateway cleanup finishes or stalls.
// https://docs.cloud.google.com/run/docs/container-contract#instance-shutdown
const SHUTDOWN_TIMEOUT_MILLISECONDS = 8_000;

export function installGatewayShutdown(gateway, processRef = process) {
  let isClosing = false;
  let hasExited = false;
  let deadline;

  function finish(exitCode, safeErrorCode) {
    if (hasExited) return;
    hasExited = true;
    clearTimeout(deadline);
    processRef.removeListener("SIGTERM", shutdown);
    processRef.removeListener("SIGINT", shutdown);
    try {
      if (safeErrorCode) processRef.stderr.write(`${safeErrorCode}\n`);
    } finally {
      processRef.exit(exitCode);
    }
  }

  function shutdown() {
    if (isClosing) return;
    isClosing = true;
    deadline = setTimeout(() => finish(1, "MEDIA_GATEWAY_SHUTDOWN_TIMEOUT"), SHUTDOWN_TIMEOUT_MILLISECONDS);
    Promise.resolve().then(() => gateway.close()).then(
      () => finish(0),
      () => finish(1, "MEDIA_GATEWAY_SHUTDOWN_FAILED"),
    );
  }

  processRef.on("SIGTERM", shutdown);
  processRef.on("SIGINT", shutdown);
}
