# Realtime Noel media gateway

Cloud Run용 오디오 전용 게이트웨이입니다. 호스트는 `/live` WebSocket으로 PCM16 mono 16 kHz, **40 ms/1,280 bytes** 프레임을 보내고, 시청자는 같은 경로에서 PCM16 24 kHz 바이너리를 구독합니다. 공개 상태 점검은 `/health`를 사용합니다. `/healthz`는 로컬 호환성을 위해 동일한 응답을 유지합니다. `/metrics`는 공개 endpoint가 아니며 `LIVE_GATEWAY_METRICS_TOKEN`과 정확히 일치하는 `Authorization: Bearer <token>`이 있어야 응답합니다. 세 endpoint 모두 오디오·자막·토큰 내용을 포함하지 않습니다.

필수 환경변수: `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GEMINI_LIVE_MODEL`, `GOOGLE_CLOUD_PROJECT`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `LIVE_GATEWAY_TOKEN_SECRET`, `LIVE_VIEWER_TOKEN_SECRET`, `LIVE_GATEWAY_ALLOWED_ORIGINS`, `LIVE_GATEWAY_METRICS_TOKEN`, `LIVE_EXTERNAL_ENV=development`, `LIVE_ALLOWED_GCP_PROJECT`, `LIVE_ALLOWED_SUPABASE_REF`. 실제 GCP project와 Supabase project ref는 allowlist 값과 정확히 같아야 하며, URL의 port·query·fragment도 허용하지 않습니다. 두 AI 키는 서버에만 두며 브라우저로 반환하지 않습니다. `SUPABASE_SERVICE_ROLE_KEY`는 기존 개발 환경의 임시 fallback일 뿐이며 새 연결에는 사용하지 않습니다. 선택적으로 `STT_LANGUAGE_CODES`(기본 `ko-KR,en-US,ja-JP`)와 Cloud Run의 `PORT`를 사용합니다. Google Cloud STT·Translation·TTS 인증은 Application Default Credentials로 주입합니다. 값 형식은 `.env.example`을 참고하되 실제 secret은 커밋하지 않습니다.

## 실시간 처리 경로

- Presentation 자막은 출력 모드와 관계없이 Gemini Live Translate를 사용합니다.
- Presentation 음성은 Gemini 또는 OpenAI Realtime Translation 중 선택하며, OpenAI 경로는 24 kHz PCM16 연속 스트림의 음성 delta만 전달하고 transcript는 자막에 사용하지 않습니다.
- Meeting/Townhall은 Cloud STT V1 streaming diarization의 final 화자 라벨을 사용합니다. 이 라벨은 final 응답에서만 제공되므로, 쉼 없이 이어지는 장문 발화에서는 번역 자막·음성이 발화 종료 뒤 늦게 시작될 수 있습니다. 이 경로에는 Presentation 단일 발표자 저지연 목표를 적용하지 않습니다.

## 승인 전 IAM 조건

- Cloud Run runtime에는 사용자 관리 서비스 계정을 사용하고 Owner·Editor·Viewer와 서비스 에이전트 역할을 부여하지 않습니다.
- STT 호출에는 공식 최소 역할인 `roles/speech.client`만 사용합니다.
- 일반 TTS synthesis에는 Long Audio 전용 TTS IAM 역할을 부여하지 않습니다. ADC quota project가 요구하는 경우에만 개발 프로젝트의 `roles/serviceusage.serviceUsageConsumer`를 사용합니다.
- 애플리케이션은 stdout/stderr의 Cloud Run 기본 수집만 사용합니다. Logging API 직접 호출을 추가할 때만 `roles/logging.logWriter`를 검토합니다.
- Gemini 서버 API key는 개발 프로젝트와 Generative Language API로 제한하고 브라우저에 전달하지 않습니다.
- Supabase `sb_secret`은 컴포넌트별로 별도 생성해 배포 환경에 직접 주입합니다. runtime 서비스 계정에는 Secret Manager 조회 권한을 부여하지 않습니다.
- `GOOGLE_APPLICATION_CREDENTIALS` 파일을 Cloud Run에 넣지 않고 연결된 서비스 계정의 ADC를 사용합니다.

배포 전에 Cloud Run 요청 timeout을 60분으로 설정하고, 배포 후 `GET /health`가 `Cache-Control: no-store`와 `{ "ok": true }`를 반환하는지 확인해야 합니다. `/metrics` 검증에는 secret bearer를 사용하며 인증 실패 시 404가 반환되는지 함께 확인합니다. Cloud Run 공개 점검에는 플랫폼에서 선점될 수 있는 `/healthz`를 사용하지 않습니다. 이 폴더는 자동 배포 명령을 포함하지 않습니다.
