# 캡션 엔진(STT·번역) 공급자 비교 조사 (2026-09-02)

조사 방식: 각 공급자의 공식 문서·가격 페이지를 직접 확인. 확인하지 못한 항목은 UNVERIFIED로 표시. 어느 공급자도 한국어 지연·WER 수치를 공개하지 않으므로 순위는 **검증된 계약 기능 + 가격** 기준이며, 한국어 실측(bake-off)은 별도로 필요하다.

요구 조건: 16kHz mono PCM 40ms 프레임 스트리밍, 부분 자막 300~500ms, 확정 1~2s, 문장 번역 2s 이내, Node 24(Cloud Run)와 Electron에서 동작, 용어집·고유명사 처리, **한국어 인식 품질 최우선**.

## A. 스트리밍 STT

| 공급자 / 모델 | 프로토콜 | ko/ja | 부분 결과·지연 | 용어집 | 소스 언어 고정 | 세션 한도 | 가격 | 비고 |
|---|---|---|---|---|---|---|---|---|
| **Google `gemini-3.5-transcribe-live`** (현행) | Live API WS, 16kHz PCM | ko-KR, ja-JP (85+ 언어, 코드스위칭) | interim + final. 지연 수치 미공개 | `customVocabulary` ≤1,000 (권장 ≤100) | `languageCodes`는 **편향(bias)일 뿐 강제 아님** | **세션 10분** | 오디오 $3.50/1M tok ≈ $0.005/분 + 텍스트 출력 ≈ $0.004/분 | 언어 강제 불가, 10분 재연결, 8/31 가용성 장애 이력 |
| **Google Cloud STT v2 `chirp_3`** | gRPC StreamingRecognize | ko-KR, ja-JP 스트리밍 GA | interim_results, endpointing 조절 | PhraseSet ≤1,200개, boost ≤20 | **강제** (`language_codes:["ko-KR"]`) | **스트림 5분** (회전 필요) | **$0.016/분** (구간 할인) | gRPC, Gemini의 3배 가격 |
| **OpenAI `gpt-live-transcribe`** (2026-07) | Realtime WS/WebRTC | 57개 언어 주장, **한국어 명시 없음 (UNVERIFIED)** | delta/completed, 지연 수치 없음 | `prompt` 자유 텍스트 | `languages`는 힌트 | UNVERIFIED | **$0.017/분** (`gpt-4o-transcribe` $0.006, mini $0.003) | 가장 비쌈, 16kHz 수용 UNVERIFIED |
| **Deepgram Nova-3 `language=ko`** | WS `/v1/listen` | ko, ja 스트리밍 지원. **`multi` 코드스위칭에 한국어 없음** | interim + endpointing 표준. "300ms 이하"는 제3자 주장 | **한국어 keyterm 확인**, ≤500 토큰(~100단어) | **강제** (`language=ko`, 연결당 1언어) | 미문서화 | **$0.0048/분 + keyterm $0.0013/분** | ko↔en 혼용은 소켓 2개 + 자체 중재 필요 |
| AssemblyAI Universal-3.5 | WS | ja만, **한국어 없음** | — | — | — | — | — | **한국어 미지원으로 제외** |
| Speechmatics Realtime | WS | 한국어 지원(벤더 주장 WER 5.22%) | partials <500ms, finals `max_delay` 0.7~4s(기본 4s) | 사전 ≤1,000 단어 | 강제(연결당 1언어) | 미문서화 | 페이지에 단위 없음, **UNVERIFIED** | 기본 4s 확정 지연은 낮춰야 함 |
| ElevenLabs Scribe v2 Realtime | WS, pcm_16000 | kor, jpn | partial/committed, "~150ms" 벤더 주장 | **≤50 keyterm × 20자** | `language_code` | 미문서화 | $0.0065/분 + keyterm $0.05/시 | 용어집 너무 작음(한국어 복합명사 20자 제한) |
| **Soniox `stt-rt-v5`** | WS, raw PCM | 60+ 언어, ko/ja 실시간 포함 | `is_final` 토큰, endpoint 500~3000ms | `context` ≤**10,000자** (용어·도메인·**번역 용어 매핑**) | `language_hints_strict: true` **강제** | **스트림 300분** | **$0.002/분** + context 텍스트 $4/1M tok, **번역 포함 무료** | 소규모 벤더, 한국어 정확도 미검증 |
| Azure AI Speech | SDK WS | ko-KR, ja-JP | recognizing 이벤트 | Phrase list ≤500 (ko-KR 지원 UNVERIFIED) | 강제 | 미문서화 | 페이지 마스킹, **UNVERIFIED** | |
| 2026 신규 | | | | | | | | **Mistral Voxtral Realtime** (`voxtral-mini-transcribe-realtime-2602`): ko/ja 포함 13언어, sub-200ms 조절, 편향 ≤100용어이나 "영어 외 실험적", $0.006/분, Apache-2.0 가중치. **Gladia Solaria-1**: 100언어, 한국어 명시 UNVERIFIED |

## B. 문장 번역 (짧은 문장 + 용어집)

| 공급자 / 모델 | 용어집 | ko/ja | 가격 /1M tok | 비고 |
|---|---|---|---|---|
| **Gemini `gemini-3.7-flash` / `3.6-flash`** (현행) | 프롬프트 주입 | ○ | $0.75 in / $3.75 out (2026-12-31까지, 이후 $1.50/$7.50) | `gemini-3.5-flash-lite` $0.30/$2.50. 지연 SLA 없음 |
| **OpenAI `gpt-5-nano` / `gpt-5-mini`** | 프롬프트 | ○ | **$0.05/$0.40**, **$0.25/$2.00** | 최저가 LLM 레인, 교차 벤더 폴백 |
| Anthropic Claude Haiku 4.5 / Sonnet 5 | 프롬프트(캐시 0.1x) | ○ | $1/$5, $2/$10 | 3번째 폴백 후보 |
| **DeepL `latency_optimized` + glossary** | **네이티브 용어집, ko·ja 소스/타깃 모두 지원**, `source_lang` 필수 | ○ | 무료 50만자/월, Pro 요금 UNVERIFIED | **결정적 용어 강제**가 가능한 유일한 경로 |
| Google Cloud Translation v3 | 용어집 지원 | ○ | NMT $20/M자, LLM $10/$10, Adaptive $25/$25 | **Adaptive는 1 QPS 제한** → 실시간 불가 |
| Azure Translator | Custom Translator(학습형) | ○ | $10/M자 | 세션별 용어집에 과함 |

**실시간 음성→번역 단일 API**: Gemini `live-translate-preview`는 소스 언어 고정 불가(공식 문서도 "유사 언어에서 자동 감지가 어렵다"고 명시), 오디오 출력 $0.0315/분. Azure Live Interpreter도 자동 감지만 지원(같은 실패 모드). Azure 표준 speech translation과 Soniox one-way translation만 소스 고정 + 중간 번역을 제공하지만 번역 측 용어집이 없거나 미검증. **2단계(STT + 텍스트 번역) 파이프라인을 대체할 단일 API는 아직 없다.**

## 권장 순위

**STT (한국어 우선)**
1. **Soniox stt-rt-v5** — 한국어 강제 고정, 10k자 컨텍스트, 300분 세션, 현행의 1/2.5 가격. 단 한국어 정확도 미검증·소규모 벤더 → bake-off 필수.
2. **Deepgram Nova-3 ko** — 한국어 keyterm 검증, 성숙한 WS, $0.0061/분. 소켓당 1언어라 ko↔en 전환은 소켓 2개 + 기존 중재기.
3. **Gemini 3.5 Transcribe Live** — 폴백으로 유지. 언어 커버리지·1,000 용어는 최고지만 한국어 고정 불가, 10분 세션, 가용성 이력.
4. Chirp 3 (강제 고정·1,200 phrase지만 gRPC·5분 회전·3배 가격), 5. Voxtral Realtime(다크호스), 6. 나머지는 1~3 실패 시에만.

**번역 (<2s, 용어집)**
1. `gemini-3.5-flash-lite` → 품질 필요 시 `gemini-3.7-flash` (이미 연결됨, 가장 싼 동일 계열 교체)
2. `gpt-5-nano` → `gpt-5-mini` 교차 벤더 폴백
3. DeepL latency_optimized + ko/ja 용어집 — 결정적 용어 강제 레인
4. Claude Haiku 4.5
5. Google Translation LLM

## 어댑터 인터페이스 (최소)

```ts
interface SttAdapter {
  start(cfg: SttConfig): Promise<void>;                // 재연결·스트림 회전(Chirp 5분, Gemini 10분) 내부 처리
  pushAudio(pcm16le16k: Buffer, tsMs: number): void;   // 1280B/40ms, 필요 시 어댑터가 리샘플
  finalize(): void;
  updateVocabulary?(terms: string[]): void;            // 미지원이면 no-op + 재연결
  stop(): Promise<void>;
  on(ev: "interim"|"final"|"language"|"error"|"reconnected", h: (e: SttEvent) => void): void;
}
interface SttConfig { sourceLanguages: string[]; strictSource: boolean; vocabulary: string[]; contextText?: string; endpointingMs: number; sampleRate: 16000; }
interface SttEvent { kind: "interim"|"final"; text: string; language?: string; startMs?: number; endMs?: number; utteranceId: string; confidence?: number; }

interface TranslateAdapter {
  translate(req: TranslateRequest, signal: AbortSignal): Promise<TranslateResult>; // 호출자가 2s 기한·폴백 체인 소유
  prepareGlossary?(g: GlossaryEntry[], pair: [string, string]): Promise<string>;
}
interface TranslateRequest { text: string; sourceLang: string; targetLangs: string[]; glossaryRef?: string; glossary: GlossaryEntry[]; priorContext?: string[]; }
interface TranslateResult { translations: Record<string, string>; provider: string; model: string; latencyMs: number; glossaryHits?: string[]; }
```

라우팅에 필요한 capability 플래그: `canPinSource` (Gemini Live·OpenAI는 false), `maxSessionMs` (Gemini 600k, Chirp 300k, Soniox 18M).

## 출처
Gemini: ai.google.dev/gemini-api/docs/live-api/live-transcribe, /docs/live-api/live-translate, /docs/pricing · Chirp 3: docs.cloud.google.com/speech-to-text/docs/models/chirp-3 · OpenAI: developers.openai.com/api/docs/guides/realtime-transcription, /docs/pricing · Deepgram: developers.deepgram.com/docs/keyterm, deepgram.com/pricing · Soniox: soniox.com/docs/stt/rt/real-time-transcription, soniox.com/pricing · ElevenLabs: elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime · Speechmatics: docs.speechmatics.com/speech-to-text/realtime/output · DeepL: developers.deepl.com/docs/api-reference/glossaries · Google Translation: cloud.google.com/translate/pricing · Mistral: mistral.ai/news/voxtral-transcribe-2
