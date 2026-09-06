/** @param {import("ws").WebSocket | {readyState:number, send:Function, on:Function, once:Function, off:Function}} socket */
export function requestLiveGatewayDrain(socket, sessionId, timeoutMilliseconds = 12_000) {
  if (socket.readyState !== 1) return Promise.resolve({ ok: false, code: "MEDIA_DRAIN_FAILED" });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      resolve(result);
    };
    const onMessage = (data) => {
      let message;
      try { message = JSON.parse(data.toString("utf8")); } catch { return; }
      if (message?.type === "drained" && message.sessionId === sessionId) finish({ ok: true });
      else if (message?.type === "error") finish({ ok: false, code: "MEDIA_DRAIN_FAILED" });
    };
    const onClose = () => finish({ ok: false, code: "MEDIA_DRAIN_FAILED" });
    const timer = setTimeout(() => finish({ ok: false, code: "MEDIA_DRAIN_TIMEOUT" }), timeoutMilliseconds);
    socket.on("message", onMessage);
    socket.once("close", onClose);
    try { socket.send(JSON.stringify({ type: "drain", sessionId })); } catch { onClose(); }
  });
}
