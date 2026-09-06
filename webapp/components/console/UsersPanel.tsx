"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import type { ActiveSessionRow, ConsoleProfileRow, EngineDeploySummary, VoiceProvider } from "@/lib/console/console-store";
import { SYSTEM_LOCALES } from "@/lib/system-language";
import { consoleMessages } from "@/lib/system-language/console-messages";

import { ConfirmDialog } from "./ConfirmDialog";
import { consoleErrorKey, consoleFetch } from "./console-client";
import { useConsolePending } from "./ConsoleShell";
import {
  buildRejectReason, deployCodeLabelKey, deployResultLabelKey, emptyStateKey, formatConsoleDate, REJECT_REASON_LABEL_KEYS, rejectReasons, statusLabelKey, voiceProviderLabel,
  type ProfileFilter, type RejectReason,
} from "./console-model";

interface UsersResponse { profiles: ConsoleProfileRow[]; pendingCount: number }
/** `GET /api/console/users/[id]/active-sessions`: the exact sessions a switch of this profile would touch. */
interface ActiveSessionsResponse { count: number; sessions: ActiveSessionRow[] }
type PatchBody = { profileId: string; status: "approved" | "rejected" | "disabled"; reason?: string } | { profileId: string; role: "host" | "admin" };
/** `PATCH { voiceProvider }` answer (D1): the profile plus what happened to each of that user's running sessions. */
interface VoiceAssignmentResult { sessionId: string; result: "switched" | "queued" | "failed"; code?: string }
interface VoiceAssignmentResponse { id: string; status: string; role: string; voiceProvider: VoiceProvider; results: VoiceAssignmentResult[]; summary: EngineDeploySummary; changed: boolean }
interface VoiceAssignmentOutcome { voiceProvider: VoiceProvider; results: VoiceAssignmentResult[]; summary: EngineDeploySummary }
/** The pending engine switch: `activeCount` is `null` while the session list loads and `"unknown"` when it could not be read. */
interface VoiceTarget { row: ConsoleProfileRow; voiceProvider: VoiceProvider; activeCount: number | null | "unknown" }

const FILTERS: readonly ProfileFilter[] = ["pending", "approved", "rejected", "disabled"];
const FILTER_LABEL_KEYS: Record<ProfileFilter, string> = { pending: "대기", approved: "승인", rejected: "반려", disabled: "비활성" };

/**
 * `/console/users`: signup approval, roles, disable/reactivate, and the per-user Live Call engine
 * (D1: operator-assigned, applied to the user's running sessions immediately). Nothing is patched
 * locally - every mutation is followed by a fresh `GET`, so the table and the rail badge only ever
 * show what the server confirmed. One request in flight per row (`aria-busy`), errors inline per row.
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
  const [voiceTarget, setVoiceTarget] = useState<VoiceTarget | null>(null);
  const [voiceOutcomes, setVoiceOutcomes] = useState<Record<string, VoiceAssignmentOutcome>>({});
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

  /**
   * The select is controlled by the server row, so a cancelled confirm simply re-renders the old
   * value. The confirm quotes the exact number of this user's running sessions from the per-profile
   * endpoint (the server resolves the host id from the profile row); a failed count still allows
   * the switch with the "every running session" copy.
   */
  async function openVoiceConfirm(row: ConsoleProfileRow, voiceProvider: VoiceProvider) {
    setVoiceTarget({ row, voiceProvider, activeCount: null });
    let activeCount: number | "unknown" = "unknown";
    try {
      const data = await consoleFetch<ActiveSessionsResponse>(`/api/console/users/${row.id}/active-sessions`);
      activeCount = data.count;
    } catch {
      activeCount = "unknown";
    }
    setVoiceTarget((current) => (current && current.row.id === row.id && current.voiceProvider === voiceProvider ? { ...current, activeCount } : current));
  }

  async function assignVoiceProvider(row: ConsoleProfileRow, voiceProvider: VoiceProvider) {
    setBusyId(row.id);
    setRowErrors((current) => { const next = { ...current }; delete next[row.id]; return next; });
    setVoiceOutcomes((current) => { const next = { ...current }; delete next[row.id]; return next; });
    try {
      const data = await consoleFetch<VoiceAssignmentResponse>("/api/console/users", { method: "PATCH", body: { profileId: row.id, voiceProvider } });
      setVoiceOutcomes((current) => ({ ...current, [row.id]: { voiceProvider: data.voiceProvider, results: data.results, summary: data.summary } }));
      await loadProfiles(filter);
    } catch (error) {
      setRowErrors((current) => ({ ...current, [row.id]: consoleErrorKey(error, "엔진을 바꾸지 못했습니다.") }));
    } finally {
      // Close on failure as well, so the row's inline alert is not hidden behind the dialog backdrop.
      setVoiceTarget(null);
      setBusyId(null);
    }
  }

  function renderVoiceOutcome(outcome: VoiceAssignmentOutcome) {
    return (
      <div className="console-row-status" role="status">
        <p className="console-status-line">
          {t("{engine}(으)로 전환: 전환됨 {switched} · 대기열 {queued} · 실패 {failed}", {
            engine: voiceProviderLabel(outcome.voiceProvider), switched: outcome.summary.switched, queued: outcome.summary.queued, failed: outcome.summary.failed,
          })}
        </p>
        {outcome.results.length > 0 && (
          <ul className="console-row-results" aria-label={t("세션별 전환 결과")}>
            {outcome.results.map((entry) => (
              <li key={entry.sessionId}>
                <code>{entry.sessionId}</code>
                <span className={`console-status console-result-${entry.result}`}>{t(deployResultLabelKey(entry.result))}</span>
                {entry.code !== undefined && <span className="console-result-code">{t(deployCodeLabelKey(entry.code))}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
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
              <th scope="col" role="columnheader">{t("라이브 콜 엔진")}</th>
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
                <td role="cell" data-label={t("라이브 콜 엔진")}>
                  <label className="console-inline-field">
                    <span className="console-sr-only">{t("{email} 라이브 콜 엔진", { email: row.email })}</span>
                    <select value={row.voiceProvider ?? "soniox"} disabled={busyId === row.id}
                      onChange={(event) => {
                        const voiceProvider = event.currentTarget.value;
                        if ((voiceProvider === "soniox" || voiceProvider === "gemini") && voiceProvider !== (row.voiceProvider ?? "soniox")) void openVoiceConfirm(row, voiceProvider);
                      }}>
                      <option value="soniox">{voiceProviderLabel("soniox")}</option>
                      <option value="gemini">{voiceProviderLabel("gemini")}</option>
                    </select>
                  </label>
                  {voiceOutcomes[row.id] && renderVoiceOutcome(voiceOutcomes[row.id])}
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
      <ConfirmDialog
        variant="primary"
        open={voiceTarget !== null}
        title={t("{email}의 엔진을 {engine}(으)로 바꿀까요?", { email: voiceTarget?.row.email ?? "", engine: voiceProviderLabel(voiceTarget?.voiceProvider) })}
        body={(
          <p>
            {voiceTarget?.activeCount === null && t("불러오는 중…")}
            {voiceTarget?.activeCount === "unknown" && t("진행 중인 세션 수를 확인할 수 없습니다. 이 사용자의 진행 중인 세션은 모두 즉시 전환됩니다.")}
            {typeof voiceTarget?.activeCount === "number" && t("이 사용자의 진행 중인 세션 {count}개가 즉시 전환됩니다. 다음 세션부터도 이 엔진을 사용합니다.", { count: voiceTarget.activeCount })}
          </p>
        )}
        confirmLabel={t("전환")}
        busy={voiceTarget !== null && (voiceTarget.activeCount === null || busyId === voiceTarget.row.id)}
        onCancel={() => setVoiceTarget(null)}
        onConfirm={() => { if (voiceTarget) return assignVoiceProvider(voiceTarget.row, voiceTarget.voiceProvider); }}
      />
    </section>
  );
}
