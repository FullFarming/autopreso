// Task 2 replaces this stub with the real Soniox WebSocket adapter
// (STT provider contract over packages/caption-core/soniox-protocol.js).
export class SonioxRealtimeAdapter {
  constructor(options) {
    this.provider = "soniox";
    this.options = Object.freeze({ ...options });
  }

  async open() {
    throw new Error("SONIOX_ADAPTER_NOT_IMPLEMENTED");
  }
}
