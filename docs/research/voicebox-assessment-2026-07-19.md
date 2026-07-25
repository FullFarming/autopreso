# Voicebox 적용성 분석 — 2026-07-19

## 검토 기준

- 대상: [`FullFarming/voicebox`](https://github.com/FullFarming/voicebox), main
  `f2cf2a729d733acd7c759d85c6ace2d602f50d6e`
- 동일 revision은 README가 가리키는 upstream `jamiepine/voicebox`와 일치했다.
- 비교 범위: TTS 생성, 문장 분할, 작업 큐·취소, 상태 전달, 화자별 음성 지정, 개인정보와 합성음 고지.
- 이번 검토는 소스와 로컬 fake provider만 사용했다. 모델 다운로드, 실제 음성, 외부 API, 배포는 실행하지 않았다.

## 구조 차이

Voicebox는 한 사용자의 장치에서 모델·참조 음성·생성 파일·히스토리를 관리하는 local-first 음성 제작
도구다. Realtime Noel은 한 호스트의 실시간 입력을 최대 세 언어로 변환하고 최대 50명에게 같은 결과를
전달하는 세션 기반 중계 제품이다. 따라서 Voicebox의 엔진 수나 음성 복제 기능을 가져오는 것보다,
긴 작업을 안전하게 분할하고 취소하며 상태를 보이게 하는 운영 패턴이 직접적인 개선점이다.

| Voicebox 관찰 | Noel 판단 | 적용 결과 |
|---|---|---|
| 문장 경계, CJK 문장부호, Unicode를 고려한 긴 TTS 입력 분할 | 채택 | Chirp 제한보다 작은 UTF-8 4,999-byte 단위로 분할하고 code point·문장 경계를 보존 |
| 청크 사이 crossfade로 클릭 완화 | 변형 채택 | 저장 파일 병합 대신 실시간 PCM 경계에서 짧은 fade와 peak limiting 적용 |
| GPU 경합을 막는 직렬 생성 큐 | 변형 채택 | 전체 직렬화는 언어 간 지연을 만들므로 언어별 순서 보장 큐로 격리 |
| queued/running 작업 취소와 상태 이벤트 | 채택 | provider AbortSignal, 3초 Townhall deadline, disconnect 취소, 명시적 오류 이벤트 적용 |
| client/profile별 고정 voice binding | 채택 | `(targetLanguage, speakerId)`별 Chirp 음색을 세션 동안 고정 |
| 말하는 동안 항상 보이는 speaking pill·profile명 | 채택 | Host·Viewer·PiP·Chrome에 `AI 합성 통역 음성`과 재생 조건을 사전 고지 |
| subscriber별 bounded queue | 원칙만 채택 | 오디오를 조용히 버리지 않고 server/browser 3초 상한에서 연결을 명시적으로 중단 |
| 실패 작업 재시도와 crash stale cleanup | 변형 채택 | 자동 fallback은 금지하고 close single-flight·실패 후 shutdown 재시도·candidate orphan 정리 적용 |

## 의도적으로 적용하지 않은 항목

1. **음성 복제** — Townhall은 원화자의 음성 복제를 요구하지 않는다. 동의 증거를 보유하지 않는
   다화자 회의에서 clone을 만들면 사칭·생체정보·관할별 동의 문제가 커진다. Chirp preset 음색을
   고정하고 합성음임을 표시하는 현재 결정을 유지한다.
2. **로컬 생성 파일·전체 히스토리** — Voicebox의 제작 워크플로에는 유용하지만 Noel은 원본 음성,
   음성 특징, 전체 transcript를 저장하지 않는 것이 보안 경계다. 마지막 확정 자막 snapshot만 유지한다.
3. **7개 로컬 TTS 엔진과 모델 관리 UI** — Cloud Run의 연결 수·메모리·cold start와 운영 복잡도를
   크게 늘리고 실시간 3개 언어 지연 목표에 직접 도움이 되지 않는다.
4. **전역 단일 생성 큐** — 한 언어의 느린 TTS가 나머지 언어를 막으므로 채택하지 않았다.
5. **가득 찬 상태 큐의 oldest drop** — 상태 알림에는 허용될 수 있지만 Townhall PCM에 적용하면
   시청자가 모르는 음성 누락이 생긴다. Noel은 `SLOW_CONSUMER` 또는 `QUEUE_LATENCY_EXCEEDED`로
   fail-closed한다.
6. **장치 로컬 API/MCP 공개** — 이번 제품의 6자리 입장, 세션·언어 권한, private broadcast 계약을
   우회하므로 도입하지 않았다.

## 적용된 코드 경계

- `media-gateway/src/tts-text-segmentation.js`: UTF-8·CJK 안전 분할.
- `media-gateway/src/pcm-conditioning.js`: 음량 보정, peak limiting, 합성 경계 fade.
- `media-gateway/src/google-provider-adapters.js`: Chirp v1 bidirectional streaming, buffer 상한과 취소.
- `media-gateway/src/ordered-task-queue.js`: 언어별 순서와 3초 지연 중단.
- `media-gateway/src/gateway-server.js`: heartbeat, token 만료, bounded host operation, atomic swap과 정리.
- `webapp/components/live/live-audio-client.ts`: bounded reconnect와 WebAudio queue 상한.
- `webapp/components/live/LiveViewer.tsx`: 재생 동작, terminal slow-consumer, socket/source 정리.
- `chrome-extension/sidepanel.html`: Townhall 합성음과 사용자 재생 고지.

## 결론과 다음 검증

Voicebox의 가장 가치 있는 교훈은 더 많은 음성 모델이 아니라 **분할·직렬화·취소·상태 가시성·고정
identity**다. 이 다섯 패턴은 Noel의 실시간 구조에 맞춰 적용했다. 로컬 fake provider 검증은 완료됐지만,
실제 Chirp 첫 바이트 지연, Supabase `AbortSignal`, 50명·3언어 30분 부하는 개발 프로젝트 승인 뒤에만
검증한다. 로컬 Node는 v23.11.0이고 `media-gateway` 요구 버전은 Node 24 이상이므로 실제 통합 검증은
Node 24 환경에서 수행해야 한다.
