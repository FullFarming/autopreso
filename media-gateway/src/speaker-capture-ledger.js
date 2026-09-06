const unresolved = () => ({ floor: null, speakerProfile: null, unresolved: true });

// 2026-09-05 fix: Provider completion time is unrelated to who owned captured PCM.
// Retain immutable identity intervals; missing/ambiguous bounds never select the current person.
export class SpeakerCaptureLedger {
  #epochs = [];
  #offset = 0;

  capture(duration, attribution) {
    const snapshot = structuredClone({ floor: attribution.floor ?? null, speakerProfile: attribution.speakerProfile ?? null, unresolved: attribution.unresolved === true });
    const key = JSON.stringify(snapshot);
    const previous = this.#epochs.at(-1);
    if (previous?.key === key) previous.end += duration;
    else this.#epochs.push({ start: this.#offset, end: this.#offset + duration, key, snapshot });
    this.#offset += duration;
    if (this.#epochs.length > 4096) this.#epochs.shift();
  }

  resolve(utterance) {
    const onset = utterance.sourceSessionStartOffsetMs;
    const hasOnset = Number.isFinite(onset) && onset >= 0;
    const start = hasOnset ? onset : utterance.sourceGenerationStartOffsetMs ?? 0;
    const end = Number.isFinite(utterance.sourceSessionEndOffsetMs)
      ? utterance.sourceSessionEndOffsetMs : Number.isFinite(utterance.sourceGenerationEndOffsetMs) ? utterance.sourceGenerationEndOffsetMs : this.#offset;
    if (!Number.isFinite(start) || start < 0 || end <= start || end > this.#offset + 1) return unresolved();
    const epochs = this.#epochs.filter((epoch) => epoch.end > start && epoch.start < end);
    if (!epochs.length || epochs[0].start > start || epochs.at(-1).end < end
      || epochs.some((epoch) => epoch.key !== epochs[0].key)) return unresolved();
    if (epochs[0].snapshot.unresolved) return unresolved();
    return { ...structuredClone(epochs[0].snapshot) };
  }
}
