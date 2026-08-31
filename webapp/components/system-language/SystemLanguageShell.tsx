"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SystemLanguageButton } from "./SystemLanguageButton";
import styles from "./system-language.module.css";

export function SystemLanguageShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // 2026-08-31 feat: The presentation output stays free of operator controls.
  const isPresentation = /^\/stage\//u.test(pathname ?? "");
  return <div className={styles.shell} data-presentation={isPresentation}>
    {!isPresentation && <header className={styles.bar}><SystemLanguageButton /></header>}
    <div className={styles.content}>{children}</div>
  </div>;
}
