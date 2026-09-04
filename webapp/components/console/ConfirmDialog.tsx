"use client";

import { useEffect, useId, useRef, type ReactNode, type SyntheticEvent } from "react";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { consoleMessages } from "@/lib/system-language/console-messages";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Native `<dialog>` opened with `showModal()`: focus is trapped by the browser, `Escape` fires
 * `cancel` (which we route to `onCancel` so React state stays the source of truth), and the
 * destructive action is never the first focusable element - 취소 comes first and takes focus.
 */
export function ConfirmDialog({ open, title, body, confirmLabel, busy = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const t = useSystemText(consoleMessages);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    // Keep the element open until state says otherwise; the effect above closes it.
    event.preventDefault();
    if (!busy) onCancel();
  }

  return (
    <dialog ref={dialogRef} className="console-dialog" aria-labelledby={titleId} onCancel={handleCancel}>
      <h2 id={titleId}>{title}</h2>
      <div className="console-dialog-body">{body}</div>
      <div className="console-dialog-actions">
        <button ref={cancelRef} type="button" className="glass-btn" autoFocus disabled={busy} onClick={onCancel}>{t("취소")}</button>
        <button type="button" className="console-danger" disabled={busy} aria-busy={busy} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}
