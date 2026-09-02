# Soniox stt-rt-v5 적합성 분석: 호스트 실시간 언어 지정과 개선 여부 (2026-09-02)

입력: 사용자 제공 `SONIOX-REALTIME-STT-TRANSLATION-INTEGRATION-GUIDE.md`(2026-08-31) + 오늘 직접 조회한 공식 문서 6쪽(language-hints, language-restrictions, websocket-api, real-time-translation, stt-translation, translation supported-languages). 인용은 원문.

## 1. "호스트가 그때그때 영어/한국어를 지정하면 그에 맞춰 인입" — 가능한가

**세션 도중 설정 변경은 API에 없다.** WebSocket 첫 메시지가 config이고, 이후 제어 메시지는 `finalize`와 `keepalive` 둘뿐이다. 언어를 바꾸려면 **새 WebSocket**을 열어야 한다. 다만 스트림 한도가 300분이고 연결이 가벼워, 게이트웨이가 이미 가진 회전(rotation)·핸드오프 구조로 "지정 즉시 새 소켓을 열고 1~2초 링버퍼를 재전송해 이어붙이는" 방식은 구현 가능하다. 전환 순간 0.5~1초 공백과 경계 문장의 중복·누락 가능성은 남는다(가이드 §16 overlap replay와 중복 제거 규칙 적용).

**그러나 수동 지정 없이도 어제 실패 모드를 막을 수 있다.** 핵심 필드는 `language_hints` + `language_hints_strict`다.

- `language_hints`만: "Language hints do not restrict recognition to those languages — they only bias the model toward them." (Gemini Transcribe의 `languageCodes`와 같은 편향)
- `language_hints_strict: true`: "enables language restriction based on the provided hints". **집합 제한이 가능**하다. `["ko","en"]`으로 두면 한국어·영어만 인식 대상이 되어 어제의 zh-Hans/vi 오인식 계열이 차단된다. 문서 경고: "best-effort, not a hard guarantee", 여러 언어를 넣으면 "accuracy can degrade when language identification becomes ambiguous", 단일 언어 제한이 "strongly preferred for production".
- 모델은 집합 안에서 발화·문장 단위로 자동 식별한다: "handles multilingual speech seamlessly, even when multiple languages are mixed within a single sentence or conversation."

따라서 권장 설계는 **언어 모드 3단**이다.

| 모드 | Soniox 설정 | 용도 |
|---|---|---|
| 자동(기본) | `language_hints: ["ko","en"]`, `strict: true` | 한·영 혼용 발표, 방향 자동 전환 |
| 한국어 고정 | `["ko"]`, `strict: true` | 발표자가 한국어만 쓰는 구간, 최고 정확도 |
| 영어 고정 | `["en"]`, `strict: true` | 영어 게스트 구간 |

호스트가 모드를 바꾸면 어댑터가 새 소켓을 열어 교체한다. 이것이 사용자가 말한 "그때그때 지정"의 실제 구현 형태이며, 대부분의 시간은 자동 모드로 두고 고정은 예외 구간에만 쓰는 것이 문서 권고와 맞다.

## 2. 번역: `two_way`가 en↔ko 자동 방향 전환을 한 소켓에서 처리

- `two_way(language_a: ko, language_b: en)`: A 발화 → B 번역, B 발화 → A 번역을 자동으로 수행. 자막 제품의 "입력 언어의 반대 언어를 표시" 계약과 정확히 일치한다. 제3언어 발화 처리는 미문서.
- 번역 토큰은 **부분(non-final)으로 스트리밍**된다: "translation tokens follow, chunk by chunk, without waiting for the full sentence", "translation can begin before the sentence ends". 확정 후 REST 호출을 기다리는 Flash 경로(1~3초)보다 구조적으로 빠르다.
- 원문 토큰에는 `start_ms/end_ms`가 있고 번역 토큰에는 없다. 원문↔번역은 1:1이 아니지만 `<end>` 경계와 `translation_status`/`language`/`source_language`로 **세그먼트 단위** 대응은 가능하다. 어제의 Live Translate(대응 정보 전혀 없음)보다 낫다.
- 다중 대상 배열은 없다. en+ko는 `two_way` 소켓 1개로 끝나지만 ja를 더하면 `one_way ja` 소켓 1개 추가 또는 Flash 텍스트 번역이 필요하다.
- ko·en·ja 모두 번역 지원 언어에 있고 "3600+ language pairs"라 명시되나 개별 pair 표는 없다(spike에서 확인).

## 3. 현행·대안 대비 개선 여부

| 항목 | Live Translate 직접(현행 배포) | Transcribe Live + Flash(HEAD) | **Soniox two_way** |
|---|---|---|---|
| 소스 언어 제한 | ✗ | 편향만 | **집합/단일 제한(best-effort)** |
| 한국어 zh/vi 오인식 위험 | 발생 확인 | 낮음(편향) | 차단 설계 가능 |
| 번역 텍스트 도착 | 생성 음성 속도, 발화 후 | 확정 후 REST 1~3s | **발화 중 부분 스트리밍** |
| 원문↔번역 대응 | 없음 | 1:1 | 세그먼트 단위(`<end>` 경계) |
| 소켓 수(en+ko) | 대상당 1 → 2 (로컬 system+mic는 4) | STT 1 + REST | **입력당 1** |
| 세션 한도 | 미문서 | 10분 | **300분** |
| 용어집 | 없음 | customVocabulary 1,000 | context 10k자 + `translation_terms` |
| 원문 타임스탬프 | 없음 | 발화 단위 | **토큰 단위** |
| 가격(분당, en+ko) | ≈ $0.074 | ≈ $0.009 + Flash | **≈ $0.002 + 번역 출력 토큰** |
| 한국어 정확도 | 실측 불량 | 실측 양호(6~8월) | **미검증** |
| 공급자 리스크 | Google, 8/31 가용성 장애 | Google | 소규모 벤더, KR 리전 없음(US/JP), 기본 동시 소켓 10, resume 핸들 없음 |

**결론: 구조적으로는 명확한 개선이다.** 어제 확정한 세 증상(오인식·이상한 흐름·지연)의 원인을 모두 API 계약 수준에서 다룬다. 단 한국어 인식 정확도와 번역 품질이 미검증이므로, 채택 여부는 **실측 후** 결정해야 한다. 가이드가 제안한 순서(Phase 0 spike → shadow → canary)를 그대로 따르되, 첫 spike에서 다음을 재야 한다.

1. 한국어 리허설 음성(합성 + 실제 리허설, 고객 음성 제외)으로 Transcribe Live 대비 WER과 첫 부분 자막 지연.
2. `strict ["ko","en"]` 자동 모드에서 한·영 전환 정확도, 오인식(타 스크립트) 0건 여부.
3. `two_way` 번역의 첫 토큰 지연과 문장 완성 품질, `translation_terms` 반영률.
4. JP 엔드포인트 대 US 엔드포인트 지연.

## 4. 접근안 A와의 결합

공급자 추상화(접근안 A)에서 Soniox는 **1단계부터** 포함할 가치가 있다. 어댑터 하나(`soniox-realtime-adapter.js`)가 STT와 번역 두 역할을 동시에 채우므로, 카탈로그에 "결합 공급자(stt+translation in one stream)" 유형과 `languageMode`(auto/ko/en) capability를 추가한다. 핫스왑 규칙은 동일하다: 설정 저장 → 데스크톱 `restartChannels` / 게이트웨이 `update` → 새 소켓 교체. 언어 모드 전환도 같은 경로를 탄다.

Gemini Transcribe Live + Flash는 폴백 공급자로 유지하고, Flash 텍스트 번역은 (가) 세 번째 언어(ja) 또는 (나) 가이드 §14.2처럼 Soniox 번역을 preview로 두고 확정 번역을 별도로 만들 때 쓴다. 어느 쪽인지는 spike 품질을 보고 정한다.

## Spike result 2026-09-02 (합성 한·영 음성 17 s, US 엔드포인트)

- 연결 520~650 ms(서울→US). JP 엔드포인트는 현재 키로 `unauthenticated`(키가 US 리전 프로젝트) → US 사용.
- `language_hints ["ko","en"] + strict` 자동 모드: 원문 토큰 언어 정확(ko 구간 ko, en 구간 en), 타 스크립트 오인식 0건. `two_way` 번역 확정 토큰이 원문 확정과 거의 동시에 도착(첫 확정 4.79 s / 4.80 s). ko→en, en→ko 모두 정확. TTS가 "ARR"을 발음한 구간은 "어레인기드"로 오인식(Gemini Transcribe는 "recurring revenue"로 인식).
- **경계 신호 실측**: 연속 발화 17 s 동안 `<end>` 0회. 2.0 s 디지털 무음 삽입 시 ~650 ms 뒤 `<end>`. `{"type":"finalize"}` 전송 시 ~300 ms 뒤 `<fin>`. 종료는 **빈 텍스트 프레임**으로 보내야 `<end>` + `finished`가 ~350 ms에 도착하고, 빈 바이너리 프레임은 종료되지 않음(8 s 대기 후 타임아웃).
- 결론: 인식·번역 품질은 채택 가능 수준. 구현 계약 두 가지를 고쳐야 한다. (1) `closePayload`는 빈 텍스트 프레임. (2) 리듀서가 `<end>/<fin>`에서만 확정하므로, 새 토큰 없이 1.2 s가 지나고 미확정 최종 텍스트가 있으면(또는 세그먼트 15 s 초과) 앱이 `finalize`를 보내 `<fin>`으로 확정한다. 이 수정 후 spike를 재실행해 기본 공급자를 결정한다.

## 재실행 2026-09-03 00:58 KST (수정 계약 적용, 커밋 2aca0cc)

- 세 언어 모드 모두 `finished` 정상 수신(빈 텍스트 프레임), 타임아웃 0, 오류 0, 타 스크립트 오인식 0. 확정 1건/레인(17 s 연속 발화 → 종료 시 `<end>`), 첫 부분 자막 p50 669~703 ms, 확정 지연 p50 738~760 ms, 첫 번역 p50 ≈3.5 s. ko→en·en→ko 번역 모두 정확("ARR" 합성 발음만 "Arraigned"으로 오인식 — TTS 고유 결함, Gemini Transcribe 2건 확정·번역 없음).
- `finalize` 전송 0회: 연속 발화 중 토큰이 계속 도착해 1.2 s 유휴가 생기지 않았고, 최초 확정 토큰(≈4.8 s)+15 s 상한이 클립 종료(≈17.6 s) 뒤였다. 스케줄러는 유휴·상한 조건에서만 동작하도록 설계된 대로다. 실제 회의처럼 문장 사이 멈춤이 있으면 `<end>`가 먼저 온다.
- **기본 공급자 판정:** `DEFAULT_ENGINE_SELECTION`은 **Gemini Transcribe + Flash 유지**. 근거: (1) 합성 음성 1클립만으로 실제 마이크 한국어 정확도를 판정할 수 없다(ARR 오인식이 그 예). (2) Soniox 번역은 정확히 2개 언어 세션에만 적용되고, 3개 언어 세션은 Gemini 번역이 필요하다. (3) 배포된 게이트웨이에는 Plan 2 전까지 Soniox 레인이 없어 기본값을 바꾸면 데스크톱과 Live Call의 기본이 갈라진다. Soniox는 설정의 엔진 선택에서 "결합 공급자(권장: 한·영 2개 언어)"로 노출하고, 사용자가 실제 리허설 음성으로 확인한 뒤 기본값 전환을 다시 결정한다(한 줄 변경: `packages/caption-core/caption-engine-catalog.js`의 `DEFAULT_ENGINE_SELECTION`).
