import type { SpeakerProfile } from "@/lib/live-contract";
import { buildSpeakerPhotoUrl } from "../../../packages/caption-core/speaker-profile.js";
import styles from "./SpeakerRosterEditor.module.css";

export function SpeakerIdentity({ profile, sessionId, fallback }: { profile?: SpeakerProfile; sessionId?: string; fallback: string }) {
  let photoUrl: string | undefined;
  if (sessionId && profile?.photoAssetId) {
    try { photoUrl = buildSpeakerPhotoUrl(sessionId, profile.photoAssetId); } catch { photoUrl = undefined; }
  }
  return <span className={styles.identity}>
    {photoUrl && <img src={photoUrl} alt="" width={44} height={44} />}
    <span>{profile?.displayName || fallback}{profile && [profile.company, profile.department].filter(Boolean).length > 0 && <span className={styles.organization}>{[profile.company, profile.department].filter(Boolean).join(" · ")}</span>}</span>
  </span>;
}
