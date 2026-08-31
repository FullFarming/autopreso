# Live Translate 3.5 전환과 자막 지연 개선 설계

날짜: 2026-08-31 (한국시간)

상태: **검토안. 런타임·설정·DB·배포 변경 없음.** 사용자의 속도·비용·용어집 우선순위 답변 및 아래 프로토콜 검증을 기다린다. 이 문서는 구현 승인이나 운영 전환의 증거가 아니다.

범위: Live Call 게이트웨이의 원문·번역을 `gemini-3.5-live-translate-preview`로 처리하고, 라이브 문단 요약과 종료 요약에만 `gemini-3.7-flash`를 쓰는 전환. 기존 독립 로컬 자막 엔진과 화이트보드 엔진 전환은 포함하지 않는다.

선행 계약: [참여자 화면·수요 런타임](2026-08-31-participant-demand-live-viewer-design.md), [원문·요약 및 내보내기](2026-08-31-recap-consent-host-records-export-design.md). 참여자 0명 구간의 기록 공백, 회의 종료 후 6시간 조회, 새로고침 복구, 권한·발언권은 유지한다.

후속 요구 반영: [표시 언어 고정·다국어 원문 설계](2026-08-31-fixed-target-language-routing-design.md)가 탭 동등성·표시 모드·동일 언어 echo 정책을 보완한다. 새 요구에서는 `echoTargetLanguage: true`를 우선 검증하며, 아래 `false + 원문 passthrough`는 혼합 구간 대응을 증명할 때만 가능한 대안이다. 원문·번역 연결과 비용의 전환 게이트는 그대로 유지한다.

## 1. 결정하려는 문제

현재 경로는 원문 확정 → 원문 저장 → 3.7 텍스트 번역 → 번역 저장이다. 목표는 발언 중 번역을 회색으로 이어 쓰고, **실제로 확정되어 저장된 번역만** 흰색으로 바꾸는 것이다. 번역문을 문단 요약으로 교체하지 않는다.

현재 구현에 없는 전역 병목을 제거한다는 이유로 큐를 재작성하지 않는다. `RollingSpeechSession.#handleFinalUtterance()`는 작업을 추적하면서 즉시 반환하며, 언어별 최종 번역 큐는 이미 독립적이다. 동일한 운영 연결 구조의 오프라인 지연 실험에서 일본어 번역을 멈춰도 원문 2개 저장과 영어 최종 자막 2개 발행이 진행됐다. 이는 외부 모델 지연이나 운영 성능 수치의 증거는 아니다.

현재 대상 언어의 중간 번역을 건너뛰는 비용 정책과 최종 텍스트 번역 호출이 주요 차이다. 3.5 전환은 호출 순서를 조금 줄이는 수정이 아니라 **지속 오디오 번역과 원문 연결 계약의 변경**이다.

## 2. 공식 근거와 미확정 사항

| 항목 | 확인 결과 | 구현 결정 |
|---|---|---|
| 처리 방식 | 연속 음성 번역이며 시스템 지시·도구를 지원하지 않음 | 문장이 끝날 때까지 입력을 묶어 보내지 않음; 용어집 프롬프트 주입 금지 |
| SDK 설정 | `AUDIO` 응답과 input/output transcription, 단일 target language 설정 | SDK 경로를 사용; 원문을 얻기 위한 별도 전사 세션 추가 금지 |
| 입력 | 16kHz mono PCM16, 권장 100ms 청크 | 기존 40ms 프레임을 경계·잔여 바이트를 보존하여 100ms로 묶음 |
| 출력 | 번역 음성과 전사 텍스트 | 서버에서 오디오를 소비·폐기하고 클라이언트에는 자막만 전달 |

위 설정과 제한은 [Live Translate 가이드](https://ai.google.dev/gemini-api/docs/live-api/live-translate)를 따른다. 모델 설명은 오디오·텍스트 출력을 표시하지만, TEXT-only 세션으로 동일 번역을 제공하거나 오디오 과금을 피할 수 있다는 근거는 없다. [모델 문서](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-live-translate-preview)

SDK `Transcription.finished`는 선택 필드이고 전사 종료를 나타낸다. Live Translate가 모든 구간에서 이를 보낸다는 보장은 확인하지 못했다. 선택 필드인 `words`와 화자 정보 역시 실제 모델에서 제공된다고 가정하지 않는다. [SDK Transcription](https://googleapis.github.io/js-genai/release_docs/interfaces/types.Transcription.html)

일반 API에서 input transcription은 다른 메시지와 순서가 보장되지 않는다. output transcription과 종료 신호의 일반 규칙도 input/output의 동일 문장 대응을 보장하지 않는다. 지속 번역 모델의 실제 신호 발생 여부를 별도로 확인해야 한다. [Live API 응답 참조](https://ai.google.dev/api/live#bidigeneratecontentservercontent)

다음은 **미확정**이다: 청크가 누적 스냅샷인지 증분인지, 원문·번역 구간 간 대응, 매 구간 종료 신호 발생, 지원되는 세션 수명·재개·rollover 방식. 예제의 마지막 대기는 완전한 drain 보장이 아니다. [공식 예제](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_LiveTranslate.py)

발표의 수초 지연 표현은 제품의 p95 보장이 아니다. 측정 전에 “즉시 번역”이나 고정 지연 수치를 약속하지 않는다. [Google 발표](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-live-3-5-translate/)

## 3. 공유 세션과 모델 책임

```text
인증·발언권을 통과한 단일 PCM 소스
  └─ session 설정 언어 1~3개에 동일 프레임 공유
      ├─ 3.5 번역 lane A ─ input: 유일한 원문 권위 / output: 번역 A
      ├─ 3.5 번역 lane B ─ input: 연결 검증용 / output: 번역 B
      └─ 3.5 번역 lane C ─ input: 연결 검증용 / output: 번역 C
          ↓ 검증된 종료 + 원문 연결 + 저장 성공
      언어별 자막 발행 → 모든 해당 참여자와 gateway 사용 HOST

권위 원문 저장 → 문단 묶음 → 3.7 문단 요약 / 실제 회의 종료 → 3.7 종료 요약
```

- `active languages`의 초기 정의는 **서버가 세션에 설정한 언어 집합**이다. 실제 인증된 참여자가 한 명 이상 있을 때 설정 언어의 세션을 공유한다. 참여자별 생성이나 별도 원문 전용 세션은 없다.
- 한 언어를 시청하는 사람이 0명이 됐다는 이유로 해당 언어만 닫는 최적화는 제외한다. 그렇지 않으면 원문 leader 유지 비용과 언어별 기록 공백을 따로 설계해야 한다. 위 정의의 비용은 시청자가 고른 언어 수가 아닌 설정된 언어 수에 비례한다.
- leader는 runtime epoch 시작 시 설정 언어의 정해진 순서로 고정한다. 가장 먼저 응답한 세션을 leader로 바꾸지 않는다. 다른 lane의 input은 원문·주제·요약 저장을 호출하지 않는다.
- 번역 또는 문장 다듬기 목적으로 3.7을 호출하지 않는다. 정확한 별칭 치환 등 결정적 용어 보정만 허용하며, 보정 전 텍스트와 보정 결과를 구분한다. 이는 지시문 기반 용어 정확도를 대체한다는 보장이 아니다.
- 기존 업로드 자료의 `glossaryExtraction`도 3.7을 사용한다. “3.7은 요약에만”을 제품 전체에 적용하려면 이 별도 작업까지 변경할지 범위를 확정해야 한다. 이번 Live Call 경로에서 이를 몰래 추가 호출하지 않는다.
- `echoTargetLanguage: false`일 때 같은 언어 입력의 출력 부재는 실패로 간주하지 않는다. 해당 언어의 원문 표시는 권위 원문을 사용한다. 언어 감지나 input 언어 정보를 확인할 수 없으면 동일 언어라고 추측하여 성공 처리하지 않는다.

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

## 6. 화자·수요·종료·재연결

발언권을 통과한 PCM만 모든 lane에 동일하게 보낸다. 캡처 전에 floor revision과 화자 소유권을 부착하며 출력 도착 시점의 현재 floor로 덮어쓰지 않는다. 40ms→100ms 프레임 결합도 floor revision과 provider generation 경계를 넘지 않으며 잔여 PCM을 다음 화자에게 붙이지 않는다. 발언권 교체에 걸친 구간을 정확히 분리할 수 없으면 잘못된 화자에게 저장하지 않고 불완전 처리한다.

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

drain 동안에는 기존 owner/epoch 저장 fence를 유지한다. 소켓 close가 끝났어도 source tail, 각 lane 최종 작업, publisher 저장이 끝나기 전 “완료”로 보고하지 않는다. 전체 제한 시간 후에는 남은 작업을 abort하고 갭/불완전 상태로 기록한다. 실제 종료로 DB owner가 이미 해제된 경우 late write 실패를 정상 자막 재발행으로 우회하지 않는다.

프로세스 종료는 별도 상위 제한이 있다. 현재 `gateway-shutdown.js`는 8초 후 종료하므로 내부 10초 drain을 끝까지 기다려 준다고 가정할 수 없다. 전환 구현은 SIGTERM의 남은 시간을 모든 lane과 저장 작업이 공유하게 하고, 상위 제한보다 짧은 drain 예산을 적용해야 한다. 강제 종료 때 마지막 원문·번역을 완전히 보존한다는 보장은 하지 않는다.

Live Translate 전용 세션 수명과 재개 지원이 확인될 때까지 Transcribe의 10분 제한, 570초 교체, context compression, session resumption 설정을 복사하지 않는다. rollover 지원이 확인되면 capture 경계에서 기존 generation 입력을 차단하고 drain한 후 다음 generation을 시작한다. 겹치는 오디오 재전송은 중복 원문 방지와 비용 상한을 별도 증명해야 하며 초기 구현에서는 사용하지 않는다. 공백 없이 무제한 회의가 가능하다고 미리 표시하지 않는다.

현재 HOST mirror는 참가자 번역만 전달하는 조건이다(`live-media-pipeline.js`의 `#publishCaption`). Electron에서 gateway를 유일한 자막 생성기로 선택하는 경로는 HOST 발언도 받아야 한다. producer 계약을 명시하여 gateway 모드에서는 HOST·참가자 모두 전달하고, 독립 로컬 엔진 모드에서는 중복 표시를 막는 회귀 테스트가 필요하다. 이것은 모델 변경만으로 자동 해결되지 않는다.

## 7. 비용과 계측

확인한 가격은 입력 오디오 100만 토큰당 $3.50, 출력 오디오 100만 토큰당 $21이다. 분당 근삿값 $0.0053 입력과 $0.0315 출력을 사용하면, 입력·출력이 각각 60분일 때 1개 언어 약 **$2.21**, 3개 언어 약 **$6.62**다. 실제 출력 길이·침묵과 사용량에 따라 달라진다. [가격표](https://ai.google.dev/gemini-api/docs/pricing)

이 예시는 Cloud Run, DB, 3.7 요약, 재연결·겹침 비용을 제외한다. 번역 오디오를 재생하지 않아도 생성 비용이 없어지는 것은 아니다. 한 언어당 연결 시간·입력초·출력초·usage metadata를 기록하고 알 수 없는 값은 0원으로 표시하지 않는다.

기존 HTTP 텍스트 RPM 제한만으로 지속 Live 세션 비용을 제한할 수 없다. 활성 lane 최대 3, 세션 동시 연결 상한, 무입력·종료 대기 한도, 회의별 오디오 시간/비용 상한과 수요 0 drain을 함께 적용한다. 예산 초과는 명시적 중단이며 3.7 번역으로 자동 전환하지 않는다.

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
| 0 / 공식자료·CTO | 합성 오디오 관측, 이 문서의 미확정 항목 | 종료·누적·대응·수명 지원 범위 기록. 유료 호출은 별도 승인 범위에서만 실행 |
| 1 / Adapter | 새 `media-gateway/src/gemini-live-translate-adapter.js`와 해당 test | SDK 설정, 양방향 transcript parser, bounded pending/drain, audio 폐기. 이전 대형 adapter 전체 복구 금지 |
| 2 / Schema·Publisher | additive migration, `supabase-adapters.js`, DTO | 필요 시 검증된 다대다 source links와 fenced atomic final 저장; 관계 미상 통과 금지 |
| 3 / Pipeline | `live-media-pipeline.js`, 필요 시 새 stream coordinator와 tests | 단일 leader 원문, 독립 lane, source 저장 순서, final 작업 추적, summary 입력 한 번 |
| 4 / Runtime 계약 | `packages/caption-core/gemini-caption-contract.js`, `server.js`, workload tests | 명시적 모델 profile, 번역·polish 3.7 호출 0, 세션 설정 fingerprint 및 모델 metadata 일치 |
| 5 / UI·HOST | `LiveViewer.tsx`, 자막 DTO, 웹 HOST, Electron와 `public/` renderer | 회색→흰색 동일 행, 중립 화자, gateway HOST mirror, 로컬 엔진 중복 없음 |
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

## 10. 적대적 검증 계획과 전환 게이트

| 시나리오 | 기대 결과 |
|---|---|
| target가 source보다 먼저 또는 source DB가 느림 | 회색 유지; 올바른 연결·저장 전 흰색·영구 번역 없음 |
| 누적/증분, 반복 단어, split Unicode, 빈 text + finished | 검증된 parser 규칙대로 완성; 실제 반복 보존 |
| input 2개 : output 1개, input/output 경계 서로 다름 | 검증된 출처 목록 또는 명시적 실패; FIFO 가짜 연결 없음 |
| 3개 lane input이 각각 원문을 보냄 | 권위 원문과 요약 입력은 각각 한 번만 |
| 한 lane이 느리거나 영원히 종료 신호를 안 보냄 | 다른 lane 진행; pending 상한·deadline 도달 후 명시적 실패 |
| DB 원문 저장 응답 유실 | 중복 원문 재시도 없음, 번역 최종 승격 없음, 유료 세션 종료 |
| source leader 종료와 participant floor 교체 동시 발생 | 새 화자에 이전 발언 저장 없음; 검증 불가 구간 공백 표시 |
| drain 중 새 viewer 접속, owner 교체 후 late final | 기존 runtime 상태 전이를 따르고 old epoch 저장·발행 거부 |
| 0명 시작·1명 입장·마지막 퇴장·새로고침 | 0명 유료 세션 없음, 최초 입장 준비, 30초 후 drain, 원문/seq 복구 |
| pause/stop/lease 만료 때 final 미도착 | bounded 종료, 숨은 reconnect·무한 유료 연결 없음 |
| gateway 단독 producer의 HOST/참가자 발언 | 웹/Electron HOST에 모두 자막, 로컬 엔진 모드 중복 없음 |
| 종료 후 6시간 재접속 | 저장된 원문·요약·공백 유지, 브라우저 새로고침이 기한 연장하지 않음 |

운영 전환 조건은 (1) 속도·비용·용어집 우선순위 확정, (2) 위 프로토콜 미확정 항목 해결 또는 정확도를 낮추지 않는 지원 범위 확정, (3) 모델별 테스트와 실제 시연, (4) 예산/관측/rollback 준비다. 한두 합성 문장이 번역됐다는 사실만으로 긴 회의와 다국어 기록이 검증됐다고 보고하지 않는다.

새 profile은 시작 시 불변으로 선택하며 진행 중 세션을 hot switch하지 않는다. 운영 변경 시 기존 세션은 기존 엔진을 유지한다. rollback은 신규 세션의 profile 선택을 이전 엔진으로 돌리고 신규 Translate 세션은 drain한다. 기존 원문·caption source links·6시간 기록을 삭제하지 않는다. 전환 실패를 사용자에게 알리지 않고 이전 모델로 자동 재시도하는 경로는 만들지 않는다.
