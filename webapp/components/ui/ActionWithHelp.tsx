"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import styles from "./ActionWithHelp.module.css";

export function ActionWithHelp({ children, label, help }: { children: ReactNode; label: string; help: string }) {
  const [isOpen, setOpen] = useState(false);
  const helpId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [isOpen]);
  return <div className={styles.group} ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={(event) => {
    if (event.key === "Escape" && isOpen) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    }
  }}>
    <div className={styles.action}>{children}</div>
    <button ref={trigger} type="button" className={styles.helpButton} aria-label={label}
      aria-expanded={isOpen} aria-controls={helpId} onClick={() => setOpen((open) => !open)}>?</button>
    <p className={styles.description} id={helpId} hidden={!isOpen} tabIndex={isOpen ? 0 : undefined}>{help}</p>
  </div>;
}
