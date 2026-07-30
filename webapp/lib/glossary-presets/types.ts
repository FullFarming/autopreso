import type { CreateGlossaryPresetInput } from "./schema";

export interface GlossaryPreset {
  id: string;
  name: string;
  domain: string;
  glossary: string;
  languagePair: CreateGlossaryPresetInput["languagePair"];
  version: number;
  updatedAt: string;
}
