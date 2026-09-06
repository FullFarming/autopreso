# Realtime Noel media gateway

Cloud Run용 실시간 자막 게이트웨이입니다. 호스트와 발언권을 받은 참가자는 `/live` WebSocket으로 PCM16 mono 16 kHz, **40 ms/1,280 bytes** 프레임을 보내고, 시청자는 같은 경로에서 JSON 자막·상태 이벤트를 구독합니다. 번역 음성 바이너리는 생성하거나 전송하지 않습니다. 공개 상태 점검은 exact `GET /health`만 사용합니다. `/healthz`는 로컬 호환성을 위해 동일한 응답을 유지하지만 Cloud Run 공개 점검에는 사용하지 않습니다. 다른 method, query, suffix, trailing slash는 모두 404입니다. `/metrics`는 공개 endpoint가 아니며 `LIVE_GATEWAY_METRICS_TOKEN`과 정확히 일치하는 `Authorization: Bearer <token>`이 있어야 응답합니다. 세 endpoint 모두 오디오·자막·토큰 내용을 포함하지 않습니다.

필수 환경변수: `GEMINI_API_KEY`, `GOOGLE_CLOUD_PROJECT`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `LIVE_GATEWAY_TOKEN_SECRET`, `LIVE_VIEWER_TOKEN_SECRET`, `LIVE_GATEWAY_ALLOWED_ORIGINS`, `LIVE_GATEWAY_METRICS_TOKEN`, `LIVE_EXTERNAL_ENV=development`, `LIVE_ALLOWED_GCP_PROJECT`, `LIVE_ALLOWED_SUPABASE_REF`. 실제 GCP project와 Supabase project ref는 allowlist 값과 정확히 같아야 하며, URL의 port·query·fragment도 허용하지 않습니다. Gemini API key는 서버에만 두며 브라우저로 반환하지 않습니다. Gateway 런타임은 OpenAI API key를 요구하거나 읽지 않습니다. `SUPABASE_SERVICE_ROLE_KEY`는 기존 개발 환경의 임시 fallback일 뿐이며 새 연결에는 사용하지 않습니다. 선택적으로 `STT_LANGUAGE_CODES`(기본 `ko-KR,en-US,ja-JP`), `SONIOX_API_KEY`(Soniox 엔진을 선택한 세션에만 필요하며 없으면 해당 세션이 `ENGINE_KEY_MISSING`으로 거부됨), Cloud Run의 `PORT`를 사용합니다. STT/번역/요약 모델은 env가 아니라 `packages/caption-core/caption-engine-catalog.js` 카탈로그와 세션의 `captionConfig.engine`이 결정합니다. Google Cloud 호환 클라이언트 인증은 Application Default Credentials로 주입합니다. 값 형식은 `.env.example`을 참고하되 실제 secret은 커밋하지 않습니다.

## 실시간 처리 경로

- Presentation과 Meeting/Townhall은 입력 오디오를 한 번만 `gemini-3.5-transcribe-live`의 `VERBATIM` 모드로 전사합니다. 중간 전사는 화면 미리보기 전용이며 확정 전사만 저장·번역합니다.
- 확정 원문은 출발 언어 용어 보정 뒤 `gemini-3.7-flash` 텍스트 번역으로 언어별 자막을 만들고, 대상 언어 용어를 결정론적으로 다시 보정합니다.
- 이전 저장 행의 `voice_provider`, `voice_output_mode`, `output_mode`는 스키마 호환을 위해 읽을 수 있지만 모든 신규·수정 세션은 `captions`로 정규화합니다. 이 값으로 음성 공급자나 TTS 연결을 만들지 않습니다.
- Meeting/Townhall의 floor 정보는 동일한 전사 흐름의 자막 화자 정보로 결합됩니다. 발언권 참가자의 입력 오디오는 유지하지만 번역 음성 출력은 없습니다.

## Cloud Run 비용·수명주기 계약

2026-08-16부터 게이트웨이는 GCP 프로젝트 `gen-lang-client-0321430669`
(asia-northeast3)에서 서비스됩니다. 이전 프로젝트 `studied-sled-460400-u2`는
프로젝트 국한 Cloud Run 인스턴스 기동 불가 결함으로 이설했습니다(경위와 남은
절차는 `docs/superpowers/specs/2026-08-15-gateway-scale-to-zero-design.md`).
웹앱의 `NEXT_PUBLIC_LIVE_GATEWAY_URL`이 현재 서비스 URL의 정본입니다.

게이트웨이는 상시 서버가 아니라 라이브콜의 호스트 WebSocket이 연결된 동안만 활성화되는 서비스입니다. Cloud Run은 `request-based billing`과 서비스 수준 `min=0`을 사용해야 하며, 인스턴스 기반 과금이나 최소 인스턴스 1은 허용하지 않습니다. 다음 설정을 배포 후 다시 확인합니다.

```bash
gcloud run services update SERVICE --region REGION \
  --cpu-throttling \
  --min 0 \
  --max 1 \
  --min-instances 0 \
  --max-instances 1 \
  --concurrency 256 \
  --timeout 3600 \
  --cpu 1 \
  --memory 1Gi \
  --cpu-boost
```

`min=0`이면 호스트의 첫 `/health` 또는 `/live` 요청이 인스턴스를 기동하고, 모든 WebSocket 요청이 끝나면 Cloud Run이 자동으로 0까지 축소합니다. 라이브 종료 후 외부 업타임 체크나 주기적 헬스 핑으로 게이트웨이를 깨우지 않습니다. `max=1`은 현재 세션 fanout 상태가 프로세스 메모리에 있기 때문에 유지합니다. `concurrency=256`은 HOST 1명, VIEWER 최대 200명, 짧은 재연결 중첩과 상태 점검 여유를 포함한 단일 인스턴스 계약입니다. 여러 인스턴스로 확장하려면 먼저 세션 이벤트를 외부 메시지 계층으로 동기화해야 합니다.

비용 우선 기본값에서는 예약 시작 T0 또는 호스트의 수동 시작 전까지 Cloud Run 요청을 만들지 않습니다. 운영자가 웹앱에 `NEXT_PUBLIC_LIVE_GATEWAY_PREWARM_ENABLED=true`를 명시했을 때만 열린 인증된 호스트 화면이 T-60에 한 번 웜업합니다. 이 선택적 요청은 process liveness만 확인하며 Gemini 세션이나 미디어 파이프라인을 만들지 않습니다. `preparing` 참여자는 same-origin 상태 API만 polling하고 `/health`, gateway token, WebSocket을 호출하지 않습니다. T0 또는 수동 시작 뒤에도 gateway의 readiness CAS 성공 전에는 세션을 `live`로 표시하거나 `started` ACK를 보내지 않습니다.

서비스 수준 `min=0`만으로는 검증이 끝나지 않습니다. 과거 리비전에 남은 `revision-level minScale=1`과 그 리비전을 가리키는 `traffic tag`는 별도 최소 인스턴스를 계속 유지할 수 있습니다. 설정 변경 후 100% 트래픽과 보존할 모든 tag가 건강한 `minScale=0` 리비전을 참조하는지 확인하고, `minScale=1` 리비전을 참조하는 traffic entry가 하나라도 있으면 비용 차단을 완료로 판정하지 않습니다.

## 승인 전 IAM 조건

- Cloud Run runtime에는 사용자 관리 서비스 계정을 사용하고 Owner·Editor·Viewer와 서비스 에이전트 역할을 부여하지 않습니다.
- STT 호출에는 공식 최소 역할인 `roles/speech.client`만 사용합니다.
- 번역 음성/TTS를 호출하지 않으므로 TTS IAM 역할을 부여하지 않습니다. ADC quota project가 요구하는 경우에만 개발 프로젝트의 `roles/serviceusage.serviceUsageConsumer`를 사용합니다.
- 애플리케이션은 stdout/stderr의 Cloud Run 기본 수집만 사용합니다. Logging API 직접 호출을 추가할 때만 `roles/logging.logWriter`를 검토합니다.
- Gemini 서버 API key는 개발 프로젝트와 Generative Language API로 제한하고 브라우저에 전달하지 않습니다.
- Supabase `sb_secret`은 컴포넌트별로 별도 생성해 배포 환경에 직접 주입합니다. runtime 서비스 계정에는 Secret Manager 조회 권한을 부여하지 않습니다.
- `GOOGLE_APPLICATION_CREDENTIALS` 파일을 Cloud Run에 넣지 않고 연결된 서비스 계정의 ADC를 사용합니다.

배포 전에 Cloud Run 요청 timeout을 60분으로 설정하고, 배포 후 `GET /health`가 `Cache-Control: no-store`와 `{ "ok": true }`를 반환하는지 확인해야 합니다. `/metrics` 검증에는 secret bearer를 사용하며 인증 실패 시 404가 반환되는지 함께 확인합니다. Cloud Run 공개 점검에는 플랫폼에서 선점될 수 있는 `/healthz`를 사용하지 않습니다.

저장소 루트의 `scripts/configure-cloud-run-scale-zero.sh`는 기본적으로 변경 명령만 미리 보여 줍니다. `--apply`와 정확한 `--confirm-target PROJECT/REGION/SERVICE`가 함께 있어야 설정을 변경하며, 완료 후 `scripts/verify-cloud-run-scale-zero.mjs`로 서비스 수준과 트래픽 주소 가능한 모든 리비전을 다시 검사합니다.

향후 Cloud Run 배포 workflow는 배포 작업이 성공한 직후 reusable gate `./.github/workflows/verify-media-gateway-deployment.yml`을 반드시 호출해야 합니다. 이 gate는 정적 Google Cloud key를 받지 않고 GitHub OIDC와 Workload Identity Federation만 사용하며, 전달하는 감사용 service account에는 `roles/run.viewer`만 부여합니다. gate는 서비스와 리비전을 읽어 검증할 뿐 배포·설정 변경 명령을 실행하지 않습니다. 현재 저장소에는 Cloud Run 배포 workflow가 없으므로 이 호출 계약은 자동 배포가 추가될 때 함께 연결해야 합니다.

현재 설정 증거와 변경 승인 절차는 `tasks/runbook-gateway-scale-zero.md`를 따릅니다. 건강하지 않은 리비전으로의 트래픽 이동, tag 삭제, min/max 변경은 각각 정확한 대상에 대한 별도 사용자 승인 없이는 실행하지 않습니다.
