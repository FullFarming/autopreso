# 라이브 뷰어 TDS 명세 반영 디자인 개선안

- 작성일: 2026-08-22
- 근거 문서: `AI 어닝콜 라이브 디자인 시스템·제품 구현 명세서` (2026-08-21, ~/.aside 세션 아티팩트) + `DESIGN.md` (NOVA 디자인 시스템)
- 리뷰 방식: /plan-design-review 7패스, 웹앱 UI 전수 감사 기반
- 시각 레퍼런스: `~/.gstack/projects/FullFarming-autopreso/designs/live-viewer-tds-earnings-20260822/design-sketch.html`
- 디자인 완성도: 6/10 → 결정 반영 시 9/10

## 1. 확정된 결정 (사용자 승인)

| # | 결정 | 내용 |
|---|---|---|
| 1A | 자막 표시 모드 | `번역만 / 원문만 / 함께 보기` 전역 모드를 ControlDrawer 안 radiogroup으로 추가, 현재 모드는 툴바 상태칩(`보기 번역만`)으로 표시. 기본값 `번역만 + 캡션별 원문 펼침` (명세 D-03) |
| 2A | partial 비색상 신호 | DESIGN.md §8.2 그대로: 대비 승격 + 미확정 텍스트에 파란 점선 밑줄(`underline dashed --nova-system-default 1px`), 같은 크기·무게, 칩·스피너 없음. sr-only로 "입력 중" 제공 |
| 3A | 스테이지 언어 | **영어 유지** — 행사장 QR 화면은 영어 안내가 낫다는 의도적 결정. 결함 아님 |
| 추가 | 영/한 이중 표기 금지 | ① 기본 모드는 `번역만`(함께 보기는 opt-in) ② 자막 언어=원문 언어인 verbatim 캡션에는 `원문 보기` 펼침을 렌더하지 않음(중복 방지) ③ 번역 실패 시 target 레인에 원문을 병기하지 않고 `번역이 조금 늦어요` 상태 문구로 대체 |
| 5A | 타이포 토큰 계층 | DESIGN.md §6.3 스케일(`t1~t7`, `st13` + 줄높이 파생 규칙 + 캡션 전용 램프 `--nova-caption-size`)을 한 곳에 정식 정의. globals.css의 4중 semantic alias 복제를 단일 테마 스코프로 통합 |
| 5B | 화자 정체성 | 아바타 없이 **화자 이름 텍스트에 colorToken 색상만** 적용. 조건: 10색 로테이션 중 `#0A0A0B` 배경에서 4.5:1 미달 색은 밝은 변형으로 교체. 정체성은 이름 텍스트가 전달하므로 색은 보강 신호 |
| 7A | 테마 전략 | 다크 단일 유지 + 5A 토큰을 `data-theme` 스코프 구조로 정의해 라이트는 후일 tier-2 재매핑 한 겹으로 열어둠. records 라이트는 현상 유지 |
| 7B | corrected 상태 | P2 이월. 원칙만 기록: **정정 도입 시 `정정됨` 배지 + 정정 시각 필수, 무음 교체 금지** (명세 §10.4) |
| T5 | 어닝콜 3탭 IA | `AI 분석 / 발표 내용 / 지난 발표` 탭 구조를 **P2 로드맵**으로 채택 (claim/evidence 파이프라인 선행 필요). earnings/ 컴포넌트군은 이 방향으로만 확장 |

## 2. 격차 분석 요약 (감사 결과)

**이미 명세 수준**: 상태 투명성(게이트웨이 9상태×5톤, 대기실 카운트다운, 기능 단위 오류 문구), 자동 추적(pin/unpin + 최신 자막 버튼 + reduced-motion), 접근성 중상위(roving tabindex, 포커스 복원, 44px 타깃), 어닝콜 스캐폴딩(earnings/ 섹션 네비·grounded index).

**결함 (심각도순)**:
1. `--nova-font-size-{t4~t7,st13}` 36곳+ 참조·정의 0 — `translation.module.css` 사용처는 fallback 없어 런타임 무효 (5A로 해결)
2. partial/final 색상 단독 구분 — `translation.module.css:183,191` (2A로 해결)
3. 자막 텍스트 `lang` 속성 0개 — 스크린리더 오낭독 (T1)
4. 표시 모드 부재 — 캡션별 펼침만 존재 (1A로 해결)
5. semantic alias 4중 복제 + 라우트별 테마 하드 분리 (5A/7A로 해결)
6. `SpeakerAssignment.colorToken` 뷰어 경로에서 유실 (5B로 해결)
7. 브레이크포인트 이원화 760/767 (T2)
8. UA 리다이렉트가 반응형 CSS 대행 (T3)

## 3. 구현 태스크

> 2026-08-22 구현 완료: T-A~T-E 전부 + T-F(iOS 모션, 사용자 추가 요구).
> 검증: webapp test:live 538/538, test:core 69/69, tsc, production build 통과.
> T-F 내용: speak 버튼 press가 ease-out으로 눌리고 ease-back(스프링 오버슈트)으로
> 복귀, 활성화 시 마이크 아이콘 pop(nova-icon-pop), 녹음 시트의 정지 컨트롤이
> iOS 보이스메모처럼 스프링 morph-in(nova-record-in). reduced-motion 전부 제외 처리.

- [x] **T-A (P1, human: ~1일 / CC: ~20분)** — webapp 토큰 계층 — DESIGN.md §6.3 타이포 스케일 + 캡션 램프를 `:root[data-theme]` 스코프에 정식 정의, 4중 alias 통합, 200% 줌 reflow 검증 포함
  - Surfaced by: Pass 5 — 토큰 참조·정의 불일치 (결정 5A, 7A)
  - Files: `webapp/app/globals.css`, `webapp/components/live/translation/translation.module.css`, `glossary.module.css`, `earnings.module.css`
  - Verify: `npm --prefix webapp run test:live` + 자막 화면에서 computed font-size가 정의값과 일치
- [x] **T-B (P1, human: ~2시간 / CC: ~10분)** — 자막 상태 신호 — partial 텍스트에 점선 밑줄 + sr-only 상태, final 대비 승격 유지
  - Surfaced by: Pass 2 — 색상 단독 구분 (결정 2A)
  - Files: `webapp/components/live/translation/translation.module.css`, `CaptionEntry.tsx`
  - Verify: `data-caption-state="partial"`에서 non-color 신호 존재 어설션
- [x] **T-C (P1, human: ~2시간 / CC: ~10분)** — 영/한 이중 표기 금지 — verbatim 캡션 원문 펼침 억제 + 번역 실패 시 원문 병기 대신 상태 문구
  - Surfaced by: 사용자 추가 요구 (D7 답변)
  - Files: `webapp/components/live/translation/CaptionEntry.tsx`, `ViewerLaneHealthNotice.tsx`
  - Verify: sourceLanguage == lane language 캡션에 `원문 보기` 미렌더 테스트
- [x] **T-D (P2, human: ~1일 / CC: ~30분)** — 표시 모드 — ControlDrawer radiogroup(번역만/원문만/함께) + 툴바 상태칩, 전환 시 active utterance·스크롤 앵커 유지 (명세 §11.5)
  - Surfaced by: Pass 1 (결정 1A)
  - Files: `webapp/components/live/LiveViewer.tsx`, `translation/CaptionEntry.tsx`, `ControlDrawer`
  - Verify: 모드 전환 후 `[data-utterance-key]` 앵커 유지 테스트
- [x] **T-E (P2, human: ~2시간 / CC: ~10분)** — 화자 이름 색상 — captionLaneInput에서 colorToken 보존, 이름 텍스트에 적용, 대비 미달 색 밝은 변형 매핑
  - Surfaced by: Pass 5 (결정 5B)
  - Files: `webapp/components/live/LiveViewer.tsx:238-253`, `CaptionEntry.tsx`
  - Verify: 10색 전부 4.5:1 이상 대비 계산 테스트

### TODOS (이월)

- [ ] **T1 (P2)** lang 속성 — CaptionEntry 번역/원문에 각각 `lang` 부여 (계약의 sourceLanguage 재사용). 접근성 결함, 2~3줄.
- [ ] **T2 (P2)** 브레이크포인트 통일 — 760px(레거시) vs 767px(모듈)를 한 값으로. T-A와 함께 처리 권장.
- [ ] **T3 (P3)** UA 리다이렉트 → 반응형 CSS — `/watch`→`/m/watch` 리다이렉트와 compact prop 이중 구조를 명세 §9.1 단일 반응형으로 통합. 회귀 면적 큼, 독립 작업.
- [ ] **T4 (P3)** 데드 서피스 제거 — 미사용 컴포넌트 8개(MeetingTurnFeed, ConversationFeed, SubtitleBubble, GlassTopBar, ErrorBanner, usePipOverlay, quality/HostLiveSurface, LanguageSelector) + globals.css 950~1250 레거시 밴드 + 고아 클래스. 테스트가 읽는 파일 주의.
- [ ] **T5 (P2 로드맵)** 어닝콜 3탭 IA — claim/evidence 파이프라인과 함께. corrected 상태 모델 포함.

## 4. NOT in scope (검토 후 명시적 제외)

- **플레이어/다시듣기/챕터 seek/음성 통역** — NOVA 자막 전용 운영 계약(음성 미제공, 비용 확정)과 충돌. 명세의 해당 절은 채택하지 않음.
- **FloatingCaptionPlayer(앱 전역 자막)** — 웹앱은 단일 목적 뷰어라 route 간 유지 요구 없음.
- **TDS 패키지/UI Kit 직접 사용** — 라이선스상 App-in-Toss 전용. NOVA는 clean-room 자체 토큰(DESIGN.md)으로 원칙만 재구현. 토스 자산 미사용 유지.
- **스테이지 한국어화** — 영어 유지 의도적 결정 (3A).
- **지금 양모드(라이트) 구축** — 7A에 따라 구조만 열어둠.

## 5. What already exists (재사용)

- `DESIGN.md` 전체 — 토큰 3계층, 타이포 스케일·파생 규칙, §8.2 partial 신호 설계까지 완비. 이번 작업은 대부분 "이미 설계된 값 입력".
- `translation/` `status/` `earnings/` `consent/` 컴포넌트군 — CSS Module 분리 양호, 그대로 확장.
- `ControlDrawer`(native dialog + 포커스 복원) — 표시 모드 radiogroup의 착륙 지점.
- `CaptionEvent` 계약 — colorToken, sourceLanguage, translationStatus 모두 이미 실림.
- Prior learning [live-call-finals-must-display] — committed+partial 꼬리 합성 패턴의 검증 근거.

## 6. Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| 모바일 라이브 뷰어 (A: 번역만) | ~/.gstack/projects/FullFarming-autopreso/designs/live-viewer-tds-earnings-20260822/design-sketch.html | 다크, 점선 밑줄 partial, 표시 모드 칩 | 칩("듣고 있어요")은 2A 결정으로 제외, 점선 밑줄만. 아바타는 5B 결정으로 이름 색상으로 대체 |
| 모바일 라이브 뷰어 (B: 함께 보기) | 동일 파일 두 번째 프레임 | 원문 위·번역 아래, 번역 지연 상태 | opt-in 모드. verbatim 중복 방지 규칙 적용 |

(이미지 목업은 OpenAI 키 부재로 미생성 — `design setup` 후 `$D variants` 재실행 가능)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | issues_open→resolved | score: 6/10 → 9/10, 9 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** DESIGN CLEARED — 9개 결정 확정, 구현 태스크 5개 + TODO 5개 정의. eng review required before shipping the implementation.

NO UNRESOLVED DECISIONS
