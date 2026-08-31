"use client";

import { useState, type ReactNode } from "react";

import styles from "./workspace-viewport.module.css";

export default function WorkspaceViewport({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState(100);

  return (
    <section className={`live-workspace-viewport ${styles.viewport}`} aria-label="관리자 작업 화면">
      <div className={styles.toolbar} role="group" aria-label="작업 화면 크기">
        <span>화면 크기</span>
        <button type="button" aria-label="작업 화면 축소" disabled={scale === 50}
          onClick={() => setScale((current) => Math.max(50, current - 10))}>−</button>
        <button type="button" className={styles.reset} aria-label={`작업 화면 ${scale}%, 100%로 초기화`}
          onClick={() => setScale(100)}><output aria-live="polite">{scale}%</output></button>
        <button type="button" aria-label="작업 화면 확대" disabled={scale === 150}
          onClick={() => setScale((current) => Math.min(150, current + 10))}>+</button>
      </div>
      <div className={styles.scroller} role="region" aria-label="관리자 작업 내용, 가로 세로 스크롤 가능" tabIndex={0}>
        <div className={styles.canvas} style={{ zoom: scale / 100, width: `max(1100px, ${10000 / scale}%)` }}>
          {children}
        </div>
      </div>
    </section>
  );
}
