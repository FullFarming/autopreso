# Gemini Live API 문서군 전수 조사 (2026-09-02)

조사 대상 14개 페이지를 직접 조회했다. 인용은 원문 그대로이며, 조회한 페이지에 없는 항목은 UNVERIFIED로 표시한다.

출처: 개요 `/docs/live-api`, capabilities `/docs/live-guide`, 도구 `/docs/live-tools`, 세션 `/docs/live-session`, Transcribe `/docs/live-api/live-transcribe`, Translate `/docs/live-api/live-translate`, SDK `/docs/live-api/get-started-sdk`, WebSocket `/docs/live-api/get-started-websocket`, ephemeral `/docs/ephemeral-tokens`, 모델 `/docs/models`(+ 각 모델 카드), 가격 `/docs/pricing`, WS 레퍼런스 `ai.google.dev/api/live`, best practices `/docs/live-api/best-practices`, ADK `adk.dev/live/models/`, LiveKit, Pipecat.

## 1. 현재 Live 모델 ID

| 모델 | 설명(원문) | 입출력 |
|---|---|---|
| `gemini-3.1-flash-live-preview` | "High-quality, low-latency Live API model for real-time dialogue" (2026-03) | 입력 텍스트·이미지·오디오·영상 / 출력 "Text and audio" (텍스트는 전사로만) |
| `gemini-2.5-flash-native-audio-preview-12-2025` | 네이티브 오디오 대화 | 출력 "Audio and text", 출력 8,192 tok |
| `gemini-3.5-transcribe-live` / `gemini-3.5-transcribe` | "New Stable", "Automatically detects 85+ languages, handles multi-language code-switching" (2026-08) | 오디오 → 텍스트 |
| `gemini-3.5-live-translate-preview` | "Low-latency, real-time speech to speech translation model that supports 70+ languages" (2026-06) | 오디오 → "Audio (translated speech) and Text (transcript)" |

## 2. 핵심 질문 답

**Q1. 범용 Live 모델에 TEXT 출력이 가능한가 → 불가.** live-guide: "The native audio models only support `AUDIO` response modality." / "If you need the model response as text, use the output audio transcription feature." 현재 범용 Live 모델 둘 다 네이티브 오디오 모델이다. ADK·LiveKit·Pipecat 문서도 동일하게 "TEXT modality는 비네이티브 모델에서만" 이라고 적는다. Live API에서 `responseModalities: ["TEXT"]`가 문서화된 곳은 **Transcribe Live뿐**이다.

**Q2. 범용 모델에 "번역가" 시스템 지시 → 계약상 유효하나 자막용으로 부적합.** `systemInstruction`은 존재하고 best practices에 "RESPOND IN {OUTPUT_LANGUAGE}"를 권한다. 그러나 (가) 모델이 번역을 *말하고* 텍스트는 `outputTranscription`(생성 음성의 전사)으로만 온다. (나) 응답은 VAD 침묵 뒤에 시작한다: `silenceDurationMs` "The required duration of detected non-speech… this will increase the model's latency." (다) 발표자가 계속 말하면 기본 `START_OF_ACTIVITY_INTERRUPTS`로 자기 번역을 끊는다. (라) 중간 번역(partial)이 없다. 500ms 부분 자막은 이 프로필로 불가능하다.

**Q3. 한 세션에서 다중 대상 언어 텍스트 / 구조화 출력 → 불가.** 모델 카드에 Structured outputs "Not supported". live-tools는 Search·function calling만 지원. 프롬프트로 "ko 다음 en으로 말해라"는 오디오·turn 단위이고 신뢰성 UNVERIFIED. Live Translate는 `targetLanguageCode`가 단일 스칼라 필드다.

**Q4. 범용 모델의 원문 전사 → 가능하나 언어 고정 없음.** `inputAudioTranscription` "If set, enables transcription of voice input." `languageCode`(BCP-47) 포함. "The transcription is sent independently of the other server messages and there is no guaranteed ordering." 언어: "Native audio output models automatically choose the appropriate language and don't support explicitly setting the language code." `interimInputTranscription`을 범용 모델이 내는지는 UNVERIFIED.

**Q5. Live Translate.** 필드는 `targetLanguageCode`("Required… BCP-47", 기본 "en")와 `echoTargetLanguage`("If true, the model will generate audio when the target language is spoken, essentially it will parrot the input") 둘. 소스 언어 필드 없음. 문서 한계 원문: **"Language detection struggles with heavy accents, similar languages (e.g., Spanish vs. Portuguese), or rapid language switches."** "Only audio input is supported for translation." 출력은 `responseModalities=["AUDIO"]` + 입력/출력 전사. TEXT 전용 UNVERIFIED. 세션 한도 UNVERIFIED. 용어집 없음. 100ms 청크 권장.

**Q6. Transcribe Live.** setup: `inputAudioTranscription: { languageCodes, customVocabulary, mode: "SMART"|"VERBATIM" }`, `responseModalities: ["TEXT"]`. `languageCodes`는 **힌트**: "BCP-47 language codes providing hints about the languages present in the audio. If omitted or empty, defaults to automatic language detection." 가이드: 명시하면 "bias recognition toward specific languages." `customVocabulary` "up to 1,000 phrases… best results are typically achieved with up to 100 terms". 출력 `interim_input_transcription`("low-latency, speculative partial hypotheses… These partial updates occur rapidly with minimal delay")와 `input_transcription`("finalized transcript emitted when the speaker pauses"). 한도 "continuous streaming for up to 10 minutes". 화자 분리·단어 타임스탬프 미지원.

**Q7. 세션 한도.** 범용: "Without compression, audio-only sessions are limited to 15 minutes"; 컨텍스트 압축 시 무제한; 연결 수명 "around 10 minutes"; 재개 토큰 "valid for 2 hr". `GoAway`는 `timeLeft` 포함. Transcribe Live 10분(재개 지원 UNVERIFIED), Translate UNVERIFIED.

**Q8. 언어.** live-guide "97 languages"(개요는 70이라 문서 불일치), ko·ja·en 포함. Transcribe 85+ (`ko-KR`, `ja-JP`, `en-US`). Translate 70+ (`ko`, `ja`, `en`).

**Q9. 가격.** 청구 단위: "25 tokens per second of audio" → 1M 오디오 토큰 ≈ 667분.

| 프로필 | 입력 | 출력 | 연결당 ≈ $/분 |
|---|---|---|---|
| 3.1 Flash Live | $3.00/1M ($0.005/분) | 텍스트 $4.50/1M, 오디오 $12.00/1M ($0.018/분) | ≈ $0.023 + 전사 텍스트 (오디오 출력 회피 불가) |
| Transcribe Live | $0.005/분 | 텍스트 $0.004/분 | **≈ $0.009** |
| Live Translate | $0.0053/분 | 오디오 $0.0315/분 | **≈ $0.037 × 대상 언어 수** |

**Q10. Ephemeral 토큰.** "can only be used to start a single session", `expireTime` 기본 30분, `newSessionExpireTime` 기본 1분, `liveConnectConstraints`로 모델·config 잠금 가능, v1beta 전용. Transcribe/Translate 모델 수용 여부 UNVERIFIED. 현재 Electron은 main 프로세스가 HOST 소켓을 들고 있어 서버 발급 토큰 흐름과 맞는다.

**Q11. 기타.** 3.1은 한 `serverContent`에 오디오와 전사가 동시에 담길 수 있음. 청크: 범용 20~40ms, Transcribe/Translate 100ms(현재 40ms 프레임 2~3개 묶기). 범용 모델 `thinkingLevel` 기본 `minimal`; Transcribe/Translate에는 thinking 토글 없음.

## 3. 세 프로필 비교

| | 범용 네이티브 오디오 + 시스템 지시 | Transcribe Live | Live Translate |
|---|---|---|---|
| 출력 필드 | 오디오 `modelTurn`, `inputTranscription`, `outputTranscription` | `interimInputTranscription`, `inputTranscription`(+`languageCode`) | 번역 오디오, `inputTranscription`, `outputTranscription` |
| TEXT 모달리티 | ✗ (AUDIO만) | ○ | 미문서(AUDIO만 제시) |
| 소스 언어 고정 | ✗ 자동 | 힌트(편향) | ✗ 자동, 전환에 약함 |
| 연결당 다중 대상 | 프롬프트만, 오디오, 신뢰성 없음 | 해당 없음 | 대상 1개 |
| 스트리밍 | VAD 침묵 뒤 turn 단위 | interim 연속 + 정지 시 final | 발화별 오디오, 텍스트는 오디오를 따라감 |
| 용어집 | 프롬프트만 | `customVocabulary` ≤1,000 | 없음 |
| 세션 | 15분(압축 시 무제한), 연결 ~10분 | 10분 | UNVERIFIED |
| $/분 | ≈ $0.023+ | ≈ $0.009 | ≈ $0.037 × 대상 수 |

## 4. 판정

- **계약상 유효**: 범용 모델 + 시스템 지시(오디오 출력, 텍스트는 전사), Transcribe Live TEXT, Live Translate(대상 1개/세션 + 전사).
- **자막 제품에 실용적**: **Transcribe Live**만이 부분 텍스트 <500ms·언어 힌트·용어집·최저가를 동시에 만족한다. 번역 텍스트(1~3 대상)는 기존 REST 텍스트 번역과 결합해야만 얻는다. Live Translate는 오디오 출력 비용을 감수할 때 언어별 추가 연결로만 의미가 있고, 번역 텍스트의 partial은 문서화되지 않았다.
- **배제**: 범용 Live 모델을 텍스트 번역기로 쓰는 안(TEXT 없음, 침묵 뒤 turn 단위, 자기 발화 끼어들기, 구조화 출력 없음, 버리는 오디오에 $0.023/분 지불), 한 세션 다중 대상 JSON 안(미지원).

즉 **"Gemini 하나의 연결로 음성 → 언어별 번역 텍스트"는 어떤 Live 프로필로도 구성할 수 없다.** Gemini만으로 가려면 Transcribe Live(원문) + Flash 텍스트 번역(언어별)의 2단계가 유일하다.
