# 배포 런북 — 엔진 재설계 + 인증/콘솔 (2026-09-05)

대상 커밋: 브랜치 `codex/engine-hardening-20260905` HEAD(`ec128de` 이후). 실행 위치는 이 브랜치가 체크아웃된 워크트리(메인 트리에 다른 워크스트림의 미커밋 변경이 있어 메인 트리에서 빌드하지 않는다). 모든 운영 변경 단계는 **사용자 "진행" 승인 후** 실행한다. 비밀 값은 어디에도 붙이지 않는다.

## 0. 사전 확인 (읽기 전용)

1. 클린 체크아웃 게이트: 격리 워크트리에서 `npm test`, `npm run typecheck`, `npm --prefix media-gateway test`, `npm --prefix webapp test`, `npm --prefix webapp run typecheck` 전부 녹색 (949b06f 결과: 루트 1676/1662/14 skip, 게이트웨이 591, 웹앱 943+77; ec128de 결과는 게이트 로그 참조).
2. Supabase SQL Editor에서 두 쿼리를 실행해 결과를 확인한다.
   - 저장된 세션 메타데이터 중 이제 거부되는 형태(옛 `modelPreferences.source`가 Flash 모델 id)가 있는지:
     ```sql
     select id, status, event_metadata->'modelPreferences' as mp
     from public.live_sessions
     where event_metadata ? 'modelPreferences'
       and not (event_metadata->'modelPreferences' ? 'engine')
       and coalesce(event_metadata->'modelPreferences'->>'source','') not in ('gemini-3.5-live-translate-preview','gemini-3.5-transcribe-live');
     ```
     행이 있으면 배포 전에 해당 행의 `modelPreferences`를 `{ "engine": <현재 전역 엔진> }`으로 바꾸는 UPDATE를 별도로 승인받아 실행한다.
   - 배포된 이벤트 메타데이터 정규화 함수가 `authoritativeSourceId`/`sourceSequence` 키를 받는지(본문 확인):
     ```sql
     select pg_get_functiondef('public.normalize_live_session_event_metadata'::regproc);
     ```
3. 사용자 대시보드 작업(비밀 값 포함, 사용자가 직접): Google Cloud OAuth 클라이언트 + Supabase 콜백 URI 등록, Supabase Google 공급자 활성화, URL Configuration에 `https://realtime-noel-web.vercel.app/auth/callback`, 이메일 확인 활성화, Vercel 환경변수 `ADMIN_BOOTSTRAP_EMAILS`, (선택) `LIVE_GATEWAY_URL`(없으면 `NEXT_PUBLIC_LIVE_GATEWAY_URL` 사용).

## 1. 마이그레이션 적용 (Supabase SQL Editor, 파일명 순, 각각 전체 붙여넣기 → Run)

1. `supabase/migrations/202609020001_live_summary_generic_failure_retry.sql`
2. `supabase/migrations/202609020002_auth_profiles_desktop_codes.sql`
3. `supabase/migrations/202609020003_console_rpcs.sql`
4. `supabase/migrations/202609020004_live_session_engine_admin.sql`
5. `supabase/migrations/202609020005_console_deploy_audit.sql`

확인:
```sql
select proname from pg_proc where proname in ('upsert_profile_on_login_v1','set_profile_status_v1','set_engine_defaults_v1','set_live_session_engine_admin_v1','record_console_deploy_v1','reset_live_summary_generation_v1');
```
6개가 모두 나와야 한다. 모두 추가 전용이라 롤백은 필요 없다(테이블 유지).

## 2. 웹앱 (Vercel 프로덕션)

워크트리 루트에서(웹앱은 리포 루트에서 배포한다):
```bash
vercel deploy --prod
```
확인:
- `GET https://realtime-noel-web.vercel.app/api/live-config` 응답에 `engineDefaults`, `captionEngines`가 있다.
- `/login`에 Google 버튼 → 구분선 → 이메일/아이디 → 비밀번호 → 로그인 → 회원가입/재설정 순서.
- 부트스트랩 관리자 이메일로 Google 첫 로그인 → `/admin` 진입, `profiles` 행 생성(`role=admin`, `host_id=noel`).
- `/console/users`, `/console/sessions`, `/console/engine` 화면 확인(이 시점에 처음 실제로 렌더링된다; 375px/1280px 모두).
- 레거시 `noel` + 비밀번호 로그인이 여전히 동작한다.

롤백: Vercel 대시보드에서 이전 배포를 Promote.

## 3. 미디어 게이트웨이 (Cloud Run, 프로젝트 gen-lang-client-0321430669)

```bash
gcloud builds submit --config cloudbuild.media-gateway.yaml --region asia-northeast3 --project gen-lang-client-0321430669
```
빌드 출력의 이미지 digest를 `<IMAGE>`에 넣어 트래픽 없이 새 리비전 생성:
```bash
gcloud run deploy realtime-noel-media-gateway --region asia-northeast3 --project gen-lang-client-0321430669 --image <IMAGE> --revision-suffix engines-20260905 --no-traffic --update-secrets SONIOX_API_KEY=realtime-noel-soniox-api-key:latest
```
확인:
```bash
curl -s https://realtime-noel-media-gateway-1020335991043.asia-northeast3.run.app/health
```
태그 URL로 새 리비전의 `/health`도 확인한 뒤 트래픽 전환(이 서비스는 리비전 고정이라 update-traffic이 필수):
```bash
gcloud run services update-traffic realtime-noel-media-gateway --region asia-northeast3 --project gen-lang-client-0321430669 --to-revisions realtime-noel-media-gateway-engines-20260905=100
```
롤백:
```bash
gcloud run services update-traffic realtime-noel-media-gateway --region asia-northeast3 --project gen-lang-client-0321430669 --to-revisions realtime-noel-media-gateway-live-input-20260901=100
```
새 메트릭(대시보드/알림에 추가): `engine_switches_total`, `engine_switch_failures_total`, `engine_switch_rate_limited_total`, `engine_switch_unauthorized_total`, `engine_switch_attempts`, `host_reattach_engine_repins_total`, `host_reattach_engine_repin_refusals_total`.

## 4. 데스크톱 (DMG)

```bash
npm run dist:mac
```
설치: NOVA 종료 → `/Applications/NOVA.app` 백업 → 교체(DMG 빌드만으로는 설치 앱이 바뀌지 않는다). 확인: 로컬 자막(Gemini, Soniox 키가 있으면 Soniox도), 데스크톱 로그인 창의 Google 버튼 → 시스템 브라우저 → `nova://` 복귀, 설정의 "콘솔" 버튼(관리자만), Live Call 1회 시작.

## 5. 배포 후 종단 확인

1. 웹 호스트로 Live Call 시작(Gemini 기본 엔진) → 참여자 자막 정상.
2. 콘솔 `/console/engine`에서 Soniox(2개 언어 세션) 선택 → "배포" → 결과 표에 진행 중 세션 `switched`, 호스트 화면 엔진 상태가 connecting→ready로 바뀌고 자막이 이어진다(1~2초 공백 허용). 데스크톱 호스트라면 네트워크 재접속 후에도 세션이 유지되는지(웜 재부착) 확인.
3. `profile_events`에 `engine_defaults` 행 2개(엔진, 카운터) 기록 확인.
4. 요약: 세션 종료 후 스켈레톤 → 요약 생성; 빈 세션은 "기록된 발언이 없어…" 문구.
5. 기록 원문 뷰: 화자별 한 문단 + 발언 시각.
6. 안정화 후(며칠) 콘솔 계정 섹션에서 레거시 비밀번호 로그인 끄기.

## 6. 브랜치 정리

`codex/engine-hardening-20260905`를 `codex/google-live-latency-20260831`에 fast-forward 병합(메인 트리의 다른 워크스트림 변경이 커밋된 뒤; 충돌 시 리베이스). 메인 트리에서 실행할 때는 그 세션이 끝난 뒤에만.
