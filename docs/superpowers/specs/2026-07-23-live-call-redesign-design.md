# Live Call 전면 개선 설계 (2026-07-23)

레퍼런스: 어닝콜 실시간 번역 앱 화면 녹화(토스증권 AI 어닝콜 스타일 — 다크 테마,
화자 라벨+타임스탬프 카드 피드, 요약/원문 토글, 챕터 마커, 한/EN 전환, 하단 라이브
캡션 시트). WhisperLiveKit 분석에서 차용: append-only 자막 커밋, 화자 분리 중심 설계.

## 결정 사항 (사용자 승인)

- 아키텍처: **media-gateway(Cloud Run) 기반**. webapp(Next.js)이 컨트롤 플레인,
  gateway가 오디오/자막 데이터 플레인.
- 자막 번역: **Gemini Live Translate** (기존 파이프라인 유지). 참가자는 각자 원하는
  언어로 구독(뷰어별 언어 토픽 — 이미 구현되어 있음).
- 범위: ①Live Call 코어(발언권) ②모바일 UI ③번역 음성 ④미팅 요약 전부 + ⑤관련
  화면 리디자인.
- 저장: **Supabase** (프로젝트 Realtimenoel / lrvgvdolsnmdffjqlorn).

## 필요한 API 키 (사용자 질문에 대한 답)

| 키 | 용도 | 필수 여부 |
| --- | --- | --- |
| `GEMINI_API_KEY` 1개 | 자막 실시간 번역(Gemini Live) + 미팅 요약 생성 | 필수 |
| GCP 프로젝트(서비스 계정 ADC) | Cloud STT 화자분리(meeting), Chirp TTS 번역 음성 | 필수 (별도 "키"가 아니라 서비스 계정) |
| Supabase URL + `sb_secret` | 세션/그랜트/기록/요약 저장 | 필수 |
| `OPENAI_API_KEY` | presentation 음성 모드 전용(선택 경로) | Gemini만 쓰면 실사용 없음 (env는 요구되므로 등록만) |
| `LIVE_GATEWAY_TOKEN_SECRET`/`LIVE_VIEWER_TOKEN_SECRET` | 토큰 서명 | 자체 생성(구매 불필요) |

즉 새로 발급할 외부 키는 Gemini 1개 + GCP 서비스 계정 + Supabase 프로젝트 키가 전부다.

## 기존 자산 (재사용)

- webapp: 호스트 로그인, 세션 생성, **QR 초대**(`LiveHostDashboard` + `qrcode`),
  초대 리딤 + **이름 입력**(`viewer_grants.display_name`), 모바일 시청(`/m/watch`),
  뷰어 언어 구독, 24kHz 번역 음성 재생.
- media-gateway: HOST 오디오 인입 → Gemini Live 자막 / Cloud STT 화자분리 →
  언어 토픽별 자막+음성 브로드캐스트, Supabase 스냅샷/화자 영속화.
- Supabase: `live_sessions`, `viewer_grants`, `live_session_invites`,
  `live_snapshots`, `session_speakers`, `live_rate_limits`.

## 신규 구현

### 1. 발언권 (Speak / floor control)

- `live_sessions`에 `floor_grant_id uuid null`, `floor_taken_at timestamptz null` 추가.
- RPC `take_live_floor(p_session_id, p_grant_id)` — grant 유효성 검증 후 원자적
  선점(기존 보유자 강제 해제, 새 보유자 기록, `(ok, previous_grant_id, display_name)` 반환).
  `release_live_floor(p_session_id, p_grant_id)` — 보유자만 해제.
- gateway 프로토콜 확장 (viewer 롤):
  - `{type:"speak-start"}` → RPC로 플로어 선점 → 성공 시 해당 WS를 발언자로 표시,
    `{type:"live-event", payload:{type:"floor", holder:{grantId, displayName}}}`를 전 언어
    토픽에 브로드캐스트, 기존 발언자 WS에는 `{type:"speak-ended", reason:"preempted"}`.
  - 발언자 WS만 바이너리 프레임(16kHz/40ms, HOST와 동일 규격) 전송 허용 → 호스트
    세션 파이프라인 `acceptAudio`로 주입. 세션당 동시 발언자 1명.
  - `{type:"speak-end"}` 또는 WS 종료 → 플로어 해제, `floor holder:null` 브로드캐스트.
  - 발언자 오디오 구간의 자막 화자는 diarization 라벨 대신 **participant displayName**으로
    귀속(파이프라인에 `activeFloorSpeaker` 주입, caption.speaker.label 교체).
- 호스트 마이크와 발언자 마이크가 겹치는 경우: 발언자가 플로어를 잡은 동안 호스트
  프레임은 드롭(발언 우선) — 회의 진행자가 명시적으로 다시 말하면 speak-end 후 재개.

### 2. 발언 기록 영속화

- 새 테이블 `live_utterances(id, session_id, seq, language, speaker_label,
  speaker_name, text, emitted_at, created_at)` — final caption마다 저장.
- RPC `persist_live_utterance_if_active(...)` (기존 snapshot RPC 패턴과 동일한 활성
  세션 가드). gateway `SupabaseLivePublisher.publish`에서 final caption 시 호출.
- 세션당·언어당 상한(예: 5,000행) 초과 시 저장 생략(브로드캐스트는 계속).

### 3. 미팅 요약

- 새 테이블 `live_meeting_summaries(session_id, language, summary jsonb, model,
  created_at)` — summary는 {title, overview, chapters[], decisions[], actionItems[],
  speakerHighlights[]} 구조.
- webapp API `POST /api/live-sessions/[id]/summary` (호스트 인증) — 세션 종료 상태
  확인 → `live_utterances`를 시간순으로 모아 Gemini(`gemini-flash-latest` 계열)로
  구조화 요약 생성 → upsert. `GET`은 호스트/그랜트 보유자에게 반환.
- 호스트 대시보드: 종료 시 "요약 생성" 플로우 + 지난 미팅 목록(요약 열람).
- 모바일: 세션 종료 이벤트 수신 시 요약 준비되면 요약 화면 표시.

### 4. 모바일 참가자 UI (어닝콜 스타일)

`/m/watch` (LiveViewer 모바일 분기) 리디자인:

- 다크 딥차콜 배경, 상단 고정 헤더(세션 상태 dot + 제목 + 언어 퀵 토글).
- 본문: **화자별 턴 카드 피드** — 화자 색 dot + 이름(발언자면 displayName) +
  타임스탬프, 턴 단위로 묶인 final 자막, 자동 스크롤(사용자 스크롤 시 일시정지 +
  "최신으로" 버튼).
- 하단: **라이브 캡션 시트** — 현재 partial을 크게, 배경 blur, 발언자 이름 pill.
- 언어: 구독 언어 스위치(세그먼트 컨트롤, 세션 languages 목록에서 선택; 한/EN을
  1탭 토글로 우선 노출) — 스위치 시 재구독 + 스냅샷 복원.
- **Speak 버튼**: 하단 중앙 대형 버튼. 누르면 마이크 권한 → speak-start → 발언 중
  상태(파형 애니메이션 + "OOO 발언 중" 배지 전체 브로드캐스트). 다른 사람이 누르면
  기존 발언자는 자동 종료 토스트.
- 번역 음성: 기존 audio 출력 모드 재생 유지(폰 스피커) — 발언자 본인 폰에서는
  자기 발언 음성 재생 음소거(에코 방지).

### 5. 리디자인 (⑤부분)

- LiveHostDashboard: QR 카드/참여자 목록/플로어 상태를 새 비주얼로 정리.
- 데스크톱 앱(public/subtitle.html)의 Live 진입 카드 문구/스타일 정돈은 후속.

## 테스트 전략

- gateway: `media-gateway/test`에 floor-control 유닛/통합 테스트(TDD) — 가짜
  authorizer/pipeline으로 speak-start 선점, 바이너리 수락, 자막 화자 치환, 해제 검증.
- webapp: 기존 `test:live` 패턴에 floor/summary 서비스 테스트 추가, `typecheck`.
- Supabase: 마이그레이션은 MCP `apply_migration`으로 적용, RPC는 SQL로 검증.

## 알려진 한계

- 발언자 오디오는 gateway를 통해 번역 파이프라인으로만 흐른다(원음 릴레이 없음).
  참가자들이 듣는 것은 번역 TTS 음성이다 — 사용자의 "라이브 번역처럼" 요구와 일치.
- iOS Safari 자동재생 정책: 첫 탭(입장 버튼)에서 AudioContext를 resume해야 한다
  (기존 live-audio-client 처리 재사용).
- 같은 회의에서 호스트 발화와 참가자 발언이 물리적으로 같은 공간이면 에코 가능 —
  발언 중 호스트 프레임 드롭으로 완화.
