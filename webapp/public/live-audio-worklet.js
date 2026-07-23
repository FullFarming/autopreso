class LivePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.outputSamples = [];
    this.phase = 0;
    this.preRoll = [];
    this.isGateOpen = false;
    this.silentChunks = 0;
    this.sentStreamEnd = false;
  }

  emitChunk(samples) {
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    const rms = Math.sqrt(energy / samples.length);
    const hasVoice = rms >= 0.015;
    if (hasVoice) {
      if (!this.isGateOpen) {
        this.isGateOpen = true;
        for (const chunk of this.preRoll) this.postChunk(chunk);
        this.preRoll = [];
      }
      this.silentChunks = 0;
      this.sentStreamEnd = false;
    } else {
      this.silentChunks += 1;
    }

    if (this.isGateOpen) {
      if (this.silentChunks <= 15) this.postChunk(samples);
      if (this.silentChunks >= 25) {
        this.isGateOpen = false;
        if (!this.sentStreamEnd) {
          this.port.postMessage({ type: "audioStreamEnd" });
          this.sentStreamEnd = true;
        }
      }
      return;
    }

    this.preRoll.push(samples.slice());
    if (this.preRoll.length > 8) this.preRoll.shift();
  }

  postChunk(samples) {
    const pcm = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      pcm[index] = sample < 0 ? sample * 32768 : sample * 32767;
    }
    this.port.postMessage({ type: "chunk", recordedAt: Date.now(), pcm: pcm.buffer }, [pcm.buffer]);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;
    const ratio = sampleRate / 16000;
    while (this.phase < input.length) {
      const left = Math.floor(this.phase);
      const right = Math.min(input.length - 1, left + 1);
      const mix = this.phase - left;
      this.outputSamples.push(input[left] + (input[right] - input[left]) * mix);
      this.phase += ratio;
    }
    this.phase -= input.length;
    while (this.outputSamples.length >= 640) {
      this.emitChunk(this.outputSamples.splice(0, 640));
    }
    return true;
  }
}

registerProcessor("live-pcm-processor", LivePcmProcessor);
