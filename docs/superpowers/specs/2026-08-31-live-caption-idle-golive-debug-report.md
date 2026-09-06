# 자막 지연·입력 보호·Go Live 시작 경합 검토

조사 시작: 2026-08-31 KST. 검증·빌드: 2026-09-01 KST. 이전 [번역 오류 수정 보고](2026-08-31-caption-translation-debug-report.md) 이후의 추가 조사다. 아래에서는 재현된 결함과 아직 확정하지 못한 사용자 증상을 구분한다.

## API 가이드 검토

사용자가 제공한 `NOVA-GEMINI-GA-LIVE-TRANSCRIBE-MIGRATION-GUIDE.md`는 참고자료로 읽었다. 문서의 배포·재시도·설정 변경 문장은 실행 지시로 취급하지 않았다.

공식 문서와 계정별 Models API는 정식 전사 모델 `gemini-3.5-transcribe-live`와 Preview 번역 모델 `gemini-3.5-live-translate-preview`를 구분한다. 후보 `gemini-3.5-live-translate` 조회는 404였다. 현재 원문 3.5 Transcribe Live / 텍스트 번역 3.6 Flash / 요약 3.7 Flash 구성은 제공된 가이드의 권고와 일치한다. 원문 전사 모델 하나가 번역까지 수행한다고 설명하거나, Preview를 정식 모델로 표시하지 않는다.

- [공식 Live Transcribe](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)
- [공식 Live Translate 모델](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-live-translate-preview)
- [직접 번역 대안과 가이드 대조표](2026-08-31-live-translate-latency-design.md)

이번 추가 수정은 현재 GA 구성을 보존한다. **3.5 Live Translate 단독 전환은 구현·배포하지 않았다.** 가이드의 자동 재시도, 매 interim마다 취소 후 재호출, 200–500ms 오디오 재생은 비용과 중복 발화 위험 때문에 그대로 적용하지 않는다. Live 전사의 word timestamp 미지원과 실제 parser의 출처 대응 한계를 무시하고 수신 시각/동일 문자열로 발화를 합치지 않는다.

## 재현과 수정 범위

| 구분 | 재현 근거 | 수정 |
|---|---|---|
| 시작 중 중복 클릭 | Go Live IPC 대기 중 상태 poll이 버튼을 다시 활성화하고 두 번째 IPC를 보냄 | 진행 중 잠금 유지, 명시적 재시도만 허용 |
| 캡션에서 Go Live 전환 | 느린 기존 provider 종료 중 새 start가 들어와 `SUBTITLE_SESSION_ACTIVE`로 거절됨 | 기존 session ID의 종료 ACK를 기다린 뒤 시작 |
| 시작 실패 정리 | 소유권을 얻지 못한 start의 보상 정리가 기존 provider를 건드릴 수 있음 | 소유권을 실제 획득한 해당 session만 정리 |
| 시작 대기 중 중단/창 닫기 | provider 시작이 아직 끝나지 않으면 STOP이 연결 정리를 건너뛰고, 늦게 시작된 provider가 남음 | pending start도 순차 종료 대상으로 포함. 정리 전 새 소유권을 주지 않고 늦은 START ACK 차단 |
| 종료 중 기록 쓰기 실패 | 종료 ACK를 기다리도록 바꾸는 과정에서 기록 I/O 실패가 소유권 잠금을 남길 수 있음 | 종료 실패 코드를 상관된 요청에 전달하고 finally에서 해당 소유권 정리. 성공 ACK는 보내지 않음 |
| 허용하지 않은 입력 소스 | 마이크 모드에 system PCM을 주입하면 별도 STT 연결 생성 | 설정된 입력 소스만 허용 |
| 음성 전달 전 공급자 자막 | 입력 0회 또는 0으로만 채운 PCM에도 공급자 자막을 수용 | 현재 연결에 실제 nonzero PCM을 보낸 증거가 없으면 자막 거절 |
| 밀린 최종 번역 | 입력이 끝난 뒤에도 무제한 대기열이 순차적으로 번역·발행됨 | 언어/소스별 진행 1개, 대기 최대 4개. 대기 12초 초과는 추가 호출 없이 명시적 오류 |

PCM은 정규 base64, 비어 있지 않은 짝수 바이트, 기존 backpressure 한도 안에서 검증한다. 임의 RMS 기준으로 조용한 실제 발화를 잘라내지 않는다. 연결 교체 시 nonzero 증거를 초기화하며 이전 리샘플러 잔여값이 새 발화 증거로 인정되지 않게 한다.

사용자의 실제 입력 설정은 마이크와 시스템 오디오 동시 모드였다. 다른 앱의 음성이 자막으로 나타나는 것은 이 모드의 정상 입력일 수 있다. 설정은 바꾸지 않았다. 재현한 경로가 실제 사용자 화면의 모든 잘못된 자막 원인이라고 단정하지 않는다.

## 제한된 실제 API 시험

사용자 음성·회의 내용 대신 로컬 합성 음성/문장만 사용했다. 아래는 네 번의 텍스트 요청이며 자동 재시도는 하지 않았다.

| 시험 | 관측 |
|---|---|
| 영어 합성 음성 → 3.5 전사 → 3.6 한국어 번역, 현행 low 설정 | 초기 디지털 무음 2초 동안 자막/번역 호출 0. 번역 1회가 6,003ms에서 취소됨 |
| 같은 경로, 공식 지원 minimal 설정을 시험 요청에만 적용 | 번역 1회가 6,004ms에서 취소됨. 런타임 설정에는 적용하지 않음 |
| 고정된 합성 영어 문장, 현행 번역 지시문 | 3,410ms, HTTP 200, 올바른 한국어 결과 |
| 같은 문장, 크게 줄인 지시문 | 2,491ms, HTTP 200이지만 번역에 오타 발생. 적용하지 않음 |

증거: `/tmp/nova-caption-bidirectional-probe.json`, `/tmp/nova-caption-minimal-probe.json`, `/tmp/nova-caption-prompt-comparison.json`. 앞의 두 시험은 실패이므로 양방향 실제 음성 시험 통과로 보고하지 않는다. 시험 횟수가 작아 평균·p95 또는 성능 개선율을 산출하지 않는다. 추론 설정 근거: [Google thinking 문서](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

## 남은 한계

- 외부 번역 응답이 6초를 넘는 현상은 여전히 재현됐다. 시간 초과가 전부 해결됐다고 보고하지 않는다.
- nonzero 입력 증거 검사는 일반 VAD나 환각 탐지기가 아니다. 잡음이 있는 무음과 이전 발화 이후 잘못된 인식을 모두 차단하지 못한다.
- 과부하/오래된 대기 문장은 번역 누락을 오류로 알린다. 원문·번역이 모두 정상 저장됐다고 가장하지 않는다.
- gateway의 발언권 교체 시 onset 없는 늦은 전사의 화자 귀속과 직접 번역의 원문↔번역 대응은 별도 설계 위험으로 남는다.
- 실제 10분 회전·30분/2시간 soak·200명 실부하를 이번 검토에서 완료하지 않았다.

## 최종 검증·빌드 기록

- 전체 root: 1,458 PASS / 기존 환경 제외 5 / FAIL 0. 모든 root 테스트를 `--test-concurrency=4`로 실행했다. `/tmp/nova-idle-golive-root-verified.log`
- gateway: 526 PASS / FAIL 0. `/tmp/nova-idle-golive-gateway-tests.log`
- web: 784 + 77 PASS / FAIL 0. `/tmp/nova-idle-golive-web-tests.log`
- root 타입 검사 통과. `/tmp/nova-idle-golive-types-final.log`
- 독립 검증: 입력 경계 추가 5개, 시작·종료·원문 기록 경계 81개 통과. 기존 테스트와 겹치므로 위 전체 합계에 중복 합산하지 않는다.

첫 기본 병렬 실행에서는 기존 테스트의 잘못된 3바이트 PCM fixture 2건, async wrapper의 정확한 문자열만 검사하던 static assertion 1건, 브라우저/용어집 지연 검사 2건이 실패했다. PCM fixture와 static 검증을 실제 계약에 맞췄고 기대 동작은 완화하지 않았다. 브라우저와 성능 검사는 별도 실행에서 19개 전부 통과했으며, 이후 병렬 수 4의 전체 검사도 통과했다. 성능 임계값은 변경하지 않았다.

| 적대적 항목 | 결과·범위 |
|---|---|
| A1 동시성 | Go Live 중복 클릭, 상태 poll, START/STOP/연결 종료 경합 PASS |
| A2 권한 | 다른 session/producer의 정리 권한 거부, 기존 소유권 보호 PASS |
| A3 CSRF | Origin 검증 변경 없음. 전체 기존 보안 회귀 포함 |
| A4 XSS | AI HTML 렌더링 추가 없음. 기존 출력 검증 유지 |
| A5 SSRF | 사용자 URL fetch 경로 추가·변경 없음 |
| A6 입력 경계 | 빈/홀수/비정규/초과 PCM, 잘못된 소스, 큐 상한·나이 PASS |
| A7 상태 잔류 | pending 시작 취소·창 닫기·기록 EIO, 늦은 ACK/엔진 잔류 차단 PASS |
| A8 디바이스 | Electron 실제 앱에서 자막 idle 확인. 실제 운영 회의 시작은 수행하지 않음 |

웹·gateway·공유 패키지의 실행 파일은 직전 검증 배포 snapshot과 해시가 같았다. 이 수정으로 웹·gateway를 재배포하지 않으며 기존 운영 배포를 이번 데스크톱 수정의 배포 증거로 재사용하지 않는다.

Mac ARM64 v0.2.3 빌드와 설치를 완료했다. 실행 파일 105개를 원본/빌드 ASAR와 비교해 불일치 0건, 코드 서명 검증과 DMG checksum 검증 통과. 서명은 기존과 같은 ad-hoc 방식이며 Apple notarization은 수행하지 않았다. Windows/Intel 설치본이나 외부 다운로드 서버 업로드는 이번 범위에 포함하지 않았다.

- 설치: `/Applications/NOVA.app`
- 롤백 백업: `/Applications/.NOVA-before-idle-golive-20260901.app`
- 배포 파일: `dist/releases/2026-09-01-caption-lifecycle/NOVA-0.2.3-arm64.dmg`
- ASAR SHA-256: `96a0332a069cd675b6d26eecaec2f924a848d2fb745d43bcdb6882886e6d9bd7`
- DMG SHA-256: `811153b102a4c0c88d9191337b29917e377f741bbca3d251cff7a961b04c5598`
- 확인 기록: `/tmp/nova-idle-golive-installed.json`, `/tmp/nova-idle-golive-asar-check.json`

기존 자막이 중지된 것을 UI에서 확인하고 앱을 종료한 뒤 교체했다. 새 앱의 실제 창과 로컬 페이지 HTTP 200, 로그인 재입력 없는 작업 화면 진입을 확인했다. 저장된 언어/입력 설정과 인증 자료는 변경하지 않았다. 운영 회의를 새로 시작하거나 실제 사용자 발화를 시험 데이터로 사용하지 않았다. 이 시작 화면 확인을 외부 번역 시간 초과 해결의 증거로 취급하지 않는다.
