# 라이브 자막 방향성 문제 — 진단과 공급자 조사

작성 2026-07-26. 연구 산출물이며 **구현 지침이 아니라 근거 문서**다. 이 표면은 다른 세션이
작업 중이므로, 손대기 전에 §2와 §3을 먼저 읽을 것.

표기: **[문서]** 공식 문서로 확인(URL 포함) · **[코드]** 이 리포에서 확인(file:line) ·
**[추정]** 근거는 있으나 미확인.

---

## 0. 결론 먼저

세 가지가 겹쳐 있고, 서로 다른 층위다.

1. **요구 계약 자체는 이미 아키텍처에 있다.** 언어당 세션 하나씩 열고 원문 레인을 따로 두는
   구조는 옳다. 바꿀 것은 토폴로지가 아니다.
2. **증상의 직접 원인은 "번역 레인이 소스를 되돌려주는 것"이고, 게이트웨이에는 그것을 막는
   가드가 하나도 없다.** 데스크톱에는 네 개 있다.
3. **이전에 "고쳤다"고 기록된 수정은 프로덕션에서 실행되지 않는 코드에 들어갔다.** 그리고 그
   코드를 검증하는 테스트도 같은 죽은 진입점만 호출하므로 계속 초록이었다.

가장 값싼 다음 행동은 코드를 고치는 것이 아니라 **§4의 관측 두 개를 실행해 어느 가설인지
확정하는 것**이다. 세 가설의 수정 방향이 서로 다르다.

---

## 1. 요구 계약

소유자 표현 그대로: 한국어로 말하면 **한국어 원문을 들린 대로** 기록하고 영어로 번역,
영어로 말하면 **영어 원문을 들린 대로** 기록하고 한국어로 번역. 이것이 **병렬**로 돌고,
인입 언어를 **발화 단위로 감지**한다.

여기서 반드시 구분해야 할 것이 있다. 세션 언어가 `["ko","en"]`이고 한국어 발화일 때 KO
레인에 한국어가 보이는 것은 **두 가지 서로 다른 사건**일 수 있다.

| 관측 | 판별 | 판정 |
|---|---|---|
| `origin === "source"` + `sourceLanguage === language` | 원문 레인 | **정상. 요구 계약 그 자체** |
| `origin` 없음 + `sourceLanguage === language` | 번역 레인이 에코 | **버그** |

**판별 기준은 "언어가 같은가"가 아니라 `origin`이다.** [코드]
`live-media-pipeline.js:876-879`(원문 레인 발행), `:985-988`(필드 구성).

`presentation` 세션은 원문 레인 자체를 열지 않으므로(`:203`, `isMeeting &&`) 거기서
동일언어 캡션은 **예외 없이 버그**다.

---

## 2. 진단

### 2.1 공급자 계약: "동일언어 번역"이라는 모드는 없다

Gemini Live Translate의 `echoTargetLanguage`는 이분법이다 — `true`면 그대로 따라 읽고,
`false`면 **침묵한다**. 기본값은 `false`이고 이 리포도 `false`다. [문서]
([live-translate](https://ai.google.dev/gemini-api/docs/live-api/live-translate)) [코드]
`google-provider-adapters.js:307`

즉 "한국어를 한국어로 번역"은 모델이 할 수 있는 동작이 아니다. **KO 레인의 한국어는
① 우리가 넣은 원문이거나 ② 모델이 뱉지 말아야 할 것을 뱉은 에코**, 둘 중 하나다.

같은 성질이 OpenAI에도 있다 — *"tries not to translate speech that is already in the
selected output language"* [문서]. "tries not to"는 보장이 아니라 확률적 표현이다.

> **함의**: 어떤 단일 번역 모델을 쓰든 **원문은 별도 경로로 확보해야 한다.** 번역기에게
> 원문을 달라고 하는 것은 설계상 불가능하다.

### 2.2 양방향은 세션 2개가 맞다 — 이 부분은 바꿀 필요 없다

한 세션 = 타깃 언어 하나, setup에서 고정, 연결 중 변경 불가. [문서] 발화별 타깃 전환은
문서에 없고 pause/resume 왕복이 필요하다. 이 리포는 이미 언어당 세션을 연다. [코드]
`live-media-pipeline.js:193-219`, 오디오 팬아웃 `:268`

**대신 대가가 있다**: 입력 오디오가 세션마다 전량 과금되므로 **비용이 타깃 언어 수에 선형**.
2언어 ≈ $0.074/분. [문서] `echoTargetLanguage: true`로 바꾸면 동일언어 구간의 출력 토큰이
0에서 전량으로 바뀌어 **출력 과금이 대략 2배**가 된다.

### 2.3 핵심: 게이트웨이에 에코 가드가 없다

데스크톱은 동일언어 에코를 **네 겹**으로 막는다. 게이트웨이는 **0개**다. [코드]

| 데스크톱 가드 | 위치 | 게이트웨이 |
|---|---|---|
| `isSameLanguageEcho` | `subtitle-realtime.js:552`, `:1048` (정의 `:2294`) | 없음 |
| `isSourceEcho` (폴리시 후) | `:616`, `:1049` (정의 `:1946`) | 없음 |
| `echoRegistry.outputEchoesAnotherSource` | `:556`, `:1054` | 없음 |
| `translationRoleForSource` → null | `:1593`, 사용 `:565`/`:770`/`:1061` | 없음 |

그리고 **살아 있는 유일한 게이트는 이 버그를 원리적으로 못 잡는다.**
`isOutputInTargetLanguage`는 "이 레인의 문자가 3자 이상 나오는가"만 본다. [코드]
`language-gate.js:142-146` — KO 레인의 한국어는 자명하게 통과한다. 이 게이트는 *교차* 언어
누출용이고 *동일* 언어 에코에는 눈이 멀어 있다.

데스크톱 주석이 같은 증상을 한국어로 적어두고 있다 — `"영어가 영어로 원문 자막"`
(`subtitle-realtime.js:615`), `"Gemini transliterates same-language audio and echoes it
back"`(`:1050`). **공급자가 이런다는 전제는 추측이 아니라, 데스크톱 가드가 존재하는 이유다.**

### 2.4 이전 수정이 실행되지 않는 코드에 들어갔다

포팅된 게이트(`sourceLaneMatches`)는 `#processFinalUtterance`(`:522`)와
`#drainPartialLane`(`:359`) 안에 있다. 두 함수의 진입점인 `acceptFinalUtterance` /
`acceptPartialTranscript`는 **프로덕션 호출자가 없다.** [코드] 실제 경로는
`onCaption → #publishPresentationCaption`(`:202`)이고, `:243-246`이 직접
*"No session type reaches here anymore"*라고 적어두고 있다.

그리고 `media-gateway/test/language-gate-pipeline.test.js`는 **그 죽은 진입점만** 구동한다.
도달 불가능한 코드 위의 초록 테스트다. 이전 세션들이 "해결됨"으로 기록한 이유가 이것으로
설명된다.

`test/live-language-gate-parity.test.js`는 두 사본의 **순수 함수 일치**만 보장한다. 파이프라인이
그 함수를 호출하는지는 검사하지 않으므로, `sourceLaneMatches`를 파이프라인에서 지워도 초록이다.
에코 가드 네 개는 아예 import되지도 않는다.

### 2.5 `language-gate.js` 헤더 주석이 틀렸고, 그 틀린 근거가 판단을 정당화했다

| 주장 | 판정 |
|---|---|
| "데스크톱 결정의 PORT, parity 테스트로 고정" | **부분적으로 사실.** 탐지 primitive는 충실. **에코 가드 4개와 `translationRoleForSource`는 조용히 누락**되었고 헤더는 이를 밝히지 않음 |
| "textPlausiblyInLanguage + FAIL OPEN을 대체했다" | **거짓.** 실제 살아 있는 경로(`:847-849`)에서 여전히 결정권자 |
| "데스크톱은 레인 언어가 아니면 SUPPRESS한다" | **finals에 대해 거짓.** `:613-620`이 정반대를 명시 — *"it does not drop the caption… Keeping raw English OFF a Korean screen is the VIEWER's job"* |
| "아비터 미포팅 근거: 게이트웨이는 단일 STT라 중재할 표가 없다" | **거짓이고 근거가 낡음.** `:193`이 **언어당 세션**을 열고 각자 자기 `inputTranscription.languageCode`를 보고한다(`google-provider-adapters.js:363`). 데스크톱과 동일 토폴로지. 표는 존재하는데 중재하지 않고 `languageIndex === 0` 하나만 보고 나머지를 **버린다**(`:203`) |

마지막 항목이 특히 중요하다. 데스크톱은 소스 언어를 바꾸려면 **형제 채널 2개 이상의 합의 +
`SOURCE_HOLD_MS` 홀드**를 요구한다(`subtitle-realtime.js:1454-1458`). 게이트웨이는 단일
세션의 `languageCode`가 한 번 튀면 히스테리시스 없이 원문 레인이 즉시 이동한다. **같은
공급자 토폴로지 위에서 명백히 더 약한 보장이다.**

### 2.6 신뢰 순서가 문서와 반대다

Google 문서는 명시한다 — *"Language detection struggles with… rapid language switches.
**Note:** This should only impact the input transcript. Language codes and the final
translation should still be accurate."* [문서] 즉 **텍스트가 불안정하고 언어 코드는 정확하다.**

그런데 `live-media-pipeline.js:846-849`는 모델의 `languageCode`를 **스크립트 검사로
덮어쓴다.** 불안정하다고 문서화된 텍스트에서 파생한 휴리스틱으로, 정확하다고 문서화된 코드를
기각하는 구조다. 한영이 서로 다른 문자라 대개는 일치하지만, 코드 스위칭
발화("이 API는 stateless합니다")에서 올바른 `ko`가 기각되어 한국어 원문이 영어 레인으로 갈 수
있다.

또한 `outputTranscription.languageCode`가 존재하는데 `:326`이 `.text`만 읽는다. [문서]는 이
필드를 샘플에서 직접 출력한다. **"이 캡션의 언어 ≠ 이 세션의 타깃이면 버린다"는 불변식을
어댑터 경계에서 공짜로 걸 수 있었다.**

### 2.7 기록 필드가 세 가지 방식으로 오염된다

이 절은 **방금 만든 원문 EN/KO 탭에 직접 영향**을 준다. 탭은 각 줄에서 "요청 언어에 맞는 쪽"을
고르므로, 필드가 오염되면 탭이 감지할 방법이 없다.

1. **에코 캡션**: `text`와 `source_text`가 **둘 다 한국어**, 두 언어 필드가 동일,
   `translation_status`는 부재 → `supabase-adapters.js:79-80`이 `"translated"`로 정규화.
   **정상처럼 보이는 중복 쌍이 저장된다.**
2. **fail-open 캡션**: 원문이 양쪽 필드에. `language-gate-pipeline.test.js:78-81`이 이것을
   *의도*로 고정하고 있다 — *"The original travels in both fields"*. `translation_status`를
   무시하는 UI는 소스를 번역으로 렌더한다.
3. **원문 레인 행**: `source_text`가 **NULL**이고 원문이 `text`에 있다. "원문 = source_text"로
   읽는 UI는 아무것도 못 찾는다. `origin === "source"`면 `text`로 폴백해야 한다.

추가로 **통화 후 임포트가 번역을 원문 필드에 넣을 수 있다**:
`electron/main.js:1334-1338`이 `utterance.text → sourceText`로 매핑하는데
`translatedText`/`sourceLanguage`/`targetLanguage`가 전부 없고 `languages[0]`만 쓴다. 그리고
그 API(`webapp/app/api/live-sessions/[id]/transcript/route.ts:33-38`)는 `source_text` /
`source_language` / `origin` / `translation_status`를 **전부 버린 채** 반환하므로, 데스크톱은
원리적으로 구분할 수 없다.

**데스크톱 로컬 엔진의 기록은 건전하다.** `commitSubtitleNow`가 broadcast 전에 가드를 모두
통과시키므로 `sourceText`/`translatedText`가 항상 진짜 쌍이다.

---

## 3. 가설 순위

| # | 가설 | 확신도 |
|---|---|---|
| H1 | 게이트웨이에 에코 가드가 없고, 살아 있는 게이트는 구조적으로 이를 못 잡는다 | **기전은 코드로 확정.** 지금 실제로 발화 중인지는 미확인 |
| H2 | 이전 수정이 죽은 경로에 들어갔고 테스트도 죽은 경로를 검증한다 | **코드로 확정** |
| H3 | 원문 레인이 번역 레인으로 읽히고 있다 | 기전 확정, 해석은 화면에 따라 다름 |
| H4 | 기록 필드 반전 (§2.7) | **코드로 확정.** H1~H3와 독립적인 별개 버그 |
| H5 | 데스크톱 로컬 엔진이 같은 증상을 낸다 | **코드상 설명되지 않음.** 로컬 오버레이에서 보인다면 `settings.json` 언어 설정과 `subtitle-polish.js`를 볼 것 |

---

## 4. 확정을 위한 관측 (코드 수정 전에 이것부터)

**관측 A — 에코 행이 실제로 저장되고 있는가**

```sql
select count(*)
from public.live_utterances
where source_language = language
  and origin is distinct from 'source'
  and translation_status is distinct from 'verbatim';
```
한 건이라도 나오면 H1이 실제로 발화 중이다. 0이면 H1은 이론상 위험일 뿐이고 초점을 H3/H4로
옮겨야 한다.

**관측 B — 죽은 경로 확인**

`#processFinalUtterance` 진입에 카운터를 하나 넣고 실제 통화를 한 번 돌린다. 0으로 남으면 H2
확정이며, **지금 있는 게이트를 아무리 고쳐도 아무 일도 일어나지 않는다**는 뜻이다.

**관측 C — 공급자가 정말 에코하는가**

KO 타깃 세션의 원시 `outputTranscription`을 로깅하고 한국어로 말한다. 텍스트가 나오면
`echoTargetLanguage: false`에도 불구하고 모델이 뱉는 것이고, 나오지 않으면 KO 레인의 한국어는
전부 우리 원문 백필이다(H3).

---

## 5. 공급자 조사

### 5.1 왜 조사했는가

지금 구조의 보정 로직(`language-gate.js`, `SOURCE_VOTE_WINDOW_MS` 일체)은 **공급자가 주지
않는 신호를 유니코드 휴리스틱으로 대신 만들어내는 것**이다. 발화 단위 언어 코드를 신뢰도와
함께 주는 공급자를 쓰면 휴리스틱이 데이터로 대체된다.

### 5.2 비교

가정: 2시간 한영 회의, 양방향, 소스 약 11만 자, finals만 번역.

| | 감지 단위 | 언어 보고 | 원문+번역 한 번에 | 타깃 지정 | source==target | 2시간 비용 | 한국어 |
|---|---|---|---|---|---|---|---|
| **Gemini Live translate** (현재) | 발화, 자동 | `inputTranscription.languageCode` | 예, 단 **타깃당 세션** → 감지기 N개 | setup 고정 | **문서화됨**: 침묵(기본) | ~$5.05 | ✅ |
| **OpenAI realtime-translate** | 발화, 자동 | **없음** — 어떤 이벤트에도 언어 필드 없음 | 예, 타깃당 세션 | `session.audio.output.language` | *"tries not to"* | ~$12.24 | ✅ (13개 중) |
| **Azure 후보 LID + 번역** | 구절 단위, 문장 내 전환 불가 | 예 **+ 신뢰도 등급** | **예 — 한 결과에 둘 다** | `AddTargetLanguage()`, **최대 2** | 문서 없음 | ~$5.60 | ✅ |
| **Google STT + Cloud Translation** | 결과 단위 | 예 | 직접 조립 | 감지 결과로 우리가 결정 | 문서 없음 | ~$4.10 | ✅ |
| **AWS Transcribe LID + Translate** | **발화 단위 + `Score`** | 예 **+ 수치 신뢰도** | 직접 조립 | 감지 결과로 우리가 결정 | 문서 없음 | **~$2.85** | ✅ |
| **Soniox `two_way`** | **토큰 단위** | 예 (+번역 토큰에 `source_language`) | **예 — 한 스트림, `translation_status`로 태깅** | **쌍**(`language_a`/`language_b`) | **구조적으로 불가능** | **~$0.24–0.36** | ✅ |
| Deepgram | — | 스트리밍 LID 미지원 | 번역 없음 | — | — | ~$1.15 | **❌ multi에 한국어 없음** |
| AssemblyAI | 턴 단위 | 예 | 스트리밍 번역 없음 | — | — | — | **❌ 18개에 없음** |
| WhisperLiveKit | **~2초에 1회 래치, 재실행 없음** | JSON엔 있으나 **번역기에 전달 안 됨** | 프로토콜상 예 | `--target-language` | **가드 없음 — 같은 버그 재현** | 자체호스팅 | 표에만 있음 |
| Whisper 계열 | 첫 30초 1회 | 예 | `task=translate`는 **X→영어 전용** | 없음 | turbo는 *"원본 언어를 반환"* | 자체호스팅 | Fleurs WER 14.3–15.2, 논문이 지목한 약점 |

### 5.3 눈에 띄는 사실 넷

1. **Google 문서가 이 실패를 알려진 한계로 명시**하고 있고, 같은 모델에서 *"스페인어 타깃
   세션에 영어가 약 50% 확률로 비결정적으로 나온다"*는 미해결 포럼 리포트가 있다. [문서]
   ([thread](https://discuss.ai.google.dev/t/gemini-3-5-live-translate-preview-intermittently-outputs-english-instead-of-configured-target-language/174290))
   **그 비율이면 하위 게이팅으로 고칠 수 없고 억제만 가능하다.**
2. **Soniox `two_way`는 요구 계약에 거의 그대로 대응한다.** `{"type":"two_way",
   "language_a":"en","language_b":"ko"}`로 한 스트림에서 원문과 번역이 함께 오고
   `translation_status: "original"|"translation"`으로 태깅된다. **타깃이 아니라 쌍으로
   정의되므로 ko→ko 요청 자체가 표현 불가능하다.** 세션 300분. 비용은 현재의 약 1/10~1/20.
3. **Azure가 결과 객체 모양은 가장 좋은데 Node에서 막힌다.** 연속 LID + 번역은 C#/C++/Python만
   문서화되어 있다. 사이드카를 감수할 게 아니면 제외.
4. **Whisper 계열은 en→ko를 만들 수 없다.** `task=translate`는 영어 타깃 전용이고, turbo는
   *"원본 언어를 반환한다"* — 우리 버그가 모델 레벨에 있는 셈이다. WhisperLiveKit은 LID를
   ~2초에 한 번 래치하고 그 값을 번역기에 넘기지도 않는다. 기존에 이 프로젝트를 "스트리밍
   분절/부분-확정 분리/재연결 아이디어"로만 한정해 참고하기로 한 판단은 옳았다.

---

## 6. 권장 경로

### 6.1 지금 (공급자 교체와 무관하게 해야 하는 것)

1. **§4의 관측 A·B·C 먼저.** 세 가설의 수정 방향이 다르다.
2. **`origin`을 판별자로 쓰는 것을 클라이언트 전체에 통일.** 언어 동일성으로 판단하면 원문
   레인을 버그로 오인한다. (다른 세션이 지금 이 표면을 작업 중 — 워킹트리에
   `live-caption-display-policy.js`, `caption-feed.ts`, `LiveViewer.tsx`, transcript API
   변경이 있다.)
3. **`outputTranscription.languageCode`를 읽어 어댑터 경계에서 불변식으로 건다.** 공짜이고,
   이 버그 부류를 발생 지점에서 잡는다.
4. **transcript API가 `source_text`/`source_language`/`origin`/`translation_status`를 버리는
   것을 고친다.** 이걸 버리면 데스크톱이 원문과 번역을 구분할 방법이 없다(§2.7).
5. **테스트가 살아 있는 경로를 구동하게 만든다.** 지금 파이프라인 테스트는 죽은 진입점을
   호출한다. 이것을 고치지 않으면 다음 수정도 같은 방식으로 조용히 무력화된다.

### 6.2 중기: 분리형 2단계를 권장

요구 계약에는 독립적인 두 의무가 있다 — **(a) 원문은 항상** 내보내고, **(b) 번역은 소스 ≠
레인일 때만**. 단일 번역 모델은 (a)를 깨끗하게 수행할 수 없다. 타깃 하나로 설정되고, "입력이
이미 타깃"에 대한 대답이 **침묵**이기 때문이다.

분리하면 제어 흐름이 뒤집힌다. 인식기 하나가 발화당 `(텍스트, 언어코드, 신뢰도)`를 주고,
**타깃은 산술이 된다** — `target = {ko,en} \ {detected}`. src==tgt 호출을 애초에 하지 않으므로
표의 "문서 없음" 칸들이 전부 무의미해진다.

- **1순위 스파이크: Soniox `two_way`.** 파이프라인을 직접 만들지 않고 분리형 *의미론*을
  얻는다. 리스크는 정직하게: 3대 클라우드보다 작은 벤더이고, 품질 수치는 **벤더 자체 발표**뿐
  이며 독립적인 한영 벤치마크를 찾지 못했고, 지연 시간 수치가 문서에 없다. 60초 프로브로 답이
  나오는 것들이다.
- **대안(제도적으로 안전한 쪽): AWS Transcribe `IdentifyMultipleLanguages` + Translate.** 모든
  링크가 한국어로 문서화되어 있고, **발화당 수치 신뢰도(`Score`)**를 주는 유일한 클라우드다 —
  `SOURCE_HOLD_MS` 히스테리시스를 원칙 있는 임계값으로 대체할 수 있다. 4시간 세션 + 재개 창.

### 6.3 대가

- **지연**: 분리형은 발화당 왕복이 하나 늘어난다. Google도 AWS도 Translate 지연 수치를
  공개하지 않는다. Soniox가 예외인 이유가 이것 — 같은 스트림 안에서 단어 단위로 번역 토큰을
  낸다.
- **비용**: STT는 싸지고 문자 과금이 붙는다. finals만 하면 작지만 **interim을 번역하면 크게
  늘어난다.** Azure가 이 현상을 직접 문서화한다.
- **품질**: 오디오를 직접 듣는 번역 모델이 운율·화자 맥락을 가진다. 종이 위에서는
  Gemini/OpenAI가 번역 *품질*에서 유리하고 라우팅 *정확도*에서 불리하다. 이를 판정할 인용
  가능한 한영 벤치마크를 **찾지 못했다** — 자체 오디오로 결론 낼 것.
- **용어집/폴리시 파이프라인은 영향 없음.** 캡션 텍스트에 작용하므로 공급자 하류에 있다.
  오히려 진짜 STT 원문이 폴리시 입력을 깨끗하게 만든다.

---

## 7. 검증되지 않은 것 (그대로 두었다)

- H1이 **지금 실제로** 발화 중인지 — §4 관측 A로만 확정 가능
- `echoTargetLanguage: false`에서 `outputTranscription`이 나오는지 여부는 **문서화되어 있지
  않다**. "침묵"은 오디오에 대한 서술이다
- Gemini Live translate 모델에 VAD(`realtimeInputConfig`)를 보내는 것이 유효한지 —
  문서 근거 없음. `google-provider-adapters.js:312-317`은 미검증으로 두고 새 동작을 여기에
  얹지 말 것
- Azure interim 번역 가용 여부 — 언어별 문서가 서로 다르게 서술
- Soniox 지연/한영 품질 — 벤더 자체 발표 외 근거 없음
- 한영 자막 품질을 판정할 공개 벤치마크 — 찾지 못함

---

## 출처

Gemini: [live-translate](https://ai.google.dev/gemini-api/docs/live-api/live-translate) ·
[WebSockets ref](https://ai.google.dev/api/live) ·
[session](https://ai.google.dev/gemini-api/docs/live-session) ·
[pricing](https://ai.google.dev/gemini-api/docs/pricing) ·
[미해결 포럼 리포트](https://discuss.ai.google.dev/t/gemini-3-5-live-translate-preview-intermittently-outputs-english-instead-of-configured-target-language/174290)

OpenAI: [realtime translation](https://developers.openai.com/api/docs/guides/realtime-translation) ·
[cookbook](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide) ·
[pricing](https://developers.openai.com/api/docs/pricing)

Azure: [speech translation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-translation) ·
[language identification](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-identification)

Google Cloud: [STT multiple languages](https://docs.cloud.google.com/speech-to-text/docs/multiple-languages) ·
[Chirp 3](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3) ·
[Translation v3](https://docs.cloud.google.com/translate/docs/reference/rest/v3/projects/translateText)

AWS: [streaming LID](https://docs.aws.amazon.com/transcribe/latest/dg/lang-id-stream.html) ·
[Result](https://docs.aws.amazon.com/transcribe/latest/APIReference/API_streaming_Result.html) ·
[Transcribe pricing](https://aws.amazon.com/transcribe/pricing/)

Soniox: [realtime translation](https://soniox.com/docs/translation/stt-translation/rt-translation) ·
[websocket API](https://soniox.com/docs/api-reference/stt/websocket-api) ·
[limits](https://soniox.com/docs/stt/rt/limits-and-quotas)

Whisper 계열: [Whisper paper §3.6](https://ar5iv.labs.arxiv.org/html/2212.04356) ·
[large-v3 card](https://huggingface.co/openai/whisper-large-v3) ·
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) ·
[WhisperLiveKit API](https://github.com/QuentinFuxa/WhisperLiveKit/blob/main/docs/API.md)
