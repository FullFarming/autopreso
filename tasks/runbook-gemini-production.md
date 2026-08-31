# Gemini Production Approval Runbook

상태: **BLOCKED — 아래 모든 항목에 사람의 증빙과 승인이 기록되기 전에는 production 배포 금지**

참조: [승인 사양](../SPEC-live-call-quality-gemini.md), [API key 보안](https://ai.google.dev/gemini-api/docs/api-key), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [Gemini logs 정책](https://ai.google.dev/gemini-api/docs/logs-policy)

## 1. 자격 증명과 환경 경계

- [ ] Gemini 키는 production 서버의 secret store에만 있고 브라우저 환경변수, 응답, 로그, 저장소에는 없다.
  증빙: 담당자 / 확인 일시 / secret 이름만 표시한 설정 화면 또는 검증 로그:
- [ ] 키 제한이 Gemini API와 승인된 production 실행 주체에만 적용되며, 승인된 billing project에 귀속된다.
  증빙: 실제 키 값과 project ID를 가린 제한 설정 캡처 및 승인자:
- [ ] production 환경·project allowlist가 development/staging과 분리되어 있고 불일치 시 시작이 실패한다.
  증빙: 값은 가린 정상 시작 로그와 의도적 불일치 실패 로그:
- [ ] 키 소유자, 접근 가능 역할, 비상 폐기 권한이 최소 권한으로 승인되었다.
  증빙: IAM 검토 링크 또는 승인 기록:

## 2. 데이터 사용과 보존

- [ ] AI Studio/Gemini developer logging이 production project에서 비활성화된 것을 사람이 확인했다.
  증빙: project와 실제 값을 가린 설정 화면, 확인자, 확인 일시:
- [ ] 데이터 공유 또는 모델 개선 참여가 비활성화된 것을 사람이 확인했다.
  증빙: 설정 화면 또는 공급자 관리 콘솔 기록:
- [ ] logging/data sharing 비활성화를 **zero-data-retention 보장으로 표현하지 않았고**, 적용 요금제·API·계약의 잔여 보존/남용 방지 처리와 지역 조건을 법무·보안이 확인했다.
  증빙: 적용 정책/계약 링크, 검토자, 허용된 잔여 보존 조건:
- [ ] 회의 콘텐츠의 외부 처리 목적, 동의, 보존 및 삭제 절차가 내부 개인정보 정책과 일치한다.
  증빙: 정책 또는 DPA 검토 링크와 승인자:

## 3. 모델·호출·비용 계약

- [ ] production 빌드가 승인 사양의 workload별 고정 모델만 사용하며 사용자 입력으로 model, URL, tools를 선택할 수 없다.
  증빙: 모델 allowlist 테스트와 빌드 식별자:
- [ ] SDK retry는 `attempts: 1`, REST/애플리케이션 호출도 한 번뿐이며 alternate-model 또는 숨은 fallback이 없다.
  증빙: 호출 횟수/실패 경로 테스트 결과:
- [ ] prompt/output token, 동시 호출, session/global rate 및 outstanding work 제한이 provider 호출 전에 적용된다.
  증빙: 경계 테스트 결과와 승인된 제한값 문서:
- [ ] timeout/abort가 provider 과금 중단을 보장하지 않는다는 전제에서 비용 예산이 승인되었다.
  증빙: 비용 책임자 승인 기록:
- [ ] project별 RPM/TPM/RPD 및 예산 임계치에 경보가 설정되고 담당자와 대응 채널이 지정되었다.
  증빙: 값을 가린 alert 설정 캡처, 수신자, 테스트 알림 기록:

## 4. 릴리스 전 누출 검증

- [ ] production browser bundle에서 `@google/genai`, Gemini WebSocket/REST host, API key 응답 처리, direct provider transport가 0건이다.
  증빙: production build artifact 스캔 명령과 결과:
- [ ] `/api/gemini-token`과 `/api/pair-keys`는 key/env를 반환하지 않는 `410` tombstone이다.
  증빙: 응답 상태·본문 검증 결과(실제 key 사용 금지):
- [ ] 저장소와 배포 diff의 key/token/credential 패턴을 사람이 검토했고 실제 secret이 0건이다.
  증빙: secret scan 결과와 검토자:
- [ ] 애플리케이션·gateway 로그에는 prompt, response, transcript, email, participant identity, session credential, key, raw provider error가 없다.
  증빙: 정상·거절·timeout·rate-limit 로그 샘플(민감값 없이)과 검토자:
- [ ] 관측값은 고정 workload, allowlisted model, latency, safe result code, 숫자 usage metadata로만 제한된다.
  증빙: metric/log schema와 샘플:

## 5. 실패·회전·롤백 준비

- [ ] provider failure, refusal, malformed output, rate-limit, timeout에서 durable source caption은 유지되고 자동 retry/fallback은 발생하지 않는다.
  증빙: 실패 주입 테스트 결과:
- [ ] 키 유출 대응 절차가 `새 키 발급 → 제한 검증 → 서버 secret 교체 → 구 키 폐기 → 누출 범위 감사` 순서로 리허설되었다.
  증빙: 실제 키가 없는 리허설 기록, 담당자, 목표 복구 시간:
- [ ] 장애 시 Gemini 기능을 중지해도 source captions와 저장된 회의 기록을 보존하는 rollback 절차가 검증되었다.
  증빙: staging rollback 기록과 복구 확인:
- [ ] 이전 production artifact와 환경 설정으로 되돌리는 책임자, 실행 명령, health check, 중단 기준이 승인되었다.
  증빙: rollback 문서 링크, artifact 식별자, 승인자:
- [ ] rollback 뒤 새 provider 호출이 0건이고 browser key 노출이 없음을 다시 확인하는 검증 단계가 있다.
  증빙: rollback 후 metric 및 bundle/log scan 결과:

## 6. 최종 사람 승인

- [ ] Security 승인자는 위 증빙을 검토하고 미해결 Critical/High/Medium이 없음을 확인했다.
  증빙: 이름 / 일시 / 승인 기록:
- [ ] Privacy/Legal 승인자는 외부 처리, 잔여 보존, 동의 및 삭제 조건을 승인했다.
  증빙: 이름 / 일시 / 승인 기록:
- [ ] Operations/Cost 승인자는 제한, 경보, 키 회전 및 rollback 준비를 승인했다.
  증빙: 이름 / 일시 / 승인 기록:
- [ ] Release owner가 모든 체크박스와 증빙이 완성된 것을 확인하고 production 배포를 명시적으로 승인했다.
  증빙: 이름 / 일시 / 배포 승인 티켓:

모든 체크박스가 완료되지 않았다면 상태는 계속 **BLOCKED**다.
