"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { useSystemLanguage, useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { SYSTEM_LOCALES } from "@/lib/system-language";
import { inviteMessages } from "@/lib/system-language/invite-messages";
import type { HostInvitation } from "./invite-share";
import styles from "./InviteQrDialog.module.css";

export const INVITE_QR_OPTIONS = { width: 1024, margin: 4, errorCorrectionLevel: "M" as const, color: { dark: "#000000", light: "#ffffff" } };

export function getValidQrInvitation(invitation: HostInvitation | null, now: number): HostInvitation | null {
  if (!invitation || !/^[0-9]{6}$/u.test(invitation.admissionCode) || !(Date.parse(invitation.expiresAt) > now)
    || !invitation.url || invitation.url.length > 4096) return null;
  try {
    const url = new URL(invitation.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
  } catch { return null; }
  return invitation;
}

export function InviteQrDialog({ sessionTitle, invitation, onClose }: { sessionTitle: string; invitation: HostInvitation | null; onClose: () => void }) {
  const t = useSystemText(inviteMessages);
  const { language } = useSystemLanguage();
  const titleId = useId();
  const helpId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [canFullscreen, setCanFullscreen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasFullscreenError, setHasFullscreenError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [qr, setQr] = useState<{ key: string; dataUrl: string; hasError: boolean }>({ key: "", dataUrl: "", hasError: false });
  const current = getValidQrInvitation(invitation, Math.max(now, Date.now()));
  const invitationKey = current ? JSON.stringify([current.sessionId, current.url, current.admissionCode, current.expiresAt]) : "";
  const invitationUrl = current?.url ?? "";
  const expiresAt = invitation?.expiresAt;

  useEffect(() => { setIsMounted(true); }, []);
  useEffect(() => {
    if (!isMounted) return;
    const dialog = dialogRef.current;
    const surface = surfaceRef.current;
    if (!dialog || !surface) return;
    const previousFocus = document.activeElement;
    dialog.showModal();
    closeRef.current?.focus();
    setCanFullscreen(Boolean(document.fullscreenEnabled && typeof surface.requestFullscreen === "function"));
    const receiveFullscreenChange = () => setIsFullscreen(document.fullscreenElement === surface);
    document.addEventListener("fullscreenchange", receiveFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", receiveFullscreenChange);
      if (document.fullscreenElement === surface) void document.exitFullscreen().catch(() => undefined);
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [isMounted]);

  useEffect(() => {
    const remaining = Date.parse(expiresAt ?? "") - Date.now();
    if (!(remaining > 0)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining, 2_147_483_647));
    const receiveVisibility = () => { if (document.visibilityState === "visible") setNow(Date.now()); };
    document.addEventListener("visibilitychange", receiveVisibility);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", receiveVisibility); };
  }, [expiresAt, now]);

  useEffect(() => {
    let isCurrent = true;
    setQr({ key: invitationKey, dataUrl: "", hasError: false });
    if (invitationUrl) void QRCode.toDataURL(invitationUrl, INVITE_QR_OPTIONS).then(
      (dataUrl) => { if (isCurrent) setQr({ key: invitationKey, dataUrl, hasError: false }); },
      () => { if (isCurrent) setQr({ key: invitationKey, dataUrl: "", hasError: true }); },
    );
    return () => { isCurrent = false; };
  }, [invitationKey, invitationUrl, retry]);

  async function toggleFullscreen() {
    const surface = surfaceRef.current;
    if (!surface) return;
    setHasFullscreenError(false);
    try {
      if (document.fullscreenElement === surface) await document.exitFullscreen();
      else await surface.requestFullscreen();
    } catch {
      setHasFullscreenError(true);
    }
  }

  if (!isMounted) return null;
  const image = current && qr.key === invitationKey ? qr.dataUrl : "";
  const hasQrError = current && qr.key === invitationKey && qr.hasError;
  return createPortal(<dialog ref={dialogRef} className={`live-modal-root ${styles.dialog}`} aria-modal="true" aria-labelledby={titleId}
    aria-describedby={helpId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div ref={surfaceRef} className={styles.surface}>
      <header className={styles.header}>
        <div className={styles.heading}><h2 id={titleId}>{t("참여 QR 코드")}</h2><p>{sessionTitle}</p></div>
        <div className={styles.actions}>
          {canFullscreen && <button type="button" onClick={() => { void toggleFullscreen(); }}>{t(isFullscreen ? "전체 화면 종료" : "전체 화면")}</button>}
          <button ref={closeRef} type="button" onClick={onClose}>{t("닫기")}</button>
        </div>
      </header>
      <div className={styles.body}>
        {!current ? <p role="status" id={helpId}>{t(invitation && Date.parse(invitation.expiresAt) <= Date.now()
          ? "입장 시간이 만료되었습니다. 다시 사용하려면 입장 시간을 연장해 주세요."
          : "현재 사용할 수 있는 초대가 없습니다. 초대 상태를 확인해 주세요.")}</p>
          : <>
            {image ? <img className={styles.qr} src={image} width={1024} height={1024} alt={t("NOVA 참여자 초대 QR 코드")} />
              : hasQrError ? <div className={styles.error}><p role="alert">{t("QR 코드를 만들지 못했습니다. 다시 시도해 주세요.")}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>{t("다시 시도")}</button></div>
                : <p role="status">{t("QR 코드 생성 중…")}</p>}
            <div className={styles.accessCode}><span>{t("인증 코드")}</span><strong>{current.admissionCode}</strong></div>
            <p id={helpId} className={styles.help}>{t("QR을 스캔한 뒤 참여 정보를 입력해 주세요.")}</p>
            <p className={styles.deadline}>{t("{date}까지 입장 가능", { date: new Intl.DateTimeFormat(SYSTEM_LOCALES[language], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(current.expiresAt)) })}</p>
          </>}
        {hasFullscreenError && <p role="status" className={styles.help}>{t("전체 화면으로 전환하지 못했어요. 이 확대 창에서 QR을 계속 사용할 수 있어요.")}</p>}
      </div>
    </div>
  </dialog>, document.body);
}
