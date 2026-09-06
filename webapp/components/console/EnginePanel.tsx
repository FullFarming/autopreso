"use client";

import { useCallback, useEffect, useId, useState } from "react";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { consoleMessages } from "@/lib/system-language/console-messages";

import { ConfirmDialog } from "./ConfirmDialog";
import { consoleErrorKey, consoleFetch } from "./console-client";

interface SettingsResponse { legacyPasswordLoginEnabled: boolean; warning?: string }

/**
 * `/console/engine`. D1 (2026-09-05) retired the global engine: the Live Call engine is assigned
 * per user from the users table and applies to that user's running sessions immediately, so this
 * page only states the default and links there. The account section (legacy login switch) stays.
 */
export function EnginePanel() {
  const t = useSystemText(consoleMessages);
  const headingId = useId();
  const accountHeadingId = useId();
  const [legacyLogin, setLegacyLogin] = useState<boolean | null>(null);
  const [isLegacyConfirmOpen, setIsLegacyConfirmOpen] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setSettingsError(null);
    try {
      const data = await consoleFetch<SettingsResponse>("/api/console/settings");
      setLegacyLogin(data.legacyPasswordLoginEnabled);
    } catch (error) {
      setSettingsError(consoleErrorKey(error, "설정을 불러오지 못했습니다."));
    }
  }, []);

  useEffect(() => { void loadSettings(); }, [loadSettings]);

  async function saveLegacyLogin(enabled: boolean) {
    setIsSavingSettings(true);
    setSettingsError(null);
    setSettingsStatus(null);
    try {
      const data = await consoleFetch<SettingsResponse>("/api/console/settings", { method: "PUT", body: { legacyPasswordLoginEnabled: enabled } });
      setLegacyLogin(data.legacyPasswordLoginEnabled);
      setSettingsStatus(data.warning === "LEGACY_LOGIN_DISABLED_WARNING" ? "레거시 로그인이 꺼졌습니다. 비밀번호 로그인은 더 이상 동작하지 않습니다." : "설정을 저장했습니다.");
    } catch (error) {
      setSettingsError(consoleErrorKey(error, "설정을 저장하지 못했습니다."));
    } finally {
      // Close on failure as well, so the inline alert is not hidden behind the dialog backdrop.
      setIsLegacyConfirmOpen(false);
      setIsSavingSettings(false);
    }
  }

  return (
    <>
      <section className="glass live-panel console-panel" aria-labelledby={headingId}>
        <div className="live-section-heading">
          <h2 id={headingId}>{t("라이브 콜 엔진")}</h2>
        </div>
        <p className="live-help">{t("기본 엔진: Soniox 인식+번역. 사용자별 엔진은 사용자 탭에서 바꾸며 즉시 적용됩니다.")}</p>
        <div className="console-row-actions">
          <a className="glass-btn" href="/console/users">{t("사용자 탭으로")}</a>
        </div>
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
          variant="destructive"
          open={isLegacyConfirmOpen}
          title={t("레거시 로그인을 끌까요?")}
          body={<p>{t("비밀번호로 로그인한 호스트는 다음 요청부터 거부됩니다. 관리자 계정이 Supabase로 로그인할 수 있는지 먼저 확인하세요.")}</p>}
          confirmLabel={t("끄기")}
          busy={isSavingSettings}
          onCancel={() => setIsLegacyConfirmOpen(false)}
          onConfirm={() => saveLegacyLogin(false)}
        />
      </section>
    </>
  );
}
