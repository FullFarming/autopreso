# Supabase 인증 설정 가이드 — Google 로그인 · 리디렉션 · 이메일 확인 · 마이그레이션 (2026-09-05)

대상 프로젝트: NOVA 프로덕션 Supabase, ref **`qahzljufcqbzwkdweeji`** (서울 리전, "pal" 조직). 이 값은 게이트웨이 리비전의 `LIVE_ALLOWED_SUPABASE_REF`에서 읽은 것으로 비밀이 아니다. 아래에서 `<ref>`는 모두 이 값이다.

> **왜 제가 직접 못 했는가.** 이 세션에 연결된 Supabase 커넥터는 `FullFarming's Org` 한 곳만 보이고(프로젝트 3개, 모두 INACTIVE, 서울 리전인 것은 "WPR Dashboard"뿐), `pal` 조직과 `qahzljufcqbzwkdweeji` 프로젝트는 목록에 없다. 커넥터가 다른 Supabase 계정으로 인증된 상태다. §5에 제가 대신 적용할 수 있게 하는 방법을 적었다.

소요 시간 약 20분. 순서: §1 Google → §2 Supabase 공급자 → §3 URL → §4 이메일 → §5 마이그레이션 → §6 검증.

---

## 1. Google Cloud — OAuth 클라이언트 만들기

콘솔: <https://console.cloud.google.com/apis/credentials> (프로젝트는 아무 것이나 가능. 게이트웨이가 있는 `gen-lang-client-0321430669`를 쓰면 한곳에서 관리된다.)

1. **OAuth 동의 화면**(APIs & Services → OAuth consent screen)이 없으면 먼저 만든다.
   - User type: **External** (조직 외 이메일도 회원가입하게 하려면). 내부 직원만이면 Internal.
   - 앱 이름 `NOVA`, 지원 이메일, 개발자 연락처 입력.
   - Scopes: 기본 `email`, `profile`, `openid`만. 추가 스코프 없음.
   - Publishing status가 **Testing**이면 테스트 사용자 100명 제한 + 7일 토큰 만료가 있다. 운영이면 **Publish app**을 누른다(민감 스코프가 없으므로 검증 심사 없이 바로 게시된다).
2. **Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `NOVA Supabase Auth`
   - **Authorized JavaScript origins**: 넣지 않아도 된다(PKCE 흐름은 Supabase가 대신 콜백을 받는다). 넣으려면 `https://realtime-noel-web.vercel.app`.
   - **Authorized redirect URIs** — 정확히 한 줄:
     ```
     https://qahzljufcqbzwkdweeji.supabase.co/auth/v1/callback
     ```
     Supabase 대시보드의 Google 공급자 화면에 표시되는 "Callback URL (for OAuth)"과 글자 단위로 같아야 한다. 끝에 슬래시를 붙이지 않는다.
3. **Create** → 표시되는 **Client ID**와 **Client secret**을 복사한다(비밀 값. 채팅·문서·리포에 붙이지 않는다. 다음 절에서 Supabase 대시보드에만 입력한다).

## 2. Supabase — Google 공급자 활성화

대시보드: <https://supabase.com/dashboard/project/qahzljufcqbzwkdweeji/auth/providers>

1. **Google** 항목을 펼친다 → **Enable Sign in with Google** 켬.
2. **Client IDs**: §1의 Client ID 붙여넣기.
3. **Client Secret (for OAuth)**: §1의 Client secret 붙여넣기.
4. **Skip nonce checks**: 꺼둔다(웹 PKCE 흐름은 nonce를 지원한다).
5. **Save**.

웹앱은 `signInWithOAuth({ provider: "google", redirectTo: <origin>/auth/callback })`로 PKCE 흐름을 시작하고, 데스크톱은 같은 흐름에 `?client=desktop&state=…`가 붙는다. 둘 다 Supabase 콜백을 거쳐 웹앱 `/auth/callback`으로 돌아오므로 Google 쪽 설정은 위 하나로 끝난다.

## 3. Supabase — URL Configuration (리디렉션 허용 목록)

대시보드: <https://supabase.com/dashboard/project/qahzljufcqbzwkdweeji/auth/url-configuration>

| 항목 | 값 |
|---|---|
| **Site URL** | `https://realtime-noel-web.vercel.app` |
| **Redirect URLs** (Add URL로 각각 추가) | `https://realtime-noel-web.vercel.app/auth/callback` |
| | `https://realtime-noel-web.vercel.app/auth/callback?client=desktop&state=*` |
| | `https://*-noel-kims-projects.vercel.app/auth/callback` (프리뷰 배포에서도 로그인해 보려면. 팀 슬러그는 Vercel 대시보드의 프리뷰 URL 형태로 확인) |
| | `http://localhost:3000/auth/callback` (로컬 개발용, 선택) |

- `nova://auth/callback`은 **Supabase에 넣지 않는다.** 데스크톱 복귀 딥링크는 Supabase가 아니라 웹앱 `/auth/callback` 페이지가 만든다(`webapp/lib/auth/exchange.ts`). Supabase가 검사하는 것은 웹앱 URL만이다.
- 와일드카드는 `*`(한 세그먼트)와 `**`(여러 세그먼트)를 지원한다. 쿼리스트링이 다르면 정확히 일치하지 않으므로 `?client=desktop&state=*` 항목이 필요하다. 이 항목이 빠지면 데스크톱 Google 로그인이 Site URL로 튕겨 `state` 검증에 실패한다.
- 저장 뒤 목록에 4~5개 항목이 보이는지 확인한다.

## 4. Supabase — 이메일 확인 및 가입 정책

대시보드: <https://supabase.com/dashboard/project/qahzljufcqbzwkdweeji/auth/providers> → **Email** 펼치기

| 설정 | 값 | 이유 |
|---|---|---|
| Enable Email provider | 켬 | 이메일/비밀번호 회원가입 지원 |
| **Confirm email** | **켬** | 확인 전에는 세션이 나오지 않는다. 웹앱은 가입 뒤 "이메일을 확인하세요" 안내를 띄우고, 확인 링크는 `emailRedirectTo` = `/auth/callback`으로 돌아온다 |
| Secure email change | 켬 | 기본값 유지 |
| Minimum password length | 8 이상 | 웹앱 `validateSignup`과 맞춤 |

**Sign In / Providers → General(또는 Auth → Settings)**
- **Allow new users to sign up**: 켬. 가입은 공개, 승인은 콘솔에서 운영자가 한다(`status = pending` → `/console/users`에서 approve). 이 스위치를 끄면 회원가입 카드가 `signup_disabled` 오류를 받는다.
- **Manual linking**: 꺼둠.

**Rate limits**(Auth → Rate Limits): 기본값(이메일 발송 시간당 30건 등)이면 충분하다. 초대 이벤트 직전에 대량 가입이 예상되면 이메일 한도만 올린다.

**SMTP**(Auth → SMTP Settings): 기본 Supabase 발송은 시간당 몇 건으로 제한되고 발신자가 `noreply@mail.app.supabase.io`다. 실제 사용자에게 확인 메일을 보내려면 **Custom SMTP**(예: Resend, SES)를 켜고 발신 주소를 회사 도메인으로 바꾸는 것을 권한다. 지금 단계에서는 선택.

**이메일 템플릿**(Auth → Email Templates → Confirm signup): 본문의 `{{ .ConfirmationURL }}`은 그대로 두면 된다. 제목·문구만 한국어로 바꾸면 된다.

## 5. 마이그레이션 적용

### 5-1. 직접 적용 (SQL Editor)

<https://supabase.com/dashboard/project/qahzljufcqbzwkdweeji/sql/new>

1. 먼저 상태 점검(앞서 드린 쿼리, 요약):
   ```sql
   select
     to_regclass('public.profiles') is not null                                   as m_202609020002,
     exists(select 1 from pg_proc where proname='set_profile_status_v1')          as m_202609020003,
     exists(select 1 from pg_proc where proname='set_live_session_engine_admin_v1') as m_202609020004,
     exists(select 1 from pg_proc where proname='record_console_deploy_v1')       as m_202609020005,
     exists(select 1 from pg_proc where proname='set_profile_voice_provider_v2')  as m_202609050001,
     to_regclass('public.managed_caption_sessions') is not null                   as m_202609050002,
     exists(select 1 from pg_proc where proname='set_live_session_engine_admin_v2') as m_202609050005,
     exists(select 1 from pg_proc where proname='set_live_session_engine_admin_v3') as m_202609050006;
   ```
2. `false`인 것부터 **파일명 순**으로 `supabase/migrations/2026090200xx`, `2026090500xx` 파일을 하나씩 전체 붙여넣기 → Run. 모두 추가 전용·재실행 안전이라 `true`인 것을 다시 돌려도 해가 없다.
3. 마지막에 위 쿼리를 다시 돌려 전부 `true`인지 확인하고, 아래 11개 함수가 있는지 본다.
   ```sql
   select proname from pg_proc where proname in (
     'upsert_profile_on_login_v1','set_profile_status_v1','set_profile_role_v1',
     'set_live_session_engine_admin_v1','set_live_session_engine_admin_v2','set_live_session_engine_admin_v3',
     'set_profile_voice_provider_v2','set_profile_voice_provider_v3','read_profile_admin_v1',
     'list_live_session_ids_for_host_admin_v1','reset_live_summary_generation_v1') order by 1;
   ```

### 5-2. 제가 대신 적용하게 하려면 (커넥터 재연결)

Claude 데스크톱 앱 → 설정 → 커넥터(Connectors) → **Supabase** → 연결 해제 뒤 다시 연결하면서 **`pal` 조직이 속한 Supabase 계정**으로 로그인하고, 조직 선택 화면에서 `pal`을 고른다. 다시 연결한 뒤 "적용해 줘"라고 하면 제가 `list_projects`로 `qahzljufcqbzwkdweeji`가 보이는지 확인하고 §5-1을 실행한다. (계정이 같은데 조직만 다르면 커넥터 인증 화면에서 조직을 바꾸면 된다.)

## 6. 검증 순서

1. §1~§4 저장 뒤 Vercel 프로덕션 배포 전에라도 **현재 프로덕션 `/login`**에서 Google 버튼을 눌러 Google 동의 화면이 뜨고 `/auth/callback`으로 돌아오는지만 본다. 마이그레이션 전이라면 `profiles` 업서트 RPC가 없어 교환 단계에서 실패하는 것이 정상이다.
2. 마이그레이션 완료 → 저에게 알림 → 제가 `vercel deploy --prod` → 게이트웨이 트래픽 전환.
3. `ADMIN_BOOTSTRAP_EMAILS`에 등록된 이메일로 Google 로그인 → `/console/users`에 본인이 `admin`으로 보인다.
4. 다른 이메일로 회원가입 → 확인 메일 링크 → `/pending` 화면 → 콘솔에서 승인 → 재로그인 시 대시보드 진입.
5. 실패 시 볼 곳: Supabase → Authentication → Logs(리디렉션 불일치는 `redirect_to is not allowed`, Google 설정 오류는 `invalid_client`/`redirect_uri_mismatch`).

## 7. 자주 나는 오류

| 증상 | 원인 | 조치 |
|---|---|---|
| Google 화면에서 `Error 400: redirect_uri_mismatch` | §1 redirect URI 오타 또는 슬래시 | Supabase 공급자 화면의 Callback URL을 복사해 그대로 넣기 |
| 로그인 뒤 Site URL(홈)로만 돌아오고 로그인이 안 됨 | §3 Redirect URLs에 `/auth/callback` 미등록 | 항목 추가 후 재시도 |
| 데스크톱 로그인만 실패(`state` 오류) | `?client=desktop&state=*` 항목 누락 | §3 두 번째 항목 추가 |
| 가입 후 로그인 시 `Email not confirmed` | 확인 메일 미클릭 또는 SMTP 한도 | 메일 확인, 필요하면 Custom SMTP |
| `/api/auth/exchange` 500, `PGRST202` | 마이그레이션 미적용 | §5 |
| Google 동의 화면에 "확인되지 않은 앱" 경고 | 동의 화면이 Testing 상태 | Publish app |
