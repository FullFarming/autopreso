// Task 2 replaces this stub with the real Soniox WebSocket adapter
// (STT provider contract over packages/caption-core/soniox-protocol.js).
// Even as a stub it must never expose the api key: options live in a private
// field so JSON.stringify / Object.values / logging cannot leak it.
export class SonioxRealtimeAdapter {
  #options;

  constructor(options) {
    this.provider = "soniox";
    this.#options = Object.freeze({ ...options });
  }

  get languageMode() { return this.#options.languageMode; }

  get translation() { return this.#options.translation === true; }

  async open() {
    throw new Error("SONIOX_ADAPTER_NOT_IMPLEMENTED");
  }
}
