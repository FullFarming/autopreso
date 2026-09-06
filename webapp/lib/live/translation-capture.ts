import { z } from "zod";

// This describes the accepted audio window, never a sentence-to-source match.
export const translationCaptureSchema = z.object({
  kind: z.literal("independent-live-translation"),
  streamGeneration: z.string().uuid(),
  captureEpoch: z.string().uuid(),
  captureStartedAt: z.string().datetime().nullable(),
  captureEndedAt: z.string().datetime(),
  finalization: z.literal("application-sentence-boundary"),
}).strict().refine((value) => value.captureStartedAt === null
  || Date.parse(value.captureStartedAt) <= Date.parse(value.captureEndedAt));

export type TranslationCapture = z.infer<typeof translationCaptureSchema>;
export function readTranslationCapture(value: unknown): TranslationCapture | undefined {
  const result = translationCaptureSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export interface CaptionTranslationCaptureInput {
  translationCapture?: unknown;
  translationStatus?: unknown;
  sourceText?: unknown;
  sourceLanguage?: unknown;
  sourceStartedAt?: unknown;
  origin?: unknown;
  authoritativeSourceId?: unknown;
  languageObservation?: unknown;
}

/** Independent audio capture cannot also claim an authoritative source sentence. */
export function hasValidTranslationCaptureProvenance(caption: CaptionTranslationCaptureInput): boolean {
  if (caption.translationCapture === undefined) return true;
  return readTranslationCapture(caption.translationCapture) !== undefined
    && caption.translationStatus === "translated"
    && [caption.sourceText, caption.sourceLanguage, caption.sourceStartedAt,
      caption.origin, caption.authoritativeSourceId, caption.languageObservation].every(value => value == null);
}
