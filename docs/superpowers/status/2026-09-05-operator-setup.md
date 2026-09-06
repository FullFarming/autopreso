# NOVA 운영 설정 안내

2026-09-05. 이 문서는 이번 구현을 운영 환경에 연결할 때 필요한 설정이다. 코드 변경만으로 Vercel·Supabase·Google 설정이 자동 적용되지는 않는다. 운영 배포와 운영 DB 변경은 아직 실행하지 않았다.

## 1. 먼저 준비할 값

문서 기반 용어집의 신규 Drive 연동 준비 사항은 이 문서 마지막의 **Google Drive 용어집 가져오기 준비**를 참고한다. 해당 연동은 설계 단계이며 기존 Google 가입 설정만으로 동작하지 않는다.

- 실제 관리자 이메일: `ADMIN_BOOTSTRAP_EMAILS`. `noel` 아이디를 실제 Supabase 사용자와 연결하는 데 필요하다.
- 웹앱의 최종 HTTPS 주소, Supabase 프로젝트 URL·공개 키·서버 전용 secret key.
- Soniox API 키. Gemini 배정과 종료 후 요약을 사용할 경우 Gemini API 키도 준비한다.
- Google 가입을 위한 OAuth Client ID와 Client Secret.
- 기존 gateway 주소와 웹앱/gateway가 공유하는 서명 키. 기존 운영 키를 임의로 새로 만들면 기존 참가자의 입장권이 무효화된다.

개인 키·비밀번호를 이 문서, 소스 코드, `NEXT_PUBLIC_*` 변수에 입력하지 않는다. 아래 표의 공개 변수만 브라우저에 전달된다.

## 2. noel 관리자 로그인

요청한 관리자 비밀번호는 로컬 `webapp/.env.local`에 **scrypt 해시**로 저장했다. 원문 비밀번호는 저장하지 않았다. Git에서 제외된 파일이며 파일 권한은 소유자 읽기·쓰기만 허용한다.

비밀번호를 다시 설정할 때 프로젝트 루트에서 다음을 실행한다. 터미널에 입력한 문자는 표시되지 않는다.

```sh
node scripts/configure-admin-login.mjs
```

이 도구는 다른 환경변수를 보존하면서 `ADMIN_USER_IDS=noel`, `ADMIN_PASSWORD_HASH`를 설정하고 평문 `ADMIN_PASSWORD` 설정을 제거한다. Vercel 대시보드 입력용 값은 비공개 `webapp/.env.admin-vercel`에 저장된다.

| 설정 | 입력할 내용 |
|---|---|
| `ADMIN_USER_IDS` | `noel` |
| `ADMIN_PASSWORD_HASH` | `.env.admin-vercel` 파일의 해당 값 |
| `ADMIN_BOOTSTRAP_EMAILS` | 본인이 소유한 실제 관리자 이메일 |
| `LIVE_ALLOW_WEAK_TEST_LOGIN` | 운영에서 `false` |

**주의할 형식 차이:** Next.js의 `.env.local`에서는 `$`가 `\$`로 이스케이프되어야 한다. Vercel Environment Variables 입력란에는 역슬래시가 없는 원래 해시를 넣는다. 위 도구가 두 형식을 각각 생성한다.

검증된 비밀번호로 처음 로그인하면 설정된 이메일의 Auth 사용자와 관리자 프로필을 연결한다. 이 과정은 확인 메일이나 사용자 비밀번호를 새로 보내지 않는다. 이미 차단된 계정은 복구하지 않는다. 같은 이메일이 일반 사용자·승인 대기 계정으로 이미 존재하면 `ADMIN_BOOTSTRAP_CONFLICT`가 발생할 수 있으므로, 기존 관리자를 통해 그 계정의 권한을 확인한 뒤 운영자가 조정한다. 이메일을 임의로 다른 사람 주소로 지정하지 않는다.

로그인 후 `/admin`에서 Live Call을, 관리자 콘솔 `/console`에서 사용자 승인·배정·운영 설정을 관리한다. 아이디가 `noel`이라는 이유만으로 인증을 생략하지 않는다.

## 3. Vercel 웹앱

이 저장소를 연결하고 Root Directory를 **`webapp`**으로 설정한다. Next.js 프레임워크, Node.js 24, Install `npm ci`, Build `npm run build`를 사용한다. 저장소 바깥 경로가 아니라 저장소 내부의 `packages/`를 함께 참조하므로 **Include source files outside of the Root Directory in the Build Step** 옵션을 켠다. 프로젝트의 `next.config.mjs`에도 상위 파일 추적이 설정되어 있다.

[공식 Monorepo 안내](https://vercel.com/docs/monorepos/monorepo-faq), [환경변수 안내](https://vercel.com/docs/environment-variables).

| 환경변수 | 용도 / 값 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 프로젝트 HTTPS URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 공개 publishable key; 기존 변수명을 유지 |
| `NEXT_PUBLIC_LIVE_GATEWAY_URL` | `wss://<gateway-host>/live` |
| `SUPABASE_SECRET_KEY` | 웹 서버 전용 Supabase secret key |
| `LIVE_ALLOWED_SUPABASE_REF` | 허용된 Supabase 프로젝트 ref |
| `LIVE_EXTERNAL_ENV` | 현재 프로젝트의 외부 연결 가드는 `development` 값만 허용한다. Vercel의 Production/Preview 구분과 별개다. |
| `ALLOWED_ORIGINS` | 실제 웹앱 origin. 경로·와일드카드 없이 `https://<web-host>`; 여러 주소는 쉼표 구분 |
| `SESSION_SECRET`, `PAIR_SECRET` | 각각 독립적인 충분히 긴 무작위 비밀 값, 최소 32자 |
| `LIVE_ADMISSION_PEPPER` | 입장 코드 보호용 서버 비밀 값 |
| `LIVE_VIEWER_TOKEN_SECRET` | gateway와 동일한 참가자 토큰 서명 키 |
| `LIVE_GATEWAY_TOKEN_SECRET` | gateway와 동일한 호스트 토큰 서명 키 |
| `SONIOX_API_KEY` | 관리형 PC 캡션의 단기 연결 키 발급에 필요 |
| `GEMINI_API_KEY` | Gemini 캡션의 단기 연결 권한·텍스트 번역, Live Call 종료 후 요약에 필요 |
| `ADMIN_USER_IDS`, `ADMIN_PASSWORD_HASH`, `ADMIN_BOOTSTRAP_EMAILS` | 위 관리자 설정 |

추가 운영 기능을 이미 사용 중이면 `.env.example`과 기존 배포 안내에 있는 cron/prewarm 변수도 유지한다. `NEXT_PUBLIC_LIVE_GATEWAY_PREWARM_ENABLED=false` 상태에서는 사전 예열을 기대하지 않는다. 환경변수를 변경한 뒤에는 해당 환경으로 새 배포해야 반영된다. Preview에서 운영 DB·키로 신규 기능을 시험하지 말고 별도 개발 프로젝트를 사용한다.

## 4. Supabase와 Google 가입

1. Supabase Auth에서 Email 가입 및 Google provider를 활성화한다. 이메일 확인 정책과 신규 사용자 승인 정책을 선택한다. 앱은 현재 콘솔의 승인 정책을 따르며, 신규 사용자의 기본 엔진은 Soniox다.
2. Google Cloud에서 OAuth 동의 화면과 **웹 애플리케이션** OAuth Client를 만든다.
3. Google의 Authorized JavaScript origins에 실제 웹앱 origin을 등록한다.
4. Google의 Authorized redirect URIs에는 **Supabase 대시보드에 표시된 callback URL**을 등록한다. 보통 `https://<project-ref>.supabase.co/auth/v1/callback`이다. 여기에 앱의 `/auth/callback`을 대신 넣지 않는다.
5. Client ID와 Client Secret은 Supabase Google provider 설정에 입력한다.
6. Supabase Auth URL Configuration의 Site URL을 웹앱 주소로 설정한다. Redirect URLs에는 `https://<web-host>/auth/callback`과 사용하는 개발 환경의 정확한 callback 주소를 추가한다. 데스크톱 Google 로그인도 기존 브라우저 callback·교환 경로를 사용한다.
7. Google 앱이 Testing 상태라면 실제 시험 계정을 Test users에 등록한다. 공개 가입 전에는 Google의 게시/검증 요구를 확인한다.

[Supabase Google 가입 공식 문서](https://supabase.com/docs/guides/auth/social-login/auth-google), [redirect URL 공식 문서](https://supabase.com/docs/guides/auth/redirect-urls).

이메일 발송 설정이 없는 환경에서는 가입 확인·비밀번호 재설정 메일이 정상 도착하는지 별도 확인해야 한다. 이번 작업에서 실제 가입 메일을 발송하지 않았다.

## 5. DB 변경 순서

기존 프로젝트에서는 먼저 기존 migration 적용 상태를 확인하고 누락된 선행 migration부터 순서대로 적용한다. 이번 변경 파일:

1. `supabase/migrations/202609050001_user_engine_access_renewal.sql`
2. `supabase/migrations/202609050002_managed_caption_sessions.sql`

새 프로젝트만 `supabase/bootstrap-new-project.sql`을 사용한다. 기존 운영 DB에 bootstrap 전체를 다시 실행하지 않는다. 자세한 의존성과 RPC는 `supabase/README.md`에 있다.

첫 migration은 사용자 엔진 배정과 Live Call 접근 권한 갱신을 추가한다. 두 번째는 PC 캡션 세션의 시작·종료 및 배정 메타데이터를 서버에서 검증하기 위한 저장소다. PC 캡션의 음성·자막 본문을 서버 기록에 저장하기 위한 테이블이 아니다.

배정 변경은 **다음 새 제품 세션부터** 적용된다. 진행 중 연결 재시도·공급자 시간 제한 교체는 새 제품 세션이 아니며 기존 엔진을 유지한다. 기존 사용자/세션 데이터는 삭제하지 않는다.

## 6. 실시간 gateway

Vercel 웹앱과 별도로 기존 Cloud Run gateway를 배포한다. 긴 WebSocket 음성 연결을 Next.js 요청으로 옮기지 않는다.

- 서버 전용 `SONIOX_API_KEY`를 설정한다. Soniox 실시간 인식·번역에는 Gemini 키가 필요하지 않다.
- Gemini를 배정할 경우 gateway에도 `GEMINI_API_KEY`가 필요하다.
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `LIVE_ALLOWED_SUPABASE_REF`를 맞춘다.
- `GOOGLE_CLOUD_PROJECT`와 `LIVE_ALLOWED_GCP_PROJECT`는 같은 허용된 프로젝트로 지정하고 현재 가드의 `LIVE_EXTERNAL_ENV=development`를 유지한다.
- `LIVE_GATEWAY_TOKEN_SECRET`, `LIVE_VIEWER_TOKEN_SECRET`는 웹앱 값과 정확히 같아야 한다.
- `LIVE_GATEWAY_ALLOWED_ORIGINS`에 실제 웹앱 origin을 지정한다. 데스크톱 직접 연결이 필요한 배포는 기존 `LIVE_GATEWAY_ALLOW_TRUSTED_NON_BROWSER` 정책을 확인한다.
- 이미 사용 중인 참여자 수요 기반 연결 정책 `LIVE_PARTICIPANT_DEMAND_ENABLED`는 웹앱과 gateway에서 일치시킨다.
- 장시간 연결을 허용하는 Cloud Run 요청 제한을 설정해도 공급자/네트워크 연결은 끊어질 수 있다. 앱이 재연결하며 회의 자체를 자동 종료하지 않는다.

Soniox 3개 언어에서는 입력당 최대 3개 스트림을 사용한다. 마이크·시스템 오디오 동시 입력 및 연결 교체의 일시적인 중첩까지 포함해 Soniox 동시 연결 한도를 확보해야 한다. 429/과금 한도/인증 실패는 무조건 즉시 반복해서 해결되지 않는다. 연결 시간 한도에 따른 종료는 새 연결로 이어가고, 지속 장애는 상태를 표시한다.

## 7. PC 앱과 모델 연결

새 PC 앱 빌드가 필요하다. 기존 설치본은 새 관리자 배정/인증 API와 자동으로 같아지지 않는다.

관리형 PC 캡션은 로그인된 세션으로 서버에서 단기 연결 권한을 얻는다. Soniox는 제한된 임시 키, Gemini Transcribe는 모델이 제한된 단기 토큰을 사용한다. Gemini의 텍스트 번역은 서버를 통해 수행한다. 장기 모델 키를 PC 앱에 포함하거나 사용자 설정에 배포하지 않는다. [Soniox 임시 키](https://soniox.com/docs/guides/temporary-api-keys), [Gemini Transcribe 단기 토큰](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe).

macOS에서는 마이크·화면/시스템 오디오 권한, Windows에서는 선택한 입력 장치와 시스템 오디오 캡처를 확인한다. 캡션은 인터넷 연결이 필요하다.

## 8. 운영 반영 전 확인

- 일반 이메일 가입·Google 가입 → 승인 정책 적용 → Soniox 기본 배정.
- `noel` 정상/오류 비밀번호, 관리자 이메일 누락, 차단된 계정 로그인.
- 관리자 Soniox↔Gemini 변경 → 현재 세션 유지 → 다음 시작에 변경.
- 한국어 발화 + 한국어·영어·일본어: 원문과 두 번역이 올바르게 표시되는지.
- 10분 이상 연속 음성, 순간 네트워크 단절, 재연결 도중 호스트 종료.
- 6시간 경계를 넘어 호스트/참가자 접근 유지, 닫힌 입장권은 다시 열리지 않음.
- Live Call 종료 후 원문/번역 기록·요약, Soniox만 설정된 환경에서는 요약 키 누락을 별도 안내.
- 설치본의 마이크/시스템 입력과 웹 참여자 화면을 같은 실제 음성으로 비교.

자동 검증과 로컬 화면 점검은 실제 공급자 음성 품질 시험을 대체하지 않는다. 이번 작업의 최종 검증 보고서에서 실측 여부를 확인한다. 이상 시 신규 세션 생성을 잠시 중지하고 이전 웹앱/gateway/PC 버전을 함께 되돌린다. 추가된 DB 컬럼·테이블을 긴급 삭제하지 않는다. 운영 배포는 별도의 명시적인 배포 지시 후 진행한다.

## 9. Google Drive 용어집 가져오기 준비

2026-09-05 추가 설계. **아직 Drive 연동 코드·callback은 구현 전**이다. 다음 준비 사항을 기존 Google 회원가입 설정과 구분한다. 구체적 환경변수명과 callback 경로는 구현 완료 후 이 절에 확정하며, 임의의 redirect URL을 등록하지 않는다.

1. 연동에 사용할 Google Cloud 프로젝트에서 Google Drive API와 Google Picker API를 활성화한다.
2. 선택 파일 접근에 사용할 OAuth 클라이언트와 동의 화면을 준비한다. 로그인용 `openid/email/profile`과 별개로, 파일 선택 시 `https://www.googleapis.com/auth/drive.file` 범위를 요청하도록 구성한다. 전체 Drive 읽기 권한은 요구하지 않는다.
3. Picker App ID는 Google Cloud 프로젝트 번호다. OAuth Client ID와 Picker App ID는 같은 프로젝트를 사용한다. Picker용 공개 API 키는 실제 웹 origin과 필요한 API로 제한한다. OAuth Client Secret은 서버 전용으로 보관한다.
4. 구현에서 확정한 웹 origin과 Drive OAuth callback을 정확하게 등록한다. 기존 Supabase Google 로그인 callback을 Drive 전용 callback으로 임의 대체하지 않는다. 개발·운영 주소는 구분한다.
5. 테스트 계정에 PDF/Google Docs 샘플을 준비한다. 사용자 Drive 전체를 사전 수집하지 않는다. 사용자가 Picker로 직접 선택한 문서만 분석한다.
6. 문서 분석용 Gemini 키와 해당 PDF 지원 모델의 이용 가능 여부를 확인한다. Transcribe Live 키 연결만으로 문서 추출 경로가 자동 완성되지는 않는다. 현재 PDF 추출 모델과 한도를 구현 문서에서 확인한다.
7. 일회성 문서 가져오기에는 장기 동기화를 설정하지 않는다. 토큰·문서 내용·API 키를 브라우저 영구 저장소나 로그에 남기지 않는다. Mac 앱에서는 시스템 브라우저 인증 흐름을 사용한다.

Google Docs PDF 내보내기는 10MB 제한이 있으며 현재 앱 PDF 추출기도 10MB 제한이다. 더 큰 파일을 조용히 잘라 분석 완료로 표시하지 않는다. 운영 적용 전에는 권한 철회·다운로드 금지·파일 크기 초과·두 문서 연속 가져오기와 중복·번역 충돌을 시험한다.

공식 문서: [Drive 권한 범위](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Picker 설정](https://developers.google.com/workspace/drive/picker/guides/web-picker-sample), [다운로드·내보내기](https://developers.google.com/workspace/drive/api/guides/manage-downloads).

상세 설계: [문서 용어집과 출력 제어](../plans/2026-09-05-document-glossary-and-display-controls.md).
