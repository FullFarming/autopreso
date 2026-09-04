# NOVA (realtime-noel) — 프로젝트 정리와 작업 이력 (2026-09-05 기준)

작성 시각: 2026-09-05 08:45 KST. 브랜치 `codex/google-live-latency-20260831`, HEAD `f784cd9`. 이 문서는 2026-09-02부터 이어진 작업의 맥락·결정·진행 상황을 한곳에 모은 것이다. 세부 근거는 각 스펙·계획·원장 파일에 있으며, 여기서는 경로만 가리킨다.

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
7. **2026-09-04 추가 결정**: Live Call 엔진은 **관리자가 콘솔에서 정한 전역 값 하나**, 호스트는 **바꿀 수 없음(잠금)**, 배포 시 **진행 중 세션도 즉시 전환**. 데스크톱 `subtitle.engine`은 로컬 자막 전용. (`2026-09-02-auth-approval-admin-console-design.md` §9)
8. 기본 공급자: spike 결과에도 **Gemini Transcribe + Flash 유지**(합성 음성만으로 실제 마이크 정확도를 판정할 수 없고, 3개 언어 세션은 Gemini 번역이 필요하며, 배포된 게이트웨이에 Soniox 레인이 없기 때문). Soniox는 관리자가 선택 가능한 결합 엔진.
9. 보안 규칙: API 키는 채팅에 붙이지 않는다(사용자가 직접 `~/.config/realtime-noel/soniox.env`와 Secret Manager `realtime-noel-soniox-api-key`에 설치 완료). 테스트는 fixture 문자열만. `git add -A` 금지. 운영 변경(마이그레이션 적용·Vercel·Cloud Run·DMG)은 사용자 승인 후.

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

### 4.5 Plan B — 관리자 콘솔 (거의 완료)
계획 `2026-09-02-auth-plan-b-admin-console.md`, 원장 `.superpowers/sdd/2026-09-02-auth-plan-b-admin-console/progress.md`.
- `53d8ed8` 마이그레이션 `202609020003`: `engine_defaults`, `console_settings`(레거시 비번 로그인 스위치), RPC(`list_profiles_admin_v1`, `set_profile_status_v1`, `set_profile_role_v1`, `list_sessions_admin_v1`, `read_console_settings_v1`, `set_engine_defaults_v1`, `set_legacy_password_login_v1`). 마지막 관리자 보호·자기 변경 금지·상태 전이 규칙은 SQL에서 강제.
- `a077878` 콘솔 스토어, `requireAdmin`, 엔진 기본값 정규화.
- `4d1c39d` API 라우트(`/api/console/users|sessions|engine-defaults|settings`), `/api/login`에 `LEGACY_LOGIN_DISABLED`, `/api/live-config`에 `engineDefaults`.
- `a04ee1d`+`00b4a23` 콘솔 UI(`/console/users|sessions|engine`), 대시보드 "콘솔" 링크(관리자만), §9 반영: 엔진 페이지의 주 액션은 **"배포"**, 확인 다이얼로그, 세션별 결과 표.
- `852c486`+`1f8e1ed` 데스크톱 "콘솔" 버튼·창(관리자만), Live Call 생성은 항상 관리자 엔진 사용.
- `f784cd9` Task 6a: `set_live_session_engine_admin_v1`(진행 중 세션의 `event_metadata.modelPreferences.engine` 교체 + `engineHistory`), `list_live_session_ids_admin_v1` (마이그레이션 `202609020004`, **미적용**).
- **남은 일**: Task 6b(배포 PUT이 진행 중 세션마다 RPC + 게이트웨이 푸시 호출, 감사 페이로드), Task 7(문서). 콘솔 화면의 실제 브라우저 확인은 승인된 관리자 프로필이 필요해 배포 후 부트스트랩 로그인 시점으로 미룸.

### 4.6 Plan 2 — 게이트웨이·웹앱 엔진 전환 (진행 중)
계획 `2026-09-02-caption-engine-plan-2-gateway-webapp.md`, 원장 `.superpowers/sdd/2026-09-02-caption-engine-plan-2-gateway-webapp/progress.md`.
- Task 1 `30d5634`+`01fa7e3`: 게이트웨이 엔진 팩토리(`media-gateway/src/engines/create-engines.js`), 어댑터가 카탈로그 모델 사용, 번역 폴백 체인(모델당 1회, 시도 2.8 s/총 6 s, 세션 런타임을 통과해도 429/5xx가 폴백으로 이어지도록 오류 코드 매핑 수정), `translateWithProvenance`.
- Task 2 `d234071`+`dd7943a`: Soniox 게이트웨이 어댑터(24 테스트; 키는 private 필드; 빈 텍스트 프레임 종료; finalize 스케줄러).
- Task 3 `60e4b7d`+`b90fd9e`: 파이프라인 결합 공급자 경로(원문·번역 동시 확정, 부분 번역은 seq 소비 없이 게시 — 계약 C1), 엔진 기반 provenance, Live Translate 경로 삭제, `RollingSpeechSession`이 스트림별 rollover(Soniox 290분/Gemini 540 s), 결합 모드 누락 레인은 cooldown 없이 fail-open.
- Task 4 `00f2ad4`: `modelPreferences = { engine, engineHistory }`, 서버 권위(비관리자 엔진은 전역값으로 대체), 게이트웨이 authorizer가 `engineSelectionKey` 비교, 데스크톱이 `{ engine }` 전송, Live Translate 모델 거부. 세 스위트 모두 녹색(웹앱 928, 게이트웨이 587).
  - **리뷰(REQUEST CHANGES)**: 클린 체크아웃에서 (C1) 요약 모델이 실제 호출 모델과 다르게 기록됨(의존 WT 파일 미커밋), (C2) 웹 호스트 대시보드가 `modelPreferences`를 보내지 않아 관리자가 비기본 엔진을 배포하면 authorizer가 거부, (I1) `engineHistory` 64개 캡이 `event_metadata` 4096바이트 제한을 초과. **판정**: 히스토리는 8개 이하 + 직렬화 본문 3800바이트 초과 시 오래된 것부터 삭제(웹앱과 Task 6a RPC 동일 규칙), 엔트리에 `reason` 추가.
  - **진행 중**: fix round A(C1·I1·I2·I3·M1~M6, 클린 워크트리 게이트), Task 5(재시작: 게이트웨이 `POST /internal/sessions/:id/engine` + ADMIN 게이트웨이 토큰 + `engine-status` + 대시보드 `modelPreferences` 전달(C2) + 컨트롤러 엔진 pill).
- 남은 Task 6(모든 핀 정합 + 게이트웨이/gemini-server WT 커밋 → 브랜치가 자체 정합), Task 7(클린 워크트리 검증 → 배포).

### 4.7 리뷰에서 나온 결정 중 기억할 것
- 게이트웨이 Live Call 확정 자막에 LLM polish는 **넣지 않는다**(2026-08-31 지연 계약; 번역 호출이 최종 텍스트를 만들고 결정적 용어집 패스는 유지). 데스크톱 로컬 자막의 polish는 그대로.
- 계약 C1(자막 seq는 확정에만 소비)은 게이트웨이·뷰어 양쪽에 `contract C1` 마커로 표시되어 있고 한쪽만 바꾸면 안 된다.
- Node의 `--experimental-strip-types`는 TS 파라미터 프로퍼티·enum을 지원하지 않는다(명시적 필드 사용). 프리커밋 시크릿 스캐너는 `const x = "…token…"` 형태를 막으므로 fixture 리터럴은 호출부에 인라인한다.
- 워킹트리에 이전 워크스트림의 미커밋 변경(~580줄 bootstrap 미러, 게이트웨이/웹앱 파일)이 많아, 커밋은 **자기 헝크만**(`git apply --cached` 또는 `git hash-object` + `update-index`) 스테이징한다. Plan 2 Task 6가 게이트웨이 WT를 정리·커밋하기 전까지는 **워킹트리가 런타임 진실**이며 개별 커밋은 클린 체크아웃에서 빨갈 수 있다.

---

## 5. 지금 워킹트리·커밋 상태

- HEAD `f784cd9`. 이번 스트림 커밋 55개(2026-09-02~04). 배포된 서비스(Vercel 웹앱, Cloud Run 게이트웨이, 설치된 NOVA.app)는 **아직 아무것도 반영되지 않았다**.
- 스위트(WT 기준, Task 4 직후): 웹앱 `test:live` 928/928 + `test:core` 77/77, 게이트웨이 587/587, 루트 1627(부하 시 흔들리는 성능 테스트 2개 제외 전부 통과), 타입체크 모두 깨끗. 클린 체크아웃은 fix round A와 Task 6 뒤에 녹색이 되어야 한다.
- 미적용 마이그레이션(파일명 순으로 적용): `202609020001_live_summary_generic_failure_retry.sql`, `202609020002_auth_profiles_desktop_codes.sql`, `202609020003_console_rpcs.sql`, `202609020004_live_session_engine_admin.sql`. `202609010005`는 배포 DB에 이미 있는 것으로 보고 있으나 Task 7에서 확인.
- 원장(`.superpowers/sdd/*/progress.md`)은 gitignore 대상이라 커밋에 없다. 모든 판정·편차가 거기에 있다.

---

## 6. 남은 작업 (순서)

1. Plan 2 Task 4 fix round A → 클린 워크트리 게이트 통과.
2. Plan 2 Task 5(진행 중 세션 엔진 전환 엔드포인트, `engine-status`, 대시보드 `modelPreferences` 전달).
3. Plan B Task 6b: 콘솔 "배포" PUT → `set_engine_defaults_v1` → 진행 중 세션마다 `set_live_session_engine_admin_v1` + `pushEngineToGateway` → 결과 표 응답 → `profile_events.engine_defaults`에 `{ engine, sessionsSwitched, sessionsFailed }`.
4. Plan 2 Task 6: 남은 핀 정합, 게이트웨이/gemini-server 워킹트리 커밋, bootstrap 미러 정리, `google-live-client.js` 잔여 정리, 삭제된 경로를 쓰는 루트 SQL 테스트 정리.
5. Plan B Task 7 문서, Plan 2 Task 7 클린 워크트리 검증(`npm ci` 3종 + 스위트 3종 + 타입체크 2종).
6. **배포(사용자 승인 필요)**: 마이그레이션 4개 적용 → Vercel 프로덕션 → 부트스트랩 관리자 구글 첫 로그인으로 프로필 생성 확인 → 콘솔 `/console/users`·`/console/engine` 실제 화면 확인 → 게이트웨이 Cloud Run 새 리비전(`--update-secrets SONIOX_API_KEY=realtime-noel-soniox-api-key:latest`, 트래픽 전환은 별도 명령) → DMG 빌드·설치(`nova` 스킴) → 안정화 후 콘솔에서 레거시 비번 로그인 끄기.
7. 후속: 비밀번호 재설정 화면, Soniox 실제 마이크 리허설 + mid-speech finalize 번역 검증 후 기본 공급자 재검토, XLSX 내보내기의 빈 레인 라벨.

---

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
