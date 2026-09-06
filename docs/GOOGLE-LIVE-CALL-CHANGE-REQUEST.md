# Google 기반 Live Call 자막 전용 전환 및 수정 요청서

- 작성일: 2026-08-21 (Asia/Seoul)
- 대상: NOVA 웹앱, 데스크톱 호스트 프로그램, Media Gateway, Google Cloud 운영 담당자
- 문서 목적: 지금까지 확인·수정한 Google 연동 사항을 한곳에 기록하고, 웹앱 또는 호스트 프로그램의 후속 수정·배포 요청에 바로 사용할 수 있게 한다.
- 현재 상태: **코드 수정 및 로컬 검증 중이며, 이번 자막 전용 변경은 아직 운영 배포하지 않았다.** Cloud Run의 운영 최대 인스턴스 제한 변경만 별도로 반영된 상태다.

## 1. 최종 제품 계약

NOVA Live Call은 다음 계약으로 통일한다.

1. 하나의 호스트 기기만 행사장 오디오를 전송한다.
2. 호스트 입력은 노트북 마이크 또는 행사장 믹서에 연결된 USB 오디오 인터페이스 중 하나만 사용한다.
3. 참여자는 최대 200명이며 오디오를 업로드하지 않고 자막만 구독한다.
4. 한 행사에서 자막 언어는 1개 이상 3개 이하로 제한한다.
5. 중간 인식 결과는 원문 언어 자막에만 표시한다.
6. 번역은 확정된 STT 문장에 대해서만 수행한다.
7. 번역 음성, TTS, Gemini Live 오디오 출력은 제공하지 않는다.
8. 행사 오디오 입력은 최대 2시간으로 제한한다.
9. 예약 행사 시작 60분 전부터 서버 예약 작업이 Cloud Run 상태를 확인하고 게이트웨이를 준비한다.
10. Cloud Run은 평상시 `min=0`, 행사 및 준비 요청이 없을 때 scale-to-zero를 유지한다.

## 2. 변경 배경과 비용 분석

### 2.1 Cloud Run 비용

기존 비용 급증은 애플리케이션의 백그라운드 루프가 아니라, 과거 Cloud Run 리비전과 트래픽 태그에 남아 있던 `minScale=1` 설정이 원인이었다.

- 조사 프로젝트: `studied-sled-460400-u2` (`My First Project`)
- 리전: `asia-northeast3`
- 2026-08-01~19 Cloud Run 비용: 약 **₩92,535**
- 실제 요청 처리 CPU 비용: 약 **₩7**
- 나머지 99.99% 수준: 최소 인스턴스 CPU·메모리 비용
- 관측 패턴: serving 리비전 1개와 tagged 리비전 7개가 각각 `minScale=1`로 유지
- `9,850,784` 최소 인스턴스 초는 8개 인스턴스가 약 14일 이상 유지된 패턴과 일치

현재 운영 대상은 별도 프로젝트다.

- 운영 프로젝트: `gen-lang-client-0321430669`
- 리전: `asia-northeast3`
- 서비스: `realtime-noel-media-gateway`
- 확인된 서비스 계약: `min=0`, `max=1`, request-based CPU, concurrency 256, timeout 3600초, 1 CPU, 1 GiB, startup CPU boost
- 운영 반영 완료: 서비스 최대 인스턴스 `20 → 1`

중요: 서비스 수준 `min=0`만 확인하면 부족하다. 트래픽을 받을 수 있는 모든 리비전과 태그의 `minScale`도 0이어야 한다.

### 2.2 Gemini API 비용

Gemini 비용은 Cloud Run과 다른 프로젝트 및 결제 경계에서 발생했다.

- Gemini 프로젝트: `gen-lang-client-0504190091` (`chatreplit`)
- 결제 계정: `014030-68817B-60AC10` (`My Billing Account`)
- API: `generativelanguage.googleapis.com`
- 최근 사용 키: `Gemini API Key 2` (2026-06-10 생성)
- 2026년 7월 비용: **₩144,745**
- 2026년 6월 비용: 약 **₩10,774**
- 전월 대비 증가율: **1,243.47%**
- 2026-07-25~27 비용: **₩141,945**, 7월 전체의 98.1%

7월 주요 SKU:

| SKU | 사용량 | 비용 | 비중 |
| --- | ---: | ---: | ---: |
| Live Translate audio output | 2,402,200 토큰 | ₩77,421 | 53.5% |
| Gemini 3.5 Flash text input | 13,581,229 토큰 | ₩31,265 | 21.6% |
| Gemini 3.5 Flash text output | 1,599,108 토큰 | ₩22,088 | 15.3% |
| Live Translate audio input | 2,585,958 토큰 | ₩13,891 | 9.6% |

직접 원인은 자막만 표시하는 제품에서도 Gemini Live 연결 설정이 `responseModalities: ["AUDIO"]`를 요청했던 구조다. 사용자에게 음성을 재생하지 않더라도 모델이 음성을 생성하면 audio output 토큰 비용이 발생한다.

추가 증폭 요인은 다음과 같았다.

- 오디오 source별, 목표 언어별 Live 세션 생성
- `system`과 `mic`, 최대 3개 언어 조합에서 최대 6개 Live 세션 가능
- 3개 언어의 ordered translation direction은 최대 6개 경로
- 확정 자막마다 Flash 보정 호출 가능
- Gemini Live reconnect에 짧은 backoff는 있었지만 총 시도 횟수 또는 총 경과시간 상한이 없었음

## 3. 변경 전과 변경 후 구조

### 3.1 변경 전

```text
호스트 오디오
  → source(system/mic)별 분기
  → 언어별 Gemini Live 세션
  → AUDIO 응답 요청
  → 음성 큐/오디오 publish
  → 입력·번역 자막 callback
  → 선택적 Gemini Flash 보정
```

문제점:

- 표시하지 않는 번역 음성도 과금될 수 있음
- source 수 × 언어 수만큼 Live 세션이 증가함
- 중간 자막과 최종 자막 처리 경계가 비용에 불리함
- 참여자 수와 무관해야 할 모델 세션이 설정 조합에 따라 증가함

### 3.2 변경 후 운영 경로

```text
호스트 기기 1대의 PCM 오디오
  → Cloud Speech-to-Text rolling stream 1개
  → interim 원문 자막 1개 레인에만 publish
  → committed 원문 문장
      ├─ 원문 언어: 그대로 publish
      └─ 나머지 최대 2개 언어: Gemini Flash 텍스트 번역
  → 선택적 committed-caption polish
  → 최대 200명의 VIEWER가 Supabase/WebSocket 자막 구독
```

운영 경로에는 다음이 없다.

- Gemini Live 세션 생성
- `responseModalities: ["AUDIO"]`
- 번역 오디오 큐
- TTS 호출
- `publishAudio` 호출
- 참여자 오디오 업로드

## 4. 실제 코드 수정 사항

### 4.1 Media Gateway 운영 의존성 교체

파일: `media-gateway/src/server.js`

- `GeminiLiveTranslateAdapter`와 Gemini Live client 주입 제거
- 운영 파이프라인에 `CloudSpeechToTextAdapter` 주입
- 확정 텍스트 번역용 `GeminiTextTranslateAdapter` 유지
- 선택적 확정 자막 보정용 `captionPolish` 유지
- 번역/TTS 음성 의존성 미주입

현재 모델 계약:

- Live Translate: 운영 Live Call 경로에서 사용하지 않음
- translation/polish/recap 등 텍스트 작업: 고정 모델 매트릭스 사용
- 현재 코드의 텍스트 모델: `gemini-3.7-flash`
- 호출자가 모델 이름을 override할 수 없음

### 4.2 단일 STT rolling stream

파일:

- `media-gateway/src/live-media-pipeline.js`
- `media-gateway/src/rolling-speech-session.js`

변경 내용:

- 파이프라인 시작 시 Cloud STT rolling stream을 정확히 1개 생성
- `RollingSpeechSession`에 `onPartialTranscript` 전달
- rollover 재생 구간에서 partial 중복 방지
- 확정 문장은 기존 ordered final queue로 전달하여 자막 순서와 seq 유지
- 첫 입력 source를 세션의 호스트 source로 고정
- 다른 source가 뒤늦게 섞이면 `MULTIPLE_HOST_AUDIO_SOURCES_FORBIDDEN`
- 중간 인식 결과는 source language가 일치하는 원문 레인에만 표시
- 중간 결과에는 Gemini 번역을 호출하지 않음
- 확정 결과에서 원문을 제외한 목표 언어만 텍스트 번역

참고: 기존 provider 단위 테스트를 위한 `liveTranslate` 주입 호환 경계는 남겨 두었다. **운영 `server.js`는 이 의존성을 주입하지 않으므로 운영 Live Call에서 해당 경로는 도달할 수 없다.** 이 경계는 데스크톱/provider 회귀 테스트 제거가 완료되면 별도 정리할 수 있다.

### 4.3 음성 출력 제거 계약

파일:

- `webapp/lib/security/live-input-validation.ts`
- `media-gateway/src/config.js`
- `webapp/components/live/LiveHostDashboard.tsx`

변경 내용:

- 신규/수정 API의 output mode는 `captions`만 허용
- `captions_audio`, `audio` 입력은 public API 경계에서 거부
- Gateway 설정도 `captions`만 허용
- 호스트 UI에서 번역 음성 관련 선택지를 노출하지 않음
- 호스트 입력 안내를 “호스트 기기 1대의 마이크 또는 USB 믹서”로 명시

레거시 타입과 과거 DB row 파싱용 값은 일부 내부 계약에 남아 있을 수 있다. 신규 생성·수정 API와 운영 Gateway는 자막 전용으로 차단한다.

### 4.4 200명·최대 3개 언어·2시간 계약

파일:

- `webapp/components/live/LiveHostDashboard.tsx`
- `webapp/lib/security/live-input-validation.ts`
- `webapp/lib/live/service.ts`
- `media-gateway/src/config.js`
- `media-gateway/src/gateway-server.js`

변경 내용:

- 웹 UI 기본 최대 시청자: `50 → 200`
- 신규 세션 서비스 기본 최대 시청자: `200`
- API schema 기본 최대 시청자: `200`
- 허용 범위: 1~200명
- 언어 허용 범위: 중복 없는 1~3개
- Gateway 오디오 시간 기본 상한: `6시간 → 2시간`
- 16 kHz mono PCM 기준 byte budget도 2시간으로 축소
- 참여자는 VIEWER grant로 자막만 구독하고 binary media 업로드는 Gateway에서 거부

참여자 수는 Gemini/STT 세션 수를 늘리지 않는다. 1명이 보든 200명이 보든 호스트 STT stream은 1개다.

### 4.5 예약 기반 T-60분 준비

신규/수정 파일:

- `webapp/lib/live/gateway-prewarm.ts`
- `webapp/lib/live/gateway-prewarm.test.ts`
- `webapp/app/api/internal/live-gateway-prewarm/route.ts`
- `webapp/components/live/scheduled-gateway-start.ts`
- `webapp/components/live/scheduled-gateway-start.test.ts`
- `webapp/lib/live/store.ts`
- `webapp/vercel.json`
- `webapp/.env.example`
- `webapp/README.md`

동작:

1. Vercel Cron이 5분마다 `/api/internal/live-gateway-prewarm` 호출
2. endpoint는 `Authorization: Bearer <CRON_SECRET>` 검증
3. 현재 시점부터 60분 이내에 `status=preparing`인 예약 세션이 있는지 조회
4. 늦은 행사 시작을 위해 예약 시각이 최대 10분 지난 preparing 세션도 조회
5. 대상이 있을 때만 Gateway WebSocket URL을 엄격히 검증하고 HTTPS `/health`로 변환
6. 20초 timeout으로 health 요청
7. health가 2xx가 아니면 `LIVE_GATEWAY_PREWARM_UNHEALTHY`로 fail-closed 처리
8. 대상 세션이 없으면 Cloud Run에 요청하지 않음
9. 열린 호스트 화면의 T-60분 요청은 서버 cron 지연에 대비한 백업

Supabase 조회는 같은 `scheduled_at` query parameter를 중복하는 대신 다음 명시적 AND 필터를 사용한다.

```text
and=(scheduled_at.gte.<start>,scheduled_at.lte.<end>)
```

보안 경계:

- Gateway URL은 `wss:`만 허용
- pathname은 정확히 `/live`
- username/password, port, query, fragment 금지
- 실제 health 요청은 `https://<host>/health`
- redirect 금지, credential 미전송, `no-store`
- `CRON_SECRET`은 32자 이상이어야 함

환경 변수:

| 변수 | 용도 |
| --- | --- |
| `NEXT_PUBLIC_LIVE_GATEWAY_URL` | 브라우저 WebSocket `/live` URL |
| `NEXT_PUBLIC_LIVE_GATEWAY_PREWARM_ENABLED` | 열린 호스트 화면의 T-60분 백업 웜업. `false`일 때만 비활성화 |
| `LIVE_GATEWAY_URL` | 서버 cron이 사용하는 동일한 `/live` URL |
| `CRON_SECRET` | Vercel Cron Bearer secret, 32자 이상 |

주의: 5분 주기의 health 요청은 예약 구간 중 게이트웨이를 반복적으로 깨우는 방식이다. Cloud Run의 항상 켜짐 인스턴스를 예약하는 방식은 아니므로, 실제 행사 전 리허설에서 `active-instance-count`, 첫 WebSocket 연결 시간, cold-start 시간을 관측해야 한다.

### 4.6 Cloud Run scale-to-zero 운영 도구

파일:

- `scripts/configure-cloud-run-scale-zero.sh`
- `scripts/verify-cloud-run-scale-zero.mjs`
- `test/cloud-run-scale-zero-contract.test.js`
- `tasks/runbook-gateway-scale-zero.md`
- `docs/superpowers/specs/2026-08-15-gateway-scale-to-zero-design.md`

정책:

- 기본 실행은 preview
- 실제 변경은 `--apply --confirm-target PROJECT/REGION/SERVICE`가 모두 있어야 가능
- 서비스뿐 아니라 리비전·태그·과금·자원·Ready 상태를 fail-closed 검증
- 배포 후 drift 검증을 필수 절차로 사용

권장 검증 명령:

```bash
npm run cloud-run:verify-scale-zero -- \
  --project gen-lang-client-0321430669 \
  --region asia-northeast3 \
  --service realtime-noel-media-gateway
```

## 5. 웹앱 수정 요청

웹앱 담당자는 다음 항목을 완료해야 한다.

### 필수 UI

- [ ] 출력 모드 선택 UI를 제거하고 항상 “실시간 번역 자막”으로 표시
- [ ] 음성 제공자, 음성 선택, 번역 음량, 음성 재생 상태 UI 제거
- [ ] 기본 시청자 수를 200으로 표시
- [ ] 200명 초과 입력 차단 및 한국어 오류 표시
- [ ] 언어는 1~3개, 중복 선택 금지
- [ ] 호스트 오디오 입력 안내를 “한 기기의 마이크 또는 USB 믹서 중 하나”로 표시
- [ ] 예약 행사에 “시작 60분 전 서버 준비” 상태 표시
- [ ] 준비 완료, 준비 중, 준비 실패를 Gateway health/WebSocket 상태와 구분하여 표시

### 필수 API

- [ ] create/update payload의 `outputMode`는 생략하거나 `captions`만 전송
- [ ] `captions_audio`, `audio`, voice 관련 필드 전송 제거
- [ ] `maxViewers` 기본값 200
- [ ] 예약 시각은 timezone이 포함된 ISO 문자열로 전송
- [ ] viewer는 media/control payload를 전송하지 않고 subscribe만 수행

### 오류 처리

- [ ] `MULTIPLE_HOST_AUDIO_SOURCES_FORBIDDEN`: “이미 선택한 호스트 입력과 다른 오디오가 감지되었습니다”
- [ ] `SESSION_AUDIO_LIMIT_EXCEEDED`: “2시간 오디오 제한에 도달했습니다”
- [ ] `LIVE_GATEWAY_URL_REQUIRED`: 서버 설정 누락 안내
- [ ] `LIVE_GATEWAY_PREWARM_TIMEOUT`: 예약 준비 실패 및 수동 재시도 제공

## 6. 데스크톱 호스트 프로그램 수정 요청

호스트 프로그램 담당자는 다음 계약을 적용해야 한다.

### 오디오 입력

- [ ] 한 Live Call당 입력 source를 한 번만 선택
- [ ] source 변경이 필요하면 기존 stream을 종료하고 세션을 명시적으로 재시작
- [ ] 기본은 행사장 믹서의 USB audio interface
- [ ] 16 kHz, mono, PCM16, 20 ms frame 계약 유지
- [ ] viewer/participant 마이크 전송 기능 비활성화
- [ ] `system`과 `mic` 동시 전송 금지

### 자막 출력

- [ ] 원문 interim 자막을 빠르게 표시
- [ ] 번역 언어는 committed 자막만 갱신되어도 정상으로 처리
- [ ] 자막 seq를 언어별로 유지
- [ ] 음성 chunk, audio-control, translated playback 처리 제거 또는 비활성화
- [ ] Gemini Live reconnect UI를 Cloud STT stream 상태와 Gateway 연결 상태로 교체

### 예약 및 상태

- [ ] 브라우저/호스트 프로그램이 닫혀 있어도 서버 cron이 준비하므로 로컬 앱을 T-60분 동안 켜 두도록 요구하지 않음
- [ ] 행사 시작 전 Gateway readiness 확인 버튼 제공
- [ ] 시작 시점에는 host token을 새로 발급하고 WebSocket 연결
- [ ] 종료 시 오디오 stream, WebSocket, 캡션 queue를 명시적으로 종료

## 7. Google Cloud 운영 수정 요청

### Cloud Run

- [ ] exact target 확인: `gen-lang-client-0321430669 / asia-northeast3 / realtime-noel-media-gateway`
- [ ] service min instances = 0
- [ ] service max instances = 1
- [ ] serving 및 tagged revision의 minScale = 0
- [ ] 불필요한 traffic tag 제거
- [ ] request-based CPU 유지
- [ ] 배포 후 verify-scale-zero 실행
- [ ] 실제 Start/Stop 뒤 active instance가 0으로 복귀하는지 확인

### Gemini/Generative Language API

- [ ] `Gemini API Key 2`의 호출 출처를 운영 Gateway로 제한
- [ ] API key application/API restriction 설정
- [ ] 월 예산 및 50/80/100% 알림 설정
- [ ] Gemini Live audio input/output SKU가 0인지 일별 확인
- [ ] Flash input/output 토큰을 행사별로 관측
- [ ] 앱 차원의 비용 kill switch 설계 및 적용
- [ ] caption polish는 `selective`만 허용하고 `full` 비율은 0 유지

### Cloud Speech-to-Text

- [ ] Gateway service account에 필요한 최소 Speech 권한만 부여
- [ ] 실제 사용하는 Google Cloud 프로젝트와 결제 계정 확인
- [ ] 한 행사에서 streaming recognize stream 수가 1인지 측정
- [ ] 2시간 stream rollover 및 최종 자막 유실 여부 실증
- [ ] 인식 언어 후보가 최대 3개를 넘지 않도록 환경 설정 확인

## 8. 비용 및 장애 방지 수용 기준

배포는 다음 조건을 모두 만족해야 완료로 본다.

### 기능 기준

- [ ] 호스트 기기 1대에서 2시간 연속 오디오 입력 가능
- [ ] 3개 언어 자막 정상 표시
- [ ] 200명 동시 viewer가 subscribe-only로 동작
- [ ] viewer binary media 전송은 거부
- [ ] 다른 호스트 audio source 혼입은 거부
- [ ] interim은 원문 언어에만 표시
- [ ] committed 자막은 최대 2개 목표 언어로 번역
- [ ] 종료 후 회의 기록과 요약 생성 가능

### 비용 기준

- [ ] Gemini Live 세션 수 = 0
- [ ] Gemini Live audio input token = 0
- [ ] Gemini Live audio output token = 0
- [ ] Cloud STT stream 수 = 행사당 1
- [ ] Gemini 텍스트 번역 호출 수는 `확정 문장 수 × 원문을 제외한 표시 언어 수` 이내
- [ ] 참여자 수 증가가 Google 모델 세션 수를 증가시키지 않음
- [ ] 행사와 예약 준비가 없을 때 Cloud Run active instance = 0

### 성능 기준

- [ ] T-60분 준비 요청 성공
- [ ] T0 첫 host WebSocket 연결 시간 기록
- [ ] 원문 interim 표시 지연 기록
- [ ] committed 원문 및 번역 자막 지연 기록
- [ ] 2시간 동안 caption seq 누락·역전 없음
- [ ] 200 viewer 부하에서 Gateway slow-consumer 방어 정상

## 9. 검증 현황

이번 자막 전용 변경에서 확인한 항목:

- `media-gateway/test/captions-only-live-call.test.js`
  - 운영 의존성에 Gemini Live가 없는 계약
  - STT stream 1개
  - audio publish 금지
  - interim 번역 호출 0회
  - 3개 final caption lane
  - 다른 host source 혼입 차단
- `media-gateway/test/rolling-speech-session.test.js`
  - partial transcript 전달
  - rollover 중복 억제
- `webapp/lib/live/gateway-prewarm.test.ts`
  - 대상 예약이 없을 때 health 요청 0회
  - T-60분 예약이 있을 때 정확한 `/health` 호출
  - 엄격한 Gateway URL 검증
- `webapp/components/live/scheduled-gateway-start.test.ts`
  - 기본 T-60분 브라우저 백업 웜업
  - 명시적 `false` opt-out
- `webapp/lib/live/live-service.test.ts`
  - Supabase 예약 범위의 명시적 AND 필터

검증 명령:

```bash
cd media-gateway && npm test
cd webapp && npm run typecheck
cd webapp && npm run test:live
cd webapp && npm run test:core
cd webapp && npm run build
cd .. && git diff --check
```

이 문서 작성 시점의 최신 상태:

- Media Gateway 전체: **478/478 통과**
- Webapp live: **503/503 통과**
- Webapp core: **68/68 통과**
- Webapp TypeScript `tsc --noEmit`: 통과
- Next.js production build: 통과, `/api/internal/live-gateway-prewarm` 포함 확인
- Cloud Run scale-to-zero 계약: **5/5 통과**
- `git diff --check`: 통과
- 루트 전체 테스트: **1,332 통과, 1 실패, 1 skip**
  - 유일한 실패는 코드 assertion이 아니라 샌드박스에서 Chrome debug port를 기다리다 timeout된 `test/browser-smoke.test.js`
  - 자막 전용 Gateway 및 Webapp 단위·계약·빌드 검증은 모두 통과

## 10. 아직 완료되지 않은 운영 작업

다음은 코드 또는 조사만 끝났고 운영 완료로 표시하면 안 된다.

- 이번 STT→텍스트 번역 파이프라인의 Cloud Run 배포
- `LIVE_GATEWAY_URL`, `CRON_SECRET` 운영 환경 변수 설정
- Vercel Cron 운영 호출 확인
- Gemini 프로젝트 예산 50/80/100% 알림 생성
- 애플리케이션 비용 kill switch
- API key restriction 최종 설정
- 200명·2시간 실제 부하 실증
- 행사 종료 후 Cloud Run scale-to-zero 복귀 관측
- Google Billing 보고 지연 이후 8월 비용 재확인

## 11. 배포 순서

1. 변경 파일 review 및 전체 테스트 통과
2. Gemini/Cloud Speech 권한과 프로젝트 경계 확인
3. Webapp에 `LIVE_GATEWAY_URL`, `CRON_SECRET` 설정
4. Vercel Cron endpoint를 staging에서 수동 호출
5. Cloud Run Gateway staging 배포
6. 한 호스트, 3개 언어, 소수 viewer로 15분 smoke test
7. Billing metrics에서 Gemini Live audio SKU 0 확인
8. 200 viewer, 2시간 soak test
9. 운영 Cloud Run exact target 재확인
10. 운영 배포
11. 예약 행사 T-60분 health 요청과 T0 연결 확인
12. Stop 후 active instance 0 복귀 확인
13. 다음 날 Billing에서 STT·Flash·Live SKU 분리 확인

## 12. 롤백 원칙

- 운영 장애 시 이전 Gateway 이미지로 되돌릴 수 있으나, `min=0`, `max=1` 정책은 유지한다.
- 롤백 시에도 public API는 `captions`만 허용한다.
- 비용 문제 때문에 Gemini Live AUDIO 경로를 운영에서 다시 주입하지 않는다.
- STT 장애 시 자동으로 Gemini Live AUDIO로 fallback하지 않는다. 자막 기능을 명시적으로 실패시키고 운영자에게 알린다.
- 예약 cron 장애 시 호스트의 수동 readiness 요청을 사용하되 상시 최소 인스턴스로 임시 전환하지 않는다.

## 13. 관련 증거와 변경 이력

Gemini 비용 증가와 겹치는 주요 Git 이력:

- `8ed4b98` (2026-07-25): `feat: land the live translation subtitle product`
- `8f4d650` (2026-07-26): `fix(captions): allow full quality polish budget`
- `54080ba` (2026-07-27): `fix(live-call): unify caption pipeline and prepare Seoul release`
- `25707a7` (2026-07-30): `feat: stabilize Gemini live translation`

로컬 조사 증거 이미지:

- Gemini 7월 SKU: `/Users/kyeongmankim/.aside/u/0/sessions/2026-08-21_BCtssyAqlIbBLnLn/tmp/gemini-july-sku-breakdown.png`
- Cloud Run 최소 인스턴스 SKU: `/Users/kyeongmankim/.aside/u/0/sessions/2026-08-21_BCtssyAqlIbBLnLn/tmp/billing-cloud-run-min-instance-skus.png`
- API와 Cloud Run 예산 비교: `/Users/kyeongmankim/.aside/u/0/sessions/2026-08-21_BCtssyAqlIbBLnLn/tmp/billing-budgets-api-vs-cloud-run.png`

Google Cloud Billing은 2026-08-19 이후 일부 보고 지연을 공지했으므로, 최신 비용 0원 표시는 확정값으로 간주하지 않는다.
