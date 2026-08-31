# 게이트웨이 scale-to-zero 설계

작성일: 2026-08-15

## 문제

Cloud Run의 `realtime-noel-media-gateway`가 라이브콜을 거의 하지 않는 날에도 매일 과금된다.

원인은 서비스 설정 한 줄이다.

```
autoscaling.knative.dev/minScale: '1'
autoscaling.knative.dev/maxScale: '1'
cpu: '1', memory: 1Gi, timeoutSeconds: 3600
run.googleapis.com/startup-cpu-boost: 'true'
```

`minScale: 1`은 요청이 하나도 없어도 1 vCPU / 1 GiB 인스턴스를 24시간 유지한다.
월 2,592,000초의 프로비저닝 시간은 무료 active CPU 한도 180,000 vCPU-초의
14.4배다. 다만 request-based billing의 유휴 최소 인스턴스에는 더 낮은 idle 단가가
적용되므로 이 비율을 실제 청구액 배수로 해석하면 안 된다. WebSocket이 열려 있는
동안은 active 시간으로 과금된다.

게이트웨이를 다른 호스트로 옮기는 것은 이 문제의 해법으로 과하다. 게이트웨이는
Cloud Run 전용 API를 쓰지 않는 순수 Node + `ws` 서버라 이식 자체는 가능하지만,
이식하면 서비스 계정 키 파일 주입(`new SpeechClient()`의 ADC 의존), origin 허용목록,
WSS 인증서, 60분 WebSocket 유지 가능 여부를 전부 새로 해결해야 한다. 그리고 무료
티어 호스트 대부분이 유휴 시 휴면이라 콜드 스타트 문제는 그대로 남는다.

조사 결과 게이트웨이를 주기적으로 깨우는 외부 요인은 없다. Cloud Scheduler 작업이
없고, Cloud Monitoring 업타임 체크가 0개이며, `webapp/vercel.json`에 cron이 없고,
웹앱 코드에 게이트웨이 헬스 핑이 없다. `minScale: 1`이 유일한 원인이다.

## 목표

라이브콜이 실제로 진행 중일 때만 게이트웨이 인스턴스가 살아 있고, 그 외 시간에는
인스턴스 수가 0으로 내려가 과금되지 않는다.

명시적 비목표: 게이트웨이를 Cloud Run 밖으로 이전하지 않는다. Gemini API 비용은
이 작업의 범위가 아니다(번역 엔진 자체의 비용이며 게이트웨이 배관과 무관하다).

## 수용 기준

1. 서비스와 트래픽이 참조하는 모든 리비전의 최소 인스턴스가 0이고, 라이브 세션을
   종료한 뒤 열린 요청이 없어 인스턴스 수가 0으로 내려간다.
2. 참가자 뷰어 탭을 열어둔 채 세션이 `preparing` 상태로 남아 있어도 인스턴스 수가
   0을 유지한다.
3. 호스트가 go-live를 눌렀을 때 콜드 스타트가 있더라도 라이브 시작이 실패하지
   않는다.

## 설계

```mermaid
flowchart LR
    A["평상시<br/>인스턴스 0개"] --> B["호스트가 라이브 시작"]
    B --> C["헬스 요청 워밍업"]
    C --> D["Cloud Run 기동"]
    D --> E["호스트 WebSocket 연결"]
    E --> F["참여자는 live/paused에서만 연결"]
    F --> G["호스트가 종료"]
    G --> H["인증된 stop 전송"]
    H --> I["파이프라인·Gemini 해제"]
    I --> J["세션 종료 broadcast + 소켓 close"]
    J --> K["열린 요청 0 → 유휴 대기"]
    K --> A
```

### 1. Cloud Run 설정 변경

```bash
gcloud run services update SERVICE \
  --region REGION \
  --cpu-throttling \
  --min 0 \
  --max 1 \
  --concurrency 256 \
  --timeout 3600 \
  --cpu-boost
```

`maxScale: 1`, `containerConcurrency: 256`, `timeoutSeconds: 3600`으로 고정한다.
게이트웨이 세션 fanout이 프로세스 메모리에 있으므로 다중 인스턴스 확장은 이 작업의
범위가 아니다. concurrency 256은 HOST 1명, VIEWER 최대 200명, 짧은 재연결 중첩과
상태 점검 여유를 한 인스턴스에 수용하는 승인 계약이다.

`startup-cpu-boost: true`도 반드시 유지한다. 지금까지는 의미가 없었지만
`minScale: 0` 이후에는 콜드 스타트 시간을 줄이는 역할을 한다.

이 변경은 코드가 아니라 배포 환경의 상태이므로, `media-gateway/README.md`에
"`minScale`은 0이어야 하며 1로 올리면 상시 과금된다"는 근거와 함께 기록한다.
README가 배포 조건을 서술하는 유일한 문서이기 때문이다.

서비스 수준 `min=0`만 확인해서는 부족하다. 트래픽 태그가 과거 `minScale=1`
리비전을 가리키면 그 리비전은 계속 최소 인스턴스를 유지할 수 있다. 배포 후에는
100% 트래픽과 모든 보존 태그가 건강한 `minScale=0` 리비전을 참조하는지 확인한다.

2026-08-15 실행에서는 서비스 수준 `min=0` 적용에 성공했지만, 기존 이미지의 새
인스턴스가 Cloud Run의 `PORT=8080` startup health check를 통과하지 못했다. 동일
이미지·동일 사양의 `minScale=0` 리비전도 cold start에서 같은 결과가 재현됐다.
가용성을 위해 100% 트래픽과 기존 tag는 건강한 과거 `minScale=1` 리비전으로
되돌렸다. 따라서 비용 차단 완료 조건은 아직 충족되지 않았으며, 아래 코드 배포 승인
후 새 이미지의 cold start와 `minScale=0` 트래픽 전환을 다시 검증해야 한다.

2026-08-15 심야 재실행에서 위 startup 실패의 원인을 격리했다. 결론: 앱·이미지·설정
문제가 아니라 `studied-sled-460400-u2` **프로젝트에 국한된 Cloud Run 인스턴스 기동
불가**(구글 플랫폼 측 결함)다. 근거는 전부 재현 실험이다.

- 새 이미지(scale-to-zero 코드 포함, 빌드 `cfda8439`)뿐 아니라 **트리비얼
  `node -e` HTTP 서버**, **구글 공식 hello 컨테이너**(신규 서비스)도 동일하게
  실패한다. Secret env를 전부 제거해도, `gen2`로 바꿔도, 도쿄(asia-northeast1)
  리전에서도 실패한다.
- 실패 시그니처: `Starting new instance` 이후 4분간 컨테이너 stdout/stderr 0줄,
  TCP probe 실패 시스템 로그조차 없음 → HealthCheckContainerError. 컨테이너
  프로세스가 실행조차 되지 않는다.
- 같은 계정의 **다른 프로젝트**(gen-lang-client-0321430669)에서는 같은 서울
  리전에 hello가 정상 배포·기동됐다. 빌링 정상, org policy·binauthz 없음, 쿼터
  정상, `run.serviceAgent` IAM 정상, 공개·개인화 장애 공지 없음.
- 운영 리비전 `dual-path-0730`(minScale=1)의 인스턴스도 이미 죽어 있었다.
  `minScale=1`은 상시 생존을 보장하지 않고 플랫폼이 주기적으로 재활용하는데
  (8/9·8/11 재시작 확인), 재활용 기동이 이 결함에 걸리면 그대로 다운된다. 지난
  7일간 요청이 0건이라 아무도 몰랐다. **즉 게이트웨이는 이 작업과 무관하게 이미
  다운 상태였다.**
- 진단 중 서비스 템플릿에 남은 command 오버라이드·secrets 제거·gen2는 원상 복구
  배포로 되돌렸고(`scale0-0815` 태그 리비전), 진단용 probe 서비스들은 삭제했다.

플랫폼이 복구되는 즉시 남은 절차: `scale0-0815` 리비전 ready 확인 → 100% 트래픽
전환 → `minScale=1` 리비전을 가리키는 구식 태그 제거 → 웹앱(뷰어 게이트) Vercel
배포 → 인스턴스 0 수렴 검증.

2026-08-16 새벽 실행: `studied-sled` 결함이 수 시간 지속됐고 그 사이 서울 서비스가
삭제됐기 때문에(도쿄 이설 시도 흔적 포함), **게이트웨이를 Cloud Run이 정상 동작하는
같은 계정의 `gen-lang-client-0321430669` 프로젝트로 이설해 완료**했다.

- 새 프로젝트에 AR repo·SA(`realtime-noel-gateway@gen-lang-...`)·최소 IAM 3종
  (secretAccessor, serviceUsageConsumer, speech.client)·secret 5종(바이트 동일
  복제)을 만들고, 같은 Dockerfile로 이미지를 빌드해 배포했다. 첫 리비전이 즉시
  ready — studied-sled 결함이 프로젝트 국한임을 최종 확인.
- 서비스 구성: `min=0, max=1, concurrency=256, timeout=3600, cpu-boost,
  cpu-throttling(request-based), gen1`. 새 URL
  `https://realtime-noel-media-gateway-1020335991043.asia-northeast3.run.app`.
  `/health` 200 + `Cache-Control: no-store`, `/metrics` 무인증 404 확인.
- env는 `GOOGLE_CLOUD_PROJECT`/`LIVE_ALLOWED_GCP_PROJECT`만
  `gen-lang-client-0321430669`로 바뀌고 나머지는 동일(감사 로그에서 복원).
- 웹앱: Vercel `NEXT_PUBLIC_LIVE_GATEWAY_URL`을 새 URL로 교체하고 프로덕션
  재배포(뷰어 live/paused 게이트 포함). 이 과정에서 웹앱이 리포 루트의
  `packages/*`를 import하게 된 것에 맞춰 Vercel 프로젝트 `rootDirectory=webapp`
  설정 + 리포 루트에서 배포하는 방식으로 전환했고, `next.config.mjs`의
  `outputFileTracingRoot`를 리포 루트로 올렸다(함수 트레이스에 packages 포함).
  **이후 웹앱 배포는 리포 루트에서 `vercel deploy --prod`로 실행해야 한다.**
- 데스크톱은 `/api/live-config`에서 게이트웨이 URL을 받으므로 코드 변경 없이 새
  게이트웨이를 따라간다(워밍업·20초 타임아웃은 이미 워킹트리에 구현됨).
- 남은 것: studied-sled 쪽 잔해(재생성했지만 ready가 아닌 서울 서비스, 도쿄 빈
  서비스) 정리 여부와 구글 지원 케이스 제출 여부는 사용자 결정
  (`2026-08-15-gcp-support-case-draft.md` 참고).

### 2. 데스크톱 — 콜드 스타트 흡수

`minScale: 0`에서는 첫 연결에 컨테이너 부팅, `@google/genai`와
`@google-cloud/speech` 모듈 로딩, `SpeechClient` ADC 초기화가 끼어든다.

**워밍업.** 호스트가 라이브를 시작할 때, 게이트웨이 WebSocket을 열기 전에
게이트웨이 `/health`로 GET 요청을 한 번 보내 인스턴스를 깨운다. `/health`는 인증이
필요 없고 오디오·자막·토큰을 담지 않으며 `Cache-Control: no-store`를 반환한다.
게이트웨이 URL은 이미 `fetchGatewayConnection`이 `/api/live-config`에서 받아오므로
새로운 설정 값이 필요 없다.

워밍업 실패는 라이브 시작을 막지 않는다. 인스턴스가 이미 떠 있거나 네트워크가
잠시 흔들린 경우까지 go-live를 실패시킬 이유가 없고, 아래 타임아웃 상향이 안전망
역할을 한다.

**타임아웃 상향.** 콜드 스타트를 견디지 못하는 두 지점을 올린다.

| 위치 | 현재 | 이유 |
| --- | --- | --- |
| `electron/main.js` `hostSpeakViaGateway` 소켓 오픈 | 3,000 ms | 새 소켓을 여는 경로라 콜드 스타트를 직접 맞는다 |
| `electron/main.js` 번역 재시작 경로 | 10,000 ms | 재시작 시 인스턴스가 이미 내려가 있을 수 있다 |

기본값으로 두 지점 모두 20,000 ms를 적용한다. 구현 단계에서 `minScale: 0` 상태의
실제 콜드 스타트를 측정해, 측정값의 3배가 20초를 넘으면 그때 다시 올린다. 이
타임아웃은 실패를 감지하는 상한일 뿐 정상 경로의 지연이 아니므로, 넉넉하게 잡는
쪽의 비용이 낮다.

`ensureLiveGatewayBridge`의 기존 재연결 백오프는 그대로 둔다. 이미
`armedSession.status !== "live"`일 때 재연결하지 않도록 게이트되어 있어
(`electron/main.js:1522`, `electron/main.js:1899`) 세션이 끝나면 게이트웨이를
두드리지 않는다.

### 3. 웹앱 뷰어 — 라이브일 때만 게이트웨이에 연결

현재 뷰어는 세션이 `stopped`가 아니고 종료되지 않았으면 게이트웨이 WebSocket을
연다. 즉 호스트가 세션만 만들어두고 아직 시작하지 않은 `preparing` 상태에서도
붙는다. 재연결 백오프 상한은 30초이고 (`connection-resilience.ts`
`RECONNECT_MAX_MILLISECONDS`) 횟수 제한이 없다.

결과적으로 참가자가 대기 화면 탭을 열어둔 것만으로 30초마다 요청이 들어가
인스턴스의 유휴 타이머가 계속 리셋된다. 이 상태로는 `minScale: 0`으로 내려도
과금이 그대로 남을 수 있다.

**변경.** 게이트웨이 연결 조건을 `sessionStatus`가 `live` 또는 `paused`일 때로
좁힌다. `paused`를 포함하는 이유는 호스트의 일시 정지가 짧은 중단이며 여기서
연결을 끊으면 재개할 때마다 콜드 스타트를 다시 맞기 때문이다.

게이트는 모든 `subscribe` 호출을 소유하는 단일 lifecycle effect에 둔다. 세션 복구,
참가, 언어 변경, 포그라운드 복구가 직접 연결하지 않게 해 한 곳을 빠뜨렸을 때 생기는
비용 누수를 막는다. 모든 재연결 예약은 웹앱 상태 API에서 `live` 또는 `paused`를
다시 확인한 뒤에만 실행한다. 상태 조회 실패는 fail-closed로 다음 Vercel 폴링을
기다리고 Cloud Run을 깨우지 않는다.

`preparing` 상태에서는 게이트웨이를 건드리지 않고 기존 세션 상태 폴링만 돈다. 이
폴링은 웹앱 API(Vercel/Supabase)를 향하므로 게이트웨이를 깨우지 않는다. 폴링 주기가
`preparing`일 때 2.5초로 이미 짧아, 상태가 `live`로 바뀌면 그 안에 감지된다.
`sessionStatus`가 `live`로 전이할 때 `subscribe`를 실행하는 효과를 추가한다.

**받아들인 트레이드오프.** 미리 입장해 대기 중이던 참가자는 go-live 직후 곧바로
자막을 받지 못하고, 상태 폴링(최대 2.5초) + 연결 시간만큼 늦게 받는다. 호스트
워밍업 덕에 이 시점에는 인스턴스가 이미 떠 있으므로 콜드 스타트는 겹치지 않는다.
비용을 우선한 의도적 선택이다.

### 4. 명시적 종료 수렴

웹 호스트는 오디오 drain을 확인한 뒤 인증된 `stop`을 전송한다. 게이트웨이는 해당
세션의 파이프라인, 주제 처리, Gemini 자원을 먼저 해제하고, 참여자에게 `stopped`
상태를 broadcast한 다음 호스트와 참여자 WebSocket을 정상 종료한다. 명시적 stop에는
예상치 못한 네트워크 단절용 grace 시간을 적용하지 않는다. 마지막 열린 요청이
사라진 뒤 Cloud Run의 유휴 scale-to-zero가 시작된다.

### 5. 검증

1. 세션을 한 번 진행하고 종료한 뒤, Cloud Run 인스턴스 수 메트릭이 0으로 내려가는
   것을 확인한다.
2. 참가자 뷰어를 `preparing` 세션에 붙여둔 채 인스턴스 수가 0을 유지하는지 확인한다.
3. go-live에서 첫 자막까지 실패 없이 도달하는지 확인한다.

## 테스트

TDD로 진행한다. 실패하는 테스트를 먼저 쓴다.

데스크톱 테스트는 `electron/main.js`를 `node:test`에서 import할 수 없어 소스를
텍스트로 읽어 정규식으로 검사하거나 `node:vm`으로 함수를 잘라내 평가하는 방식을
쓴다. 이 저장소의 기존 관행(`test/desktop-live-start.test.js`,
`test/desktop-stage-window.test.js`)을 그대로 따른다.

- 루트 스위트: 라이브 시작 경로가 게이트웨이 소켓을 열기 전에 `/health` 워밍업을
  수행하는지, 워밍업 실패가 go-live를 막지 않는지, 상향된 타임아웃 값이 소스에
  존재하는지.
- webapp `test:live`: `preparing`에서 연결하지 않고 `live`/`paused`에서만 연결하며,
  종료 broadcast 유실·느린 소비자 close·포그라운드 복귀에서도 상태 확인 전 재연결이
  없는지.
- media-gateway: 인증된 stop이 파이프라인·Gemini 해제 → stopped broadcast → 모든
  socket close 순서로 수렴하고, `/health`는 정확한 GET 경로만 허용하는지.

세 스위트는 각각 별도 프로젝트이므로 `npm test`(루트),
`npm --prefix webapp run test:live`, `npm --prefix media-gateway test`를 각각 돌린다.

## 변경 대상

| 파일 | 변경 |
| --- | --- |
| Cloud Run 서비스 설정 | request-based billing, service/revision `min=0`, `max=1` (코드 아님) |
| `media-gateway/README.md` | `minScale: 0` 요구사항과 근거 기록 |
| `electron/main.js` | go-live 전 `/health` 워밍업, 3초·10초 타임아웃 상향 |
| `webapp/components/live/LiveViewer.tsx` | 단일 `live`/`paused` 연결 게이트와 terminal 재연결 차단 |
| `webapp/components/live/live-audio-client.ts` | drain 후 인증 stop, bounded ack, 로컬 자원 정리 |
| `media-gateway/src/gateway-server.js` | stop 자원 해제·종료 broadcast·socket close, 엄격한 health GET |
| `test/` | 데스크톱 워밍업·타임아웃 계약 테스트 |
| `webapp/components/live/*.test.ts` | 뷰어 연결 게이트 테스트 |

webapp 테스트 파일을 새로 만들 경우 `webapp/package.json`의 `test:live` 스크립트에
파일명을 반드시 추가한다. 루트 스위트의 `test/webapp-test-coverage.test.js`가 이를
검사하며, 등록하지 않으면 테스트가 조용히 실행되지 않는다.
