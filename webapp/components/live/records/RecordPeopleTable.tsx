"use client";

import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { recordsMessages, formatSystemRecordDate } from "@/lib/system-language/records-messages";

import { MagnifyingGlass } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { LiveRecordParticipant } from "@/lib/live-records/service";
import type { HostRecapRequest } from "@/lib/live-recap/contract";
import { normalizeRecordSearch } from "./live-records-presentation";
import styles from "./live-records.module.css";

interface PeopleRow {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  time: string;
  state: string;
}

export function RecordPeopleTable({ participants, recipients, mode }: {
  participants: readonly LiveRecordParticipant[];
  recipients: readonly HostRecapRequest[];
  mode: "participants" | "recipients";
}) {
  const t = useSystemText(recordsMessages);
  const { language } = useSystemLanguage();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const isRecipients = mode === "recipients";
  const rows = useMemo<PeopleRow[]>(() => isRecipients
    ? recipients.map((request) => ({ id: request.id, name: request.displayName, email: request.email,
      company: request.company, time: request.requestedAt,
      state: request.status === "cancelled" ? "신청 취소" : "수신 신청" }))
    : participants.map((participant) => ({ id: participant.participantId, name: participant.displayName,
      email: participant.email, company: participant.company, time: participant.joinedAt,
      state: participant.consents.summaryDelivery.accepted ? "동의" : "미동의" })), [isRecipients, participants, recipients]);
  const filtered = useMemo(() => {
    const search = normalizeRecordSearch(query).normalize("NFC").toLocaleLowerCase("ko");
    return rows.filter((row) => [row.name, row.email, row.company].some((value) => value?.normalize("NFC").toLocaleLowerCase("ko").includes(search)));
  }, [query, rows]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / 20));
  const safePage = Math.min(page, totalPages);
  const visibleRows = filtered.slice((safePage - 1) * 20, safePage * 20);
  const title = t(isRecipients ? "수신 신청자" : "참여자");

  return <section aria-label={t("{title} 명단", { title })}>
    <header className={styles.peopleHeading}>
      <div><h2>{title}</h2>{isRecipients && <p>{t("요약·원문 이메일 수신에 동의한 참여자")}</p>}</div>
      <label className={styles.peopleSearch}><span className={styles.srOnly}>{t("{title} 이름 또는 이메일 검색", { title })}</span>
        <MagnifyingGlass size={22} aria-hidden="true" />
        <input type="search" value={query} maxLength={100} placeholder={t("이름 또는 이메일 검색")}
          onChange={(event) => { setQuery(event.currentTarget.value); setPage(1); }} />
      </label>
    </header>
    <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={t("{title} 표, 좁은 화면에서 가로 스크롤", { title })}>
      <table className={styles.peopleTable}>
        <caption className={styles.srOnly}>{t("{title} 전체 {count}명", { title, count: rows.length })}</caption>
        <thead><tr><th scope="col">{t("이름")}</th><th scope="col">{t("이메일")}</th><th scope="col">{t("소속")}</th>
          <th scope="col">{t(isRecipients ? "신청 시각" : "참여 시각")}</th><th scope="col">{t(isRecipients ? "신청 상태" : "요약 수신 동의")}</th></tr></thead>
        <tbody>{visibleRows.map((row) => <tr key={row.id}><th scope="row">{row.name || t("이름 없음")}</th><td>{row.email || t("이메일 없음")}</td>
          <td>{row.company || "—"}</td><td><time dateTime={row.time}>{formatSystemRecordDate(row.time, language)}</time></td><td>{t(row.state)}</td></tr>)}</tbody>
      </table>
    </div>
    {filtered.length === 0 && <p className={styles.empty} role="status">{t(query ? "검색 결과가 없습니다." : isRecipients ? "아직 수신 신청자가 없습니다." : "참여자 기록이 없습니다.")}</p>}
    <p className={styles.tableCount} aria-live="polite">{query ? t("검색 결과 {count}명 · 전체 {total}명", { count: filtered.length, total: rows.length }) : t("전체 {count}명", { count: rows.length })}</p>
    {totalPages > 1 && <nav className={styles.pagination} aria-label={t("{title} 페이지", { title })}>
      <button type="button" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>{t("이전")}</button>
      <span>{safePage} / {totalPages}</span>
      <button type="button" disabled={safePage === totalPages} onClick={() => setPage(safePage + 1)}>{t("다음")}</button>
    </nav>}
  </section>;
}
