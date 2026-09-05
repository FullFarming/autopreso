import { EventEmitter } from "node:events";

/** A credential is issued only for this connection; closing while issuance is
 * pending must prevent a late provider connection from restarting capture. */
export function createManagedCaptionSocket({ url, provider, protocols = undefined, init = undefined, getCredential, createWebSocket }) {
  let upstream = null;
  let isClosed = false;
  let apiKey = "";
  const socket = Object.assign(new EventEmitter(), {
    send(payload, options = undefined) {
    if (isClosed || !upstream) throw new Error("CAPTION_SOCKET_NOT_READY");
    if (provider === "soniox" && typeof payload === "string" && payload) {
      const value = JSON.parse(payload);
      if (Object.hasOwn(value, "api_key")) payload = JSON.stringify({ ...value, api_key: apiKey });
    }
    upstream.send(payload, options);
    },
    close(code = 1000) {
    if (isClosed) return;
    isClosed = true;
    apiKey = "";
    if (upstream) upstream.close(code);
    else socket.emit("close", code, Buffer.alloc(0));
    },
    terminate() {
    if (isClosed) return;
    isClosed = true;
    apiKey = "";
    if (upstream) upstream.terminate?.();
    else socket.emit("close", 1006, Buffer.alloc(0));
    },
  });
  Object.defineProperties(socket, {
    readyState: { get: () => isClosed ? 3 : upstream?.readyState ?? 0 },
    bufferedAmount: { get: () => upstream?.bufferedAmount ?? 0 },
  });
  void Promise.resolve().then(() => isClosed ? null : getCredential()).then((credential) => {
    if (isClosed) return;
    if (typeof credential?.apiKey !== "string" || !credential.apiKey) throw new Error("CAPTION_CREDENTIAL_INVALID");
    apiKey = credential.apiKey;
    const endpoint = new URL(url);
    if (provider === "gemini") {
      endpoint.pathname = endpoint.pathname.replace(/\.BidiGenerateContent$/u, ".BidiGenerateContentConstrained");
      endpoint.searchParams.delete("key");
      endpoint.searchParams.set("access_token", apiKey);
    }
    upstream = createWebSocket(endpoint.toString(), protocols, init);
    for (const name of ["open", "message", "error", "close", "unexpected-response"]) {
      upstream.on(name, (...args) => {
        if (!isClosed || name === "close") socket.emit(name, ...args);
      });
    }
  }).catch(() => {
    if (isClosed) return;
    // Broker responses and tokenized URLs must never become renderer diagnostics.
    socket.emit("error", new Error("임시 자막 연결을 준비하지 못했습니다. 로그인과 연결 상태를 확인해 주세요."));
    socket.close(1006);
  });
  return socket;
}
