# 외부 유료 API 사용 감사 — 이중 사용·과사용·누수

- 감사일: 2026-08-22 (읽기 전용, 워킹트리 기준 + Cloud Run 배포본(HEAD 25707a7) 대조)
- 범위: Gemini(generativelanguage) · Cloud STT V2 · Supabase / 3개 표면(게이트웨이 서버, 데스크톱 로컬 파이프라인, 웹앱)
- 기준 시나리오: 2시간 행사, 3개 언어, 뷰어 200명, 분당 final ~20개

## 배포 상태별 최우선 결론

| 상태 | 발견 | 규모 |
|---|---|---|
| 🔴 **지금 Cloud Run에서 과금 중** (로컬에 수정 있으나 미배포) | interim마다 비원문 레인 Gemini 번역 — 출력은 어디에도 저장 안 됨(순수 폐기 지출) + admission 30rpm과 충돌해 final 번역까지 굶겨 30초 자막 블랙아웃 유발 | **~7,000+ Gemini 호출/2h 폐기** |
| 🔴 지금 배포 중 (로컬 수정 미배포) | 뷰어 인증 RPC 2.5초 개별 발사 (배치 없음) | **~576,000 Supabase RPC/2h** → 로컬 수정본은 리스+배치로 ~72,000 (8×↓) |
| �min **새 코드 — 이대로 배포하면 신규 발생** | participant-speaking 재인증이 뷰어별·비배치·~4.25초 주기 (`gateway-server.js:1177-1187`) | 발언 가능 뷰어 200명 시 **~340,000 RPC/2h** — 함께 실리는 배치 인증의 4.7배. **게이트웨이 배포 전 배치/리스 필수** |
| 🔴 데스크톱 기본 설정 | `responseModalities:["AUDIO"]` 무조건 + 기본 captions 모드 → **4채널이 문장마다 음성 합성 후 전부 폐기** (7월 audio output ₩77,421의 직접 원인 구조) | Live 비용의 ~86%가 폐기 음성 |
| 🔴 데스크톱 기본 설정 | 무음 포함 상시 스트리밍 × `system_mic` 기본 2소스 × 언어 수 = 기본 4배 입력 과금, VAD 송신 게이트 없음 | 무음 1시간도 4시간치 입력 과금 |

## 이중 사용 (같은 일에 두 번 지불)

1. **Live Call 하이브리드 이중 엔진** — 호스트 PCM을 로컬 Gemini Live(소스×언어, 최대 6세션)와 게이트웨이 파이프라인이 **동시에** 번역 (`subtitle-dashboard.js:3930-3961`, 의도된 설계지만 문장당 최대 ~4 LLM 패스). 참가자 발언 중에도 로컬 레인은 플로어 게이트 없이 계속 스트리밍.
2. **로컬 한 줄 이중 번역** — Live가 번역한 문장을 selective polish의 `recoverFromSource`가 Flash로 재번역 가능 (`polish-policy.js:228-233`); 대형 기본 용어집 탓에 `hasUnresolvedTerm` 빈발 가능.
3. **웹앱 같은 row 중복 읽기** — `/status`·`/summary`·`/transcript` 라우트가 한 요청에서 동일 `live_sessions`를 2–3회 조회 (`assertHostSessionOwnership`+`readSessionLifecycle` 연쇄).
4. **스테이지 이중 폴링** — 호스트 5초 폴링마다 세션 객체 identity가 갈려 BroadcastChannel 재브로드캐스트 → 스테이지가 무조건 재조회 = 2배 (5초당 API 4회/Supabase 10 reads).
5. **speaker legend RPC ×3** — 동일 페이로드를 언어별 3회 persist.
6. **STT rollover 2초 중복 청구** — 270초마다 +0.74% (화자 라벨 remap용, 의도·허용 수준).
7. (반증) **뷰어 자막 이중 경로 없음** — 캡션은 WebSocket 단일 경로, REST snapshot은 1회 가드. 단 **재접속 경로가 가드를 우회**해 매 재접속 wave마다 200명×7 reads 재다운로드 (`LiveViewer.tsx:999`).

## 과사용 (불필요하게 잦거나 큼)

- **대기실 상태 폴링 2.5초 ×200명** — 탭 가시성 게이트 없음: 10분 대기실 = ~48,000 요청/~96,000 reads, 게이트웨이 push와 중복 (`LiveViewer.tsx:699`)
- **호스트 participants 5초마다 최대 5,000행 조회 후 100개만 렌더** — `seq.asc`라 심지어 "최근"도 아님; `desc&limit=100`으로 축소 가능 (`lib/live/activity.ts:78-110`)
- **join rate limit 60/5분 < 제품 상한 200명** — QR 스캔 러시에서 61번째부터 429 (`live-rate-limit.ts:125-133`)
- **구독자 0 레인도 번역·영속** — `getSubscriberCount` 주입만 되고 미사용; 기록 기능으로 방어 가능하나 무조건적 (~4,800 호출/2h)
- **재접속 herd** — base 500ms ±20% jitter: 게이트웨이 순단 시 200명이 10초 내 ~5,000 Supabase 연산 + 티켓 버킷(1,200/60s) 고갈로 순단→지속 장애 전환
- **로컬 무한 재연결** — 10회 후 5초 간격 영구 재시도(세션 수명 내), 성공마다 새 과금 세션

## 누수 (수명주기 밖 호출)

- topic detector가 **Stop 이후** 큐 드레인으로 ≤256회 Gemini 호출 (bounded)
- 호스트 5초 폴링이 stopped/failed/만료 후에도 **영원히** 지속 (`LiveHostDashboard.tsx:1109-1157` — sessionId null만 종료 조건)
- 파이프라인 복구 시도마다 동일 fingerprint 용어집 재로드 (≤12회, 캐시 가능)
- (클린) 데스크톱 수명주기 누수 없음: producer 소켓 사망 시 유료 provider 즉시 종료; 웹앱 토큰 발급 라우트 폐쇄 확인(410/삭제)

## 권장 우선순위

**P0 (배포 게이트)**
1. `authorize_live_participant_speaking_v1` 배치/리스화 — **게이트웨이 배포 전에** (미수정 시 이번 배포가 ~340k RPC/2h 신규 유발)
2. 게이트웨이 Cloud Run 배포 — interim 번역 폐기 지출(~7k Gemini/2h)과 뷰어 인증 8× 절감이 로컬에만 있음. 배포 자체가 최대 절감 행위

**P1 (데스크톱 비용 구조)**
3. Live Call 중 로컬 엔진 중단(또는 opt-in) — 이중 엔진 해소
4. `responseModalities:["TEXT"]` 라이브 프로브 — 수용 시 로컬 Live 비용 ~86% 제거; 불가 시 언어채널·소스 수 축소
5. 기본값 교정: `inputMode` mic 단일 + VAD 송신 게이트(무음 미전송)

**P2 (웹앱 소음)**
6. 대기실 폴링: visibility 게이트 + 게이트웨이 push 우선 / participants 쿼리 `desc&limit=100` / 스테이지 identity-stable merge / join limit 200 정합 / 재접속 snapshot 가드 통일 / 호스트 폴링 종료 조건

**P3**: legend ×3 축약, 용어집 fingerprint 캐시, `/summary` 캐시, 재접속 base 지연 상향
