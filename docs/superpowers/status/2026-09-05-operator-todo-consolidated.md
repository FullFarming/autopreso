# 운영 반영 전 해야 할 일 — 두 작업 흐름 통합 정리 (2026-09-05)

이 문서는 두 문서를 합쳐 다시 정리한 것이다.
- 이 세션의 결과: `docs/superpowers/status/2026-09-05-project-status-and-worklog.md`, `2026-09-05-deploy-runbook.md` (브랜치 `codex/engine-hardening-20260905`, HEAD 9cf5480, 클린 체크아웃 게이트 통과).
- 다른 곳에서 진행된 작업의 문서: `docs/superpowers/status/2026-09-05-operator-setup.md`, `2026-09-05-core-product-implementation.md`, `2026-09-05-project-separation.md` (메인 워킹트리에 **미커밋** 상태로 있는 약 330개 파일 변경의 설명서).

두 작업은 같은 저장소에서 순차로 쌓여 있다. 다른 곳의 작업은 이 세션의 커밋(949b06f) 위에 올라간 워킹트리 변경이며, 이 세션의 콘솔·배포 코드를 그대로 쓰면서 기본값과 배정 모델을 바꾸었다. 그래서 **먼저 결정해야 할 충돌 3가지**가 있고, 그 다음에 계정·대시보드 작업, 배포 순서가 온다.

---

## 1. 먼저 결정할 것 (사용자)

| # | 항목 | 이 세션(커밋됨) | 다른 곳(미커밋) | 결정이 필요한 이유 |
|---|---|---|---|---|
| D1 | 엔진 배정 모델 | 관리자가 정한 **전역 엔진 하나**. 호스트는 바꿀 수 없고, 콘솔 "배포"가 **진행 중 세션도 즉시** 전환(게이트웨이 내부 엔드포인트). 2026-09-04 사용자 결정(§9). | `profiles.voice_provider`로 **사용자별 배정**(Soniox 또는 Gemini). **다음 새 세션부터** 적용, 진행 중 세션 즉시 전환은 설계상 거절. | 두 규칙이 동시에 살아 있으면 콘솔에 "배포" 버튼과 사용자별 배정이 둘 다 보이고, 어느 쪽이 실제 엔진을 정하는지 운영자가 알 수 없다. 하나를 고르거나 "전역 기본값 + 사용자별 예외" 같은 우선순위를 정해야 한다. |
| D2 | 기본 엔진 | Gemini 3.5 Transcribe Live + Flash 번역 (spike 결론: 실제 마이크 검증 전, 3개 언어 세션 호환) | **Soniox 인식+번역** (신규 사용자 기본, 3개 언어는 대상별 별도 연결로 해결) | 카탈로그 `DEFAULT_ENGINE_SELECTION` 값이 다르다. Soniox 기본이면 Soniox 동시 연결 한도(입력당 최대 3, 교체 중 최대 6)와 US 리전 지연을 운영 전 확인해야 한다. |
| D3 | 무엇을 배포하나 | 커밋 55개 + 강화 브랜치 3커밋. 게이트 통과. | 위 커밋 위의 미커밋 변경(제품 분리, Soniox 기본, 관리형 PC 자막 티켓, 화자 로스터, 마이그레이션 4개 추가). 그 문서 기준 로컬 검증은 통과했다고 하나 **커밋·클린 게이트는 아직**. | (a) 이 세션 것만 먼저 배포하고 다른 작업은 다음 배포로, (b) 다른 작업을 커밋·게이트 후 한 번에 배포, 둘 중 하나. (a)가 위험이 작다. |
| D4 | Vercel 프로젝트 구조 | 현재 운영: **리포 루트**에서 배포(`.vercel/project.json`이 루트, 메모리 기록). | Root Directory를 `webapp`으로 바꾸고 "Include source files outside of the Root Directory" 켜기 | 지금 운영 중인 방식을 바꾸면 빌드 설정 변경이 필요하다. 바꿀 이유가 있는지 확인 후 결정. 결정 전에는 기존 방식 유지. |

결정 결과에 따라 코드 정합 작업(예: 콘솔에서 배포 버튼과 사용자별 배정 중 하나 숨기기, `DEFAULT_ENGINE_SELECTION` 통일, 다른 작업의 커밋과 게이트)이 필요하며, 그것은 제가 한다.

---

## 2. 사용자가 직접 해야 하는 계정·대시보드 작업 (비밀 값은 채팅·문서·`NEXT_PUBLIC_*`에 넣지 않음)

### 2.1 Google Cloud (OAuth 로그인용)
1. OAuth 동의 화면 구성. 앱이 Testing 상태면 실제로 쓸 계정을 Test users에 추가.
2. **웹 애플리케이션** 타입 OAuth Client ID 생성.
3. Authorized JavaScript origins: `https://realtime-noel-web.vercel.app` (그리고 쓰는 개발 origin).
4. Authorized redirect URIs: **Supabase 대시보드에 표시된 callback URL** (`https://<project-ref>.supabase.co/auth/v1/callback`). 앱의 `/auth/callback`을 여기에 넣지 않는다.
5. Client ID·Secret은 Supabase에만 입력한다(아래 2.2).

### 2.2 Supabase Dashboard → Authentication
1. Providers → Email 활성화, **이메일 확인(Confirm email) 켜기**.
2. Providers → Google 활성화, 2.1의 Client ID/Secret 입력.
3. URL Configuration → Site URL `https://realtime-noel-web.vercel.app`; Redirect URLs에 `https://realtime-noel-web.vercel.app/auth/callback` 추가(개발 환경을 쓰면 그 정확한 callback도).
4. 이메일 발송이 실제로 되는지(가입 확인·비밀번호 재설정 메일) 한 번 확인. 확인 메일이 오지 않으면 SMTP 설정이 필요하다.

### 2.3 Vercel (프로젝트 realtime-noel-web) 환경변수
기존 값은 유지하고 다음을 확인·추가한다. 값을 바꾼 뒤에는 **새 배포**가 있어야 반영된다.

| 변수 | 할 일 |
|---|---|
| `ADMIN_BOOTSTRAP_EMAILS` | **추가.** 본인이 소유한 실제 관리자 이메일(쉼표 구분). 첫 Google 로그인에서 이 이메일이 승인된 관리자가 되고 `host_id=noel`을 상속한다. |
| `ADMIN_USER_IDS` | `noel` 유지. |
| `ADMIN_PASSWORD_HASH` | 다른 곳 작업이 `node scripts/configure-admin-login.mjs`로 만든 해시를 쓰기로 했다면, 그 도구가 생성한 Vercel용 값(역슬래시 없는 원본)을 입력하고 평문 `ADMIN_PASSWORD`는 제거. 이 세션 것만 배포하면 기존 설정 그대로. |
| `LIVE_GATEWAY_URL` (선택) | 서버 측 게이트웨이 주소. 없으면 `NEXT_PUBLIC_LIVE_GATEWAY_URL`을 쓴다. |
| `SONIOX_API_KEY`, `GEMINI_API_KEY` | **다른 곳 작업(관리형 PC 자막 임시 키 발급)을 배포할 때만** 웹앱에도 필요. 이 세션 것만이면 웹앱에는 불필요(게이트웨이에만). |
| `LIVE_ALLOW_WEAK_TEST_LOGIN` | 운영에서 `false`. |

### 2.4 Cloud Run 미디어 게이트웨이 (프로젝트 gen-lang-client-0321430669)
- Secret Manager `realtime-noel-soniox-api-key`는 이미 설치됨. 배포 명령의 `--update-secrets SONIOX_API_KEY=realtime-noel-soniox-api-key:latest`로 연결한다(제가 실행).
- `LIVE_GATEWAY_TOKEN_SECRET`, `LIVE_VIEWER_TOKEN_SECRET`는 웹앱과 **정확히 같은 값**이어야 한다(관리자 엔진 전환 토큰도 이 키로 서명). 기존 값을 새로 만들지 않는다.
- Soniox를 기본으로 쓰기로 하면(D2) Soniox 계정의 동시 연결 한도를 확인한다: 입력당 최대 3 스트림, 연결 교체 중 최대 6, 마이크+시스템 오디오 동시 사용 시 2배.

### 2.5 Supabase SQL Editor — 배포 직전 읽기 전용 확인 2건
```sql
-- 1) 이제 거부되는 옛 형태(modelPreferences.source가 Flash id)의 세션이 있는지
select id, status, event_metadata->'modelPreferences' as mp
from public.live_sessions
where event_metadata ? 'modelPreferences'
  and not (event_metadata->'modelPreferences' ? 'engine')
  and coalesce(event_metadata->'modelPreferences'->>'source','') not in ('gemini-3.5-live-translate-preview','gemini-3.5-transcribe-live');
```
행이 있으면 알려주세요. 해당 행을 `{ "engine": <전역 엔진> }`으로 고치는 UPDATE를 별도로 제안합니다.
```sql
-- 2) 이벤트 메타데이터 정규화 함수 본문(authoritativeSourceId/sourceSequence 허용 여부)
select pg_get_functiondef('public.normalize_live_session_event_metadata'::regproc);
```
결과 본문을 그대로 붙여 주시면 제가 판독합니다.

---

## 3. 마이그레이션 적용 (Supabase SQL Editor, 파일명 순, 각 파일 전체 붙여넣기 → Run)

### 3.1 이 세션 것 (필수, 순서대로)
1. `202609020001_live_summary_generic_failure_retry.sql` — 요약 실패 복구·빈 세션 `empty`
2. `202609020002_auth_profiles_desktop_codes.sql` — `profiles`, `profile_events`, 데스크톱 로그인 코드
3. `202609020003_console_rpcs.sql` — 콘솔 RPC, `engine_defaults`, `console_settings`
4. `202609020004_live_session_engine_admin.sql` — 진행 중 세션 엔진 전환 RPC
5. `202609020005_console_deploy_audit.sql` — 배포 감사 RPC

### 3.2 다른 곳 작업 것 (D3에서 함께 배포하기로 한 경우에만, 위 5개 뒤에)
6. `202609050001_user_engine_access_renewal.sql` — `profiles.voice_provider`(기본 soniox), 접근 갱신
7. `202609050002_managed_caption_sessions.sql` — 관리형 PC 자막 세션 테이블
8. `202609050003_live_speaker_roster.sql` — 화자 로스터
9. `202609050004_speaker_profile_history.sql` — 발언 화자 프로필 이력

모두 추가 전용이다. 기존 운영 DB에 `bootstrap-new-project.sql` 전체를 다시 실행하지 않는다.

확인 쿼리(3.1 뒤):
```sql
select proname from pg_proc where proname in ('upsert_profile_on_login_v1','set_profile_status_v1','set_engine_defaults_v1','set_live_session_engine_admin_v1','record_console_deploy_v1','reset_live_summary_generation_v1');
```

---

## 4. 배포 순서 (제가 실행, 각 단계마다 승인)

1. **마이그레이션** (사용자가 3절대로 실행) → 확인 쿼리 결과 공유.
2. **웹앱** `vercel deploy --prod` → `/api/live-config`에 `engineDefaults`·`captionEngines`가 있는지, `/login` 화면, **부트스트랩 관리자 Google 첫 로그인**(→ `/admin`, `profiles` 행 생성), `/console/users`·`/console/sessions`·`/console/engine` 실제 화면 확인(이때 처음 렌더링됨), 레거시 `noel` 로그인 유지 확인. 롤백은 이전 배포 Promote.
3. **게이트웨이** Cloud Build → 트래픽 없이 새 리비전(`--update-secrets SONIOX_API_KEY=…`) → `/health` → 트래픽 100% 전환. 롤백 리비전 `realtime-noel-media-gateway-live-input-20260901`.
4. **데스크톱** `npm run dist:mac` → NOVA 종료 → `/Applications/NOVA.app` 백업·교체(사용자). 로컬 자막, 데스크톱 Google 로그인(`nova://` 복귀), 설정의 "콘솔" 버튼, Live Call 1회.
5. **종단 확인**: 웹 호스트 Live Call → 콘솔 "배포"로 엔진 전환 → 진행 중 세션 `switched`, 호스트 엔진 상태 connecting→ready, 데스크톱 호스트 재접속 유지 → `profile_events` 감사 행 2개 → 요약 스켈레톤 → 기록 원문 화자별 한 문단.
6. 안정화 후 콘솔에서 **레거시 비밀번호 로그인 끄기**.

---

## 5. 역할 분담 요약

| 사용자 | 저 |
|---|---|
| D1~D4 결정 | 결정에 맞춰 코드 정합(콘솔 UI·기본값·다른 작업 커밋과 클린 게이트) |
| 2.1~2.4 계정·대시보드·환경변수 | 2.5 결과 판독, 필요 시 UPDATE 제안 |
| 3절 마이그레이션 실행, 확인 쿼리 결과 공유 | 4절 배포 명령 실행(단계별 승인 후), 각 단계 확인 결과 보고 |
| 4-2 첫 관리자 Google 로그인, 4-4 앱 교체 | 콘솔 실제 화면 검수(관리자 로그인 후), 롤백 필요 시 즉시 실행 |
| 실제 마이크 리허설(한·영, 10분 이상, 네트워크 단절) | 결과 기반 기본 공급자 재검토 |

---

## 6. 아직 열려 있는 항목 (배포와 무관하게 후속)
- 비밀번호 재설정 링크가 `/auth/callback`으로 와서 "새 비밀번호 설정" 화면이 없다.
- Soniox 실제 마이크 리허설과 mid-speech `finalize` 시 번역 귀속 검증.
- XLSX 내보내기의 빈 레인 "생성 상태" 라벨.
- 다른 곳 작업의 Google Drive 용어집 가져오기(설계 단계, callback 미확정).
- 메인 브랜치 병합: `codex/engine-hardening-20260905` → `codex/google-live-latency-20260831`은 다른 작업의 미커밋 변경이 커밋된 뒤에 fast-forward/리베이스.
