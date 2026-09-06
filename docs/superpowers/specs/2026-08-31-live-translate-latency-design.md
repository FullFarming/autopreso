# Live Translate 3.5 직접 en↔ko 자막 전환과 지연 개선 설계

날짜: 2026-08-31 (한국시간)

상태: **GA 구성 참고자료 검토 완료 · 직접 Live Translate 정식 모델 가용성 차단 · 직접 번역안 미배포.** 사용자가 새 [GA 전환 가이드](/Users/kyeongmankim/.aside/u/0/sessions/2026-08-21_BCtssyAqlIbBLnLn/artifacts/NOVA-GEMINI-GA-LIVE-TRANSCRIBE-MIGRATION-GUIDE.md)를 제공했다. 이 자료도 Live Translate 정식 ID를 제시하지 않고 3.5 Transcribe Live + 3.6 텍스트 번역 + 3.7 요약을 권장한다. 자료의 배포·재시도 절차는 실행 지시가 아니라 검토 데이터로 다룬다. 이번 갱신은 문서만 변경하며, 진행 중 자막 세션·설정·DB·운영을 변경하지 않는다. 자료 제공을 Preview 승인 또는 “3.5만으로 직접 양방향 번역 완료”로 해석하지 않는다.

범위: 일반 자막의 영어↔한국어 자동 반대 언어 표시와 Live Call 참여자의 고정 선택 언어 표시를 구분하여, 원문·번역을 Live Translate 3.5가 직접 생성하는 구조를 설계한다. 자막 번역·polish용 텍스트 모델 호출은 없고, 라이브 문단 요약과 종료 요약에는 `gemini-3.7-flash`를 유지한다. 아래 API 계약의 확인 대상은 현재 공개된 `gemini-3.5-live-translate-preview`이며 정식 ID가 확인되기 전 이를 정식 모델로 대입하지 않는다. 일반 자막도 표시 계약에는 포함하지만 독립 로컬 엔진 전환은 구현 승인·소유권 배정 전까지 실행하지 않는다. 화이트보드 엔진은 제외한다.

분기 구분: 위 범위와 §3~10은 **선택되지 않은 직접 번역 대안**의 조건이다. 이번 참고자료의 GA 권고는 §2.1~2.2에서 별도로 검토한다. GA 권고 경로에서는 3.6 텍스트 번역이 필요하므로 직접 번역안의 “텍스트 번역 0” 조건을 현재 GA 코드에 적용하지 않는다. 원문·고정 선택 언어 UI는 두 경로 모두 유지할 제품 계약이며 모델 구성만으로 UI 완료를 판단하지 않는다.

선행 계약: [참여자 화면·수요 런타임](2026-08-31-participant-demand-live-viewer-design.md), [원문·요약 및 내보내기](2026-08-31-recap-consent-host-records-export-design.md). 참여자 0명 구간의 기록 공백, 회의 종료 후 6시간 조회, 새로고침 복구, 권한·발언권은 유지한다.

후속 요구 반영: [표시 언어 고정·다국어 원문 설계](2026-08-31-fixed-target-language-routing-design.md)의 원문/선택 언어 UI, 탭 동등성과 기존 기록 계약을 유지한다. 이번 en↔ko 범위에는 최대 두 개의 고정 대상 lane을 사용하며, 이전 1~3언어 확장안은 이번 활성화 범위에 포함하지 않는다. `echoTargetLanguage: true`를 우선 검증하고 `false + 원문 passthrough`는 혼합 구간 대응을 증명한 뒤 별도로 결정할 대안으로 남긴다. 원문·번역 연결과 비용의 전환 게이트는 그대로 유지한다.

## 0. 모델 가용성: 구현·운영 전환 차단 조건

2026-08-31에 다시 확인한 공식 모델 페이지는 모델 코드와 버전 모두 `gemini-3.5-live-translate-preview`를 명시한다. 8월 26일 GA 공지는 `gemini-3.5-transcribe` / `gemini-3.5-transcribe-live`이며 Live Translate와 다르다. [공식 모델 페이지](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-live-translate-preview), [릴리스 노트](https://ai.google.dev/gemini-api/docs/changelog)

같은 날 CTO의 계정별 Models API 읽기 확인에서도 Live Translate는 Preview만 조회되었고 정식 후보 ID 조회는 404였다. 이는 해당 계정·요청 시점의 관측이지 모든 계정의 미래 가용성을 부정하는 증거가 아니다. 정식 모델 ID·GA 발표·해당 계정 접근이 확인되거나 사용자가 Preview 사용을 명시적으로 선택하기 전에는 모델 선택을 바꾸지 않는다. `-preview`를 임의 제거하거나 별칭/기존 텍스트 모델로 자동 대체하지 않는다. 정식판과 Preview의 차이는 아직 비교할 근거가 없다.

새 자료가 권장하는 GA 구성은 이미 현재 저장소의 모델 행렬과 일치한다. 따라서 “정식 모델로 새로 전환해야 한다”는 작업으로 바로 이어지지 않는다. 권고 구성 유지와 미검증 연속성 개선은 구분하며, Preview의 사용 여부는 여전히 별도 결정이다.

## 1. 결정하려는 문제

이 문서의 최초 비교 대상은 원문 확정 → 원문 저장 → 3.7 텍스트 번역 → 번역 저장이었다. 이후 별도 자막 오류 수정에서는 원문 3.5 Transcribe Live / 번역·polish 3.6 / 요약 3.7로 역할이 분리되었다. 이것은 본 Live Translate 직접 번역안의 배포를 뜻하지 않는다. 목표는 발언 중 번역을 회색으로 이어 쓰고, **실제로 확정되어 저장된 번역만** 흰색으로 바꾸는 것이다. 번역문을 문단 요약으로 교체하지 않는다.

현재 구현에 없는 전역 병목을 제거한다는 이유로 큐를 재작성하지 않는다. `RollingSpeechSession.#handleFinalUtterance()`는 작업을 추적하면서 즉시 반환하며, 언어별 최종 번역 큐는 이미 독립적이다. 동일한 운영 연결 구조의 오프라인 지연 실험에서 일본어 번역을 멈춰도 원문 2개 저장과 영어 최종 자막 2개 발행이 진행됐다. 이는 외부 모델 지연이나 운영 성능 수치의 증거는 아니다.

최초 비교 경로의 중간 번역 생략 정책과 최종 텍스트 번역 호출은 기존 검토의 배경이다. 이후 필수 중간 번역 호출 정책 개선과 별개로, 3.5 전환은 호출 순서를 조금 줄이는 수정이 아니라 **지속 오디오 번역과 원문 연결 계약의 변경**이다.

### 1.1 일반 자막과 참여자 언어 선택의 구분

| 화면/모드 | 영어 발화 | 한국어 발화 | 불변 조건 |
|---|---|---|---|
| 일반 자막의 자동 반대 언어 모드 | 원문 영어 + 한국어 번역 | 원문 한국어 + 영어 번역 | 자동 전환은 표시 경로 선택이며 열린 provider 연결의 대상 언어 변경이 아님 |
| 참여자가 한국어 선택 | 한국어 번역 | 한국어 원문/검증된 동일 언어 출력 | 발화 언어가 바뀌어도 선택은 한국어 유지 |
| 참여자가 영어 선택 | 영어 원문/검증된 동일 언어 출력 | 영어 번역 | 발화 언어가 바뀌어도 선택은 영어 유지 |
| 원문 보기 | 영어 원문 | 한국어 원문 | 번역문으로 원문을 덮어쓰거나 요약으로 교체하지 않음 |

시스템 UI 언어(ko/en/ja)는 이 표의 캡션 언어와 무관하다. 버튼이나 메뉴 언어 변경으로 AI 연결·캡션 대상 언어를 변경하지 않는다. 참여자가 언어를 바꾸면 이미 공유 중인 lane 구독만 바꾸며 개인별 AI 연결을 만들지 않는다.

자동 반대 언어 선택은 검증된 발화 언어와 원문·번역 관계가 있는 구간에만 적용한다. 영어·한국어가 섞였거나 언어 감지가 불명확하면 마지막 언어를 재사용해 확정 번역을 꾸미지 않는다. 원문을 유지하고 번역 미확정 상태를 표시한다. 짧은 “네”, “Yes”와 반복 문장도 임의 삭제하지 않는다. 이번 en/ko 프로필을 기존 다른 언어가 설정된 세션에 몰래 적용하거나 해당 언어를 en/ko로 치환하지 않는다.

## 2. 공식 근거와 미확정 사항

| 항목 | 확인 결과 | 구현 결정 |
|---|---|---|
| 처리 방식 | 연속 음성 번역이며 시스템 지시·도구를 지원하지 않음 | 문장이 끝날 때까지 입력을 묶어 보내지 않음; 용어집 프롬프트 주입 금지 |
| 연결 설정 | `AUDIO` 응답과 input/output transcription, 단일 target language 설정 | 공식 wire 계약에 맞춘 취소 가능한 transport 사용; 원문 전용 전사 세션 추가 금지 |
| 입력 | 16kHz mono PCM16, 권장 100ms 청크 | 기존 40ms 프레임을 경계·잔여 바이트를 보존하여 100ms로 묶음 |
| 출력 | 번역 음성과 전사 텍스트 | 서버에서 오디오를 소비·폐기하고 클라이언트에는 자막만 전달 |

위 설정과 제한은 [Live Translate 가이드](https://ai.google.dev/gemini-api/docs/live-api/live-translate)를 따른다. 모델 설명은 오디오·텍스트 출력을 표시하지만, TEXT-only 세션으로 동일 번역을 제공하거나 오디오 과금을 피할 수 있다는 근거는 없다. [모델 문서](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-live-translate-preview)

SDK `Transcription.finished`는 선택 필드이고 전사 종료를 나타낸다. Live Translate가 모든 구간에서 이를 보낸다는 보장은 확인하지 못했다. 선택 필드인 `words`와 화자 정보 역시 실제 모델에서 제공된다고 가정하지 않는다. [SDK Transcription](https://googleapis.github.io/js-genai/release_docs/interfaces/types.Transcription.html)

최신 일반 API는 input transcription의 메시지 간 순서를 보장하지 않으며 마지막 output transcription은 `generationComplete` 또는 `interrupted`보다 앞서고 이후 `turnComplete`가 온다고 설명한다. 이 규칙은 input/output의 동일 문장 대응을 보장하지 않는다. 지속 번역 모델의 실제 신호 발생 여부를 별도로 확인해야 한다. [Live API 응답 참조](https://ai.google.dev/api/live#bidigeneratecontentservercontent)

`targetLanguageCode`는 한 개이며 `echoTargetLanguage`는 이미 대상 언어인 입력의 음성 생성 여부를 정한다. `true`가 텍스트 무누락·자동 반대 언어 전환을 보장하지 않는다. 단일 연결에서 대상 언어를 동적으로 바꿀 수 없으므로 이번 양방향 설계는 en/ko 고정 연결 두 개를 상한으로 한다. [TranslationConfig](https://googleapis.github.io/js-genai/release_docs/interfaces/types.TranslationConfig.html), [Live API 설정](https://ai.google.dev/api/live)

번역 가이드는 잡음이 모두 무시되지는 않고 빠른 언어 전환에서 감지가 어려우며 echo 사용 시 음성 아티팩트가 생길 수 있다고 명시한다. 번역 전용이라는 설명을 무음 오탐 0건이나 항상 정확한 원문이라는 보장으로 확대하지 않는다. 대화형 에이전트 프롬프트·텍스트 입력·도구·자동 인사·자가 대화 루프를 추가하지 않는다. [제약](https://ai.google.dev/gemini-api/docs/live-api/live-translate#limitations)

다음은 **미확정**이다: 청크가 누적 스냅샷인지 증분인지, 원문·번역 구간 간 대응, 매 구간 종료 신호 발생, 지원되는 세션 수명·재개·rollover 방식. 예제의 마지막 대기는 완전한 drain 보장이 아니다. [공식 예제](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_LiveTranslate.py)

발표의 수초 지연 표현은 제품의 p95 보장이 아니다. 측정 전에 “즉시 번역”이나 고정 지연 수치를 약속하지 않는다. [Google 발표](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-live-3-5-translate/)

### 2.1 새 GA 가이드의 API 계약 대조

| 주장 | 공식 확인 및 현재 코드 |
|---|---|
| GA 원문 3.5 / 번역·polish 3.6 / 주제·요약·용어집 추출 3.7 | 현재 `packages/caption-core/gemini-caption-contract.js:19`의 불변 행렬과 일치. Live Translate 단독 구성과는 다름 |
| `TEXT`, `inputAudioTranscription`, `languageCodes: []`, `VERBATIM` | 공식 설정과 일치. 원시 wire의 `inputAudioTranscription`은 setup 바로 아래이며 Translate 설정 위치와 다름. 현재 `src/gemini-live-transcribe.js:29`와 gateway adapter `:167`도 이 계약 사용 |
| interim과 final 구분 | Transcribe Live 문서는 `interimInputTranscription`을 중간 가설, `inputTranscription`을 확정 전사로 정의. 현재 두 parser가 동일하게 분리하므로 Translate의 미확정 `finished` 조건을 STT에 추가할 이유 없음 |
| 언어 자동 감지·VERBATIM | 빈 언어 목록은 자동 감지, VERBATIM은 반복·간투어를 보존하는 모드. 언어 감지·원문 정확도 100%나 혼합 발화의 자동 반대 번역 보장으로 확대하지 않음 |
| vocabulary 최대 1,000 / 보통 100 이하 권장 | 공식 수치와 일치. 현재 `packages/caption-core/gemini-transcription-vocabulary.js:1`은 API 상한 1,000, 운영 선택 100을 구분하며 로컬 setup도 100개 제한. 무조건 1,000개로 확대하지 않음 |
| Live 최대 10분 / 단어 시간·화자분리 미지원 | Transcribe 모델별 제한과 일치. 비실시간 Transcribe의 word annotations/diarization을 Live 지원으로 가져오면 안 됨 |

설정·전사 필드·자동 감지·모드·용어집 근거: [Live Transcribe 가이드](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe). 수명·단어 시간·화자분리 근거: [모델별 기능표](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe#feature-support-and-limitations). 이는 API 계약과 코드 대조 결과이며 긴 회의·운영 품질 검증 PASS가 아니다.

시간 정보에는 문서 간 세부 공백이 있다. Live 가이드는 **단어 단위 시간 미지원**과 함께 발화 단위 시간을 언급하지만, SDK `Transcription`의 필드에는 명확한 발화 start/end 및 세션 간 기준이 제시되지 않는다. “Live 시간 정보 전부 미지원”이라고 단정하거나 반대로 중복 제거에 쓸 정확한 시각이 있다고 가정하지 않는다. [Live 제한](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe#limitations), [SDK 타입](https://googleapis.github.io/js-genai/release_docs/interfaces/types.Transcription.html)

### 2.2 그대로 적용하면 안 되는 제안과 남은 검증

- **200~500ms replay + 시간/정규화 텍스트 중복 제거:** 가이드의 운영 제안이며 검증된 API 기능이 아니다. 현재 gateway는 입력 오디오 누적량에서 source offset을 만들고 수신 시각으로 `sourceEndedAt`을 만든다(`google-provider-adapters.js:146`, `:338`). 이것을 provider의 정확한 발화 시간으로 사용하면 안 된다. `rolling-speech-session.js:160`은 Transcribe에 overlap 재전송을 하지 않는 분기를 이미 둔다. replay를 도입하면 실제 반복 발화를 삭제하거나 같은 원문을 두 번 저장할 수 있으며 중복 입력 비용도 생긴다. 공급자 시간 필드·기준·부분 발화 범위가 확인되지 않으면 기존 무재전송 경계를 유지한다.
- **미리 연결하고 바로 old socket 닫기:** setup 성공은 이전 final 수신 완료를 뜻하지 않는다. 현재 gateway에는 이전 연결의 제한된 drain이 있고 로컬 경로는 `audioStreamEnd` 뒤 drain 후 교체한다(`src/subtitle-realtime.js:388`). 후속 연결·음성 전송·old final을 독립적으로 관리하고 stop/floor/epoch 경계를 지켜야 한다. 9분 30초/13개 연결은 가이드의 계획 예시이지 공식 무손실 연속 회의 보장이 아니다. 현재 gateway rotation 540초와 adapter 수명 570초도 서로 다른 여유값이다.
- **더 긴 final timeout으로 자동 재시도:** 그대로 채택하지 않는다. 현재 caption 번역 호출부는 deadline과 abort를 갖는 단일 요청이며, 응답이 늦었다는 이유로 이미 과금된 호출을 반복하면 비용·최종 대기열이 늘어난다. timeout 변경은 실측과 예산을 포함한 별도 결정이고 하위 SDK의 재시도 정책도 별도로 확인해야 한다. 실패 시 원문과 명확한 번역 오류를 유지하고 다른 모델·공급자 fallback이나 무제한 retry를 넣지 않는다.
- **partial latest-wins 취소:** 최신 대기 입력을 교체하는 것과 매 interim마다 실행 중 유료 요청을 취소·재생성하는 것은 다르다. 현재 로컬 `preview()`는 대기 입력을 합치며 이전 유료 요청을 매번 abort하지 않는다. final/stop 등 수명 경계에서는 취소한다(`src/subtitle-realtime.js:686`, `:811`). 가이드의 한 줄 권고로 이 비용 보호를 되돌리지 않는다.
- **`return response.text` 예시 직접 이식:** 현재 bound runtime·모델 override 차단·usage 계측·취소·출력 검증을 우회한다. nonstream 응답은 첫 candidate의 `finishReason === "STOP"`과 본문을 검증하는 기존 정책을 유지한다(`packages/gemini-server/policy.js:90`). 잘린 출력이나 thought를 자막 final로 통과시키지 않는다.
- **“최대 200명”, 2시간 연속, 10분 경계 무손실:** 모델 기능이 아니라 NOVA 부하·연속성 수용 기준이다. 이번 문서 검토에서는 paid soak·실제 배포·부하 시험을 하지 않았다. 교체 경계의 짧은/반복 발화, 늦은 final, 취소 중 연결, 권한 회수, 큐 상한, 비용 총량을 검증해야 한다. 가이드의 번역 음성 Preview 병행 옵션 역시 별도 비용과 결정이 필요하며 자동 추가하지 않는다.

판정: **현재 GA 모델 행렬을 유지하는 권고는 타당하다.** 다만 이 조합은 3.5 음성 인식과 3.6 텍스트 번역을 사용하며 “3.5만으로 직접 양방향 번역”의 완료가 아니다. 직접 번역이 계속 필요하면 아래 Preview 대안과 대응·비용 제약을 별도로 결정한다. 이번에는 참고자료 분석과 문서만 갱신하며 재전송·retry·모델·운영 설정을 변경하지 않는다.

## 3. 공유 세션과 모델 책임

```text
인증·발언권을 통과한 단일 PCM 소스
  └─ en↔ko 프로필: 같은 프레임을 최대 두 연결에 공유
      ├─ target ko / echo true ─ input: 유일한 원문 leader / output: 한국어
      └─ target en / echo true ─ input: 연결 검증용 / output: 영어
          ↓ 검증된 종료 + 원문 연결 + 저장 성공
      언어별 자막 발행
          ├─ 일반 자막: 검증된 source 언어의 반대 output 선택
          └─ 참여자: 선택한 고정 언어 유지 / 원문 보기 별도

권위 원문 저장 → 문단 묶음 → 3.7 문단 요약 / 실제 회의 종료 → 3.7 종료 요약
```

- 이번 프로필의 서버 설정 언어 집합은 `{ko, en}`이고 source leader는 `ko`로 고정한다. Live Call은 실제 인증된 참여자가 한 명 이상이고 승인된 source가 준비되었을 때 두 연결을 공유한다. 독립 일반 자막은 사용자 명시적 시작·활성 캡처가 수요 조건이다. 듣는 사람별 연결, 원문 전용 세션, 로컬 엔진과 gateway의 동시 중복 생성은 없다.
- 한 언어를 시청하는 사람이 0명이 됐다는 이유로 해당 언어만 닫는 최적화는 제외한다. 그렇지 않으면 원문 leader 유지 비용과 언어별 기록 공백을 따로 설계해야 한다. 위 정의의 비용은 시청자가 고른 언어 수가 아닌 설정된 언어 수에 비례한다.
- leader는 runtime epoch 시작 시 고정하며 가장 먼저 응답한 세션으로 바꾸지 않는다. 다른 lane의 input은 원문·주제·요약 저장을 호출하지 않는다. source leader 고정은 한국어만 원문으로 받는다는 뜻이 아니다. 실제 다국어 입력 전사 지원과 언어 표시는 별도 검증한다.
- 번역 또는 문장 다듬기 목적으로 3.6·3.7 등 텍스트 모델을 호출하지 않는다. 정확한 별칭 치환 등 결정적 용어 보정만 허용하며, 보정 전 텍스트와 보정 결과를 구분한다. 이는 지시문 기반 용어 정확도를 대체한다는 보장이 아니다.
- 기존 업로드 자료의 `glossaryExtraction`도 3.7을 사용한다. “3.7은 요약에만”을 제품 전체에 적용하려면 이 별도 작업까지 변경할지 범위를 확정해야 한다. 이번 Live Call 경로에서 이를 몰래 추가 호출하지 않는다.
- 초기 검증 설정은 양쪽 모두 `echoTargetLanguage: true`다. 동일 언어 출력도 확인된 전사 종료·저장 규칙을 통과해야 하며, 빈 output을 가짜 성공으로 만들지 않는다. `false + 원문 passthrough`는 과거 비용 대안으로만 보존한다. 채택하려면 같은 언어 음성 억제와 원문 표시를 분리하고 언어 감지·혼합 구간·전사 연속성을 먼저 검증해야 한다.

## 4. 원문·번역 연결: 운영 전환의 필수 조건

### 4.1 별도의 식별자

| 식별자 | 용도 | 금지 사항 |
|---|---|---|
| runtime `epoch`, `ownerId` | DB 저장 권한과 휴면·재개 세대 | provider의 문장 번호로 대체 금지 |
| provider generation, lane ID | 연결 교체 전후 메시지 격리 | 언어별 N번째 결과가 같은 원문이라는 추정 금지 |
| lane segment key | 회색 자막 갱신과 흰색 전환의 UI 동일성 | 마지막 원문 ID를 다음 중간 자막에 재사용 금지 |
| authoritative source ID/seq | 단일 권위 원문과 요약 입력 | 다른 lane 원문을 중복 저장하거나 원문을 소급 수정 금지 |
| caption `seq` | 언어별 최종 저장·복구 순서 | 중간 자막이 번호를 소비하거나 최신 번호를 올리지 않음 |

leader의 확정 원문을 기존 직렬 source tail에서 한 번 저장한다. 실제 provider 원문은 raw, 결정적 보정은 normalized로 분리한다. Live Translate 원문을 기존 전사 모델의 `VERBATIM` 결과라고 표기하지 않는다.

타임스탬프는 `receivedAt`, 캡처 범위, 검증된 provider 시간 중 무엇인지 구분한다. callback 시각을 발화 시작 시각으로 꾸미지 않는다. provider 시간·capture offset의 대응이 확인되지 않으면 정확한 문장 음성 범위는 미상으로 둔다.

### 4.2 순서만으로는 연결할 수 없음

output이 먼저 도착하면 해당 lane의 제한된 pending 버퍼에 두고 input 확정·원문 저장을 기다린다. 이 대기는 **연결 증거가 있을 때만** 성공할 수 있다. 시간이 가까움, 같은 메시지 객체 안에 있음, FIFO 순서, 문자 수, `sourceSequence`가 같음만으로 원문과 번역을 연결하지 않는다.

다른 lane의 input 문장을 leader의 유일한 연속 원문 범위에 정확히 맞출 수 있다면 원문 간 연결 증거로 쓸 수 있다. 그러나 이것만으로 그 lane의 output이 해당 input의 번역이라는 사실까지 입증되지는 않는다. provider의 구간 대응 규칙이 따로 필요하다. 반복 문장·누락·합쳐진 문장은 모호하면 실패 처리한다.

**현재 공식 문서만으로 이 대응 규칙을 확정할 수 없다.** 합성 오디오 실험은 관측된 프로파일을 검증할 수 있지만 문서에 없는 보장을 만들어 내지는 않는다. 예외를 탐지할 방법까지 없으면 정확한 문장 연결을 약속하는 운영 경로로 활성화하지 않는다.

### 4.3 저장 모델의 분기

현재 최종 자막 RPC는 단일 `authoritativeSourceId`를 요구한다. 다국어 번역의 문장 경계가 다를 경우 다음을 구분한다.

| 관측한 대응 | 저장 방식 |
|---|---|
| 검증된 원문 1개 → 번역 1개 또는 여러 개 | 같은 원문 ID와 검증된 범위 정보를 사용 가능 |
| 검증된 원문 여러 개 → 번역 1개 | additive source-links 관계와 원문 목록을 원자적으로 저장해야 함 |
| 대응 미상 | 확정 원문 연결을 만들지 않음; 최종 발행·영구 번역 저장 금지 |

다대다 관계가 필요하면 Schema 담당이 `(sessionId, language, captionSeq, sourceId, ordinal)` 관계, 같은 세션 FK 검증, owner/epoch를 잠근 저장 RPC, 내보내기·조회 DTO를 함께 추가한다. 기존 단일 ID에 첫 원문만 넣어 전체 출처인 것처럼 표시하지 않는다. 관계 테이블을 추가하는 것만으로 미상인 대응 문제가 해결되지는 않는다.

API가 문장 단위 대응을 제공하지 않는다면 별도 제품 결정이 필요하다. 번역에 “이 구간의 번역 스트림”이라는 명시적 범위 출처를 쓰도록 기록 계약을 바꾸거나, 기존 전사→텍스트 번역 경로를 유지한다. 이는 자동 fallback이 아니며 사용자 판단 없이 정확한 문장 연결을 범위 추정으로 낮추지 않는다.

## 5. 회색 중간 자막과 흰색 최종 자막

1. adapter는 input/output 각각의 청크 순서를 보존한다. 검증된 프로파일에 따라 증분을 누적하거나 스냅샷을 교체한다. 매번 prefix 비교로 방식을 추측하지 않는다. “네, 네” 같은 실제 반복을 지우는 중복 제거도 금지한다.
2. 중간 결과는 안정적인 lane segment key로 회색 행을 갱신한다. 기존 140ms 안정화/500ms 최대 대기는 화면 갱신 제어에만 쓰며, 저장 완료 신호로 쓰지 않는다.
3. 검증된 `finished === true` 또는 해당 구간을 실제 종료하는 검증된 turn 신호에서만 `providerFinal`을 만든다. 마침표, 침묵 1.2초, 입력 stream 종료 요청, `generationComplete` 하나만으로 문장 확정을 추측하지 않는다. interrupted 결과는 정상 확정으로 승격하지 않는다.
4. `providerFinal` 이후 원문 연결·원문 저장·번역 저장을 통과해야 `isFinal: true`가 된다. 기존 publisher의 임시 발행은 회색이며 저장 성공 이후 동일 행만 흰색이 된다.
5. 출처 대기 중 speaker가 검증되지 않았으면 이전 발언자의 이름을 붙이지 않는다. 새 중간 행을 표시하려면 현재 speaker 필수 DTO를 중립 상태를 허용하도록 함께 변경한다.
6. 종료 신호가 끝내 오지 않거나 대응이 불명확하면 중간 자막을 정리하고 `번역을 완료하지 못했어요` 상태와 불완전 구간을 남긴다. timeout을 성공 조건으로 쓰지 않는다.

초기 버퍼 상한 제안은 lane당 미완료 64구간, 구간당 16,000문자다. 첫 text 이후 종료 신호 대기는 최대 20초, 확정 output의 원문 연결 대기는 5초, 전체 graceful drain은 현재 10초 한도 안에서 제안한다. 이는 API 규정이나 측정된 성능이 아닌 조정 가능한 안전 상한이다. 긴 연속 발언이 20초 안에 확정 신호를 주지 않는다면 이 초안은 해당 발언을 지원하지 못하므로 실험 결과에 맞춰 상한 또는 지원 범위를 다시 결정해야 한다. 경과 시간과 메모리 양을 모두 제한하고 overflow는 명시적 실패로 전달한다.

원문 저장・최종 발행을 Promise 체인에 무한히 쌓는 것도 상한 위반이다. input/output parser뿐 아니라 source tail·DB 대기·최종 발행 작업의 개수와 바이트를 함께 제한한다. 상한을 넘기면 신규 PCM을 중단하고 보존하지 못한 구간을 명확히 남긴다. 이미 받은 원문을 몰래 버리거나 유실 구간을 문단 요약으로 채우지 않는다.

## 6. 화자·수요·종료·재연결

발언권을 통과한 PCM만 모든 lane에 동일하게 보낸다. 캡처 전에 floor revision과 화자 소유권을 부착하며 출력 도착 시점의 현재 floor로 덮어쓰지 않는다. 40ms→100ms 프레임 결합도 floor revision과 provider generation 경계를 넘지 않으며 잔여 PCM을 다음 화자에게 붙이지 않는다. 발언권 교체에 걸친 구간을 정확히 분리할 수 없으면 잘못된 화자에게 저장하지 않고 불완전 처리한다.

provider가 캡처 경계를 되돌려 주지 않으면 같은 연결에 새 화자의 PCM을 넣으면서 이전 output의 화자를 추측할 수 없다. 초기 안전 경계는 이전 입력 차단 → 제한된 drain → 두 연결 종료 확인 → 새 generation/화자 연결이다. 이 과정의 공백은 숨기지 않는다. 독립적인 원문·번역 대응 증거를 확보하기 전 연결 유지 최적화로 이 경계를 없애지 않는다.

| 전이 | 필수 동작 |
|---|---|
| 참여자 0 → 1 | 인증된 실제 viewer 연결, local HOST source-ready lease, runtime claim과 DB seq 복원을 통과한 뒤 provider 시작 |
| 설정 언어 준비 일부 실패 | 모두 준비됐다고 ready ACK 하지 않음; 제한 시간 내 정리하고 사용자가 재시도할 수 있는 실패 표시 |
| 마지막 참여자 퇴장 | 기존 30초 유예 후 신규 PCM 차단 → provider drain → 모든 provider와 HOST/viewer WS 닫기; 실제 회의 종료 금지 |
| 수요 복귀 | 새 runtime epoch 및 owner 검증, DB seq 복원 후 새 provider generation; prewarm·health ping 재도입 금지 |
| 사용자가 pause | 새 PCM·새 추론 차단, 확정 가능한 것만 drain; 원문 공백 표시, 회의를 ended로 만들지 않음 |
| 실제 stop/end | 새 캡처 차단, bounded drain 후 종료 처리; 남은 미완성 구간을 정상 원문으로 저장하지 않음 |
| lease 만료·권한 회수 | 신규 작업 즉시 거절, 이전 generation의 callback과 저장 차단, 유료 연결 종료 |
| source 저장 결과 불명 | 동일 원문을 재시도하여 중복 생성하지 않음; pipeline을 실패 상태로 정리 |
| leader 실패 | 다른 input을 임의 승격하지 않음; 전체 source 권위를 일시 정지하고 명시적 재시작에서 새 epoch 구성 |
| 일반 자막 시작·종료 | 사용자 명시적 시작에서만 두 lane 생성; pause/stop/앱 종료가 새 PCM·추론·연결을 차단하며 숨은 자동 재접속 없음 |
| 시작 중 취소·한 lane 연결 시간 초과 | setup deadline에서 실제 transport 취소, 늦게 열린 연결도 닫음; 나머지 lane을 고아 유료 연결로 남기지 않음 |
| 오류 후 사용자가 다시 시작 | 새 인증·현재 session version·runtime/floor generation 검증; 실패 fence를 자동 start나 타이머로 해제하지 않음 |

drain 동안에는 기존 owner/epoch 저장 fence를 유지한다. 소켓 close가 끝났어도 source tail, 각 lane 최종 작업, publisher 저장이 끝나기 전 “완료”로 보고하지 않는다. 전체 제한 시간 후에는 남은 작업을 abort하고 갭/불완전 상태로 기록한다. 실제 종료로 DB owner가 이미 해제된 경우 late write 실패를 정상 자막 재발행으로 우회하지 않는다.

프로세스 종료는 별도 상위 제한이 있다. 현재 `gateway-shutdown.js`는 8초 후 종료하므로 내부 10초 drain을 끝까지 기다려 준다고 가정할 수 없다. 전환 구현은 SIGTERM의 남은 시간을 모든 lane과 저장 작업이 공유하게 하고, 상위 제한보다 짧은 drain 예산을 적용해야 한다. 강제 종료 때 마지막 원문·번역을 완전히 보존한다는 보장은 하지 않는다.

일반 Live 문서는 연결 약 10분, 압축 없는 음성 세션 15분을 설명하지만 Live Translate 프로필에서의 수명·압축·재개 지원이 모두 확인된 것은 아니다. Transcribe의 570초 교체나 대화형 모델의 재개 설정을 그대로 복사하지 않는다. [세션 관리](https://ai.google.dev/gemini-api/docs/live-api/session-management)

rollover 지원이 확인되면 capture 경계에서 기존 generation 입력을 차단하고 drain한 후 다음 generation을 시작한다. 겹치는 오디오 재전송은 중복 원문 방지와 비용 상한을 별도 증명해야 하며 초기 구현에서는 사용하지 않는다. 공백 없이 무제한 회의가 가능하다고 미리 표시하지 않는다. 자동 VAD를 사용할 때 `audioStreamEnd`는 입력 종료 통지이며 output drain 완료 ACK가 아니다. 무음 입력만 지속하며 생기는 출력도 정상 발화로 가정하지 않는다. [입력 종료 계약](https://ai.google.dev/api/live#bidigeneratecontentrealtimeinput)

최초 조사에서 HOST mirror는 참가자 번역만 전달하는 조건이었다(`live-media-pipeline.js`의 `#publishCaption`). 이후 변경을 보존하면서 Electron에서 gateway를 유일한 자막 생성기로 선택하는 경로가 HOST 발언도 받는지 확인해야 한다. producer 계약을 명시하여 gateway 모드에서는 HOST·참가자 모두 전달하고, 독립 로컬 엔진 모드에서는 중복 표시를 막는 회귀 테스트가 필요하다. 이것은 모델 변경만으로 자동 해결되지 않는다.

## 7. 비용과 계측

확인한 Preview 가격은 입력 오디오 100만 토큰당 $3.50, 출력 오디오 100만 토큰당 $21이다. 분당 근삿값 $0.0053 입력과 $0.0315 출력을 사용하면 입력·출력이 각각 60분인 1개 lane은 약 **$2.21**, en/ko 두 lane은 약 **$4.42**다. 이전 3언어안의 약 $6.62는 이번 두 lane 범위의 예산이 아니다. 실제 출력 길이·침묵과 사용량에 따라 달라지며, 미확인 정식판 가격으로 간주하지 않는다. [가격표](https://ai.google.dev/gemini-api/docs/pricing)

이 예시는 Cloud Run, DB, 3.7 요약, 재연결·겹침 비용을 제외한다. 두 연결에는 같은 입력이 각각 과금된다. 이번 설계는 공식 예시의 `AUDIO` 모드를 필수로 사용하므로 화면이 자막 전용이어도 생성 오디오 비용을 예산에 포함한다. 서버는 오디오를 제한된 메모리에서 소비·폐기하며 재생·녹음·다운로드로 노출하지 않는다. 한 언어당 연결 시간·입력초·출력초·usage metadata를 기록하고 알 수 없는 값은 0원으로 표시하지 않는다.

기존 HTTP 텍스트 RPM 제한만으로 지속 Live 세션 비용을 제한할 수 없다. 활성 유료 lane 최대 2, 원문 별도 연결 0, 참여자별 연결 0을 강제한다. 교체 연결도 이전 물리 연결 종료 확인 뒤 시작하여 순간적으로 상한을 넘지 않는다. 연결 setup deadline·송신/수신 큐 바이트 상한·무입력 및 drain 한도·세션별 오디오 시간/비용 상한과 수요 0 drain을 함께 적용한다. 예산 초과나 번역 실패는 명시적 중단이며 3.6/3.7 텍스트 번역, 다른 공급자 또는 Preview/정식 별칭으로 자동 전환하지 않는다.

| 측정값 | 목적 |
|---|---|
| 캡처 입력 → 첫 input/output 관측 | provider 구간의 지연을 분리; 지원되는 시간 기준만 사용 |
| 첫 output → provider final | 실제 지속 번역과 완료 대기 구분 |
| provider final → source 연결 → DB durable → viewer paint | 상관관계·저장·UI 지연을 분리 |
| pending 수/바이트/최고 대기, 종료 신호 누락 | 누수와 영원히 회색인 자막 탐지 |
| 중복 source ID, old epoch 거절, 미상 출처 비율 | 기록 신뢰성과 세대 격리 검증 |
| 활성 lane·오디오초·estimated/actual 비용 | 시청자 수만큼 비용이 늘어나지 않는지 확인 |

운영 로그에 원문, 음성, 참여자 이름, access token을 쓰지 않는다. 프로토콜 실험은 익명 합성 문장만 사용하고 저장 fixture는 비밀정보를 제거한다. source callback부터 재는 기존 지연 지표를 전체 음성 지연이라고 보고하지 않는다.

## 8. 파일별 구현 순서와 소유권 제안

| 순서 / 담당 | 변경 경계 | 완료 조건 |
|---|---|---|
| 0 / 공식자료·CTO | 정식 모델 ID/접근, 합성 오디오 관측, 이 문서의 미확정 항목 | §0 차단 해소 후 종료·누적·대응·수명 지원 범위 기록. 유료 호출은 명시 승인된 총량 안에서만 실행 |
| 1 / Adapter | `media-gateway/src/gemini-live-translate-adapter.js`와 해당 test | 기존 초안 존재 여부부터 확인; 공식 설정, input/output parser, bounded pending/drain, 실제 연결 취소, audio 폐기. 이전 대형 adapter 전체 복구 금지 |
| 2 / Schema·Publisher | additive migration, `supabase-adapters.js`, DTO | 필요 시 검증된 다대다 source links와 fenced atomic final 저장; 관계 미상 통과 금지 |
| 3 / Pipeline | `live-media-pipeline.js`, 필요 시 새 stream coordinator와 tests | 단일 leader 원문, 독립 lane, source 저장 순서, final 작업 추적, summary 입력 한 번 |
| 4 / Runtime 계약 | `packages/caption-core/gemini-caption-contract.js`, `server.js`, workload tests | 확인된 정확한 모델 profile, 번역·polish 텍스트 호출 0, 두 lane 상한, 세션 설정 fingerprint 및 모델 metadata 일치 |
| 5 / UI·HOST | `LiveViewer.tsx`, 자막 DTO, 웹 HOST, Electron와 `public/` renderer | §1.1 일반 자동 반대 언어/참여자 고정 언어 구분, 원문 유지, 회색→흰색 동일 행, 중립 화자, gateway HOST mirror, 로컬 엔진 중복 없음 |
| 6 / CTO 검증 | 세 프로젝트 tests/typecheck, 브라우저·Electron 시연 | 아래 적대적 시나리오와 비용·지연 비교, 운영 전환/rollback 검토 |

의존성이 있는 Schema→Publisher→Pipeline은 순차 통합한다. 파일별 owner를 다시 배정하고 기존 미커밋 작업을 보존한다. 새 모델 전환 플래그와 participant demand 플래그는 다른 목적이다. 모델 작업을 이유로 아직 운영 검증되지 않은 demand 기능까지 함께 활성화하지 않는다.

## 9. 변경이 필요한 기존 테스트 계약

| 파일 | 현재 보호하는 계약 | 전환 시 처리 |
|---|---|---|
| `media-gateway/test/captions-only-live-call.test.js` | 단일 STT, Live AUDIO 없음, source partial만, 최종당 text 번역 | 기존 profile 테스트 유지 + Translate profile 추가. provider 오디오 허용과 사용자 음성 재생 금지를 분리 |
| `media-gateway/test/gemini-only-shared-engine.test.js` | Transcribe 설정, 한 최종 번역당 3.7 호출 | 신규 profile에서는 translation/polish 호출 0, 공유 lane 수 검증 |
| `media-gateway/test/provider-adapters.test.js` | TEXT/VERBATIM, interim/final field, 전사 수명 | Transcribe 테스트를 Translate 이름으로 바꾸지 않음; 별도 wire fixtures 사용 |
| `media-gateway/test/server.test.js` | STT + text translator 주입, workload 모델 | profile별 주입·기록 metadata·readiness 검증 |
| `test/gemini-caption-contract.test.js`, `test/gemini-3-7-workload-contract.test.js` | 고정 모델 행렬과 workload 정책 | 요약과 번역 역할을 구분한 profile 계약; 조용한 model override 금지 유지 |
| `test/subtitle-realtime.test.js` | Live Translate 설정을 Transcribe로 정규화 | 독립 로컬 엔진은 현행 유지; Live Call profile을 이 정규화에 통과시키지 않음 |
| `test/gemini-live-transcribe.test.js`, `test/gemini-transcription-vocabulary.test.js` | 전사 모델의 용어집·VERBATIM | 기존 엔진 보호 유지; Translate의 지원 근거로 사용 금지 |
| `media-gateway/test/authoritative-source-persistence.test.js` | 원문 저장 실패 시 번역 호출 전 차단 | 새 모델은 음성 수신 중 이미 번역하므로 “호출 전”은 불가. 원문 durable 전 최종 저장/흰색 발행 금지를 명시적으로 검증 |
| `supabase/migrations/202608310004_live_media_write_epoch_fences.sql` | 한 원문 UUID + owner/epoch fence | 관계 확장이 필요한 경우 additive fenced RPC로 대체; 기존 fence 완화 금지 |

`media-demand-coordinator`, floor attribution/control, authoritative recovery, participant capability 테스트는 계속 통과해야 한다. 비용 guard를 지워서 새 테스트를 통과시키거나 callback을 추적 없이 detach해서 지연을 감추지 않는다.

위 표의 기존 계약은 최초 조사 시점의 비교 기록이다. 번역·polish 3.6 분리 등 후속 수정은 보존하고 작업 직전 실제 테스트를 다시 읽는다. 모델명을 옛 3.7로 되돌려 맞추거나 미사용 모델 경로만 테스트하여 새 profile의 실제 조합 검증을 대신하지 않는다.

## 10. 적대적 검증 계획과 전환 게이트

| 시나리오 | 기대 결과 |
|---|---|
| 정식 후보 ID 404 / 계정 목록에는 Preview만 있음 | 시작 전 모델 가용성 차단 표시; 별칭 생성·Preview 자동 대입·기존 세션 교체 없음 |
| 영어→한국어→영어, 한 글자 응답과 같은 문장 반복 | 일반 자막은 검증된 구간마다 반대 언어; 참여자 고정 언어는 유지; 원문과 실제 반복 보존 |
| 한 문장 안 영어/한국어 전환·언어 정보 누락 | 언어와 대응이 불명확한 구간을 가짜 확정하지 않음; 원문 유지·번역 미확정 표시 |
| 참여자 1명→100명 / 언어 탭 반복 변경 | 유료 연결 최대 두 개 유지; 개인별 소켓·추가 원문 STT·텍스트 번역 호출 없음 |
| UI 언어 ko/en/ja 변경 | 메뉴만 변경; 캡션 대상·provider 세션·3.7 요약 호출 수에 영향 없음 |
| target가 source보다 먼저 또는 source DB가 느림 | 회색 유지; 올바른 연결·저장 전 흰색·영구 번역 없음 |
| 누적/증분, 반복 단어, split Unicode, 빈 text + finished | 검증된 parser 규칙대로 완성; 실제 반복 보존 |
| input 2개 : output 1개, input/output 경계 서로 다름 | 검증된 출처 목록 또는 명시적 실패; FIFO 가짜 연결 없음 |
| 두 lane input이 각각 원문을 보냄 | ko leader만 권위 원문과 요약 입력을 한 번 저장; en input으로 중복 저장 없음 |
| 한 lane이 느리거나 영원히 종료 신호를 안 보냄 | 검증된 source가 있는 다른 lane의 진행을 불필요하게 막지 않음; leader가 실패하면 §6에 따라 원문 권위 정지. pending 상한·deadline 도달 후 명시적 실패 |
| DB 원문 저장 응답 유실 | 중복 원문 재시도 없음, 번역 최종 승격 없음, 유료 세션 종료 |
| source leader 종료와 participant floor 교체 동시 발생 | 새 화자에 이전 발언 저장 없음; 검증 불가 구간 공백 표시 |
| drain 중 새 viewer 접속, owner 교체 후 late final | 기존 runtime 상태 전이를 따르고 old epoch 저장·발행 거부 |
| 0명 시작·1명 입장·마지막 퇴장·새로고침 | 0명 유료 세션 없음, 최초 입장 준비, 30초 후 drain, 원문/seq 복구 |
| pause/stop/lease 만료 때 final 미도착 | bounded 종료, 숨은 reconnect·무한 유료 연결 없음 |
| 시작 전 무음·장시간 무음·잡음/음악만 입력 | 자동 인사·자가 대화 호출 0; 오탐 전사/출력은 실제 검증 결과로 기록. 음성 근거 없이 정상 원문/요약으로 확정되는 경로가 있으면 전환 차단 |
| 같은 언어 입력 + echo true의 출력 지연·빈 출력 | 입력 원문 보존; 출력 무누락으로 간주하지 않음. 늦은 echo를 다음 발화의 번역으로 붙이지 않음 |
| 짧은 발화 직후 무음, 한 번 말한 뒤 동일 문장 재발화 | 침묵 시간만으로 문장 확정하지 않고 완료 규칙 검증; 반복 발화가 중복 제거로 사라지지 않음 |
| floor 반납/선점 직후 이전 화자의 late input/output | 캡처 시점 floor revision/generation을 검증; 새 화자명·새 원문 ID로 저장하지 않음; 분리 불가 구간은 미완료 표시 |
| floor 교체 drain 중 신규 화자 PCM·잔여 40ms 프레임 | 이전 연결로 신규 PCM 송신 금지; 100ms 결합이 화자 경계를 넘지 않음; 정리 완료 전 교체 연결 생성 금지 |
| stop/owner 교체 후 output.finished·turnComplete 도착 | 오래된 epoch/generation 저장·발행 거부; 새 세션 첫 자막이나 요약 입력으로 재사용 없음 |
| setup 대기 중 취소 / 한 lane만 열린 뒤 다른 lane 시간 초과 | 실제 transport 모두 종료; 늦은 setup 응답에서 새 연결/유료 입력 재개 없음 |
| output 또는 source 저장이 멈춘 채 계속 말함 | 대기 수·바이트·시간 상한 도달 시 명시적으로 중단; unbounded final queue·조용한 원문 drop 없음 |
| gateway 단독 producer의 HOST/참가자 발언 | 웹/Electron HOST에 모두 자막, 로컬 엔진 모드 중복 없음 |
| 종료 후 6시간 재접속 | 저장된 원문·요약·공백 유지, 브라우저 새로고침이 기한 연장하지 않음 |
| 번역 실패·모델 미가용·예산 초과 | 텍스트 번역/다른 모델/공급자 자동 fallback 0; 재시작은 실제 사용자 동작과 현재 권한을 확인 |
| 문단 종료·회의 종료 | 검증된 권위 원문만 3.7 요약 입력; 요약이 캡션을 대체하거나 두 lane이 같은 요약을 중복 요청하지 않음 |

운영 전환 조건은 (1) §0의 정식 모델 가용성 또는 명시적 Preview 선택 해결, (2) 위 프로토콜 미확정 항목 해결 또는 정확도를 낮추지 않는 지원 범위 확정, (3) 일반 자동 반대 언어와 참여자 고정 언어의 모델별 테스트·실제 시연, (4) 두 lane 오디오 비용·용어집 제약·예산/관측/rollback 확인, (5) 사용자 명시적 배포 지시다. 현재는 설계 갱신만 완료하며 이 검증 표는 PASS 보고가 아닌 미실행 수용 기준이다. 한두 합성 문장이 번역됐다는 사실만으로 무음 안정성·긴 회의·반복 발화·양방향 기록이 검증됐다고 보고하지 않는다.

새 profile은 시작 시 불변으로 선택하며 진행 중 세션을 hot switch하지 않는다. 운영 변경 시 기존 세션은 기존 엔진을 유지한다. rollback은 신규 세션의 profile 선택을 이전 엔진으로 돌리고 신규 Translate 세션은 drain한다. 기존 원문·caption source links·6시간 기록을 삭제하지 않는다. 전환 실패를 사용자에게 알리지 않고 이전 모델로 자동 재시도하는 경로는 만들지 않는다.
