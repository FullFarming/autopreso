"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import type { ConsoleSessionRow } from "@/lib/console/console-store";
import { SYSTEM_LOCALES } from "@/lib/system-language";
import { consoleMessages } from "@/lib/system-language/console-messages";

import { consoleErrorKey, consoleFetch } from "./console-client";
import { formatConsoleDate, sessionModeLabelKey, sessionStatusLabelKey, summaryStatusLabelKey, type ConsoleRange, type ConsoleSessionsSummary } from "./console-model";

interface SessionsResponse { sessions: ConsoleSessionRow[]; summary: ConsoleSessionsSummary }

const RANGES: readonly ConsoleRange[] = ["7d", "30d", "all"];
const RANGE_LABEL_KEYS: Record<ConsoleRange, string> = { "7d": "7일", "30d": "30일", all: "전체" };

/** `/console/sessions`: four summary cards and the session table, aggregated server-side from existing tables. */
export function SessionsPanel() {
  const t = useSystemText(consoleMessages);
  const { language } = useSystemLanguage();
  const locale = SYSTEM_LOCALES[language];
  const [range, setRange] = useState<ConsoleRange>("7d");
  const [sessions, setSessions] = useState<ConsoleSessionRow[]>([]);
  const [summary, setSummary] = useState<ConsoleSessionsSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSerial = useRef(0);
  const headingId = useId();

  const loadSessions = useCallback(async (selected: ConsoleRange) => {
    const serial = ++requestSerial.current;
    setIsLoading(true);
    setError(null);
    try {
      const data = await consoleFetch<SessionsResponse>(`/api/console/sessions?range=${selected}`);
      if (serial !== requestSerial.current) return;
      setSessions(data.sessions);
      setSummary(data.summary);
    } catch (requestError) {
      if (serial !== requestSerial.current) return;
      setError(consoleErrorKey(requestError, "세션 목록을 불러오지 못했습니다."));
    } finally {
      if (serial === requestSerial.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadSessions(range); }, [range, loadSessions]);

  const cards: readonly { key: string; value: number | null }[] = [
    { key: "오늘 세션", value: summary?.today ?? null },
    { key: "진행 중", value: summary?.live ?? null },
    { key: "7일 발언 수", value: summary?.utterances7d ?? null },
    { key: "요약 실패", value: summary?.summaryFailures ?? null },
  ];

  return (
    <section className="glass live-panel console-panel" aria-labelledby={headingId}>
      <div className="live-section-heading">
        <h2 id={headingId}>{t("세션 현황")}</h2>
      </div>
      <div className="console-summary-grid" aria-busy={isLoading}>
        {cards.map((card) => (
          <div key={card.key} className="console-summary-card">
            <span>{t(card.key)}</span>
            <strong className="console-num">{card.value === null ? "—" : card.value.toLocaleString(locale)}</strong>
          </div>
        ))}
      </div>
      <div className="console-chips">
        {RANGES.map((candidate) => (
          <button key={candidate} type="button" aria-pressed={range === candidate} onClick={() => setRange(candidate)}>{t(RANGE_LABEL_KEYS[candidate])}</button>
        ))}
      </div>
      {error && (
        <div className="live-error" role="alert">
          <span>{t(error)}</span>
          <button type="button" className="glass-btn" onClick={() => void loadSessions(range)}>{t("다시 시도")}</button>
        </div>
      )}
      <div className="console-table-wrap" aria-busy={isLoading}>
        <table className="console-table">
          <thead>
            <tr>
              <th scope="col">{t("제목")}</th>
              <th scope="col">{t("호스트")}</th>
              <th scope="col">{t("시작/종료")}</th>
              <th scope="col">{t("상태")}</th>
              <th scope="col">{t("언어")}</th>
              <th scope="col" className="console-num">{t("발언 수")}</th>
              <th scope="col" className="console-num">{t("참여자 수")}</th>
              <th scope="col">{t("요약 상태")}</th>
            </tr>
          </thead>
          <tbody>
            {!isLoading && !error && sessions.length === 0 && (
              <tr><td colSpan={8} className="console-empty">{t("기간 내 세션이 없습니다.")}</td></tr>
            )}
            {isLoading && sessions.length === 0 && (
              <tr><td colSpan={8} className="console-empty" role="status">{t("불러오는 중…")}</td></tr>
            )}
            {sessions.map((row) => (
              <tr key={row.id}>
                <td>
                  <a className="console-row-link" href={`/records/${encodeURIComponent(row.id)}`} aria-label={`${row.title?.trim() || t("제목 없음")} · ${t("기록 보기")}`}>
                    <strong>{row.title?.trim() || t("제목 없음")}</strong>
                    <small>{t(sessionModeLabelKey(row.mode))}</small>
                  </a>
                </td>
                <td>{row.hostEmail ?? row.hostId}</td>
                <td className="console-num">
                  <span>{formatConsoleDate(row.createdAt, locale)}</span>
                  <span>{row.endedAt ? formatConsoleDate(row.endedAt, locale) : "—"}</span>
                </td>
                <td><span className={`console-status console-status-${row.status}`}>{t(sessionStatusLabelKey(row.status))}</span></td>
                <td>{row.languages.join(", ").toUpperCase()}</td>
                <td className="console-num">{row.utteranceCount.toLocaleString(locale)}</td>
                <td className="console-num">{row.participantCount.toLocaleString(locale)}</td>
                <td>{t(summaryStatusLabelKey(row.summaryStatus))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
