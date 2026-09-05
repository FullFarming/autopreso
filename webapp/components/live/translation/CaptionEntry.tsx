import { SpeakerIdentity } from "../SpeakerIdentity";
import type { SpeakerProfile, CaptionTranslationStatus } from "@/lib/live-contract";
import styles from "./translation.module.css";

export type CaptionDisplayMode = "translation" | "source" | "bilingual";

interface CaptionEntryProps {
  text: string;
  speakerProfile?: SpeakerProfile;
  sessionId?: string;
  speakerLabel?: string;
  speakerColor?: string;
  timestamp?: string;
  isFinal: boolean;
  translationStatus?: CaptionTranslationStatus;
  pendingText?: string;
  sourceText?: string | null;
  isActive?: boolean;
  displayMode?: CaptionDisplayMode;
}

export function CaptionEntry({
  text, speakerProfile, sessionId,
  speakerLabel = "Speaker",
  speakerColor,
  timestamp,
  isFinal,
  translationStatus = "translated",
  pendingText,
  sourceText,
  isActive = false,
  displayMode = "translation",
}: CaptionEntryProps) {
  const state = translationStatus === "failed" ? "failed" : isFinal ? "final" : "partial";
  // 이중 표기 금지: verbatim 자막은 본문이 곧 원문이므로 어떤 모드에서도 같은
  // 문장을 두 번 그리지 않는다. 실패 자막은 원문이 본문으로 fail-open되어
  // 오는데, 그대로 그리면 한 레인에 두 언어가 섞이므로 상태 문구로 바꾸고
  // 원문은 펼침 뒤로 보낸다.
  const isFailed = translationStatus === "failed";
  const hasDistinctSource = Boolean(sourceText) && sourceText !== text && translationStatus !== "verbatim";
  const bodyText = isFailed
    ? "번역을 불러오지 못했어요. 원문 보기에서 확인할 수 있어요."
    : displayMode === "source" && hasDistinctSource && sourceText
      ? sourceText
      : text;
  const sourceLine = !isFailed && displayMode === "bilingual" && hasDistinctSource ? sourceText : null;
  const disclosureText = isFailed
    ? (hasDistinctSource && sourceText ? sourceText : text)
    : displayMode === "translation" && hasDistinctSource
      ? sourceText
      : null;

  return (
    <article className={styles.entry} data-list-item="caption"
      data-caption-state={state} data-active={isActive || undefined}>
      <header className={styles.entryMeta}>
        {!speakerProfile?.photoAssetId && <span className={styles.speakerBadge} aria-hidden="true">{(speakerProfile?.displayName || speakerLabel).trim().charAt(0).toUpperCase() || "S"}</span>}
        <span className={styles.speakerName} style={speakerColor ? { color: speakerColor } : undefined}><SpeakerIdentity profile={speakerProfile} sessionId={sessionId} fallback={speakerLabel} /></span>
        {timestamp && <time className={styles.timestamp}>{timestamp}</time>}
        {disclosureText && (
          <details className={styles.sourceDisclosure}>
            <summary>원문 보기</summary>
            <p>{disclosureText}</p>
          </details>
        )}
      </header>
      {sourceLine && <p className={styles.sourceLine}>{sourceLine}</p>}
      <p className={styles.captionText}>
        {bodyText}
        {pendingText && <span className={styles.pendingText}>{pendingText}</span>}
        {state === "partial" && <span className={styles.srOnly}>입력 중</span>}
      </p>
    </article>
  );
}
