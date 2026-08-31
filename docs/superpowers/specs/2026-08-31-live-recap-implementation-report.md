# 라이브 기록·수신 신청 구현 검증 — 2026-08-31

사용자가 전체 구현을 승인했고 실제 이메일 발송은 별도로 처리하기로 확정했다. 구현은 로컬 작업 트리에 있으며 운영 배포·DB 적용·메일 발송·Git push는 하지 않았다. 이미 있던 대규모 미커밋 변경은 보존했다.

## 구현 결과

- 라이브 연속 자막: 회색 작성 중 → 흰색 확정. 라이브 요약 CTA 없음. 발언 권한이 있는 경우만 가운데 아이콘 캡슐 마이크.
- 종료: 서버 endedAt+6시간의 원문/요약 읽기와 기존 참여자 복구. 5xx 장애가 인증 정보 삭제나 즉시 로그아웃으로 연결되지 않는다.
- 버튼 클릭으로 해당 회의의 원문·요약 이메일 수신 신청과 v2 목적 동의를 원자적으로 저장. 마케팅 동의는 변경하지 않는다. 발송 worker/공급자/배달 상태는 범위에서 제외.
- 호스트: 참여자/원문/AI 요약/수신 신청자 4탭. 검색/화면 페이지와 무관한 5시트 실제 XLSX. 긴 원문·한글·이모지·수식처럼 보이는 문자열을 보존한다. 초과 데이터는 명시적 실패로 처리한다.
- 수요 런타임: 실제 참여자 연결과 준비된 호스트 소스가 있을 때만 음성 처리. 마지막 이탈 후 30초 유예 및 최대10초 정리. 미디어 휴면과 회의 종료 분리. 오래된 epoch 쓰기, 지연된 heartbeat, 새로고침 경합, 실패 상태 자동 재가동 차단.
- 원문·요약·Excel은 실제 미수집 구간을 표시한다. 수집되지 않은 발언을 복원했다고 주장하지 않는다.

## 주요 변경 경계

| 영역 | 파일 |
|---|---|
| 참여자 | LiveViewer.tsx, ViewerReadingFeed.tsx, ParticipantMeetingMinutes.tsx, ViewerRecapRequest.tsx, viewer-records-recovery.ts, viewer-source-record.ts, globals.css |
| 호스트 기록 | webapp/components/live/records/*, app/records/demo 및 app/m/records/demo |
| 요청·XLSX | webapp/lib/live-recap/*, api/live-sessions/[id]/recap-request, api/live-records/[id]/recipients 및 export |
| 6시간 인증 | lib/auth/live-auth.ts, lib/security/live-viewer-authorization.ts, live-admission-store.ts, csrf.ts, records-session 및 source transcript 경로 |
| 웹 호스트 | host-demand-control.ts, live-audio-client.ts, LiveHostDashboard.tsx, scheduled-gateway-start.ts |
| Electron | electron/live-demand-controller.js, electron/main.js, public/subtitle-dashboard.js, subtitle-controller.js, subtitle-i18n.js |
| 게이트웨이 | media demand coordinator/store, gateway-server, publisher, pipeline, provider drain 및 runtime API |
| 스키마 | 202608310002/003/004 추가 migration, bootstrap-new-project.sql의 동일 구간, supabase/README.md |
| 패키지·설정 예시 | ExcelJS4.4.0와 uuid11.1.1 override, 새 테스트 등록, 기본 false 수요 플래그, 예약 prewarm cron 제거 |

## 실행 검증

| 검사 | 결과 |
|---|---|
| root 전체 | 1,313 PASS / 0 FAIL / 2 SKIP |
| web 전체 | 742 PASS / 0 FAIL |
| gateway 전체 | 415 PASS / 0 FAIL |
| 별도 로컬 PostgreSQL(PGlite) 실제 SQL | 17 PASS / 0 FAIL |
| root/web TypeScript | PASS |
| git diff --check | PASS |
| web production dependency audit | 취약점0 |
| 브라우저 화면·조작 | design-qa.md 참조 |

root의 SQL 선택 검사는 기본 환경에서 건너뛰지만 별도 PGlite 실행으로 검증했다. 다른 skip은 기존 dual-WebSocket mirror 테스트의 runner hang 예외다. 전체 Supabase 설치나 실기기 E2E가 통과했다는 의미는 아니다. 프로젝트에 lint script는 없다.

## 적대적 검증

| 항목 | 결과·근거 |
|---|---|
| A1 동시성 | 같은 신청 중복 저장/마케팅 수정 없음, 낡은 epoch 쓰기 차단, pending 연결이 idle deadline을 연장하지 않음. SQL·WebSocket·클라이언트 회귀검사 통과 |
| A2 권한 | 타 호스트 export, 타 회의/철회 참여자, 만료 원문 접근 차단. runtime GET middleware 누락으로 발생하던 참가자401도 수정 |
| A3 Origin | 요청 저장은 정확한 Origin 검사. runtime 읽기만 GET 허용, host-source/변경 요청은 예외 불가 |
| A4 XSS/수식 | React 텍스트 렌더링, XLSX 문자열 셀. 수식·링크 객체 없음. 긴 Unicode 및 SpreadsheetML escape 원문 보존 검사 |
| A5 외부 입력 | 임의 수신 주소/CC/첨부 URL을 받지 않음. 이번 흐름에 외부 URL fetch/메일 전송 없음 |
| A6 경계 | 정확한6h, 잘못된 HTTP 성공 envelope, 역순/다른회기 응답, 긴 셀·용량 초과·Unicode 처리 |
| A7 잔류 | stop 중 늦은 요청이 연결을 살리지 않음. 응답이 유실된 false 요청도 source generation 폐기. 실패 runtime은 수동 재시작만 해제 |
| A8 화면 | 모바일 여백·단일 스크롤·하단 CTA 잘림 수정. 320/390px와1280px 확인. 실제 iPhone/iPad/Electron 장치 검증은 별도 |

추가로 이전 회의 버전을 사용한 demand wake, 수동 재시도 오류를 성공으로 표시한 경로, demand flag 해제 시 legacy로 전환되는 경로, Electron 자동 복구가 로컬 AI를 켜는 경로를 수정했다.

## 활성화와 롤백

1. 운영 변경은 사용자 ‘배포해’ 명령 후에만 실행한다. 먼저 개발/스테이징에서 전체 migration 체인과 인증된 실시간 연결을 검증한다.
2. 추가 migration002→003→004를 기존 schema 위에 적용하고 웹·게이트웨이·Electron 호환 버전을 함께 배포한다. 요청·명단·XLSX 기능도 신규 RPC가 필요하다.
3. `LIVE_PARTICIPANT_DEMAND_ENABLED=false`가 기본이다. 일치하는 웹/게이트웨이 설정과 DB가 확인된 뒤에만 양쪽을 true로 활성화한다. Electron은 서버 runtime.enabled를 따른다.
4. Cloud Run min instances0 등 운영 조건에서만 scale-to-zero가 가능하다. 단일 방이 비어도 다른 방에 참여자가 있으면 공유 서비스가 유지된다. 실제 비용·축소 시간은 아직 측정하지 않았다.
5. 롤백 전 활성 demand 세션을 정리하고 소스/연결이 닫혔는지 확인한다. 동작 중 플래그만 꺼서 legacy로 자동 전환하지 않는다. 추가 테이블·동의 원장은 파괴적으로 삭제하지 않는다.

## 로컬 확인

- 참여자: http://127.0.0.1:3100/m/watch/demo
- 호스트: http://127.0.0.1:3100/records/demo
- 예시 데이터로 정상·실패·만료·권한 상태를 조작할 수 있다. 기록 화면 시연은 production에서 비활성이다.
- 같은 로컬 서버의3100포트만 이 작업에서 사용했다. 기존3000서버는 종료하거나 변경하지 않았다.
