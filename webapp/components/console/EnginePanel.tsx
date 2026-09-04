"use client";

import { useCallback, useEffect, useId, useState } from "react";

import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import type { EngineSelection } from "@/lib/console/engine-defaults";
import { SYSTEM_LOCALES } from "@/lib/system-language";
import { consoleMessages } from "@/lib/system-language/console-messages";

import { ConfirmDialog } from "./ConfirmDialog";
import { consoleErrorKey, consoleFetch } from "./console-client";
import {
  countActiveSessions,
  filterTranslationOptions,
  formatConsoleDate,
  isEngineDirty,
  languageModeLabelKey,
  languageModesFor,
  reconcileEngineSelection,
  type ConsoleEngineCatalog,
  type ConsoleEngineCatalogEntry,
} from "./console-model";

interface EngineDefaultsResponse { engine: EngineSelection; catalog: ConsoleEngineCatalog; updatedAt: string | null; updatedByEmail: string | null }
/** `results` arrives once Task 6 pushes the engine to running sessions; until then the PUT returns `{ engine }` only. */
interface DeployResult { sessionId: string; result: "switched" | "queued" | "failed"; code?: string }
interface EnginePutResponse { engine: EngineSelection; results?: DeployResult[] }
interface SettingsResponse { legacyPasswordLoginEnabled: boolean; warning?: string }
interface SessionsResponse { sessions: { status: string }[] }

const RESULT_LABEL_KEYS: Record<DeployResult["result"], string> = { switched: "전환됨", queued: "대기열", failed: "실패" };

function entryKey(entry: Pick<ConsoleEngineCatalogEntry, "provider" | "model">): string {
  return `${entry.provider}/${entry.model}`;
}

function findEntry(entries: readonly ConsoleEngineCatalogEntry[], key: string): ConsoleEngineCatalogEntry | null {
  return entries.find((entry) => entryKey(entry) === key) ?? null;
}

/**
 * `/console/engine` (spec §9): one global Live Call engine, deployed with "배포". The confirm
 * dialog names how many `preparing`/`live` sessions switch immediately, and the panel shows the
 * per-session result table when the server returns one. Also hosts the account section with the
 * legacy password-login switch. Nothing is stored locally until the server has answered.
 */
export function EnginePanel() {
  const t = useSystemText(consoleMessages);
  const { language } = useSystemLanguage();
  const locale = SYSTEM_LOCALES[language];
  const headingId = useId();
  const accountHeadingId = useId();
  const [catalog, setCatalog] = useState<ConsoleEngineCatalog | null>(null);
  const [saved, setSaved] = useState<EngineSelection | null>(null);
  const [draft, setDraft] = useState<EngineSelection | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [updatedByEmail, setUpdatedByEmail] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployStatus, setDeployStatus] = useState<string | null>(null);
  const [results, setResults] = useState<DeployResult[] | null>(null);
  const [activeCount, setActiveCount] = useState<number | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [isCounting, setIsCounting] = useState(false);
  const [legacyLogin, setLegacyLogin] = useState<boolean | null>(null);
  const [isLegacyConfirmOpen, setIsLegacyConfirmOpen] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<string | null>(null);

  const loadEngine = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await consoleFetch<EngineDefaultsResponse>("/api/console/engine-defaults");
      setCatalog(data.catalog);
      setSaved(data.engine);
      setDraft(data.engine);
      setUpdatedAt(data.updatedAt);
      setUpdatedByEmail(data.updatedByEmail);
    } catch (error) {
      setLoadError(consoleErrorKey(error, "엔진 설정을 불러오지 못했습니다."));
    }
  }, []);

  const loadSettings = useCallback(async () => {
    setSettingsError(null);
    try {
      const data = await consoleFetch<SettingsResponse>("/api/console/settings");
      setLegacyLogin(data.legacyPasswordLoginEnabled);
    } catch (error) {
      setSettingsError(consoleErrorKey(error, "설정을 불러오지 못했습니다."));
    }
  }, []);

  useEffect(() => { void loadEngine(); void loadSettings(); }, [loadEngine, loadSettings]);

  const isDirty = isEngineDirty(saved, draft);

  function updateDraft(next: EngineSelection) {
    if (!catalog) return;
    setDraft(reconcileEngineSelection(catalog, next));
    setDeployStatus(null);
    setResults(null);
  }

  async function openDeployConfirm() {
    setIsCounting(true);
    setDeployError(null);
    try {
      const data = await consoleFetch<SessionsResponse>("/api/console/sessions?range=7d");
      setActiveCount(countActiveSessions(data.sessions));
    } catch {
      // The count is advisory; the dialog still opens and says the number is unknown.
      setActiveCount(null);
    } finally {
      setIsCounting(false);
      setIsConfirmOpen(true);
    }
  }

  async function deploy() {
    if (!draft) return;
    setIsDeploying(true);
    setDeployError(null);
    setDeployStatus(null);
    setResults(null);
    try {
      const data = await consoleFetch<EnginePutResponse>("/api/console/engine-defaults", { method: "PUT", body: { engine: draft } });
      setIsConfirmOpen(false);
      setSaved(data.engine);
      setDraft(data.engine);
      if (Array.isArray(data.results)) setResults(data.results);
      else setDeployStatus("배포했습니다.");
      // The PUT answers with the engine only; the author and time come back from the read.
      await loadEngine();
    } catch (error) {
      setDeployError(consoleErrorKey(error, "엔진을 배포하지 못했습니다."));
    } finally {
      setIsDeploying(false);
    }
  }

  async function saveLegacyLogin(enabled: boolean) {
    setIsSavingSettings(true);
    setSettingsError(null);
    setSettingsStatus(null);
    try {
      const data = await consoleFetch<SettingsResponse>("/api/console/settings", { method: "PUT", body: { legacyPasswordLoginEnabled: enabled } });
      setIsLegacyConfirmOpen(false);
      setLegacyLogin(data.legacyPasswordLoginEnabled);
      setSettingsStatus(data.warning === "LEGACY_LOGIN_DISABLED_WARNING" ? "레거시 로그인이 꺼졌습니다. 비밀번호 로그인은 더 이상 동작하지 않습니다." : "설정을 저장했습니다.");
    } catch (error) {
      setSettingsError(consoleErrorKey(error, "설정을 저장하지 못했습니다."));
    } finally {
      setIsSavingSettings(false);
    }
  }

  function renderOptions(entries: readonly ConsoleEngineCatalogEntry[]) {
    return entries.map((entry) => (
      <option key={entryKey(entry)} value={entryKey(entry)} disabled={entry.available === false}>
        {entry.available === false ? `${entry.label} · ${t("API 키 없음")}` : entry.label}
      </option>
    ));
  }

  const translationOptions = catalog && draft ? filterTranslationOptions(catalog, draft.stt.provider) : [];
  const languageModes = catalog && draft ? languageModesFor(catalog, draft.stt.provider, draft.stt.model) : ["auto"];

  return (
    <>
      <section className="glass live-panel console-panel" aria-labelledby={headingId}>
        <div className="live-section-heading">
          <h2 id={headingId}>{t("라이브 콜 엔진 기본값")}</h2>
        </div>
        <p className="live-help">{t("배포하면 새 세션과 진행 중인 세션 모두 이 엔진으로 즉시 전환됩니다. 호스트는 엔진을 바꿀 수 없습니다.")}</p>
        {loadError && (
          <div className="live-error" role="alert">
            <span>{t(loadError)}</span>
            <button type="button" className="glass-btn" onClick={() => void loadEngine()}>{t("다시 시도")}</button>
          </div>
        )}
        {catalog && draft && (
          <div className="console-engine-grid">
            <label className="console-field">
              <span>{t("음성 인식 (STT)")}</span>
              <select value={entryKey(draft.stt)} disabled={isDeploying}
                onChange={(event) => {
                  const entry = findEntry(catalog.stt, event.target.value);
                  if (entry) updateDraft({ ...draft, stt: { provider: entry.provider, model: entry.model, languageMode: draft.stt.languageMode } });
                }}>
                {renderOptions(catalog.stt)}
              </select>
            </label>
            <label className="console-field">
              <span>{t("입력 언어 모드")}</span>
              <select value={draft.stt.languageMode} disabled={isDeploying || languageModes.length <= 1}
                onChange={(event) => updateDraft({ ...draft, stt: { ...draft.stt, languageMode: event.target.value } })}>
                {languageModes.map((mode) => <option key={mode} value={mode}>{t(languageModeLabelKey(mode))}</option>)}
              </select>
            </label>
            <label className="console-field">
              <span>{t("번역")}</span>
              <select value={entryKey(draft.translation)} disabled={isDeploying}
                onChange={(event) => {
                  const entry = findEntry(translationOptions, event.target.value);
                  if (entry) updateDraft({ ...draft, translation: { provider: entry.provider, model: entry.model } });
                }}>
                {renderOptions(translationOptions)}
              </select>
            </label>
            <label className="console-field">
              <span>{t("요약")}</span>
              <select value={entryKey(draft.summary)} disabled={isDeploying}
                onChange={(event) => {
                  const entry = findEntry(catalog.summary, event.target.value);
                  if (entry) updateDraft({ ...draft, summary: { provider: entry.provider, model: entry.model } });
                }}>
                {renderOptions(catalog.summary)}
              </select>
            </label>
          </div>
        )}
        <div className="console-deploy-row">
          <button type="button" className="accent-btn live-primary-action" disabled={!isDirty || isDeploying || isCounting} aria-busy={isDeploying || isCounting}
            onClick={() => void openDeployConfirm()}>
            {isDeploying ? t("배포 중…") : t("배포")}
          </button>
          <p className="live-help console-last-change">
            {updatedAt ? t("마지막 변경: {email} · {time}", { email: updatedByEmail ?? "—", time: formatConsoleDate(updatedAt, locale) }) : t("아직 배포한 적이 없습니다. 카탈로그 기본값이 적용됩니다.")}
          </p>
        </div>
        {deployError && <p className="live-error" role="alert">{t(deployError)}</p>}
        {deployStatus && <p className="console-status-line" role="status">{t(deployStatus)}</p>}
        {results && (
          <div className="console-table-wrap">
            <table className="console-table" aria-label={t("세션별 전환 결과")}>
              <caption>{t("세션별 전환 결과")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("세션 ID")}</th>
                  <th scope="col">{t("결과")}</th>
                  <th scope="col">{t("코드")}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row) => (
                  <tr key={row.sessionId}>
                    <td className="console-num">{row.sessionId}</td>
                    <td><span className={`console-status console-result-${row.result}`}>{t(RESULT_LABEL_KEYS[row.result])}</span></td>
                    <td>{row.code ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ConfirmDialog
          open={isConfirmOpen}
          title={t("엔진 배포")}
          body={<p>{t("진행 중인 세션 {count}개가 즉시 전환됩니다.", { count: activeCount === null ? "?" : activeCount })}</p>}
          confirmLabel={t("배포")}
          busy={isDeploying}
          onCancel={() => setIsConfirmOpen(false)}
          onConfirm={() => void deploy()}
        />
      </section>

      <section className="glass live-panel console-panel" aria-labelledby={accountHeadingId}>
        <div className="live-section-heading">
          <h2 id={accountHeadingId}>{t("계정")}</h2>
        </div>
        {settingsError && (
          <div className="live-error" role="alert">
            <span>{t(settingsError)}</span>
            <button type="button" className="glass-btn" onClick={() => void loadSettings()}>{t("다시 시도")}</button>
          </div>
        )}
        <label className="live-setting-row live-capability-switch console-switch-row">
          <span>
            <strong>{t("레거시 비밀번호 로그인")}</strong>
            <small>{t("ADMIN_USER_IDS 기반 비밀번호 로그인을 허용합니다. 끄면 Supabase 계정으로만 로그인할 수 있습니다.")}</small>
          </span>
          <input type="checkbox" checked={legacyLogin === true} disabled={legacyLogin === null || isSavingSettings} aria-busy={isSavingSettings}
            onChange={(event) => { if (event.target.checked) void saveLegacyLogin(true); else setIsLegacyConfirmOpen(true); }} />
        </label>
        {settingsStatus && <p className="console-status-line" role="status">{t(settingsStatus)}</p>}
        <ConfirmDialog
          open={isLegacyConfirmOpen}
          title={t("레거시 로그인을 끌까요?")}
          body={<p>{t("비밀번호로 로그인한 호스트는 다음 요청부터 거부됩니다. 관리자 계정이 Supabase로 로그인할 수 있는지 먼저 확인하세요.")}</p>}
          confirmLabel={t("끄기")}
          busy={isSavingSettings}
          onCancel={() => setIsLegacyConfirmOpen(false)}
          onConfirm={() => void saveLegacyLogin(false)}
        />
      </section>
    </>
  );
}
