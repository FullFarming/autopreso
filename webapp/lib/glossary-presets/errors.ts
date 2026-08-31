import { LiveSecurityConfigurationError } from "../security/config";

export type GlossaryPresetErrorCode =
  | "INVALID_GLOSSARY_PRESET"
  | "INVALID_GLOSSARY_DOCUMENT"
  | "GLOSSARY_PRESET_LIMIT_REACHED"
  | "GLOSSARY_VERSION_LIMIT_REACHED"
  | "GLOSSARY_PRESET_NAME_CONFLICT"
  | "GLOSSARY_PRESET_VERSION_CONFLICT"
  | "GLOSSARY_PRESET_NOT_FOUND"
  | "GLOSSARY_PRESET_IN_USE"
  | "GLOSSARY_DOCUMENT_VERSION_NOT_FOUND"
  | "GLOSSARY_DOCUMENT_FINGERPRINT_CONFLICT"
  | "NETWORK_UNAVAILABLE";

export class GlossaryPresetError extends Error {
  readonly code: GlossaryPresetErrorCode;
  readonly status: number;

  constructor(
    message: string,
    code: GlossaryPresetErrorCode,
    status: number,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function toGlossaryPresetFailure(error: unknown): {
  message: string;
  code: GlossaryPresetErrorCode;
  status: number;
} {
  if (error instanceof GlossaryPresetError) {
    return { message: error.message, code: error.code, status: error.status };
  }
  if (error instanceof LiveSecurityConfigurationError) {
    return { message: "용어집 동기화 서버에 연결할 수 없습니다.", code: "NETWORK_UNAVAILABLE", status: 503 };
  }
  return { message: "용어집을 동기화할 수 없습니다.", code: "NETWORK_UNAVAILABLE", status: 503 };
}
