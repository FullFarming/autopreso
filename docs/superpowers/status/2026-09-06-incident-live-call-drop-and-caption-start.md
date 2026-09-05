# 장애 기록 — Live Call 즉시 끊김·종료 불가, 자막 시작 오류, /speakers 500 (2026-09-06 00:10~01:00 KST)

## 증상 (사용자 보고)
1. 캡션(로컬 자막) 시작 시 "활성 자막 세션이 아닙니다." 오류.
2. Live Call이 시작 직후 잘 되는 듯하다가 바로 연결이 끊김.
3. Live Call 종료가 안 되고 컨트롤러가 "복구 중"으로 계속 표시.

## 증거
- Cloud Run 요청 로그: 호스트 WebSocket 수명 10.2 s / 1.5 s / 6.0 s (15:12:01Z~15:13:01Z), iPhone 뷰어는 45 s. 게이트웨이는 종료 사유를 로그에 남기지 않음.
- Supabase: 세션 `42d1acbd…` 상태 `live` 고착, `live_source_utterances` 2건(Soniox가 한국어 인식), `live_utterances` 0건.
- Supabase edge 로그: `POST /rest/v1/rpc/persist_live_final_caption_if_active` **400** ×2가 15:12:11.79Z, 15:13:00.98Z — 소켓이 닫힌 바로 그 시점.
- Postgres 로그: `column reference "source_row.id" is ambiguous` (SQLSTATE 42702), PL/pgSQL 함수 `persist_live_final_caption_if_active(…, uuid)` 17인자 오버로드.
- 운영 DB에 더미 인자로 호출해 재현(쓰기 없음): 42702 확정. 같은 패턴의 `append_owned_live_source_correction_v1`도 42702.
- Vercel 런타임 로그: `GET /api/live-sessions/<id>/speakers` 2초마다 **500** — `sharp` 모듈 로드 실패(`ERR_DLOPEN_FAILED libvips-cpp.so.8.18.3`). 종료(DELETE) 요청은 한 번도 도달하지 않음.

## 근본 원인
### A. (증상 2·3) PL/pgSQL 변수/별칭 충돌 — `202608220001_live_authoritative_source_transcript.sql`
세 함수가 행 변수(`source_row`, `session_row`, `participant_row`)를 선언하고 같은 이름을 테이블 별칭으로 써서 `alias.column` 참조가 모호해졌다. PL/pgSQL 기본 `variable_conflict = error`는 해당 문장이 **처음 실행될 때** 42702를 던진다(지연 파싱). 그래서 `p_authoritative_source_id`가 null인 테스트 경로는 통과했고, 실제 원문 id를 넘기는 게이트웨이만 실패했다. 게이트웨이는 최종 자막 저장 실패를 치명적으로 다뤄 호스트 소켓을 닫고, 데스크톱은 재접속 루프("복구 중")에 들어간다. 종료 핸들러는 연결이 없으면 마지막 원문 보존을 위해 `MEDIA_DRAIN_CONNECTION_REQUIRED`로 거부하므로 DELETE가 나가지 않았다. 같은 계열의 버그는 `202608150007`에서 `#variable_conflict use_column`으로 고친 전례가 있고, 8/22 마이그레이션이 재도입했다.

### B. (증상 1) 실패 원인을 덮어쓰는 정리용 stop
로컬 자막은 이제 관리자 배정 엔진(관리형 자막 브로커, 호스트 로그인 필요)으로 시작한다. 시작이 거부되면 대시보드가 정리용 `subtitle:stop`을 보내는데, 서버는 받아들인 적 없는 세션이라 `SUBTITLE_SESSION_MISMATCH`("활성 자막 세션이 아닙니다.")를 돌려주고, 일반 오류 핸들러가 그 문구를 실제 원인 위에 덧칠했다. 실제 원인은 대부분 `HOST_LOGIN_REQUIRED`(데스크톱 로그인 전) 또는 브로커 도달 실패다. Supabase에 관리형 자막 RPC 호출 기록이 전혀 없어 브로커까지 가지 못했음을 확인.

### C. (부수) `/api/live-sessions/[id]/speakers` 500
`photo.ts`가 모듈 최상위에서 `sharp`를 import → 명단 조회(GET)까지 네이티브 모듈 로드에 묶임. Vercel linux-x64 번들에 `@img/sharp-libvips-linux-x64`의 공유 라이브러리가 트레이스되지 않아 dlopen 실패.

## 수정
| 커밋 | 내용 |
|---|---|
| 01c7609 | `202609060001_live_source_transcript_variable_conflict.sql`: 세 함수에 `#variable_conflict use_column` 추가(본문 동일, 운영 본문과 md5 일치 확인). bootstrap 미러, README. 루트 테스트 `test/live-plpgsql-variable-conflict-policy.test.js`가 bootstrap의 최종 정의 전체에 정책 강제(장애 전 RED: 정확히 세 함수 검출). |
| 65b816a | 대시보드: 소유하지 않은 세션의 MISMATCH 응답은 무시, `HOST_LOGIN_REQUIRED`는 `live.hostLoginRequired` 문구로. 웹앱: `sharp` 지연 로드, `outputFileTracingIncludes`로 `@img/**`를 사진 업로드 라우트에 포함. 텍스트 기반 테스트 3건. |

## 운영 반영 (2026-09-06 00:30~00:55 KST)
- 마이그레이션 `202609060001` 운영 적용 → 프로브 재실행: persist는 `P0001 AUTHORITATIVE_SOURCE_LINK_CONFLICT`(정상 도메인 오류), correction은 `42501 HOST_ACCESS_REQUIRED`. 42702 소멸.
- 고착 세션 `42d1acbd…`를 웹앱과 같은 RPC `terminate_live_session`으로 종료(`stopped`, version 5).
- Vercel 프로덕션 재배포(65b816a): `/speakers` 익명 401(모듈 로드 정상), `/login` 200.
- DMG 재빌드·재설치: `/Applications/NOVA.app`(65b816a). 이전 설치는 `NOVA.app.bak-20260906-broken-4c2cbbf`, 9/1 빌드는 `NOVA.app.bak-20260906`.
- 게이트웨이: 코드 변경 없음. 단, 운영 리비전 `nova-20260905`는 hardening 브랜치(ec128de) 시점 이미지라 통합 HEAD와 11개 파일 차이가 있어, HEAD(65b816a) 이미지(Cloud Build 6a475b83, digest f4bcb2ba…)를 리비전 `realtime-noel-media-gateway-head-20260906`(태그 `head-review`, 0% 트래픽, `/health` 200)으로 준비했다. 전환: `gcloud run services update-traffic realtime-noel-media-gateway --region asia-northeast3 --project gen-lang-client-0321430669 --to-revisions realtime-noel-media-gateway-head-20260906=100`.

## 게이트 (작업 트리, 65b816a)
루트 1544 tests / 1523 pass / 0 fail / 21 skip; PGlite SQL 3파일 28/28; 웹앱 1048/1048 + 79/79; 타입체크 클린.

## 남은 확인
1. 데스크톱 재실행 → 로그인 → 캡션 시작(이제 로그인 전이면 "호스트 로그인이 필요합니다" 문구가 보여야 함) → Live Call 1회: 자막이 `live_utterances`에 쌓이고 종료가 정상 완료되는지.
2. 실음성 P0 검증(3언어, 라이브 중 엔진 전환)은 그대로 남음.
3. 게이트웨이 HEAD 리비전 트래픽 전환은 위 1이 정상이면 진행.
