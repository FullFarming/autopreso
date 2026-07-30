// Security owns the only validation truth source. This module keeps domain
// imports stable without defining a second, drifting zod contract.
export {
  createGlossaryPresetInputSchema,
  deleteGlossaryPresetBodySchema,
  glossaryPresetIdSchema,
  MAX_GLOSSARY_PRESET_DOMAIN_CHARS,
  MAX_GLOSSARY_PRESET_GLOSSARY_CHARS,
  MAX_GLOSSARY_PRESET_NAME_CHARS,
  MAX_GLOSSARY_PRESETS_PER_HOST,
  updateGlossaryPresetBodySchema,
  type CreateGlossaryPresetInput,
  type DeleteGlossaryPresetBody,
  type UpdateGlossaryPresetBody,
} from "../security/host-glossary-preset-validation";
