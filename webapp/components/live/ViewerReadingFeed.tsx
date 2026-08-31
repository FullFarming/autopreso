"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { viewerMessages } from "@/lib/system-language/viewer-messages";

import { memo, useEffect, useRef, useState } from "react";
import type { TopicCaptionPresentation } from "./translation/topic-presentation";

export const ViewerReadingFeed = memo(function ViewerReadingFeed({ captions, language, kind = "translation", onReadingAnchorChange }: {
  captions: readonly TopicCaptionPresentation[];
  language: string;
  kind?: "source" | "translation";
  onReadingAnchorChange?: (utteranceKey: string) => void;
}) {
  const t = useSystemText(viewerMessages);
  const scroll = useRef<HTMLDivElement>(null);
  const isPinned = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);
  const firstPresentedCaptions = useRef<readonly TopicCaptionPresentation[] | null>(null);
  useEffect(() => {
    const node = scroll.current;
    if (!node || captions.length === 0) return;
    if (firstPresentedCaptions.current === null) {
      firstPresentedCaptions.current = captions;
      isPinned.current = node.scrollHeight <= node.clientHeight;
      setIsFollowing(isPinned.current);
      return;
    }
    // Strict Mode repeats the mount effect; the first record must stay at its beginning.
    if (firstPresentedCaptions.current === captions) return;
    if (isPinned.current) node.scrollTop = node.scrollHeight;
  }, [captions]);
  const latestFinal = captions.findLast((caption) => caption.isFinal);
  return <section className="viewer-reading-feed" aria-label={kind === "source" ? t("실시간 원문") : t("실시간 번역")}>
    <div className="viewer-reading-scroll" ref={scroll} role="region" aria-label={t("자막 목록")} tabIndex={0}
      onScroll={(event) => {
        const node = event.currentTarget;
        isPinned.current = node.scrollHeight - node.clientHeight - node.scrollTop < 48;
        setIsFollowing(isPinned.current);
        if (onReadingAnchorChange) {
          const top = node.getBoundingClientRect().top;
          const firstVisible = Array.from(node.querySelectorAll<HTMLElement>('[data-caption-state="final"][data-utterance-key]'))
            .find((entry) => entry.getBoundingClientRect().bottom > top);
          if (firstVisible?.dataset.utteranceKey) onReadingAnchorChange(firstVisible.dataset.utteranceKey);
        }
      }}>
      {captions.length === 0 ? <p className="viewer-muted" role="status">{t("발표가 시작되면 자막이 여기에 표시됩니다.")}</p> : captions.map((caption, index) => {
        const previous = captions[index - 1];
        const showSpeaker = !previous || previous.speakerLabel !== caption.speakerLabel || previous.timestamp !== caption.timestamp;
        const failed = caption.translationStatus === "failed";
        return <article key={caption.utteranceKey ?? caption.id} data-utterance-key={caption.utteranceKey ?? caption.id}
          data-caption-state={failed ? "failed" : caption.isFinal ? "final" : "partial"}>
          {showSpeaker && <header>{kind === "source" ? t(caption.speakerLabel || "발표자") : caption.speakerLabel || t("발표자")}{caption.timestamp && <time>{caption.timestamp}</time>}</header>}
          <p lang={caption.language ?? language} className="viewer-caption-text">{failed ? t("번역을 불러오지 못했어요.") : caption.text}
            {caption.pendingText && <span className="viewer-caption-draft"> {caption.pendingText}</span>}</p>
          {(!caption.isFinal || caption.pendingText) && <span className="viewer-muted viewer-drafting-label">{kind === "source" ? t("작성 중") : t("번역 중")}</span>}
        </article>;
      })}
    </div>
    {!isFollowing && <button className="viewer-follow-button" type="button" onClick={() => {
      isPinned.current = true; setIsFollowing(true); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    }}>{t("실시간으로 돌아가기")}</button>}
    <span className="sr-only" aria-live="polite" aria-atomic="true">{latestFinal?.text}</span>
  </section>;
});
