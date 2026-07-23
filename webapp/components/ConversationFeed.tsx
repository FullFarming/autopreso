"use client";

import { memo, useEffect, useRef } from "react";

import SubtitleBubble from "./SubtitleBubble";
import type { PartialLine, SubtitleLine } from "@/lib/types";

// Memoized: the solo page re-renders ~10×/s on mic-level events; the feed's
// props only change identity when an actual subtitle event lands.
function ConversationFeed({
  lines,
  partials,
  running,
}: {
  lines: SubtitleLine[];
  partials: PartialLine[];
  running: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines.length, partials]);

  const empty = lines.length === 0 && partials.length === 0;

  return (
    <section className="glass flex-1 space-y-2 overflow-y-auto p-3 sm:p-4">
      {empty ? (
        <div className="flex h-48 flex-col items-center justify-center text-center text-sm text-cw-grey50">
          {running ? (
            <>
              <span className="cw-pulse mb-2 text-2xl">…</span>
              <span>음성을 기다리는 중입니다. 말하거나 탭 오디오를 재생해 보세요.</span>
            </>
          ) : (
            <span>시작 버튼을 누르면 번역된 자막이 여기에 표시됩니다.</span>
          )}
        </div>
      ) : (
        <>
          {lines.map((line) => (
            <SubtitleBubble
              key={line.id}
              at={line.at}
              source={line.source}
              targetLanguage={line.targetLanguage}
              sourceText={line.sourceText}
              translatedText={line.translatedText}
            />
          ))}
          {partials.map((partial) => (
            <SubtitleBubble
              key={`partial-${partial.key}`}
              at={partial.at}
              source={partial.source}
              targetLanguage={partial.targetLanguage}
              sourceText={partial.sourceText}
              translatedText={partial.translatedText}
              partial
            />
          ))}
        </>
      )}
      <div ref={bottomRef} />
    </section>
  );
}

export default memo(ConversationFeed);
