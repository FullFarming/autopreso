import { validateGlossaryDocumentV1 } from "../../../packages/caption-core/index.js";

import { GlossaryPresetError } from "./errors";
import { SupabaseGlossaryPresetStore, type GlossaryPresetStore } from "./store";
import type {
  ActivatedGlossaryDocumentVersion,
  GlossaryDocumentRecord,
  GlossaryDocumentV1,
  GlossaryDocumentVersion,
  GlossaryPreset,
  SavedGlossaryDocumentVersion,
} from "./types";

export interface ValidatedGlossaryDocument {
  readonly document: GlossaryDocumentV1;
  readonly fingerprint: string;
}

export class GlossaryPresetService {
  private readonly store: GlossaryPresetStore;
  private readonly now: () => number;

  constructor(
    store: GlossaryPresetStore,
    now: () => number = Date.now,
  ) {
    this.store = store;
    this.now = now;
  }

  list(hostId: string): Promise<GlossaryPreset[]> {
    return this.store.list(hostId);
  }

  validate(input: unknown): ValidatedGlossaryDocument {
    const result = validateGlossaryDocumentV1(input);
    if (!result.ok) throw invalidDocument();
    return {
      document: result.document,
      fingerprint: result.fingerprint,
    };
  }

  async create(hostId: string, input: unknown): Promise<GlossaryPreset> {
    const validated = this.validate(input);
    try {
      return await this.store.create(hostId, validated.document, validated.fingerprint);
    } catch (error) {
      if (!isGlossaryError(error, "GLOSSARY_PRESET_NAME_CONFLICT")) throw error;
      const existing = (await this.store.list(hostId)).find((preset) => (
        preset.name === validated.document.name
        && preset.activeDocumentFingerprint === validated.fingerprint
      ));
      if (existing) return existing;
      throw error;
    }
  }

  listVersions(hostId: string, presetId: string): Promise<GlossaryDocumentVersion[]> {
    return this.store.listVersions(hostId, presetId);
  }

  async exportVersion(hostId: string, presetId: string, version: number): Promise<GlossaryDocumentRecord> {
    const record = await this.store.readVersion(hostId, presetId, version);
    if (!record) throw versionNotFound();
    return record;
  }

  async saveVersion(
    hostId: string,
    presetId: string,
    expectedPresetVersion: number,
    input: unknown,
  ): Promise<SavedGlossaryDocumentVersion> {
    const validated = this.validate(input);
    try {
      return await this.store.saveVersion(
        hostId,
        presetId,
        expectedPresetVersion,
        validated.document,
        validated.fingerprint,
      );
    } catch (error) {
      if (!isGlossaryError(error, "GLOSSARY_DOCUMENT_FINGERPRINT_CONFLICT")
        && !isGlossaryError(error, "GLOSSARY_PRESET_VERSION_CONFLICT")) throw error;
      const [presets, versions] = await Promise.all([
        this.store.list(hostId),
        this.store.listVersions(hostId, presetId),
      ]);
      const preset = presets.find((candidate) => candidate.id === presetId);
      const existing = versions.find((candidate) => candidate.fingerprint === validated.fingerprint);
      if (preset && existing) return { ...existing, presetVersion: preset.version };
      throw error;
    }
  }

  async activateVersion(
    hostId: string,
    presetId: string,
    expectedPresetVersion: number,
    documentVersion: number,
  ): Promise<ActivatedGlossaryDocumentVersion> {
    try {
      return await this.store.activateVersion(hostId, presetId, expectedPresetVersion, documentVersion);
    } catch (error) {
      if (!isGlossaryError(error, "GLOSSARY_PRESET_VERSION_CONFLICT")) throw error;
      const preset = (await this.store.list(hostId)).find((candidate) => candidate.id === presetId);
      if (!preset || preset.activeDocumentVersion !== documentVersion || !preset.activeDocumentFingerprint) throw error;
      return {
        presetId,
        presetVersion: preset.version,
        activeDocumentVersion: documentVersion,
        activeDocumentFingerprint: preset.activeDocumentFingerprint,
        updatedAt: preset.updatedAt,
      };
    }
  }

  async duplicate(
    hostId: string,
    sourcePresetId: string,
    sourceDocumentVersion: number,
    name: string,
  ): Promise<GlossaryPreset> {
    const source = await this.store.readVersion(hostId, sourcePresetId, sourceDocumentVersion);
    if (!source) throw versionNotFound();
    const timestamp = new Date(this.now()).toISOString();
    const duplicate = this.validate({
      ...source.document,
      name,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.store.create(hostId, duplicate.document, duplicate.fingerprint);
  }

  async delete(hostId: string, presetId: string, expectedPresetVersion: number): Promise<string> {
    if (await this.store.delete(presetId, hostId, expectedPresetVersion)) return presetId;
    throw new GlossaryPresetError("용어집을 삭제할 수 없습니다.", "GLOSSARY_PRESET_VERSION_CONFLICT", 409);
  }
}

export function getGlossaryPresetService(): GlossaryPresetService {
  return new GlossaryPresetService(new SupabaseGlossaryPresetStore());
}

function invalidDocument(): GlossaryPresetError {
  return new GlossaryPresetError("용어집 내용이 올바르지 않습니다.", "INVALID_GLOSSARY_DOCUMENT", 400);
}

function versionNotFound(): GlossaryPresetError {
  return new GlossaryPresetError("용어집 버전을 찾을 수 없습니다.", "GLOSSARY_DOCUMENT_VERSION_NOT_FOUND", 404);
}

function isGlossaryError(error: unknown, code: string): error is GlossaryPresetError {
  return error instanceof GlossaryPresetError && error.code === code;
}
