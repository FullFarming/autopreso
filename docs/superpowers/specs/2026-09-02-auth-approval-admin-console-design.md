# 회원가입·구글 로그인·가입 승인·관리자 콘솔 설계

작성일: 2026-09-02 KST. 상태: **구현 완료(Plan A 전체 + Plan B Task 1~6b, 2026-09-05)** — 브랜치 `codex/google-live-latency-20260831`(HEAD `949b06f`) + 하드닝 브랜치 `codex/engine-hardening-20260905`. **배포 대기**: 마이그레이션 `202609020001`~`0005` 미적용, Vercel·Cloud Run·DMG 미반영(사용자 승인 후). 설계 대비 편차는 문서 끝 "구현 편차" 참고.

관련: [캡션 엔진 핫스왑 설계](2026-09-02-caption-engine-provider-hotswap-design.md)(전역 엔진 기본값은 그 카탈로그를 읽는다).

## 0. 결정 사항 (사용자 확정)

| 결정 | 내용 |
|---|---|
| 인증 기반 | **Supabase Auth**(구글 OAuth + 이메일·비밀번호). 기존 앱 세션 쿠키(`rnw_session`)는 유지하고 승인된 사용자에게만 발급(접근 A) |
| 가입 정책 | **공개 가입 + 관리자 승인**. 가입 직후 `pending`, 승인 시 `host`, 관리자는 승인 시 별도 부여 |
| 참여자 | 계정 없음. QR·6자리 코드 입장 그대로 |
| 데스크톱 | 로컬 자막은 로그인 없음. Live Call·콘솔만 로그인. 구글 로그인은 시스템 브라우저 + `nova://` 딥링크 |
| 콘솔 1차 범위 | 가입 관리 · 세션 데이터 대시보드(기존 데이터 집계만) · 전역 엔진 기본값 |
| 범위 밖 | 이메일 알림, 조직/테넌트, 사용량·비용 집계, Supabase SSR 전면 전환(접근 B) |

## 1. 데이터 모델 (마이그레이션 1개: `2026090201xx_auth_profiles_console.sql`)

```sql
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','disabled')),
  role text not null default 'host' check (role in ('host','admin')),
  legacy_host_ids text[] not null default '{}',
  approved_at timestamptz, approved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.profile_events (
  id bigserial primary key, profile_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id), action text not null
    check (action in ('signup','approve','reject','disable','enable','set_role','bootstrap_admin','engine_defaults')),
  reason text, payload jsonb, created_at timestamptz not null default now()
);
create table public.engine_defaults (
  id smallint primary key default 1 check (id = 1),
  engine jsonb not null, updated_by uuid references public.profiles(id), updated_at timestamptz not null default now()
);
create table public.desktop_login_codes (
  code_hash bytea primary key, profile_id uuid not null references public.profiles(id) on delete cascade,
  state text not null, expires_at timestamptz not null, consumed_at timestamptz
);
```

- RLS: `profiles`는 `auth.uid() = id`인 행 select만 허용. 나머지 접근은 전부 service role RPC: `upsert_profile_on_login_v1`, `approve_profile_v1`, `reject_profile_v1`, `set_profile_status_v1`, `set_profile_role_v1`, `list_profiles_v1(status, cursor)`, `list_sessions_admin_v1(range)`, `set_engine_defaults_v1`, `issue_desktop_login_code_v1`, `consume_desktop_login_code_v1`. anon/authenticated에는 실행 권한 없음.
- 불변식(RPC 안에서 강제): 마지막 `approved admin`의 강등·비활성화 거부(`LAST_ADMIN_PROTECTED`), 관리자 자기 자신 강등·비활성화 거부(`SELF_CHANGE_FORBIDDEN`), 상태 전이는 `pending→approved|rejected`, `approved→disabled`, `disabled→approved`, `rejected→approved`만 허용.
- `live_sessions.host_id`: 새 사용자는 auth uuid 문자열(현 `HOST_ID_PATTERN`이 허용). 기록·세션 조회의 소유 판정은 `host_id = uuid or host_id = any(legacy_host_ids)`로 확장(`getOwned`, records 스토어, `assertHostSessionOwnership`).
- 시드: 환경변수 `ADMIN_BOOTSTRAP_EMAILS`(쉼표 목록). 해당 이메일의 첫 로그인에서 `approved/admin`, `legacy_host_ids = ['noel']`(기존 `ADMIN_USER_IDS` 값에서 파생), `profile_events.bootstrap_admin` 기록. 기존 비밀번호 로그인(`/api/login`)은 전환 기간 유지하며 콘솔 토글 `legacy_password_login_enabled`(engine_defaults와 같은 singleton 설정 행 `console_settings`에 저장)로 끈다.

## 2. 웹 로그인·가입 화면과 흐름

- `/login` 한 카드. 위에서 아래로: "Google로 계속"(전체 폭, 구글 공식 G 아이콘 SVG, 화면의 유일한 주 액션) → 구분선 "또는" → 이메일 · 비밀번호(표시/숨김 토글) → "로그인" 버튼 → 하단 보조 링크 "회원가입" · "비밀번호 재설정". 가입 모드는 같은 카드에서 전환: 이름 · 이메일 · 비밀번호(8자 이상) · "가입 신청" 버튼, blur 시 인라인 검증, 제출 후 "이메일을 확인해 주세요" 상태. 375px에서 세로 배치, 버튼 높이 ≥44px, 포커스 링 유지, 카피는 라벨·값만.
- 클라이언트: `@supabase/supabase-js`(anon key, PKCE, `detectSessionInUrl`)로 `signInWithOAuth({ provider: "google", redirectTo: <origin>/auth/callback })`, `signInWithPassword`, `signUp`. `/auth/callback` 페이지가 Supabase 세션을 확정한 뒤 `POST /api/auth/exchange { accessToken }` 호출.
- 서버 `POST /api/auth/exchange`: 동일 Origin 검사 + 기존 로그인 속도 제한 → service role 클라이언트로 `auth.getUser(accessToken)`(JWT 자체 파싱 금지) → `upsert_profile_on_login_v1` → 상태 분기: `approved` → `createSessionToken(profile.id)` 쿠키 + `{ next: "/admin" }`; `pending` → `{ next: "/pending" }`(쿠키 없음); `rejected|disabled` → 403 코드. 응답에 이메일·상태만 포함.
- `/pending` 페이지: "승인 대기" 상태 카드 + "로그아웃". `/auth/callback`은 Supabase 오류(`error_description`)를 안전 문구로 표시.
- 로그아웃 `/api/logout`: 앱 쿠키 삭제 + 클라이언트 `supabase.auth.signOut()`.
- `requireHost`: 쿠키 검증 후 `profiles.status`를 60초 캐시로 조회해 `approved`가 아니면 401 `HOST_DISABLED`. 레거시 비밀번호 로그인 사용자(`noel`)는 프로필이 없으므로 캐시 조회를 건너뛰고 기존 동작 유지.
- 미들웨어: 기존 쿠키 가드 유지. `/console/*`는 추가로 `requireAdmin()`(role=admin·status=approved) 통과 필요, 아니면 `/admin`으로 리다이렉트.

## 3. 데스크톱 로그인

- 로그인 창은 웹 `/login?client=desktop&state=<32바이트 base64url>`를 연다(`state`는 main이 생성·보관). 이메일·비밀번호 로그인은 창 안에서 완료하고 기존 `classifyDesktopLoginNavigation` 경로로 쿠키 확보.
- "Google로 계속"을 데스크톱 창에서 누르면 웹 페이지가 `nova://open-browser?…` 대신 **`window.open` 차단 규칙을 우회하지 않고** 서버가 내려준 `browserLoginUrl`을 `shell.openExternal`로 열도록 preload 브리지(`desktop:openExternal`)를 통해 요청한다. 시스템 브라우저에서 구글 로그인 완료 → `/auth/callback?client=desktop&state=…` → exchange 성공 시 서버가 `issue_desktop_login_code_v1`(32바이트 무작위, sha256 저장, 60초, 1회)로 코드 발급 → 페이지가 `nova://auth/callback?code=…&state=…`로 이동 + "앱으로 돌아가기" 버튼(자동 이동 실패 대비).
- Electron: `app.setAsDefaultProtocolClient("nova")`, macOS `open-url`, Windows/Linux `second-instance` argv 파싱(기존 핸들러 확장). main이 `state` 일치 확인 후 `POST /api/auth/desktop-exchange { code, state }` → 서버가 `consume_desktop_login_code_v1`로 1회 소비 → 쿠키 발급 → 기존 `hostSession.ensureSession({ force: true })`로 확정. 불일치·만료는 로그인 창에 실패 문구.
- `pending` 사용자는 데스크톱에서도 "승인 대기" 안내 후 창 닫힘. 로컬 자막은 영향 없음.

## 4. 승인·역할

- 가입 직후 `pending`(`profile_events.signup`). 콘솔에서 승인/반려(사유 select: 미확인 사용자 · 중복 · 기타), 역할(host/admin), 비활성화/재활성화. 모든 변경은 `profile_events`.
- 알림은 1차 범위에서 이메일 없이 콘솔 배지(대기 N)와 사용자 `/pending` 화면.

## 5. 관리자 콘솔 (`/console`)

- 레이아웃: ≥1024px 좌측 사이드바(사용자 · 세션 · 엔진), 그 아래 상단 탭. NOVA 다크 토큰, 기존 `glass` 카드, 기존 SVG 아이콘 세트, 시스템 언어 ko/en/ja 메시지 파일(`console-messages.ts`).
- `/console/users`: 필터 칩(대기 N · 승인 · 반려 · 비활성), 표(이메일 · 이름 · 가입일 · 상태 · 역할 · 마지막 로그인), 행 액션: 대기 → "승인"(주) · "반려"(보조), 승인 → 역할 select · "비활성화"(위험색, 확인 다이얼로그). 모바일 카드 레이아웃, 표 `overflow-x:auto`. 서버 응답 후 갱신, 진행 중 버튼 비활성, 오류는 행 옆 인라인.
- `/console/sessions`: 요약 카드 4개(오늘 세션 · 진행 중 · 7일 발언 수 · 요약 실패 수), 표(제목 · 호스트 · 시작/종료 · 상태 · 언어 · 발언 수 · 참여자 수 · 요약 상태), 기간 필터(7일/30일/전체), 행 클릭 → `/records/<id>`. 데이터는 `list_sessions_admin_v1` 하나로 집계(기존 테이블만).
- `/console/engine`: Plan 1 카탈로그(`captionEngineCatalogForClient`)를 읽는 드롭다운 3개 + 입력 언어 모드, "저장" 버튼, 마지막 변경자·시각 표시. 저장 → `set_engine_defaults_v1` + `profile_events.engine_defaults`.
- 데스크톱: 대시보드 "콘솔" 버튼이 웹 `/console`을 로그인 창과 같은 세션의 BrowserWindow로 연다(관리자 role일 때만 노출; `/api/auth/session` 응답에 role 포함).

## 6. 전역 엔진 기본값 연동

- `/api/live-config`에 `engineDefaults` 포함. 웹 호스트의 새 세션 생성 기본값과 데스크톱 Live Call 세션 생성 기본값은 이 값을 따른다(Plan 2가 `modelPreferences`를 `engine`으로 확장하는 지점에 연결). 데스크톱 로컬 자막 `subtitle.engine`은 로컬 설정 우선: 로컬 값이 이전 전역 기본값과 같으면 새 기본값을 따라가고, 사용자가 바꾼 값이면 유지. 진행 중 세션은 바꾸지 않는다(핫스왑은 Plan 2).

## 7. 보안

- 토큰 검증은 서버 측 `auth.getUser()`만. `exchange`/`desktop-exchange`는 동일 Origin 검사, 기존 로그인 속도 제한(IP·자격 기준) 공유, 응답에 토큰·키 미포함.
- 앱 쿠키는 기존 httpOnly·HMAC·30일·90일 절대 상한 정책 유지. Supabase 리프레시 토큰은 브라우저(Supabase 기본 저장소)에만 존재하며 서버는 보관하지 않는다.
- 데스크톱 코드: sha256 해시만 저장, 60초, 1회 소비, `state` 짝 검증, 만료 행은 `consume` 시 삭제. 딥링크 파라미터·코드는 로그에 남기지 않음.
- 콘솔 RPC는 service role 전용 + `requireAdmin()`. 마지막 관리자·자기 자신 보호는 서버 RPC에서 강제.
- 공개 가입이므로 도메인 제한 없음. 이메일 가입은 Supabase 이메일 확인 필수(대시보드 설정). 구글 계정은 확인된 이메일로 간주.

## 8. 테스트·운영·배포

- 테스트: SQL 통합(RLS·RPC 권한·상태 전이·마지막 관리자 보호·코드 1회 소비), `exchange`/`desktop-exchange` 라우트(위조 토큰·pending 거부·state 불일치·만료), 미들웨어 role 가드, 콘솔 컴포넌트 렌더·액션(승인·반려·역할·비활성화·확인 다이얼로그), 로그인 카드 375px/1024px 레이아웃 스냅샷 텍스트 테스트, Electron 딥링크 파싱·state 검증(vm 슬라이스), 레거시 host_id 매핑 조회. 새 `*.test.ts`는 `webapp/package.json` 스크립트에 등록.
- 사용자 작업 체크리스트: (1) Google Cloud Console에서 OAuth 2.0 클라이언트(웹) 생성, 승인된 리디렉션 URI에 Supabase 콜백(`https://qahzljufcqbzwkdweeji.supabase.co/auth/v1/callback`) 등록. (2) Supabase Dashboard → Authentication → Providers → Google 활성화, 클라이언트 ID/시크릿 입력. (3) Authentication → URL Configuration에 `https://realtime-noel-web.vercel.app/auth/callback` 추가, 이메일 확인 활성화. (4) Vercel 환경변수 `ADMIN_BOOTSTRAP_EMAILS` 추가. 비밀 값은 채팅으로 전달하지 않는다.
- 배포 순서: 마이그레이션 적용(수동, 파일명 순) → Vercel 배포(레거시 로그인 병행) → 시드 관리자 첫 구글 로그인으로 프로필 생성 확인 → 데스크톱 DMG(`nova` 스킴 등록) → 안정화 후 콘솔에서 레거시 로그인 비활성화.
- 롤백: 마이그레이션은 추가 전용(기존 테이블 무변경)이라 웹 이전 배포로 되돌리면 동작 복구; 새 테이블은 유지.

## 9. 개정 2026-09-04 — 엔진 배포 권한 (사용자 결정)

사용자 결정: **전역 기본값 하나** · **호스트는 바꿀 수 없음(잠금)** · **진행 중인 세션에도 즉시 적용**.

- **단일 권위.** `engine_defaults.engine`이 Live Call의 유일한 엔진이다. 호스트(웹·데스크톱)의 Live Call 엔진 선택은 읽기 전용 표시("관리자 지정: Soniox stt-rt-v5")로 바뀐다. `POST /api/live-sessions`·`PATCH /api/live-sessions/:id`에서 관리자 아닌 호출자가 보낸 `modelPreferences.engine`은 서버가 전역값으로 덮어쓴다(오류 아님, 서버 권위). 데스크톱 `subtitle.engine`은 **로컬 자막 전용**이며 Live Call 생성은 항상 `/api/live-config.engineDefaults`를 쓴다. §6의 `engineDefaultsSeen` 규칙은 폐기한다.
- **배포 = 즉시 전환.** 콘솔 "배포" 버튼 → `PUT /api/console/engine-defaults { engine }` → (1) `set_engine_defaults_v1` 저장, (2) `status in ('preparing','live')`인 모든 세션의 `modelPreferences.engine` 갱신 + `engineHistory` 추가(Plan 2 Task 4의 필드), (3) 세션마다 게이트웨이 내부 엔드포인트 `POST /internal/sessions/:id/engine { engine }` 호출(기존 prewarm 내부 호출과 같은 공유 비밀 인증), (4) 게이트웨이는 새 파이프라인을 열어 준비되면 이전 것을 닫고(seq 계약 C1 유지, 기존 `update` 경로 재사용), 호스트에 `engine-status`, 뷰어에 `language-status preparing→ready`를 보낸다. 응답은 세션별 결과 목록 `{ sessionId, result: "switched" | "queued" | "failed", code? }`이며 콘솔은 이를 표로 보여 준다. 게이트웨이가 세션을 모르면(콜드) `queued` — 다음 활성화 때 DB 값이 적용된다.
- **Plan 2 Task 5 재정의.** "데스크톱 설정 변경 → Live Call 핫스왑" 경로는 만들지 않는다. 대신 게이트웨이 내부 엔진 갱신 엔드포인트 + `engine-status` 이벤트 + 웹/데스크톱 호스트 UI의 읽기 전용 엔진 상태 표시.
- **Plan B 조정.** Task 3의 `PUT`은 DB 저장까지(진행 중). 새 Task 6 "배포 푸시"가 (2)(3)을 맡고 Plan 2 Task 5 이후에 실행한다. Task 4 UI: 버튼 라벨 "배포", 확인 다이얼로그("진행 중인 세션 n개가 즉시 전환됩니다"), 결과 표. Task 5 데스크톱: 시드 규칙 대신 항상 전역값 사용(진행 중인 구현은 완료 후 수정 라운드에서 단순화).
- **감사.** 배포마다 `profile_events.engine_defaults` 페이로드에 `{ engine, sessionsSwitched, sessionsFailed }`를 남긴다.

## 10. 구현 편차 (2026-09-05, Plan B 원장 기준)

설계와 다르게 구현된 지점만 적는다. 근거는 `.superpowers/sdd/2026-09-02-auth-plan-b-admin-console/progress.md`.

- **RPC 통합.** §1의 `approve_profile_v1` / `reject_profile_v1`는 하나의 `set_profile_status_v1(p_actor_id, p_target_id, p_status)`로 합쳤다. 마지막 관리자 보호·자기 변경 금지·상태 전이 규칙은 SQL(`assert_console_admin_v1`, `LAST_ADMIN_PROTECTED`, `SELF_CHANGE_FORBIDDEN`, `INVALID_TRANSITION`)에서 강제한다.
- **콘솔 가드 위치.** `/console` 보호는 미들웨어가 아니라 서버 레이아웃(`webapp/app/console/layout.tsx` → `requireAdminFromCookieValue`)에서 한다. API 라우트는 각자 `requireAdmin`을 호출한다.
- **`grant select on profiles to authenticated` 없음.** 브라우저는 `profiles`를 직접 읽지 않고(모두 service-role RPC), `profiles_self_select` 정책은 존재하지만 무력하다. 의도된 상태.
- **§6 폐기 → §9 적용.** `engineDefaultsSeen`·호스트 선택·"새 세션에만 적용" 규칙은 모두 사라졌다. 전역 엔진이 유일한 Live Call 엔진이고 호스트 UI(웹·데스크톱)는 읽기 전용, 서버는 비관리자의 `modelPreferences.engine`을 전역값으로 덮어쓴다. 데스크톱 `subtitle.engine`은 로컬 자막 전용.
- **배포 경로(§9 (2)(3)).** `PUT /api/console/engine-defaults` → `set_engine_defaults_v1` → `preparing|live` 세션마다 `set_live_session_engine_admin_v1`(마이그레이션 `202609020004`) → 게이트웨이 `POST /internal/sessions/:id/engine`을 **60초 ADMIN 게이트웨이 토큰**(세션별 발급, 로그·응답에 남기지 않음)으로 호출(동시성 4) → 세션별 `switched | queued | failed` 결과 표. `queued`는 콜드 세션(게이트웨이가 모르는 세션)으로 정상이며 다음 활성화 때 DB 값이 적용된다. 호스트에는 `engine-status` 이벤트(엔진 역할별 1건, 시작 ACK 앞에도 전송).
- **engineHistory 규칙.** 항목 ≤ 8개, 직렬화된 `event_metadata` 본문이 3800바이트를 넘으면 오래된 것부터 삭제, 항목에 `reason: 'admin' | 'server-default'`. 웹앱 `applyEngineSelection`과 RPC가 동일 규칙. RPC는 동일 엔진 재배포에도 항목을 추가한다(감사 목적). 레거시 `{ source, summary }` 저장값은 병합하지 않고 교체한다(리더가 엄격).
- **감사 행 2개.** `set_engine_defaults_v1`이 엔진 값을 자기 이벤트 페이로드로 남기므로 카운터를 넣을 자리가 없어, `record_console_deploy_v1`(마이그레이션 `202609020005`)이 `profile_events.engine_defaults`에 `{ kind: 'deploy', engine, sessionsSwitched, sessionsQueued, sessionsFailed }`를 추가로 남긴다. 배포 1회 = 행 2개.
- **레거시 로그인 스위치.** `set_legacy_password_login_v1`이 꺼지면 `/api/login`은 `LEGACY_LOGIN_DISABLED`(403)를 반환한다. 콘솔 `/console/engine` 계정 섹션에서 조작.
- **마이그레이션.** 설계의 "1개"가 아니라 `202609020002`(profiles/desktop codes), `0003`(console RPCs), `0004`(session engine admin), `0005`(deploy audit) 네 개. 전부 미적용.
- **미해결.** 비밀번호 재설정이 `/auth/callback`으로 와서 새 비밀번호 화면이 없음. 콘솔 화면의 실제 브라우저 확인은 승인된 관리자 프로필이 있어야 하므로 배포 후 부트스트랩 로그인 시점에 한다.

## 11. 개정 2026-09-05 — 사용자별 즉시 전환 (사용자 결정 D1~D5)

두 세션의 작업을 대조한 뒤(`docs/superpowers/status/2026-09-05-cross-session-analysis-and-user-actions.md` §4) 사용자가 2026-09-05 오후에 확정한 결정. §9의 "전역 하나·호스트 잠금·배포 즉시 전환" 중 **"전역 하나"만 폐기**하고 "호스트 잠금"과 "즉시 전환"은 유지한다. 통합 브랜치 `codex/nova-integration-20260905`, 원장 `.superpowers/sdd/2026-09-05-nova-integration/progress.md`.

- **D1 사용자별 배정, 즉시 적용.** Live Call 엔진은 `profiles.voice_provider`(`soniox` | `gemini`, + `voice_provider_revision`)에 사용자별로 기록되며 **운영자(전역 관리자)만** `/console/users`에서 바꾼다. 호스트는 바꿀 수 없다(서버 권위, 오류 아님). 변경은 그 사용자의 `preparing|live` 세션에 **즉시** 적용되고 다음 세션에도 유지된다: `PATCH /api/console/users { voiceProvider }` → `set_profile_voice_provider_v2` → `engineSelectionForVoiceProvider`(공급자→엔진 매핑 하나, `resolveHostEngineAssignment`와 공유) → 호스트 범위 세션 목록 `list_live_session_ids_for_host_admin_v1` → 세션별 `set_live_session_engine_admin_v2`(engineHistory 규칙 §10 그대로 + `modelPreferences.assignmentRevision` 고정) → 게이트웨이 `POST /internal/sessions/:id/engine`(60초 ADMIN 토큰, 파이프라인 교체, 계약 C1 유지, `engine-status`). 응답은 §9와 같은 세션별 `switched | queued | failed` 표. 세션 생성 시 서버가 호출자의 현재 배정과 revision을 세션에 고정하고, 두 호스트 리더(데스크톱 `readLiveCallModelPreferences`, 웹 `readHostModelPreferences`)는 `assignmentRevision` 키를 허용·폐기한다(그 세션의 C1 치명 결함 수정, 5d4c271). 감사: RPC의 `profile_events` `user_assignment` 행 + best-effort `record_console_deploy_v1` 행(대상 프로필·공급자·revision).
- **D2 기본 엔진 Soniox.** 인식+자체 번역 결합 엔진이 기본(`caption-engine-catalog.js` `DEFAULT_ENGINE_SELECTION`, `profiles.voice_provider` 기본값 `soniox`). Gemini Transcribe Live → Flash는 관리자가 선택하는 대안. §3 결정 8(Gemini 유지)은 이것으로 대체된다. 3개 언어 세션은 Soniox 팬아웃(대상별 연결)로 처리하며, 2408f0b가 정렬·죽은 레인·일시 오류·롤오버 결함을 고쳤다.
- **D3 언어 힌트 비엄격 유지.** 자동 모드에서 `language_hints_strict`를 끄고 출력 언어를 힌트로만 보내는 그 세션의 설계(입력 ≠ 출력)를 유지한다. 2026-09-02의 strict 방어를 되돌린 것이므로 실음성 P0 검증(한국어 발화의 zh/vi 오인식 0건)이 남은 조건이다.
- **D4 전부 배포.** 수정과 클린 게이트 뒤 웹앱·게이트웨이·DMG를 모두 배포한다. Vercel 등록·환경변수는 컨트롤러가, 게이트웨이/Soniox 계정 단계는 사용자에게 안내한다.
- **D5 Vercel Root Directory 유지(리포 루트).**
- **폐기.** `engine_defaults`는 아무 것도 결정하지 않는다(테이블·RPC는 이력용으로 보존). `PUT /api/console/engine-defaults`는 410 `ENGINE_DEFAULTS_RETIRED`(GET 카탈로그는 유지), `/console/engine`은 기본 엔진 안내 카드 + `/console/users` 링크 + 계정 섹션(레거시 로그인 스위치)만 남는다. §9의 "배포" 버튼·전역 확인 다이얼로그·`deployEngineToActiveSessions`·`gateway-engine-push.ts`는 삭제됐고, 확인 다이얼로그는 사용자 행의 엔진 셀렉트로 옮겨졌다("이 호스트의 진행 중 세션 n개가 즉시 전환됩니다"). 콘솔 문구는 전부 `t()`(ko/en/ja)를 거친다.
- **마이그레이션.** `202609050001`(사용자 배정·접근 갱신)이 `set_live_session_engine_admin_v1`을 회수했던 것을 `202609050005`가 되돌린다(재부여 + `_v2` RPC 3개, 전부 additive·재실행 가능). 적용 순서: `202609020001`~`0005` → `202609050001`~`0005`. 전부 미적용.
- **인증 부수 결정.** 승인 캐시는 저장소 장애 시 마지막 값을 TTL 지나 10분까지 유지(전원 잠금 방지, 069a73d); 유료 키 발급은 DB 권위 그대로. 레거시 `noel` 로그인은 `ADMIN_BOOTSTRAP_EMAILS`가 설정된 경우에만 Supabase Auth 사용자 연결을 요구하고, 미설정 로컬은 기존 동작(break-glass).
