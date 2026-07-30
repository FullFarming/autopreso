# Realtime Noel media gateway

Cloud Run용 오디오 전용 게이트웨이입니다. 호스트는 `/live` WebSocket으로 PCM16 mono 16 kHz, **40 ms/1,280 bytes** 프레임을 보내고, 시청자는 같은 경로에서 PCM16 24 kHz 바이너리를 구독합니다. 공개 상태 점검은 `/health`를 사용합니다. `/healthz`는 로컬 호환성을 위해 동일한 응답을 유지합니다. `/metrics`는 공개 endpoint가 아니며 `LIVE_GATEWAY_METRICS_TOKEN`과 정확히 일치하는 `Authorization: Bearer <token>`이 있어야 응답합니다. 세 endpoint 모두 오디오·자막·토큰 내용을 포함하지 않습니다.

필수 환경변수: `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL=gemini-3.5-live-translate-preview`, `GOOGLE_CLOUD_PROJECT`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `LIVE_GATEWAY_TOKEN_SECRET`, `LIVE_VIEWER_TOKEN_SECRET`, `LIVE_GATEWAY_ALLOWED_ORIGINS`, `LIVE_GATEWAY_METRICS_TOKEN`, `LIVE_EXTERNAL_ENV=development`, `LIVE_ALLOWED_GCP_PROJECT`, `LIVE_ALLOWED_SUPABASE_REF`. 실제 GCP project와 Supabase project ref는 allowlist 값과 정확히 같아야 하며, URL의 port·query·fragment도 허용하지 않습니다. Gemini API key는 서버에만 두며 브라우저로 반환하지 않습니다. Gateway 런타임은 OpenAI API key를 요구하거나 읽지 않습니다. `SUPABASE_SERVICE_ROLE_KEY`는 기존 개발 환경의 임시 fallback일 뿐이며 새 연결에는 사용하지 않습니다. 선택적으로 확정 자막 후처리용 `GEMINI_TEXT_MODEL`(기본 `gemini-3.6-flash`), `STT_LANGUAGE_CODES`(기본 `ko-KR,en-US,ja-JP`)와 Cloud Run의 `PORT`를 사용합니다. Google Cloud 호환 클라이언트 인증은 Application Default Credentials로 주입합니다. 값 형식은 `.env.example`을 참고하되 실제 secret은 커밋하지 않습니다.

## 실시간 처리 경로

- Presentation과 Meeting/Townhall의 실시간 번역 자막·통역 음성은 모두 `gemini-3.5-live-translate-preview` 세션을 사용합니다. 별도의 OpenAI 실시간 번역 연결이나 대체 번역 엔진은 없습니다.
- 이전 저장 설정의 `voiceProvider: "openai"` 값은 마이그레이션 호환을 위해 입력만 허용한 뒤 즉시 `gemini`로 정규화합니다. 이 값으로 OpenAI 연결을 만들거나 환경변수를 조회하지 않습니다.
- 용어집은 로컬 확정 자막 보정을 먼저 적용합니다. 선택적 확정 자막 후처리는 `GEMINI_TEXT_MODEL`을 사용할 수 있지만 실시간 오디오 번역 공급자를 바꾸지 않습니다.
- Meeting/Townhall의 입력 전사와 floor 정보도 같은 Gemini Live 처리 흐름에서 자막 이벤트로 결합됩니다. 번역 세션의 오디오 입력은 PCM16 mono 16 kHz이고 통역 음성 출력은 PCM16 24 kHz입니다.

## 승인 전 IAM 조건

- Cloud Run runtime에는 사용자 관리 서비스 계정을 사용하고 Owner·Editor·Viewer와 서비스 에이전트 역할을 부여하지 않습니다.
- STT 호출에는 공식 최소 역할인 `roles/speech.client`만 사용합니다.
- 일반 TTS synthesis에는 Long Audio 전용 TTS IAM 역할을 부여하지 않습니다. ADC quota project가 요구하는 경우에만 개발 프로젝트의 `roles/serviceusage.serviceUsageConsumer`를 사용합니다.
- 애플리케이션은 stdout/stderr의 Cloud Run 기본 수집만 사용합니다. Logging API 직접 호출을 추가할 때만 `roles/logging.logWriter`를 검토합니다.
- Gemini 서버 API key는 개발 프로젝트와 Generative Language API로 제한하고 브라우저에 전달하지 않습니다.
- Supabase `sb_secret`은 컴포넌트별로 별도 생성해 배포 환경에 직접 주입합니다. runtime 서비스 계정에는 Secret Manager 조회 권한을 부여하지 않습니다.
- `GOOGLE_APPLICATION_CREDENTIALS` 파일을 Cloud Run에 넣지 않고 연결된 서비스 계정의 ADC를 사용합니다.

배포 전에 Cloud Run 요청 timeout을 60분으로 설정하고, 배포 후 `GET /health`가 `Cache-Control: no-store`와 `{ "ok": true }`를 반환하는지 확인해야 합니다. `/metrics` 검증에는 secret bearer를 사용하며 인증 실패 시 404가 반환되는지 함께 확인합니다. Cloud Run 공개 점검에는 플랫폼에서 선점될 수 있는 `/healthz`를 사용하지 않습니다. 이 폴더는 자동 배포 명령을 포함하지 않습니다.
