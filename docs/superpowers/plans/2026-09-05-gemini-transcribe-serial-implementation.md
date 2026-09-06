# Gemini Transcribe → Flash: 공식 문서 조사 및 구현 계획

2026-09-05. 상태: 사용자 승인 후 구현 및 통합 검증 진행 중. 최신 검증 결과는 별도 구현 보고서에 기록한다. Soniox 기본값·관리자 배정·다음 세션 적용·최대 3개 언어·호스트 종료 원칙은 그대로 유지한다.

## 결론

Gemini는 관리자가 배정하는 대안 엔진으로 적합한 구조를 제공한다. 추천 구성은 `gemini-3.5-transcribe-live`로 원문을 한 번 인식하고, 기존 고정 모델 `gemini-3.6-flash`에 대상 언어별 텍스트 번역을 요청하는 방식이다. Soniox보다 빠르거나 정확하다는 판정은 실제 음성 비교 전에는 하지 않는다.

Soniox 배정은 Soniox 자체 인식·번역만 사용한다. Gemini 배정에서만 이 직렬 파이프라인을 사용한다. 두 엔진 모두 종료 후 요약은 별도 작업이다.

## 공식 문서에서 확인한 연결 계약

| 항목 | 확인 내용 | 적용 |
|---|---|---|
| Transcribe 입력/출력 | 16-bit PCM, 16kHz mono, TEXT 모달리티, 권장 약 100ms 청크 | 입력 프레이밍을 두 실행 경로에서 통일 |
| 부분/확정 전사 | interimInputTranscription / inputTranscription | 미리보기와 기록을 분리 |
| 언어와 용어 | languageCodes는 힌트, customVocabulary는 최대 1,000개·일반 권장 100개 이하 | 실제 발화 언어 힌트와 선별된 용어만 전달 |
| 인식 모드 | VERBATIM / SMART | 원문 보존을 위해 VERBATIM 유지 |
| 연결 수명 | Transcribe Live 최대 10분 | 약 9분에서 선제 교체하는 기존 기준 재사용 |
| 화자/시각 | 실시간 화자 분리·단어별 타임스탬프 미지원 | 앱 발언권의 사용자 식별을 사용, 같은 마이크 여러 화자 식별은 보장하지 않음 |

출처: [Live Transcribe](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe). 위 지원 사양과 아래 운영 구현 제안은 구분한다.

Flash 3.6은 텍스트 출력 모델이며 Live API를 지원하지 않는다. 기존 `models.generateContent`와 스트리밍 `models.generateContentStream` API가 공식 참조에 남아 있다. 일반 텍스트 가이드의 최신 예제가 Interactions API를 쓰더라도 이번 작업에서 API 계열까지 함께 바꿀 필요는 없다. [모델 카드](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash), [GenerateContent API](https://ai.google.dev/api/generate-content).

`gemini-3.5-live-translate-preview`는 음성 번역 출력 및 단일 targetLanguageCode 경로다. 자막·원문 대응이 핵심인 이번 계획은 해당 경로를 재도입하지 않는다. [Live Translate](https://ai.google.dev/gemini-api/docs/live-api/live-translate).

## 권장 연결 흐름

```text
관리자가 배정한 Gemini 엔진·용어집 버전을 세션에 고정
  → 마이크/시스템 음성 → 16kHz PCM → Transcribe Live 연결
  → 부분 원문: 갱신 가능한 미리보기
  → 확정 원문: 발언 ID를 발급하고 보존
       ├─ Flash: 대상 언어 A 번역
       ├─ Flash: 대상 언어 B 번역
       └─ Flash: 대상 언어 C 번역(필요한 경우)
  → 결정적 용어 규칙 검사 → 확정 자막
       ├─ PC 표시
       └─ Live Call일 때 웹 표시·기록
호스트 종료 → 연결/대기 작업 정리 → Live Call 기록으로 요약
```

인식→번역은 직렬이지만, 언어별 번역은 독립적으로 진행한다. 다음 음성 수신을 번역 완료까지 막지 않는다. 선택된 자막 언어 중 신뢰할 수 있게 판별된 원문 언어는 번역 호출 없이 원문을 표시한다. 즉 한국어 발화에 한·영·일 자막이면 원문 하나와 번역 두 개가 기본이다.

원문 확정 시 부여한 ID를 번역과 연결하고 언어별 큐에서 순서를 유지한다. 같은 문장을 실제로 두 번 말한 경우 텍스트가 같다는 이유로 삭제하지 않는다. 재전송 중복 제거에는 음성 구간·연결 세대·발언 ID를 사용한다.

## 현재 코드에서 먼저 수정할 사항

| 중요도 | 발견 | 근거 | 작업 |
|---|---|---|---|
| P2 | SDK 설치 버전 불일치 | media-gateway 선언 ^2.18.0 / lock 2.19.0 / 설치 2.12.0 | 실제 STT는 raw WebSocket 사용. 재현 환경 설치 정합성은 배포 전 확인 |
| 정정 | 설치 SDK 변환기 제약이 실제 STT 경로를 막는다는 추정은 부정확 | `media-gateway/src/google-live-client.js`는 raw WebSocket 래퍼 | 현재 wire 계약을 직접 검증하며 불필요한 SDK 교체는 하지 않음 |
| P1 | 로컬 언어 힌트는 [], gateway는 전역 ko/en/ja | `src/gemini-live-transcribe.js:37`, `media-gateway/src/config.js:199`, `server.js:336` | 세션의 실제 입력 언어로 공통 힌트 생성 |
| P1 | gateway가 goAway를 처리하지 않음 | `media-gateway/src/google-provider-adapters.js:190` | 연결 교체 요청을 수명 관리자로 전달 |
| P2 | 로컬과 gateway의 청크 크기 차이 | `src/gemini-live-transcribe.js:114`, `media-gateway/src/google-provider-adapters.js:11` | 100ms PCM 프레이밍과 마지막 tail 검증 |
| P2 | 로컬 Gemini 오류가 broadcast에만 전달됨 | `src/gemini-live-transcribe.js:75` | 재시도 가능한 오류와 인증/권한 오류 분류 |

구현 단계에서 실제 호출 경로를 다시 추적한 결과, gateway STT도 이미 raw WebSocket 래퍼를 사용했다. SDK 변환기 문제를 실제 장애로 분류했던 초기 분석을 정정한다. 기존 공식 WebSocket 계약을 유지하고 힌트·프레이밍·goAway 처리 자체를 검증한다.

### STT 설정 예시 — 문서 계약, 실행 코드 아님

```javascript
{
  responseModalities: ["TEXT"],
  inputAudioTranscription: {
    languageCodes: ["ko-KR", "en-US", "ja-JP"],
    customVocabulary: ["NOVA", "EBITDA"],
    mode: "VERBATIM"
  }
}
```

언어 코드는 예시다. 자막 출력 언어가 발화 가능 언어와 항상 같다고 간주하지 않는다. 번역 대상만 일본어인 상황에서 일본어를 자동으로 STT 힌트에 넣지 않는다.

## 지연과 번역 품질

- 기존 언어별 final 큐와 최신 partial만 남기는 동작을 재사용한다. 불안정한 STT partial마다 번역 요청을 추가하지 않는다.
- 기본은 현재 `generateContent` final 경로를 안정화한다. 이후 동일 fixture에서 `generateContentStream`의 첫 표시 지연과 비용을 비교하고, 의미 있는 개선이 있을 때만 도입한다. 스트리밍 중 텍스트는 최종 기록이 아니다.
- 번역에는 현재 발언·짧은 이전 원문·관련 용어만 전달한다. 전체 회의록을 매번 보내지 않는다.
- 번역 이후 추가 LLM 교정 호출을 붙이지 않는다. 용어·숫자·금지 번역은 결정적으로 검사한다.
- 현재 runtime은 translation에 thinkingLevel=low를 이미 설정한다. Flash 3.6의 minimal은 실측 비교 후보이며 정확도를 확인하지 않고 바꾸지 않는다. [Thinking 설정](https://ai.google.dev/gemini-api/docs/thinking).
- 현재 번역 시도당 2.8초/총 6초 제한은 동작 예산이지 사용자 체감 지연 보장이 아니다. 첫 부분 원문·첫 번역·확정 번역 p50/p95를 분리 측정한다.
- 카탈로그의 자동 대체 모델 호출은 세션에 배정된 모델 정책과 함께 정리한다. 관리자 승인 없이 Soniox나 다른 모델로 바뀌지 않도록 실패를 명확히 표시한다.

## 연결 제한과 호스트 종료

기존 약 9분 교체 기준을 유지하되 오디오 프레임이 없어도 작동하는 타이머로 보완한다. goAway 수신 시 동일한 교체 경로를 호출한다. 타이머·goAway·오디오 오류가 겹쳐도 새 연결은 한 번만 생성한다.

일반 Live API 문서에는 sessionResumption과 2시간 유효 handle이 있지만 예시는 대화형 모델이다. Transcribe 전용 10분 제한을 일반 세션 압축·재개 설명으로 무시하지 않는다. 기본 구현은 새 Transcribe 연결 + 앱 자체 연속성 유지다. Transcribe의 handle 지원은 별도 실제 API 확인 전까지 의존하지 않는다. [세션 관리](https://ai.google.dev/gemini-api/docs/live-api/session-management).

- 새 연결에서도 제품 세션 ID·배정 버전·용어집 버전·발언 시간축은 유지한다.
- 마지막 미확정 오디오는 제한된 버퍼로 이어가며 누락/중복을 검증한다. 긴 장애의 무손실 복구를 약속하지 않는다.
- 호스트 종료는 취소 상태를 먼저 설정한다. 마지막 확정 결과를 제한된 시간 내 정리하고 종료 후 늦은 연결/응답은 무시한다.
- 재연결 중 관리자 배정이 바뀌어도 현재 세션은 기존 Gemini를 유지한다.
- 공통 선행 작업인 Live Call 6시간 접근 만료·참가자 인증 갱신 개선이 필요하다. 공급자 재연결만으로 해결되지 않는다.

## 인증과 용어집

Live Call은 기존 서버 gateway가 모델 키를 소유한다. 관리형 로컬 캡션에서 직접 STT 연결을 유지할 경우 서버에서 모델/config를 제한한 단기 토큰을 발급하는 경로를 검증한다. 단기 토큰은 Live API v1beta 전용이며 Flash 텍스트 번역 자격 증명으로 재사용할 수 없다. 로컬의 Flash 번역은 배정 검증을 수행하는 서버 호출 경계가 필요하다. 장기 관리자 키를 앱에 배포하지 않는다. [단기 토큰](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens).

용어집은 하나의 고정 버전에서 인식용 어휘와 대상 언어별 번역 대응표를 각각 생성한다. 발음/별칭은 인식, 지정 번역/번역 금지는 번역 단계에 적용한다. 기존 구조화 문서와 Gemini 어휘 선별기를 유지하고 이전 평가의 다국어 편집·번역 금지 저장 충돌도 공통 작업에서 수정한다.

## 구현 작업과 완료 기준

| 순서 | 담당·파일 범위 | 완료 기준·검증 |
|---|---|---|
| G1 | Backend: gateway raw WebSocket wire 계약 테스트 | languageCodes/mode/customVocabulary 송신, interim/final 수신 증명. 잘못된 값 거부 |
| G2 | Backend: 공통 힌트/PCM 계약, `src/gemini-live-transcribe.js`, STT 팩토리 | 캡션·Live Call의 같은 설정이 같은 프로토콜이 됨. 샘플 유실·불필요 padding 없음 |
| G3 | Backend Gateway: Google adapter, rolling session | 10분 경계·무음·goAway 동시 발생에 단일 교체. 호스트 종료 후 재연결 0건 |
| G4 | Backend: 기존 언어별 번역 큐·공통 runtime | 3개 언어, 느린 한 언어, final 뒤 늦은 preview 검증. 정상 final은 대상 언어당 번역 1회·추가 LLM 교정 0회 |
| G5 | Security/Schema 공통 작업: 사용자 배정, 인증 발급, 세션 고정 | 승인된 배정만 실행, 재연결에 배정 불변, 다른 사용자 접근 거절 |
| G6 | Design: 기존 캡션/Live Call 상태 컴포넌트 | 기능 추가 없이 배정 엔진·재연결·언어별 오류를 표시. 기존 디자인 토큰 유지 |
| G7 | CTO: 동일 음성 fixture 평가·통합 검증 | 아래 적대적 검증 및 지연/정확도 보고. 실제 마이크 시연 후 배포 판단 |

G1→G2 공통 계약 이후 데스크톱과 gateway는 파일 경계로 분리해 실행한다. G5는 Soniox 계획의 동일 작업을 재사용해 배정 테이블·만료 정책을 중복 구현하지 않는다.

## 위험과 적대적 검증

| 위험 | 검증 |
|---|---|
| SDK mock만 통과하고 wire가 틀림 | 실제 설치 SDK의 송수신 변환 계약 + 별도 승인된 fixture API smoke |
| 교체 시 음성/자막 중복·누락 | 9~10분 경계 긴 발화, 동일 문장 반복, 두 연속 교체, 마지막 final 지연 |
| 느린 번역이 자막을 역순으로 덮음 | 언어별 응답 순서 역전, stale preview, 종료 후 늦은 응답 |
| 언어 힌트의 과신 | 한영일 코드 스위칭, 다른 언어 발화, 숫자/고유명사, 잘못된 script 출력 |
| 키 오류를 무한 재시도 | 잘못된 키·승인 철회·429/503·연결 만료를 분리 검증 |
| 앱 6시간 제한 잔존 | 장기 Live Call과 viewer grant 갱신, 재입장, 호스트 종료 후 접근 차단 |

기계적 기준: 정상 경로 final 중복 저장 0건, 소스/번역 대응 위반 0건, 종료 후 신규 연결 0건, 추가 LLM 교정 호출 0건. 품질 기준은 용어 정확도·오교정률·숫자 보존과 동일 음성 지연 비교로 판단한다. 현재는 실제 API·실제 마이크 성능을 측정하지 않았으므로 Soniox 대비 우위나 수치 지연 목표 달성을 주장하지 않는다.
