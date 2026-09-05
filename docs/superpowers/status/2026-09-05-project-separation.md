# NOVA / Realtime Noel Canvas 프로젝트 분리

2026-09-05 사용자 요청에 따라 폴더·실행 명령·서버·설정·Git 저장소를 분리했다.

| 항목 | NOVA | Realtime Noel Canvas |
|---|---|---|
| 폴더 | `/Users/kyeongmankim/Realtime/autopreso` | `/Users/kyeongmankim/Realtime/realtime-noel-canvas` |
| Git | 기존 독립 `.git` 유지 | 별도 `.git`, 기존 이력 복제, 원격 미설정 |
| 기능 | 자막·Live Call·설정 | Excalidraw 캔버스·에이전트·STT |
| 기본 로컬 주소 | `http://127.0.0.1:3317` | `http://127.0.0.1:3319` |
| 실행 | `npm run dev -- --no-open` | `npm run dev -- --no-open` |
| 진입점 | `src/nova-cli.js` | `src/cli.js` |
| 설정 | `~/.config/nova/` | `~/.config/realtime-noel/` |

두 저장소는 각각 의존성을 설치하며 상대 폴더나 상대 node_modules를 심볼릭 링크로 참조하지 않는다. Git 객체도 공유 하드링크 없이 복제했다. NOVA 원격 주소는 보존했고 Canvas에는 origin을 남기지 않았다. 새 GitHub 저장소 생성·연결·push·commit·운영 배포는 하지 않았다. 각 저장소의 분리 변경은 검토 가능한 미커밋 상태다.

## 실제 분리 내용

- NOVA 서버에서 캔버스 상태·음성 인식 관리자·에이전트 프롬프트·도구·HTTP/WS 처리를 제거했다. 시작에 Canvas API 키나 로컬 모델이 필요하지 않다.
- NOVA `/`, `/index.html`, `/subtitle`, `/subtitle.html`은 모두 자막 화면을 제공한다. `/app.js`와 캔버스 정적 파일, 사용하지 않는 Coach/Interpreter 화면은 404다.
- Canvas 서버에서 자막 관리자·자막 API/WS·기록·용어집·polish 연결을 제거했다. Canvas에는 NOVA webapp/media-gateway/Supabase/Electron 제품 트리가 없다.
- Canvas 설정에서 자막/용어집/Gemini·Soniox 연결 설정을 제외했고, NOVA 설정에서 Canvas 에이전트/Codex 인증 탐색을 제거했다.
- Moonshine 빌드와 기존 로컬 macOS arm64 바이너리를 Canvas 쪽으로 옮겼다. NOVA 패키지의 Moonshine 의존/빌드/릴리스 작업을 제거했다.
- NOVA의 기존 macOS appId는 권한·앱 정체성의 불필요한 초기화를 피하기 위해 보존했다. 이것이 설정 공유나 Git 공유를 의미하지 않는다.
- npm 배포 대상 `nova` 소유권이 확인되지 않았으므로 기존 자동 npm publish는 제거하고 검증 아티팩트 생성으로 바꿨다. 생성된 릴리스 버전 이력 파일은 보존했다.

## 기존 데이터 보존

NOVA 최초 실행 시 `nova-config.js`가 기존 공유 위치에서 NOVA 설정 필드와 형식이 확인된 자막 기록만 가져온다. 해당 기록의 mic/system WAV·PCM도 스트리밍으로 복사한다. 일반 Canvas JSON, 관련 없는 오디오, 심볼릭 링크는 가져오지 않는다.

대상 파일이 있으면 덮어쓰지 않는다. 오디오는 임시 파일 완성 후 배타적으로 노출하고 파일 권한은 0600이다. 완료 표식으로 사용자가 NOVA에서 삭제한 기록이 매 실행마다 다시 복원되는 것을 방지한다. 원래 공유 설정·기록은 삭제하거나 변경하지 않는다.

원본 정리 시 삭제 대상은 Canvas 사본 또는
`/Users/kyeongmankim/Realtime/.separation-backup-2026-09-05`에 보존했다. 이 백업은 실행 의존성이 아니다. 문제 발생 시 백업과 Git diff로 해당 파일만 복원할 수 있으며, 기존 작업 전체를 reset하면 안 된다.

## 검수 결과

- NOVA 루트 테스트: **1,489 통과 / 16 건너뜀 / 0 실패**.
- Canvas 테스트: **211 통과 / 0 건너뜀 / 0 실패**. 캔버스 브라우저 렌더링 검사 포함.
- 두 저장소 타입 검사와 `git diff --check` 통과.
- Canvas 테스트를 독립 저장소로 옮겼으므로 이전 NOVA 단일 테스트 개수와 직접 비교하지 않는다. 캡션 보안·기록·설정 및 혼합 파일의 캡션 테스트는 유지했다.

| 적대적 시나리오 | 결과 |
|---|---|
| NOVA에서 Canvas 경로/프로토콜 접근 | Canvas 정적 파일 404, agent/transcription 초기화 없음 |
| Canvas에서 자막 경로/프로토콜 접근 | 자막 경로/API 404, 자막 제공자 초기화 및 시작 불가 |
| 원본 설정 변경으로 다른 제품 설정 덮어쓰기 | 독립 경로, 최초 이관 이후 서로 저장하지 않음 |
| 이관 대상 기존 파일·연속 이관·관련 없는 파일 | 기존 파일 보존, 완료 표식, 기록/오디오 형식 필터 테스트 통과 |
| 관리자·Stage·시스템 언어 IPC 권한 우회 | 기존 정확한 origin·발신자·소유자 검증 유지, 관련 회귀 통과 |
| 동시에 두 제품 실행 | 3317 NOVA / 3319 Canvas 브라우저 및 HTTP 확인 |

실제 HTTP 확인: NOVA 루트와 `/subtitle`은 200이며 캔버스 코드가 없고,
Canvas 루트는 200이며 `/subtitle`, `/subtitle.html`, `/api/subtitle-languages`는 404다.
화면 증거는 `output/2026-09-05-project-separation/`에 저장했다.

Canvas 시작 시 옮긴 Moonshine medium 모델의 준비 완료를 확인했다. 실제 마이크 캡처와 유료 에이전트 추론을 시작하지 않았다. NOVA 음성 제공자 호출과 운영 웹 인증은 이번 분리 검증에서 수행하지 않았다.

## 이후 사용

NOVA 작업은 `autopreso`, 캔버스 작업은 `realtime-noel-canvas`를 각각 프로젝트로 열어 진행한다. Canvas를 원격에 올리려면 별도 GitHub 저장소를 정한 뒤 그 저장소의 origin만 연결해야 한다. 기존 NOVA 원격에 Canvas 변경을 push하지 않는다.
