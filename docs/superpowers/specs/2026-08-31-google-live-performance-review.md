# Google Live API 평가와 성능·배포 검증 — 2026-08-31

## 요청과 범위

Google 공식 문서를 바탕으로 라이브 번역과 게이트웨이를 개선하고 빌드·재배포한다. 후속 요청인 ‘3.5 Live Translate로 원문·번역을 함께 처리하고 3.7은 요약에만 사용’도 평가했다. 기존 원문, 교정 이력, 종료 후 6시간 열람, 자막의 회색/흰색 구분은 유지한다.

## 모델 역할 평가

3.5 Live Translate는 연속 음성 번역에 적합한 후보다. 그러나 현재 제품의 원문 기록 계약까지 검증된 대체재라고 단정하지 않는다.

| 항목 | 3.5 Live Translate | 현재 자막 전용 경로 |
| --- | --- | --- |
| 처리 | 음성에서 원문 전사와 번역 전사 제공 | 3.5 Transcribe Live의 확정 원문 → 3.7 Flash 번역 |
| 지연 | 문장 확정 후 별도 번역 요청을 기다리는 단계를 줄일 가능성 | 확정 전사와 번역 요청 시간이 필요 |
| 음성 생성 | 공식 설정은 AUDIO; 재생을 생략해도 생성 비용은 별개 | 번역 음성을 생성하지 않음 |
| 용어집 | 번역용 시스템 지시문·용어집 지원 근거 없음 | 전사 어휘와 번역 용어집, 결정론적 보정 사용 |
| 기록 정합성 | 원문/번역 조각의 공통 식별자·1:1 대응 보장 미확인 | 확정 원문 ID를 번역에 전달 |

- [Live Translate 공식 가이드](https://ai.google.dev/gemini-api/docs/live-api/live-translate): 100ms, PCM16/16kHz 입력, 단일 targetLanguageCode, 원문·번역 전사, 음성 전용 입력과 시스템 지시 미지원.
- [모델 사양](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-live-translate-preview): 음성 및 전사 출력, preview 모델, thinking·구조화 출력 미지원.
- [Live Transcribe 공식 가이드](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe): interim/final 구분, VERBATIM, custom vocabulary. 현 코드와 부합한다.
- [Live API 메시지 계약](https://ai.google.dev/api/live#bidigeneratecontentservercontent), [SDK Transcription](https://googleapis.github.io/js-genai/release_docs/interfaces/types.Transcription.html): finished는 선택 필드다. 원문과 번역을 도착순으로 대응시켜 확정 저장하면 안 된다.
- [가격](https://ai.google.dev/gemini-api/docs/pricing): Live Translate 입력 약 $0.0053/분 + 출력 $0.0315/분. 입력·출력이 각각 60분이면 언어당 약 $2.21, 3언어 약 $6.62. 실제 음성 길이·토큰에 따라 달라지며 세금·서버·요약 비용은 제외한다. 참여자별 연결을 만들 이유는 없다.

최종 전환은 동일 음성의 지연·숫자·부정·용어·누락·확정 매칭 및 실제 사용량을 검증한 뒤 진행한다. 상세 설계는 [전환 설계](2026-08-31-live-translate-latency-design.md)에 있다. 현재 배포에서는 모델 경로를 변경하지 않았다. 3.7 LOW 튜닝도 후속 역할 분리 평가 때문에 보류했다.

## 적용한 개선

1. 자막 배열과 원문 언어 조회를 메모화하고 ViewerReadingFeed를 React.memo로 분리했다. 같은 자막에서 부모 음량 상태가 120회 갱신될 때 목록 렌더링은 121회에서 1회로 감소했다. React 19.2.7 렌더러 검증이며 네트워크 지연이나 브라우저 프레임 시간 개선 수치가 아니다.
2. SIGTERM/SIGINT에서 게이트웨이 정리를 한 번만 실행하고 8초 상한을 둔다. 예외는 고정 코드만 기록하며 늦은 완료·중복 신호가 종료 결과를 바꾸지 않는다. [Cloud Run의 10초 종료 유예](https://docs.cloud.google.com/run/docs/container-contract#instance-shutdown)에 맞춘 처리이며 진행 중 기록의 무손실 종료를 보장하지 않는다.
3. 미적용 001 SQL의 정리 함수가 기존 recap 만료만 연장해 30일 CHECK를 위반하는 문제를 PostgreSQL에서 재현해 수정했다. 기존 grant는 유지하고 누락된 grant만 실제 종료 시각에 맞춰 생성한다.

초기 조사에서 의심한 ‘한 언어 번역이 모든 후속 원문을 막는다’는 가설은 실제 RollingSpeechSession 연결 구조를 재현하자 성립하지 않았다. 불필요한 큐 재설계는 하지 않았다.

## 검사와 운영 증거

- Node 24 전체 검사: 게이트웨이 422개, 최종 웹 755개, root 1,313개 통과. root의 선택적 SQL 2개는 별도 PGlite 실행에서 총 24개 시나리오로 통과했다. root의 별도 비활성 검사 1개는 실행하지 않았다.
- root·웹 TypeScript 및 diff 공백 검사 통과.
- 실제 React 검사: 부모 120회 갱신, 임시→확정 시 같은 발언 노드 유지, 언어 변경, 내부 스크롤 상태 유지.
- 인앱 브라우저 로컬 시연: English 전환, 마지막 문장 확정, 흰색 computed color 및 원문 탭 유지 확인.
- 독립 검토에서 늦은 다른 언어 snapshot과 원문 캐시 갱신 문제를 발견했다. 캐시를 immutable React state로 관리하고 모든 쓰기 3곳을 통합해 수정했다. EN→KO→원문→늦은 EN 응답에서 KO 배열은 유지하면서 원문 2행 반영, 부모 120회 렌더에서 memo 유지 검증을 통과했고 독립 검토에서도 CLOSED 판정했다.
- Vercel의 sensitive 환경변수는 로컬 pull에서 비어 보이며 decrypted=false였다. 비밀을 재생성하거나 보호 설정을 바꾸지 않고 Vercel 서버 빌드로 검증했다.
- 로컬 실제 모델 비교는 외부 API가 차단된 설정에서 중단됐다. 차단 설정을 변경하지 않았고 실제 통화 p50/p95 개선을 주장하지 않는다.

## 배포 이력

- Supabase `qahzljufcqbzwkdweeji`: 202608310001~004 적용. 사후 기존 회의 68건, anchor 누락/변경 0건, 진행 중 회의 0건, 신규 요청·runtime·gap 0건. 참여자 direct RPC 실행 불가, service_role 실행 가능 확인.
- Cloud Build: `70ec4421-a74f-4ded-bd0e-f5faa6250399`, SUCCESS.
- 게이트웨이 이미지: `sha256:6db1079d26673d9cc1f6b11a1a054c43243a88e9ca6d55beaeef8a73c8632c09`.
- Cloud Run: `realtime-noel-media-gateway-perf-20260831`, 트래픽 100%. GET /health 200/no-store/ok, POST /health 404, 무인증 /metrics 404. min=0/max=1/request-based CPU/startup boost/256 concurrency/3600s/1CPU·1Gi 및 모든 traffic revision 검사 통과.
- 웹 첫 후보: `dpl_HEBypKgu34tGhMhPszPwuRvgsBhT`. 서버 production build 성공. 최종 캐시 수정 전이므로 기본 공개 주소로 승격하지 않는다.
- 최종 웹: `dpl_G1bJdTyjBxeJU8jjkHLec7jg92aE`, production 서버 빌드 성공 후 승격. `https://realtime-noel-web.vercel.app`가 해당 READY 배포를 가리키는지 CLI로 확인했다.
- 운영 검사: `/admin`, `/records`, `/records/demo`는 무인증 시 로그인으로 이동한다. `/api/live-config`, `/api/live-records`는 401 AUTH_REQUIRED. 모든 검사 경로에 CSP frame-ancestors 'self'가 있으며 위장 origin의 로그인 요청은 403 INVALID_ORIGIN으로 거절된다. 인앱 브라우저에서 실제 호스트 로그인 화면을 확인했다. 새 게이트웨이 리비전의 ERROR 로그는 검사 시점에 없었다.
- 실제 계정 로그인·회의 개설·마이크/모델 호출은 운영 데이터에 테스트를 만들지 않기 위해 실행하지 않았다. 원문·번역 지연의 실측 결과나 실제 회의 전체 흐름 검증 완료로 해석하면 안 된다.

## 최종 상태

**DONE_WITH_CONCERNS**: 검증된 공통 개선, 기존 승인된 기록 기능, 필요한 스키마와 웹·게이트웨이 재배포를 완료했다. 3.5 Live Translate 일괄 전환은 적용하지 않았으며, 비용 우선순위와 실제 스트림 대응 검증이 남아 있다. 관련 모델 비교안과 전환 게이트를 명시한 상태다.

## 롤백과 남은 제약

기존 Cloud Run `realtime-noel-media-gateway-cost-audit-20260822`와 Vercel `dpl_HcLCK9LLek3beKjtEGWbCLUAzCKF`를 보존했다. 문제가 생기면 앱부터 되돌리며 additive SQL·기록과 보안 제한은 제거하지 않는다. 참여자 수요 기능은 웹·Electron 조합 검증 전까지 기존 비활성 설정을 유지한다. 실제 이메일 발송, 실제 회의 데이터 생성, 비밀 변경, Git push는 수행하지 않았다.
