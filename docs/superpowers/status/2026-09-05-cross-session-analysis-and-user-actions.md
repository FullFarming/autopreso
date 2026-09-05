# 두 세션 작업 대조 분석 — 번역 기능 오차·개선점·사용자 할 일 (2026-09-05)

대상: 다른 세션의 인계 문서(`2026-09-05-session-handoff.md`)와 그 세션이 메인 워킹트리에 남긴 **미커밋 변경**(HEAD 949b06f 대비 약 330개 파일) vs 이 세션의 커밋(949b06f + 강화 브랜치 `codex/engine-hardening-20260905` HEAD 0ffcacd).

분석 방법: 문서만 읽지 않고 실제 코드를 대조했다. 메인 워킹트리에서 세 스위트를 직접 실행(루트 1530/1511 통과/19 skip, 게이트웨이 625/625, 웹앱 1029+78, 타입체크 2종 통과 — 인계 문서 수치와 일치), 번역 경로와 인증·콘솔·요약 경로를 각각 읽기 전용으로 정밀 검토했다. 아래 file:line은 메인 워킹트리 기준이다.

---

## 1. 결론 요약

1. 그 세션의 작업은 **테스트는 모두 녹색이지만, 그대로 배포하면 새 Live Call이 시작되지 않는 실제 기능 오류(C1)** 가 있다. 테스트가 없는 경계에서 난 오류라 스위트가 잡지 못했다.
2. 그 세션은 9월 4일에 확정된 결정(관리자 전역 엔진 하나, 호스트 잠금, 배포 시 진행 중 세션 즉시 전환)을 **사용자 재확인 없이 반대 방향(사용자별 배정, 다음 세션부터, 즉시 전환 거절)** 으로 바꾸고 관련 테스트를 삭제·반전했다. 이것은 버그가 아니라 제품 결정이므로 사용자가 다시 정해야 한다.
3. 번역 자체(Soniox 3개 언어 팬아웃, 입력 언어 구간 잠금)는 방향은 좋지만 **지연·누락을 만드는 결함이 3건** 있어 실음성 검증 없이 기본값으로 켜면 안 된다.
4. 그 외(관리형 자막 자격증명 브로커, 참여자 접근 갱신, 화자 명단, 요약 폴링)는 잘 만들어졌고 계약(C1, ⑥ 판정)을 지킨다. 마이그레이션 멱등성만 고치면 배포 가능하다.
5. 이 세션의 커밋(949b06f, 강화 브랜치)은 클린 체크아웃에서 전부 녹색이며 그 세션 작업의 **기반**이다. 두 작업은 대체 관계가 아니라 순서대로 쌓인 관계다.

---

## 2. 두 작업의 관계와 차이

| 항목 | 이 세션(커밋, 949b06f + 강화 브랜치) | 다른 세션(메인 WT 미커밋) | 판단 |
|---|---|---|---|
| Live Call 엔진 결정 | 관리자 전역 `engine_defaults` 하나. 비관리자가 보낸 엔진은 서버가 전역값으로 대체. | `profiles.voice_provider`(soniox/gemini)로 **사용자별 배정**, 세션 생성 시 `assignmentRevision`으로 고정. `engine_defaults`는 아무 것도 결정하지 않는 죽은 설정. | 결정 필요(§4 D1) |
| 진행 중 세션 전환 | 콘솔 "배포" → RPC + 게이트웨이 내부 엔드포인트로 즉시 교체, seq 연속, `engine-status` | 게이트웨이 엔드포인트가 무조건 409, RPC `set_live_session_engine_admin_v1` **revoke**, 콘솔 PUT은 `switched:0` 가짜 요약 반환 | 결정 필요(D1). 최소한 장애 시 비상 전환 경로(break-glass)는 유지해야 함 |
| 기본 엔진 | Gemini 3.5 Transcribe Live + Flash | Soniox 인식+번역. 기존 프로필도 마이그레이션에서 일괄 soniox rev 1 | 결정 필요(D2). 기존 사용자 일괄 변경은 계획 문서 자체와 모순 |
| Soniox 언어 수 | 정확히 2개(two_way) | 1~3개. 3개는 대상별 별도 연결(팬아웃), 1개는 one_way | 개선이나 결함 3건(§3.2) |
| 입력 언어 안정화 | 없음(공급자 결과 그대로) | `sentence-language-routing.js` 구간 잠금 + 데스크톱 동등 로직 | 개선이나 부작용 1건(§3.3) |
| 게이트웨이 Gemini 키 | 필수 | Soniox 배정이면 불필요, GenAI import 생략 | 개선, 유지 |
| 승인 상태 캐시 | 저장소 장애 시 마지막 값 유지(전원 잠금 방지) | 장애 시 만료된 캐시 거부 → 60초 지나면 모든 호스트 401 | 되돌려야 함(§3.5) |
| `noel` 로그인 | 환경변수 비번, 프로필 없음(레거시) | 비번 검증 후 `ADMIN_BOOTSTRAP_EMAILS[0]`의 Auth 사용자를 **생성·연결**, Supabase 없으면 503 | 권한 모델은 건전, 운영 부작용 2건 |
| 관리형 PC 자막 자격증명 | 없음(로컬 키) | 서버가 Soniox 임시 키(60초·1회·600초)/Gemini 단기 토큰 발급, 종료된 세션 재사용 불가 | 개선, 유지(만료 없는 갱신만 보완) |
| 요약 폴링 | ⑥ 판정 반영 | RUNNING=진행 중, 원문 먼저, 20~25초 폴링, 6회 연속 실패만 exhaustion | 개선, 벽시계 상한만 추가 |
| 화자 명단·이력 | 없음 | 명단·사진(2MiB→WebP≤256KiB)·revision·스냅샷 불변 | 개선, 유지 |
| 테스트 수 | 루트 1676 / 게이트웨이 598 / 웹 943+77 | 루트 1530 / 625 / 1029+78 (캔버스 테스트 24개 파일 삭제 포함) | 둘 다 녹색 |

---

## 3. 번역 기능의 오차·문제 (심각도순)

### 3.1 [치명] 새 Live Call이 시작되지 않는다 — `assignmentRevision` 키 거부
- 쓰는 쪽: `webapp/lib/live/service.ts:52`가 세션 생성 시 `modelPreferences = { engine, engineHistory: [], assignmentRevision }`를 저장하고, `store.ts`가 그대로 돌려준다.
- 읽는 쪽: 데스크톱 `electron/main.js:1200-1206` `readLiveCallModelPreferences`와 웹 호스트 `webapp/components/live/live-audio-client.ts:112-117` `readHostModelPreferences`는 `engine`/`engineHistory` 이외 키가 있으면 `EngineSelectionError`/`INVALID_ENGINE`을 던진다. 데스크톱은 매 (재)시작 전 재핀 경로(906fe46)에서 이 함수를 호출한다.
- 결과: 그 세션의 웹앱이 만든 세션은 어느 호스트 경로에서도 게이트웨이 파이프라인을 시작하지 못한다. `assignmentRevision`을 다루는 테스트가 두 리더 모두에 없다.
- 수정: 두 리더가 `assignmentRevision`을 허용하고 버리도록(`model-preferences.ts:155`와 동일 규칙) 바꾸고, 생성된 세션의 `modelPreferences`를 시작 경로까지 왕복시키는 데스크톱·웹 호스트 테스트 각 1개 추가.

### 3.2 [중요] Soniox 3개 언어 팬아웃의 지연·누락
- 정렬 조건이 너무 엄격: `media-gateway/src/engines/soniox-fanout-adapter.js:6-19`는 보조 연결의 번역을 **원문 텍스트 완전 일치(NFC, 공백 결합) + 오프셋 ±80 ms**로만 붙인다. 독립 인식 결과는 구두점·띄어쓰기·구간 경계가 흔히 다르므로 자주 실패하고, 실패하면 최종 자막을 **3초**(`:97`) 잡아 두었다가 해당 언어를 누락(fail-open, 원문 표시)으로 내보낸다.
- 죽은 보조 연결을 정렬 대기에서 빼지 않음(`:49`): 한 언어 연결이 죽으면 그 뒤 **모든** 최종 자막이 세션 끝까지 3초씩 늦는다.
- 보조 연결 실패가 영구적(`:117-125`): 일시적 쓰기 오류(`STT_AUDIO_BACKPRESSURE` 포함)도 실패 처리하고 다시 열지 않는다.
- 동시 롤오버(`rolling-speech-session.js:96,188-192`): 세 연결이 같은 시각에 교체된다. 데스크톱 마이크+시스템 3개 언어 = 평시 6, 교체 시 12; 게이트웨이 3/6 추가 → 최대 18 연결. Soniox 기본 동시 연결 한도 10을 넘는다.
- `Date.now()` 직접 사용(`:50,70,97`)으로 주입 시계와 불일치.
- 수정: 실패 레인은 정렬 대기에서 제외; 정렬은 오프셋 우선·텍스트는 정규화(구두점/공백 제거) 후 보조 기준; 일시 오류는 RSS 롤오버로 재개; 레인별 롤오버를 60초씩 어긋나게; 실음성으로 언어별 누락률·지연 측정 후에만 3개 언어 Soniox를 열기.

### 3.3 [중요] 언어 힌트 제한 해제와 구간 잠금의 부작용
- `packages/caption-core/soniox-protocol.js:100`: 자동 모드에서 `language_hints_strict`가 꺼지고 출력 언어를 힌트로만 보낸다. 9월 2일 확정한 방어(`["ko","en"]` strict — 한국어를 zh/vi로 오인식하던 근본 원인 대응)가 풀렸다. 게이트웨이도 Gemini STT에 `languageCodes: []`를 보내 힌트가 사라졌다(`media-gateway/src/server.js:339`). "입력 언어와 출력 언어 분리"라는 제품 의도는 이해되지만, 알려진 실패 모드를 다시 연 것이므로 **실음성 검증(한국어 발화의 타 스크립트 오인식 0건) 전에는 strict를 유지**하는 것이 안전하다.
- 구간 잠금(`media-gateway/src/sentence-language-routing.js:14-15`, `live-media-pipeline.js:628-629,679`): 한 Soniox 구간 안에서 화자가 한국어→영어로 바꾸면 영어 원문 임시 자막과 한국어 번역 임시 자막이 모두 억제되어 최종 자막까지 아무 것도 안 보인다. 잘못된 방향 번역은 만들지 않고 저장 언어에도 영향 없음(표시 라우팅만). 최종·화자 변경·재연결·정지 시 초기화는 되어 있다.
- 팬아웃과 결합 시 깜빡임: 다음 구간의 영어 임시 자막이 이전 구간 최종이 3초 잡혀 있는 동안 같은 seq를 미리보기(peek)로 받아 표시되다가 최종으로 덮인다(C1 계약은 유지).

### 3.4 [중요] 기본값 Soniox 전환의 운영 위험
- `caption-engine-catalog.js:48` 기본값이 Soniox라 `modelPreferences`가 없는 기존 준비 세션·게이트웨이 authorizer의 "없음→기본값"이 모두 Soniox가 된다. 게이트웨이에 `SONIOX_API_KEY`가 없으면 모든 새 세션이 거절된다.
- 마이그레이션 `202609050001:4`가 **기존 프로필 전부**를 soniox rev 1로 바꾼다(계획 문서는 "기존 사용자 배정을 자동 덮어쓰지 않는다"고 적었다).
- 배포 순서: 웹앱을 게이트웨이보다 먼저 올리면 HEAD 게이트웨이는 3개 언어 Soniox를 `ENGINE_SELECTION_INVALID`로 거절한다. 게이트웨이 먼저.
- 결합 엔진(Soniox)에서는 주제 추론·요약 부수 기능이 조용히 꺼진다(`live-media-pipeline.js:1368`, `server.js:311`). 상태 표시나 명시적 결정이 필요하다.
- 계약 C6(모든 세션은 ko+en 포함) 제거(`service.ts`, `live-service.test.ts:795`). ko·en이 둘 다 없는 세션에서 뷰어·스테이지 기본 언어 선택을 검증해야 한다.

### 3.5 [중요] 인증 경로: 장애 시 전원 잠금
- `webapp/lib/auth/profile-status-cache.ts:24-27`: Supabase 일시 장애 시 60초 지난 캐시를 거부 → 모든 호스트가 세션·토큰·기록·자막 API에서 401. 동시에 `noel` 레거시 로그인도 Supabase Auth Admin API를 요구해(`login/route.ts:120-131`) 장애 중 비상 로그인이 없다.
- 그 세션이 든 이유("만료 캐시로 유료 키 발급 연장 금지")는 이미 서버가 DB를 직접 읽어(`read_managed_caption_session_v1`이 `status='approved'` 요구) 보장하고 있어, 캐시 변경은 보호를 더하지 않고 잠금만 더한다.
- 수정: 마지막 값 유지 + 상한(예: TTL 지나 10분까지)으로 되돌리고, 유료 키 발급 경로는 지금처럼 DB 권위 유지.

### 3.6 [보통] 그 외
- 관리형 자막 세션 갱신에 만료 검사 없음(`202609050002:62-78`, `broker.ts:101`): 종료 안 한 세션을 몇 달 뒤에도 되살릴 수 있어 배정 revision 고정이 무력화. 24시간 유예 창 또는 정리 작업 추가.
- 마이그레이션 `202609050003`은 `create table`/`create function`(멱등 아님), `202609050004`는 `add column`에 `if not exists` 없음 + `alter function … rename` 패턴(루트 금지 패턴 테스트가 못 잡음). 재실행 시 실패. 멱등으로 고쳐야 한다. 또한 0001은 202609020002~0004에 의존하므로 **이 세션의 마이그레이션 5개를 먼저 적용**해야 한다.
- 요약 폴링: RUNNING이 풀리지 않는 세션은 클라이언트가 무한 폴링(20~25초). 벽시계 상한(예: 30분) 추가.
- `settings-store.js:425-432`: `translateAllLanguages`가 켜져 있으면 저장된 `["en","ko"]`를 로드 시 `["en","ko","ja"]`로 확장 → 조용한 3번째 언어(=Soniox 연결 1개 추가) 옵트인.
- 데스크톱 3개 언어 Soniox에서 화자 언어가 대상 3개 밖이면 원문 자막이 어느 레인에도 안 뜬다(`subtitle-realtime.js:872-886`).
- 스테이지 화면에 `/host-screen` 링크를 허용하기 위해 "스테이지에 상호작용 요소 없음" 핀을 약화(`stage-login-minutes.test.ts:28`). 프로젝터 창이 링크로 이탈하지 않는지 확인.
- 콘솔 새 문구가 `t()`를 거치지 않은 한국어 하드코딩(`EnginePanel.tsx:154,195,227`, `UsersPanel.tsx:159,178-181`), `voiceProvider` 셀렉트는 확인 없이 즉시 PATCH.
- `engineHistory`는 이제 절대 추가되지 않아 8개/3800바이트 예산 코드가 죽은 코드. `engine-deploy.ts`, `gateway-engine-push.ts`도 죽은 코드. 강화 브랜치 ec128de는 그 세션이 삭제한 코드를 수정하므로 병합 충돌이 확정이다.

---

## 4. 사용자가 결정할 것 (이 결정 없이는 정합 작업을 시작할 수 없음)

| # | 질문 | 선택지와 함의 |
|---|---|---|
| D1 | Live Call 엔진을 누가·어떻게 정하나 | (a) 9/4 결정 유지: 전역 하나·호스트 잠금·배포 즉시 전환 → 그 세션의 사용자별 배정·revoke·409를 되돌리고 `voice_provider`는 제거 또는 전역값 위의 예외로만. (b) 그 세션 방식: 사용자별 배정·다음 세션부터 → 콘솔 엔진 패널의 죽은 선택·가짜 요약 제거, 배포/푸시 코드 삭제, **단 비상 전환 RPC는 revoke하지 않고 유지**, 강화 브랜치 리베이스. (c) 혼합: 전역 기본값 + 사용자별 예외 + 관리자 즉시 전환 유지 — 가장 유연하지만 구현량 최대. |
| D2 | 기본 엔진 | Gemini 유지(검증됨, 3언어 호환) vs Soniox(그 세션 기본; 실음성 미검증, 3언어 팬아웃 결함 수정 필요, 연결 한도 확인 필요). 기존 사용자 일괄 전환 여부도 함께. |
| D3 | 자동 모드 언어 힌트 | strict 유지(9/2 방어) vs 해제(그 세션). 해제하려면 P0 실음성 검증(한국어→zh/vi 오인식 0건) 결과가 먼저 있어야 한다. |
| D4 | 배포 단위 | (a) 이 세션 커밋(+강화 브랜치)만 먼저 배포 → 위험 최소, 게이트 통과 상태. (b) 그 세션 작업까지 §5 수정 후 커밋·클린 게이트·재리뷰 뒤 한 번에. |
| D5 | Vercel Root Directory | 현재 운영은 리포 루트. 그 세션 문서는 `webapp`으로 변경 안내. 변경 이유가 없으면 유지. |

---

## 5. 그 세션 작업을 살리기 위해 제가 할 수정 (D1~D3 결정 후)

우선순위순. 각 항목은 실패하는 테스트를 먼저 쓰고 고친다.
1. **C1 수정**: 두 호스트 리더가 `assignmentRevision`을 허용·폐기; 생성→시작 왕복 테스트 2개.
2. **캐시 되돌리기**: 승인 캐시 마지막 값 유지 + 상한; `noel` 로그인의 Supabase 의존은 `ADMIN_BOOTSTRAP_EMAILS` 설정 시에만, 미설정 로컬은 기존 동작.
3. **팬아웃 결함**: 실패 레인 대기 제외, 정규화 정렬, 일시 오류 재개, 롤오버 어긋나기, 주입 시계.
4. **마이그레이션 멱등화**(0003/0004) + 의존 순서 문서화; 관리형 자막 갱신 유예 창; 요약 폴링 벽시계 상한.
5. D1 결과에 따른 콘솔 정합(죽은 패널/가짜 요약 제거 또는 배포 경로 복원), 죽은 코드 정리, 강화 브랜치 리베이스/병합.
6. 콘솔 하드코딩 문구 `t()` 적용, `voiceProvider` 변경 확인 다이얼로그, `translateAllLanguages` 확장 로직 검토, 스테이지 링크 이탈 방지 확인.
7. 그 세션 변경을 **의미 단위로 커밋**(제품 분리 / 엔진·자격증명 / 화자 / 요약·접근 / 콘솔) → 클린 워크트리 게이트 → 코드 리뷰.

---

## 6. 사용자가 직접 해야 하는 것

### 6.1 지금
1. §4의 D1~D5 결정.
2. Soniox 계정의 **동시 연결 한도** 확인(현재 기본 10으로 알려짐). Soniox 기본·3개 언어를 쓰려면 20 이상 필요.
3. 실음성 리허설 소재 준비: 한국어·영어·일본어 동일 녹음, 약어(API·EBITDA), 고유명사, 화자 전환, 한 화자의 언어 전환, 잡음, 10분 이상 연속. 이것이 D2·D3의 근거가 된다.

### 6.2 계정·대시보드 (비밀 값은 채팅·문서에 넣지 않음)
1. Google Cloud: OAuth 동의 화면, **웹 애플리케이션** OAuth Client. Authorized JavaScript origins `https://realtime-noel-web.vercel.app`; Authorized redirect URIs는 **Supabase가 보여주는 callback**(`https://<project-ref>.supabase.co/auth/v1/callback`). 앱이 Testing이면 Test users 등록.
2. Supabase → Authentication: Email 활성화 + 이메일 확인 켜기; Google 활성화(Client ID/Secret); URL Configuration Site URL `https://realtime-noel-web.vercel.app`, Redirect URLs `https://realtime-noel-web.vercel.app/auth/callback`; 확인 메일 실제 수신 확인.
3. Vercel(realtime-noel-web) 환경변수: `ADMIN_BOOTSTRAP_EMAILS`(본인 관리자 이메일) 추가; `ADMIN_USER_IDS=noel` 유지; 그 세션의 scrypt 해시를 쓰기로 하면 `ADMIN_PASSWORD_HASH`(도구가 만든 Vercel용 값) 입력 후 평문 `ADMIN_PASSWORD` 제거; `LIVE_ALLOW_WEAK_TEST_LOGIN=false`; 그 세션 작업(관리형 PC 자막)을 배포할 때만 웹앱에도 `SONIOX_API_KEY`, `GEMINI_API_KEY`. 변경 후 새 배포 필요.
4. Cloud Run 게이트웨이: `SONIOX_API_KEY` 시크릿은 설치되어 있고 배포 명령에서 연결(제가 실행). `LIVE_GATEWAY_TOKEN_SECRET`/`LIVE_VIEWER_TOKEN_SECRET`는 웹앱과 동일 값 유지(재발급 금지).

### 6.3 Supabase SQL Editor — 배포 직전 읽기 전용 확인
```sql
-- 이제 거부되는 옛 형태(modelPreferences.source가 Flash id)의 세션
select id, status, event_metadata->'modelPreferences' as mp
from public.live_sessions
where event_metadata ? 'modelPreferences'
  and not (event_metadata->'modelPreferences' ? 'engine')
  and coalesce(event_metadata->'modelPreferences'->>'source','') not in ('gemini-3.5-live-translate-preview','gemini-3.5-transcribe-live');
-- 이벤트 메타데이터 정규화 함수 본문
select pg_get_functiondef('public.normalize_live_session_event_metadata'::regproc);
```
결과(행 수, 함수 본문)를 저에게 주시면 판독합니다.

### 6.4 마이그레이션 (파일명 순, SQL Editor에 전체 붙여넣기)
- 반드시 먼저: `202609020001`, `202609020002`, `202609020003`, `202609020004`, `202609020005` (이 세션).
- D4에서 그 세션 작업을 포함할 때만, 그 뒤에: `202609050001`, `202609050002`, `202609050003`, `202609050004` (§5.4 멱등화 뒤의 버전으로).
- 기존 운영 DB에 `bootstrap-new-project.sql` 전체를 실행하지 않는다.

### 6.5 배포 승인 (단계별, 제가 실행하고 결과 보고)
마이그레이션 → 웹앱(Vercel) → 부트스트랩 관리자 Google 첫 로그인 → 콘솔 화면 실제 확인 → 게이트웨이(트래픽 없이 리비전 → health → 전환; 롤백 `live-input-20260901`) → DMG(설치는 사용자) → 종단 확인 → 안정화 후 레거시 비번 로그인 끄기. 상세 명령은 `2026-09-05-deploy-runbook.md`.

---

## 7. 그 세션 작업에서 그대로 살릴 개선점
- Soniox `one_way` 지원과 `zh-Hans`/`zh-Hant` 코드 매핑, 연결 전 언어 검증.
- 공급자 주도 재연결(`onReconnectRequired`), 실패 스트림 추적, 타이머 기반 롤오버, 세대 간 오프셋 연속성.
- Gemini 어댑터: 꼬리 0 패딩 제거, 바이트 기반 오프셋, `goAway` 롤오버, 부분·최종에 `segmentId`.
- 게이트웨이가 Gemini 키 없이 부팅(Soniox 배정 시 GenAI import 생략), 요약 키 부재가 자막을 막지 않도록 분리.
- 문장 언어 라우팅 모듈(테스트 포함), 팬아웃의 fail-open 원칙(다른 레인 인식 결과로 대체하지 않음).
- 관리형 자막 자격증명 브로커 전체(임시 키 60초·1회·600초, Gemini 단기 토큰 모델 고정, 종료 후 410, 서버 전용 키 도달 불가 테스트).
- 참여자·호스트 접근 갱신 RPC(닫힌 창은 다시 열리지 않음), 뷰어 토큰 만료 상한.
- 요약: RUNNING을 진행 중으로, 읽기 재시도 분류, AbortController 15초, 숨은 탭 건너뛰기, 뷰어 스켈레톤, 리셋 권한 축소.
- 발언자 캡처 시점 프로필 스냅샷(현재 명단으로 과거 발언 덮어쓰지 않음), 화자 명단 모듈 전체.
- 데스크톱: 투명도 하한 0, 무제한 재연결 → 상한 있는 백오프, Gemini 비재시도 오류 코드.
- `loadForEngine`, `engineSummaryRequiredApiKeys` 분리, 설정 저장소의 캡션 언어 검증 통일.

---

## 8. 참고
- 이 세션 커밋 상태: `2026-09-05-project-status-and-worklog.md`, 배포 절차 `2026-09-05-deploy-runbook.md`, 사용자 할 일 초안 `2026-09-05-operator-todo-consolidated.md` (이 문서가 그것을 대체·확장한다).
- 그 세션 문서: `2026-09-05-session-handoff.md`, `2026-09-05-core-product-implementation.md`, `2026-09-05-operator-setup.md`.
- 분석 원장: `.superpowers/sdd/2026-09-02-caption-engine-plan-2-gateway-webapp/progress.md` 2026-09-05 17:10 항목.
