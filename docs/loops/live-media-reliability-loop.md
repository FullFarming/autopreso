# Live Media Reliability Loop

이 문서는 공개된 [The evidence-first feature loop](https://signals.forwardfuture.com/loop-library/loops/evidence-first-feature-loop/)와
[The Loop Harness verification loop](https://signals.forwardfuture.com/loop-library/loops/loop-harness-verification-loop/)를
Realtime Noel의 라이브 미디어 경계에 맞춘 저장소 전용 adaptation이다. 공개 Loop Library 항목 자체가 아니다.

## Loop prompt

> 현재 저장소 지침과 라이브 미디어 코드·테스트·미커밋 상태를 다시 읽고, 재현 가능한 신뢰성 결함 하나만 선택한다. 실패 증거를 먼저 기록하고 가장 작은 되돌릴 수 있는 변경을 만든 뒤 focused test, media-gateway 전체 test, web live test와 typecheck를 같은 조건에서 실행한다. 독립 검증이 통과하고 증거가 개선된 경우에만 유지한다. 성공, clean no-op, stagnated, blocked, approval-required 중 하나로 멈춘다. 배포·유료 API·secret·실음성·transcript·외부 변경은 실행하지 않는다.

## Scope and authority

관찰 범위는 다음 현재 구현과 직접 관련 테스트다.

- `media-gateway/src/gateway-server.js`
- `media-gateway/src/live-media-pipeline.js`
- `media-gateway/src/google-provider-adapters.js`
- `media-gateway/src/ordered-task-queue.js`
- `webapp/components/live/live-audio-client.ts`
- `webapp/components/live/LiveViewer.tsx`
- `media-gateway/test/`와 `webapp`의 live/security tests

한 cycle은 검증 가능한 reliability action 하나만 변경한다. 다른 사용자 변경, 공개 계약, 보안 정책,
세션 데이터는 보존한다. 다음 행동은 별도 승인 없이는 금지한다.

- Cloud Run·Vercel·Supabase·Chrome 조직 배포 또는 migration 적용
- Google·Supabase 등 유료/외부 API 호출
- secret 조회·출력·교체 또는 실제 토큰 사용
- 마이크·시스템 오디오·원본 PCM·음성 특징·실제 transcript의 캡처, 저장, 재생, 전송
- production 데이터, 외부 메시지, 파괴적 명령, 검증 약화, silent fallback 추가

## One cycle

1. **Observe** — 현재 파일과 관련 테스트를 다시 읽고 source revision, dirty files, 재현 명령,
   예상/실제 결과를 ledger에 남긴다. 이전 cycle의 결론을 현재 사실로 가정하지 않는다.
2. **Choose** — 재현 가능하고 범위 안이며 한 변경으로 검증 가능한 결함 하나를 고른다.
   인증·데이터 유출·무음 손실·무한 자원 사용을 먼저 고려한다.
3. **Act** — 실패를 잡는 focused test를 먼저 만들고 최소 변경 하나만 적용한다. 공개 event shape나
   인증 경계를 바꿔야 하면 `APPROVAL_REQUIRED`로 멈춘다.
4. **Verify** — 같은 재현을 다시 실행한 뒤 아래 focused/full gate를 실행한다. 생성자와 다른 fresh
   verifier가 diff, 실패 재현, 보안 경계를 read-only로 확인해야 한다.
5. **Record** — 유지/되돌림, before/after 결과, 변경 파일, 남은 위험, terminal state를 기록한다.
6. **Repeat or stop** — 방금 cycle이 측정 가능한 개선을 만들었고 독립된 다음 결함이 확인된 경우만
   새 cycle을 시작한다. 같은 증거가 반복되면 멈춘다.

## Verification gates

변경 범위에 맞는 focused test를 먼저 실행한 뒤, 아래 기존 명령을 사용한다.

```sh
cd media-gateway && npm test
cd webapp && npm run test:live
cd webapp && npm run typecheck
```

Heartbeat·reconnect·streaming TTS 변경은 최소한 다음 결정적 시나리오를 별도 test로 증명해야 한다.

- 만료·변조·다른 세션 token은 최초 연결과 재연결에서 모두 거부된다.
- heartbeat 응답이 사라지면 socket, timer, pipeline, provider stream이 한 번만 정리된다.
- 여러 close/error 신호가 동시에 와도 reconnect 작업은 하나이고, 정해진 terminal error 뒤에는
  자동 재시도가 계속되지 않는다.
- TTS 중단·timeout·disconnect가 provider stream을 취소하고 언어 queue를 무한히 기다리지 않는다.
- 서버와 브라우저의 입력·출력 buffer가 상한을 가지며, 초과 시 명시적 error/close가 발생한다.
- Townhall PCM은 누락을 숨기지 않는다. queue deadline을 넘으면 명시적으로 중단한다.
- test와 로그는 token, admission code, caption/transcript 본문, PCM을 출력하지 않는다.

Full gate 실패, focused test만 통과, verifier 미실행은 성공이 아니다. 수동 검증이 필요하면 합성된
고정 PCM과 fake provider만 사용하며 실제 음성이나 외부 API는 사용하지 않는다.

## Evidence ledger

| Field | Required record |
|---|---|
| Source | revision, dirty files, observed files |
| Candidate | one defect, severity, expected behavior |
| Before | focused reproduction and exact result |
| Action | changed files and one bounded decision |
| After | same reproduction result |
| Full gates | each command and pass/fail/blocked |
| Independent verification | verifier result and findings |
| Privacy check | proof that no secret/audio/transcript entered artifacts or logs |
| Outcome | terminal state and one safe next action |

## Terminal states

- `SUCCESS` — focused reproduction, all applicable full gates, privacy check, independent verification pass.
- `CLEAN_NO_OP` — fresh observation finds no in-scope defect with evidence; no files change.
- `STAGNATED` — a complete cycle produces no measurable improvement or repeats the same finding; retain the
  last verified state and stop.
- `BLOCKED` — required source, dependency, deterministic check, or safe local environment is unavailable;
  report missing evidence without guessing.
- `APPROVAL_REQUIRED` — the next step touches deployment, paid/external services, secrets, real audio/transcript,
  production, migrations, destructive work, or expands the agreed interface.

Errors, exhausted retries, partial checks, silent drops, and an unverified patch never map to `SUCCESS`.

## Streaming TTS, heartbeat, and reconnect security audit

아래 표는 구현 전 baseline 감사 기록이다. 이후 streaming TTS, heartbeat, bounded reconnect와 fail-closed
buffer 처리를 구현하고 반복 검증했으므로 현재 결과는
[`2026-07-19-live-media-evidence.md`](./2026-07-19-live-media-evidence.md)의 최종 gate와 독립 재감사를 따른다.

| Check | Status | Current evidence | Recommendation before acceptance |
|---|---|---|---|
| Initial token integrity and audience | PASS | `token-verifier.js` uses HMAC timing-safe comparison and checks HOST audience/TTL; viewer subscription is session-bound in `gateway-server.js:121-127`. | Preserve these checks for every replacement socket. |
| Auth expiry during a long socket | VIOLATION | `gateway-server.js:52-59` verifies once; heartbeat cannot currently expire HOST authorization. Viewer DB grant is rechecked every 30 seconds at `136-142`. | Store the authenticated expiry, close or require fresh authentication at expiry, and never let pong extend authorization. |
| Reconnect storm control | VIOLATION | Host retries at fixed 1/2 seconds in `live-audio-client.ts:173-206`; Viewer retries at fixed 1 second in `LiveViewer.tsx:412-426`. Gemini alone has a bounded three-attempt circuit at `google-provider-adapters.js:58-74`. | Use one in-flight reconnect, bounded exponential backoff with jitter, a terminal state, and fresh credentials per replacement. |
| Heartbeat ownership and cleanup | N/A | No ping/pong or heartbeat deadline exists in `gateway-server.js`. Existing auth/viewer/tick timers are cleared on close. | One server-owned heartbeat timer must mark liveness, terminate stale sockets, and clear itself exactly once on close/replacement. Test fake timers; do not log payloads. |
| Replacement resource cleanup | VIOLATION | Gateway closes the prior pipeline and guards double-close at `gateway-server.js:87-101,149-159`; browser generation guards stale Viewer sockets at `LiveViewer.tsx:405-420`. Gemini reconnect replaces `session` without explicitly closing a still-open predecessor. | Make close idempotent; abort predecessor provider sessions and pending connect/TTS work before ownership transfer. |
| Streaming TTS cancellation | N/A | Current Chirp adapter is unary `synthesizeSpeech`; `LiveMediaPipeline.close()` drains queues and cannot abort a stuck provider call. | Define an abort signal, close/cancel path, first-byte and total deadline, and a test proving disconnect cannot leave a provider stream or queue pending. |
| Input buffer abuse | PASS | Gateway caps WebSocket payload at 64 KiB and rejects invalid PCM size; host pending audio drops at the documented stale threshold in `gateway-server.js:29,62-75`. | Heartbeat/control frames must remain small and schema-validated. |
| Output/browser buffer abuse | VIOLATION | Server only checks `bufferedAmount < 750000` and otherwise drops a chunk (`gateway-server.js:168-172`); browser audio scheduling has no maximum queued duration. | Cap queued PCM duration/bytes. On overflow send an explicit error and close or stop Townhall according to its fail-closed contract. |
| Silent fallback or drop | VIOLATION | Slow-viewer PCM is counted as dropped but the viewer receives no gap/error; `OrderedTaskQueue` correctly stops Townhall when its deadline is exceeded. | Never convert stream pressure into an invisible audio gap. Preserve explicit `QUEUE_LATENCY_EXCEEDED`/language failure events and prohibit alternate voices or skipped text. |
| Logging privacy | PASS | Gateway metrics contain numeric counters/gauges only; inspected live paths do not log token, PCM, caption, or transcript contents. | Heartbeat/reconnect/TTS telemetry may record static reason codes and counts only; never bodies, headers, claims, text, or audio. |
| Paid API and live-data verification | N/A | Existing tests use fake providers and local WebSockets. | Keep loop verification fake/local. Any real Google/Supabase call is `APPROVAL_REQUIRED`. |

### Audit priorities

1. Bind heartbeat lifecycle to token expiry and idempotent resource cleanup.
2. Replace fixed unbounded browser reconnects with a bounded, jittered state machine using fresh credentials.
3. Add cancellable streaming TTS deadlines and explicit queue termination.
4. Replace silent output drops with a protocol-visible fail-closed outcome and a browser queue ceiling.
