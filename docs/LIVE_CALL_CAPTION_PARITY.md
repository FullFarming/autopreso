# Live Call 자막 vs 로컬 캡션 — 품질 격차와 정본(canonical) 설계

## 0. 2026-07-26 최종 기준과 현재 상태

이 문서의 아래 절에는 조사 과정의 과거 상태와 당시 미해결 항목도 남아 있습니다. 현재
구현과 테스트의 기준은 이 절이 우선합니다.

### 0.1 제품 계약

- **Electron 노트북 화면과 확장 화면 자막**은 캡션 전용 모드와 동일하게 동작한다.
- 화면에는 사용자가 고른 언어 **한 개만** 표시한다. 기본값은 한국어이며 EN/KO를 고를 수
  있다.
- 화면 언어가 KO이면 영어 입력은 한국어 번역, 한국어 입력은 한국어 원문을 표시한다.
  화면 언어가 EN이면 반대로 동작한다.
- 입력이 Electron 호스트 마이크인지 QR 웹 참여자 마이크인지는 화면 정책에 영향을 주지
  않는다.
- **QR 웹 기록은 별도 계약**이다. 모든 발화를 EN과 KO 두 레인에 모두 보존하고, 사용자가
  탭을 바꾸면 이미 받은 전체 기록을 즉시 보여준다.

### 0.2 구현 결과

- 게이트웨이를 유일한 자막 생산자로 사용하고 Electron 화면과 웹앱이 같은 canonical
  caption event를 구독한다.
- 화면 표시 정책은 `src/live-caption-display-policy.js`에서 선택 언어 한 레인만 허용하며,
  같은 언어 원문과 반대 언어 번역을 정확히 한 번 표시한다. provider echo와 실패 번역은
  화면에 올리지 않는다.
- 웹은 `origin: "source"` 원문도 자기 언어 레인에 보존하며, 성공 번역과 함께 EN/KO
  양쪽 기록을 유지한다.
- EN/KO snapshot은 `(sessionId, language)`별 최초 성공 때 한 번만 읽는다. 이후 전환은
  메모리 캐시를 즉시 사용하고 WebSocket replay로 누락분만 보충한다. 세션이 바뀌면 캐시와
  sequence cursor를 함께 초기화한다.
- 참여자 오디오 프레임은 **수신 시점의 발언자**를 함께 캡처한다. 발언 종료나 호스트의
  발언권 회수 뒤 늦게 도착한 provider final도 원래 참여자 ID로 EN/KO 두 레인에 저장된다.
- Speak 종료는 UI와 `speak-end`를 먼저 처리하고 브라우저 오디오 정리는 비동기로 분리해,
  정지 버튼이 `AudioContext.close()`에 막히지 않는다.

### 0.3 검증 증거

- 화면 정책 행렬: 입력 언어 2 × 입력 주체 2 × 화면 언어 2의 8조합에서 화면 event가 항상
  정확히 1개였다.
- 실제 로컬 브라우저: EN/KO 최초 snapshot 2회 후 20회 교대 전환에서 추가 snapshot 0회,
  빈 기록 0회, 오류 0회, 최대 전환 101ms였다.
- 실제 참여자 Speak: 발화가 웹에 실시간 표시됐고 Stop→Start UI 복귀는 44ms였다.
- 늦은 participant final 회귀: host → participant → 즉시 stop/reclaim → late final → host
  순서에서 participant EN/KO final은 같은 participant ID와 utterance key를 유지하고 다음
  host final은 participant ID를 갖지 않았다.
- 전체 회귀: root 825 PASS/1 SKIP, media-gateway 302 PASS, webapp 207 PASS, 두 TypeScript
  검사와 webapp production build가 통과했다.

### 0.4 남은 운영 관찰 항목

- 긴 반복 음원에서는 second-pass polish가 1.5초 제한을 넘겨 raw translation으로 진행되는
  로그가 누적될 수 있다. 언어별 직렬 처리라 요청 동시 폭증과 오디오 입력 차단은 없지만,
  provider 지연 시 committed caption 보정이 생략될 수 있으므로 운영 p95를 계속 관찰한다.
- 이번 변경은 배포하지 않았다. 배포는 사용자 명시 승인 뒤에만 진행한다.

> **이 문서의 목적**: 다른 세션/사람이 이 사안을 이어받아 검토할 수 있도록 만든 인수인계
> 문서입니다. 2026-07-26 세션의 조사·결정·미해결 항목을 담았습니다.
>
> **읽는 방법**: 모든 주장에 파일:행번호를 붙였습니다. **그대로 믿지 말고 직접 확인해
> 주세요.** 이 세션에서 저(Claude)는 같은 사안에서 네 번 틀렸고, 그 중 두 번은 코드를
> 확인하지 않고 단정한 탓이었습니다(§6에 전부 기록).
>
> 표기: `[확인]` = 코드를 읽어 확인함 · `[미확인]` = 확인하지 못함 · `[정정]` = 앞서
> 잘못 말했다가 바로잡은 것
>
> **행번호 검증**: 이 문서의 인용 행번호는 작성 후 직접 재확인했습니다. 그 과정에서 두 곳이
> 한 줄씩 어긋나 있어 고쳤습니다(`gemini-live-translate.js` 337→338,
> `electron/main.js` 1063→1064). 다른 세션이 파일을 수정하면 다시 어긋날 수 있으니,
> 행번호보다 **인용된 식별자 이름**으로 찾는 것을 권합니다.

---

## 1. 질문의 출발점

사용자가 보고한 증상 두 가지:

1. **"캡션으로만 진행할 때의 번역 퀄리티와 라이브콜을 진행할 때의 번역 퀄리티가 너무
   다르다. 일반 캡션만 진행할 때의 설정·퀄리티가 맞다."**
2. **"라이브콜 중 일렉트론으로 생성되는 자막이 그대로 웹앱에 보여지지 않고 다르게
   기재된다."**

두 증상은 원인이 다릅니다. 1번은 설정 버그(고쳤음), 2번은 구조 문제(설계 결정 필요)입니다.

---

## 2. 왜 두 화면의 자막이 다른가 — 구조

`[확인]` 라이브콜 중 **같은 호스트 마이크 오디오가 두 번 독립적으로 번역**됩니다.

```
호스트 마이크
├── (A) 로컬 엔진: public/subtitle-dashboard.js:2991 hasAutoStartedCaptionsForLiveCall
│        → src/subtitle-realtime.js → src/gemini-live-translate.js
│        → 데스크톱 오버레이 + 세션 기록
│
└── (B) 게이트웨이: 같은 렌더러가 PCM 40ms/1280B 프레임을 IPC로
         → electron/main.js 호스트 WebSocket → media-gateway (Cloud Run)
         → media-gateway/src/live-media-pipeline.js:190 언어별 Gemini Live 세션
         → onCaption → #publishPresentationCaption
         → 웹앱 뷰어 + Supabase live_utterances
```

`[확인]` 두 경로는 **모델이 같습니다** — 양쪽 `gemini-3.5-live-translate-preview`
(`src/gemini-live-translate.js:16` DEFAULT_GEMINI_MODEL, Cloud Run env `GEMINI_LIVE_MODEL`).
그런데도 문구가 갈립니다. 이유는 아래 §5.

### 2.1 부수적으로 발견한 오버레이 버그

`[확인]` 오버레이는 레인을 `targetLanguage`만으로 키잉합니다
(`public/subtitle-overlay.js:272-274` — `laneKey(targetLanguage)`가 언어 코드만 반환. 레인당 `predicted`/`lastCommittedText`/`lastSeq`
각 1개). 반면 서버는 `${source} ${targetLanguage}`로 키잉합니다
(`src/subtitle-channels.js:22-24` — `laneKey(message)`).

미팅 모드 라이브콜에서 게이트웨이는 모든 자막을 호스트로 미러링하므로
(`live-media-pipeline.js:912` `if (this.sessionType === "meeting") this.onHostEvent?.(caption)`),
데스크톱 오버레이는 **같은 언어 레인에 두 스트림을 동시에** 받습니다 — 로컬 번역과
게이트웨이 번역. 서로를 덮어씁니다.

즉 사용자가 본 것은 "웹앱이 다르다"만이 아니라 **오버레이 자체가 두 번역 사이에서
흔들리는** 현상일 가능성이 높습니다. `[미확인]` 실제 화면에서 이 깜빡임을 육안으로
확인하지는 못했습니다 — 코드 경로상 가능하다는 것까지만 확인했습니다.

---

## 3. 증상 1의 원인 — 찾아서 고쳤음

### 3.1 근본 원인: 단어집이 16,000자에서 잘림 `[확인·수정됨]`

`electron/main.js:1479` (수정 전):

```js
liveGlossaryText = String(savedSettings?.subtitle?.glossary ?? "").trim().slice(0, 16_000);
```

- 로컬 캡션은 `settingsStore`의 단어집을 **전량** 사용
- 라이브콜은 이 지점에서 **16,000자로 절단**된 것을 게이트웨이로 전송
- 기본 호텔 프리셋이 27,531자 → **11,500자 소실**, 파일 뒤쪽 섹션(고유명사·지명·
  `[번역 메모리]` 블록)이 통째로 사라짐

이 세션에서 상한을 4곳 중 3곳만 40,000자로 올리고 **이 지점을 놓쳤던 것**이 원인입니다.
지금은 40,000자로 통일하고, 네 지점 전부를 프리셋 크기와 대조하는 테스트를 넣었습니다
(`test/glossary-presets.test.js`).

상한이 있는 전체 지점:

| 위치 | 동작 | 현재 |
|---|---|---|
| `src/settings-store.js` MAX_SUBTITLE_GLOSSARY_CHARS | 초과 시 **거부(throw)** | 40,000 |
| `webapp/lib/settings.ts` MAX_GLOSSARY_CHARS | 조용히 slice | 40,000 |
| `media-gateway/src/config.js` | 조용히 slice | 40,000 |
| `electron/main.js:1479` | 조용히 slice | 40,000 ← 놓쳤던 곳 |

> `[확인]` 부수 발견: 상한이 16,000이던 동안 **기존 호텔 프리셋(27,531자)은 데스크톱
> 설정 저장 자체가 실패**했고, 웹앱·게이트웨이에서는 42% 잘려 있었습니다. 이 세션 전부터
> 있던 버그입니다.

### 3.2 기각한 가설 — polish 타임아웃 `[정정]`

게이트웨이 `media-gateway/src/server.js:105`가 `timeoutMs: 1_500`을 넘기는 것을 보고
"데스크톱 4,000ms 대비 짧아서 polish가 자주 타임아웃된다"고 의심했으나 **틀렸습니다.**

`[확인]` `src/subtitle-realtime.js:53` `DEFAULT_POLISH_TIMEOUT_MS = 1_500`이 모듈 기본값
4,000을 덮어씁니다. **양쪽 모두 1,500ms로 동일**합니다. 수정하지 않았습니다.

---

## 4. 남은 품질 격차 — 미해결

§3.1을 고친 뒤에도 남는 차이입니다. **어느 정본 설계를 택하든 게이트웨이 로컬로 고쳐야
하는 부채**입니다.

### 4.1 polish에 `sourceText`가 전달되지 않음 `[확인]`

`media-gateway/src/live-media-pipeline.js:846-852`:

```js
const polished = await this.dependencies.captionPolish.polish({
  translatedText: text, targetLanguage: language,
  tone: this.translationTone, glossary: this.glossaryText, domain: this.domainText,
  // sourceText 없음
});
```

데스크톱은 넘깁니다(`src/subtitle-realtime.js:605-609`가 `applyGlossaryCorrections`에
`sourceText: finalSource`를 넘기는 것과 같은 맥락). 결과:

- polish 프롬프트의 "원문 참조(context only)" 분기와 생략부호 복구 분기가 게이트웨이에선
  **발동하지 않음**
- 더 중요한 것: `applyGlossaryCorrections`도 `sourceText` 없이 호출되므로
  (`live-media-pipeline.js:868`) **`[번역 메모리]` 문장 단위 매칭이 게이트웨이에서 전혀
  작동하지 않습니다.** 호텔 프리셋의 번역 메모리 섹션은 상당한 분량입니다.

`[확인]` 난이도 주의: 게이트웨이에서 번역 자막(`onCaption`)과 원문 전사
(`onInputCaption`)는 **별개 콜백**으로 도착합니다. 게다가 presentation 모드에서는
`onInputCaption`이 아예 연결되지 않습니다(`live-media-pipeline.js:200`이 `isMeeting`으로
게이팅). 따라서 "인자 하나 추가"가 아니라 상관관계 추적이 필요합니다. 한 검토자는 ~20줄로
추정했습니다.

### 4.2 cross-channel 중재기 부재 — 근거가 거짓이었음 `[확인·중요]`

`media-gateway/src/language-gate.js:20-27`에 이 세션에서 제가 직접 이렇게 적었습니다:

> *"Deliberately NOT ported: the desktop's cross-channel consensus arbiter … The gateway has
> a single STT that produces one sourceLanguage for all lanes — there are no sibling votes to
> arbitrate."*

**이 근거는 거짓입니다.** `[확인]` `usesLiveTranslateCaptions()`
(`live-media-pipeline.js:971` 부근)는 presentation과 meeting **둘 다** 언어별로 Gemini Live
Translate 세션을 하나씩 엽니다 — **데스크톱과 동일한 토폴로지**입니다. 제가 근거로 삼은
단일 STT 경로(`#processFinalUtterance`)는 **어떤 세션 타입도 도달하지 않는 죽은 코드**이며,
코드 자체가 그렇게 적어두고 있습니다(`live-media-pipeline.js:834` 부근 주석
*"which no session type reaches"*).

따라서 데스크톱에만 있는 다음 계층은 **실재하는 잔여 위험**입니다:

- `isSameLanguageEcho`, `isSourceEcho`
- cross-channel echo registry (`SOURCE_HOLD_MS` 히스테리시스, sustained-English tie-break)

이식된 것은 확인됨: `isOutputInTargetLanguage`(= 데스크톱 `shouldDisplay`의 출력 게이트),
카운트+비율 한국어 우선 `detectSourceLanguage`, `sourceLaneMatches`, 결정론적
`applyGlossaryCorrections`. 두 사본의 동등성은 루트 스위트가 강제합니다
(`test/live-language-gate-parity.test.js`, `test/live-glossary-parity.test.js`).

### 4.3 커밋 경계 차이 `[정정]`

`[확인]` 데스크톱은 `turnComplete`/`generationComplete`
(`src/gemini-live-translate.js:338`) + `SUBTITLE_COMMIT_MS = 800`(`src/subtitle-realtime.js:22`) 디바운스로 커밋.
게이트웨이는 **문장 경계마다 중간 커밋**(`lastSentenceBoundaryEnd`, `emitLane` —
`media-gateway/src/google-provider-adapters.js:59,125`) + 2,500ms 침묵 플러시.

처음에는 이를 게이트웨이의 결함으로 보고했으나 **방향이 반대**입니다. `[확인]` 양쪽
코드베이스가 각각 문서화하고 있듯 **live-translate 모델은 연속 발화 중 `turnComplete`를
보내지 않습니다**(데스크톱에 `PARTIAL_STALE_CLEAR_MS`, `SILENCE_CLEAR_MS`가 필요한 이유).
그래서 타운홀 독백에서 데스크톱은 계속 자라는 partial을 타고 갑니다. **기록으로는 문장
단위 커밋이 낫습니다.**

### 4.4 temperature `[정정]`

`[확인]` `media-gateway/src/caption-polish.js:116`에 `temperature: 0.2`. 데스크톱
`src/subtitle-polish.js`는 온도 미설정 → 제공자 기본값(Gemini ~1.0)을 물려받음.

처음에 이를 품질 결함으로 보고했으나 **반대**입니다. 게이트웨이 polish가 **더
결정론적**입니다. 결함이 아닙니다.

---

## 5. 증상 2 — "두 엔진을 일치시킨다"는 불가능

### 5.1 벤더 문서가 명시적으로 부정함

`[확인, 1차 출처]`

- **OpenAI Realtime API**: GA에서 `temperature`를 **제거**했고, *"there isn't a way to make
  these audio responses deterministic with low temperatures"* —
  https://developers.openai.com/blog/realtime-api · `seed` 파라미터 없음
- **Gemini Live API**: *"`send_realtime_input` is optimized for responsiveness at the expense
  of deterministic ordering"* — https://ai.google.dev/gemini-api/docs/live-api/capabilities ·
  `generationConfig`에 `seed` 없음
- **배치 비결정성**: Thinking Machines Lab, *Defeating Nondeterminism in LLM Inference* —
  temperature 0에서 동일 프롬프트 1000회에 **80가지 서로 다른 출력**, 첫 분기 103번째 토큰.
  근본 원인은 *"the load (and thus batch-size) nondeterministically varies"*. 결정론적 커널로
  고칠 수 있으나 **자체 추론 스택(vLLM/SGLang)을 운영할 때만** 가능 —
  https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/
- **스트리밍 ASR의 두 번째 비결정성**: 청크 경계와 엔드포인팅이 **도착 타이밍 의존**.
  두 경로의 프레이밍이 다르면(로컬 자체 캡처 vs 게이트웨이 1280B/40ms) 세그멘테이션이
  달라지고, 세그멘테이션이 다르면 번역 컨텍스트 윈도우가 달라집니다.

**결론: 두 화면이 같은 텍스트를 보이려면 한쪽이 다른 쪽의 복사본이어야 합니다.**

### 5.2 업계는 전부 단일 생산자

`[확인, 1차 출처]` 다자 회의 시스템은 예외 없이 **서버에서 한 번 생성해 언어별로
팬아웃**합니다.

| 시스템 | 근거 |
|---|---|
| Microsoft Teams | Azure Cognitive Services 중앙 ASR, 참가자별 *렌더링* 선택 |
| Cisco Webex | *"A meeting or webinar can use a maximum of **15** unique caption languages at the same time"* — 뷰어당이 아니라 **미팅당** 상한 (널리 인용되는 "5개"는 낡은 수치) |
| Zoom | 호스트가 사전 선언, 참가자 구독. 3rd-party CC ingest의 `seq`는 *"must not be increased for retries"* → 멱등 키 |
| Google Meet | Media API에 자막 스트림이 **아예 없음**(오디오·비디오·메타데이터만) |
| Polycom 특허 CN102209227A | 중앙 MCU에서 STT→번역→TTS, *"Different conferees may receive different translations of the same speech"* |
| Google 특허 US8838459B2 | "virtual participant processor"가 참가자별 언어로 **한 번씩** 번역 |
| LiveKit | 에이전트(서버)가 `lk.transcription` 토픽에 발행, `segment_id` + `lk.transcription_final` |

`[확인]` **클라이언트별 자막 생성은 시청자가 1명일 때만 존재합니다**(Apple Live Captions,
온디바이스). 데스크톱 오버레이는 청중에게 보여주는 화면이라 그 예외가 아닙니다 — 현재
구조에서 오버레이는 **"청중용 두 번째 발행자"** 입니다.

`[확인, 부정적 결과]` **두 독립 엔진을 같은 오디오에 돌려 화해시키는 시스템의 공개 선례를
찾지 못했습니다.** 이것 자체가 결론입니다.

---

## 6. 이 세션에서 제가 틀린 것 — 반복하지 않기 위한 기록

| # | 틀린 내용 | 실제 | 교훈 |
|---|---|---|---|
| 1 | 언어 게이트 수정을 `#processFinalUtterance`에 넣고 "② 완료"로 보고 | **프로덕션이 실행하지 않는 경로.** 실제 경로는 `#publishPresentationCaption`(`live-media-pipeline.js:198` `onCaption`). `acceptFinalUtterance`는 242행 주석대로 테스트 전용 주입구 | 테스트 초록 ≠ 프로덕션 경로. 호출자를 끝까지 추적할 것 |
| 2 | "반대 언어 표시에는 소켓 2개가 필요" | `echoTargetLanguage: false`(`google-provider-adapters.js:207`)로 같은 언어 에코는 이미 억제되고, 원문 레인은 `origin:"source"`로 같은 레인에 실림 → **소켓 1개로 충분** | 옵션을 제시하기 전에 전제를 코드로 확인 |
| 3 | "presentation 모드 미러링이 없어 공백" | `electron/main.js:627-628`이 데스크톱발 라이브콜을 `sessionType:"meeting"`, `outputMode:"captions"`로 **하드코딩** → 해당 없음 | 같음 |
| 4 | `temperature: 0.2`를 품질 결함으로 보고 | 데스크톱은 온도 미설정(기본 ~1.0) → **게이트웨이가 더 결정론적** | 비교 대상의 기본값을 확인 |
| 5 | `language-gate.js:20-27`에 "형제 표가 없다"는 **거짓 근거**를 작성 | 언어별 세션이 실제로 존재(§4.2) | 자기가 방금 발견한 사실(죽은 경로)과 자기가 쓰는 주석을 교차 확인 |

추가로, 기록 요구사항을 먼저 확인하지 않아 **같은 테스트 3개를 두 번 뒤집었습니다**
(발행 억제 → 발행+라벨). 요구사항의 축(기록 vs 표시)을 먼저 물었어야 했습니다.

---

## 7. 결정: 게이트웨이를 정본으로

### 7.1 검토 방식

에이전트 3개로 교차 검증했습니다.

1. **아키텍처 분석** → **D1 권고**: 데스크톱을 유일 생산자로, 새 host 메시지
   (`host-caption`)로 게이트웨이에 주입해 팬아웃, 게이트웨이는 뮤트된 핫 스탠바이
2. **업계 조사** → **B 권고**(독립적으로): 게이트웨이를 유일 생산자로, 오버레이는 구독자
3. **적대적 검토**(B를 변호하며 D1을 공격하도록 지시) → **B 확정**, D1의 논거를 스코핑
   오류로 기각

### 7.2 사용자 결정

**정본 = 게이트웨이. 오버레이는 구독자. 로컬 엔진은 콜드 스탠바이.**

```
호스트 마이크
  └→ 게이트웨이 (유일한 정본 생산자, 언어별 1세션)
       ├→ 웹앱 뷰어            (변경 없음)
       ├→ Supabase live_utterances (변경 없음)
       └→ onHostEvent → 호스트 소켓 → IPC live-call:caption
            → public/subtitle-dashboard.js → subtitle:live-call-caption
            → src/server.js broadcastSubtitleMessage
                 → 오버레이 · 프리뷰 · 히스토리 · 세션 기록

로컬 엔진 = 콜드 스탠바이 (라이브콜 중 정지)
  브리지 장애 감지 → 로컬 기동 + 저하 배지 → 오버레이만 로컬로
  브리지 복구 → 게이트웨이로 자동 복귀
```

`[확인]` **중계 경로는 이미 프로덕션에서 돌고 있습니다.** `src/server.js:537-575`가
`subtitle:live-call-caption`을 native `subtitle:committed`/`subtitle:partial`로 재발행하며,
주석에 *"the overlay, preview, history, and session records treat participant speech exactly
like local captions"*. 그리고 `broadcastSubtitleMessage`는 내부에서
`sessionTranscripts.recordLine`을 호출(`src/server.js:122-131`) → **로컬 엔진을 꺼도 기록이
끊기지 않습니다.**

### 7.3 D1이 기각된 근거

`[확인]`

- **스큐 안전성**: 게이트웨이는 **모르는 host JSON 타입에 소켓을 끊습니다**
  (`gateway-server.js:545` throw → `closeWithError(4400)`). 신규 데스크톱 + 구버전
  게이트웨이 = 재연결 루프로 **오디오 브리지까지** 약 1분 내 사망. 게이트웨이 우선 배포는
  뮤트된 게이트웨이 + 중계하지 않는 구버전 데스크톱 = **조용한 시청자 블랙아웃**.
  안전한 배포 순서가 없습니다. B는 양방향 안전(게이트웨이 변경이 구버전 데스크톱에 안
  보임 — 이미 `isParticipant` 필터로 걸러냄, `subtitle-dashboard.js:3079`).
- **대역폭이 반대로 갑니다**: 데스크톱은 언어별 Gemini WSS를 열고 PCM을 **base64 JSON**으로
  전송(언어당 ~43 KB/s).

  | | 3개 언어, 행사장 업스트림 | 동시 Gemini 세션 |
  |---|---|---|
  | 현재 / D1 | ~32 + 3×43 ≈ **160 KB/s** | **6** |
  | B | **32 KB/s** | **3** |

  D1은 "행사장 와이파이 위험"을 이유로 들었지만, 같은 와이파이에 **5배** 트래픽을 얹습니다.
- **지연**: B는 업링크를 추가하지 않습니다(이미 존재). 추가되는 것은 다운링크 1홉
  (~10ms 동일 리전). 그리고 로컬 경로의 `PARTIAL_STABILITY_MS = 140`(`src/subtitle-realtime.js:33`) /
  `GEMINI_PARTIAL_MAX_HOLD_MS = 500`(`:40`) 홀드가 **제거**되므로 partial은 B가 더 빠를 수 있음.
  finals는 나빠짐 — `onHostEvent`가 `await publisher.publish(...)` 뒤에 발화하고 publish는
  Supabase RPC 2개를 순차 await(`supabase-adapters.js:18-55`) → 호스트 화면 앞 40~300ms.
  **미러링을 persist 앞으로 옮기는 3줄 변경**으로 해결.
- **D1은 계약 4개를 건드립니다**: 와이어 호환성, seq 권한(contract C1), 발언권 권한,
  liveness 감지. B는 0개.
- **킬 스위치**: B는 렌더러 런타임 불리언(재배포 불필요). D1은 분산 상태 변경이고, 그
  스위치가 사는 컴포넌트가 장애 시 바로 그 아픈 놈.

### 7.4 기각된 하이브리드

"로컬을 먼저 그리고 게이트웨이 문구로 화해" — `[확인]` **작동하지 않습니다.** §2.1의 레인
키잉 불일치 때문에 `mic ko`와 `live-call ko`가 공존하며 한 오버레이 레인에서 핑퐁하고,
두 생산자의 커밋 경계가 달라 화해할 안정적 키가 없습니다. 로컬 문장을 게이트웨이 반쪽
문장으로 대체하게 되어 **청중이 자막이 다시 써지는 것을 보게** 됩니다.

불변식: **한 순간에 정확히 하나의 소스만.**

### 7.5 콜드 vs 웜 스탠바이

사용자 선택: **콜드**. 획득 = 대역폭 1/5, Gemini 세션 반감, 발열·배터리. 부담 = 장애 전환
시 오버레이 공백 0.5~2초(`SETUP_ACK_TIMEOUT_MS = 8000` 예산). 그 구간에는 웹앱 시청자도
자막이 없으므로 데스크톱만 특별히 불리한 것은 아닙니다.

`[확인]` 폴백 트리거는 이미 있습니다: `setLiveBridgeAlert({ state: "reconnecting", code: "GATEWAY_RECONNECTING" })`가
재연결 시도마다 발화(`electron/main.js:1064-1069`). 소진 시에는
`{ state: "failed", code: "GATEWAY_RECONNECT_EXHAUSTED" }`(`:1047-1052`). `liveBridgeStatus()`가
`connected`/`connecting`/`idle`을 반환하고, 재연결 백오프
(`electron/main.js:43-45`: `LIVE_BRIDGE_RECONNECT_BASE_MS = 1_000`,
`LIVE_BRIDGE_RECONNECT_MAX_MS = 20_000`, `MAX_LIVE_BRIDGE_RECONNECTS = 8`)와 호스트 모달
(`notifyLiveBridgeFailure`)까지 갖춰져 있습니다.

`[미확인]` 남는 정직한 잔여: 발화 중 브리지가 끊기면 최대 20초 오버레이 공백. 클라이언트
플래그로 해결되지 않습니다.

---

## 8. 운용 장치 (설계안, 미구현)

### A. 전환에 필수

1. **단일 소스 불변식 강제** — §2.1의 레인 키잉 불일치를 해소하고 활성 프로듀서를 하나만
   통과시키는 게이트. 없으면 폴백 전환마다 §2.1 버그 재발.
2. **프로듀서 에포크 펜싱** — 자막에 `{producerId, epoch}`, 낮은 에포크 거부. "로컬 엔진이
   되살아나 다시 발행"을 경합이 아니라 구조적 불가능으로. (Kafka PID+시퀀스, Kleppmann
   펜싱 토큰)
3. **finals 지연 3줄 정리** — 미러링을 Supabase persist 앞으로.

### B. 안전장치

4. **저하 상태 표시** — 로컬 폴백 중임을 오버레이에 명시. 3Play 패턴의 핵심은 자동 전환
   **+ 자동 복귀**이고, 복귀 여부를 사람이 알아야 함.
5. **자막 부재 알람** — 발언권이 잡혀 있는데 언어 토픽이 N초 침묵하면 경보.
6. **NTR 골든 전사 회귀** — 기존 실오디오 프로브(`scripts/*-probe.mjs`)에 **NTR 모델**
   (번역 오류/인식 오류 분리, 3단계 심각도)로 점수. Ofcom이 채택한 NER의 언어 간 확장판.
   NER 밴드: 98.0 최소 / 98.5 양호 / 99.0 우수. 정렬은 NIST ROVER의 word-transition-network
   (SCTK). `[미확인]` NTR의 정확한 산식과 98% 임계값은 1차 출처로 확인하지 못했습니다 —
   N/T/R 분해는 확인됨, 산술은 2차 출처.

**드리프트 감지는 의도적으로 제외.** B를 하면 정본이 하나가 되어 비교 대상이 사라집니다.
두 엔진을 유지한다면 Diffy처럼 **같은 엔진 두 번 돌린 노이즈 기준선**을 먼저 세워야
합니다 — Twitter Diffy: *"Diffy measures how often primary and secondary disagree with each
other vs. how often primary and candidate disagree"*. 기준선 없는 알람은 LLM 비결정성에
상시 발화해 일주일 안에 무시됩니다.

### C. 이번 범위 제외 — 별도 부채

- **cross-channel 중재기 이식** (§4.2, 거짓 근거로 종결했던 항목)
- **polish/glossary에 `sourceText` 전달** (§4.1, 번역 메모리가 게이트웨이에서 미작동)
- **`archiveLiveCallSession` 이중 기록** — `[확인]` `electron/main.js:1246-1281`이 라이브콜
  마다 게이트웨이 `live_utterances`를 로컬 Records로 가져오는데, 로컬 캡션 세션 기록이
  **이미 별도로** 존재합니다. 즉 **한 미팅의 서로 다른 전사 2부가 이미 디스크에 있습니다.**
  단일 프로듀서가 되면 중복.
- **뷰어 attach 순서** — 조사에서 가장 일관되게 문서화된 규칙이 **"구독 먼저, 스냅샷
  나중"**입니다: Binance 오더북(1단계 스트림 오픈 → 2단계 이벤트 버퍼 → 3단계 REST
  스냅샷 → 갭이면 3단계로 재시작), Ably `untilAttach`(*"subscribe to the channel before
  making a history request"*), Phoenix(조인 파라미터에 `last_seen_id`, 조인 응답에 백필),
  Nasdaq GLIMPSE. 현재는 반대(스냅샷 → 구독)입니다. 언어별 캐시로 증상은 가렸지만 순서
  자체는 그대로입니다.
- **안정적 `utteranceId` 부재** — 현재 `seq`가 순서 키와 신원을 겸하고 있습니다. LiveKit의
  `segment_id` + `lk.transcription_final` 모델처럼 분리하면 contract C1의 충돌 원인이
  사라지고, 향후 "확정된 줄 수정"의 부착점이 생깁니다. `[확인]` 자막 **전송 표준** 중
  주소지정 가능한 "N번 자막 교체"는 없습니다 — 실제로 존재하는 두 형태는 전체 상태 교체
  (RFC 8759: *"exactly zero or one document SHALL be considered active"*)와 위치 기반 삭제
  (T.140 U+0008, RFC 9071)입니다. 키 기반 수정을 갖춘 유일한 스펙은 XEP-0301이고, 그
  `seq`-must-increment-by-1 desync 규칙은 이 저장소의 contract C1과 구조적으로 동일합니다.

---

## 9. 배포 상태

`[확인]` 2026-07-26 오전 배포·재설치 완료분:

- **media-gateway** → Cloud Run `realtime-noel-media-gateway` 리비전 `00023-8bk`, 트래픽
  100%, `asia-northeast3`. `GET /health` → 200 + `cache-control: no-store` + `{"ok":true}`,
  `/metrics` 토큰 없이 404 (README 요구사항 2건 충족)
- **webapp** → Vercel 프로덕션 READY, 런타임 에러 0
- **desktop** → `dist/NOVA-0.2.1-arm64.dmg` 빌드 후 `/Applications` 교체·재실행.
  ad-hoc 서명 폴백, notarization 생략(개발자 인증서 없음 — 기존과 동일 조건)

**⚠️ 그 이후 수정분은 배포되지 않았습니다.** §3.1의 단어집 절단 수정, 기본 단어집 해소,
언어 전환 캐시, partial 문단 병합, 회사명 오음차 교정 추가는 **로컬 커밋도 되지 않은
상태**입니다.

`[확인]` 작업 트리에 수정 26개 + 새 파일 6개가 커밋되지 않은 채 있고, **현재 프로덕션에
올라간 코드는 어떤 커밋에도 대응하지 않습니다** (롤백 기준점 없음). Cloud Run은 이전
리비전(`00022`)으로 롤백 가능하지만 웹앱·데스크톱은 소스 기준점이 필요합니다.

테스트 현황(로컬): 루트 805 통과 / 게이트웨이 265 / 웹앱 170, 실패 0, 타입체크 클린.

---

## 10. 다른 세션에 묻고 싶은 것

1. **§7.2의 결정(게이트웨이 정본 + 콜드 스탠바이)에 동의하는가?** 특히 §7.3의 D1 기각
   근거 중 반박할 것이 있는가. 대역폭 원장(160 vs 32 KB/s)과 스큐 안전성 논거를 독립적으로
   검증해 주면 좋겠습니다.
2. **§8.C를 정말 분리해야 하는가?** 중재기 부재(§4.2)와 attach 순서는 현 구조에 남는 실제
   위험입니다. 이번 변경에 섞으면 blast radius가 흐려지지만, 미루면 콜드 스탠바이가
   "언젠가 신뢰해야 하는" 컴포넌트로 남습니다.
3. **§4.1을 어떻게 구현할 것인가** — `onCaption`/`onInputCaption` 상관관계 추적. presentation
   모드에서 `onInputCaption`이 연결조차 안 된다는 점을 포함해서.
4. **콜드 스탠바이 전환 중 기록의 이음새** — 전환 순간 문구 출처가 바뀝니다. 기록에
   프로듀서를 표시할 것인가, 아니면 이음새를 숨길 것인가.
5. **커밋 전략** — 프로덕션에 올라간 것이 커밋되지 않은 상태를 어떻게 정리할 것인가.

---

## 부록: 이 세션에서 이미 수정한 관련 항목

라이브콜/자막 관련으로 같은 세션에서 처리한 것들. 맥락상 함께 알아야 합니다.

| 항목 | 내용 | 상태 |
|---|---|---|
| 기록 소실 | `live_snapshots.captions`는 설계상 자막 **1개**만 보관(`jsonb_build_array` 1개, 충돌 시 교체). 영구 기록은 `live_utterances`인데 스냅샷 API가 안 읽었음. 게다가 `subscribe()`가 captions는 비우고 `lastSeq`는 유지해 갭만 요청 → 언어 전환 시 기록 소실 | 수정 (`webapp/lib/live/store.ts`, `seq.desc&limit=200` 후 오름차순 재정렬 — `seq.asc`는 긴 세션에서 전사 중간에 조용한 구멍을 만듦) |
| 한↔영 반복 | 게이트웨이는 `textPlausiblyInLanguage` 스크립트 검사 하나 + fail-open뿐이라 번역 실패·쿨다운마다 영어 원문을 KO 레인에 발행 | 수정. 데스크톱 게이트 이식(`media-gateway/src/language-gate.js`) + 발행은 유지하되 `translationStatus:"failed"` 라벨, 표시는 뷰어가 필터 |
| 기록 vs 표시 분리 | 기록은 무조건, 표시는 필터(`origin:"source"`와 `failed` 숨김). 데스크톱의 `recordOnly` 정책(`src/server.js:547`)과 동일 | 수정 |
| 단어집/숫자 표기 | 타운홀 8개 덱(79슬라이드, 이미지 55장은 비전 OCR) 분석해 CRE 기본 단어집 6.7KB→19.3KB. 숫자는 결정론적 변환(3,000억 원 ↔ KRW 300 billion, 667K USD ↔ 66만 7,000 달러). 캡션당 0.13ms | 수정 |
| 기본 단어집 | `getDefaultSubtitleGlossaryContext`가 첫 언어쌍 일치 프리셋을 반환 → EN↔KO 기본값이 **호텔** 단어집이었음 | 수정. `default-cre-ai-en-ko` 우선 |
| 라이브 피드 접기 | 화자가 한 문장 더 말하면 문단이 묶이며 텍스트가 사라지는 현상 → 접기 제거, append만. 접기는 기록 화면(`MeetingMinutes`)으로 | 수정 |
| 진행 중 자막 위치 | 별도 카드로 그려지다 확정 시 위 문단으로 점프 → 같은 화자면 그 문단 꼬리에 렌더 | 수정 |

---

## 11. 2026-07-26 구현·검증 업데이트

이 절이 앞선 “미해결/미구현” 표기보다 우선합니다. 이번 후속 작업에서 아래 항목을 로컬에
구현했으며, 운영 환경에는 아직 적용하지 않았습니다.

- Live Call의 유일한 정상 캡션 생산자를 게이트웨이로 고정했습니다. Electron 화면과 웹앱은
  동일 canonical event를 소비하며, 로컬 캡션은 브리지 장애 때만 cold standby로 시작합니다.
- 호스트와 참가자 발화를 같은 `utteranceKey`로 묶고, Gemini input/output 순서 역전·번역
  누락·발언권 전환 뒤 늦은 final에서도 원문·번역·화자가 섞이지 않게 했습니다.
- `origin`과 `utteranceKey`를 snapshot과 `live_utterances`에 보존하는 additive migration
  `202607260001_live_caption_identity_provenance.sql`을 추가했습니다. 동일 seq 재시도는 최초
  provenance를 변경하지 않습니다.
- 웹앱은 구독을 먼저 붙인 뒤 snapshot을 보충하고, 언어별 기록을 즉시 복원합니다. Gateway는
  200행 keyset replay를 live edge까지 반복하며, UI는 언어별 확정 자막 5,000건과 partial 1건을
  손실 없이 유지합니다.
- replay·WebSocket open·snapshot·active-session guard에 bounded timeout과 AbortSignal을
  적용했습니다. 재구독·언어 전환·소켓 종료는 진행 중 replay를 실제 Supabase fetch까지
  취소하며, snapshot guard 무응답은 5초 뒤 fail-closed 됩니다.
- local fallback 종료/실패 때 producer와 로컬 기록을 함께 finalize하고, host Speak는 기존
  bridge를 single-flight로 재사용합니다.
- XFF 기반 연결 제한은 Cloud Run 런타임과 명시적
  `LIVE_GATEWAY_TRUST_GOOGLE_XFF_SUFFIX=true` 계약이 모두 있을 때만 Google proxy suffix를
  신뢰합니다. 그 외에는 socket peer로 fail-closed 합니다.

최종 로컬 검증:

| 범위 | 결과 |
|---|---|
| Root | 821개 중 820 PASS, 1 SKIP, 0 FAIL |
| Media Gateway | 296/296 PASS |
| Webapp | 191/191 PASS |
| Root/Webapp typecheck | PASS |
| Webapp production build | PASS |
| `git diff --check` | PASS |

독립 적대적 재현에서 A/B 늦은 final, missing output 다음 turn, participant→host 전환,
450행 replay, 5,000행 UI 보존, provenance conflicting retry, local fallback cleanup, 빠른 동일 문장,
stopped/guard 오류, persistence 지연, snapshot guard 무응답을 확인했습니다.

마지막 단일 통합 시나리오는 실제 `createGatewayServer`, HOST/VIEWER WebSocket,
`SupabaseLivePublisher`를 함께 사용했습니다. 같은 문장을 host(seq 1) → participant(seq 2) →
host(seq 3) 순서로 발행해 Electron host 수신과 web viewer 수신이 같은 event인지, 참가자 화자
귀속과 host 복귀가 맞는지, snapshot에 3건이 기록되는지, 신규 viewer가 seq 1–3을 순서대로
replay하는지를 각 단계 2초 제한 안에서 확인했습니다.

격리된 로컬 Supabase PostgreSQL에서 migration 전체를 처음부터 재생하는 과정에서,
`202607190002`가 제거한 legacy `realtime.messages` policy를 `202607240001`과
`202607240003`이 다시 `ALTER`하는 이력 결함을 발견했습니다. 두 obsolete ALTER 블록을
제거하고, 이미 적용된 환경도 gateway-only 상태로 수렴하도록
`202607260002_drop_legacy_realtime_policies.sql`을 추가했습니다. 수정 뒤 20개 migration 전체가
순서대로 적용됐고, 실제 DB에서 provenance 컬럼 2개, snapshot RPC 3인자, utterance RPC 14인자,
legacy Live Realtime policy 0개를 확인했습니다.

브라우저까지 포함한 로컬 실기 검증을 위해, 운영 Supabase를 절대 가리킬 수 없는 loopback 전용
테스트 게이트웨이(`media-gateway/scripts/local-live-call-e2e-gateway.mjs`)를 추가했습니다. 이
게이트웨이는 실제 `createGatewayServer`, Supabase Auth/PostgREST, authorizer, floor control,
publisher, replay를 그대로 사용하고 외부 음성·번역 제공자만 결정론적 PCM→한/영 자막으로
대체합니다. `development|test` + 명시적 opt-in + 정확한 `127.0.0.1:54321` 조합이 아니면
시작하지 않고, loopback에만 바인딩됩니다.

격리된 Supabase 전체 스택과 실제 Next.js 웹앱을 띄운 뒤 QR 참가 흐름으로 다음을 확인했습니다.

- 호스트 → 참가자 → 호스트 순서로 발언권을 교대했고, 참가자 `Local Viewer`의 344개 기록이
  호스트/웹 양쪽에 같은 화자 귀속으로 저장됐습니다.
- 한/영 레인에 최종 각각 9,529개가 같은 seq 범위(1–9,529)로 저장됐고, 웹 화면은 1,000건을 넘는 긴 기록도
  끊기지 않고 표시했습니다.
- EN→KO→EN→KO→EN→KO 6회 연속 전환은 94–435ms 안에 완료됐으며, 이전 언어 기록을
  다시 네트워크에서 처음부터 불러오거나 화면을 비우지 않았습니다.
- 게이트웨이 재시작 뒤 persisted seq에서 이어 발행됐고, snapshot 요청은 한국어 레인도 200
  응답으로 복원했습니다. 테스트 중 request-timeout 응답은 발생하지 않았습니다.

이 실기 과정에서 세션 생성 화면의 시작 시간이 매일 고정 `09:00`이라 현재 시각 이후에도
과거 시간으로 제출돼 503처럼 보이던 결함을 발견했습니다. 기본값을 브라우저 현재 시각 +10분,
5분 단위 올림으로 바꾸고 날짜 경계와 제출 직전 재검증을 추가했습니다. 과거·잘못된 시각은
명시적인 접근성 오류로 차단합니다.

남은 승인 전 검증은 실제 staging/development Supabase 적용과 Electron↔모바일 두 기기의 장시간
오디오·네트워크 시연입니다. 로컬 격리 DB 검증은 완료했지만 실제 앱 환경변수는 운영 Supabase를
가리키므로 새 원격 세션을 만드는 실기 테스트는 수행하지 않았습니다. 배포 순서는 반드시
migration → Gateway → Webapp → Desktop이며, 사용자의 명시적 배포 승인 전에는 실행하지 않습니다.
