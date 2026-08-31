# 전체 재빌드 및 운영 배포 보고

2026-08-31 KST. 사용자의 “완료되면 전체 재빌드하고 배포해줘” 요청을 명시적 배포 승인으로 적용했다. 원본 작업 트리의 기존 변경과 환경설정을 보존하고, 새 빌드를 검증한 뒤 운영 주소를 전환했다.

## 배포 결과

| 대상 | 결과 |
|---|---|
| 웹 | `https://realtime-noel-web.vercel.app` → `dpl_93Dd71otFd5vuPtqaMWq5gezc4aj`, READY |
| 웹 빌드 URL | `https://realtime-noel-dbtnu1w9w-kyeokim1234-7484s-projects.vercel.app` |
| Cloud Build | `ca36ad2c-1558-4578-aace-3cf19bcaf30e`, SUCCESS |
| 게이트웨이 | `gen-lang-client-0321430669 / asia-northeast3 / realtime-noel-media-gateway` |
| 운영 리비전 | `realtime-noel-media-gateway-full-20260831`, 단일 리비전 트래픽 100% |
| 이미지 | `sha256:7c6c19431a0f85d0faaaafa3178d6e0537506dd055fa4a2c1516f9086d56a311` |
| Supabase | `qahzljufcqbzwkdweeji`에 `202608310005_live_canonical_source_snapshots.sql` 적용 |
| Mac 앱 | ARM64 0.2.3 재빌드, `/Applications/NOVA.app` 교체 및 정상 실행 확인 |
| 설치 파일 | `dist/releases/2026-08-31-full/NOVA-0.2.3-arm64.dmg` |

## 실행 순서와 안전 조치

1. 전체 테스트, 타입 검사, 세 프로젝트 취약점 검사와 독립 Design/Security/Gateway/Schema 검토를 실행했다.
2. 기존 운영 웹·게이트웨이 버전을 기록했다. Vercel은 production 환경의 서버 빌드를 수행하되 처음에는 공개 주소를 승격하지 않았다. 민감 환경변수를 로컬에 복호화하거나 재생성하지 않았다.
3. Cloud Build에 허용된 64개 소스만 업로드했다. 환경 파일·자격 증명·node_modules는 제외했다. 새 리비전은 먼저 트래픽 0%로 생성했다.
4. CLI 연결 대상이 올바른 Supabase 프로젝트임을 확인했고 dry-run에서 미적용 migration이 005 하나뿐임을 확인했다. nullable 컬럼과 새 RPC를 추가했으며 기존 row 백필·삭제, 기존 writer 제거는 없다.
5. migration 적용 뒤 컬럼·constraint·RLS·RPC 실행 권한을 검증했다. 기존 회의 68건 유지, 적용 전후 활성 회의 0건이었다. anon/authenticated의 새 RPC 실행은 금지되고 service_role만 사용한다. 내부 관측값 validator는 service_role에도 직접 실행을 허용하지 않는다.
6. 게이트웨이 100% 전환 후 health 검사를 통과한 다음 Vercel 빌드를 운영 주소로 승격했다. 현재 주소가 새 deployment ID를 가리키는 것을 다시 확인했다.
7. 실행 중인 NOVA가 없음을 두 번 확인하고, 검증된 앱을 임시 경로에 복사·서명 검사한 뒤 기존 앱을 백업하고 교체했다. 앱 외부의 로그인·설정·언어 파일은 수정하지 않았다. 이후 표준 앱 실행으로 기동을 확인했다.

## 재빌드·검증 근거

| 검사 | 결과 |
|---|---|
| 루트 테스트 | 1,356 PASS, 기존 환경 조건 4 skip |
| 게이트웨이 테스트 | 512 PASS |
| 웹 live/core 테스트 | 741 + 77 PASS |
| 전체 합계 | 2,686 PASS, 실패 0 |
| 루트·웹 타입 검사 | PASS |
| npm audit | root/webapp/media-gateway 모두 취약점 0 |
| 형식 검사 | `git diff --check` PASS |
| Vercel 빌드 | 캐시 없이 서버 재빌드 성공, READY |
| 컨테이너 빌드 | Node 24 컨테이너 빌드·업로드 성공 |
| 소스 일치 | 격리 릴리스 사본과 원본 2,896개 파일 해시 일치 |
| Electron ASAR | 소스 109개 해시 일치, 필수 파일 누락 0 |
| Mac 산출물 | DMG 무결성 및 `codesign --verify --deep --strict` 통과 |
| 앱 실행 | NOVA 프로세스 1개, 내장 `/subtitle.html`·`/system-language.js` HTTP 200 |

별도 lint script가 없는 프로젝트이므로 lint 통과로 보고하지 않는다. 빌드 시 기존 engines 범위 경고와 MODULE_TYPELESS 테스트 경고는 남아 있으며 검사 실패는 아니다. 이번 배포를 위해 프로젝트 버전이나 릴리스 자동화 메타데이터를 임의로 변경하지 않았다.

## 운영 사후 검사

- 게이트웨이 `GET /health` → 200/ok/no-store. `POST /health` 및 무인증 `/metrics` → 404.
- Cloud Run 스케일 안전 검사 11/11 PASS. 최소 0·최대 1, 요청 기반 CPU, 시작 CPU boost, 동시 요청 256, 제한 3600초, 1 CPU/1 GiB 유지. traffic tag 없음.
- 이전 리비전 대비 모든 환경변수 항목·런타임 서비스 계정·허용 Origin·5개 비밀 참조가 동일했다. 로컬의 이전 GCP 기본 프로젝트를 사용하지 않고 모든 명령에서 현재 프로젝트를 명시했다.
- 웹 `/login`, `/watch` → 200. `/admin`, `/records`, `/records/demo` → 로그인으로 307 이동. `/api/live-config`, `/api/live-records` → 401 AUTH_REQUIRED.
- 위장 Origin을 넣은 로그인 POST는 403 INVALID_ORIGIN으로 차단됐다. 검사 경로에 `frame-ancestors 'self'` 유지.
- 실제 운영 브라우저에서 한국어→English→日本語 전환을 확인했다. 일본어 상태로 참여 페이지 이동 후 문구 유지도 확인하고 한국어로 복귀했다.
- 점검 시점의 새 Vercel 배포 error 로그 0건, 새 Cloud Run 리비전 ERROR 이상 로그 0건. 짧은 점검이며 로그 인입 지연이나 장시간 통화 안정성을 보장하지 않는다.
- 확대 QR·정상 코드 자동 입력·잘못된 QR 거절·만료 숨김은 직전 로컬 브라우저/ReactDOM 검사로 확인한 동일 소스가 배포됐다. 운영 계정으로 테스트 회의를 만들거나 실제 음성/API 호출을 생성하지 않았다.

## Mac 설치 파일과 보안 제한

- DMG SHA256: `31092b82ee2024a1e540c59ea2e2da5e2015d10a0fd6d845c52e9e4e5bbbe600`.
- 설치 ASAR SHA256: `008439688619ded1a957d5a555af71dc3bf1ea99ba02c4ae9a166b0a3eb4514a`.
- 기존 ad-hoc 서명 정책을 유지했다. Developer ID 공증은 하지 않았고 `spctl` 검사는 거부된다. 현재 Mac에서는 표준 앱 실행에 성공했지만, 다른 Mac 배포나 macOS의 마이크/화면 권한 재승인을 보장하지 않는다. Gatekeeper/TCC 설정 변경과 quarantine 제거는 하지 않았다.
- 현재 사용하는 macOS ARM64 빌드를 생성했다. Intel용 로컬 음성 sidecar가 없으므로 Intel·Windows의 동등 기능 빌드/배포 완료를 주장하지 않는다. DMG 원격 게시나 npm/GitHub release 생성은 하지 않았다.

## 유지된 제한과 복구

- 검증되지 않은 3.5 Live Translate 단독 경로를 활성화하지 않았다. 앞선 보고서의 안정적인 원문/확정 번역 분리를 유지한다.
- `LIVE_PARTICIPANT_DEMAND_ENABLED`는 기존 미설정/기본 false 상태를 유지했다. 이번 배포를 참여자 0명 시 모든 API 호출이 0임을 보장하는 근거로 사용하면 안 된다. 원문 기록 목적의 API 사용과 무인 유휴 비용은 다른 조건이다.
- 실제 두 물리 기기의 QR 스캔·마이크·장시간 회의·종료 후 6시간 전체 시나리오는 이번 운영 점검에서 실행하지 않았다.
- 웹 복구 대상: `dpl_G1bJdTyjBxeJU8jjkHLec7jg92aE`.
- 게이트웨이 복구 대상: `realtime-noel-media-gateway-perf-20260831`, 이미지 `sha256:6db1079d26673d9cc1f6b11a1a054c43243a88e9ca6d55beaeef8a73c8632c09`.
- Mac 이전 앱: `/Applications/.NOVA-backup-20260831.app`. 실행을 종료한 뒤 백업 bundle로 복구할 수 있다. 사용자 설정은 앱 bundle 밖에 보존했다.
- 문제가 발생하면 앱/게이트웨이 버전을 되돌리고 추가 스키마와 고객 기록은 유지한다. Git push, 강제 reset, DB 삭제, 이메일 발송은 수행하지 않았다.

빌드·검사 로그는 `/tmp/nova-full-release-*`, Mac 무결성/설치 기록은 `dist/releases/2026-08-31-full/`에 보관했다.
