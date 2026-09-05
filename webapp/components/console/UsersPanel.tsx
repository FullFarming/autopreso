"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import type { ConsoleProfileRow } from "@/lib/console/console-store";
import { SYSTEM_LOCALES } from "@/lib/system-language";
import { consoleMessages } from "@/lib/system-language/console-messages";

import { ConfirmDialog } from "./ConfirmDialog";
import { consoleErrorKey, consoleFetch } from "./console-client";
import { useConsolePending } from "./ConsoleShell";
import { buildRejectReason, emptyStateKey, formatConsoleDate, REJECT_REASON_LABEL_KEYS, rejectReasons, statusLabelKey, type ProfileFilter, type RejectReason } from "./console-model";

interface UsersResponse { profiles: ConsoleProfileRow[]; pendingCount: number }
type PatchBody = { profileId: string; status: "approved" | "rejected" | "disabled"; reason?: string } | { profileId: string; role: "host" | "admin" } | { profileId: string; voiceProvider: "soniox" | "gemini" };

const FILTERS: readonly ProfileFilter[] = ["pending", "approved", "rejected", "disabled"];
const FILTER_LABEL_KEYS: Record<ProfileFilter, string> = { pending: "대기", approved: "승인", rejected: "반려", disabled: "비활성" };

/**
 * `/console/users`: signup approval, roles, disable/reactivate. Nothing is patched locally -
 * every mutation is followed by a fresh `GET`, so the table and the rail badge only ever show
 * what the server confirmed. One request in flight per row (`aria-busy`), errors inline per row.
 */
export function UsersPanel() {
  const t = useSystemText(consoleMessages);
  const { language } = useSystemLanguage();
  const locale = SYSTEM_LOCALES[language];
  const { setPendingCount } = useConsolePending();
  const [filter, setFilter] = useState<ProfileFilter>("pending");
  const [profiles, setProfiles] = useState<ConsoleProfileRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<{ id: string; reason: RejectReason; note: string } | null>(null);
  const [disableTarget, setDisableTarget] = useState<ConsoleProfileRow | null>(null);
  const requestSerial = useRef(0);
  const headingId = useId();

  const loadProfiles = useCallback(async (status: ProfileFilter) => {
    const serial = ++requestSerial.current;
    setIsLoading(true);
    setListError(null);
    try {
      const data = await consoleFetch<UsersResponse>(`/api/console/users?status=${status}`);
      if (serial !== requestSerial.current) return;
      setProfiles(data.profiles);
      setPendingCount(data.pendingCount);
    } catch (error) {
      if (serial !== requestSerial.current) return;
      setListError(consoleErrorKey(error, "사용자 목록을 불러오지 못했습니다."));
    } finally {
      if (serial === requestSerial.current) setIsLoading(false);
    }
  }, [setPendingCount]);

  useEffect(() => { void loadProfiles(filter); }, [filter, loadProfiles]);

  async function patchProfile(body: PatchBody) {
    setBusyId(body.profileId);
    setRowErrors((current) => { const next = { ...current }; delete next[body.profileId]; return next; });
    try {
      await consoleFetch<{ id: string; status: string; role: string }>("/api/console/users", { method: "PATCH", body });
      setRejecting(null);
      await loadProfiles(filter);
    } catch (error) {
      setRowErrors((current) => ({ ...current, [body.profileId]: consoleErrorKey(error, "변경하지 못했습니다.") }));
    } finally {
      // Close the disable dialog on failure too: the row's inline alert would otherwise sit behind the
      // modal backdrop. The reject form stays open on failure so the typed note is not lost.
      setDisableTarget(null);
      setBusyId(null);
    }
  }

  function renderActions(row: ConsoleProfileRow) {
    const isBusy = busyId === row.id;
    if (row.status === "pending") {
      const isRejecting = rejecting?.id === row.id;
      return (
        <div className="console-row-actions">
          <button type="button" className="accent-btn live-primary-action" disabled={isBusy} onClick={() => void patchProfile({ profileId: row.id, status: "approved" })}>{t("승인")}</button>
          {!isRejecting && <button type="button" className="glass-btn" disabled={isBusy} onClick={() => setRejecting({ id: row.id, reason: "unverified", note: "" })}>{t("반려")}</button>}
          {isRejecting && rejecting && (
            <div className="console-reject-form">
              <label>
                <span>{t("반려 사유")}</span>
                <select value={rejecting.reason} disabled={isBusy} onChange={(event) => setRejecting({ ...rejecting, reason: event.target.value as RejectReason })}>
                  {rejectReasons.map((reason) => <option key={reason} value={reason}>{t(REJECT_REASON_LABEL_KEYS[reason])}</option>)}
                </select>
              </label>
              <label>
                <span>{t("메모 (선택)")}</span>
                <input type="text" className="glass-input" maxLength={150} value={rejecting.note} disabled={isBusy} onChange={(event) => setRejecting({ ...rejecting, note: event.target.value })} />
              </label>
              <div className="console-row-actions">
                <button type="button" className="console-danger" disabled={isBusy}
                  onClick={() => void patchProfile({ profileId: row.id, status: "rejected", reason: buildRejectReason(rejecting.reason, rejecting.note) })}>{t("반려 확정")}</button>
                <button type="button" className="glass-btn" disabled={isBusy} onClick={() => setRejecting(null)}>{t("취소")}</button>
              </div>
            </div>
          )}
        </div>
      );
    }
    if (row.status === "approved") {
      return (
        <div className="console-row-actions">
          <label className="console-inline-field">
            <span>{t("역할 변경")}</span>
            <select value={row.role} disabled={isBusy} onChange={(event) => void patchProfile({ profileId: row.id, role: event.target.value as "host" | "admin" })}>
              <option value="host">{t("호스트")}</option>
              <option value="admin">{t("관리자")}</option>
            </select>
          </label>
          <button type="button" className="console-danger" disabled={isBusy} onClick={() => setDisableTarget(row)}>{t("비활성화")}</button>
        </div>
      );
    }
    return (
      <div className="console-row-actions">
        <button type="button" className="accent-btn live-primary-action" disabled={isBusy} onClick={() => void patchProfile({ profileId: row.id, status: "approved" })}>
          {row.status === "disabled" ? t("재활성화") : t("승인")}
        </button>
      </div>
    );
  }

  return (
    <section className="glass live-panel console-panel" aria-labelledby={headingId}>
      <div className="live-section-heading">
        <h2 id={headingId}>{t("가입 관리")}</h2>
      </div>
      <div className="console-chips">
        {FILTERS.map((candidate) => (
          <button key={candidate} type="button" aria-pressed={filter === candidate} onClick={() => setFilter(candidate)}>
            {t(FILTER_LABEL_KEYS[candidate])}
          </button>
        ))}
      </div>
      {listError && (
        <div className="live-error" role="alert">
          <span>{t(listError)}</span>
          <button type="button" className="glass-btn" onClick={() => void loadProfiles(filter)}>{t("다시 시도")}</button>
        </div>
      )}
      <div className="console-table-wrap" aria-busy={isLoading}>
        <table className="console-table console-users-table">
          {/* Roles are explicit because the ≤767px card layout sets display: grid on rows and cells, which drops the implicit table semantics. */}
          <thead>
            <tr role="row">
              <th scope="col" role="columnheader">{t("이메일")}</th>
              <th scope="col" role="columnheader">{t("이름")}</th>
              <th scope="col" role="columnheader">{t("가입일")}</th>
              <th scope="col" role="columnheader">{t("상태")}</th>
              <th scope="col" role="columnheader">{t("역할")}</th>
              <th scope="col" role="columnheader">다음 세션 엔진</th>
              <th scope="col" role="columnheader">{t("마지막 로그인")}</th>
              <th scope="col" role="columnheader">{t("작업")}</th>
            </tr>
          </thead>
          <tbody>
            {!isLoading && !listError && profiles.length === 0 && (
              <tr role="row"><td role="cell" colSpan={8} className="console-empty">{t(emptyStateKey(filter))}</td></tr>
            )}
            {isLoading && profiles.length === 0 && (
              <tr role="row"><td colSpan={8} className="console-empty" role="status">{t("불러오는 중…")}</td></tr>
            )}
            {profiles.map((row) => (
              <tr key={row.id} role="row" aria-busy={busyId === row.id}>
                <td role="cell" data-label={t("이메일")}>{row.email}</td>
                <td role="cell" data-label={t("이름")}>{row.displayName ?? "—"}</td>
                <td role="cell" data-label={t("가입일")} className="console-num">{formatConsoleDate(row.createdAt, locale)}</td>
                <td role="cell" data-label={t("상태")}><span className={`console-status console-status-${row.status}`}>{t(statusLabelKey(row.status))}</span></td>
                <td role="cell" data-label={t("역할")}>{row.role === "admin" ? t("관리자") : t("호스트")}</td>
                <td role="cell" data-label="다음 세션 엔진">
                  <label className="console-inline-field">
                    <span className="sr-only">{row.email} 다음 세션 엔진</span>
                    <select aria-label={`${row.email} 다음 세션 엔진`} value={row.voiceProvider ?? "soniox"} disabled={busyId === row.id}
                      onChange={(event) => {
                        const voiceProvider = event.currentTarget.value;
                        if (voiceProvider === "soniox" || voiceProvider === "gemini") void patchProfile({ profileId: row.id, voiceProvider });
                      }}>
                      <option value="soniox">Soniox</option>
                      <option value="gemini">Gemini</option>
                    </select>
                  </label>
                </td>
                <td role="cell" data-label={t("마지막 로그인")} className="console-num">{formatConsoleDate(row.lastLoginAt, locale) || t("없음")}</td>
                <td role="cell" data-label={t("작업")}>
                  {renderActions(row)}
                  {rowErrors[row.id] && <p className="console-row-error" role="alert">{t(rowErrors[row.id])}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        variant="destructive"
        open={disableTarget !== null}
        title={t("{email} 계정을 비활성화할까요?", { email: disableTarget?.email ?? "" })}
        body={<p>{t("비활성화된 사용자는 즉시 로그인할 수 없고 진행 중인 라이브 콜 호스트 권한도 잃습니다. 나중에 재활성화할 수 있습니다.")}</p>}
        confirmLabel={t("비활성화")}
        busy={disableTarget !== null && busyId === disableTarget.id}
        onCancel={() => setDisableTarget(null)}
        onConfirm={() => { if (disableTarget) return patchProfile({ profileId: disableTarget.id, status: "disabled" }); }}
      />
    </section>
  );
}
