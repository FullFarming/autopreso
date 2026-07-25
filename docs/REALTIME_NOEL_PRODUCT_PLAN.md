# Realtime Noel Product Plan

문서 기준일: 2026-06-19  
제품: Realtime Noel  
형태: macOS 데스크톱 실시간 번역 자막 앱  
현재 단계: alpha, macOS arm64 DMG 검증 중

## 1. 한 줄 정의

Realtime Noel은 마이크와 시스템 오디오를 동시에 듣고, 선택한 언어들로 실시간 번역 자막을 생성해 화면 위 오버레이와 날짜별 기록으로 남기는 발표·회의용 번역 앱이다.

## 2. 해결하려는 문제

발표, 회의, 데모 환경에서는 번역 품질보다 먼저 입력과 표시 흐름이 깨지는 문제가 반복된다.

- 마이크 소리는 들어오지만 Zoom, 영상, 브라우저 같은 시스템 오디오가 번역되지 않는다.
- 시스템 오디오 권한이 켜진 것처럼 보여도 macOS 권한 항목이 앱 빌드마다 분리되어 실제 캡처가 멈춘다.
- 한국어로 말하다가 영어로 전환하거나, 영어 발화 중 한국어가 섞이면 번역 방향이 흔들린다.
- 영어/한국어만이 아니라 영어, 한국어, 일본어처럼 선택한 3개 언어 모두로 번역해야 하는 상황이 있다.
- 자막 오버레이가 앱 종료 뒤에도 남거나, 사용자가 끄고 싶을 때 바로 사라지지 않으면 발표 화면을 방해한다.
- 번역 기록이 raw log처럼 쌓이면 나중에 다시 찾거나 공유하기 어렵다.
- 호텔 투자, F&B 임대차, 비즈니스 미팅처럼 전문 용어가 많은 영역에서는 일반 번역만으로 신뢰도가 부족하다.

## 3. 제품 방향

Realtime Noel은 단순 텍스트 번역기가 아니라 발표 현장에서 필요한 전체 흐름을 다룬다.

```text
System audio + Microphone
  -> Audio health check
  -> Realtime translation channels
  -> Language detection and output gate
  -> Subtitle overlay
  -> Date-grouped translation history
```

핵심 원칙:

- 입력이 준비되지 않았으면 번역 세션을 열지 않는다.
- 시스템 오디오와 마이크는 독립적으로 캡처하고, 한쪽이 실패해도 가능한 입력으로 계속 진행한다.
- 입력 언어를 고정하지 않고 source transcript를 기준으로 계속 판정한다.
- 선택한 번역 언어가 2개든 3개든, 체크된 언어를 기준으로 target channel을 구성한다.
- partial 자막은 빠르게 보여주고, committed 자막은 용어집과 어투 보정을 거쳐 저장한다.
- 사용자에게 보이는 API key 값은 다시 노출하지 않고 등록 상태만 표시한다.

## 4. 대상 사용자

- 한국어, 영어, 일본어가 섞이는 회의나 발표를 진행하는 사용자
- 해외 청중에게 데모, 웨비나, 컨퍼런스를 진행하는 발표자
- Zoom, 브라우저 영상, 시스템 사운드와 발표자 마이크를 동시에 번역해야 하는 사용자
- 발표 후 번역 기록을 날짜별로 다시 확인해야 하는 사용자
- 호텔 투자, 부동산, F&B 임대차, 자산운용처럼 전문 용어가 많은 회의를 진행하는 사용자

## 5. 현재 제품 범위

### 포함

- macOS Electron 데스크톱 앱
- 시스템 오디오, 마이크, 시스템+마이크 입력 모드
- 영어, 한국어, 일본어 번역 언어 선택
- 체크된 번역 언어 기반 다국어 동시 번역
- OpenAI Realtime Translation
- OpenAI API key 2개 등록과 역할 분리
- Gemini Live Translation 선택 지원
- Gemini key가 있을 때 일본어 target 자동 우회 route
- 항상 위에 표시되는 자막 오버레이
- 오버레이 켜기/끄기
- 자막 위치, 크기, 투명도, 최대 줄 수, 원문 표시 설정
- 날짜별 번역 기록
- CSV export
- 로컬 Ollama 기반 주제 분류
- 비즈니스 톤 보정
- 내장 전문 용어집 preset
- macOS 권한 실패 안내
- DMG 빌드

### 제외

- 클라우드 계정 시스템
- 팀 공유 워크스페이스
- 모바일 앱 네이티브 버전
- 완전한 SaaS 운영 콘솔
- 자동 결제/사용량 과금
- 완전 오프라인 번역
- 회의 플랫폼 플러그인

## 6. 핵심 사용자 흐름

### 6.1 첫 실행

1. 사용자가 `/Applications/Realtime Noel.app`을 실행한다.
2. 앱이 로컬 서버를 `127.0.0.1:3210`에서 시작한다.
3. Electron dashboard가 `subtitle.html`을 연다.
4. 사용자가 macOS Microphone, Screen & System Audio Recording 권한을 허용한다.
5. 사용자가 OpenAI API key와 필요 시 보조 OpenAI API key, Gemini key를 저장한다.
6. 앱은 key 값을 다시 표시하지 않고 등록 여부만 보여준다.
7. 사용자가 입력 모드, Language A/B, Translation languages, topic model, tone, overlay 설정을 확인한다.

### 6.2 정상 번역

1. 사용자가 `Start subtitles`를 누른다.
2. 앱은 먼저 선택된 오디오 입력을 캡처한다.
3. `system_mic` 모드에서는 시스템 오디오와 마이크를 병렬로 캡처한다.
4. 하나 이상의 입력이 성공하면 서버에 `subtitle:start`를 보낸다.
5. 서버는 선택된 source와 target language 조합으로 realtime translation channel을 연다.
6. audio frame은 source별로 target channel에 전달된다.
7. source transcript delta를 누적해 입력 언어를 판정한다.
8. target output이 기대 언어와 맞을 때만 partial 자막을 표시한다.
9. 발화가 안정되면 committed 자막으로 확정한다.
10. committed 자막은 glossary correction과 tone polish를 거쳐 overlay, preview, history에 반영된다.

### 6.3 실패와 fallback

- 시스템 오디오 캡처가 8초 안에 응답하지 않으면 system source만 실패 처리하고 가능한 입력으로 시작한다.
- 마이크 권한이 없거나 장치가 실패하면 시스템 오디오만으로 시작할 수 있다.
- 모든 입력이 실패하면 번역 세션을 열지 않는다.
- websocket 오류는 상태를 `reconnecting`으로 바꾸고 다음 audio frame에서 복구를 시도한다.
- stop, idle, 앱 종료 시 overlay text를 즉시 비운다.

## 7. 주요 기능 결정

### 7.1 입력 모드

| 모드 | 의미 | 사용 상황 |
|---|---|---|
| `system_mic` | 시스템 오디오와 마이크 동시 입력 | 발표자 음성 + 회의/영상 소리 |
| `system` | 시스템 오디오만 입력 | Zoom, 브라우저, 영상 소리 번역 |
| `mic` | 마이크만 입력 | 현장 발표자 음성 번역 |

설계 결정:

- 입력 캡처가 성공하기 전에는 API 번역 세션을 열지 않는다.
- source capture는 병렬 실행한다.
- renderer capture timeout은 8초다.
- Electron main process의 desktop source timeout은 7초다.
- 늦게 도착한 stream은 track을 즉시 stop해 orphan capture를 막는다.

### 7.2 언어와 번역 채널

현재 지원 언어:

- English `en`
- Korean `ko`
- Japanese `ja`

기획 결정:

- Language A/B는 기본 양방향 언어쌍이다.
- Translation languages 체크박스는 실제 target language 목록이다.
- 체크된 언어가 3개면 3개 target 기준으로 번역한다.
- 같은 언어로의 번역은 source language가 판정된 뒤 suppress한다.
- source가 영어이면 한국어/일본어로, source가 한국어이면 영어/일본어로, source가 일본어이면 영어/한국어로 fan-out한다.

### 7.3 Dual OpenAI API key

3개국어 동시 번역에서는 channel 수가 늘어나고 API 부하가 커진다. 이를 위해 OpenAI key를 2개까지 저장할 수 있다.

정책:

- 2개 언어 번역은 primary OpenAI key만 사용한다.
- 모든 언어 동시 번역 또는 3개 target 운용에서는 역할별로 primary/secondary key를 나눈다.
- 예시: 영어 입력과 한국어 입력 출력 role은 API 1, 일본어 관련 출력 role은 API 2처럼 분산한다.
- secondary key가 없어도 기능은 동작하지만, channel 부하와 rate limit 안정성은 낮아질 수 있다.
- key는 settings 응답에서 제거하고 `hasOpenAIKey`, `hasOpenAISecondaryKey`만 반환한다.

### 7.4 Gemini와 일본어

OpenAI realtime translation에서 일본어 output latency가 길거나 출력이 늦는 문제가 관찰되었다. 그래서 일본어 target은 Gemini key가 있을 때 Gemini Live로 route할 수 있다.

정책:

- 사용자가 provider를 Gemini로 선택하면 Gemini를 기본 transport로 사용한다.
- OpenAI provider 상태에서도 일본어 target이고 Gemini key가 있으면 Gemini로 자동 route할 수 있다.
- 3개국어 OpenAI all-language mode에서는 OpenAI project key만 사용하도록 구성한다.
- Gemini Live 입력은 PCM16 mono 16kHz를 요구하므로 앱 내부 24kHz audio를 transport에서 16kHz로 resample한다.

### 7.5 언어 판정

한국어로 말하다가 영어로 전환하는 문제는 단순 target pair만으로 해결되지 않는다. source transcript 자체를 보고 현재 발화 언어를 안정적으로 판정해야 한다.

현재 정책:

- source transcript delta를 별도 buffer에 누적한다.
- 최소 signal character 수 전에는 언어를 lock하지 않는다.
- dominant confidence가 기준 이상일 때만 source language를 확정한다.
- 최근 source segment를 기준으로 언어 전환을 다시 감지한다.
- output text가 target language와 맞지 않으면 표시하지 않는다.
- 긴 output이 mixed 또는 unknown으로 판정되면 화면에 내보내지 않는다.

핵심 상수:

| 상수 | 값 | 의미 |
|---|---:|---|
| `LANGUAGE_LOCK_MIN_SIGNAL_CHARS` | 4 | source language lock 최소 신호량 |
| `LANGUAGE_LOCK_MIN_CONFIDENCE` | 0.68 | source dominant confidence |
| `OUTPUT_LANGUAGE_JUDGE_MIN_CHARS` | 8 | output language 판정 최소 길이 |
| `OUTPUT_LANGUAGE_MIN_CONFIDENCE` | 0.55 | output gate confidence |
| `SUBTITLE_COMMIT_MS` | 1200 | 발화 commit 대기 시간 |

### 7.6 자막 오버레이

오버레이는 dashboard와 독립된 Electron transparent window다.

정책:

- overlay on/off 상태를 settings에 저장한다.
- off로 바꾸면 overlay window를 destroy한다.
- 앱 종료 중에는 watchdog이 overlay를 다시 만들지 않도록 quit guard를 둔다.
- 다중 디스플레이에서는 display별 overlay window를 생성한다.
- overlay는 click-through이며 발표 조작을 막지 않는다.
- 상태 메시지는 실제 자막을 덮지 않도록 최소화한다.

사용자가 제어할 수 있는 항목:

- 오버레이 켜기/끄기
- 자막 위치: 상단, 중앙, 하단
- vertical offset
- 번역 자막 font size
- 원문 같이 표시
- 최대 줄 수
- opacity

### 7.7 기록과 분류

기록 대상은 raw audio나 source transcript가 아니라 완료된 번역문이다.

정책:

- partial은 저장하지 않는다.
- committed translation만 저장한다.
- KST 기준 날짜별로 그룹화한다.
- 최대 200개 record를 유지한다.
- CSV export를 지원한다.
- topic model은 로컬 Ollama를 기본 옵션으로 둔다.
- Ollama topic 분류 실패는 기록 저장 자체를 막지 않는다.
- Ollama URL은 localhost만 허용한다.

### 7.8 전문 용어와 어투

지원 preset:

- 호텔 투자 EN/KO
- F&B 임차 유치 KO/JA
- 호텔 투자 EN/JA

적용 방식:

- preset을 선택하면 glossary, domain, language pair가 함께 채워진다.
- partial에는 glossary/tone polish를 무겁게 적용하지 않는다.
- committed 자막에 `applyGlossaryCorrections()`를 먼저 적용한다.
- tone이 `business`이거나 glossary/domain이 있으면 tone polish를 적용한다.
- polish 실패 또는 timeout 시 raw translation을 그대로 사용한다.

## 8. UI 기획

현재 dashboard는 발표 중 빠르게 조작하는 도구 화면이다. 마케팅 페이지가 아니라 작업 표면이어야 한다.

화면 구성:

- 상단: 현재 세션 상태와 provider 상태
- 빠른 설정: Input, Language A, Language B, Translation languages, Topic model, Tone
- Audio sources: system/mic 입력 label, live meter, 상태
- Primary actions: Start subtitles, Stop
- Session options: Subtitle overlay, 원문 같이 표시
- Overlay position controls
- Caption preview
- Topics
- Recent history
- Settings drawer

최근 UI 정돈 결정:

- Translation languages 라벨이 잘리지 않도록 pill 형태로 정리한다.
- 숨겨진 `translateAllLanguages` 내부 옵션은 화면에 노출하지 않는다.
- Subtitle overlay와 원문 표시 옵션은 큰 카드가 아니라 낮은 2열 옵션 행으로 정리한다.
- 좁은 창에서는 모든 설정이 한 열로 자연스럽게 내려간다.
- 오디오 상태는 사용자에게 필요한 상태만 보여주고, 불필요한 raw 상태 문구는 줄인다.

## 9. 시스템 아키텍처

```text
macOS
  |
  | microphone / system audio
  v
Electron main process
  | dashboard window
  | overlay windows
  | permission handler
  | display media handler
  v
Local Express server
  | HTTP: dashboard, overlay, config, settings, history
  | WebSocket: subtitle control, audio frames, status, partial, committed
  v
Subtitle realtime manager
  | source x target channels
  | OpenAI / Gemini transport
  | source language coordinator
  | output language gate
  | glossary correction
  | tone polish
  v
Dashboard preview + overlay + history
```

주요 파일:

| 파일 | 역할 |
|---|---|
| `electron/main.js` | Electron lifecycle, macOS 권한, dashboard/overlay window |
| `electron/preload.js` | renderer에 안전한 IPC API 노출 |
| `public/subtitle.html` | 자막 dashboard UI |
| `public/subtitle.css` | dashboard와 overlay 스타일 |
| `public/subtitle-dashboard.js` | 설정 저장, audio capture, Web Audio streaming, history render |
| `public/subtitle-overlay.js` | overlay websocket, subtitle render, linger/clear |
| `src/server.js` | Express, WebSocket, settings, key validation, history API |
| `src/subtitle-realtime.js` | realtime translation manager와 language routing |
| `src/gemini-live-translate.js` | Gemini Live transport와 resample |
| `src/subtitle-polish.js` | business tone polish |
| `src/subtitle-history.js` | date-grouped history, CSV export, topic classification |
| `src/settings-store.js` | settings persistence, API key sanitization |
| `src/glossary-presets.js` | built-in glossary presets |

## 10. 설정 모델

설정 파일:

```text
~/.config/realtime-noel/settings.json
```

주요 설정:

| 설정 | 기본값 | 의미 |
|---|---|---|
| `inputMode` | `system_mic` | 시스템 오디오 + 마이크 |
| `languagePair` | `{ a: "en", b: "ko" }` | 기본 언어쌍 |
| `translationLanguages` | `["en", "ko"]` | 실제 번역 target 언어 |
| `translationProvider` | `openai` | 기본 번역 provider |
| `model` | `gpt-realtime-translate` | OpenAI realtime 번역 모델 |
| `geminiModel` | `gemini-3.5-live-translate-preview` | Gemini Live 번역 모델 |
| `overlayEnabled` | `true` | overlay 기본 활성화 |
| `showSourceText` | `false` | 원문 같이 표시 여부 |
| `recordProvider` | `ollama` | 로컬 topic 분류 |
| `ollamaModel` | `gemma3n:e2b` | topic model |
| `tone` | `natural` | 번역 어투 |
| `tonePolishModel` | `gpt-4o-mini` | commit polish 모델 |
| `verticalOffset` | `48` | 화면 가장자리 offset |

API key:

- `openai`
- `openaiSecondary`
- `gemini`

보안 원칙:

- settings file은 `0600` mode로 저장한다.
- API key는 클라이언트 응답에 반환하지 않는다.
- 클라이언트에는 key 등록 여부만 전달한다.
- glossary와 domain은 길이 제한을 둔다.

## 11. macOS 권한과 패키징

필요 권한:

- Microphone
- Screen & System Audio Recording
- macOS 버전에 따라 System Audio Recording Only

현재 정책:

- `appId`: `com.realtime-noel.app`
- `productName`: `Realtime Noel`
- `NSAudioCaptureUsageDescription` 명시
- `NSMicrophoneUsageDescription` 명시
- `NSScreenCaptureUsageDescription` 명시
- trusted local origin의 `media`, `display-capture`만 허용
- 화면 및 시스템 오디오 설정 패널 열기 버튼 제공

권장 실행 방식:

1. DMG 또는 빌드된 app을 `/Applications/Realtime Noel.app`로 설치한다.
2. Privacy & Security에서 Realtime Noel의 Microphone 권한을 켠다.
3. Screen & System Audio Recording 권한을 켠다.
4. 개발 실행 중이면 Electron 항목도 같은 권한을 켠다.
5. 권한 변경 후 앱을 완전히 종료하고 다시 실행한다.

남은 제품화 과제:

- Developer ID signing
- notarization
- first-run permission wizard
- 중복 권한 항목 안내 개선
- 실제 장치 기반 system audio smoke test

## 12. 현재 구현 상태

완료:

- Realtime Noel 리브랜딩
- macOS Electron 앱 빌드
- subtitle dashboard
- 최근 UI 정돈
- always-on-top overlay
- overlay on/off
- 앱 종료 시 overlay 잔상 방지
- multi-display overlay
- system/mic/system_mic capture mode
- capture timeout과 fallback
- AudioContext resume과 track 진단
- audio source live meter
- OpenAI key validation
- secondary OpenAI key 저장과 상태 표시
- Gemini provider 설정과 transport
- EN/KO/JA 선택 언어 기반 translation channel
- 3개 언어 동시 번역 설정
- source language lock
- recent source segment 기반 언어 전환
- wrong-language subtitle suppression
- committed subtitle polish
- built-in glossary preset
- date-grouped translation history
- CSV export
- local Ollama topic classification fallback
- macOS permission metadata
- macOS arm64 DMG 빌드

최근 검증:

- `npm run typecheck` 통과
- `npm test` 통과, 343개 중 342 pass, 1 skip
- `npm run dist:mac` 통과
- `/Applications/Realtime Noel.app` 설치 및 실행 확인
- `http://127.0.0.1:3210/subtitle.html` 응답 확인

## 13. 로드맵

### Phase 1. macOS 안정화

- Developer ID signing
- notarization 자동화
- first-run permission wizard
- 권한 상태 자동 진단
- system audio 권한 중복 항목 정리 안내
- 실제 장치 기반 캡처 테스트

### Phase 2. 번역 안정성

- 3개국어 동시 번역 장시간 테스트
- dual OpenAI key rate-limit 관찰
- 일본어 target provider routing 튜닝
- source language lock threshold 조정 UI
- punctuation/VAD 기반 turn boundary 개선
- 장시간 세션 memory와 reconnect 안정성 점검

### Phase 3. 기록 활용

- 세션별 기록 분리
- 날짜별 검색
- 주제별 필터
- Markdown export
- 기록 삭제/보관 정책
- 민감 정보 제외 옵션

### Phase 4. 전문 분야 확장

- 호텔/부동산/F&B 외 업종 preset 추가
- 사용자 glossary import/export
- 문장 단위 translation memory 강화
- 회의별 domain profile 저장

### Phase 5. 배포 경험

- notarized DMG
- auto-update
- crash/error diagnostics
- proxy/network preflight
- API 사용량과 비용 안내
- 사용자 onboarding checklist

## 14. 리스크와 대응

| 리스크 | 영향 | 현재 대응 | 남은 과제 |
|---|---|---|---|
| macOS 권한 중복 | system audio 캡처 실패 | appId/productName 고정, 권한 메시지 개선 | signing/notarization |
| capture pending | Start 지연 | renderer/main timeout | permission wizard |
| mic silent stream | 번역 미작동 | AudioContext resume, level meter | 장치 진단 강화 |
| 코드 스위칭 오판 | 잘못된 방향 자막 | source lock, output gate | threshold UI |
| 3개국어 channel 비용 | API 비용 증가 | dual key 분산 | 비용 표시와 rate-limit 테스트 |
| 일본어 output latency | 실시간성 저하 | Gemini route | provider별 품질 평가 |
| overlay 잔류 | 발표 방해 | on/off, destroy, quit guard | 장기 OS 테스트 |
| 전문 용어 오역 | 비즈니스 신뢰 저하 | glossary, tone polish | translation memory 확장 |
| proxy/websocket 차단 | 번역 연결 실패 | 오류 안내, proxy env 지원 | 네트워크 preflight |

## 15. 출시 전 체크리스트

개발 검증:

```bash
npm run typecheck
npm test
npm run dist:mac
```

수동 검증:

1. `/Applications/Realtime Noel.app` 실행
2. dashboard 열림 확인
3. OpenAI primary/secondary key 등록 상태 확인
4. Gemini key 등록 상태 확인
5. mic only 번역 확인
6. system only 번역 확인
7. system + mic 동시 입력 확인
8. 한국어 발화 후 영어/일본어 자막 확인
9. 영어 발화 후 한국어/일본어 자막 확인
10. 일본어 발화 후 영어/한국어 자막 확인
11. overlay off 후 화면에서 즉시 사라지는지 확인
12. 앱 종료 후 overlay 잔상 없음 확인
13. 날짜별 history 확인
14. CSV export 확인

## 16. 최종 메시지

Realtime Noel의 핵심은 "말하는 모든 입력을 안정적으로 듣고, 언어 전환을 따라가며, 발표 화면 위에 바로 보이는 번역 자막으로 만드는 것"이다. 현재 기획의 우선순위는 기능 추가보다 macOS 입력 안정성, 3개국어 번역 품질, 오버레이 제어, 날짜별 기록의 사용성을 제품 수준으로 끌어올리는 데 있다.
