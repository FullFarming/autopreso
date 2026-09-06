"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent, type KeyboardEvent } from "react";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { consoleMessages } from "@/lib/system-language/console-messages";

import styles from "./ConfirmDialog.module.css";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  variant: "primary" | "destructive";
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Native `<dialog>` opened with `showModal()`: focus is trapped by the browser, `Escape` fires
 * `cancel` (which we route to `onCancel` so React state stays the source of truth), and the
 * destructive action is never the first focusable element - 취소 comes first and takes focus.
 */
export function ConfirmDialog({ open, title, body, confirmLabel, busy = false, variant, onConfirm, onCancel }: ConfirmDialogProps) {
  const t = useSystemText(consoleMessages);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const confirmingRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const isPending = busy || isConfirming;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    // Keep the element open until state says otherwise; the effect above closes it.
    event.preventDefault();
    if (!busy && !confirmingRef.current) onCancel();
  }

  function handleClose() {
    // Chromium ignores preventDefault() on a second Escape and closes the element anyway. If React
    // still believes the dialog is open, `open && !dialog.open` never becomes true again and the
    // dialog can never reopen - so any native close resyncs state, busy or not (the element is
    // already gone; keeping the request's busy flag alive is the panel's job).
    if (open) onCancel();
    const trigger = returnFocusRef.current;
    if (trigger?.isConnected) trigger.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getClientRects().length > 0 && element.tabIndex >= 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first) {
      event.preventDefault();
      event.currentTarget.focus();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
      event.preventDefault();
      first.focus();
    }
  }

  async function handleConfirm() {
    if (busy || confirmingRef.current) return;
    confirmingRef.current = true;
    setIsConfirming(true);
    try {
      await onConfirm();
    } finally {
      confirmingRef.current = false;
      setIsConfirming(false);
    }
  }

  return (
    <dialog ref={dialogRef} className={`console-dialog ${styles.dialog}`} aria-labelledby={titleId} aria-describedby={bodyId} aria-busy={isPending} tabIndex={-1} onKeyDown={handleKeyDown} onCancel={handleCancel} onClose={handleClose}>
      <div className={styles.content}>
        <h2 id={titleId}>{title}</h2>
        <div id={bodyId} className="console-dialog-body">{body}</div>
      </div>
      <div className={`console-dialog-actions ${styles.actions}`}>
        <button ref={cancelRef} type="button" className="glass-btn" autoFocus disabled={isPending} onClick={() => { if (!confirmingRef.current && !busy) onCancel(); }}>{t("취소")}</button>
        <button type="button" className={variant === "destructive" ? "console-danger" : "accent-btn live-primary-action"} disabled={isPending} aria-busy={isPending} onClick={() => void handleConfirm()}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}
