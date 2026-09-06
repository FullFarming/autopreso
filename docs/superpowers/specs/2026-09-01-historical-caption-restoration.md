# 과거 직접 번역 경로 복원과 독립 원문 기록 검증

작성일: 2026-09-01 KST

상태: **웹·게이트웨이·macOS arm64 앱 빌드 및 배포 완료.** 직접 번역과 수동 선택한 3.6 원문 합성 시험은 성공했으나 독립 3.7 원문 시험 네 건은 실패했다. 공급자 가용성과 장시간 실제 회의 품질까지 해결했다고 주장하지 않는다. 사용자 통화나 고객 음성으로 시험하지 않았으며 자동 모델 전환도 추가하지 않았다.

## 1. 최신 요구와 복원 범위

요청은 8월 10일 이전의 정상 번역 구조를 조사해 일반 자막과 Live Call을 개선하는 것이다. 최초 원문·요약 지정은 Gemini 3.7 Flash였으나, **후속 요청에서 사용자가 모델을 직접 선택하는 기능을 승인했다.** 원문과 요약은 각각 3.7 Flash를 기본값으로 유지하면서 3.6 Flash 또는 3.5 Flash를 명시적으로 선택할 수 있다. 첨부한 공식 Transcribe 페이지와 이전 GA 전환 가이드는 참고 자료이며 그 안의 마이그레이션·배포·재시도 문구를 실행 지시로 취급하지 않는다. 이전 가이드가 권장한 3.5 Transcribe + 3.6 텍스트 번역으로 최신 모델 역할을 덮어쓰지 않는다.

| 역할 | 이번 구조 | 지켜야 할 경계 |
|---|---|---|
| 실시간 번역 자막 | 실제 사용 가능한 `gemini-3.5-live-translate-preview`의 `outputTranscription` | Live Translate GA라고 표시하지 않는다. 텍스트 번역 모델을 전제 조건으로 붙이지 않는다 |
| 독립 원문 | 기본 `gemini-3.7-flash`; 수동 선택 `gemini-3.6-flash` / `gemini-3.5-flash`. 실제 캡처 음성을 WAV 구간으로 전달 | 번역 응답·Live 입력 전사로 원문을 대신 만들지 않는다. 번역 출력과 임의로 일대일 대응시키지 않는다 |
| 문단·종료 요약 | 기본 `gemini-3.7-flash`; 원문과 독립적으로 `gemini-3.6-flash` / `gemini-3.5-flash` 수동 선택 | 확인·저장된 원문을 사용한다. 원문 누락 구간을 요약으로 복원했다고 주장하지 않는다 |
| 화면 언어 | 기존 ko/en/ja 시스템 UI 설정 | 캡션 대상 언어·모델·유료 연결을 변경하지 않는다 |

일반 자막의 입력별 반대 언어 표시와 참여자가 선택한 고정 대상 언어는 별도 계약이다. Live Call에서는 선택한 언어의 번역을 제공하며, 원문 보기 선택은 독립 음성 전사로 저장된 원문 기록을 읽는다. 종료 후 참여자 기록 접근 기한, 호스트 소유권, 동의 및 내보내기 권한은 이번 복원의 대상이 아니다. 기존 보호를 유지한다.

## 2. 과거 코드에서 복원할 것과 복원하지 않을 것

기준 커밋은 `25707a7` (`2026-07-30T09:50:04+09:00`, `feat: stabilize Gemini live translation`)이다. 해당 `src/gemini-live-translate.js`는 이미 `gemini-3.5-live-translate-preview`를 사용했다. 따라서 과거 품질은 정식 모델이었다는 근거가 아니다.

복원할 핵심은 **음성 → Live Translate 출력 전사 → 자막**의 직접 흐름이다. 후속 전사 확정 → 텍스트 번역 구조에서는 별도 요청의 완료와 실패가 자막 속도에 영향을 주었다. 이번에는 번역을 독립 원문 처리 완료나 원문 DB 저장에 종속시키지 않는다. 이 구조 변경이 모든 지연·품질 문제를 해결한다는 뜻은 아니다.

과거 파일 전체를 되돌리지는 않는다. 오래된 모델 설정·권한·무제한 처리·자동 복구 관행을 함께 복원하면 이후 추가한 비용 및 접근 보호가 사라질 수 있다. 특히 과거 코드의 “v1beta는 첫 음성에서 실패하므로 v1alpha만 가능”이라는 7월 주석은 이번 v1beta 합성 성공과 다르므로 현재 API 계약으로 재사용하지 않는다.

현재 공개 모델 가용성은 다음처럼 구분한다. [Live Translate 모델 문서](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-live-translate-preview), [Live Translate 사용법](https://ai.google.dev/gemini-api/docs/live-api/live-translate), [Transcribe 사용법](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe).

- 정확한 Live Translate ID는 `gemini-3.5-live-translate-preview`다. 부모 작업자의 9월 1일 모델 조회에서 이 ID는 200, `gemini-3.5-live-translate`는 404였다.
- Transcribe GA 발표와 Live Translate는 서로 다른 모델이다. Transcribe 문서의 `TEXT` 전용 전사 설정을 Translate에 적용하지 않는다.
- `gemini-3.7-flash` 모델 조회는 200이며 `generateContent`를 지원한다. 음성 입력을 받는 일반 요청 모델이며 Live Translate의 지속 연결을 대신한다는 뜻은 아니다. [3.7 Flash 모델 문서](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash), [음성 입력 문서](https://ai.google.dev/gemini-api/docs/audio).

### 2.1 수동 모델 선택과 비용 경계

통합 담당자의 공식 문서 재검증에서 `gemini-3.6-flash`와 `gemini-3.5-flash`도 음성·텍스트 입력을 지원하는 선택지로 확인했다. 문서상 지원과 특정 계정·시점의 응답 성공은 구분한다. [3.6 Flash 모델 문서](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash), [3.5 Flash 모델 문서](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash).

공유 허용 목록은 `packages/caption-core/gemini-model-catalog.js`다. 설정 필드는 원문 `geminiTranscribeModel`, 요약 `geminiSummaryModel`이며, `geminiPolishModel`은 기존 필드로 유지하고 새 요약 선택과 혼용하지 않는다. 번역 선택지는 호환되는 Live Translate Preview 하나뿐이다. 알 수 없는 ID·빈 값·충돌하는 별칭은 거부한다. 과거 저장값 `gemini-3.5-transcribe-live`만 기본 원문 모델로 이행하며 유효한 수동 선택을 기본값으로 되돌리지 않는다.

모델 저장 중에는 중복 저장과 시작을 막고, 저장 성공 뒤 화면 값을 확정하는 보호가 추가되었다. 실행 중 모델 변경은 허용하지 않는다. Live Call은 DB의 `event_metadata.modelPreferences`를 권위 설정으로 삼고 native·web 시작 및 재연결의 canonical 설정과 비교한다. 모델은 세션의 `source`·topic·recap 호출에 고정되며 fingerprint에도 포함한다. 누락된 과거 설정만 3.7 기본값을 사용하고 명시적 불일치를 다른 모델로 자동 보정하지 않는다. 실제 저장→시작→재연결 시연 및 전체 회귀의 최종 결과는 §7에 별도로 기록한다.

설정의 연결 확인은 선택된 요약 모델에 대한 **메타데이터 GET**이며 `generateContent`나 Live 연결을 만들지 않는다. 진행 중 요청 차단, 10초 재확인 제한, 8초 요청 기한을 둔다. 확인 성공은 해당 모델 메타데이터 접근 확인이지 음성 전사·번역·요약 생성 성공이나 모든 선택 모델의 가용성 보장이 아니다. 선택 UI를 여는 것과 모델 저장 역시 유료 추론 검증을 자동 실행하지 않는다. 모델을 바꿔도 기존 세션·전체 사용량 한도를 새로 시작하지 않는다.

## 3. 번역 연결과 원문 기록의 독립성

```text
동일한 실제 캡처 PCM
  ├─ 대상 언어별 공유 Live Translate 연결 → 번역 전사 → 번역 자막/저장
  └─ 단일 bounded 원문 recorder → 선택된 원문 모델의 WAV 전사 → 권위 원문 저장 → 선택된 요약 모델
```

원문 작업은 동기 enqueue만 수행하며 번역 전송이 독립 원문 응답을 기다리지 않는다. 번역 연결은 대상 언어별로 공유하고 참여자별 새 연결을 만들지 않는다. 일반 en↔ko는 두 대상 언어로 처리하며, Live Call은 허용된 설정 언어 상한과 수요 정책을 유지한다. 현재 `DirectLiveTranslationSession`의 설정 상한은 세 언어다. 불필요한 대상 언어를 자동 추가하거나 참여자 수만큼 연결을 늘리면 안 된다.

Live Call의 `echoTargetLanguage: true`는 동일 대상 언어 발화도 대상 출력에서 관찰하기 위한 설정이다. 합성 한 사례에서 한국어 대상 연결이 영어의 한국어 번역 뒤 한국어 발화 텍스트를 이어 출력했다. 이것은 모든 언어 전환, 문장 내 혼용, 침묵, 소음에서 누락이 없다는 보장이 아니다. 일반 자막의 반대 언어 표시 정책은 별도로 유지한다.

번역 텍스트에는 언어별 stream generation과 실제 캡처 epoch를 붙인다. source ID, 최근 원문, FIFO 순서, 비슷한 시각으로 번역을 권위 원문에 억지로 연결하지 않는다. Live 출력의 문장부호·안정화 기반 앱 확정과 공급자의 전사 완료 신호는 다른 개념이다. 짧은 합성 출력 관찰만으로 입력과 출력의 일대일 대응이나 공급자 final 보장을 주장하지 않는다.

`AUDIO` 응답 설정은 그대로 필요하다. 생성 음성을 재생하지 않아도 생성된 오디오 비용이 사라지지 않는다. 결과를 제한된 버퍼에서 폐기하며 사용량 미확인은 0원으로 표현하지 않는다. 다른 모델로의 자동 fallback 또는 같은 실패 구간의 자동 재요청은 금지한다.

## 4. 독립 원문 recorder의 실제 계약

공용 구현은 `packages/caption-core/gemini-source-audio.js`, 공급자 호출 어댑터는 `media-gateway/src/gemini-source-transcriber.js`다. 원문 요청은 session-bound `source` workload를 사용한다. 허용 목록에서 선택된 모델을 세션에 고정하며 개별 요청에서 모델·thinking·키를 덮어쓸 수 없다. 원문 기본값은 3.7 Flash이고, 허용된 세 모델 모두 LOW thinking과 요청당 출력 최대 2,048 토큰을 사용한다.

- 16 kHz mono PCM16만 받는다. canonical WAV는 최대 480,044 bytes, 음성 구간 최대 15초다.
- 진행 요청 1개, 대기 구간 최대 2개다. 초과 구간은 `SOURCE_AUDIO_BACKPRESSURE`와 캡처 시간 범위를 보고한다. 이전 음성을 겹쳐 보내거나 replay하지 않는다.
- 조용한 발화를 임의로 제거하지 않기 위해 **digital zero만 무음으로 취급한다**. 1.2초 zero 또는 최대 구간 길이에서 flush하고, 이전 zero의 보관은 최대 200ms다. 이것은 실제 음성 VAD가 아니다. 낮은 잡음이 계속되면 15초마다 원문 요청이 발생할 수 있다.
- floor·입력·capture epoch 변경 시 원래 구간을 분리한다. 화자 정보는 캡처 당시 스냅샷이다. 시각은 캡처 시작 시각과 PCM 길이에서 계산한 구간이며 제공자가 측정한 단어 시각이나 음성 화자 식별 결과가 아니다.
- 15초 공급자 기한을 넘으면 signal을 취소하고 recorder를 중지한다. 취소를 무시하는 제공자 뒤에 새 요청을 겹쳐 보내지 않는다. 진행·대기·활성 구간은 명시적 실패 범위로 남긴다.
- `close()`는 마지막 구간을 flush하고 제한 시간 동안 drain한다. `abort()`는 버퍼를 비우고 늦은 응답을 무시한다. 이미 시작한 DB 작업의 최종 허용 여부는 저장 계층의 epoch·권한 fence가 판정해야 한다.
- 실제 전사 텍스트만 반환한다. 번역, 요약, 원문 추정 fallback은 없다. 무음·잡음에 대해 빈 응답이 오면 원문 성공으로 처리하지 않는다.

runtime은 원문 세션당 분당 최대 30회, 전체 분당 최대 180회 및 기존 전체 budget을 함께 적용한다. “15초 구간”은 연속 소리에 대한 최소 분할 길이가 아니라 최대 길이이므로 분당 4회라는 절대 호출 상한으로 계산하면 안 된다. 짧은 발화와 무음이 반복되면 요청이 더 자주 발생한다.

## 5. 검증 증거와 한계

아래 외부 시험은 모두 부모 작업자가 비용 한도 안에서 합성 음성만 사용한 결과다. 문서 작성자는 추가 유료 요청을 하지 않았다. `/tmp` 파일은 로컬 검증 산출물이므로 영구 보관이나 CI 증거를 대신하지 않는다.

| 증거 | 관찰한 결과 | 이 결과가 보장하지 않는 것 |
|---|---|---|
| `/tmp/nova-historical-live-probe-20260901.json`, v1alpha 영어→한국어 | 입력 4.5초, 번역 텍스트 최초 관찰 약 4.59초, 생성 오디오 336,000 bytes | 최종 저장 성공, 장시간 품질, 고정 지연 SLA. 종료에는 close code 1006 기록이 있음 |
| 같은 파일, v1beta 한국어→영어 | 입력 4.9초, 번역 텍스트 청크 약 4.70초와 5.38초, 생성 오디오 348,000 bytes | 모든 세션에서 v1beta가 안정적이라는 일반 보장 |
| `/tmp/nova-historical-live-echo-probe-20260901.json` | 한국어 대상 연결에서 영어 번역과 이어진 한국어 발화 텍스트 관찰, 생성 오디오 480,000 bytes | 동일 언어 무누락, 문장 내 전환 정확도, N:M source-output 연결 |
| `/tmp/nova-historical-native-composition-probe-20260901.json` | native 직접 번역 조합에서 초기 digital zero 2초 동안 자막 0개, 이후 양방향 번역 partial/committed 출력. 연결 2개, 텍스트 생성 요청 0개, 총 13.132초 | Live 오디오 무료 처리, 실제 마이크·긴 회의·원문 기록 성공. 입력 전사 필드는 권위 3.7 원문이 아님 |
| `/tmp/nova-historical-source-probe-20260901.json` | 합성 음성 1.855초, 9.524초 뒤 `SOURCE_AUDIO_PROVIDER_FAILED`; usage 미확인 | 원문 기능 성공. input/output token 기록 0은 미과금 증거가 아님 |
| `/tmp/nova-historical-source-diagnostic-20260901.json` | 동일 합성 길이, 15.004초에 취소. `AbortError` 관찰, usage 미확인 | 정상 원문 반환. diagnostic 숫자 `20`은 HTTP 상태라고 해석하지 않음 |
| `/tmp/nova-historical-source-extended-20260901.json` | 세 번째 bounded 합성 원문 요청은 2.689초 뒤 `Service Unavailable` 메시지, 실제 HTTP 상태 미확인, usage 미확인 | 원문 성공이나 미과금 |
| `/tmp/nova-historical-source-rest-20260901.json` | 네 번째 요청은 같은 3.7 모델에 직접 REST로 한 번 전송. 11.604초 뒤 **HTTP 503 / UNAVAILABLE**, 공급자 수요 증가 메시지. 응답 텍스트 없음 | 원문 성공. 이 실패는 SDK만의 오류로 설명할 수 없지만 모든 실패 원인을 하나로 단정하지 않음 |
| `/tmp/nova-selected-source-36-20260901.json` | 수동 선택한 `gemini-3.6-flash`에 합성 음성 1.855초를 보내 **7.140초 뒤 원문 성공**. 입력 121 + 출력 6 = **127토큰**, usage 확인 | 3.7 성공, 모든 모델의 안정성, 일정 지연 보장. 자동 fallback이 아니며 실제 사용자 기본 설정을 변경하지 않음 |
| `test/gemini-source-audio.test.js` | 13개 로컬 회귀 통과: zero/quiet PCM, 15초 분할, floor/epoch 경계, 요청 상한, 취소·기한·늦은 결과 차단 | 실제 Google 음성 인식 품질·가용성 |
| `media-gateway/test/gemini-source-transcriber.test.js` | 6개 로컬 회귀 통과: strict runtime 조합, source 모델 고정, 최대 15초 WAV 연결, metadata 비전송, no-retry, 취소 및 잘못된 결과 거부 | 실제 외부 성공 |

새 원문 파일을 포함한 root `npm run typecheck`는 마지막 실행에서 통과했다. 전체 root·gateway·web 테스트와 브라우저 시연은 부모 통합 결과를 따르며 이 문서의 19개 원문 테스트로 대체하지 않는다.

## 6. 검증 한계와 운영 시 확인할 사항

1. **3.7 실제 원문 성공 증거가 없다.** 네 번의 실패를 숨기거나 번역 전사로 대체하지 않는다. 이후 3.6 수동 선택 한 건의 성공은 3.7 실패를 해결한 증거가 아니다. 공급자 가용성 문제를 확인했으며 3.7 반복 유료 시험은 멈췄다. 원문 실패를 보여 주면서 번역을 독립 유지하는지, 기록·요약에서 누락을 사실대로 표시하는지 확인한다.
2. 긴 회의에서 연결 수명, 무음·작은 소음, 여러 화자 전환, late output, 재접속, floor 종료와 저장 fence를 검증한다. 구간별 source와 번역이 의미상 일대일 대응한다고 가정하지 않는다.
3. **API 오류 자동 재시도 0과 모든 자동 연결 교체 0은 다르다.** 현재 native 경로는 API·socket 오류에 `recoveryAllowed: false`로 자동 복구를 막고 사용자 재시작을 요구한다. 한편 정상 연결의 계획된 570초 교체/서버 GoAway 처리와 별도 stall watchdog은 남아 있다. watchdog은 최근 입력 신호가 이어지는데 12초 동안 출력 진전이 없을 때 45초 간격으로 최대 3회 채널을 교체하고 이후 중단한다. 이 동작은 추가 Live 비용을 낳을 수 있고 무누락을 보장하지 않는다. 계획된 교체·stall·API 오류·사용자 중단을 각각 시험하여 종료된 연결이 살아나거나 한도를 우회하지 않는지 확인한다.
4. 시간 초과가 나도 이미 진행한 공급자 처리의 비용이 자동 환불되지는 않는다. 미확인 usage, 최종 원문 실패, 대기 초과 구간을 숨기지 않는다. caption 또는 source 모델을 더 빠른 다른 모델로 자동 바꾸지 않는다.
5. 호스트·참여자 화면에서 원문과 선택 언어, 문단 요약, 종료 후 기록을 각각 확인한다. source 작업 실패가 번역 전체를 멈추거나 이전 화자에게 새 원문을 붙이지 않아야 한다.

호스트 원문 화면은 `recentSpeeches`의 번역 텍스트 fallback을 제거하고 canonical `SourceEvent`와 호스트 권한의 `source-snapshot?audience=host`만 사용한다. history와 WS를 source sequence로 병합하고 초기 source 실패 뒤 history가 성공해도 해당 회의의 누락 알림은 보존한다. 첫 원문 전까지는 수집·대기 상태를 표시하고, 실패 이후에는 누락 상태를 유지해야 한다. 대기 표시를 성공으로 해석하거나 번역 텍스트를 원문 대신 보여 주면 안 된다. 호스트 snapshot용 read-only RPC, 참여자 snapshot 및 대기/실패 화면의 최종 통합·브라우저 검증은 아직 완료로 표시하지 않는다.

`202609010003_live_source_recording_gaps.sql`과 gateway 저장 경로는 **확인된 캡처 구간만** 최대 60초 범위의 `source_recording_failed`로 기록한다. segment ID 멱등성, 회의 상태와 쓰기 epoch/소유자 검증을 적용하며 알 수 없는 이후 전체 통화 범위를 추정하지 않는다. 최종 구현은 미완료 DB 저장 최대 8개, 중복 방지 ID 최대 2,048개와 종료 대기 5초 제한을 적용한다. 시간 제한 회귀는 테스트에서 15ms로 주입했다. 이는 원문 recorder의 진행 1개·대기 2개 제한과 별개의 DB 저장 보호다. 취소 시 이미 진행 중인 원문 저장이 성공할 수도 있으므로 보수적으로 표시한 실패 범위와 저장된 원문이 겹칠 수 있다.

DB 저장 실패·시간 초과에는 `source_gap_persist_failures_total` 지표와 안전한 `SOURCE_GAP_PERSIST_FAILED` 코드만 남고 자동 재시도하지 않는다. **화면의 `source-status: unavailable`은 누락 구간 DB 저장 성공을 뜻하지 않는다.** 저장이 성공한 `recordingGaps`는 새로고침 후 복원할 수 있지만 저장되지 않은 실패 구간은 복원 표시를 보장할 수 없다. 원문 실패 이후 번역은 독립적으로 계속한다. migration 003 적용, 저장/실패/새로고침 및 권한 회귀는 배포 전 통합 확인 대상이다.

이번 문서는 설계와 검증 상태를 남기는 기록이다. 배포 승인·실제 배포·최종 완료 보고를 대체하지 않는다.


## 7. 최종 통합·배포 결과

사용자의 기존 전체 재빌드·배포 지시 범위에서 진행했다. 운영 회의를 시험 목적으로 생성하지 않았다.

| 확인 항목 | 최종 결과 / 증거 |
|---|---|
| 전체 테스트·타입·빌드 | root 1,548 PASS / 7 SKIP / 0 FAIL, gateway 567 PASS, web 812 + 77 PASS. root·web 타입 검사 및 diff 검사 통과. Vercel Node 24 프로덕션 빌드, Electron arm64 DMG, Cloud Build 컨테이너 빌드 성공 |
| 모델 고정·시작 경합 | 실제 WS·REST, 로컬 모델 alias 우회, DB 모델 불일치 거부, 웹·native 재연결 모델 유지 회귀 통과. 모델 교체 간 호출 예산 공유 |
| 원문 누락·새로고침 | 원문 0건 + 알려진 누락 구간, 이후 정상 snapshot, 세션 변경·늦은 응답을 포함한 UI 42개 회귀 통과. DB 무응답 및 번역 종료 실패에도 bounded gap 대기 검증 |
| DB·권한 | PostgreSQL 독립 18개 회귀 통과. migration 001·002·003 적용 완료. 003 RPC는 운영 DB에서도 anon/authenticated 실행 불가, service_role만 실행 가능함을 확인 |
| 웹 | `dpl_84EPqaFsK3sm4fL2ifjCxJ1yJvwZ` READY 및 `https://realtime-noel-web.vercel.app` 승격 확인 |
| 게이트웨이 | `realtime-noel-media-gateway-models-20260901` 100% 트래픽. Cloud Build `a7b8877c-204a-4109-88b5-b348271fff0e`. 환경변수·서비스 계정·자원·동시성·timeout·min 0/max 1 유지 |
| macOS | `/Applications/NOVA.app` 0.2.3 arm64 교체. 소스 117개와 ASAR 일치, codesign 검증 통과. 앱 프로세스·로컬 HTTP 200·설치본 모델 목록 확인 |
| 배포 후 확인 | gateway `/health` 200, 운영 `/m/watch/demo` 200, 미인증 회의 목록·원문 snapshot 401. 웹 첫 경로는 로그인 리다이렉트 307. desktop 접근성 도구는 timeout이므로 OS UI 전체 시연 성공으로 계산하지 않음 |

최종 로그: `/tmp/nova-models-root-frozen.log`, `/tmp/nova-modelpicker-gateway-frozen.log`, `/tmp/nova-models-web-frozen.log`, `/tmp/nova-model-selection-production-smoke.json`. gateway 병렬 실행에서 기존 host-grace 5초 timeout 1회가 있었고 해당 suite 44개 단독 및 전체 직렬 567개 재검증을 통과했다.

적대적 검증은 저장/시작 경합(A1), 다른 호스트·미인증 접근(A2), 기존 origin 경계(A3), AI 제어문자·HTML 및 출력 검증(A4), 고정 Google origin·모델 allowlist(A5), PCM 크기·잘못된 모델·시간 경계(A6), 종료 후 늦은 연결·고아 작업·누락 구간(A7), 모바일/웹 원문·번역 표시 및 설정 재조회(A8)를 포함한다. 변경 경로에서 미해결 P1/P2는 보고되지 않았다. §6의 공급자·장시간 음성 품질 한계는 그대로 남는다.

되돌리기 대상은 웹 `dpl_34Wh6uFCALgxBQBKq34WBXRPd63e`, gateway `realtime-noel-media-gateway-caption-debug-20260831`, 앱 `/Applications/.NOVA-before-model-selection-20260901.app`이다. 추가 SQL은 기존 데이터를 제거하지 않으며 앱 롤백 시 보존한다.

최종 설치 파일: `dist/releases/2026-09-01-model-selection/NOVA-0.2.3-arm64.dmg`.
- DMG SHA256: `8b7c1293fc51d1a11144f8add7395109592bbd89441367bd020170dbd1f55458`
- ASAR SHA256: `5f33b3613abe1bb4d6144cbc2560ca3fdf9c1de3bdc6be09270e97efc8917fc0`
- gateway image digest: `sha256:4fb840903d320b06aeacf5527c8f5a1a8c595d70a0bd4c7cf813dd4fe16db3d0`

Windows·Intel macOS 빌드 및 notarization은 이번 완료 범위에 포함하지 않는다.

## 8. 사용자 실사용 후 발견한 자동 방향·즉시 시작 회귀

사용자가 3.6으로 변경한 뒤 원문 처리가 정상 작동함을 확인했다. 3.7의 앞선 HTTP 503과 구분해 두 앱 회귀를 추가 수정했다. 사용자가 저장한 원문·요약 3.6 선택은 바꾸지 않는다.

### 원인과 최소 수정

- 과거 `25707a7`의 언어 상태 유지와 동일 입력의 관찰 공유가 직접 번역 복원 경로에서 빠져 있었다. 현재 입력의 한 연결에만 원문 관찰이 도착하면 다른 대상 언어 출력이 `unknown` 또는 오래된 언어로 차단될 수 있었다. 한 글자 영문 조각마다 방향을 덮어쓰는 문제도 있었다. 같은 입력 장치의 활성 번역 연결끼리 언어 관찰만 공유하고 기존의 약한 신호 유지 규칙을 적용했다. 마이크/시스템 입력, 교체 전 연결, 원문 텍스트 자체는 서로 공유하지 않는다.
- 실제 GoLive 요청은 2026-09-01 01:43:48 KST `/start` 200, 01:43:49 `/gateway-token` 200과 WS 101까지 성공했다. 이후 01:43:51 DB 활성화 RPC에서 `22023 / INVALID_GATEWAY_READINESS_INPUT`으로 거절됐다. `c4f0007`의 자막 전용 전환이 runtime `voiceProvider`를 `null`로 바꿨는데, 기존 SQL은 DB의 `gemini` 값을 요구했다. 예약 시간이 원인이 아니다. 활성화 확인 정보와 그 해시에만 DB 호환 값을 사용한다. 실행 중 음성 재생은 계속 비활성이며 SQL 완화·새 마이그레이션은 없다.
- 준비 상태의 최신 버전을 조회하고도 이전 활성화 버전을 보내는 별도 경합을 수정했다. 이미 live인 세션의 ACK 재전송 식별자와 버전은 유지한다.
- 모델 저장 중 GoLive가 이전 전체 설정을 다시 저장하는 경합도 차단했다. 저장 중에는 마이크·연결·설정에 손대지 않으며 저장 완료 후 명시적으로 다시 시작해야 한다. 자동 재시도는 추가하지 않았다.

### 검증

- 전체 root: 1,562 PASS / 8 SKIP / 0 FAIL. 전체 gateway: 569 PASS. 타입 검사 및 독립 보안 검토 통과.
- 합성 음성 실제 API 한 번: EN→KO→EN 입력에 KO→EN→KO 확정 자막 관찰, 처음 2초 digital zero에서 자막 0개. 번역 연결 2개, 추가 텍스트 생성 요청 0개, 전체 시험 17.669초. 입력부터의 절대 시각이며 번역 지연 SLA가 아니다. `/tmp/nova-direction-regression-probe-20260901.json`.
- PostgreSQL 20개 회귀: 실제 NULL 입력 22023 재현, 수정한 값으로 미래 예약 회의 즉시 live, 같은 요청 재전송, 버전·호스트·용어집·종료 상태 보호 확인. 운영 SQL 정의는 저장소와 동일함을 읽기만으로 확인했다.
- 운영 웹 관련 파일 439개는 직전 배포와 해시가 같아 해당 웹 배포는 유지한다. 수정 대상은 native 앱 및 게이트웨이다.
- 남는 한계: 양쪽 번역 연결 모두 원문 관찰이 없거나 짧고 모호한 발화뿐이면 입력 언어를 추측하지 않는다. 미완결 발화의 빠른 언어 왕복과 동일 음성을 시스템·마이크로 중복 캡처하는 경우는 별도 품질 한계다.

추가 복구 배포 완료:
- gateway `realtime-noel-media-gateway-direction-golive-20260901` 100%, `/health` 200. Cloud Build `5b97df1c-2278-4f8f-bf79-1fb6c05b60ce`, 이미지 digest `sha256:21e4cbd5f07053d95568006132f280a356c14017238bc34cc87b62e2f60e6e13`. 기존 환경변수·자원·동시성·min 0/max 1 설정 비교 일치.
- `/Applications/NOVA.app` 교체·재실행 후 로컬 API에서 원문 3.6 / 요약 3.6 / en·ko / 기존 system_mic 선택 유지 확인. 소스 117개와 ASAR 일치 및 codesign 검증 통과. ASAR SHA256 `fda3e0c397415a351cbb0a04982c7932850a15817c47dc704637a798ca5bdbc4`.
- 설치 파일 `dist/releases/2026-09-01-direction-golive/NOVA-0.2.3-arm64.dmg`, SHA256 `b93fd0517b9771dbeec17e08b843ae75be4c0cb781f376904368fab3e9cc0ff7`.
- 롤백 앱 `/Applications/.NOVA-before-direction-golive-20260901.app`, gateway `realtime-noel-media-gateway-models-20260901`. DB와 웹 변경 없음.
- 교체 전 앱은 서버 종료 이후에도 프로세스가 남아 TERM/INT 후 해당 잔여 프로세스만 정리했다. 검증용 외부 브라우저 연결도 닫았다. 재실행은 프로세스·HTTP로 확인했으나 OS 접근성 도구의 timeout은 지속되어 전체 OS UI 시연 완료로 계산하지 않는다. 사용자의 운영 회의를 임의로 시작하지 않았다.

## 9. LIVE 상태에서 Translation waiting이 지속되는 회귀

### 관찰·판단

2026-09-01 02:06:24 KST 사용자 화면은 LIVE 38초였다. 해당 회의는 02:05:45에 DB 활성화됐고 02:07:06에 종료됐지만 번역·원문 행은 각각 0건이었다. 직전 회의도 활성화 성공 후 두 종류의 기록이 모두 0건이었다. 따라서 §8의 DB 활성화 오류와 이번 음성 전달 오류를 구분한다. 고객 음성·본문은 조회하거나 시험에 사용하지 않았다.

실행 재현과 이력 비교로 다음 두 원인을 확인했다. 두 조건 모두 `c4f0007`에 포함돼 있으며 모델 교체만으로 해결되지 않는다.

1. 게이트웨이는 `started` 직후 최초 `floor`를 보낸다. Electron은 `started`를 받은 뒤 웹의 상태 확인 GET을 기다리는 동안 `bridge.ready=false`이므로 최초 발언권 신호를 버렸다. 이후 LIVE가 돼도 `floorKnown=false`로 남아 모든 호스트 PCM이 차단됐다.
2. `system_mic` 캡처는 서로 다른 두 오디오 시계에서 system/mic 프레임을 번갈아 보냈다. 서버는 단일 호스트 입력에 고정돼 있어 두 번째 입력에서 `MULTIPLE_HOST_AUDIO_SOURCES_FORBIDDEN`이 발생했다. 이 보호 장치를 제거하면 프레임마다 번역 문맥·연결이 바뀔 수 있으므로 제거하지 않는다.

### 구현 경계와 위험 완화

- Electron에서 인증된 시작 ACK의 서버 검증 대기 중에만 최신 발언권 revision 하나를 보관한다. 검증 전에는 오디오 권한을 열지 않는다. 동일 revision의 충돌, 잘못된 payload, 실패·종료·교체된 연결은 권한을 부여하지 않는다.
- Live Call 캡처만 하나의 Web Audio 그래프에서 장치별 동시 샘플을 mono로 합쳐 하나의 24kHz/100ms PCM 스트림으로 보낸다. 기존 main의 16kHz/40ms 변환과 서버 단일 입력 보호는 유지한다. 단순히 두 스트림의 이름만 같게 바꾸지 않는다. 출력 gain은 0이고 종료·취소·실패 시 context와 노드를 해제한다. 일반 Caption Only 캡처는 독립 입력 방식을 유지한다.
- 독립 검증에서 이전 회의의 PCM이 현재 비수요 모드 회의로 전달될 수 있음을 추가 재현했다. 모든 모드에서 packet의 회의 ID와 현재 bridge 소유 세션이 정확히 일치해야 전송한다.
- 컨트롤러 입력 상태를 장치별로 관리한다. 시스템 무음이 마이크 신호를 덮어쓰지 않으며 각각 5초 후 만료한다. 장치·입력 변경과 시작·종료 시 초기화한다. 실제 연결 실패가 대기 표시보다 우선한다.
- 모델 선택·DB·웹·게이트웨이 구현은 이번 원인 수정으로 변경하지 않는다. 원문·요약의 사용자 선택 3.6, 번역 3.5 Live Translate를 유지하고 자동 모델 전환·추가 번역 연결을 도입하지 않는다.

### 실제 경로 검증과 한계

- 실제 브라우저에서 현재 `createAudioStreamer`와 PCM chunker를 읽어 합성 440Hz·880Hz 두 MediaStream을 주입했다. 3.2초 동안 31개 패킷, 두 주파수 진폭 각각 약 0.18, 모든 패킷 24kHz/100ms/4800bytes/단일 mic 라벨이었다. 종료 뒤 패킷 0개, 모든 context 종료 및 잘못된 입력 거부를 확인했다. 마이크·시스템 권한이나 실제 장치를 사용하지 않았다.
- 실제 로컬 WebSocket 게이트웨이→LiveMediaPipeline→Google 경로에 짧은 영문·한글 합성 WAV를 주입했다. 17.8초 동안 번역 연결 2개, 선택된 3.6 원문 요청·확정 각각 2건, en/ko 확정 각각 2건, 오류·원문 누락 0건, 초기 무음 자막 0건을 관찰했다. 끝난 뒤 두 Live 연결을 모두 닫았다. 운영 DB 호출·고객 회의 생성은 0건이다.
- 해당 공급자 시험의 두 번째 방향 검사에서 이전 영어 echo의 늦은 final을 선택한 검사 한계가 있다. 한국어 입력 뒤 새 영어 seq 2 출력은 관찰했으나 본문을 보존하지 않아 두 번째 문장의 번역 의미 정확성까지 검증했다고 주장하지 않는다. 추가 유료 재실행은 하지 않았다.
- 전체 OS 캡처 권한·장시간 실제 회의·운영 DB 저장까지 포함한 하나의 종단 시연과 위 분리된 경로 시험은 다르다. 공급자 지연·혼용 발화 품질 보장은 하지 않는다. Live의 생성 오디오를 재생하지 않아도 공급자 오디오 비용은 발생할 수 있다.

검증 파일: `test/desktop-live-floor-start-race.test.js`, `test/desktop-live-floor-readiness-security.test.js`, `test/live-call-audio-mix.test.js`, `test/subtitle-controller-health.test.js`. 합성 결과는 `/tmp/nova-live-mix-browser-result.txt`, `/tmp/nova-gateway-direct-source-probe-20260901.json`에 있다. 최종 전체 검사와 설치 결과는 아래에 추가한다.

### 최종 통합·적대적 검증·배포 결과

추가 검증에서 호스트 100ms PCM 뒤 남은 20ms와 리샘플링 필터 이력이 참가자 발언 이후 재사용되는 경우도 재현했다. 새 발언권과 잘못된 발언권 상태에서는 잔여 PCM·필터 이력을 폐기하고, 동일 revision·동일 발언자의 중복 ACK에서는 연속성을 유지한다. 선택적인 hybrid 경로는 저장 설정을 바꾸지 않고 Live Call 시작 요청의 복사본만 혼합 mic 입력에 맞춘다. 채널 복구 역시 현재 캡처 입력을 유지하고 새 캡처 시작 때만 저장된 입력 변경을 반영한다.

| 검증 | 결과 |
|---|---|
| A1 동시성 | PASS — started/floor/GET 순서, 중복 ACK, 중복 캡처 |
| A2 권한 | PASS — 검증 전·다른 회의·닫힌/교체된 bridge의 오디오 차단 |
| A3 CSRF / A4 HTML / A5 SSRF | N/A — 관련 경계 변경 없음. 기존 전체 보안 회귀 통과 |
| A6 입력 | PASS — 잘못된 ID·revision·소스·혼합 PCM 크기와 속도 |
| A7 잔류 | PASS — 중단·취소·늦은 응답·발언권 변경 뒤 PCM 잔류, 동일 ACK 연속성 |
| A8 디바이스 | PASS — 혼합·단일 입력, 지연 장치 획득, 브라우저 실제 오디오 그래프. 모바일 레이아웃 변경 없음 |

독립 보안 회귀를 포함한 관련 32개 검증이 통과했고, 발견한 이전 회의 PCM 전달 P1과 발언권 사이 PCM 잔류 P2를 수정했다. 검토 범위에서 남은 P1/P2는 없다.

- 최종 전체 검사: root **1,597 PASS / 8 SKIP / 0 FAIL**(1,605개), gateway **569 PASS**, web **812 + 77 PASS**. 총 **3,055 PASS**. root·web 타입 검사 및 diff 검사 통과. 별도 lint 스크립트는 없다. 로그 `/tmp/nova-live-waiting-root-final.log`, `/tmp/nova-live-waiting-gateway-tests.log`, `/tmp/nova-live-waiting-web-tests.log`.
- macOS arm64 0.2.3 패키징·서명 검증 성공. 기존 NOVA는 정상 종료했고 `/Applications/NOVA.app`을 교체·재실행했다. 설치본 117개 소스가 현재 코드와 일치하며 로컬 HTTP 200 및 실제 Caption Controller UI 접근을 확인했다. 재실행 첫 접근성 요청은 timeout, 재확인은 성공했다. 실제 사용자 회의를 임의로 생성하거나 시작하지 않았다.
- 사용자 원문·요약 `gemini-3.6-flash`, `system_mic`, en/ko 선택 유지 확인. 로그인 데이터·암호·키 설정을 변경하지 않았다.
- 설치 파일: `dist/releases/2026-09-01-live-audio/NOVA-0.2.3-arm64.dmg`. DMG SHA256 `fb433ebad20d7f85ce3749a2832bab343b09021fa2f27a9828a04fc802f46d24`, ASAR SHA256 `c74a2592f3fb6588dd7c016a817b7d21c7b487d641331f17eab0ed53c56263d0`.
- 서버 변경 없음: gateway 배포 입력 2,405개와 웹 관련 입력 439개의 기존 배포 스냅샷 해시가 일치했다. gateway `realtime-noel-media-gateway-direction-golive-20260901`과 웹 `dpl_84EPqaFsK3sm4fL2ifjCxJ1yJvwZ`를 유지한다. gateway health·웹 demo 200, 미인증 회의 목록 401 확인. DB migration·API 키·서버 자원·호출 한도 변경 없음.
- 앱 롤백: `/Applications/.NOVA-before-live-audio-20260901.app`. Windows·Intel macOS·공증은 이번 앱 교체 범위 밖이다. 장시간 실사용·잡음·동시 큰 음량 입력의 클리핑 및 번역 의미 품질은 위 짧은 합성 시험으로 보장하지 않는다.


## 10. Live 원문·번역 통합과 기록 복구 (2026-09-01)

사용자의 최신 요청은 앞 절의 원문 Flash 선택 정책을 대체한다. 원문·번역은 3.5 Live만 사용하고, 문단·회의 요약만 3.6 Flash를 사용한다. 관련 없는 용어집 추출·선택적 교정 모델은 이번 Live 경로에 추가하지 않는다.

### 확인한 원인과 결정

- 실제 최근 종료 회의에는 번역 27행과 원문 8행이 저장돼 있었다. 기록이 전부 없던 것이 아니라 원문 생산 경로, 로컬 조회, 요약 설정에 서로 다른 문제가 있었다. 운영 조회는 행 개수·상태만 읽었고 본문·참여자 개인정보는 기록하지 않았다.
- 기존 Live 입력 전사는 언어 힌트만 사용하고 문장을 버렸다. 이제 기존 번역 연결 중 하나만 원문 기록의 작성자로 지정한다. 별도 Flash 원문 요청이나 추가 원문 Live 연결을 열지 않는다. 언어별 번역은 원문 저장을 기다리지 않고 표시한다.
- 공식 Live Translate 문서는 inputAudioTranscription과 outputAudioTranscription을 함께 지원한다. 실제 사용 가능한 문서 모델 ID는 `gemini-3.5-live-translate-preview`다. 확인되지 않은 GA 별칭으로 이름을 바꾸지 않는다. https://ai.google.dev/gemini-api/docs/live-api/live-translate
- 프로덕션 웹에 GEMINI_API_KEY가 없어 요약 요청이 공급자 호출 이전에 실패했다. 새 설정 오류는 SUMMARY_NOT_CONFIGURED로 구분하고 명시적 수동 재요청만 허용한다. 005는 이전 일반 SUMMARY_FAILED 행을 바꾸거나 일괄 재생성하지 않는다.
- 종료 전에 인증된 소유 연결로 drain을 요청한다. 이미 접수한 호스트·참여자 음성 및 원문 저장이 끝난 뒤에만 ACK하고 DELETE/요약을 진행한다. 연결이 없으면 서버에서 미시작·종료 또는 수요 sleeping을 검증해야 한다. 시간 초과·저장 실패는 자동 유료 재접속 없이 명시 오류로 처리한다.
- 004는 원문 provenance를 추가한다. 공급자의 finished와 앱의 quiet/drain/길이 확정을 구분하며 기존 원문 NULL 값은 재해석하지 않는다. 실제 공급자 시각이 없는 sourceStartedAt은 만들어내지 않는다.
- 앱 기록은 서버의 원문 페이지와 언어별 독립 번역을 각각 읽는다. 번역을 원문으로 바꾸거나 시간·순번으로 서로 짝짓지 않는다. 원격 요약 준비 중 상태가 기존 로컬 요약을 지우지 않으며 Live Call 로컬 자동 요약의 중복 호출을 금지한다.
- 마이크 권한이 없으면 하단 버튼 슬롯과 예약 여백을 없앤다. 원문·한국어·English 탭 모두 스크롤 하단과 notebook 하단이 일치함을 실제 브라우저에서 확인했다.

### 검증 근거와 한계

- 실제 Google 연결로 합성 영문과 한글을 별도의 제한된 시험에서 전송했다. 각 시험은 Live 연결 2개, 원문 1건 저장, en/ko 확정 출력, Flash 원문 요청 0회, 초기 무음 자막 0개, 끝난 뒤 모든 연결 종료를 확인했다. 10.8초·11.9초는 전체 시험 시간이며 번역 지연 지표가 아니다. 운영 DB 호출·고객 회의 생성은 없다.
- 실제 3.6 Flash 요약 어댑터로 합성 원문을 한 번 요청하여 한국어 구조화 요약을 받았다(4.49초, 입력39·출력27 tokens, 공급자 total393). 자동 재시도는 없다.
- 원문 저장은 실제 PGlite PostgreSQL v3 RPC와 소유권·세대·종료·6시간·철회 검증으로 별도 확인했다. 요약은 실제 서비스→REST 어댑터의 공급자 대역→CAS 저장→조회 흐름으로 검증했다. 이 분리된 검증들을 고객 기기의 장시간 음성→운영 DB→요약 전체 시연이라고 부르지 않는다.
- 적대적 검토에서 source gap의 무음 시간 포함으로 60초 제한을 넘던 문제, 원문 실패 뒤 drain 성공 응답, 연결이 없음을 무수요로 오인하던 문제, 이전 AI 문단 요약이 원문 근거에 섞이는 문제를 발견하고 보완했다.
- 원문·번역은 steady-state 2개 언어 연결을 공유하며, 계획된 연결 교체 중에는 이전/다음 연결이 잠시 겹칠 수 있다. 오디오를 재생하지 않아도 Live의 생성 오디오 비용은 발생한다. 공급자의 번역 의미 정확성·장시간 잡음·모든 단말의 캡처 권한까지 보장하지 않는다.

최종 빌드·배포 식별자 및 전체 회귀 결과는 아래에 기록한다.


### 최종 검사·배포 완료

- 전체 회귀 root 1,632 PASS / 기존 10 SKIP / 0 FAIL, gateway 597 PASS, web 821 + 77 PASS: **3,127 PASS**. root·web 타입 검사 및 diff 검사 통과. 로그 `/tmp/nova-live-source-{root,gateway,web}-verified.log`. 이후 Unicode 보강 1개를 포함한 archive 관련 92개도 별도 통과했다.
- 독립 적대적 검증 179개 PASS. A1 동시성, A2 소유권·6시간·철회, A3 IPC origin, A5 고정 URL, A6 Unicode·큐·원문 시각, A7 종료·유실·재연결, A8 native/web 전송 경계를 검증했다. A4 HTML 렌더링 변경 없음; 과거 AI 요약의 근거 오염은 별도 회귀 통과. 검토 범위에 미해결 P1/P2 없음.
- 운영 DB에 004/005를 적용했다. `source_provenance` 및 v3/fenced RPC 존재와 service_role만 실행 가능함을 확인했다. 잘못 축약한 함수 이름으로 첫 존재 확인이 false였으나, 실제 `persist_authoritative_live_source_utterance_v3` 및 `_fenced_v1`로 재조회해 둘 다 확인했다. 기존 회의 원문·요약 job 행을 변경하거나 재생성하지 않았다.
- 웹 요약 서버에 기존 Gemini 연결의 키를 sensitive production 환경 변수로 설정했다. 값은 명령 인자·파일·출력·소스에 노출하지 않았다. 새 deployment `dpl_51KHp4GqscTeyHZaySdT2kEgvjee`, immutable URL `https://realtime-noel-eab14plcl-kyeokim1234-7484s-projects.vercel.app`. 보호된 후보 demo 200을 확인한 뒤 기존 production 도메인으로 승격했다.
- gateway Cloud Build `bbf5f590-b2fd-4704-a6b8-d0e7c66987e9`, image SHA256 `7596dff1c24a8df4df1a46f260571e583192d5c71449d407ce39f5e0cacc352a`. revision `realtime-noel-media-gateway-live-input-20260901`을 무트래픽으로 배포·health 200 확인 후 100%로 전환했다. 최소 0/최대 1, CPU 1, 메모리 1Gi, concurrency 256 및 기존 키·권한 설정을 유지한다.
- `/Applications/NOVA.app` macOS arm64 0.2.3을 재빌드·서명 검증·교체·재실행했다. 설치본 119개 소스 해시가 현재 코드와 일치하고 HTTP 200 및 로그인된 기존 화면 진입을 확인했다. 실제 고객 회의를 임의로 시작하지 않았다. 확인 중 사용자가 앱 상태를 변경하여 이후 UI 조작은 중지했다.
- 설치 파일 `dist/releases/2026-09-01-live-input/NOVA-0.2.3-arm64.dmg`, SHA256 `25addf9ca3b7255480dbaeef85ebbededc46621678761a328f8d42b8189d3b6d`. ASAR SHA256 `68662663bca9afe1dc7c9956ca17e1f5df588c80a1c1921cddb62842f5e3e21e`. 앱 롤백 `/Applications/.NOVA-before-live-input-20260901.app`.
- production web demo 200, 미인증 회의 목록 401, gateway health 200. 배포 snapshot gateway 72개·전체 2,936개 runtime 파일 불일치 0. 소스 변경은 작업 트리에 보존했고 다른 작업자의 변경을 커밋·되돌리기 하지 않았다.
- 이전에 실패한 일반 SUMMARY_FAILED job은 자동 재생성하지 않았다. 원문 자체가 녹음되지 않았던 과거 회의의 내용은 만들어 복구하지 않는다. Windows/Intel macOS/공증 및 장시간 실제 통화의 품질 검증은 이번 설치 범위 밖이다.
