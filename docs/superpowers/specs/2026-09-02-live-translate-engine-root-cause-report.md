# 자막·Live Call 번역 붕괴와 지연의 근본원인 조사 (2026-09-02)

조사일: 2026-09-02 KST. 대상: 사용자 보고 "로컬 캡션은 속도감은 있지만 병목이 느껴짐 / Live Call은 번역이 완전히 잘못되고 자막 흐름이 이상함".

상태: **근본원인 확정, 수정 미착수.** 수정은 엔진 선택(아래 §5)을 사용자가 결정한 뒤 진행한다. 이 조사에서 유료 API 호출, 배포, 설정·DB 변경은 하지 않았다.

## 1. 지금 실제로 돌고 있는 구조

8/31 밤(KST 9/1 03:00) 배포와 NOVA.app 재설치로 **두 경로 모두** 캡션 엔진이 바뀌었다.

| 경로 | HEAD 커밋(82db9e9, 8/31 오후 배포 `caption-debug-20260831`) | 현재 운영 (워킹트리 = `live-input-20260901` 리비전 = 설치된 NOVA.app) |
|---|---|---|
| 원문(STT) | `gemini-3.5-transcribe-live` + `STT_LANGUAGE_CODES=ko-KR,en-US,ja-JP` 언어 제약 | `gemini-3.5-live-translate-preview`의 `inputTranscription` (언어 자동 감지, 힌트 불가) |
| 번역 | 확정 원문 → Flash 텍스트 번역 1회 (6s 예산, 모델 폴백 체인) | 같은 Live Translate 연결의 `outputTranscription` (생성된 번역 **음성**의 전사) |
| 연결 수 | 입력당 STT 1개 + 텍스트 요청 | 입력 × 대상언어 만큼 Live 연결. 로컬 `system_mic` + en/ko = **4개**, 게이트웨이 en/ko = 2개, 각 연결이 음성을 생성·과금 |
| 원문↔번역 대응 | 1:1 (같은 확정 문장을 번역) | 없음 — 코드 자체가 `exactSourceCorrespondence: false`, `sourceCorrespondence: "unverified"` |

해당 코드: 게이트웨이 조립 `media-gateway/src/server.js:316` (`createLiveTranslationSession` → `GeminiLiveTranslateAdapter`, `echoTargetLanguage: true`), 세션 `media-gateway/src/direct-live-translation-session.js`, 데스크톱 `src/subtitle-realtime.js` `createDirectTranslationLane` + `src/gemini-live-translate.js` (`echoTargetLanguage: false`).

git 이력: 7/23~7/25에 Live Translate 직접 엔진으로 출발 → 8/31 `c4f0007`에서 Transcribe+텍스트 번역으로 전환 → 8/31 밤 워킹트리에서 다시 직접 엔진으로 복원(`2026-09-01-historical-caption-restoration.md`). 즉 지금 증상은 7월에 겪었던 것과 같은 계열이다.

## 2. Live Call "번역이 완전히 잘못됨" — 확정 증거 (Supabase 운영 DB)

세션 `00cd7322` (9/1 10:05 KST, 게이트웨이 `live-input-20260901`, 호스트 1명 한국어 발화, iPhone 뷰어 1명). `live_source_utterances` = Live Translate `inputTranscription`:

| source_seq | 감지 언어 | 원문 텍스트 |
|---|---|---|
| 1~3 | **ko** | "안내한 것처럼 이제 지금 하는 본체는…" (정상) |
| 4~5 | **zh-Hans** | "这版在,那我也想体验一下这台车。我女排特喜欢。" |
| 6~7 | **vi** | "Thật ra thì cái này nó cũng khá là tương đối thôi…" |

한국어 음성 구간 4~7을 모델이 **중국어·베트남어로 오인식**했고, 같은 구간의 번역 lane 출력은 그 오인식을 그대로 번역했다.

| lane | seq | 뷰어가 본 텍스트 |
|---|---|---|
| en | 4 | "This version is out, and I want to experience this car. I'm a big fan of the women's volleyball team…" |
| ko | 3 | "이 버전은, 저도 사실 찍고 싶었는데, 여자 배구는 아마 안 될 것 같아요." |
| ko | 5 | "사실 그 발전은 기술의 발전은 아마도 어떤 것이냐면…" (vi 오인식의 한국어 번역) |

ko lane은 `echoTargetLanguage: true`라 원래는 한국어 발화를 그대로 되돌려 줘야 하지만, 모델이 입력을 중국어로 판단하면 "중국어→한국어 번역"이 되어 발표자 말과 무관한 한국어가 뷰어에 뜬다. **원문 문제이자 번역 문제이며, 둘 다 같은 모델의 언어 자동 감지가 원인이다.**

두 번째 세션 `a5e2dcd3` (8/31 17:27Z, `models-20260901`)도 같은 계열: ko lane "어머니를 보내드린지 얼마 안 됐어", en lane "Oh, you can't go in first. Everyone else is already there." 같은 환각 출력이 나왔고, 사용자 본인이 발화 중 "갑자기 번역이 이렇게 됐죠? 번역 자체가 지금 이상한 거 같은데", "자막이 생성되는 것처럼 라이브처럼 적히는 느낌이 안 나는 거 같아요"라고 말한 것이 그대로 기록돼 있다.

API 계약 확인 (공식 Live Translate 가이드, 2026-09-02 조회): `translationConfig`는 `targetLanguageCode`, `echoTargetLanguage` **두 필드만** 있고 소스 언어 힌트 필드가 없다. 응답 모달리티는 AUDIO만 허용. 즉 **앱 코드로 이 오인식을 막을 수단이 없다.** 반면 HEAD의 Transcribe Live 경로는 `languageCodes`로 인식 언어를 ko/en/ja로 제약한다.

게이트웨이 Cloud Run 로그에는 WARNING 이상이 0건이다. 모델은 정상 응답을 준 것이고, 내용이 틀렸을 뿐이다. 그래서 로그로는 잡히지 않는다.

## 3. "이상한 자막 흐름" — 구조적 원인

1. **속도 = 음성 생성 속도.** `outputTranscription`은 모델이 *말하는* 번역 음성의 전사다. 9/1 프로브 기록(historical-caption-restoration §5): 입력 4.9s에 첫 번역 텍스트 4.70s. 모델은 번역 가능한 단위가 모일 때까지 기다린 뒤 말하기 속도로 텍스트를 흘린다. 긴 문장이면 발화가 끝난 뒤에도 수 초간 텍스트가 이어진다. Transcribe+텍스트 경로는 원문 partial이 140ms 안정화로 즉시 뜨고 번역이 확정 후 1~3s에 도착하는 구조라 체감이 다르다. 사용자가 말한 "속도감은 있는데 병목이 있는 것 같다"의 실체.
2. **lane 간 독립 분절.** en lane과 ko lane은 별개 모델 인스턴스라 문장 경계·내용이 서로 다르다 (위 표에서 en seq 3과 ko seq 2가 서로 다른 범위를 덮는다).
3. **문장부호 기반 확정만 존재.** 게이트웨이 `boundaryEnd()`와 데스크톱 `onOutput`은 문장부호 뒤 1.2s 정지에만 확정한다. 부호 없이 이어지는 출력은 partial로만 커지고 최대 길이 타이머가 없다(게이트웨이는 16k자에서 lane 실패).
4. **로컬 원문↔번역 불일치.** 데스크톱 기록(`transcripts/8f213047…`, 9/1 11:13 KST)에 `"저도 뜨기는 떠요. 네." → "Solo it's showing up for me too."`, `"근데 이게" → "Yes."`, `"" → "Yeah."`처럼 앞 문장의 번역이 다음 원문에 붙거나 원문 없는 번역이 저장됐다. 두 스트림을 시각 버퍼로 짝지을 뿐이라 필연적이다.
5. **240s 회전·발언권 전환 시 정지.** 게이트웨이는 4분마다 새 연결을 열고 이전 연결 drain(4s)+종료(최대 7s) 동안 새 lane 출력을 보류(`holdPublication`)한다. 화자(floor) 전환 시에는 오디오 tail 안에서 전 lane 재연결을 기다리며, 대기 프레임 64개(2.56s) 초과 시 `DIRECT_TRANSLATION_AUDIO_BACKPRESSURE` → `failOwnedPipeline`으로 **파이프라인 전체가 종료**된다. 9/1 세션은 호스트 단독이라 발현되지 않았지만 참여자 발언이 있는 회의에서는 위험하다.
6. **비용.** 자막만 쓰는데 연결마다 24kHz 번역 음성을 생성한다. 로컬 4연결 + 게이트웨이 2연결.

## 4. 조사한 것 중 원인이 아닌 것

- Gemini 3.7 Flash 503 장애 (8/31 저녁): 텍스트 번역 실패의 원인이었고 `82db9e9` 폴백 체인으로 해결됐다. 직접 엔진 전환의 동기였지만, 지금 증상과는 무관하다.
- go-live 404 / INVALID_GATEWAY_READINESS_INPUT: 세션은 정상 활성화됐다(`gateway_activated_at` 기록).
- 데스크톱·게이트웨이 코드 불일치: 설치된 app.asar와 운영 리비전 모두 워킹트리와 같은 직접 엔진이다.
- 테스트: root 1,548 PASS / gateway 597 PASS. 테스트는 모델의 언어 오인식을 검증할 수 없다.

## 5. 선택지

**A. Transcribe Live + Flash 텍스트 번역으로 복귀 (권장)** — HEAD `82db9e9`에 이미 검증·배포된 구조. `languageCodes` 언어 제약, 원문·번역 1:1, 원문 partial 즉시 표시, 자막당 연결 1개. 워킹트리의 다른 기능(모델 선택 UI, drain 프로토콜, 원문 누락 기록, 아카이브, go-live 수정)은 유지하고 **엔진 조립부만** 되돌린다: `media-gateway/src/server.js` 어댑터 조립, `src/subtitle-realtime.js` lane 구현, `gemini-model-catalog.js`의 source 허용 모델(`gemini-3.5-transcribe-live` 복원), 관련 테스트. 세 배포(게이트웨이·Vercel·DMG) 필요. 사람 기준 1~2일, CC 기준 반나절. 한계: Flash 텍스트 번역은 확정 후 1~3s 지연이 남고 공급자 스파이크에는 폴백 체인으로 대응.

**B. Live Translate 직접 엔진 유지 + 완화** — 소스 언어 힌트가 API에 없어 §2의 오인식은 막지 못한다. 할 수 있는 것: ko lane echo 대신 en lane의 inputTranscription을 한국어 원문으로 표시, 무부호 출력의 최대 길이 확정, 발언권 전환 시 재연결을 오디오 tail 밖으로 이동. 오인식·환각·음성 속도 지연은 남는다.

**C. 혼합** — 원문은 Transcribe Live로 고정(언어 제약, 즉시 partial), 번역만 Live Translate 출력 사용. 연결 수는 A보다 많고 원문↔번역 대응은 여전히 없다. 오인식은 원문 화면에서는 사라지지만 번역 lane에는 남는다.

권장은 A다. 사용자가 8/31 밤 A 구조를 버린 이유(3.7 Flash 503)는 이미 해결됐고, 지금 사용자가 보고한 세 증상(잘못된 번역·이상한 흐름·병목)은 전부 직접 엔진의 모델 특성에서 나온다.

## 6. 롤백 지점 (즉시 복구가 필요할 때)

- 게이트웨이: `realtime-noel-media-gateway-caption-debug-20260831` (HEAD 구조). 트래픽은 리비전 고정이므로 `update-traffic` 필수.
- Mac 앱: `/Applications/.NOVA-before-idle-golive-20260901.app` (asar 확인 결과 Transcribe+Flash 구조, 8/31 23:23 빌드). `.NOVA-before-model-selection-20260901.app`과 `.NOVA-backup-20260831.app`은 둘 다 Live Translate 직접 구조라 롤백 대상이 아니다.
- 웹: `dpl_34Wh6uFCALgxBQBKq34WBXRPd63e`.
