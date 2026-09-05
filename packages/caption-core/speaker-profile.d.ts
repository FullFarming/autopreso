export interface SpeakerProfile {
  readonly id: string;
  readonly version: number;
  readonly displayName: string;
  readonly company: string;
  readonly department: string;
  readonly photoAssetId: string | null;
}
/** @throws {TypeError} Invalid identity, version, or bounded profile text. */
export function normalizeSpeakerProfile(value: unknown): Readonly<SpeakerProfile>;
/** @throws {TypeError} Invalid session or photo identity. */
export function buildSpeakerPhotoUrl(sessionId: string, photoAssetId: string): string;
