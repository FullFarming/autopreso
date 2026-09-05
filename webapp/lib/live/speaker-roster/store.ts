import { z } from "zod";
import { getLiveStoreConfig, type LiveStoreConfig } from "../config";
import { LiveSessionError } from "../errors";
import { supabaseAdminHeaders } from "../../security/supabase-server-access";
import { speakerRosterStateSchema, type SpeakerRosterReplace, type SpeakerRosterState } from "./validation";

export interface SpeakerPhoto { contentType: "image/webp"; bytesBase64: string }
export interface SpeakerRosterStore {
  get(sessionId: string, hostId: string): Promise<SpeakerRosterState>;
  replace(sessionId: string, hostId: string, input: SpeakerRosterReplace): Promise<SpeakerRosterState>;
  createPhoto(sessionId: string, hostId: string, photoId: string, photo: SpeakerPhoto): Promise<{ photoAssetId: string }>;
  getPhoto(sessionId: string, photoId: string): Promise<SpeakerPhoto>;
}

const RPC_ERRORS: Readonly<Record<string, readonly [number, string]>> = {
  SPEAKER_ROSTER_FORBIDDEN: [404, "회의를 찾을 수 없습니다."],
  SPEAKER_ROSTER_CONFLICT: [409, "다른 기기에서 발언자 설정이 변경되었습니다. 새로고침 후 다시 선택하세요."],
  SPEAKER_ROSTER_TERMINAL: [409, "종료된 회의는 변경할 수 없습니다."],
  SPEAKER_ROSTER_INVALID: [400, "발언자 설정이 올바르지 않습니다."],
  SPEAKER_ROSTER_DUPLICATE: [400, "발언자 또는 온라인 연결이 중복됩니다."],
  SPEAKER_ROSTER_PARTICIPANT: [400, "이 회의의 온라인 참여자를 선택하세요."],
  SPEAKER_ROSTER_PHOTO: [404, "발언자 사진을 찾을 수 없습니다."],
  SPEAKER_ROSTER_ACTIVE: [400, "등록된 발언자를 선택하세요."],
};

export class SupabaseSpeakerRosterStore implements SpeakerRosterStore {
  private readonly config: LiveStoreConfig;
  private readonly fetcher: typeof fetch;
  constructor(config: LiveStoreConfig = getLiveStoreConfig(), fetcher: typeof fetch = fetch) {
    this.config = config; this.fetcher = fetcher;
  }
  private async rpc(name: string, body: object): Promise<unknown> {
    const response = await this.fetcher(`${this.config.baseUrl}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { ...supabaseAdminHeaders(this.config.credential), "Content-Type": "application/json" },
      body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const parsed = z.object({ message: z.string() }).safeParse(result);
      const code = parsed.success ? parsed.data.message : "";
      const mapped = RPC_ERRORS[code];
      if (mapped) throw new LiveSessionError(mapped[1], code, mapped[0]);
      throw new LiveSessionError("발언자 설정을 저장하거나 불러올 수 없습니다.", "SPEAKER_ROSTER_UNAVAILABLE", 503);
    }
    return result;
  }
  async get(sessionId: string, hostId: string) {
    return speakerRosterStateSchema.parse(await this.rpc("get_live_speaker_roster_v1", { p_session_id: sessionId, p_host_id: hostId }));
  }
  async replace(sessionId: string, hostId: string, input: SpeakerRosterReplace) {
    return speakerRosterStateSchema.parse(await this.rpc("replace_live_speaker_roster_v1", {
      p_session_id: sessionId, p_host_id: hostId, p_expected_revision: input.expectedRevision,
      p_speakers: input.speakers.map(member => ({ id: member.id, displayName: member.displayName,
        company: member.company, department: member.department, photoAssetId: member.photoAssetId,
        participantId: member.participantId })),
      p_active_onsite_speaker_id: input.activeOnsiteSpeakerId,
    }));
  }
  async createPhoto(sessionId: string, hostId: string, photoId: string, photo: SpeakerPhoto) {
    return z.object({ photoAssetId: z.uuid() }).parse(await this.rpc("create_live_speaker_photo_v1", {
      p_session_id: sessionId, p_host_id: hostId, p_photo_id: photoId,
      p_content_type: photo.contentType, p_bytes_base64: photo.bytesBase64,
    }));
  }
  async getPhoto(sessionId: string, photoId: string): Promise<SpeakerPhoto> {
    const result = await this.rpc("get_live_speaker_photo_v1", { p_session_id: sessionId, p_photo_id: photoId });
    if (result === null) throw new LiveSessionError("발언자 사진을 찾을 수 없습니다.", "SPEAKER_ROSTER_PHOTO", 404);
    return z.object({ contentType: z.literal("image/webp"), bytesBase64: z.string().min(1).max(350_000).regex(/^[A-Za-z0-9+/=\r\n]+$/u) })
      .parse(result);
  }
}
