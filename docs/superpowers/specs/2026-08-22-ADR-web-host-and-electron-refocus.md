# ADR-2026-08-22: 웹 전용 호스트 완성과 Electron 컴패니언 슬림화

**Status:** Accepted (eng review 반영 v2 — 2026-08-22)
**Date:** 2026-08-22
**Deciders:** noel (제품/기술 총괄)

> v2 수정: outside voice(Claude 서브에이전트)가 v1의 전제 오류를 입증 — 웹 호스트
> 오디오는 신축 대상이 아니라 **이미 출하되어 있음**(`live-audio-client.ts`,
> commit 8ed4b98). 본 문서는 "갭 메우기" 계획으로 재작성되었다.

## Context

호스트 역할은 두 클라이언트가 수행할 수 있다: Electron 데스크톱(시스템/믹서 캡처,
오버레이)과 **웹앱 호스트 대시보드**. v1 감사는 웹 호스트가 없다고 판단했으나
재검증 결과 다음이 이미 출하되어 있다:

| 이미 출하됨 | 근거 |
|---|---|
| 브라우저 HOST 업그레이드 (Origin 허용목록) | `gateway-security.js:40-48` |
| 웹 호스트 마이크 캡처 + 40ms/1,280B 프레임 | `live-audio-client.ts` (AudioWorklet) |
| 토큰 선제 갱신 + 사전 재접속 | `live-audio-client.ts:161-168, 581-595` (`scheduleProactiveReconnect`, 만료 60초 전) |
| 대시보드 브로드캐스트 연결 | `LiveHostDashboard.tsx` `connectBroadcast` |
| 어드민 로그인 → 세션 생성 → 유저 조인 | /login, /api/live-sessions, /watch |
| 게이트웨이 clientKind 전환 reattach | `gateway-server.js:1410-1428` |

**검증된 잔여 갭 (이번 단계 범위):**

1. **마이크 장치 선택 없음** — `LiveHostDashboard.tsx:271` `inputSource: "mic"` 하드코딩, `enumerateDevices`/`deviceId` 사용 0건
2. **4410 REPLACED 미처리** — 밀려난 호스트 탭이 원인 불명 끊김으로 인식, 재접속 핑퐁 위험 (`gateway-server.js:1424`)
3. **Wake Lock 없음** — 화면 꺼짐 방지 부재 (주의: Wake Lock은 화면 꺼짐만 방지, 탭 백그라운드는 별개 — 가시성 경고로 보완)
4. **재접속 교체 순간 프레임 스풀 없음** — `isReplacing` 가드만 있고 교체 중 프레임은 유실
5. **브라우저 HOST 계약 테스트·문서 부재** — CLAUDE.md가 "호스트=비브라우저"로 서술(스테일), 회귀 방지 테스트 없음
6. **웹 호스트 E2E 부재**
7. **웹↔Electron 인계 불가** — reattach는 `activationKey` 일치 필요(`gateway-server.js:1386-1389`)한데 웹 start는 매번 새 UUID(`start/route.ts:39`), Electron은 자체 키(`electron/main.js:2906`) — 공유 경로 없음. **사용자 결정: 이번 범위에 포함**

## Decision

**D1(v2): 웹 호스트는 신축이 아니라 위 갭 7개를 메워 완성한다.**
출하 동작 보존 원칙: 프레임은 무태그 유지(레인 변경 회피), `getUserMedia` 제약은
EC/NS/AGC=true(사용자 승인 baseline) 유지 — 변경은 리허설 실측 후에만.

**D2: Electron을 "캡처·오버레이 컴패니언"으로 슬림화한다 (별도 단계, 변경 없음).**
고유 가치 4개만 유지: 시스템/믹서 캡처, 클릭스루 오버레이, 로컬 Moonshine, OS 권한
영속(appId 불변). 세션 CRUD/초대/기록 UI는 웹으로 이관. 전면 재작성 기각(권한 상실).

## 인계(handover) 설계 — 갭 7 (구현 반영)

구현 중 확인: 활성화 키는 이미 게이트웨이 readiness RPC가
`live_sessions.gateway_activation_key`에 영속하고 있었다
(`202608150006_live_gateway_readiness_start.sql`). 따라서 신규 저장이 아니라
**노출·채택**으로 구현했다:
- 호스트 전용 GET `/api/live-sessions/[id]`가 세션의 `activationKey`를 반환
  (store `fromRow`가 UUID 검증 후 매핑; 뷰어 projection(admission store)은 별도
  필드 목록이라 노출되지 않음)
- 웹 대시보드: 이미 live인 세션 재접속 시 `activeSession.activationKey`를 제시
  → 페이지 새로고침에도 웜 reattach
- Electron: Go-Live 직전 세션 재조회 응답의 `activationKey`를 채택(없을 때만
  로컬 mint fallback) → 웹→데스크톱 인계가 파이프라인·seq·floor를 보존
- 게이트웨이 계약 테스트가 고정: 같은 키=웜 reattach+구 소켓 4410, 다른 키=콜드 재시작

## Trade-off Analysis (v1에서 유지되는 판단)

- 서버사이드 릴레이(SFU) 기각 — 자막 전용 제품 과설계, scale-to-zero 위배
- Electron 전면 재작성 기각 — appId 변경 시 macOS TCC 권한 상실
- 마이크 전용 세션=웹 호스트 / 믹서·오버레이 행사=컴패니언 역할 분리 유지

## Consequences

- (쉬워짐) 호스트 온보딩: 설치 없이 어드민 로그인만으로 진행
- (쉬워짐) 웹↔Electron 인계가 근거 있는 기능이 됨 (activationKey 서버 소유)
- (재방문) 리허설 실측 2건: 탭 백그라운드 오디오 연속성, EC/NS/AGC의 STT 영향 (TODOS.md)
- (재방문) Electron 슬림화 실행 (별도 단계)

## Action Items (v2 — 갭 메우기)

1. [x] **P1** 4410 REPLACED 전용 처리 — 재접속 금지 + "다른 기기에서 호스트로 접속했어요" + 수동 재시작 버튼
2. [x] **P1** 재접속 교체 프레임 스풀 (≤2초) — `live-audio-client.ts` reconnect 경로
3. [x] **P1** 브라우저 HOST 계약 테스트(media-gateway) + CLAUDE.md/주석 갱신
4. [x] **P1** activationKey 서버 소유화 + 웹/Electron 공유 → 인계 동작
5. [x] **P2** 마이크 장치 선택 picker (enumerateDevices, deviceId 전달)
6. [x] **P2** Wake Lock + 가시성 경고 배너 (foreground-recovery 재사용)
7. [x] **P2** 웹 호스트 E2E: 시작→조인→롤오버→인계→종료
8. [ ] **P3** Electron 슬림화 (별도 단계 — v1 계획 유지)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 7 issues, 0 critical gaps open |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean (2026-08-22, 별건: 뷰어 TDS) | score 6→9/10 |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** outside voice(Claude 서브에이전트; Codex는 CLI 모델캐시 오류로 실패)가 v1의 전제 오류(웹 호스트 기출하)와 인계 근거 부재를 입증 — 4개 tension 모두 사용자 결정으로 해소(갭 재작성, 출하 동작 유지, 인계 이번 범위 포함).
- **VERDICT:** ENG CLEARED — 갭 7개로 재작성된 계획 승인, 구현 진행.

NO UNRESOLVED DECISIONS
