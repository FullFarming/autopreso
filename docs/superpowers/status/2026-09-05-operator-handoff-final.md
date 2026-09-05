# 운영자 최종 인계 — 사용자별 엔진 전환 + 인증/콘솔 배포 (2026-09-05)

브랜치 `codex/nova-integration-20260905` HEAD `d432d96`. 이 문서 하나로 **사용자가 직접 해야 할 일**과 **제가 실행한 일/실행할 일**을 구분한다. 오전 판 런북(`2026-09-05-deploy-runbook.md`)의 "전역 엔진 배포" 단계는 폐기되었고, 이 문서가 우선한다. 비밀 값은 어디에도 적지 않는다.

## 1. 확정된 동작 (D1~D5)

| 항목 | 결정 |
|---|---|
| 기본 엔진 | Soniox (STT/번역), 요약은 gemini-3.6-flash |
| 전환 권한 | 운영자(관리자)만. 호스트는 엔진을 고를 수 없다 |
| 전환 단위 | **사용자별**(`profiles.voice_provider`). 그 사용자의 진행 중 세션은 즉시 전환, 이후 세션에도 유지 |
| 언어 힌트 | 비엄격(non-strict) 힌트, 기획대로. 실음성 검증은 P0 후속 |
| Vercel 등록 | 완료(제가 실행). Root Directory 변경 없음 |

전환 경로: `/console/users` → `PATCH /api/console/users/:id { voiceProvider }` → `set_profile_voice_provider_v3`(변경 없으면 `changed=false`, 배포 생략) → 그 호스트의 `preparing|live` 세션마다 `set_live_session_engine_admin_v3` + 게이트웨이 `POST /internal/sessions/:id/engine`(60초 ADMIN 토큰) → 결과 `switched|queued|failed`. 게이트웨이가 429이면 1회 재시도 후 `queued`, 도달 불가면 `queued`(리스 만료·재접속 시 새 엔진으로 수렴). `GET /api/console/users/:id/active-sessions`가 정확한 진행 중 세션 수를 준다.

## 2. 이미 끝난 것 (제가 실행, 프로덕션 트래픽 변경 없음)

- Vercel 프로덕션 환경변수: `ADMIN_BOOTSTRAP_EMAILS`, `SONIOX_API_KEY` 등록(기존 값 유지).
- 게이트웨이 이미지 빌드(Cloud Build `e2aca266`) → Cloud Run 리비전 `realtime-noel-media-gateway-nova-20260905` 생성. 트래픽 0%, 태그 `nova-review`, `/health` 200, `SONIOX_API_KEY` 시크릿 연결, 옛 `GEMINI_LIVE_MODEL` 제거. 현재 100% 트래픽은 여전히 `live-input-20260901`.
- 웹앱 프로덕션 빌드 로컬 검증(exit 0). Preview 환경은 `SESSION_SECRET`이 없어 Vercel 프리뷰 빌드가 실패하지만 프로덕션과 무관.
- DMG `dist/NOVA-0.2.3-arm64.dmg` 빌드(ad-hoc 서명 경고는 기존과 동일).
- 클린 체크아웃 게이트(d432d96, 수정 라운드 포함): 루트 1539/1518 pass/21 skip(PGlite SQL 테스트는 별도 실행 10/10), 게이트웨이 644/644, 웹앱 1047/1047 + 79/79, 타입체크 2건 클린. 게이트웨이·Electron 코드는 수정 라운드에서 바뀌지 않아 이미지·DMG 재빌드 불필요.

## 3. 사용자가 해야 할 것 — 순서대로

### 3-1. Supabase 마이그레이션 (SQL Editor)

1. 앞서 드린 상태 점검 쿼리를 실행해 `false`인 항목을 확인한다.
2. `false`인 파일만 **파일명 순**으로 전체 붙여넣기 → Run. 모두 추가 전용·재실행 안전.
   - `202609010001`~`202609010005` (이미 적용되어 있을 가능성 높음)
   - `202609020001`~`202609020005`
   - `202609050001`~`202609050006` (`0006`은 오늘 저녁 추가: `set_profile_voice_provider_v3`, `set_live_session_engine_admin_v3`)
3. 확인:
   ```sql
   select proname from pg_proc where proname in (
     'upsert_profile_on_login_v1','set_profile_status_v1','set_profile_role_v1',
     'set_live_session_engine_admin_v1','set_live_session_engine_admin_v2','set_live_session_engine_admin_v3',
     'set_profile_voice_provider_v2','set_profile_voice_provider_v3','read_profile_admin_v1',
     'list_live_session_ids_for_host_admin_v1','reset_live_summary_generation_v1'
   ) order by 1;
   ```
   11개가 모두 나와야 한다. `set_live_session_engine_admin_v1`은 절대 revoke하지 않는다(구 리비전 롤백 경로).
4. 저에게 "마이그레이션 완료"라고 알려 준다. 그 시점에 제가 §4를 실행한다.

### 3-2. Google / Supabase 인증 설정 (대시보드, 비밀 값 포함이라 사용자 직접)

1. Google Cloud Console → OAuth 클라이언트(웹) 생성. 승인된 리디렉션 URI에 Supabase 콜백(`https://<project-ref>.supabase.co/auth/v1/callback`)을 넣는다.
2. Supabase → Authentication → Providers → Google 활성화, 위 클라이언트 ID/시크릿 입력.
3. Supabase → Authentication → URL Configuration: Site URL `https://realtime-noel-web.vercel.app`, Redirect URLs에 `https://realtime-noel-web.vercel.app/auth/callback`, `https://realtime-noel-web.vercel.app/**`, 그리고 데스크톱용 `nova://auth/callback`.
4. Supabase → Authentication → Email: "Confirm email" 활성화(회원가입 → 이메일 확인 → 관리자 승인 흐름).
5. `ADMIN_BOOTSTRAP_EMAILS`에 등록한 이메일(운영자 본인)로 첫 Google 로그인을 하면 `profiles` 행이 `role=admin, host_id=noel`로 생성된다.

### 3-3. 게이트웨이 / Soniox 계정

1. **Soniox 동시 연결 한도**: 팬아웃 어댑터는 입력당 언어별 연결을 연다. 3개 언어 세션 = 3연결, 롤오버 교체 순간 최대 6, 데스크톱 마이크+시스템 입력이면 2배. 동시 라이브 세션 수 × 12를 여유 있게 감당하도록 Soniox 콘솔에서 한도(기본 플랜은 낮음)를 확인·상향한다. 부족하면 `ENGINE_UNAVAILABLE`로 해당 레인이 죽고 자막이 끊긴다.
2. Cloud Run 시크릿 `realtime-noel-soniox-api-key`는 이미 새 리비전에 연결되어 있다. 키를 교체할 때는 시크릿에 새 버전을 추가하고 리비전을 다시 배포한다(`latest` 참조).
3. 게이트웨이 env는 변경할 것이 없다. 참고로 필수 목록은 `media-gateway/README.md` 5행. `LIVE_GATEWAY_ALLOWED_ORIGINS`에 웹앱 도메인이 이미 있고, 데스크톱 레인은 `LIVE_GATEWAY_ALLOW_TRUSTED_NON_BROWSER`가 켜져 있어야 한다(현 리비전에서 상속).
4. 모니터링에 추가할 메트릭: `engine_switches_total`, `engine_switch_failures_total`, `engine_switch_rate_limited_total`, `engine_switch_unauthorized_total`, `host_reattach_engine_repins_total`, `host_reattach_engine_repin_refusals_total`.

### 3-4. 데스크톱 설치

NOVA 종료 → `/Applications/NOVA.app` 백업 → `dist/NOVA-0.2.3-arm64.dmg`로 교체(DMG 빌드만으로는 설치 앱이 바뀌지 않는다). 첫 실행에서 마이크·화면 권한을 다시 물을 수 있다. 확인: 설정에 엔진 선택이 **없고** 현재 배정 엔진이 읽기 전용으로 표시되는지, Google 로그인 → 시스템 브라우저 → `nova://` 복귀, Live Call 1회.

## 4. 마이그레이션 확인 뒤 제가 실행할 것 (순서 고정)

1. 리포 루트에서 `vercel deploy --prod`. 확인: `/api/live-config`(`captionEngines` 포함), `/login` 카드, `/console/users`에서 사용자별 엔진 전환 응답 표.
2. 게이트웨이 트래픽 전환:
   ```bash
   gcloud run services update-traffic realtime-noel-media-gateway --region asia-northeast3 --project gen-lang-client-0321430669 --to-revisions realtime-noel-media-gateway-nova-20260905=100
   ```
   확인: `curl -s https://realtime-noel-media-gateway-snqwfuxqza-du.a.run.app/health` 200, 웹 호스트 Live Call 1회(Soniox 기본), 콘솔에서 그 사용자를 Gemini로 바꿔 `switched`와 호스트 `engine-status` connecting→ready 확인.
3. 결과를 워크로그에 기록하고 통합 브랜치를 PR로 올린다.

순서를 지키는 이유: 새 웹앱은 v3 RPC를 호출하므로 마이그레이션이 먼저여야 하고, 새 게이트웨이의 `/internal/sessions/:id/engine`은 웹앱이 보내는 `assignmentRevision`을 기대하므로 웹앱 다음이어야 한다.

## 5. 롤백

| 대상 | 명령/행동 |
|---|---|
| 게이트웨이 | `gcloud run services update-traffic realtime-noel-media-gateway --region asia-northeast3 --project gen-lang-client-0321430669 --to-revisions realtime-noel-media-gateway-live-input-20260901=100` |
| 웹앱 | Vercel 대시보드에서 이전 배포 Promote |
| 데스크톱 | 백업한 `NOVA.app`으로 교체 |
| 마이그레이션 | 유지(추가 전용). 구 코드는 v1/v2 RPC를 계속 쓴다 |

## 6. 배포 후 P0 검증 (실음성)

1. 한국어→영어/일본어 3언어 세션에서 비엄격 언어 힌트가 한국어를 zh/vi로 오인식하지 않는지 `live_source_utterances.source_language` 분포로 확인(로그보다 먼저 볼 것).
2. 콘솔에서 Soniox↔Gemini를 라이브 중 전환해 자막 공백이 1~2초 이내인지, seq가 이어지는지(뷰어 블랙아웃 없음).
3. 데스크톱 호스트 네트워크 끊김 → 재접속 후 같은 세션 유지(웜 재부착), 전환 뒤 재접속 시 `SESSION_REVOKED`가 나오지 않는지.
4. 요약: 세션 종료 후 스켈레톤 → 요약, 30분 초과 시 `SUMMARY_GENERATION_STALLED` 안내.

## 7. 후속(비차단)

비밀번호 재설정 화면, Drive 용어집, XLSX 빈 레인 라벨, 레거시 `noel` 비밀번호 로그인 끄기(안정화 며칠 뒤 콘솔 스위치), Preview 환경 `SESSION_SECRET` 등록(프리뷰 빌드 복구).
