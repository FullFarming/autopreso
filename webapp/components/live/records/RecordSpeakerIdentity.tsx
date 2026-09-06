"use client";

import { useState } from "react";
import type { getRecordSpeakerPresentation } from "./record-speaker-presentation";
import styles from "./live-records.module.css";

export function RecordSpeakerIdentity({ speaker, fallbackName }: {
  speaker: ReturnType<typeof getRecordSpeakerPresentation> | undefined;
  fallbackName: string;
}) {
  const [failedPhotoUrl, setFailedPhotoUrl] = useState<string | null>(null);
  if (!speaker) return null;
  return <div className={styles.recordSpeaker}>
    <span className={styles.recordSpeakerAvatar} aria-hidden="true">{speaker.photoUrl && speaker.photoUrl !== failedPhotoUrl
      ? <img src={speaker.photoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedPhotoUrl(speaker.photoUrl)} />
      : speaker.initials}</span>
    <span className={styles.recordSpeakerDetails}>
      <span className={styles.recordSpeakerName}>{speaker.displayName || fallbackName}</span>
      {speaker.organization && <span className={styles.recordSpeakerOrganization}>{speaker.organization}</span>}
    </span>
  </div>;
}
