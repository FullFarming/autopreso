# NOVA (realtime-noel) — 프로젝트 정리와 작업 이력 (2026-09-05 기준)

작성 시각: 2026-09-05 08:45 KST, 갱신 14:30 KST(Plan B Task 7), 19:10 KST(§4.7 통합). 현재 브랜치 `codex/nova-integration-20260905`, HEAD `4c2cbbf`(949b06f + 하드닝 브랜치 + 두 번째 세션 체크포인트 + 통합 수정). §1~§4.6은 오전 기준 기록이며, 이후 상태는 §3 말미·§4.7·§5·§6에 있다. 이 문서는 2026-09-02부터 이어진 작업의 맥락·결정·진행 상황을 한곳에 모은 것이다. 세부 근거는 각 스펙·계획·원장 파일에 있으며, 여기서는 경로만 가리킨다.

---

## 1. 프로젝트가 무엇인가

**NOVA(패키지명 realtime-noel)**는 실시간 음성 번역 자막 제품이다. 하나의 리포에 세 실행 표면이 있다.

| 표면 | 위치 | 역할 |
|---|---|---|
| 데스크톱 앱 (Electron) | `electron/`, `public/subtitle-*`, `src/` | 호스트 PC의 마이크·시스템 오디오를 잡아 **로컬 자막**(오버레이 창)을 그리고, Live Call을 시작·운영한다. 로컬 자막 엔진은 `src/subtitle-realtime.js`가 직접 Gemini/Soniox에 연결한다. |
| 미디어 게이트웨이 (Cloud Run) | `media-gateway/` | **Live Call** 파이프라인. 호스트 오디오를 받아 인식(STT)·번역·(TTS)하고 참여자에게 언어별 자막을 배포한다. 발언권(floor), 자막 순번(seq) 계약, Supabase 저장을 담당한다. |
| 웹앱 (Next.js, Vercel) | `webapp/` | 참여자 뷰어(QR/6자리 코드 입장), 호스트 대시보드, 기록(원문·요약), 그리고 데스크톱이 호출하는 REST API. 이번 작업으로 **로그인·가입·승인·관리자 콘솔**이 추가되었다. |
| 데이터 | `supabase/migrations/` | `live_sessions`, `live_utterances`, 요약, 프로필 등. 대부분 `security definer` RPC로만 접근한다. 마이그레이션은 파일명 순으로 수동 적용한다. |

원래 제품(화이트보드 에이전트 CLI)도 같은 서버(`src/server.js`)에 남아 있지만 이번 작업과는 무관하다.

세 테스트 스위트가 따로 있다: 루트 `npm test`, `npm --prefix media-gateway test`, `npm --prefix webapp test`(TS 테스트는 `webapp/package.json`의 `test:live`/`test:core` 문자열에 파일명을 등록해야 실행되고, 루트 `test/webapp-test-coverage.test.js`가 누락을 잡는다).

---

## 2. 이번 작업이 시작된 이유

사용자 보고(2026-09-02): "로컬 자막은 빠르지만 병목이 느껴지고, Live Call은 번역이 완전히 틀리고 자막 흐름이 이상하다."

**확정한 근본 원인** (`docs/superpowers/specs/2026-09-02-live-translate-engine-root-cause-report.md`):
- 배포된 게이트웨이가 `gemini-3.5-live-translate-preview`(음성 출력 전용 Live Translate) 모델을 원문·번역 동시 생성에 쓰고 있었다. 이 API에는 **소스 언어 힌트가 없어** 한국어를 zh/vi로 오인식했다(DB `live_source_utterances.source_language`에 증거). 원문↔번역 대응 정보도 없어 자막 흐름이 뒤엉켰다.
- 해법은 **2단계 엔진 복귀**: `gemini-3.5-transcribe-live`(텍스트 전용 인식) + Gemini Flash 텍스트 번역. 그리고 공급자를 바꿀 수 있는 구조.

**모델 정리** (`2026-09-02-caption-engine-model-survey.md`, `2026-09-02-gemini-live-api-docs-survey.md`, `2026-09-02-soniox-fit-analysis.md`):
- Gemini 3.5 Transcribe Live: 텍스트 전용 STT, 언어 힌트는 편향만, 세션 10분 상한. 번역은 별도 Flash 호출.
- Soniox stt-rt-v5: 인식+번역 결합(two_way), `language_hints_strict`로 한·영 집합 제한 가능, 300분 세션, 정확히 2개 언어 세션에만 적용.
- Live Translate(문제 모델): 제거 대상.

---

## 3. 사용자 결정 목록 (변경 불가한 전제)

1. 핫스왑 범위: **로컬 자막과 진행 중 Live Call 모두 즉시** 적용.
2. 공급자: **다중 공급자, 단계적** (1단계 Gemini + Soniox). 접근안 A(공유 카탈로그 + 프로세스별 어댑터 팩토리).
3. 인증: **Supabase Auth**(구글 + 이메일/비번), 기존 `rnw_session` 쿠키는 앱 세션으로 유지(접근 A).
4. 가입: **공개 가입 + 관리자 승인**. 콘솔 범위: 가입 관리 · 세션 데이터 · 전역 엔진 기본값.
5. 기록 원문 뷰: **화자가 바뀌지 않으면 한 문단**, 발언마다 시각 표시(⑤).
6. 요약 생성: 로딩 스켈레톤, 첫 실패·반복 클릭 문제 해결(⑥).
7. ~~**2026-09-04 추가 결정**: Live Call 엔진은 **관리자가 콘솔에서 정한 전역 값 하나**, 호스트는 **바꿀 수 없음(잠금)**, 배포 시 **진행 중 세션도 즉시 전환**.~~ **→ D1(2026-09-05 오후)로 대체**: 엔진은 **사용자별**(`profiles.voice_provider`), **운영자(전역 관리자)만** `/console/users`에서 바꾸며, 변경은 그 사용자의 진행 중 세션에 **즉시** 적용되고 다음 세션에도 유지된다. "호스트 잠금"과 "즉시 전환"은 유지, "전역 하나"만 폐기. 데스크톱 `subtitle.engine`은 로컬 자막 전용 그대로. (스펙 §11)
8. ~~기본 공급자: spike 결과에도 **Gemini Transcribe + Flash 유지**(합성 음성만으로 실제 마이크 정확도를 판정할 수 없고, 3개 언어 세션은 Gemini 번역이 필요하며, 배포된 게이트웨이에 Soniox 레인이 없기 때문). Soniox는 관리자가 선택 가능한 결합 엔진.~~ **→ D2(2026-09-05 오후)로 대체**: 기본 엔진은 **Soniox**(인식+자체 번역), Gemini Transcribe → Flash는 대안. 3개 언어는 Soniox 팬아웃(대상별 연결, 2408f0b가 결함 수정). 실음성 검증(P0)은 남은 조건.
9. 보안 규칙: API 키는 채팅에 붙이지 않는다(사용자가 직접 `~/.config/realtime-noel/soniox.env`와 Secret Manager `realtime-noel-soniox-api-key`에 설치 완료). 테스트는 fixture 문자열만. `git add -A` 금지. 운영 변경(마이그레이션 적용·Vercel·Cloud Run·DMG)은 사용자 승인 후.
10. **2026-09-05 오후 결정 D1~D5** (근거 `2026-09-05-cross-session-analysis-and-user-actions.md` §4, 기록 스펙 §11): D1 사용자별 즉시 전환(위 7 대체) · D2 Soniox 기본(위 8 대체) · D3 자동 모드 언어 힌트는 두 번째 세션 설계(입력 ≠ 출력, 비엄격) 유지, 실음성 P0 검증은 후속 · D4 수정+클린 게이트 뒤 전부 배포(Vercel 등록은 컨트롤러, 게이트웨이/Soniox 계정 단계는 사용자 안내) · D5 Vercel Root Directory는 리포 루트 유지.

---

## 4. 작업 스트림별 진행 상황

### 4.1 Plan 1 — 캡션 엔진 코어·데스크톱 (완료, 17 커밋 a94e507..cd31914)
- `packages/caption-core/caption-engine-catalog.js`: 엔진 카탈로그 SSOT(stt/translation/summary × gemini/soniox, capability, `normalizeEngineSelection`, `migrateLegacyEngineSelection`, `engineSelectionKey`, `validateEngineForLanguages`). 기본값 `DEFAULT_ENGINE_SELECTION` = Gemini Transcribe Live / 3.6 Flash / 3.6 Flash.
- 설정 `subtitle.engine`(+ 레거시 마이그레이션, `apiKeys.soniox`), 데스크톱 2단계 엔진 복원, transport seam(`src/caption-engine/`), Soniox 프로토콜·전송(`soniox-protocol.js`, `soniox-transport.js`), 설정 저장 즉시 `restartChannels`(새 채널 먼저 열고 이전 닫기), 설정 UI(엔진 드롭다운·언어 모드·Soniox 키 저장), spike 스크립트 `npm run spike:engine`.
- 원장: `.superpowers/sdd/2026-09-02-caption-engine-plan-1-core-desktop/progress.md`.

### 4.2 Soniox spike와 계약 수정 (완료)
- 실측: 연속 발화 17 s 동안 `<end>` 0회, 종료는 **빈 텍스트 프레임**이어야 함(빈 바이너리는 무시), `finalize`→`<fin>` 300 ms.
- 수정 `2aca0cc`: `closePayload()` 빈 텍스트 프레임; `createSonioxFinalizeScheduler`(1.2 s 유휴/15 s 세그먼트 상한)로 `finalize` 전송, `<fin>`에서 확정. 재실행 결과 3개 모드 모두 정상 종료·오류 0·타 스크립트 오인식 0·양방향 번역 정확(`36e13bd`, 스펙 §재실행).
- 남은 확인: 실제 마이크 리허설, 그리고 mid-speech `finalize` 시 `<fin>` 프레임에 해당 세그먼트 번역이 실리는지(리뷰 M7).

### 4.3 경계 수정 ⑤·⑥ (완료)
- ⑥ 요약 복구 `3ed24a9` + `6225d53`: 빈 세션은 실패가 아닌 `empty`; 일반 실패도 재시도 가능; 호스트 `reset` RPC(`POST /summary { reset: true }`, 세션당 시간당 10회 한도); 시도 20 s/총 60 s, 일시적 오류만 1회 재시도(429는 1.5 s 대기); `SummarySkeleton` 로딩 컴포넌트; 마이그레이션 `202609010005`(추적 시작)·`202609020001`(**미적용**).
- ⑤ 기록 원문 `c6e0970`: `groupTranscriptReading`이 화자 전환·seq 공백·녹음 끊김에서만 새 턴; 턴은 문단 하나; 발언마다 `HH:MM:SS` 마커.

### 4.4 Plan A — 인증·가입·승인·데스크톱 딥링크 (완료, 8 커밋 + CSS 수정)
스펙 `2026-09-02-auth-approval-admin-console-design.md`, 계획 `2026-09-02-auth-plan-a-identity-login-desktop.md`, 원장 `.superpowers/sdd/2026-09-02-auth-plan-a-identity-login-desktop/progress.md`.
- `010c214` 마이그레이션 `202609020002`: `profiles`(status pending/approved/rejected/disabled, role host/admin, **`host_id`** = 쿠키 주체), `profile_events`, `desktop_login_codes`(sha256, 60 s, 1회), RPC 4개. 부트스트랩 관리자는 `ADMIN_USER_IDS` 첫 항목(`noel`)을 `host_id`로 상속하므로 기존 세션 소유가 유지된다.
- `57c02a8` `SupabaseProfileStore`(서버 측 `GET /auth/v1/user`로 토큰 검증, publishable 키만 사용), `ADMIN_BOOTSTRAP_EMAILS`.
- `73bbe14` `POST /api/auth/exchange`(승인된 경우만 쿠키 발급; pending→`/pending`; 데스크톱은 `nova://auth/callback?code&state` 반환), `POST /api/auth/desktop-exchange`.
- `eed3299`+`16a524c` `requireHost` 승인 상태 게이트(60 s 캐시; 프로필 없는 uuid 호스트는 거부), `/api/auth/session`에 `role`.
- `da6cd1a`+`2a0763a` 로그인 카드(Google → 구분선 → 이메일/아이디 + 비번(표시 토글) → 로그인 → 회원가입/재설정), `/auth/callback`, `/pending`. 375/1280 px 직접 확인.
- `23bdd56`+`a1f2942` 데스크톱: 시스템 브라우저 구글 로그인 → `nova://` 딥링크(패키지 빌드 또는 `NOVA_DEV_DEEP_LINK=1`일 때만 등록) → `/api/auth/desktop-exchange` → 쿠키.
- `3b4dd05` 문서·env 예시; `bbe52d6` 루트 테스트 핀 갱신.
- 미해결: 비밀번호 재설정 링크가 `/auth/callback`으로 와서 "새 비밀번호 설정" 화면이 없음(후속).

### 4.5 Plan B — 관리자 콘솔 (완료: Task 1~6b + Task 7 문서)
계획 `2026-09-02-auth-plan-b-admin-console.md`, 원장 `.superpowers/sdd/2026-09-02-auth-plan-b-admin-console/progress.md`.
- `53d8ed8` 마이그레이션 `202609020003`: `engine_defaults`, `console_settings`(레거시 비번 로그인 스위치), RPC(`list_profiles_admin_v1`, `set_profile_status_v1`, `set_profile_role_v1`, `list_sessions_admin_v1`, `read_console_settings_v1`, `set_engine_defaults_v1`, `set_legacy_password_login_v1`). 마지막 관리자 보호·자기 변경 금지·상태 전이 규칙은 SQL에서 강제.
- `a077878` 콘솔 스토어, `requireAdmin`, 엔진 기본값 정규화.
- `4d1c39d` API 라우트(`/api/console/users|sessions|engine-defaults|settings`), `/api/login`에 `LEGACY_LOGIN_DISABLED`, `/api/live-config`에 `engineDefaults`.
- `a04ee1d`+`00b4a23` 콘솔 UI(`/console/users|sessions|engine`), 대시보드 "콘솔" 링크(관리자만), §9 반영: 엔진 페이지의 주 액션은 **"배포"**, 확인 다이얼로그, 세션별 결과 표.
- `852c486`+`1f8e1ed` 데스크톱 "콘솔" 버튼·창(관리자만), Live Call 생성은 항상 관리자 엔진 사용.
- `f784cd9` Task 6a: `set_live_session_engine_admin_v1`(진행 중 세션의 `event_metadata.modelPreferences.engine` 교체 + `engineHistory` ≤ 8개·3800바이트 예산·`reason`), `list_live_session_ids_admin_v1` (마이그레이션 `202609020004`, **미적용**). 레거시 `{ source, summary }`는 병합 대신 교체, 동일 엔진 재배포도 히스토리 추가.
- `327a0c6` Task 6b: 콘솔 "배포" `PUT /api/console/engine-defaults` → `set_engine_defaults_v1` → `preparing|live` 세션마다 RPC + `pushEngineToGateway`(60 s ADMIN 토큰, 동시성 4) → `{ engine, results[{ sessionId, result: switched|queued|failed, code? }], summary }` → `record_console_deploy_v1`(마이그레이션 `202609020005`, **미적용**; 배포 1회 = `profile_events.engine_defaults` 행 2개).
- Task 7(문서, 하드닝 브랜치): AGENTS.md "Admin console" 단락, `supabase/README.md` 마이그레이션 11·12 + "Admin console" 소절, 스펙 상태줄 + §10 구현 편차, 메모리 `live-call-host-auth-contract.md`, 이 문서.
- 콘솔 화면의 실제 브라우저 확인은 승인된 관리자 프로필이 필요해 배포 후 부트스트랩 로그인 시점에 한다.

### 4.6 Plan 2 — 게이트웨이·웹앱 엔진 전환 (Task 1~6 완료, Task 7 게이트 1단계 통과)
계획 `2026-09-02-caption-engine-plan-2-gateway-webapp.md`, 원장 `.superpowers/sdd/2026-09-02-caption-engine-plan-2-gateway-webapp/progress.md`.
- Task 1 `30d5634`+`01fa7e3`: 게이트웨이 엔진 팩토리(`media-gateway/src/engines/create-engines.js`), 어댑터가 카탈로그 모델 사용, 번역 폴백 체인(모델당 1회, 시도 2.8 s/총 6 s, 세션 런타임을 통과해도 429/5xx가 폴백으로 이어지도록 오류 코드 매핑 수정), `translateWithProvenance`.
- Task 2 `d234071`+`dd7943a`: Soniox 게이트웨이 어댑터(24 테스트; 키는 private 필드; 빈 텍스트 프레임 종료; finalize 스케줄러).
- Task 3 `60e4b7d`+`b90fd9e`: 파이프라인 결합 공급자 경로(원문·번역 동시 확정, 부분 번역은 seq 소비 없이 게시 — 계약 C1), 엔진 기반 provenance, Live Translate 경로 삭제, `RollingSpeechSession`이 스트림별 rollover(Soniox 290분/Gemini 540 s), 결합 모드 누락 레인은 cooldown 없이 fail-open.
- Task 4 `00f2ad4`: `modelPreferences = { engine, engineHistory }`, 서버 권위(비관리자 엔진은 전역값으로 대체), 게이트웨이 authorizer가 `engineSelectionKey` 비교, 데스크톱이 `{ engine }` 전송, Live Translate 모델 거부. 세 스위트 모두 녹색(웹앱 928, 게이트웨이 587).
  - **리뷰(REQUEST CHANGES)**: 클린 체크아웃에서 (C1) 요약 모델이 실제 호출 모델과 다르게 기록됨(의존 WT 파일 미커밋), (C2) 웹 호스트 대시보드가 `modelPreferences`를 보내지 않아 관리자가 비기본 엔진을 배포하면 authorizer가 거부, (I1) `engineHistory` 64개 캡이 `event_metadata` 4096바이트 제한을 초과. **판정**: 히스토리는 8개 이하 + 직렬화 본문 3800바이트 초과 시 오래된 것부터 삭제(웹앱과 Task 6a RPC 동일 규칙), 엔트리에 `reason` 추가.
  - fix round A `d9b9b8f` + `bbfc403`: 요약 모델이 클린 체크아웃에서도 세션 엔진을 따름(`summary-gemini-adapter.ts`, `rest-recap.js` 모델별 URL), `engineHistory` 8개/3800바이트 규칙(웹앱 store + Task 6a RPC 동일), `listOwnedActive` 행별 파싱 격리, 소스 모델은 Live 2종만 허용(flash 소스 핀은 fail-closed — 배포 전 저장 형태 스캔 필요).
- Task 5 `00556e5`: 게이트웨이 `POST /internal/sessions/:id/engine`(60 s ADMIN 토큰, fail-closed 매트릭스, 콜드 세션 `queued`), 파이프라인 교체 시 seq 연속(C1), 호스트 `engine-status`(엔진 역할별, 시작 ACK 앞에도 전송), 뷰어 `preparing→ready`, 대시보드 `modelPreferences` 전달(C2), 컨트롤러 엔진 pill, `gateway-engine-push.ts`(웹앱이 게이트웨이의 `verifyAdminGatewayToken`으로 토큰을 검증하는 교차 계약 테스트).
- Task 6 `4c28deb`(입력 소스 마이그레이션 `202609010001~0004` + bootstrap 미러), `461f026`(데스크톱 Live Call archive/drain 모듈 등 WT 커밋), `906fe46`(데스크톱이 게이트웨이 (재)시작 전 세션 레코드에서 엔진을 다시 핀 — Task 5 후속 I1), `5b5d964`(웹앱 소스 레저·스냅샷 동기화·자막 provenance·요약 원문), `949b06f`(엔진 카탈로그 핀 정합 + 게이트웨이 WT 커밋). 이 시점부터 **커밋된 브랜치가 자체 정합**이다(WT 진실 규칙 종료).
- Task 7 1단계(클린 워크트리 게이트, 949b06f, node_modules 심링크): 루트 typecheck 클린, 1676 / 1662 pass / 0 fail / 14 skip; 게이트웨이 591/591; 웹앱 typecheck 클린, `test:live` 943/943 + `test:core` 77/77. 남은 것: 하드닝 라운드(Task 5 리뷰 M1~M5 + 게이트웨이 재접속 warm 판정) → 게이트 재실행 → 배포.

### 4.7 통합(2026-09-05 오후) — 브랜치 `codex/nova-integration-20260905`

두 번째 세션이 메인 워킹트리에 남긴 미커밋 작업(~380 파일: 제품 경계 NOVA 전용, Soniox 기본, 사용자별 엔진 배정, 관리형 자막 자격증명, 화자 명단, 접근 갱신, 요약 폴링)을 949b06f 위에 체크포인트로 커밋하고, 대조 분석(`2026-09-05-cross-session-analysis-and-user-actions.md`)에서 찾은 결함을 D1~D5에 맞춰 고친 뒤 하드닝 브랜치를 병합했다. 원장 `.superpowers/sdd/2026-09-05-nova-integration/progress.md`. 커밋(시간순):

- `b8dcba0` wip(checkpoint): 두 번째 세션의 미커밋 NOVA 작업 스냅샷(`git add -A` 1회, 루트 `controller.js`/`live-interpreter.js` 제외; 이후 커밋은 파일 지정 스테이징만).
- `5d4c271` fix(live): 두 호스트 리더(데스크톱 `readLiveCallModelPreferences`, 웹 `readHostModelPreferences`)가 서버가 고정한 `assignmentRevision`을 허용·폐기 — 이 키 때문에 새 Live Call이 시작되지 않던 치명 결함(C1) 수정, 생성→시작 왕복 계약 테스트 추가.
- `d8a2b00` merge: `codex/engine-hardening-20260905`(ec128de warm reattach·엔진 전환 시도 정리·키 존재 플래그·413 hangup·레인 인식 ready 재공지 + 문서 3건) 병합.
- `2408f0b` fix(gateway): Soniox 팬아웃 — 시간 범위 정렬(≥50% 겹침 + 정규화 텍스트), 죽은/복구 중 레인은 대기에서 제외(죽은 레인 1개당 최종 자막 3초 지연 → 0), 백프레셔는 비치명, 일시 오류는 상한 백오프로 레인 재개(3회 연속 실패 시 `SONIOX_TRANSLATION_UNAVAILABLE`), 레인별 롤오버 60초 어긋나기, 늦은 임시 자막 지연.
- `6ef36b7` feat(supabase): `202609050005` — `set_live_session_engine_admin_v1` service_role 재부여(0001의 회수 되돌림) + `set_live_session_engine_admin_v2`(assignmentRevision 기록)·`list_live_session_ids_for_host_admin_v1`·`set_profile_voice_provider_v2`.
- `069a73d` fix(auth): 승인 캐시가 저장소 장애 시 마지막 값을 TTL 지나 10분까지 유지(전원 잠금 방지); 레거시 `noel` 로그인은 `ADMIN_BOOTSTRAP_EMAILS` 미설정 로컬에서 기존 동작(break-glass).
- `9061071` feat(console): 운영자의 사용자별 엔진 배정이 그 사용자의 진행 중 세션에 즉시 적용 — `PATCH /api/console/users { voiceProvider }` → `set_profile_voice_provider_v2` → `engineSelectionForVoiceProvider` → 세션별 `set_live_session_engine_admin_v2` + 게이트웨이 `POST /internal/sessions/:id/engine`(60초 ADMIN 토큰); `PUT /api/console/engine-defaults`는 410 `ENGINE_DEFAULTS_RETIRED`; `deployEngineToActiveSessions`·`gateway-engine-push.ts` 등 죽은 코드 삭제.
- `19b7d9c` fix(console): 죽은 전역 엔진 패널을 안내 카드 + `/console/users` 링크로 교체; 사용자 행 엔진 셀렉트에 확인 다이얼로그(진행 중 세션 수) + 인라인 세션별 결과; 콘솔 문구 전부 `t()`(ko/en/ja), 사전 밖 한국어 리터럴을 거부하는 테스트.
- `5e581bf` fix(supabase): `202609050003`/`0004` 멱등화(`if not exists`/`create or replace`/do-block 가드 rename; PGlite 테스트가 두 번 적용 + 금지 패턴 핀; bootstrap 미러 갱신) + 관리형 자막 갱신 24시간 유예(`CAPTION_SESSION_EXPIRED`, 브로커 410).
- `74470c6` fix(live): 요약 폴링 벽시계 상한 30분(`SUMMARY_GENERATION_STALLED`), 읽기 실패 소진 `SUMMARY_READ_EXHAUSTED`, ko/en/ja 문구.
- `5ea73b9` fix(desktop): 설정 로드가 `translateAllLanguages`로 `ja`를 조용히 추가하지 않음(언어 1개 = Soniox 연결 1개); 마이크/시스템 Soniox 롤오버 오프셋 +30초 어긋나기.
- `43def59` fix(captions): Gemini 임시 토큰의 `languageCodes`가 티켓 언어의 부분집합이 아니면 400 `CAPTION_LANGUAGES_MISMATCH`.
- `4c2cbbf` fix(stage): 스테이지의 `/host-screen` 링크가 `target=_blank rel=noopener` — Electron 스테이지 창은 열기 거부, 브라우저 프로젝터는 탭 유지.

클린 게이트(4c2cbbf, 격리 워크트리 + node_modules 심링크): 루트 1537 / 1517 pass / 0 fail / 20 skip(PGlite 테스트는 `NOVA_PGLITE_MODULE` 필요), 게이트웨이 644/644, 웹앱 `test:live` 1043/1043 + `test:core` 79/79, 타입체크 2종 클린. 통합 중 Vercel 프로덕션 환경변수 `ADMIN_BOOTSTRAP_EMAILS`·`SONIOX_API_KEY` 등록 완료(다음 배포부터 유효). 게이트웨이 Cloud Run에는 `SONIOX_API_KEY` 시크릿이 아직 연결되지 않았고 `GEMINI_LIVE_MODEL`은 더 이상 읽지 않는다(배포 시 `--update-secrets` / `--remove-env-vars`). 남은 결함: 데스크톱 마이크+시스템 팬아웃의 프로세스 수준 stagger는 5ea73b9로 30초 오프셋만 적용.

### 4.8 리뷰에서 나온 결정 중 기억할 것
- 게이트웨이 Live Call 확정 자막에 LLM polish는 **넣지 않는다**(2026-08-31 지연 계약; 번역 호출이 최종 텍스트를 만들고 결정적 용어집 패스는 유지). 데스크톱 로컬 자막의 polish는 그대로.
- 계약 C1(자막 seq는 확정에만 소비)은 게이트웨이·뷰어 양쪽에 `contract C1` 마커로 표시되어 있고 한쪽만 바꾸면 안 된다.
- Node의 `--experimental-strip-types`는 TS 파라미터 프로퍼티·enum을 지원하지 않는다(명시적 필드 사용). 프리커밋 시크릿 스캐너는 `const x = "…token…"` 형태를 막으므로 fixture 리터럴은 호출부에 인라인한다.
- 워킹트리에 이전 워크스트림의 미커밋 변경(~580줄 bootstrap 미러, 게이트웨이/웹앱 파일)이 많아, 커밋은 **자기 헝크만**(`git apply --cached` 또는 `git hash-object` + `update-index`) 스테이징한다. Plan 2 Task 6가 게이트웨이 WT를 정리·커밋하기 전까지는 **워킹트리가 런타임 진실**이며 개별 커밋은 클린 체크아웃에서 빨갈 수 있다.

---

## 5. 지금 워킹트리·커밋 상태

- 브랜치 `codex/nova-integration-20260905` HEAD `4c2cbbf`(949b06f → 하드닝 ec128de·문서 → 체크포인트 b8dcba0 → 통합 수정 12커밋, §4.7). `codex/google-live-latency-20260831`은 949b06f에 머물러 있고, 하드닝 브랜치는 d8a2b00에서 병합됐다. 배포된 서비스(Vercel 웹앱, Cloud Run 게이트웨이 리비전 `live-input-20260901`, 설치된 NOVA.app)는 **아직 아무것도 반영되지 않았다**.
- 4c2cbbf 클린 체크아웃 스위트: 루트 1537 / 1517 pass / 0 fail / 20 skip, 게이트웨이 644/644, 웹앱 `test:live` 1043 + `test:core` 79, 타입체크 2종 클린(§4.7).
- 메인 워킹트리는 이제 통합 브랜치 그 자체다. 추적되지 않는 루트 `controller.js`·`live-interpreter.js`는 두 번째 세션의 잔여물로 커밋 대상이 아니다.
- **미적용 마이그레이션(파일명 순으로 적용, 순서 준수)**: `202609020001_live_summary_generic_failure_retry.sql`, `202609020002_auth_profiles_desktop_codes.sql`, `202609020003_console_rpcs.sql`, `202609020004_live_session_engine_admin.sql`, `202609020005_console_deploy_audit.sql`, 그 뒤 `202609050001_user_engine_access_renewal.sql`, `202609050002_managed_caption_sessions.sql`, `202609050003_live_speaker_roster.sql`, `202609050004_speaker_profile_history.sql`, `202609050005_regrant_session_engine_admin.sql`. 202609050001은 202609020002~0005에 의존하고, 0005는 0001 뒤여야 한다. 0003/0004는 멱등(5e581bf). `202609010001~0005`의 배포 DB 적용 여부는 배포 전 `supabase migration list`로 확인.
- 원장(`.superpowers/sdd/*/progress.md`)은 gitignore 대상이라 커밋에 없다. 모든 판정·편차가 거기에 있다.

## 6. 남은 작업 (순서)

완료: Plan 1·Plan 2·Plan A·Plan B, 하드닝 라운드(ec128de, d8a2b00 병합), 두 번째 세션 체크포인트와 통합 수정(§4.7), 클린 게이트(4c2cbbf 녹색), 이 문서·AGENTS.md·`supabase/README.md`·스펙 §11 갱신. 남은 순서:

1. **T2b 코드 리뷰 판정 반영**(원장 18:58 dispatched): 콘솔 사용자별 즉시 전환(9061071, 19b7d9c)의 리뷰 결과에 따라 수정 라운드가 있으면 게이트 재실행.
2. **배포(D4, 사용자 go 필요, 단계별 승인)**: 마이그레이션 10개 적용(§5 순서; `202609010001~0005` 적용 여부 먼저 확인; 배포 직전 읽기 전용 SQL 2건은 `2026-09-05-cross-session-analysis-and-user-actions.md` §6.3) → **게이트웨이 먼저** Cloud Run 새 리비전(`--update-secrets SONIOX_API_KEY=realtime-noel-soniox-api-key:latest`, `--remove-env-vars GEMINI_LIVE_MODEL`; 트래픽 없이 → health → 전환, 롤백 `live-input-20260901`) → Vercel 프로덕션(리포 루트, 환경변수는 등록 완료) → 부트스트랩 관리자 Google 첫 로그인 → `/console/users`에서 엔진 셀렉트 실제 확인(`queued|switched`, 5xx 없음) → DMG 빌드·설치(`nova` 스킴) → 종단 확인 → 안정화 후 레거시 비번 로그인 끄기. 상세 명령은 `2026-09-05-deploy-runbook.md`(전역 배포 단계는 사용자별 전환으로 읽을 것).
3. **실음성 P0 검증**(D2·D3 조건): 한국어·영어·일본어 동일 녹음, 화자/언어 전환, 10분 이상 연속 — Soniox 기본·비엄격 힌트에서 타 스크립트 오인식 0건, 3개 언어 팬아웃의 언어별 누락률·지연 측정. Soniox 동시 연결 한도(기본 10, 3개 언어 운영에 20 이상) 확인.
4. 후속: 비밀번호 재설정 화면, 데스크톱 마이크+시스템 팬아웃의 프로세스 수준 stagger, 결합 엔진(Soniox)에서 꺼지는 주제 추론·요약 부수 기능의 상태 표시, XLSX 내보내기의 빈 레인 라벨, 새 게이트웨이 메트릭(엔진 전환·팬아웃 레인) 대시보드.

## 7. 사용자가 직접 해야 하는 것 (비밀 값은 채팅에 올리지 않음)

1. Google Cloud Console: OAuth 2.0 웹 클라이언트 생성, 승인된 리디렉션 URI에 Supabase 콜백 `https://<project-ref>.supabase.co/auth/v1/callback` 등록.
2. Supabase Dashboard → Authentication → Providers → Google 활성화(클라이언트 ID/시크릿 입력); URL Configuration에 `https://realtime-noel-web.vercel.app/auth/callback` 추가; 이메일 확인 켜기.
3. Vercel 환경변수 `ADMIN_BOOTSTRAP_EMAILS`(관리자 이메일, 쉼표 구분) 추가. 게이트웨이 Cloud Run에는 `SONIOX_API_KEY` 시크릿 연결(배포 명령에 포함).
4. 배포 각 단계에 "진행" 승인.

---

## 8. 참고 파일 지도

- 스펙: `docs/superpowers/specs/2026-09-02-*.md`(근본 원인, 모델 조사, Gemini Live API, Soniox 적합성+spike, 엔진 핫스왑 설계, 인증·콘솔 설계 §9 포함).
- 계획: `docs/superpowers/plans/2026-09-02-caption-engine-plan-1-core-desktop.md`, `…-plan-2-gateway-webapp.md`, `…-auth-plan-a-identity-login-desktop.md`, `…-auth-plan-b-admin-console.md`.
- 원장: `.superpowers/sdd/{2026-09-02-caption-engine-plan-1-core-desktop,2026-09-02-caption-engine-plan-2-gateway-webapp,2026-09-02-auth-plan-a-identity-login-desktop,2026-09-02-auth-plan-b-admin-console,bounded-fixes}/`.
- 운영 메모(AGENTS.md "Live translation architecture" → Host identity 단락, `supabase/README.md` Authentication 설정, `webapp/.env.example`).
