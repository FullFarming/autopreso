# 고정 언어·원문 및 API 사용량 개선 구현 보고

2026-08-31. [설계](2026-08-31-fixed-target-language-routing-design.md)의 후속 구현이다. 사용자는 기능에 필요한 비용과 구현을 승인했으며, 중복·누수·과사용은 허용하지 않았다. 이 문서는 로컬 구현 및 검증 결과이며 운영 전환 완료 보고가 아니다.

## 적용한 동작

- 원문 / 한국어 / English는 서로 다른 고정 lane이다. 화자나 입력 언어가 바뀌어도 선택한 번역 lane은 바뀌지 않는다. 원문에는 실제 KO·EN·혼합 발화를 보존한다.
- 숫자 등 중립 텍스트, 같은 언어의 원문 전달, 혼합·불명 언어를 구분한다. 번역 실패를 다른 언어 원문으로 대신 표시하지 않는다. 공급자의 languageCode는 관측 근거 중 하나이며 정답으로 신뢰하지 않는다.
- 원문은 번역 cache 합집합 대신 하나의 서버 원장과 전용 snapshot에서 복원한다. 작성 중 원문은 generation/revision으로 관리하고 확정 원문 sequence를 소비하지 않는다. 늦은 clear가 새 문장을 지우지 못한다.
- 이미 저장한 원문의 중복 수신은 저장된 번역을 복원한다. 응답을 잃었다는 이유로 다시 유료 번역하지 않는다. 복원할 번역이 없으면 누락 안내를 유지한다.
- pause·provider rollover마다 source generation을 구분하므로 같은 문장을 다시 말해도 과거 중복으로 제거하지 않는다.
- 회의 종료 후 원문 열람은 기존 참여 이력·권한 회수 여부와 실제 종료 후 6시간으로 제한한다. 초대 만료와 기록 권한을 혼동하지 않는다. 새로고침은 기록/선택 복원을 사용하며 모델을 새로 호출하지 않는다.
- 3.7의 기존 주제 판정 한 번에서 문단 요약도 받는다. 최근 원문 8개(각 최대600자)와 이전 요약 최대500자를 입력으로 사용한다. 부분 문장·필러는 추가 호출하지 않는다. 실패·동시 갱신 충돌에서는 기존 요약과 저하 상태를 유지한다. 원문 이어 붙이기를 AI 요약이라고 표시하지 않는다.

## 연결·호출 보호

- Google 연결 준비 중 취소와 timeout이 실제 WebSocket을 종료한다. 기존 SDK의 대기 연결 취소 제약 때문에 공식 WS 프로토콜을 서버에서 직접 사용한다. API key는 서버 밖으로 전달하지 않는다.
- 연결/오디오/메시지/큐/전송 지연에 상한을 두고 오류 시 종료한다. 건강 검사는 AI 연결을 만들지 않는다. 모델·endpoint는 고정되어 있다.
- 공급자 실패나 저장 실패 뒤의 유료 자동 복구 루프를 제거한다. 자동 start/update는 실패 상태를 해제하지 못한다. 인증된 사용자의 명시적인 재시작만 가능하며 이전 연결의 정리가 실패하면 새 연결도 차단한다.
- host 이탈 중 늦게 완료된 start/reattach와 오래된 pipeline의 원문 전송을 차단한다. pause 시 오디오 연결을 닫고 이미 받은 원문은 보존한다.
- SDK·REST·웹 요약까지 usageKnown을 전달한다. 이미 과금된 응답이 검증 실패해도 알려진 사용량을 보존하고, 확인하지 못한 사용량은 0으로 집계하지 않는다.

## Live Translate 실제 시험과 전환 판단

고객 음성·운영 DB를 사용하지 않고 로컬 음성 합성으로 만든 5.631초 KO→EN→혼합 발언을 ko와 en에 각각 한 번 전송했다. 연결 2회, 입력 약11.4초(100ms 프레임 패딩 포함), 재시도0. 별도로 모델 metadata 읽기1회. 테스트 출력은 `/tmp/nova-fixed-target-probe/results.json`에 있으며 비밀키는 파일이나 로그에 저장하지 않았다.

| 관측 | KO target | EN target |
|---|---:|---:|
| 첫 입력 전사 수신(연결 준비 포함) | 3560ms | 3463ms |
| 첫 출력 전사 수신(연결 준비 포함) | 3722ms | 3687ms |
| finished=true | 0 | 0 |
| turn/generation 완료 경계 | 0 | 0 |
| 생성된 출력 음성 | 6750ms | 6750ms |

이 작은 시험은 평균 지연·정확도·회귀 개선률을 증명하지 않는다. 출력의 목표 언어는 유지되었지만, 원문 languageCode와 실제 문자가 불일치했고 동일 음성의 입력 전사도 target에 따라 달랐다. 문장별 완료/원문-번역 대응과 마지막 발화의 완전한 수신을 확인하지 못했다. 따라서 FIFO·시간 근접성으로 원문 ID를 붙이거나 침묵을 공급자 확정 신호로 해석하지 않는다. 생성 음성을 버려도 사용 비용이 없는 것은 아니다.

**운영 경로를 3.5 Live Translate 단독으로 전환하지 않았다.** 검증 가능한 원문 3.5 Transcribe + 확정 번역 3.7 Flash 경로를 유지한다. 신규 Live Translate adapter는 고정 target·echo·100ms PCM·bounded queue·취소·usage 관측을 갖추었지만 운영 factory에 연결하지 않았다. 따라서 번역 중 모든 언어에 부분 번역이 연속 제공된다는 기능까지 완료했다고 보고하지 않는다. 원문/동일언어 partial과 기존 확정 번역은 유지된다.

공식 근거: [Live Translate](https://ai.google.dev/gemini-api/docs/live-api/live-translate), [Live Transcribe](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe), [Live API reference](https://ai.google.dev/api/live), [가격](https://ai.google.dev/gemini-api/docs/pricing). 문서의 speech-to-speech 연속 처리와 애플리케이션의 문장별 확정 원장 요구를 구분했다.

## 검증 및 남은 한계

- SQL: 격리된 PostgreSQL(PGlite)로 canonical source·6시간 권한·회수·epoch fence·idempotency·cleanup 총31개 통과. 운영 DB에는 테스트 쓰기를 하지 않았다.
- 브라우저: 로컬 `/m/watch/demo`에서 KO 고정 상태의 KO→EN, EN 고정 상태의 혼합 발언, 원문 언어 전환을 확인. `/records/demo`에서 동일 화자 문단 연결, 원문 실패 안내와 기존 기록 보존을 확인했다. 실제 고객 세션의 새로고침·장시간 통화 검증을 대신하지 않는다.
- 모델의 의미 정확도, 음성으로만 실제 인물 식별, 긴 문단의 모든 세부사항 보존을 보장하지 않는다. 화자 신원 불명은 중립 표기로 유지한다.
- 실패 tombstone은 process 메모리에 있으며 demand 모드의 process/instance 경계에서는 DB runtime fence를 함께 사용한다. 현재 기존 운영 demand flag를 임의로 켜지 않았다. 참가자가 없는 상태에서도 원문 기록이 요구되는 세션은 기록 목적의 원문 API 사용이 발생한다.
- 새 원문 기능의 배포 순서는 migration005 → gateway/web. 추가 migration은 기존 row의 관측값을 추정 백필하지 않는다. rollback은 이전 앱/게이트웨이로 되돌리고 additive schema는 유지한다.

## 최종 검증 결과

Node 24.18.1 기준. 운영 서비스나 고객 데이터에는 쓰지 않았다.

| 검증 | 결과 | 근거 |
|---|---|---|
| 루트 전체 | 1324 PASS, 실패0, 환경 조건4개 skip | `/tmp/nova-fixed-final-root.log` |
| 게이트웨이 전체 | 512 PASS, 실패0 | `/tmp/nova-fixed-final-gateway.log` |
| 웹 전체 | live703 + core76 PASS, 실패0 | `/tmp/nova-fixed-final-web.log` |
| 격리 PostgreSQL | 31 PASS, skip0 | `/tmp/nova-fixed-sql-tests.log` |
| 루트·웹 TypeScript | PASS | 전체 테스트 로그 후반 |
| 최종 Next production build | PASS, 14페이지 생성 | `/tmp/nova-fixed-final-build.log` |
| 빌드 소스 일치 | production 소스306개 해시 동일 | 별도 복사본과 현재 webapp/packages 비교 |
| 변경 형식 검사 | `git diff --check` PASS | 기존 사용자 변경 유지 |
| 독립 보안 검토 | 새 P1/P2 없음, 관련14테스트 PASS | 취소·물리 종료·전송 제한·rate window·원문 generation·비밀 비노출 |

별도 lint script가 없어 lint 통과라고 보고하지 않는다. 루트의 조건부 SQL skip은 위 명시 실행으로 검증했지만 나머지 환경 조건을 실제 운영 검증으로 대체하지 않았다. gateway는 별도 compile script 없는 JavaScript 서비스로 전체 런타임 테스트를 실행했다. Electron 설치파일 재패키징은 이번 검증 범위에 포함하지 않았다.

## 적대적 검증 기록

| 시나리오 | 결과 | 확인한 경계 |
|---|---|---|
| A1 동시성 | PASS | start 중 host 이탈, 중복 수동 재시작, 동일 발언 중복, pause·rollover 후 실제 재발언 보존, 요약 CAS 충돌 |
| A2 권한 우회 | PASS | 다른 세션/미구독 원문 접근 차단, 회수·만료·6시간 경계, 잘못된 activation key와 stale version 차단 |
| A3 CSRF | 새 mutation endpoint 없음 | 원문 snapshot은 인증 GET, 기존 인증·origin 경계 보존. 새로운 범용 CSRF 감사를 완료했다고 주장하지 않음 |
| A4 XSS/외부 텍스트 | PASS | 공급자 HTML/control·과대입력 거부, 원문과 정규화 텍스트 분리, React 일반 텍스트 렌더링 |
| A5 SSRF | PASS/범위 제한 | Live provider endpoint 고정, redirect 금지, 사용자가 외부 URL을 지정하는 신규 경로 없음 |
| A6 입력 경계 | PASS | 숫자·혼합·unknown·NFD원문·일본어 장음부호, 큰 프레임/셋업/queue·잘못된세대 |
| A7 잔류 자원 | PASS | 늦은 connection 후보 종료, 정체 전송 timeout, 실제 socket close await, cleanup 실패 quarantine, 자동 유료 복구 없음 |
| A8 화면 | 로컬 PASS | KO/EN 고정 탭, 같은 화자 언어 전환, gray/white computed style, 종료·만료·읽기 실패. 실제 iPhone/iPad·고객 장시간 통화는 미실행 |

추가 발견·수정: 종료/재접속으로 session rate window가 초기화되어 호출 한도를 우회하던 경로를 차단했다. window는 원래 60초가 지나야 새 요청 예산으로 바뀐다. 사용량 관측에 usageKnown이 없더라도 측정된0으로 처리하지 않는다.

## 배포 상태와 승인 대상

로컬 코드와 빌드를 완료했으며 이번 변경의 운영 DB migration과 재배포는 실행하지 않았다. migration005 → gateway/web 순서로 반영해야 새 원문 snapshot을 사용할 수 있다. 모델 단독 전환 보류는 배포 여부와 별개이며, 배포하더라도 안전한 기존 모델 분리를 유지한다. 새 마이그레이션과 코드 반영 후 회의 생성·초기 수동 재시작·KO/EN 전환·실제 종료 후 기록 복원을 별도 운영 점검해야 한다.

