# Realtime Noel — Live Call 개선 작업 문서

문서 작성일: 2026-07-23
작성 맥락: 첨부 기획서(`docs/REALTIME_NOEL_LIVE_CALL_PRODUCT_INTENT.md`)를 기준으로 기존 구현을 감사(audit)하고,
발견된 갭 전체 + 사용자 추가 요구 3건을 구현하던 중 월 사용 한도(spend limit)로 일부 작업이 중단됨.
이 문서는 (1) 프로젝트 전체 구조, (2) 감사 결과, (3) 구현 계약(스펙), (4) 완료/미완 상태, (5) 재개 방법을 남긴다.

> 상태 요약(2026-07-23 기준)
> - **Electron 호스트**: 완료. 테스트 16/16 통과.
> - **webapp**: 대부분 반영 + 타입체크 `tsc --noEmit` 통과(0 오류). 단, 에이전트가 최종 테스트 스위트를 끝까지 돌리기 전에 중단 → **테스트 재실행·검증 필요**.
> - **media-gateway**: `src` 반영됨, 테스트 179/181 통과. **1건 실패**(`pipeline.test.js`의 seq-continuity — per-language seq 전환 반영 중이던 테스트) + 에이전트가 남긴 **teardown 순서 버그 미수정**(아래 참조).
> - 아직 **어떤 것도 커밋하지 않음**. 모든 변경은 워킹 트리 상태.

---

## 1. 프로젝트 개요

### 1.1 제품 정체성

- **Realtime Noel**은 실시간 번역 자막 데스크톱 프로그램이 핵심(primary)이다. 프로그램으로 들어오는 음성을
  인식해 선택 언어로 자막을 출력하는 기존 기능은 독립적으로 계속 동작한다.
- **Live Call**은 그 위에 얹는 **선택 기능(optional)**: 호스트가 생성한 실시간 자막·번역을 현장 참가자들이
  각자의 모바일 웹에서 함께 보고, 발언(Speak)·화자 기록·AI 회의록까지 하나의 세션으로 관리한다.
- 중요: Live Call 실패(세션 생성 실패, 모바일 연결 실패 등)가 기본 데스크톱 자막을 절대 중단시키면 안 된다.
- **Autopreso(화이트보드 AI)와는 분리된 독립 제품**이다. 이 저장소(autopreso)에 함께 들어있으나, Live 작업에
  화이트보드 기능을 엮지 않는다. (메모리: `realtime-vs-autopreso-separation`)

### 1.2 리포지토리 구조 (Live Call 관련)

```
autopreso/
├─ src/                     # 기존 CLI/서버 + 자막 파이프라인(Moonshine/OpenAI STT, Gemini/OpenAI 번역)
├─ public/                  # 데스크톱 자막 오버레이/컨트롤러 프런트엔드(정적, 빌드 스텝 없음)
├─ electron/                # macOS 데스크톱 호스트 셸
│   ├─ main.js              #   메인 프로세스. 기본 자막 창 + Live Call 워크스페이스(BrowserWindow) 오픈
│   └─ preload.js           #   렌더러 브리지
├─ subtitle.html, subtitle-dashboard.js  # 데스크톱 자막 UI (root ↔ public/ 동일 사본 유지 규칙)
├─ media-gateway/           # Live Call 실시간 미디어 게이트웨이 (WS 오디오→STT→번역→TTS→팬아웃)
│   ├─ src/
│   │   ├─ gateway-server.js       # WS 서버, 인증, floor 제어, 브로드캐스트
│   │   ├─ live-media-pipeline.js  # 세션당 파이프라인: STT→번역→TTS, sequence 발급
│   │   ├─ supabase-adapters.js    # Supabase RPC 어댑터(floor take/release, utterance persist 등)
│   │   ├─ server.js               # 파이프라인 생성/hot-swap(restart) 오케스트레이션
│   │   ├─ speaker-registry.js     # 화자 슬롯(최대 6) 관리
│   │   ├─ token-verifier.js       # 참가자/호스트 WS 토큰 HMAC 검증
│   │   ├─ gateway-connection-limiter.js, gateway-security.js  # rate/connection 제한, origin
│   │   └─ metrics.js, config.js, ordered-task-queue.js ...
│   └─ test/                # node:test, hand-rolled mock
├─ webapp/                  # Next.js(App Router) — 모바일 뷰어 + 호스트 대시보드 + Live API
│   ├─ app/api/live-sessions/**   # 세션 생성/시작/상태/초대/요약/트랜스크립트 등 라우트
│   ├─ app/m/watch, app/watch/**  # 모바일/데스크톱 뷰어 페이지
│   ├─ app/stage/[id]/             # (신규) 호스트 카운트다운+QR 스테이지 뷰
│   ├─ components/live/**          # LiveHostDashboard, LiveViewer, ViewerStage, SpeakerCaption 등
│   ├─ lib/live/**                 # 도메인 로직(service, store, summary, admission-code, activity 등)
│   ├─ lib/security/**             # 입력 검증, rate limit, viewer 인가, admission store
│   └─ middleware.ts               # 전역 CSRF/Origin + 호스트 세션 쿠키 가드
└─ supabase/migrations/**  # 추가형(additive) 마이그레이션. live_* 테이블/RPC/RLS/cron 정리
```

### 1.3 Live Call 엔드투엔드 흐름

```
[호스트 데스크톱(Electron)]
   └ 기본 자막(항상 동작)
   └ "Open Live Call" → webapp 호스트 대시보드(BrowserWindow)
        └ 세션 생성(제목/일정) → QR + 6자리 코드
        └ (신규) 스테이지 창을 확장 디스플레이에 전체화면(카운트다운+QR)
        └ Start Live

[참가자 모바일 웹(webapp /m/watch)]
   └ QR 스캔 or 6자리 코드 → 이름/부서/직급 입력 → 대기 화면(검정)
   └ 호스트 Start → Live 자막(검정 풀스크린, 흰 자막)
   └ 개인별 KO/EN 자막 + 번역 음성 On/Off + 글자크기
   └ Speak → 단일 발언권 → 화자 신원이 자막·기록에 연결

[media-gateway]
   └ 호스트 오디오 WS → STT → (원문 lane verbatim + 타 언어 Gemini 번역) → TTS(언어별 1회) → 언어별 팬아웃
   └ Supabase에 확정 자막(live_utterances, per-language seq) 영속

[종료]
   └ 호스트 End(확인 필요) → 전체 기기 종료 상태 전파 → AI 회의록(OpenAI Structured Outputs) 자동 생성
```

### 1.4 상태 모델(기획서 §14, 이번 작업으로 확장)

```
Preparing → Live → Paused → (Live) → ... → Ended → MinutesReady
```
- **Restart**: 자막 엔진만 재초기화. 세션/QR/코드/참가자/발언 기록 유지.
- **Stop = Paused**: 자막 일시정지. 세션 유지, QR·코드 회전 금지. (이번 작업으로 신규 도입)
- **End**: 유일한 종료. 확인 절차 필수, QR/코드 무효화, 전체 기기 종료 전파, 회의록 생성.

---

## 2. 감사(Audit) 결과 요약

세 영역을 병렬 감사했다. 기획서의 "제품 완성 기준 10문항"과 실패 시나리오 A~E를 기준으로 판정.

### 2.1 잘 되어 있던 부분(유지)

- **DB/보안 계층이 견고**: 6자리 코드 HMAC 저장(평문 미저장) + 세션 수명 동안 코드 불변 트리거
  (`enforce_stable_live_admission`, `202607230004`), 낙관적 잠금(version 컬럼), RLS fail-closed,
  30일 정리 pg_cron, 4축 rate limit(IP/기기/세션/전역).
- **단일 발언권**: DB `FOR UPDATE` CAS(`take_live_floor`)로 원자성 확보, 비보유자 오디오 프레임 폐기(소켓 유지).
- **호스트 인증**: 모든 상태변경 API에 Origin/CSRF + 호스트 소유권 검증, 게스트의 세션 생성/타 세션 접근 차단.
- **TTS 언어별 1회 합성 후 팬아웃**: 50명 규모에서 뷰어당 중복 합성 비용 회피.
- **회의록**: OpenAI Structured Outputs(strict) 사용, 실패를 성공으로 처리하지 않는 오류 경로.

### 2.2 발견된 주요 갭 (→ 이번 작업 대상)

| # | 갭 | 심각도 | 기획서 근거 |
|---|---|---|---|
| G1 | 호스트 소켓 끊기면 파이프라인 즉시 파괴 + **seq 0 리셋**, 재접속 경로 없음 | P0 | 실패 E, §8.6 |
| G2 | 뷰어 재접속 gap-fill 서버측 미구현; seq가 전 언어+오디오 공유 전역 카운터 | P0 | 기준 9, 실패 B |
| G3 | End Session에 확인 없음 + 파괴 버튼이 일반 컨트롤과 같은 행 | P0 | §10.5, §19.3 |
| G4 | 입장 코드 이중 생성기(랜덤 vs 결정적) → `/invites` 실패 시 코드 회전 | P0 | §8.3, 기준 3 |
| G5 | 회의록이 End 시 자동 생성 안 됨(호스트 수동 호출) | P1 | §16, 기준 10 |
| G6 | Stop=일시정지 시맨틱 부재(상태 enum에 paused 없음) | P1 | §8.6 |
| G7 | 화자 교체 시 지연 STT 확정문이 새 화자에게 오귀속 | P1 | §4.2 |
| G8 | 모바일 자막 스크롤백/최신복귀 없음(slice(-8) 하드캡), 대기·종료 화면 미비 | P1 | §9.3 |
| G9 | 기능 플래그 부재(롤백 전략 불가), 화면공유·자막공개 토글 미구현 | P1 | §23 |
| G10 | Supabase snapshot RPC가 자막 핫패스를 막고 일시 장애가 언어 쿨다운 유발 | P2 | 기준(지연 p95) |
| G11 | 지연 계측 부재(p95 2.5s/floor 1s 측정 불가), 구독자 0명 언어도 TTS 합성 | P2 | §18 |
| G12 | actionItems가 `string[]`(담당자/기한/미정 구조 없음), 자막에 부서·직급 미표시 | P2 | §16.2 |
| G13 | 마이그레이션 실제 적용 미확인(RLS·트리거·cron은 적용 후에만 유효) | P2 | §24 |

### 2.3 사용자 추가 요구 3건

- **R1 (한/영 이중 자막)**: Gemini 번역과 별개로, 한국어 발화면 KO 원문 lane + EN 번역 lane 둘 다 생성.
  영어 발화면 EN 원문 + KO 번역. 유저가 고른 언어 lane이 보이도록.
- **R2 (스테이지 카운트다운+QR)**: Live 세션 실행 시 "진행 예정" 화면을 확장 디스플레이(없으면 메인에 복제처럼)에
  띄우고, 예정 시간까지 카운트다운. 호스트가 Start를 눌러야 시작. 이 화면에 QR 표시.
- **R3 (화자 오버레이)**: Live 세션에서 화자가 바뀌면 자막 위에 화자 이름·부서·직급을 오버레이로 표시.
  Live 세션이 아니면 이 옵션 없이 진행.

---

## 3. 구현 계약(공유 스펙)

세 스트림(webapp/media-gateway/electron)이 프로토콜을 공유하도록 아래 계약을 먼저 확정했다.
원본: 세션 스크래치패드 `LIVE_CALL_CONTRACT.md`. 요지는 다음과 같다.

- **C1 per-language sequence**: 확정 자막 seq는 `(sessionId, language)`별 단조 증가, **1부터**. 오디오 청크/컨트롤은
  자막 seq를 소비하지 않음. 파이프라인 생성 시 Supabase `max(seq)`+1로 시드 → 재접속/재시작에도 유지.
  DB `unique(session_id, language, seq)` + `on conflict do nothing`.
- **C2 subscribe replay**: `{type:"subscribe", sessionId, language, lastSeq?}`. lastSeq 있으면 게이트웨이가
  `seq > lastSeq`를 조회해 `replay:true` caption 이벤트로 순서대로 보낸 뒤 라이브 합류. 클라이언트는 언어별 lastSeq 관리.
- **C3 호스트 재접속 유예**: 호스트 소켓 close 시 파이프라인을 **기본 45초**(`LIVE_HOST_RECONNECT_GRACE_MS`)
  detached 유지(floor·seq·뷰어 유지). 같은 sessionId 재접속 시 reattach. 유예 만료 시에만 teardown.
- **C4 pause/resume**: 상태 enum에 `paused` 추가. RPC `pause_live_session`/`resume_live_session`
  (FOR UPDATE + version). 게이트웨이 `{type:"pause"}`/`{type:"resume"}`(HOST 전용). host lease는
  `status IN ('live','paused')`를 유효로. 코드/QR 회전 금지.
- **C5 floor 이벤트 신원**: `{type:"floor", holder:{participantId,name,department,jobTitle}|null}`. 확정 자막
  speaker 메타에도 department/jobTitle 포함.
- **C6 한/영 이중 자막**: 세션 자막 언어는 항상 ko+en 합집합. 대상 언어==발화 원문 언어면 번역 없이 STT 원문을
  그대로 해당 lane 확정 자막으로 방출, 나머지 언어만 Gemini 번역.
- **C7 회의록 자동 생성**: End 성공 시 활성 언어별 요약 생성 자동 트리거(베스트 에포트, 비블로킹, 재시도 1회).
  뷰어는 `SUMMARY_NOT_READY` 동안 지수 백오프 폴링. `actionItems`를 `{description, owner, due}[]`로,
  불명 시 `"미정"`.
- **C8 스테이지 뷰**: 호스트 전용. 검정 배경 + 제목 + scheduledAt 카운트다운(없으면 "Waiting for host") +
  QR + 6자리 코드 + 입장 인원. **카운트다운 0이어도 자동 시작 금지** — 호스트 Start 필요.
  Electron이 window.open(name="realtime-noel-stage")을 인터셉트해 확장 디스플레이 전체화면(없으면 메인 최대화).
- **C9 기타**: 기능 플래그(`NEXT_PUBLIC_LIVE_CALL_ENABLED`, `REALTIME_NOEL_LIVE_CALL_ENABLED`, 기본 true),
  End 확인+분리, `GET /api/live-sessions?scope=mine` 호스트 세션 복구, admission 코드 결정적 단일화,
  snapshot best-effort, 지연 히스토그램, 구독자 0명 언어 TTS 스킵, 화자 교체 귀속 펜싱.
  **신규 npm 의존성 금지, 기존 테스트 패턴 준수, TDD.**

---

## 4. 구현 상태 (스트림별)

### 4.1 Electron 호스트 — ✅ 완료 (테스트 16/16)

변경 파일: `electron/main.js`, `electron/preload.js`, `subtitle-dashboard.js`(+`public/` 동일 사본).
추가 테스트: `test/desktop-stage-window.test.js`.

- **스테이지 창(C8)**: `setWindowOpenHandler`가 stage 요청(window name `realtime-noel-stage` 또는 `/stage/` 경로,
  허용 origin 한정)을 감지 → 하드닝된 webPreferences(contextIsolation/sandbox)로 자식 창 허용.
  `resolveStageDisplayPlacement(displays, primaryId)` 순수 함수: 확장 디스플레이 있으면 그 bounds+fullscreen,
  없으면 primary bounds(+maximize, 복제처럼). 디스플레이 add/remove 핫플러그 시 재배치. 자동 시작 없음.
- **기능 플래그(C9)**: `isLiveCallEnabled(env)` — 기본 true, `"false"`(trim/소문자)일 때만 off.
  `live-workspace:open` IPC 게이팅 + `live-workspace:get-enabled` 노출. 기본 자막 경로 무영향.
- **회귀**: `product-brand.test.js` 등 통과, 기본 자막 컨트롤 무변경 확인.

### 4.2 webapp — 🟨 대부분 반영 + 타입체크 통과, 테스트 검증 필요

`tsc --noEmit` 통과(0 오류). 아래 항목의 파일은 디스크에 존재하나, 에이전트가 **최종 테스트 스위트 실행 전에 중단**됨.

반영 확인된 항목:
- **G4 코드 단일화**: `webapp/lib/live/admission-code.ts`(+`.test.ts`), `admission/route.ts`가 결정적 파생 사용.
- **G5+C7 회의록 자동 생성**: `webapp/lib/live/post-session-summary.ts`(+`.test.ts`), `service.ts`/`[id]/route.ts` DELETE 경로.
  `summary.ts` 스키마의 `actionItems`가 owner/`미정` 구조로 변경(스키마·프롬프트·렌더러).
- **G6+C4 paused**: `webapp/lib/live-contract.ts`에 `paused`, `app/api/live-sessions/[id]/pause/route.ts`,
  `.../resume/route.ts`, 마이그레이션 `supabase/migrations/202607240001_live_session_pause.sql`.
- **G3 End 확인+분리**: `LiveHostDashboard.tsx`에 `live-danger-zone`(별도 영역, 2단계 확인, window.confirm 미사용).
- **G9 기능 플래그**: `webapp/lib/live/feature-flag.ts`(+`.test.ts`).
- **호스트 복구**: `app/api/live-sessions/route.ts`에 `GET ?scope=mine`.
- **G8 스크롤백/대기/종료 화면**: `LiveViewer.tsx`에 return-to-latest/atBottom 로직, 대기·종료 뷰.
- **C2/C1 클라 seq**: `LiveViewer.tsx` per-language `lastSeq`(10개소).
- **R3 화자 오버레이**: `LiveViewer.tsx` overlay/floorHolder(14개소), `SpeakerCaption.tsx`.
- **R2 스테이지 뷰**: `app/stage/[id]/page.tsx`, `components/live/LiveStageView.tsx`.
- **R1 한/영 보장**: 세션 생성/검증에서 ko+en 합집합(webapp 측).
- **G12 minor**: 부서/직급 길이 정합, 컴팩트 터치 타깃(globals.css).

⚠️ 남은 검증(재개 시 최우선):
1. webapp 테스트 스위트 전체 실행(`cd webapp && npm test` 또는 해당 러너) — 신규 `.test.ts` 6개 포함 통과 확인.
2. 대시보드 Pause/Resume 버튼이 실제 `pause`/`resume` 라우트에 배선됐는지 최종 확인(에이전트 마지막 로그가
   "rewire the action row" 단계였음).
3. 마이그레이션 `202607240001`의 SQL 문법/`terminate_live_session`가 paused 허용하도록 `create or replace`됐는지 검토.

### 4.3 media-gateway — 🟨 src 반영, 테스트 179/181 (1 실패 + 미수정 버그 1)

변경: `src/gateway-server.js`, `src/live-media-pipeline.js`, `src/supabase-adapters.js`, `src/server.js`,
`src/config.js`, `src/metrics.js`, `src/speaker-registry.js` + 테스트들, 신규 `test/live-call-gateway.test.js`,
`test/metrics.test.js`.

- ✅ 대부분의 계약 항목(C1 per-language seq, C2 replay, C3 grace, C4 pause/resume, C5 floor 신원,
  C6 이중 자막, snapshot best-effort, 히스토그램, 구독자 0명 TTS 스킵) 코드 반영.
- ❌ **알려진 실패 1건**: `test/pipeline.test.js`의 "mode hot-swap preserves speaker identity ..." —
  per-language seq 전환에 맞춰 갱신 중이던 seq-continuity 단언. 테스트 기대값 또는 시드 로직 정합 필요.
- ❌ **미수정 버그(에이전트가 발견하고 고치기 직전 중단)**: 호스트 teardown에서 `hostSessions` 삭제가
  `releaseFloor`보다 **먼저** 실행되어, floor=null 브로드캐스트가 language 목록을 잃고 뷰어에 도달하지 못함.
  → `gateway-server.js`의 teardown 순서를 **releaseFloor 먼저, hostSessions 삭제 나중**으로 재정렬해야 함.

---

## 5. 재개(Resume) 가이드

한도 회복 후, 또는 Opus로 계속할 때 아래 순서를 권장한다. 모두 워킹 트리 상태이며 아직 미커밋.

1. **media-gateway teardown 순서 버그 수정**(§4.3): `gateway-server.js` 호스트 close 경로에서 releaseFloor를
   hostSessions 삭제보다 먼저 호출. 이후 `pipeline.test.js` seq-continuity 실패 정합.
   검증: `cd media-gateway && node --test test/*.test.js` → 181/181.
2. **webapp 테스트 전체 실행 + Pause/Resume 배선 확인**(§4.2 남은 검증 1~3).
3. **크로스-스트림 프로토콜 정합 확인**: 계약 C1/C2/C4/C5의 메시지 shape가 webapp 클라이언트와 gateway 서버 간
   실제로 일치하는지(필드명 `lastSeq`, `holder.department` 등) 통합 테스트 또는 수동 대조.
4. **Supabase 마이그레이션 적용/검증**(G13, 기획서 §24): 개발 프로젝트(project_ref `ganiabssgqcycnchshpz`)에
   `202607240001` 포함 최신 추가형 마이그레이션 적용 후 in-file 검증 블록 실행. RLS/트리거/cron은 적용 후에만 유효.
5. **로컬 3기기 시연**(기획서 §22): iPhone Safari, Android Chrome, macOS 호스트. Speak 동시성, 재접속 seq 복구,
   Restart/Stop/End 구분, 한/영 이중 자막 전환, 스테이지 카운트다운, 화자 오버레이.
6. **커밋 전략**: 스트림별로 conventional commit 분리 권장
   (`feat(media-gateway): ...`, `feat(webapp): ...`, `feat(electron): ...`). CHANGELOG/manifest는 release-please
   자동 생성이므로 수기 편집 금지(프로젝트 규칙).
7. 운영 배포는 버그 검사·로컬 시연·**사용자 명시 승인 후에만**(기획서 §23).

---

## 6. 미해결/향후 판단 필요

- **화면 공유 토글 + 모바일 자막 공개 토글**(G9 일부): 기획서 §11이 요구하나 이번 범위에서 UI 토글은 미착수
  (Electron은 현재 `getDisplayMedia`를 시스템 오디오 캡처에만 사용, 비디오 트랙 미발행). 별도 작업 필요.
- **`failed` 세션 상태**: enum에는 있으나 이를 세팅하는 RPC 부재(dead state). 게이트웨이 장애 시 세팅하거나 정리.
- **7번째 화자**(speaker-registry 6 슬롯 초과): 자막 귀속은 유지하되 legend 노출 정책 확정 필요.
- **회의록 요약 구조의 DB 모델링**: `live_meeting_summaries.summary`가 opaque jsonb — 무결성은 앱 계층 의존.
  필요 시 JSON schema CHECK 또는 하위 컬럼화.

---

## 부록 A. 핵심 파일 빠른 참조

- 기획 원본: `docs/REALTIME_NOEL_LIVE_CALL_PRODUCT_INTENT.md`
- 배포 준비 체크: `docs/live-deployment-readiness.md`, `scripts/live-deployment-readiness.mjs`
- floor 계약(메모리): 프로젝트 메모리 `live-call-floor-architecture`
- 자막 파이프라인 baseline/글로서리(메모리): `subtitle-working-baseline`, `subtitle-glossary-content`,
  `subtitle-multilang-channel-architecture`
- Live 마이그레이션: `supabase/migrations/202607190001_*` ~ `202607240001_live_session_pause.sql`

## 부록 B. 감사 판정 근거 파일:라인 (대표)

- 단일 발언권 CAS: `supabase/migrations/202607230004_...:738-860` (`take_live_floor` FOR UPDATE)
- 코드 불변 트리거: `202607230004_...:185-243` (`enforce_stable_live_admission`)
- 호스트 teardown(버그): `media-gateway/src/gateway-server.js` 호스트 close 경로(≈700-710)
- 전역 seq(수정 대상): `media-gateway/src/live-media-pipeline.js` (구 `#seq` ≈305/396/469/507)
- End 확인 zone(신규): `webapp/components/live/LiveHostDashboard.tsx:1207` (`live-danger-zone`)
- 회의록 스키마: `webapp/lib/live/summary.ts` (`MEETING_SUMMARY_JSON_SCHEMA`, actionItems)
