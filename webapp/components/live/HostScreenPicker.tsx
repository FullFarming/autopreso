"use client";

import { useEffect, useState } from "react";
import { loadHostScreenSessions, type HostScreenSession } from "./host-screen-sessions";
import styles from "./HostScreenPicker.module.css";

const statusLabels: Record<string, string> = { preparing: "시작 대기", live: "진행 중", paused: "일시 정지" };

export default function HostScreenPicker() {
  const [sessions, setSessions] = useState<HostScreenSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError("");
    setSessions([]);
    void loadHostScreenSessions(fetch, controller.signal).then((result) => {
      if (!controller.signal.aborted) setSessions(result);
    }).catch((requestError: unknown) => {
      if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : "세션 목록을 불러오지 못했습니다.");
    }).finally(() => {
      if (!controller.signal.aborted) setIsLoading(false);
    });
    return () => controller.abort();
  }, [refreshKey]);

  return (
    <main className={styles.page}>
      <div className={styles.content}>
        <a className={styles.back} href="/admin">NOVA</a>
        <header className={styles.heading}>
          <div><h1>QR·진행 화면</h1><p>데스크톱과 같은 계정의 세션을 선택하세요.</p></div>
          <button className={styles.button} type="button" disabled={isLoading} onClick={() => setRefreshKey((key) => key + 1)}>
            {error ? "다시 시도" : "새로고침"}
          </button>
        </header>
        <p className={styles.notice}>음성 송출은 데스크톱에서 계속됩니다.</p>
        <section aria-label="내 세션" aria-busy={isLoading}>
          {isLoading && <p role="status" className={styles.message}>세션을 불러오는 중입니다.</p>}
          {error && <div role="alert" className={styles.message}><p>{error}</p><a className={styles.button} href="/login">로그인 확인</a></div>}
          {!isLoading && !error && sessions.length === 0 && <div role="status" className={styles.message}><h2>표시할 세션이 없습니다</h2><p>데스크톱에서 세션을 만든 뒤 새로고침해 주세요.</p></div>}
          {!isLoading && !error && sessions.length > 0 && <ul className={styles.list}>
            {sessions.map((session) => <li key={session.id}>
              <a className={styles.session} href={`/stage/${session.id}`}>
                <span className={styles.sessionInfo}><strong>{session.title || "제목 없는 세션"}</strong><span>{statusLabels[session.status]}</span></span>
                <span className={styles.open}>화면 열기 <span aria-hidden="true">→</span></span>
              </a>
            </li>)}
          </ul>}
        </section>
      </div>
    </main>
  );
}
