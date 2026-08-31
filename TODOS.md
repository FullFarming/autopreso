# TODOS

## 디자인 부채 (2026-08-22 /plan-design-review에서 승인)

- [ ] **lang 속성 부여 (P2)** — CaptionEntry의 번역 본문과 원문에 각각 `lang` 속성. 스크린리더가 영어·일본어 자막을 한국어 음성으로 낭독하는 접근성 결함 해소. 데이터는 계약(sourceLanguage)에 이미 있음. Files: webapp/components/live/translation/CaptionEntry.tsx
- [ ] **브레이크포인트 통일 (P2)** — globals.css 레거시 760px vs 모듈 767px를 한 값으로. 토큰 계층 작업(T-A)과 함께 처리 권장. 경계 근처 회귀 확인 필요.
- [ ] **UA 리다이렉트 → 반응형 CSS (P3)** — /watch→/m/watch UA 리다이렉트 + compact prop 이중 구조를 단일 반응형 레이아웃으로 통합. 회귀 면적 큼(뷰어 전체), 독립 작업으로 분리. Files: webapp/lib/viewer-surface-routing.ts, LiveViewer.tsx
- [ ] **레거시 데드 서피스 제거 (P3)** — 미사용 컴포넌트 8개(MeetingTurnFeed, ConversationFeed, SubtitleBubble, GlassTopBar, ErrorBanner, usePipOverlay, quality/HostLiveSurface, LanguageSelector) + globals.css 950~1250 레거시 밴드 + 고아 CSS. 주의: 테스트가 텍스트로 읽는 파일 확인 후 삭제.
- [ ] **어닝콜 3탭 IA (P2 로드맵)** — `AI 분석 / 발표 내용 / 지난 발표` 탭 구조 채택. claim/evidence 파이프라인 선행 필요. corrected(정정됨) 상태 모델 포함: 정정은 배지+시각 표시 필수, 무음 교체 금지.

상세 근거: docs/superpowers/specs/2026-08-22-live-viewer-tds-design-improvements.md

## 웹 호스트 리허설 실측 (2026-08-22 /plan-eng-review에서 승인)

- [ ] **리허설 실측 (운영, ~30분)** — ① 브라우저 탭 백그라운드/화면 꺼짐 시 호스트 오디오 연속성(기기별: macOS Safari/Chrome, Windows Chrome) ② EC/NS/AGC=true가 행사장 마이크 STT 정확도에 주는 영향. 웹 호스트 갭 구현 완료 후 실제 기기에서. 결과에 따라 getUserMedia 제약 재검토.
