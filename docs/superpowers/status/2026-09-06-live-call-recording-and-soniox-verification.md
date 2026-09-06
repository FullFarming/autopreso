# Live Call 검증 — 자막 미기록 원인, 끊김 로그, Soniox 공식 문서 대조 (2026-09-06)

사용자 보고(2026-09-06 15:0x KST 세션 `f70e50c0…`): ① 연결이 끊기고 다시 붙는다 ② 번역 자막이 기록되지 않는다 ③ 번역 품질이 낮다. 세 가지를 데이터로 검증했다.

## 1. 자막 미기록 — 원인 확정, 수정·운영 반영 완료

**증거.** 원문(`live_source_utterances`) 7건 저장, 자막(`live_utterances`) 0건, 스냅샷 0건. Supabase 로그에서 `persist_live_final_caption_if_active`는 14회 모두 **200**(어제의 400과 다름) → 함수가 예외 없이 `false`를 반환. 8/31~9/1 세션도 자막은 있었지만 `authoritative_source_id`가 연결된 행은 전체 DB에 **0건**.

**원인.** 게이트웨이가 저장용 이벤트에 뷰어용 키 `authoritativeSourceId`·`sourceSequence`를 그대로 넣는데, 스냅샷 기본 검증기 `persist_live_snapshot_if_active_20260725`는 허용 목록 밖의 최상위 키가 하나라도 있으면 예외 대신 `false`를 돌려준다. 그래서 스냅샷 → 원자적 최종 저장이 통째로 조용히 실패했다. 운영 DB에서 롤백 프로브로 확정: 게이트웨이와 같은 이벤트 → `false`, 두 키만 제거 → `true`.

**수정.** 커밋 d73772a.
- 게이트웨이 어댑터가 `p_event`에서 두 키를 제거(링크는 이미 `p_authoritative_source_id` 컬럼으로 전달). 단위 테스트 추가(수정 전 RED).
- 마이그레이션 `202609060002_live_final_caption_wire_keys.sql`: 17인자 함수가 위임 전에 두 키를 제거(이중 방어). 운영 적용 후 롤백 프로브: `stored=true, live_utterances=1, linked=1, snapshots=1`.
- 게이트웨이 리비전 `realtime-noel-media-gateway-wirekeys-20260906`(digest 15cd0e57…) 배포, 트래픽 100%, `/health` 200.

**정정.** 어제 기록에서 운영 리비전 `nova-20260905`가 "hardening 브랜치(ec128de) 시점 이미지"라고 적었는데, Cloud Build 소스 tarball의 `live-media-pipeline.js` 해시가 통합 트리(4c2cbbf/d432d96)와 일치했다. 즉 운영 게이트웨이는 처음부터 통합 코드였다. `head-20260906` 리비전은 불필요했고, 이번 `wirekeys-20260906`이 유일한 실제 변경(어댑터 키 제거)이다.

## 2. "연결이 끊겼다가 붙는다" — 오늘은 호스트가 아니라 뷰어 소켓

Cloud Run 요청 로그(06:00Z): **호스트 소켓은 63.8초 = 세션 전체 동안 1회 연결 유지**(어제의 42702 원인은 해소됨). 뷰어 소켓은 47초 뒤 0.39 s → 0.70 s → 0.23 s → 5.3 s로 4회 재접속(Vercel에도 `viewer-gateway-ticket` 4회, 06:00:56~58). 게이트웨이는 종료 사유를 로그에 남기지 않아 코드는 확정하지 못했지만, 뷰어 재접속 경로는 `lastSeq` 이후 누락 자막을 DB에서 재생(`replayUtterances`)하고 실패 시 `REPLAY_FAILED`(4411)로 닫는다. 자막이 한 건도 저장되지 않은 상태와 시기가 일치하므로 §1 수정 뒤 재확인이 필요하다. **후속(관측성)**: 게이트웨이가 소켓 종료 코드·사유를 구조화 로그로 남기도록 추가할 것.

## 3. Soniox 공식 문서 대조 (품질·끊김 관점)

| 항목 | 공식 문서 | 우리 구현 | 판정 |
|---|---|---|---|
| 엔드포인트 | `wss://stt-rt.soniox.com/transcribe-websocket` | 동일(+ jp 리전 상수) | OK |
| 모델/오디오 | `stt-rt-v5`, pcm_s16le, sample_rate·num_channels 필수 | 동일(16 kHz mono) | OK |
| `max_endpoint_delay_ms` 500–3000(기본 2000), `endpoint_sensitivity` −1~1(기본 0), `endpoint_latency_adjustment_level` 0–3(기본 0) | 저지연 권장값 1500 / 0.3 / 2 | 2000 / 0.0 / 0 (전부 기본값) | 문서 범위 내. 지연을 줄이려면 권장값으로 조정 가능(품질 영향 없음이 문서상 명시되진 않음) |
| 번역 | `two_way`는 language_a≠language_b; 번역 토큰은 타임스탬프 없음, `translation_status` original/translation, 최종·비최종 모두 번역 | two_way ko/en, 번역 토큰은 시간범위 정렬로 원문에 매핑(3언어 팬아웃) | OK. 다만 언어 목록 페이지에 ko 명시는 별도 확인 필요(현재 실제로 한국어 번역이 나오므로 지원됨) |
| 스트림 종료 | 빈 프레임 전송 | 동일 | OK |
| 세션 최대 | **300분**(고정) | 연결 수명 290분 후 롤오버 | OK |
| **수동 finalize** | "말이 끝난 뒤 약 200 ms 무음 후에만 호출", "너무 자주 보내면 끊길 수 있음(몇 초에 한 번은 괜찮음)", "**너무 일찍 finalize하면 모델 정확도가 떨어진다**" | 유휴 1.2 s 후 finalize(OK) **+ 세그먼트 15 s 상한에서 발화 중에도 강제 finalize**(`createSonioxFinalizeScheduler`, 원문/게이트웨이 공통) | **문서 위반 가능성 — 품질 저하 원인 후보 1순위.** 15초 넘게 이어지는 문장은 중간에 잘려 원문 정확도와 번역 문맥이 깨진다. `<end>`(엔드포인트 감지)가 켜져 있어 상한은 대부분 불필요 |
| 동시 연결 | **기본 10개**(콘솔에서 상향 요청 가능), 분당 요청 100 | 세션당 언어별 1연결(3언어=3), 롤오버 순간 ×2, 데스크톱 마이크+시스템 ×2, 로컬 캡션 별도 → 캡션+라이브콜 동시 사용 시 10 초과 가능 → `429 limit_exceeded`로 연결 거부 | **끊김 원인 후보.** 어제 인계 문서의 "20 이상 권장"이 그대로 유효. Soniox 콘솔에서 한도 확인·상향 필요 |
| keepalive | 무오디오 구간에 `{"type":"keepalive"}`(간격 미명시) | 8 s 무오디오면 5 s마다 전송 | OK |
| 오류 코드 | 413 `max_duration_reached`, 429 `limit_exceeded`, 408 `request_timeout`, 503 | 413→SONIOX_MAX_DURATION 재접속, 429/503은 레인 재개 백오프 | OK |

## 4. 권고(결정 필요)
1. **finalize 15초 상한 제거 또는 "무음 200 ms 이후에만"으로 제한** — 문서의 정확도 경고에 정면으로 걸리는 유일한 항목. 구현: 상한을 발화 중에는 적용하지 않고, 토큰 유휴가 확인된 뒤에만 finalize(엔드포인트 감지가 이미 문장 경계를 준다). 원문 캡션과 게이트웨이가 같은 스케줄러를 쓰므로 한 곳 수정.
2. Soniox 콘솔 동시 연결 한도 확인(≥20).
3. 게이트웨이 소켓 종료 코드 로깅 추가 후 뷰어 재접속 재확인.
4. 실제 Live Call 1회 재실행 → `live_utterances`에 자막이 쌓이는지, 뷰어 재접속이 사라졌는지 확인(§1 수정으로 둘 다 바뀌어야 함).
