"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { viewerMessages } from "@/lib/system-language/viewer-messages";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./translation.module.css";

interface ControlDrawerProps {
  triggerLabel: string;
  title: string;
  children: ReactNode;
}

export function ControlDrawer({ triggerLabel, title, children }: ControlDrawerProps) {
  const t = useSystemText(viewerMessages);
  const [isOpen, setIsOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  function closeDrawer() {
    setIsOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <>
      <button ref={triggerRef} className={styles.secondaryButton} type="button" onClick={() => setIsOpen(true)}>
        {triggerLabel}
      </button>
      {isOpen && typeof document !== "undefined" && createPortal(<dialog
        ref={dialogRef}
        className={`live-modal-root ${styles.drawer}`}
        aria-labelledby={titleId}
        onCancel={(event) => { event.preventDefault(); closeDrawer(); }}
        onClose={() => { if (isOpen) setIsOpen(false); }}
      >
        <header className={styles.drawerHeader}>
          <h2 id={titleId}>{title}</h2>
          <button className={styles.secondaryButton} type="button" onClick={closeDrawer}>{t("닫기")}</button>
        </header>
        <div className={styles.drawerBody}>{children}</div>
      </dialog>, document.body)}
    </>
  );
}
