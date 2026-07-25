# Live Media Reliability Evidence — 2026-07-19

이 기록은 `live-media-reliability-loop.md`를 로컬 fake provider와 합성 PCM에만 적용한 결과다.
실제 Google·Supabase 호출, 실제 음성·자막 데이터, migration, 배포는 사용하지 않았다.

## Loop 0 — Baseline

- Source: 시작 전 관련 파일 SHA-256, `git status`, 관련 diff를
  `/tmp/realtime-noel-loop-2026-07-19T12-10-47-231Z`에 기록했다.
- Before: `media-gateway` 26/26, root live UI 8/8, `webapp test:live` 11/11 PASS.
- Candidate: unary TTS, 고정 재연결, heartbeat·연결 중 token 만료 부재, server/browser 출력
  buffer의 silent drop 또는 무상한 대기.
- Outcome: 다음 결함이 각각 독립 재현되어 bounded cycle로 진행.

## Loop 1 — Streaming TTS and PCM

- Action: Chirp 3 HD v1 양방향 streaming만 허용하고 UTF-8 4,999-byte 자연 경계 분할,
  arbitrary response boundary 누적, PCM16 conditioning, 정확한 250 ms frame을 구현했다.
- Evidence: 첫 audio frame이 request stream 종료 전에 전달됨, CJK·emoji 무손실 분할, odd-byte carry,
  고정 voice와 언어별 순서 보장을 fake provider test로 검증했다.
- Independent finding: provider stall과 내부 response queue 상한이 처음 구현에 빠져 추가 cycle로 이동했다.
- Outcome: `SUCCESS`; 독립된 후속 결함은 새 cycle 후보로 분리했다.

## Loop 2 — Connection ownership and recovery

- Action: heartbeat/pong, HOST token hard expiry, bounded exponential backoff+jitter, proactive token refresh,
  Gemini generation ownership, slow viewer의 가시적 `SLOW_CONSUMER` 종료를 구현했다.
- Evidence: stale socket 종료, 만료 token 종료, 이전 Gemini callback 무효화, 교체 session close-once,
  malformed/near-expiry credential의 tight loop 차단을 test로 검증했다.
- Independent finding: 동시 host 교체, VIEWER hard expiry/single-flight, shutdown cleanup-once가 처음 구현에
  빠져 추가 cycle로 이동했다.
- Outcome: `SUCCESS`; 독립된 후속 결함은 새 cycle 후보로 분리했다.

## Loop 3 — Browser playback and disclosure

- Action: WebAudio의 projected queue duration을 3초로 제한하고 예약 source/socket/timer를 정리하며,
  server·browser slow-consumer를 terminal 오류로 표시했다. Host, Viewer, PiP, Chrome에
  `AI 합성 통역 음성`과 사용자 동작 재생 조건을 표시했다.
- Evidence: root live UI test, web typecheck, desktop `/watch`, 390×844 `/m/watch`, Host 세 모드 실제 클릭을
  로컬 브라우저에서 검증했다. 5자리 입장번호는 submit 불가 상태를 유지했다.
- Outcome: `SUCCESS`.

## Independent verification findings

초기 생성자와 분리된 Security Agent가 최신 소스를 다시 읽어 다음 후속 결함을 재현했다.

1. stalled TTS hard deadline·response buffer 상한 부재.
2. 동시 host 교체 또는 교체 실패 시 pipeline orphan 가능성.
3. VIEWER 만료 hard bound·authorize single-flight 부재.
4. shutdown timer cleanup 호출 중복.

이 네 항목은 측정 가능한 새 증거이므로 한 번 더 TDD cycle을 수행한다. 같은 finding이 반복되거나
focused/full gate가 개선되지 않으면 `STAGNATED`로 멈춘다.

## Loop 4 — Provider cancellation and connection ownership

- Action: Townhall TTS에 실제 `AbortController` 기반 3초 hard deadline, PCM16 3초분인 144KB 응답
  buffer 상한, disconnect 취소를 적용했다. 호스트 교체를 세션별 직렬화하고 VIEWER hard expiry,
  재인증 timeout·single-flight, cleanup-once를 구현했다.
- Evidence: provider 무응답·drain 정지·응답 범람, 동시·실패·shutdown host 교체, VIEWER 만료와
  재인증 정지를 fake provider test로 재현했다.
- Independent finding: session host 작업 대기열 상한과 start deadline, close 실패 후 재시도 가능성이
  추가 보강 대상으로 확인됐다.
- Outcome: `SUCCESS`; 독립된 후속 결함은 새 cycle 후보로 분리했다.

## Loop 5 — Bounded host operations and retryable cleanup

- Action: 실행 중 작업 외 host 대기 작업을 세션당 8개로 제한하고 `pipelineFactory + candidate.start`에
  10초 hard deadline과 shutdown signal을 적용했다. pipeline close는 single-flight로 공유하되 성공한
  뒤에만 완료로 기록하고, 실패한 pipeline은 shutdown에서 재시도한다.
- Evidence: queue overflow, 멈춘 start, 늦게 반환된 factory, running·queued shutdown, 동시 close,
  첫 close 실패 후 재시도를 결정적 test로 검증했다.
- Independent verification: Security Agent가 최신 소스와 관련 테스트를 다시 읽고 이전 MED 두 건을
  모두 PASS로 판정했다. 새 HIGH/MED 회귀와 token·PCM·자막·transcript 로그는 발견되지 않았다.
- Outcome: `SUCCESS`.

## Final gates

| Gate | Result |
|---|---|
| `media-gateway npm test` | 59/59 PASS; audit 취약점 0건 |
| root `npm test -- --test-concurrency=1` | 513 PASS, 1 SKIP, 0 FAIL |
| root `npm run typecheck` | PASS |
| `webapp npm run test:live` | 11/11 PASS |
| `webapp npm run typecheck` | PASS |
| root live UI focused test | 14/14 PASS |
| `webapp npm run build` | PASS |
| Chrome MV3 syntax·CSP·archive | PASS |
| independent security re-review | 이전 HIGH/MED finding 6건 모두 PASS, 새 HIGH/MED 없음 |
| secret/audio/transcript log scan | PASS |

기본 병렬 root full test에서는 기존 `browser-smoke.test.js`가 한 차례 16초 제한을 넘었으나 같은 테스트의
격리 실행은 PASS했고, 전체를 `--test-concurrency=1`로 재실행한 최종 gate도 513 PASS로 완료됐다. 따라서
코드 결함이 아닌 로컬 병렬 자원 경합으로 기록한다.

로컬 fake provider 범위의 최종 terminal state는 `SUCCESS`다. 실제 provider, 개발 프로젝트,
migration 또는 배포를 사용하는 다음 행동은 `APPROVAL_REQUIRED`다.

## Adversarial Bug Hunt Report

| # | Scenario | Result | Evidence |
|---|---|---|---|
| A1 동시성 | 동시 host start/update와 queue overflow | PASS | atomic swap·최대 8개 대기·orphan 0개를 gateway test로 검증 |
| A2 권한 | 변조·만료·다른 audience/session token | PASS | HOST/VIEWER token 및 재인증 test, session/language binding |
| A3 CSRF | 누락 origin, prefix attack, port 변형 | PASS | `webapp` strict-origin test 11/11에 포함 |
| A4 XSS | 자막·오류 문자열의 HTML 실행 가능성 | PASS | React text rendering, `dangerouslySetInnerHTML`·동적 코드 실행 0건 |
| A5 SSRF | 사용자 제공 URL fetch | N/A | 새 live 경로는 사용자 URL을 입력받아 fetch하지 않음 |
| A6 입력 경계 | 1–3 언어, CJK·emoji, oversized TTS/PCM | PASS | segmentation·provider buffer·audio envelope test |
| A7 orphan | 교체 실패·shutdown·close 실패 | PASS | candidate close, close single-flight, 실패 후 재시도 test |
| A8 디바이스 | Chrome 114 MV3, `/watch`, `/m/watch`, PiP | PASS | 정적 CSP/package 검사와 로컬 desktop·390×844 클릭 시연 |

정상 시연은 Host에서 Presentation → Meeting → Townhall 전환 후 `/watch`와 `/m/watch` 진입으로
수행했다. 실패 시연은 5자리 입장번호의 submit 차단과 slow-consumer/token-expiry의 명시적 terminal
오류로 수행했다. 브라우저 콘솔의 기존 `favicon.ico` 404 외 새 오류는 없었다.
