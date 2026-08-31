"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages } from "@/lib/system-language/records-messages";

import { useId, useMemo, useState } from "react";
import { searchSelectedTranscript, type SearchableCaption } from "./earnings-presentation";
import styles from "./earnings.module.css";

export function SelectedTranscriptSearch({ captions, laneLabel }: {
  captions: readonly SearchableCaption[];
  laneLabel: string;
}) {
  const t = useSystemText(recordsMessages);
  const inputId = useId();
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchSelectedTranscript(captions, query), [captions, query]);
  return (
    <details className={styles.search}>
      <summary>{t("선택한 자막 검색")}</summary>
      <label htmlFor={inputId}>{t("{lane} 자막에서 찾기", { lane: laneLabel })}</label>
      <input id={inputId} name="transcriptSearch" type="search" value={query}
        onChange={(event) => setQuery(event.currentTarget.value)} autoComplete="off" />
      <p aria-live="polite">{query.trim() ? t("{count}개 결과", { count: results.length }) : t("검색어를 입력해 주세요.")}</p>
      {results.length > 0 && <ol>{results.map((caption) => <li key={caption.id}><strong>{caption.speakerLabel}</strong> {caption.text}</li>)}</ol>}
    </details>
  );
}
