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
