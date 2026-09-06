# 캡션 표시 방식(번역만 / 원문 동시) — 설계 (2026-09-06)

## 배경
로컬 캡션은 선택한 언어마다 레인이 하나씩 있고, 각 레인은 `acceptSource`(`src/subtitle-realtime.js`)로 **자기 언어로 말한 원문**도 `isSourceCaption: true` 자막으로 내보낸다. 그래서 한국어로 말하면 한국어 원문 + 영어 번역이 함께 뜬다. Live Call은 참여자에게 원문 레인을 함께 보여주는 것이 맞지만, 캡션은 오프라인 행사용이므로 기본은 **인입 언어의 반대편 번역만** 보여야 한다(사용자 결정 2026-09-06).

## 결정
- 설정 `subtitle.displayMode`를 살린다(값은 기존 그대로 `translation_only` | `translation_source`). 기본값 `translation_only`.
  - `translation_only`: 원문 캡션(`isSourceCaption`)을 표시하지 않는다. 한국어 인입 → 영어 레인만, 영어 인입 → 한국어 레인만. 3개 언어면 번역 2개.
  - `translation_source`: 선택한 모든 언어 레인을 항상 표시한다(원문 레인 포함). "동시 출력"과 "다중언어 출력"은 이 하나의 옵션이다.
- 필터는 **표시 단계**(오버레이·대시보드 미리보기)에서만 한다. 서버 브로드캐스트와 기록(Records/transcripts)은 그대로 원문 라인을 받는다.
- Live Call 미러 라인(`source === "live-call"`)은 필터 대상이 아니다(플래그도 없다).
- 설정 UI: 캡션 설정의 "출력 방식" 항목에 라디오 2개(번역만 표시 / 원문과 선택한 모든 언어 동시 표시). 숨김 input `displayMode`를 대체한다.
- `translation_source`를 기본값으로 되돌리던 로드 마이그레이션(`settings-store.js`)은 제거한다. 저장된 선택이 유지되어야 한다.

## 변경 파일
`src/settings-store.js`(마이그레이션 제거), `public/subtitle-overlay.js`(렌더·스냅샷 필터), `public/subtitle-dashboard.js`(미리보기 필터, 폼 읽기/쓰기), `public/subtitle.html`(라디오), `public/subtitle-i18n.js`(ko/en/ja 문구).

## 테스트(먼저 작성)
- `test/subtitle-overlay-lanes.test.js`: `translation_only`에서 `isSourceCaption` 라인은 레인을 만들지도 표시하지도 않고, 번역 라인은 그대로 표시된다; `translation_source`에서는 원문 레인이 표시된다; `source: "live-call"` 라인은 모드와 무관하게 표시된다.
- `test/settings-store.test.js`(또는 해당 파일): `translation_source`가 로드 후에도 유지된다.
- `test/subtitle-frontend.test.js`: 폼에 `displayMode` 라디오 2개와 i18n 키가 있다.

## 비범위
서버 측 원문 억제, Live Call 뷰어 표시, 레인 위치/스타일.
