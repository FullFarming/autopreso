"use client";

import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages, formatSystemRecordDate } from "@/lib/system-language/records-messages";

import type { LiveRecordListItem } from "./live-record-types";
import styles from "./live-records.module.css";

interface LiveRecordsListProps {
  records: readonly LiveRecordListItem[];
  query: string;
  activeQuery: string;
  totalRecords: number;
  page: number;
  totalPages: number;
  isLoading?: boolean;
  error?: string;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  onClearSearch: () => void;
  onRetry: () => void;
  onPageChange: (page: number) => void;
  onOpen: (id: string) => void;
}

function RecordListSkeleton() {
  const t = useSystemText(recordsMessages);
  return (
    <div className={styles.recordListSkeleton} role="status" aria-live="polite">
      <span className={styles.srOnly}>{t("기록 불러오는 중")}</span>
      {[0, 1, 2].map((row) => (
        <div className={styles.skeletonRow} key={row} aria-hidden="true">
          <span /><span /><span />
        </div>
      ))}
    </div>
  );
}

export function LiveRecordsList({
  records, query, activeQuery, totalRecords, page, totalPages, isLoading = false, error = "",
  onQueryChange, onSearch, onClearSearch, onRetry, onPageChange, onOpen,
}: LiveRecordsListProps) {
  const t = useSystemText(recordsMessages);
  const { language } = useSystemLanguage();
  const isEmpty = !isLoading && !error && records.length === 0;

  return (
    <section className={styles.list} aria-labelledby="live-records-heading" aria-busy={isLoading}>
      <header className={styles.pageHeader}>
        <div>
          <h1 id="live-records-heading">{t("라이브콜 기록")}</h1>
          {!isLoading && !error && <span className={styles.resultCount}>{t("{count}개", { count: totalRecords })}</span>}
        </div>
      </header>

      <form className={styles.search} role="search" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
        <label htmlFor="live-record-search">{t("기록 검색")}</label>
        <div className={styles.searchField}>
          <input id="live-record-search" name="query" type="search" value={query}
            aria-label={t("라이브콜 기록 검색")} placeholder={t("제목 또는 날짜")}
            onChange={(event) => onQueryChange(event.currentTarget.value)} />
          {activeQuery && <button className={styles.clearButton} type="button" onClick={onClearSearch}>{t("초기화")}</button>}
        </div>
        <button className={styles.searchButton} type="submit">{t("검색")}</button>
      </form>

      {error ? (
        <div className={styles.statePanel} role="alert">
          <strong>{t("기록을 불러오지 못했습니다.")}</strong>
          <button type="button" onClick={onRetry}>{t("다시 시도")}</button>
        </div>
      ) : isLoading ? <RecordListSkeleton /> : isEmpty ? (
        <div className={styles.statePanel} role="status">
          <strong>{t(activeQuery ? "검색 결과가 없습니다." : "기록이 없습니다.")}</strong>
          {activeQuery && <button type="button" onClick={onClearSearch}>{t("전체 기록")}</button>}
        </div>
      ) : (
        <ul className={styles.recordRows} aria-label={t("라이브콜 기록 목록")}>
          {records.map((record) => (
            <li key={record.id}>
              <button type="button" onClick={() => onOpen(record.id)}>
                <span className={styles.recordIdentity}>
                  <strong>{record.title}</strong>
                  <small>{formatSystemRecordDate(record.scheduledAt, language)}</small>
                </span>
                <span className={styles.recordMeta}>{record.languages.join(" · ") || t("원문")}</span>
                <span className={styles.recordMeta}>{t("{count}명", { count: record.participantCount })}</span>
                <span className={styles.rowStatuses}>
                  <span className={styles.statusChip} data-state={record.status.state}>
                    <i className={styles.statusDot} aria-hidden="true" />{t(record.status.label)}
                  </span>
                  <span className={styles.statusChip} data-state={record.summaryState.state}>
                    <i className={styles.statusDot} aria-hidden="true" />{t(record.summaryState.label)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!error && !isLoading && !isEmpty && totalPages > 1 && (
        <nav className={styles.pagination} aria-label={t("기록 페이지")}>
          <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>{t("이전")}</button>
          <span aria-live="polite">{page} / {Math.max(1, totalPages)}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>{t("다음")}</button>
        </nav>
      )}
    </section>
  );
}
