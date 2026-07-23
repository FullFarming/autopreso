# Realtime Noel Web

호스트 한 명의 오디오를 Cloud Run 미디어 게이트웨이로 보내고, 최대 3개 언어를 최대 50명의 웹·모바일·Chrome 시청자에게 공유하는 사내용 Live 화면입니다.

- `Presentation`: Gemini 3.5 Live Translate의 번역 자막과 선택적 native 번역 음성
- `Meeting`: Cloud STT V2 화자 분리 후 화자 고정 자막과 선택적 Chirp 3 HD 통역 음성

출력은 세션 형식과 별도로 `자막`(기본), `자막 + 통역 음성`, `통역 음성만` 중 하나를 고릅니다. 기존 `Townhall` 값은 한 호환 사이클 동안 `Meeting + 통역 음성만`으로만 읽습니다. 산업 용어팩은 지시를 지원하는 Meeting 텍스트 번역에 적용되며, Google 공식 제약상 Presentation의 Live Translate에는 적용되지 않습니다.

장기 Google API 키와 서비스 계정은 브라우저에 전달하지 않습니다. 기존 `/api/gemini-token`과 `/api/pair-keys`는 `410`으로 폐쇄됐습니다.

## 환경 변수

운영 환경의 secret 값은 모두 32자 이상이어야 하며 누락 시 fail-closed 됩니다.

| 변수 | 용도 |
| --- | --- |
| `ADMIN_USER_IDS` | 쉼표로 구분한 호스트 로그인 아이디 |
| `ADMIN_PASSWORD` | 호스트 로그인 비밀번호 |
| `SESSION_SECRET` | 호스트 세션 HMAC |
| `PAIR_SECRET` | 기존 QR 로그인 HMAC(키 동기화에는 사용하지 않음) |
| `LIVE_ADMISSION_PEPPER` | 6자리 입장번호 HMAC pepper |
| `LIVE_VIEWER_TOKEN_SECRET` | 6시간 VIEWER grant 토큰 |
| `LIVE_GATEWAY_TOKEN_SECRET` | 15분 HOST gateway 토큰; gateway와 동일 값 |
| `ALLOWED_ORIGINS` | 정확히 허용할 웹 origin 목록 |
| `CHROME_EXTENSION_ORIGIN` | 조직 배포 후 확정된 `chrome-extension://<32자 ID>` |
| `NEXT_PUBLIC_LIVE_GATEWAY_URL` | `/live`를 포함한 Cloud Run `wss://` 주소 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 프로젝트 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 브라우저 anonymous auth용 현재 `sb_publishable` 공개 키(호환 변수명) |
| `SUPABASE_SECRET_KEY` | 서버 전용 컴포넌트별 `sb_secret` REST/RPC 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | 임시 legacy fallback; 새 연결에는 사용하지 않음 |

로컬 `next dev`에서만 약한 테스트 계정을 써야 할 때는 `.env.development.local`에 `LIVE_ALLOW_WEAK_TEST_LOGIN=true`, `LIVE_TEST_LOGIN_ID`, `LIVE_TEST_LOGIN_PASSWORD`를 명시합니다. production build/runtime에서는 이 경로가 거부됩니다.

예시는 `.env.example`을 참고합니다. 실제 secret은 저장소에 커밋하지 않습니다.

## 로컬 검증

```sh
npm install
npm run typecheck
npm run test:live
npm run build
npm run dev
```

마이크·시스템 오디오와 Document PiP는 HTTPS 또는 localhost에서만 동작합니다. Supabase migration, Cloud Run 배포, Chrome 조직 배포는 별도의 승인 후 수행합니다.

## 주요 경로

```text
app/page.tsx                         호스트 Live 화면
app/watch/page.tsx                   데스크톱 시청자
app/m/watch/page.tsx                 모바일 시청자
app/api/live-sessions/               세션·입장·snapshot·gateway token API
components/live/                     호스트/시청자/AudioWorklet 클라이언트
lib/live-contract.ts                 REST·Broadcast·PCM 공개 계약
middleware.ts                        strict-origin CSRF·Auth·CSP
```
