import type { ReactNode } from "react";
import styles from "./translation.module.css";

interface TranslationToolbarProps {
  children: ReactNode;
  ariaLabel?: string;
}

export function TranslationToolbar({ children, ariaLabel = "Translation controls" }: TranslationToolbarProps) {
  return <div className={styles.toolbar} role="toolbar" aria-label={ariaLabel}>{children}</div>;
}

