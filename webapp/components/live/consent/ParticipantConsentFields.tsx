"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { viewerMessages } from "@/lib/system-language/viewer-messages";

import { useId } from "react";

import styles from "./participant-consent-fields.module.css";

export interface ConsentNoticePresentation {
  version: string;
  text: string;
}

interface ParticipantConsentFieldsProps {
  privacyConsent: boolean;
  summaryDeliveryConsent: boolean;
  marketingConsent: boolean;
  notices: {
    privacy: ConsentNoticePresentation;
    summaryDelivery: ConsentNoticePresentation;
    marketing: ConsentNoticePresentation;
  };
  onPrivacyConsentChange: (value: boolean) => void;
  onSummaryDeliveryConsentChange: (value: boolean) => void;
  onMarketingConsentChange: (value: boolean) => void;
}

export function ParticipantConsentFields({
  privacyConsent,
  summaryDeliveryConsent,
  marketingConsent,
  notices,
  onPrivacyConsentChange,
  onSummaryDeliveryConsentChange,
  onMarketingConsentChange,
}: ParticipantConsentFieldsProps) {
  const t = useSystemText(viewerMessages);
  const id = useId().replaceAll(":", "");
  return (
    <fieldset className={styles.root}>
      <legend>{t("참여 동의")}</legend>
      <div className={styles.choice}>
        <label htmlFor={`${id}-privacy`}>
          <input id={`${id}-privacy`} name="privacyConsent" type="checkbox" required checked={privacyConsent}
            aria-describedby={`${id}-privacy-notice`}
            onChange={(event) => onPrivacyConsentChange(event.currentTarget.checked)} />
          <span><strong>{t("필수")}</strong> {t("개인정보 수집 및 이용 동의")}</span>
        </label>
        <details><summary>{t("내용 보기")}</summary><p id={`${id}-privacy-notice`}>v{notices.privacy.version} · {t(notices.privacy.text)}</p></details>
      </div>
      <div className={styles.choice}>
        <label htmlFor={`${id}-summary`}>
          <input id={`${id}-summary`} name="summaryDeliveryConsent" type="checkbox" checked={summaryDeliveryConsent}
            aria-describedby={`${id}-summary-notice`}
            onChange={(event) => onSummaryDeliveryConsentChange(event.currentTarget.checked)} />
          <span><strong>{t("선택")}</strong> {t("회의 요약 이메일 수신")}</span>
        </label>
        <details><summary>{t("내용 보기")}</summary><p id={`${id}-summary-notice`}>v{notices.summaryDelivery.version} · {t(notices.summaryDelivery.text)}</p></details>
      </div>
      <div className={styles.choice}>
        <label htmlFor={`${id}-marketing`}>
          <input id={`${id}-marketing`} name="marketingConsent" type="checkbox" checked={marketingConsent}
            aria-describedby={`${id}-marketing-notice`}
            onChange={(event) => onMarketingConsentChange(event.currentTarget.checked)} />
          <span><strong>{t("선택")}</strong> {t("마케팅 정보 수신")}</span>
        </label>
        <details><summary>{t("내용 보기")}</summary><p id={`${id}-marketing-notice`}>v{notices.marketing.version} · {t(notices.marketing.text)}</p></details>
      </div>
    </fieldset>
  );
}
