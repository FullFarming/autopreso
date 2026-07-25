# 자막 다국어 확장 + 다채널(뷰어별 언어) 개선 설계

2026-07-12 · looping-engineering 원칙 적용 (유한 루프, 상태 명시, 기존 승인 상태 비파괴)

## 현재 구조 진단 (분석 결과 요약)

1. **언어는 en/ko/ja 폐쇄 열거형.** 서버(`subtitle-realtime.js`, `settings-store.js`,
   `server.js`)와 클라이언트(`subtitle-dashboard.js`, `subtitle-controller.js`)의 약 20곳에
   `["en","ko","ja"]` 화이트리스트가 하드코딩되어 있고, `translationLanguages`는 2~3개로 제한.
2. **"채널"은 서버 내부 (source, targetLanguage) 번역 파이프라인 개념일 뿐**, 뷰어 구독 모델이
   아니다. `broadcast()`는 모든 WS 클라이언트에 동일 바이트를 전송하고, 오버레이는 수신한 모든
   언어 레인을 렌더링한다. 뷰어별 언어 선택 상태가 서버에 존재하지 않는다.
3. **자막 라인에 id/seq가 없고**, 늦게 접속한 클라이언트는 히스토리만 받을 뿐 현재 라이브
   레인 스냅샷을 받지 못한다 → 뷰어별 독립 동기화가 구조적으로 불가능.

## 설계 원칙 (회귀 방지)

- 2026-06-25 승인된 working baseline(EN↔KO 게이트, 레인 라이프사이클, 글로서리 파이프라인)은
  **동작 변경 없이** 유지한다. 모든 변경은 "기본값 동일 + 확장 지점 추가" 방식.
- 언어 감지의 핵심 로직(`detectLanguage`의 en/ko/ja 스크립트 카운팅, 한국어 혼합 게이트,
  합의 아비터)은 수정하지 않는다. 신규 소스 언어는 provider languageCode(Gemini가 보고) 또는
  스크립트-그룹 폴백으로 처리한다.
- 루프 종료 조건: `npm run typecheck` + `npm test` 전부 green. 수정 이터레이션 최대 3회,
  초과 시 해당 변경을 되돌리고 보고한다.

## Phase A — N-언어 기반 (이번 구현)

**새 모듈 `src/subtitle-languages.js`** — 단일 언어 레지스트리:
- 코어: en, ko, ja (기존 동작 그대로) + 신규 출력 언어: zh, es, fr, de, pt, ru, vi, id, th, ar
- 언어별 `{code, label, nativeLabel, script, aliases, charPattern}`
- `MAX_TRANSLATION_LANGUAGES = 5` (언어당 소스별 provider WS 1개씩 열리므로 비용 상한)

**연결 지점 (모두 레지스트리 기반으로 치환, 기본 동작 동일):**
- `subtitle-realtime.js`: `normalizeTranslationLanguages`(cap 3→5), `normalizeLanguageCode`,
  `normalizeProviderLanguageCode`, `translationRoleForSource`(en/ko/ja 3종 세트는 기존 매트릭스
  유지, 그 외는 설정 순서 기반 일반화 + 스크립트-그룹 소스 폴백), `countLanguageCharsFor`,
  `countLanguageSignalChars`(신규 스크립트 추가 — en/ko/ja 텍스트에는 영향 0), `stripSubtitlePrefix`
- `settings-store.js`: `languagePair`/`translationLanguages`/`subtitlePositions` 검증을
  레지스트리 기반으로 확장 (2~5개)
- `server.js`: `subtitle:control` languages 필터 레지스트리화, `GET /api/subtitle-languages`
- `gemini-live-translate.js`: targetLabel 레지스트리화 (신규 언어도 영어 라벨로 프롬프트에 전달)

**알려진 한계 (의도된 범위 제한):**
- 같은 스크립트를 쓰는 두 언어(예: en+es)를 동시에 *소스*로 쓰는 경우 스크립트 감지로는 구분
  불가 → Gemini provider languageCode에 의존. 출력(타깃) 언어로는 제한 없음.
- 글로서리 방향 감지(`detectTermLanguage`)는 ko/ja/en 유지 (글로서리 동작 회귀 방지).

## Phase B — 다채널: 뷰어별 언어 구독 + 독립 동기화 (이번 구현)

**새 모듈 `src/subtitle-channels.js`** — 채널 허브:
- 모든 subtitle 브로드캐스트에 단조 증가 `seq` 부여 (클라이언트 순서 보장/중복 감지)
- 레인 상태 유지: `(source, targetLanguage)`별 마지막 partial/committed, clear 시 제거,
  `subtitle:status idle`에서 전체 클리어
- 클라이언트별 구독: `subtitle:subscribe {languages:[..]|null}` (null=전체, 기존 클라이언트와
  100% 하위호환 — 구독 메시지를 안 보내면 기존과 동일하게 전부 수신)
- 구독/접속 시 `subtitle:snapshot` 응답 → 늦게 합류한 뷰어도 현재 라이브 라인 즉시 표시

**서버 (`server.js`):** `broadcastSubtitleMessage`가 허브를 통과 — `targetLanguage`가 있는
메시지는 구독 필터로 클라이언트별 선별 전송, 나머지(status/history/error)는 전체 전송.

**오버레이 (`public/subtitle-overlay.js`):** URL `?lang=ko` (쉼표 목록 허용) →
- 접속 시 `subtitle:subscribe` 전송, 자기 언어 레인만 렌더링 (기존 라이프사이클 타이머는
  이미 레인별·클라이언트 로컬이므로 "각자만의 동기화"가 자연히 성립)
- `subtitle:snapshot` 수신 시 현재 라인 즉시 렌더
- 파라미터 없으면 기존 동작 그대로 (전체 레인)

사용법: OBS/브라우저 소스/각 참가자 화면에서 `http://<host>:3210/subtitle-overlay.html?lang=ja`
처럼 각자 자기 언어 채널을 연다.

**대시보드 (`public/subtitle-dashboard.js`):** 언어 pill을 `/api/subtitle-languages`에서 받아
동적 렌더링 (오프라인 폴백 en/ko/ja), 선택 상한 3→5. 신규 언어의 화면 위치는 당분간 기본값
(bottom-center) — 위치 지정 UI 확장은 Phase C.

## Phase C — 후속 (이번 범위 밖, 로드맵)

1. 신규 언어별 위치 지정 UI(placement rows 동적 생성) + 컨트롤러 프리셋 동적화
2. 뷰어별 표시 설정(폰트/투명도)을 URL 파라미터로 오버라이드 (`?font=44&opacity=0.8`)
3. zh/es 소스 감지 강화(provider 코드 신뢰도 가중), 글로서리 방향 감지 N-언어화
4. 원격 뷰어(로컬 네트워크 밖) — 현 로컬 origin 게이트를 유지한 채 phone-link(Supabase relay)
   경로에 channel 개념 이식
