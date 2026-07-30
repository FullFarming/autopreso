import { GlossaryPresetError } from "./errors";
import { MAX_GLOSSARY_PRESETS_PER_HOST, type CreateGlossaryPresetInput } from "./schema";
import { SupabaseGlossaryPresetStore, type GlossaryPresetStore } from "./store";
import type { GlossaryPreset } from "./types";

export class GlossaryPresetService {
  private readonly store: GlossaryPresetStore;

  constructor(store: GlossaryPresetStore) {
    this.store = store;
  }

  list(hostId: string): Promise<GlossaryPreset[]> {
    return this.store.list(hostId);
  }

  async create(hostId: string, input: CreateGlossaryPresetInput): Promise<GlossaryPreset> {
    const current = await this.store.list(hostId);
    if (current.length >= MAX_GLOSSARY_PRESETS_PER_HOST) {
      throw new GlossaryPresetError("용어집은 최대 50개까지 저장할 수 있습니다.", "GLOSSARY_PRESET_LIMIT_REACHED", 409);
    }
    assertNameAvailable(current, input.name);
    return this.store.create(hostId, input);
  }

  async update(
    hostId: string,
    id: string,
    expectedVersion: number,
    input: CreateGlossaryPresetInput,
  ): Promise<GlossaryPreset> {
    const current = await this.store.list(hostId);
    const existing = current.find((preset) => preset.id === id);
    if (!existing) throw notFound();
    if (existing.version !== expectedVersion) throw versionConflict();
    assertNameAvailable(current, input.name, id);
    const updated = await this.store.update(id, hostId, expectedVersion, input);
    if (updated) return updated;
    return this.classifyMutationMiss(hostId, id, expectedVersion);
  }

  async delete(hostId: string, id: string, expectedVersion: number): Promise<string> {
    const current = await this.store.list(hostId);
    const existing = current.find((preset) => preset.id === id);
    if (!existing) throw notFound();
    if (existing.version !== expectedVersion) throw versionConflict();
    if (await this.store.delete(id, hostId, expectedVersion)) return id;
    return this.classifyMutationMiss(hostId, id, expectedVersion);
  }

  private async classifyMutationMiss(hostId: string, id: string, expectedVersion: number): Promise<never> {
    const current = (await this.store.list(hostId)).find((preset) => preset.id === id);
    if (!current) throw notFound();
    if (current.version !== expectedVersion) throw versionConflict();
    throw new GlossaryPresetError("용어집을 변경할 수 없습니다.", "GLOSSARY_PRESET_VERSION_CONFLICT", 409);
  }
}

export function getGlossaryPresetService(): GlossaryPresetService {
  return new GlossaryPresetService(new SupabaseGlossaryPresetStore());
}

function assertNameAvailable(presets: GlossaryPreset[], name: string, excludedId?: string): void {
  const normalized = name.normalize("NFC").toLocaleLowerCase("en-US");
  if (presets.some((preset) => preset.id !== excludedId
    && preset.name.normalize("NFC").toLocaleLowerCase("en-US") === normalized)) {
    throw new GlossaryPresetError("같은 이름의 용어집이 이미 있습니다.", "GLOSSARY_PRESET_NAME_CONFLICT", 409);
  }
}

function notFound(): GlossaryPresetError {
  return new GlossaryPresetError("용어집을 찾을 수 없습니다.", "GLOSSARY_PRESET_NOT_FOUND", 404);
}

function versionConflict(): GlossaryPresetError {
  return new GlossaryPresetError("용어집이 다른 곳에서 변경되었습니다. 다시 불러오세요.", "GLOSSARY_PRESET_VERSION_CONFLICT", 409);
}
