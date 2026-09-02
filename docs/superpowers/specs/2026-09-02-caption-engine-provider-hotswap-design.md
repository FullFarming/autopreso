# 캡션 엔진 공급자 추상화·설정 선택·즉시 핫스왑 설계

작성일: 2026-09-02 KST. 상태: 설계 승인 대기 → 구현 계획 작성 예정.

선행 조사: [근본원인 보고](2026-09-02-live-translate-engine-root-cause-report.md), [공급자 비교](2026-09-02-caption-engine-model-survey.md), [Live API 문서 전수 조사](2026-09-02-gemini-live-api-docs-survey.md), [Soniox 적합성](2026-09-02-soniox-fit-analysis.md).

## 0. 결정 사항 (사용자 확정)

| 결정 | 내용 |
|---|---|
| 핫스왑 범위 | 로컬 자막 즉시 + **진행 중 Live Call 포함** 즉시 적용 |
| 공급자 범위 | 다중 공급자, 단계적. 1단계 Gemini(Transcribe Live + Flash) + **Soniox(stt-rt-v5)**. 2단계 Deepgram·OpenAI·DeepL |
| 파이프라인 골격 | **2단계(STT → 텍스트 번역)** 복귀. Live Translate 직접 경로 제거. Soniox는 STT+번역 결합 공급자로 취급 |
| 언어 지정 | 호스트 언어 모드 3단: `auto`(ko+en 제한) · `ko` · `en`. 전환은 핫스왑과 같은 경로 |
| 자동 모델 대체 | 공급자 실패 시 자동 교체 없음(기존 결정 유지). 상태 표시 + 사용자 선택으로 복구 |
| API 키 | 채팅으로 전달하지 않음. 데스크톱 설정 `apiKeys.soniox`, 게이트웨이 Secret Manager `SONIOX_API_KEY` |

## 1. 전체 구조

```
설정(subtitle.engine, apiKeys)
        │
        ▼
packages/caption-core/caption-engine-catalog.js        ← 단일 진실 원천(SSOT)
  roles: stt · translation · summary
  providers: gemini · soniox   (2단계: deepgram · openai · deepl)
  entry: { provider, model, label, roles[], capability }
  capability: { canRestrictSource, combinedSttTranslation, maxSessionMs,
                vocabularyLimit, requiredApiKey, languageModes[] }
  validateEngineSelection(engine) → canonical | throw ENGINE_SELECTION_INVALID
        │
   ┌────┴─────────────────────────────┐
   ▼                                  ▼
데스크톱 src/caption-engine/        게이트웨이 media-gateway/src/engines/
  createSttChannel(sel, ctx)           createSpeechToText(sel, ctx)   → RollingSpeechSession provider 계약
  createTranslator(sel, ctx)           createTextTranslate(sel, ctx)  → LiveMediaPipeline textTranslate 계약
  gemini-transcribe-channel.js         gemini-transcription-adapter.js (google-provider-adapters에서 이동)
  gemini-flash-translator.js           gemini-text-translate-adapter.js (동일)
  soniox-realtime-channel.js           soniox-realtime-adapter.js
```

- 파이프라인 본체는 유지: 게이트웨이 `LiveMediaPipeline` + `RollingSpeechSession`(HEAD `82db9e9`의 2단계 경로), 데스크톱 `createSubtitleRealtimeManager`의 `createSourceTranscriptionClient` + `createTextTranslationLane`(HEAD 구현 복원).
- 제거: `media-gateway/src/direct-live-translation-session.js`, `gemini-live-translate-adapter.js`, `gemini-source-transcriber.js`(WAV 원문 경로), 데스크톱 `src/gemini-live-translate.js`, `createDirectTranslationLane`, `packages/caption-core/gemini-source-audio.js`, 관련 테스트. `LiveMediaPipeline`의 `createLiveTranslationSession` 분기와 `#openDirectTranslation` 계열 삭제.
- 유지: 모델 선택 UI 골격(`public/subtitle-model-settings.js`, 카탈로그 형태로 확장), drain 프로토콜, 원문 누락 기록(`source_recording_gaps`), 라이브콜 아카이브, go-live 수정, 웹앱 변경 일체.
- **결합 공급자 규칙**: `engine.stt.provider === engine.translation.provider && capability.combinedSttTranslation`이면 텍스트 번역 단계를 건너뛰고 STT 어댑터가 내는 번역 토큰을 partial/final로 사용한다. 그 외 조합은 원문 확정 → 번역 어댑터 호출.

### 어댑터 공통 계약

```ts
// STT (게이트웨이는 RollingSpeechSession.provider, 데스크톱은 transport로 감싼다)
interface SttSession {
  open({ onPartial, onFinal, onTranslation?, onBoundary, onStatus, signal }): Promise<void>;
  sendAudio(pcm16k1280: Uint8Array): Promise<void>;
  finalize?(): void;
  gracefulDrain(): Promise<void>;
  close(): Promise<UsageSummary>;
  abort(): void;
}
interface SttEvent { text: string; isFinal: boolean; language: string|null; startMs: number|null; endMs: number|null; segmentId: string; providerSequence: number; receivedAt: number; }
interface TranslationEvent extends SttEvent { targetLanguage: string; sourceLanguage: string|null; alignment: "segment_order"; }
interface BoundaryEvent { type: "endpoint"|"manual-finalize"|"stream-finished"|"rotation"; segmentId: string; }

// 텍스트 번역
interface TextTranslator {
  translate({ text, sourceLanguage, targetLanguage, glossary, domain, isFinal, signal }): Promise<{ text, provider, model, latencyMs }>;
}
```

## 2. 설정 스키마와 카탈로그

```json
"subtitle": {
  "engine": {
    "stt":         { "provider": "soniox", "model": "stt-rt-v5", "languageMode": "auto" },
    "translation": { "provider": "soniox", "model": "stt-rt-v5" },
    "summary":     { "provider": "gemini", "model": "gemini-3.6-flash" }
  }
},
"apiKeys": { "gemini": "...", "geminiSecondary": "...", "soniox": "..." }
```

- 1단계 카탈로그: STT `gemini:gemini-3.5-transcribe-live`(languageModes: auto만, canRestrictSource false), `soniox:stt-rt-v5`(auto·ko·en, canRestrictSource true, combined true, maxSessionMs 18,000,000). 번역 `gemini:gemini-3.5-flash-lite | gemini-3.6-flash | gemini-3.7-flash`, `soniox:stt-rt-v5`(STT가 soniox일 때만 유효). 요약 `gemini:gemini-3.6-flash | gemini-3.7-flash`.
- 마이그레이션(`settings-store.js`): `geminiTranscribeModel`·`geminiSummaryModel`·`geminiPolishModel`·`geminiModel`을 읽어 `engine`으로 변환하고 제거. `gemini-3.5-live-translate-preview` → `gemini/gemini-3.5-transcribe-live`. 요약은 저장값 유지(3.6/3.7), 그 외는 기본값.
- `apiKeys.soniox`는 `getSanitized()`에서 `hasSonioxKey`로만 노출. 카탈로그 응답(`/api/config`의 `captionModels` 후속인 `captionEngines`)에 각 항목의 `requiredApiKey`와 현재 보유 여부를 함께 내려 UI가 키 없는 공급자를 비활성 표시.
- 게이트웨이 `createGeminiCaptionConfig` → `createCaptionConfig`로 일반화: `models` 대신 `engine`을 canonical 필드로 두고 지문(fingerprint)에 포함. 이름은 호환을 위해 `geminiCaptionConfigFingerprint` alias 유지. 게이트웨이 `config.js`는 `SONIOX_API_KEY`를 선택 환경변수로 읽고, 카탈로그 항목의 `requiredApiKey`가 없으면 그 공급자 선택을 `ENGINE_KEY_MISSING`으로 거절.
- 웹앱 `modelPreferences` → `{ engine }` 형태로 확장(`webapp/lib/live/model-preferences.ts`). 서버 카탈로그에 없는 조합은 400 `INVALID_ENGINE_SELECTION`. 기존 저장값은 읽기 시 이행.

## 3. 핫스왑 흐름

### 3.1 데스크톱 로컬 자막
1. `PUT /api/settings` 또는 `settings:update`로 `subtitle.engine`/`apiKeys` 변경.
2. `assertModelSettingsChangeIsIdle` 가드 제거. 저장 후 `engine` 또는 관련 키가 바뀌었으면 `subtitles.restartChannels({ reason: "engine_change" })`.
3. `restartChannels`는 새 채널을 먼저 `open()`하고 setup ACK를 받은 뒤 이전 채널을 `close({graceful:true})`한다(현재는 close 후 open). 이전 채널의 진행 중 문장은 drain 시간(≤750ms) 안에 확정한다. 공백 목표 ≤1초.
4. 언어 모드 전환(`engine.stt.languageMode`)도 같은 함수를 탄다. Soniox 채널은 최근 1.5초 PCM 링버퍼를 새 소켓에 먼저 보내고, 경계 문장의 중복은 정규화 텍스트 겹침(≥12자)으로 제거한다.
5. 상태 브로드캐스트: `subtitle:status { status: "recovering", reason: "engine_change" }` → `listening`.

### 3.2 Live Call (진행 중 포함)
1. Electron main: 설정 변경 감지 → 활성 Live Call이 있으면 (a) 웹앱 `PATCH /api/live-sessions/:id { modelPreferences: { engine } }`, (b) 게이트웨이에 `update` 메시지(새 `captionConfig` + 지문). 웹 호스트(브라우저)는 `live-audio-client.update()`가 같은 순서를 수행.
2. 웹앱 `service.ts`의 `SESSION_MODEL_PREFERENCES_PINNED` 409 제거. 변경마다 `event_metadata.engineHistory[]`에 `{ engine, changedAt, byHostId }` append(최대 64개).
3. 게이트웨이: `isSameHostSettings`의 지문 비교가 변화를 감지 → 기존 `update` 경로로 `pipelineFactory` 재실행 → `resolvePipelineInitialSequences`로 durable max seq 이어받기 → 이전 파이프라인 `closePipelineOnce`. `SupabaseHostAuthorizer`는 DB `modelPreferences.engine`과 요청 `captionConfig.engine` 일치를 요구(순서 (a)→(b) 보장).
4. 뷰어: `language-status: preparing` → `ready`. 교체 중 도착한 이전 파이프라인의 늦은 final은 기존 `createMediaEventGuard`(pipelineGeneration)로 차단.
5. 호스트 컨트롤러·웹 대시보드에 `engine-status` 표시(연결 중/준비/저하/실패 + 공급자·모델).

### 3.3 게이트웨이 시크릿
`SONIOX_API_KEY`를 Secret Manager에 추가하고 Cloud Run env로 주입. 게이트웨이는 세션 시작 시 선택 공급자의 키 존재를 확인하며, 없으면 `start`/`update`를 `ENGINE_KEY_MISSING`으로 거절(파이프라인 미생성).

## 4. 오류 처리와 폴백

- 자동 공급자 교체 없음. `engine-status { role, provider, model, status: connecting|ready|degraded|failed, code }` 이벤트를 호스트 소켓·데스크톱 렌더러에 전달.
- Soniox: `error_type` 기준 분기 — `invalid_request`·`unauthenticated` 재시도 금지, `limit_exceeded`(429)·`service_unavailable`(503)은 지터 백오프 250ms→500→1s→2s→4s(캡 5s), 연속 3회 실패 시 `failed`. 20초 무오디오 시 `keepalive`(8초 주기). 종료는 빈 프레임 → `finished:true` 대기(최대 5s) → close. `max_duration_reached`(300분)는 계획 회전.
- Gemini 텍스트 번역: 기존 `generateGeminiTextWithModelFallback` 유지. 체인은 선택 모델 → 카탈로그가 정한 동일 계열 후속(예: 3.7 → 3.6 → 3.5-lite). 모델당 1회, 2.8s.
- 결합 공급자 부분 실패: Soniox 소켓 실패 시 원문 `source-status: unavailable`과 번역 `language-status: unavailable`을 동시에 알리고 파이프라인은 유지, 백오프 재연결. 재연결 성공 시 `ready`.
- 키 누락·잘못된 조합은 저장 시점에 거절(UI 400), 실행 시점에 다시 검증.

## 5. 원문↔번역 대응과 기록

- 세그먼트 단위 대응: Soniox `<end>`(또는 `max_endpoint_delay_ms` 2000) 경계마다 원문 세그먼트 확정, 그 경계 전 도착한 `translation` 토큰을 같은 `segmentId`에 묶음. 원문 `start_ms/end_ms` 기록, 번역은 `alignment: "segment_order"`, 단어 타임스탬프 없음. 시각 버퍼 짝짓기 금지.
- Gemini 경로는 기존 1:1(확정 원문 → 번역).
- seq 계약 C1 유지: partial은 seq 미소비, 세그먼트 확정 시에만 final 발행.
- 기록: `live_source_utterances.stt_provider/stt_model`, `live_utterances.translation_model`에 실제 값. `event_metadata.engineHistory`로 구간별 엔진 추적. 데스크톱 transcripts에도 `engine` 필드 추가.
- 용어집 두 층: 공급자 힌트(Soniox `context.terms/translation_terms` ≤10k자, Gemini `customVocabulary` ≤1,000 + 프롬프트) + 결정적 `applyGlossaryCorrections`(모든 확정 라인, 기존 규칙).

## 6. 검증과 실측

- 단위: 카탈로그 검증(조합·키), 설정 마이그레이션, Soniox 토큰 리듀서(final append, non-final 교체, `<end>/<fin>` 비표시, 한국어 공백 보존, 번역 토큰 타임스탬프 미생성), 세그먼트 대응, 핫스왑 세대 가드(늦은 이벤트 차단), 언어 모드 전환 링버퍼 재전송·중복 제거, 오류 분기·백오프.
- 통합(fake provider): 데스크톱 `restartChannels` 새-open-후-close 순서, 게이트웨이 `update` 교체 시 seq 연속성과 뷰어 replay, 웹앱 PATCH 409 제거·`engineHistory` 기록, 키 누락 거절.
- 회귀: 기존 root/gateway/webapp 전체 통과. 제거 파일의 테스트는 삭제, `test/webapp-test-coverage.test.js` 규칙 준수.
- Spike(실 API, 사용자 키 필요, 합성 음성 + 사용자 리허설 음성만): 같은 PCM을 Soniox `auto`/`ko`/`en`과 Transcribe Live에 동시 공급. 측정 — 첫 부분 자막 지연, 확정 지연 p50/p95, 타 스크립트 오인식 건수, `two_way` 첫 번역 토큰 지연, `translation_terms` 반영률, US 대 JP 엔드포인트 RTT. 결과로 1단계 기본 공급자 결정. 스크립트는 `scripts/engine-spike.mjs`(throwaway 아님, 재실측용으로 유지).

## 7. 배포 순서와 롤백

1. 구현 + 세 스위트 통과 + typecheck.
2. Spike 실측 → 기본 공급자 결정 → 카탈로그 기본값 반영.
3. 게이트웨이: `SONIOX_API_KEY` 시크릿 → 리비전 트래픽 0% 배포 → `/health` → 100% 전환(`update-traffic` 필수). 롤백: 직전 리비전.
4. Vercel 프로덕션 승격. 롤백: 직전 deployment.
5. DMG 재빌드·`/Applications/NOVA.app` 교체(백업 보관).

## 8. 범위 밖

2단계 공급자(Deepgram·OpenAI·DeepL) 어댑터, 브라우저 직접 Soniox 연결(temporary key), Soniox TTS, 한국 리전(미제공), Cloud Run 1시간 소켓 교체 문제(별도 과제), 화이트보드 제품.

## Plan 1 hand-off (desktop complete) — 2026-09-02

Tasks 1-8 (steps 1-5) landed on HEAD `bc8d4f1`. Root suite (`npm test`) is green.
Ran, from repo root: `npm --prefix media-gateway test`, `npm --prefix webapp run test:live`,
`npm --prefix webapp run typecheck`, `npm --prefix webapp test`. No fixes applied.

- Catalog: `packages/caption-core/caption-engine-catalog.js`; protocol: `soniox-protocol.js`.
  Gateway/webapp still consume the shim `packages/caption-core/gemini-model-catalog.js`
  (default now `gemini-3.5-transcribe-live`, translation `gemini-3.6-flash`), which is
  the entire cause of every failure below — all are contract-pin mismatches, not code bugs.

**media-gateway** (`npm --prefix media-gateway test`): 593 tests, 574 pass, 19 fail.
Failing files:
- `test/config.test.js` — 11/16 fail. `GEMINI_WORKLOAD_MODEL_MATRIX.translation` is now
  `gemini-3.6-flash` (catalog default); gateway env fixtures/adapters still pin the old
  `gemini-3.7-flash`/legacy values. **Item 1 from the controller's ledger — confirmed.**
- `test/host-model-authorization.test.js` — 2/4 fail (old model-pin assertions).
- `test/live-input-source-persistence.test.js` — 1/4 fail (same cause).
- `test/gemini-only-shared-engine.test.js` — 1/9 fail (v4 config pins old translation role).
- `test/gateway-readiness-composition.test.js` — 2/2 fail (captions-settings activation pins old model id).
- `test/quality-runner.test.js` — 1/1 fail (`gemini-3.5-transcribe-live` vs expected `gemini-3.5-live-translate-preview`).
- `test/gemini-runtime-composition.test.js`, `test/direct-live-input-source.test.js`,
  `test/direct-live-pipeline.test.js`, `test/direct-live-translation-session.test.js` —
  **all pass (0 fail)**, contrary to the brief's prediction; no action needed there.
- **Concern (not a Plan-1 regression):** `test/gemini-source-transcriber.test.js` crashes the
  whole file with `ERR_MODULE_NOT_FOUND` for `packages/caption-core/gemini-source-audio.js`
  (a module that has never existed in git history). Both the test file and its companion
  `media-gateway/src/gemini-source-transcriber.js` are **untracked**, part of unrelated
  in-flight uncommitted work (pre-dates this catalog change) — not caused by Tasks 1-8, but
  it will keep failing until Plan 2 either creates that module or removes the orphaned test.

**webapp**: `test:live` = 821 tests, 811 pass, 10 fail — all contract-pin mismatches, no
import/syntax errors. `npm run typecheck` passes clean (exit 0). `npm test` (`test:live &&
test:core`) short-circuits on the same 10 failures, so `test:core` (7 files: host-surface,
invite-share, speak-client, audio, channelCore, languageDetect, live-contract) did not run
this pass — unrelated to caption engine, low risk.
Failing files: `components/live/live-audio-client.test.ts` (2), `lib/live/live-service.test.ts` (2),
`lib/live/model-preferences.test.ts` (3, incl. the predicted one), `lib/live/post-session-summary.test.ts` (1),
`lib/live/summary.test.ts` (1), `lib/security/live-security.test.ts` (1, pins
`DEFAULT_GEMINI_MODEL_SELECTION.source` — renamed to `DEFAULT_ENGINE_SELECTION.stt.model`).

**Root suite:** `test/gemini-3-7-workload-contract.test.js` passes (6/6) against the current
working tree (adapter timeout 6_000, `LEGACY_TEXT_TRANSLATION_MODEL = gemini-3.7-flash`,
`GENERATE_WORKLOADS` without `translation`) — but this pins the **working-tree** gateway
contract, not any committed state, so it goes red on a clean single-commit checkout until
Plan 2 commits the gateway/gemini-server changes and re-adds the two-stage `translation`
workload. Plan 2 must reconcile this test as part of that commit.

**Stale doc:** AGENTS.md's "root-vs-`public/` frontend duplication trap" section is now
stale — the eight root-level `subtitle-*` duplicates were deleted on this branch, and
`test/subtitle-frontend.test.js` asserts `public/<file>` is the sole runtime copy. Plan 2
(or the final sweep) should correct that section.

**Deferred minors** (full text in `.superpowers/sdd/2026-09-02-caption-engine-plan-1-core-desktop/progress.md`,
lines matching `^Task N: minor (deferred`, **including the variant phrasings**
`(deferred, Plan 2)`, `(deferred, for final review)`, and `(deferred, Plan 2/store)`):
Task 1: 3, Task 2: 3, Task 3: 1, Task 4: 7, Task 5: 4, Task 6: 3, Task 7: 7, Task 8: 1 —
29 total, none blocking.

**Not yet done:** Task 8 steps 6-7 (real-API spike run + choosing the default provider)
are pending a Soniox key; the catalog default remains Gemini until then. The installed
`/Applications/NOVA.app` and the deployed gateway are unchanged. Live Call started from
`npm run desktop` is rejected during host authorization because the deployed gateway's
Supabase host authorizer compares the DB model pin against the desktop's captionConfig
and the desktop now sends the Transcribe-Live default; the exact error code surfaced to
the desktop was not exercised in Plan 1. This will not resolve until Plan 2 commits,
builds, and deploys both sides.
