# Realtime Noel Wiki

문서 기준일: 2026-06-18  
대상 제품: Realtime Noel macOS 데스크톱 앱  
현재 초점: 발표, 회의, 데모 환경의 실시간 양방향 번역 자막

## 1. 제품 정의

Realtime Noel은 macOS에서 시스템 오디오와 마이크 음성을 동시에 캡처하고, 영어와 한국어를 실시간 양방향으로 번역해 화면 위 자막 오버레이로 보여주는 데스크톱 앱이다.

핵심 목표는 발표자가 발표나 데모 조작에 집중하는 동안, 청중이 언어 장벽 없이 같은 흐름을 따라가도록 만드는 것이다. 단순 텍스트 번역기, 회의록 앱, 녹음 앱이 아니라 발표 현장에서 필요한 입력 캡처, 언어 판정, 번역, 자막 표시, 기록 정리, 권한 진단을 하나의 흐름으로 묶는 실시간 자막 인프라를 지향한다.

기존 코드베이스에는 Excalidraw 기반 화이트보드 에이전트 기능이 남아 있지만, 현재 기획의 중심은 `Realtime Noel Subtitles` 데스크톱 앱이다.

## 2. 기획 배경

발표와 회의 현장에서는 다음 문제가 반복된다.

- 한국어와 영어가 섞이면 기존 번역 앱이 번역 방향을 자주 잘못 잡는다.
- 발표자의 마이크와 회의/영상의 시스템 오디오를 동시에 들어야 하지만, 한쪽만 캡처되면 맥락이 끊긴다.
- macOS의 마이크, 화면 기록, 시스템 오디오 권한이 분리되어 있어 사용자가 권한을 켰다고 생각해도 실제 앱에는 권한이 없는 경우가 많다.
- 자막 오버레이가 앱 종료 뒤에도 남거나, 상태 메시지가 실제 자막을 덮으면 발표를 방해한다.
- 번역 기록이 raw log처럼 쌓이면 발표 후 다시 찾거나 공유하기 어렵다.
- 호텔 투자, F&B 임대차, 비즈니스 회의처럼 전문 용어가 많은 환경에서는 일반 번역 품질만으로 부족하다.

Realtime Noel은 이 문제를 다음 방향으로 해결한다.

- 로컬 오디오 캡처가 성공한 뒤에만 번역 세션을 연다.
- 시스템 오디오와 마이크를 병렬로 캡처하고, 실패한 입력은 timeout 후 격리한다.
- 영어와 한국어 target channel을 동시에 열어 입력 언어와 출력 언어를 검증한다.
- 문장 중간 언어 전환을 source transcript delta 기반으로 재판정한다.
- 오버레이는 켜기/끄기, 위치, 크기, 잔상 제거를 제품 기능으로 다룬다.
- 완료된 번역만 날짜별 기록에 저장한다.
- 전문 용어집과 비즈니스 톤 보정 레이어를 commit 단계에 적용한다.

## 3. 대상 사용자

주요 사용자는 다음과 같다.

- 한국어와 영어를 섞어 말하는 발표자
- 해외 청중이 있는 데모 진행자
- 화상회의, 웨비나, 컨퍼런스에서 실시간 자막이 필요한 사용자
- 발표 후 번역 기록을 날짜별로 다시 확인해야 하는 사용자
- 호텔 투자, 부동산, F&B 임대차, 자산운용 등 전문 용어가 많은 회의를 진행하는 사용자

## 4. 제품 범위

### 포함 범위

- macOS Electron 데스크톱 앱
- 시스템 오디오, 마이크, 시스템+마이크 입력 모드
- 영어와 한국어 양방향 실시간 번역
- OpenAI Realtime Translation 기본 지원
- Gemini Live Translation 선택 지원
- 항상 위 자막 오버레이
- 다중 디스플레이 오버레이
- 오버레이 켜기/끄기
- 자막 위치, 크기, 투명도, 최대 줄 수 설정
- 날짜별 번역 기록
- CSV export
- 로컬 Ollama 기반 주제 분류 옵션
- 전문 용어집 preset
- 비즈니스 톤 polish
- OpenAI/Gemini API key 저장 및 등록 상태 표시
- macOS 권한 실패 진단 메시지
- DMG 빌드

### 제외 범위

- 클라우드 계정 시스템
- 팀 공유 워크스페이스
- 모바일 앱
- 서버 배포형 SaaS
- 원격 사용자 간 동기화
- 회의 플랫폼 플러그인
- 완전한 오프라인 번역
- 자동 결제/과금 관리

## 5. 핵심 사용자 흐름

### 첫 실행

1. 사용자가 `Realtime Noel.app`을 실행한다.
2. 앱은 로컬 서버를 `127.0.0.1:3210` 또는 사용 가능한 포트로 시작한다.
3. Electron dashboard window가 `/subtitle.html`을 연다.
4. 앱은 macOS 마이크 권한을 사전 요청한다.
5. 사용자는 OpenAI 또는 Gemini API key를 저장한다.
6. key는 저장 후 다시 클라이언트로 반환하지 않고, 등록 여부만 badge로 표시한다.
7. 사용자는 입력 모드, 언어쌍, 자막 스타일, 기록 옵션을 확인한다.

### 정상 번역

1. 사용자가 `Start`를 누른다.
2. 앱은 먼저 선택된 입력을 캡처한다.
3. `system_mic`이면 시스템 오디오와 마이크 캡처를 병렬로 시도한다.
4. 성공한 입력이 하나 이상 있을 때만 `subtitle:start`를 서버로 보낸다.
5. 서버는 번역 provider별 realtime websocket을 연다.
6. 입력 audio frame은 source별, target language별 채널에 전달된다.
7. source transcript로 입력 언어를 판정한다.
8. output transcript가 target language와 맞는 경우에만 partial subtitle을 표시한다.
9. commit timer가 지나면 최종 문장을 용어집과 톤 보정에 통과시킨다.
10. 완료 자막은 dashboard, overlay, history에 반영된다.

### 실패와 fallback

- 시스템 오디오 캡처가 8초 안에 응답하지 않으면 해당 source만 실패로 표시하고 가능한 입력으로 시작한다.
- 마이크 권한이 없거나 장치가 실패하면 시스템 오디오만으로 시작할 수 있다.
- 모든 입력이 실패하면 번역 세션을 열지 않고 사용자에게 원인을 표시한다.
- OpenAI/Gemini websocket이 끊기면 로컬 캡처는 유지하고 다음 audio frame에서 재연결 상태로 복구한다.
- 앱 종료, stop, idle 상태에서는 overlay text를 즉시 비운다.

## 6. 주요 기능

### 6.1 오디오 입력

지원 입력 모드:

| 모드 | 의미 | 사용 상황 |
|---|---|---|
| `system_mic` | 시스템 오디오와 마이크 동시 입력 | 발표자 음성 + 회의/영상 소리 모두 필요 |
| `system` | 시스템 오디오만 입력 | Zoom, 영상, 브라우저 소리 번역 |
| `mic` | 마이크만 입력 | 현장 발표자 음성 번역 |

캡처 정책:

- 오디오 캡처 성공 전에는 번역 API 세션을 열지 않는다.
- source별 capture는 병렬 실행한다.
- renderer capture timeout은 8초다.
- main process의 desktop source timeout은 7초다.
- 늦게 도착한 media stream은 track을 즉시 stop한다.
- AudioContext가 `suspended`이면 사용자 제스처 안에서 `resume()`을 시도한다.
- track muted, ended, level 0 상태를 UI에 표시한다.

### 6.2 번역 provider

지원 provider:

| Provider | 모델 | 역할 |
|---|---|---|
| OpenAI | `gpt-realtime-translate` | 기본 realtime 번역 |
| Gemini | `gemini-3.5-live-translate-preview` | Gemini Live 기반 realtime 번역 |

Provider 공통 원칙:

- 번역 provider는 transport abstraction 뒤에 숨긴다.
- language lock, wrong-direction suppression, commit, polish는 provider와 무관한 공통 pipeline에서 처리한다.
- OpenAI key와 Gemini key는 별도로 저장한다.
- key는 설정 응답에서 제거하고 `hasOpenAIKey`, `hasGeminiKey`만 반환한다.

Gemini 관련 설계:

- Gemini Live 입력은 PCM16 mono 16kHz를 요구한다.
- 앱의 24kHz PCM16 audio는 Gemini transport에서 16kHz로 resample한다.
- `setupComplete`는 `api_ready` 상태로 매핑한다.
- `goAway` 또는 close는 recoverable reconnect로 처리한다.
- target이 일본어이고 Gemini key가 있으면 Gemini로 자동 route할 수 있다.

### 6.3 영어/한국어 양방향 번역

Realtime Noel은 입력 언어를 하나로 고정하지 않는다. 언어쌍이 `en`과 `ko`이면 target language channel을 동시에 연다.

- target `en`: 한국어 입력을 영어로 표시
- target `ko`: 영어 입력을 한국어로 표시

`system_mic` 모드에서는 source 2개와 target 2개를 조합해 최대 4개 채널이 열린다.

중요한 점은 같은 source audio를 두 target channel에 보내되, 실제로 화면에 표시할지는 source/output language gate가 결정한다는 것이다. 이 구조는 한국어로 말하다가 영어로 전환하거나, 영어 회의 중 한국어 멘트를 섞는 상황을 다루기 위한 것이다.

### 6.4 언어 판정

초기 문제는 한글 한 글자 또는 영문자 한 조각만 보고 언어를 판단하면 코드 스위칭 상황에서 방향이 흔들린다는 점이었다.

현재 정책:

- source transcript delta를 별도 buffer에 누적한다.
- 최소 signal character 수를 넘기 전에는 source language를 lock하지 않는다.
- dominant language confidence가 기준 이상일 때만 lock한다.
- source language가 unknown이면 자막 표시를 보류한다.
- 최근 transcript segment 기준으로 언어 전환을 다시 감지한다.
- target output이 target language와 맞지 않으면 표시하지 않는다.
- 긴 output이 unknown 또는 mixed로 판정되면 garbled subtitle로 보고 suppress한다.

핵심 상수:

| 상수 | 현재 값 | 의미 |
|---|---:|---|
| `LANGUAGE_LOCK_MIN_SIGNAL_CHARS` | 4 | source language lock 최소 신호량 |
| `LANGUAGE_LOCK_MIN_CONFIDENCE` | 0.68 | source dominant confidence |
| `OUTPUT_LANGUAGE_JUDGE_MIN_CHARS` | 8 | output language 판정 최소 길이 |
| `OUTPUT_LANGUAGE_MIN_CONFIDENCE` | 0.55 | output gate confidence |
| `SUBTITLE_COMMIT_MS` | 1200 | commit quiet timer |

### 6.5 자막 표시

자막은 두 단계로 표시된다.

- partial: realtime 느낌을 위해 가능한 빨리 overlay/dashboard에 표시
- committed: 발화가 안정된 뒤 용어집과 톤 보정을 적용한 최종 문장

표시 원칙:

- partial은 polish를 거치지 않는다.
- committed만 business tone polish를 거친다.
- 상태 메시지는 fresh subtitle을 덮지 않는다.
- speech가 멈추면 마지막 자막은 길이에 비례해 잠시 유지된 뒤 사라진다.
- stop, idle, websocket disconnect, 앱 종료 시 overlay는 즉시 비워진다.

영화식 자막 유지 시간:

```text
duration = clamp(2000 + 60 * chars, 2500, 7000) ms
```

### 6.6 자막 오버레이

오버레이는 Electron `BrowserWindow`로 생성한다.

주요 속성:

- frame 없음
- transparent background
- focusable false
- skipTaskbar true
- alwaysOnTop true
- `screen-saver` level + 1
- visible on all workspaces
- full screen space에서도 표시
- click-through

다중 디스플레이 정책:

- `screen.getAllDisplays()` 기준으로 display별 overlay window를 하나씩 만든다.
- display added, removed, metrics changed 이벤트에서 overlay window를 재조정한다.
- watchdog이 1초마다 overlay z-order를 재확인한다.
- 앱 focus, macOS active 이벤트에서도 즉시 `moveTop()`을 호출한다.

오버레이 제어:

- dashboard에서 overlay on/off 가능
- off 상태는 settings에 저장된다.
- off로 바꾸면 모든 overlay window를 destroy한다.
- 앱 종료 중에는 watchdog이 overlay를 다시 만들지 못하도록 `isQuitting` guard를 둔다.

### 6.7 번역 기록

기록은 raw audio나 source transcript를 저장하지 않는다. 현재 저장 대상은 완료된 번역문이다.

기록 정책:

- `subtitle:committed`만 저장한다.
- partial은 저장하지 않는다.
- 최대 200개 record를 유지한다.
- 각 record는 날짜, 시간, 입력 source, target language, topic, translated text를 가진다.
- KST 기준 날짜별 그룹으로 정렬한다.
- CSV export를 지원한다.

주제 분류:

- 기본은 heuristic topic이다.
- `recordProvider: "ollama"`이면 로컬 Ollama `/api/chat`으로 짧은 topic label을 생성한다.
- Ollama URL은 localhost만 허용한다.
- 로컬 topic 분류 실패는 기록 저장 자체를 막지 않는다.

### 6.8 용어집과 도메인 학습

Realtime Noel은 전문 분야 번역 품질을 위해 built-in glossary preset을 제공한다.

현재 preset:

- 호텔 투자 `EN↔KO`
- F&B 임차 유치 `KO↔JA`
- 호텔 투자 `EN↔JA`

호텔 투자 preset에는 다음 항목이 포함된다.

- MRG, DSCR, CAPEX, RevPAR, OCC, ADR 등 약어 원문 유지
- C&W, Hilton, TheHyoosik, First Cabin, Timework Myeongdong, NOOn square 표기 고정
- 호텔 투자/운영/개발/자산운용 용어쌍
- 비즈니스 관용 표현
- Hospitality Market Session 2026 발표·패널 토론 문장과 용어

적용 방식:

- 사용자가 preset을 선택하면 glossary, domain, language pair가 함께 채워진다.
- commit 전 `applyGlossaryCorrections()`가 1차 보정한다.
- polish prompt는 glossary를 대칭 용어쌍으로 해석한다.
- glossary에 있는 문장 또는 절 단위 pair는 translation memory처럼 취급한다.

### 6.9 비즈니스 톤 보정

번역 provider의 raw output은 commit 단계에서 선택적으로 polish된다.

적용 조건:

- tone이 `business`인 경우
- glossary가 설정된 경우
- domain이 설정된 경우

원칙:

- partial에는 적용하지 않는다.
- 실패하거나 timeout이면 raw translation을 그대로 사용한다.
- 기본 timeout은 4초다.
- 의미 추가, 삭제, 추론은 금지한다.
- 한국어 output은 번역투를 줄이고 자연스러운 격식체로 다듬는다.
- 영어 output은 professional business English로 다듬는다.
- 일본어 output은 자연스러운 비즈니스 경어로 다듬는다.

## 7. 시스템 아키텍처

```text
macOS user
  |
  | microphone / system audio
  v
Electron app
  |
  | dashboard window
  | overlay windows
  | media permission handler
  | display media handler
  v
Local Express server (127.0.0.1)
  |
  | HTTP
  | - /subtitle.html
  | - /subtitle-overlay.html
  | - /api/config
  | - /api/settings
  | - /api/glossary-presets
  | - /api/subtitles/history
  | - /api/subtitles/history/export.csv
  | - /api/subtitles/openai/validate
  |
  | WebSocket /ws
  | - subtitle:start
  | - subtitle:audio
  | - subtitle:stop
  | - subtitle:partial
  | - subtitle:committed
  | - subtitle:status
  | - subtitle:error
  v
Realtime translation manager
  |
  | source x target channels
  | language lock
  | output gate
  | glossary correction
  | tone polish
  v
Dashboard + overlay + history
```

## 8. 주요 파일

| 파일 | 역할 |
|---|---|
| `electron/main.js` | Electron lifecycle, dashboard/overlay window, macOS media 권한, system audio capture handler |
| `electron/preload.js` | renderer에서 overlay on/off, 권한 설정 열기 IPC 호출 노출 |
| `public/subtitle.html` | subtitle dashboard UI |
| `public/subtitle-dashboard.js` | 설정 저장, audio capture, Web Audio streaming, history render, overlay toggle |
| `public/subtitle-overlay.html` | overlay HTML |
| `public/subtitle-overlay.js` | overlay websocket, subtitle/status render, linger/clear 정책 |
| `public/subtitle.css` | dashboard와 overlay 스타일 |
| `src/server.js` | Express server, websocket relay, settings, key validation, history API |
| `src/subtitle-realtime.js` | realtime translation manager, provider transport, language routing, commit pipeline |
| `src/gemini-live-translate.js` | Gemini Live transport, 24kHz to 16kHz resample, message mapping |
| `src/subtitle-polish.js` | business tone polish prompt와 timeout fallback |
| `src/subtitle-history.js` | 번역 기록 저장, 날짜 그룹, CSV export, topic classification |
| `src/glossary-presets.js` | built-in industry glossary preset |
| `src/settings-store.js` | settings persistence, API key sanitization, subtitle setting validation |
| `docs/glossary-hospitality-2026-06-pairs.txt` | 호텔/호스피탈리티 발표용 용어집 원본 |
| `docs/REALTIME_NOEL_ONE_SLIDE.md` | 한 장짜리 발표 슬라이드용 요약 |
| `docs/PACKAGING.md` | macOS/Windows 패키징 메모 |

## 9. 설정 모델

설정 파일:

```text
~/.config/realtime-noel/settings.json
```

이전 설정 경로는 앱 시작 시 새 경로로 migrate한다. 내부 구현에는 legacy config path를 읽는 코드가 남아 있지만, 사용자에게 노출되는 제품명과 설정 경로는 Realtime Noel 기준이다.

주요 subtitle 기본값:

| 설정 | 기본값 | 의미 |
|---|---|---|
| `inputMode` | `system_mic` | 시스템 오디오 + 마이크 |
| `languagePair` | `{ a: "en", b: "ko" }` | 영어/한국어 |
| `displayMode` | `translation_only` | 번역 자막만 표시 |
| `translationProvider` | `openai` | 기본 provider |
| `model` | `gpt-realtime-translate` | OpenAI realtime 번역 모델 |
| `geminiModel` | `gemini-3.5-live-translate-preview` | Gemini Live 번역 모델 |
| `overlayEnabled` | `true` | overlay 기본 활성화 |
| `recordProvider` | `ollama` | 로컬 topic 분류 |
| `tone` | `natural` | 기본 톤 |
| `tonePolishModel` | `gpt-4o-mini` | commit polish 모델 |
| `maxSubtitleLines` | `3` | overlay 최대 줄 수 |
| `verticalOffset` | `48` | 화면 가장자리 offset |

보안 원칙:

- settings file mode는 `0600`으로 저장한다.
- API key는 `/api/config`, `/api/settings` 응답에 직접 반환하지 않는다.
- 클라이언트에는 등록 여부만 전달한다.
- subtitle glossary와 domain은 길이 제한을 둔다.

## 10. macOS 권한 정책

Realtime Noel이 안정적으로 작동하려면 다음 권한이 필요하다.

- Microphone
- Screen & System Audio Recording
- System Audio Recording Only 항목이 있는 macOS 버전에서는 해당 항목

현재 완화책:

- `appId`는 `com.realtime-noel.app`로 고정한다.
- productName은 `Realtime Noel`로 고정한다.
- Info.plist에 `NSAudioCaptureUsageDescription`, `NSMicrophoneUsageDescription`, `NSScreenCaptureUsageDescription`를 명시한다.
- Electron permission request handler는 trusted local origin의 `media`, `display-capture`만 허용한다.
- 시스템 설정의 Screen Recording 패널을 여는 버튼을 제공한다.
- main process에서 microphone access를 명시적으로 요청한다.
- display media source 조회에는 timeout을 둔다.

주의할 점:

- 개발 실행 중에는 `Electron` 권한 항목이 따로 생길 수 있다.
- 빌드 산출물을 직접 실행하면 `dist/mac-arm64` 경로 기준 권한이 생길 수 있다.
- `/Applications/Realtime Noel.app`로 복사 후 실행하면 권한 경로가 더 안정적이다.
- 현재 ad-hoc signing 상태에서는 새 빌드마다 macOS 권한 항목이 중복될 수 있다.

권장 사용자 안내:

1. `/Applications/Realtime Noel.app`만 실행한다.
2. Privacy & Security에서 `Realtime Noel`의 Microphone 권한을 켠다.
3. `Screen & System Audio Recording`에서 `Realtime Noel` 권한을 켠다.
4. 개발 실행 중이면 `Electron` 항목에도 같은 권한을 켠다.
5. 권한 변경 후 앱을 완전히 종료하고 재시작한다.

## 11. 오류 대응 정책

### 시스템 오디오 시작 실패

대표 메시지:

```text
시스템 오디오를 시작하지 못했습니다: system 캡처가 8초 안에 응답하지 않았습니다.
macOS Privacy & Security에서 Realtime Noel의 Screen & System Audio Recording 권한을 허용한 뒤 앱을 재시작하세요.
개발 실행 중이면 Electron 항목도 같은 권한이 필요합니다.
가능한 입력만으로 시작했습니다.
```

해석:

- 전체 앱 실패가 아니라 system source 실패다.
- mic capture가 성공했다면 mic만으로 계속 진행한다.
- 둘 다 실패하면 start를 중단한다.

### 마이크 silent

가능한 원인:

- Microphone 권한 없음
- 선택된 장치가 실제 입력을 받지 않음
- AudioContext suspended
- track muted
- OS input source 불일치

앱 대응:

- AudioContext resume 시도
- source별 live meter 표시
- mic 권한 안내 메시지 표시
- selected mic 실패 시 system default mic 재시도

### 번역 websocket 오류

가능한 원인:

- API key 없음 또는 잘못됨
- 네트워크 프록시가 websocket upgrade 차단
- provider session close
- Gemini Live preview session limit

앱 대응:

- distinct socket error는 사용자에게 한 번 표시한다.
- HTTP 403/407/302 등 unexpected response는 네트워크 차단으로 안내한다.
- 상태를 `reconnecting`으로 바꾸고 다음 audio frame에서 복구를 시도한다.

## 12. 검증 체계

주요 테스트 범위:

- subtitle setting normalization
- OpenAI Realtime session shape
- Gemini setup message, audio resample, fragment normalization
- provider selection
- Gemini key required error
- EN to KO, KO to EN routing
- delayed source transcript 처리
- wrong-language output suppression
- recent source segment 기반 언어 전환
- stale session audio 무시
- Realtime socket reconnect
- graceful session close
- glossary correction
- business tone polish prompt
- subtitle history date grouping
- CSV export
- Ollama localhost guard
- dashboard capture-before-start
- checking inputs timeout
- AudioContext resume
- overlay idle clear
- overlay on/off
- multi-display overlay window map
- Electron appId, productName, permission metadata

검증 명령:

```bash
npm run typecheck
npm test
git diff --check
npm run dist:mac
```

출시 전 수동 확인:

1. `/Applications/Realtime Noel.app` 실행
2. dashboard가 열리는지 확인
3. `http://127.0.0.1:3210/subtitle.html` 응답 확인
4. OpenAI 또는 Gemini key 등록 badge 확인
5. mic only 번역 확인
6. system only 번역 확인
7. system + mic 동시 입력 확인
8. 한국어 발화 후 영어 자막 확인
9. 영어 발화 후 한국어 자막 확인
10. overlay off 후 화면에서 사라지는지 확인
11. 앱 종료 후 overlay 잔상 없음 확인
12. history가 날짜별로 묶이는지 확인
13. CSV export 확인

## 13. 빌드와 배포

패키지 명:

```text
realtime-noel
```

제품명:

```text
Realtime Noel
```

주요 명령:

```bash
npm run desktop
npm run dist:mac
npm run dist:mac:x64
npm run dist:win
```

현재 빌드 정책:

- macOS arm64 DMG를 우선 검증한다.
- Windows portable target은 존재하지만 현재 주력 검증 대상은 macOS다.
- unsigned/ad-hoc macOS 빌드는 Gatekeeper와 권한 중복 이슈가 남는다.
- 제품 수준 배포에는 Developer ID signing과 notarization이 필요하다.

권장 설치 흐름:

1. `npm run dist:mac`
2. `dist/mac-arm64/Realtime Noel.app`를 `/Applications/Realtime Noel.app`로 복사
3. `/Applications/Realtime Noel.app` 실행
4. macOS Privacy & Security에서 권한 허용
5. 앱 재시작

## 14. 주요 제품 결정

| 결정 | 이유 |
|---|---|
| 제품명은 `Realtime Noel`로 통일 | 이전 제품명 계열의 사용자 노출을 제거하고 현재 제품 목적에 맞춤 |
| 로컬 캡처 성공 전 API 세션을 열지 않음 | 권한 실패 상태에서 비용과 세션을 낭비하지 않기 위해 |
| system/mic 캡처는 병렬 실행 | 한쪽 pending이 전체 start를 막지 않도록 하기 위해 |
| capture timeout을 둠 | macOS permission dialog와 Electron capture pending에 대응 |
| target language channel을 동시에 운용 | 코드 스위칭과 양방향 번역을 안정적으로 처리하기 위해 |
| source language lock 전에는 표시 보류 | 잘못된 방향 자막을 줄이기 위해 |
| partial은 빠르게, commit은 정확하게 | realtime 체감과 전문 번역 품질의 균형 |
| glossary/polish는 commit에만 적용 | partial latency를 악화시키지 않기 위해 |
| overlay는 display별 window로 운용 | 발표자 화면과 외부 모니터 모두에 자막을 표시하기 위해 |
| 기록은 committed translation만 저장 | raw log와 민감 source speech 저장을 피하기 위해 |
| Ollama topic 분류는 localhost만 허용 | 외부 URL 오용과 데이터 유출을 막기 위해 |

## 15. 현재 구현 상태

구현된 항목:

- Realtime Noel 리브랜딩
- macOS Electron 앱 빌드
- subtitle dashboard
- always-on-top overlay
- overlay on/off
- multi-display overlay
- system/mic/system_mic capture mode
- capture timeout과 fallback
- Web Audio resume과 track 진단
- OpenAI API key validation
- Gemini provider 설정과 transport
- EN/KO dual target translation
- source language lock
- recent segment 기반 언어 전환
- wrong-language subtitle suppression
- committed subtitle polish
- built-in glossary preset
- date-grouped translation history
- CSV export
- local Ollama topic classification fallback
- macOS permission description metadata

아직 제품화가 덜 된 항목:

- Developer ID signing
- notarization
- first-run permission wizard
- 앱 내 권한 상태 자동 진단
- 실시간 audio diagnostic dashboard 고도화
- 실제 장치 기반 자동 capture test
- 긴 세션 비용 관리
- provider별 비용 추정
- session 단위 기록 관리
- 번역 기록 검색
- 자동 업데이트

## 16. 로드맵

### Phase 1. macOS 안정화

- Developer ID signing 적용
- notarization 자동화
- `/Applications` 설치 흐름 고정
- 첫 실행 권한 wizard 추가
- Screen & System Audio Recording 설정 바로가기 개선
- 권한 중복 항목 정리 가이드 제공

### Phase 2. 입력 신뢰성

- system/mic live meter 가시성 강화
- source별 capture 상태 로그 export
- 장치 변경 감지
- silent input 장기 지속 시 사용자 경고
- real-device capture smoke test 추가

### Phase 3. 번역 품질

- language lock threshold UI 노출
- punctuation/VAD 기반 turn boundary 개선
- source segment reset 정책 튜닝
- domain glossary preset 추가
- 문장 단위 translation memory 보강
- 호텔/부동산/F&B 외 업종 preset 확장

### Phase 4. 기록과 활용

- 세션별 기록 분리
- 날짜별 검색
- 주제별 자동 요약
- Markdown export
- CSV export column 선택
- 민감 정보 제외 옵션

### Phase 5. 배포 경험

- notarized DMG
- auto-update
- crash/error diagnostics
- 네트워크 프록시 진단
- API 사용량/비용 안내
- 사용자 onboarding checklist

## 17. 리스크

| 리스크 | 영향 | 현재 대응 | 남은 과제 |
|---|---|---|---|
| macOS 권한 중복 | 시스템 오디오 캡처 실패 | appId/productName 고정, 권한 메시지 개선 | Developer ID signing/notarization |
| system capture pending | Start 지연 또는 실패 | main/renderer timeout | 권한 wizard |
| mic silent stream | 번역 미작동 | mic access prompt, AudioContext resume, level 표시 | 장치 진단 강화 |
| 짧은 코드 스위칭 오판 | 잘못된 자막 방향 | language lock, output gate | threshold UI |
| 4개 realtime channel 비용 | API 비용 증가 | source/target 명시, reconnect 제어 | single routing channel 연구 |
| provider preview 변동 | Gemini 동작 변화 | transport abstraction | 실제 wire 검증 자동화 |
| overlay 잔류 | 발표 방해 | idle clear, destroy, quit guard | OS별 장기 테스트 |
| 전문 용어 오역 | 비즈니스 신뢰 저하 | glossary preset, polish | translation memory 확장 |
| 네트워크 프록시 차단 | websocket 연결 실패 | unexpected-response 안내 | 사전 네트워크 진단 |

## 18. 운영 체크리스트

개발자가 새 빌드를 검증할 때:

```bash
npm run typecheck
npm test
git diff --check
npm run dist:mac
```

사용자에게 전달하기 전:

1. DMG 생성 확인
2. 앱을 `/Applications`에 설치
3. 기존 중복 Electron/Realtime Noel 권한 항목 확인
4. Microphone 권한 확인
5. Screen & System Audio Recording 권한 확인
6. mic only 번역 테스트
7. system only 번역 테스트
8. overlay off/on 테스트
9. 앱 종료 후 overlay 잔상 확인
10. history 날짜 그룹 확인

## 19. 한 줄 요약

Realtime Noel은 마이크와 시스템 오디오를 실시간으로 듣고, 영어/한국어 방향을 문장 중간까지 판정한 뒤 반대 언어 자막을 화면 위에 안정적으로 표시하고, 완료된 번역 기록을 날짜별로 정리하는 발표용 실시간 번역 자막 앱이다.
