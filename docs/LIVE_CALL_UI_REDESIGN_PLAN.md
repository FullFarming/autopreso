# Live Call UI Redesign Plan

Date: 2026-07-26
Status: Implementation complete; production deployment approved
Design authority: `DESIGN.md` (Toss/TDS structure, NOVA tokens)

## Clarification Summary

- 목적: Live Call의 Electron·스테이지·모바일 기록 화면을 하나의 제품처럼 보이게 하고, 자막을 핵심 콘텐츠로 유지한다.
- 포함: Electron 자막/Live Call/기록/설정, 웹 참여/대기/실시간/종료 기록, 16:9 QR 스테이지.
- 제외: 번역 파이프라인·음성 인식 정책 변경, 배포, 기존 기록 삭제.
- 사용자/권한: Electron 호스트와 웹 참여자의 기존 권한을 유지한다. 디자인 변경으로 권한 범위를 넓히지 않는다.
- 데이터: 기존 참여자 API를 우선 재사용한다. Electron 기록의 참여자 탭에는 종료 시점 참여자 스냅샷을 선택적 메타데이터로 저장한다. DB 스키마 변경은 우선 전제하지 않는다.
- 정상 흐름: 호스트가 16:9 커버와 일정을 등록하고 스테이지를 연다 → 참여자 프로필이 왼쪽부터 쌓인다 → 양방향 자막이 이어진다 → 종료 후 요약/원문/참여자를 탭으로 확인한다.
- 실패 흐름 A: 커버 로딩 실패 시 검정 기본 배경과 동일한 QR 대비를 유지한다.
- 실패 흐름 B: 요약 생성 실패 시 원문과 참여자 탭은 계속 사용할 수 있고 요약 탭에서만 재시도한다.
- 외부 호출: 기존 Live Call/Supabase API만 사용한다. 새 외부 서비스는 추가하지 않는다.
- 성공 기준: 중복 종료 문구 0개, 자막 페이지의 Topics/확정 자막 패널 0개, 탭 전환 재요청 0회, 16:9 커버 크롭 안정, 참여자 표시와 종료 기록 일치, 키보드·모바일·reduced-motion 검증 통과.
- 롤백: UI와 선택적 참여자 메타만 단일 기능 커밋으로 되돌린다. 기존 기록 데이터와 캡션 수집 로직은 삭제하지 않는다.

## Approved Mockups

| Surface | Approved variant | Decision |
|---|---|---|
| Electron record detail | A | 상단 `요약 / 원문 / 참여자`, 한 패널만 노출 |
| 16:9 QR stage | B | 왼쪽 세션 정보, 오른쪽 QR |
| Mobile ended record | A | 상단 `요약 / 원문` 탭 |

Additional decisions:

- 스테이지는 실제 로딩 중에만 로딩 모션을 표시한다.
- 예정 시작 시간이 있으면 남은 시간을 `HH:MM:SS` 또는 `MM:SS`로 표시하고 원형 진행 모션을 함께 사용한다.
- 예정 시간이 없으면 가짜 카운트다운을 만들지 않는다.
- `END`는 종료 후에만 나타난다. 기존 `--nova-status-error`/`--nova-status-live` 계열의 단일 시맨틱 레드를 사용하고, opacity만 천천히 변화시키는 은은한 모션을 적용한다.
- `prefers-reduced-motion`에서는 로딩을 제외한 장식 모션과 END 점멸을 정지한다.

Design board:
`/Users/kyeongmankim/.gstack/projects/FullFarming-autopreso/designs/live-call-records-redesign-20260726/design-board.html`

## Architecture Decision

1. `DESIGN.md`를 유일한 디자인 기준으로 유지한다. Electron과 webapp의 중복된 색상 체계는 NOVA 역할 토큰으로 수렴시킨다.
2. 화면 유형과 언어 선택을 분리한다.
   - 1차 탭: `요약 / 원문 / 참여자`
   - 2차 선택: 원문 탭 내부의 `EN / KO`
3. 탭 전환은 이미 받은 데이터를 로컬 상태에서 전환한다. 탭을 바꿀 때 네트워크를 다시 호출하지 않는다.
4. Topics와 확정 자막 UI만 숨기고 기록 수집 데이터는 유지한다. Records가 유일한 기록 열람 진입점이다.
5. 참여자 표시는 기존 안정적 speaker id 색상과 이니셜을 사용한다. 최대 5개를 보이고 나머지는 `+N`으로 합친다.
6. 스테이지 커버는 16:9 업로드 미리보기와 `object-fit: cover; object-position: center`를 기본으로 한다. QR 영역에는 고정 scrim을 두어 이미지 종류와 관계없이 대비를 보장한다.
7. 종료 UI는 한 번만 상태를 알린다. 헤더의 `END` 외에 `Live session ended`, `The meeting has ended` 같은 중복 설명을 제거한다.

## Seven-pass Design Review

### 1. Information architecture

- Captions: 설정과 실행만 남긴다. Topics와 확정 자막 로그는 제거한다.
- Live Call: `세션 정보 / 일정 / 언어 / 입장`의 다섯 카드식 나열을 줄이고, 기본 정보와 참여 설정의 두 그룹으로 정리한다. 등록된 세션은 생성 폼 아래의 별도 목록으로 둔다.
- Records: 달력은 탐색, 상세는 소비라는 역할을 분리한다. 상세는 승인된 세 탭을 사용한다.
- Settings: 일반 설정과 고급 엔진/키 설정을 분리하고 고급 영역은 기본적으로 닫는다.
- Viewer: 실시간에는 자막만 주인공으로, 종료 후에는 기록 소비만 주인공으로 둔다.

### 2. State coverage

| Surface | Loading | Empty | Error | Success/partial |
|---|---|---|---|---|
| Stage cover | 실제 이미지 decode 중 skeleton | 검정 기본 배경 | 검정 배경으로 복구 | 16:9 cover + scrim |
| Countdown | 예정 시간이 있을 때만 ring | 예정 없음: `Waiting` | 잘못된 시간: countdown 숨김 | 초 단위, tabular numerals |
| Avatar stack | 참가자 갱신 시 레이아웃 고정 | `0 joined` | 마지막 정상 목록 유지 | 5개 + `+N` |
| Summary | 패널형 skeleton | 요약 준비 중 | 해당 탭 안에서 재시도 | 기존 요약 유지 후 교체 |
| Transcript | 첫 로드 skeleton | 기록 없음 | 원문 탭 안에서 안내 | EN/KO 즉시 전환 |
| Participants | 첫 로드 skeleton | 참여자 없음 | 마지막 스냅샷 유지 | 참석/퇴장 상태 표시 |

### 3. Journey and emotional arc

1. 생성: 입력해야 할 항목이 적고 다음 행동이 즉시 보인다.
2. 대기: 커버와 카운트다운으로 시작 시점을 확신한다.
3. 입장: 자신이 참가했는지 프로필 스택으로 확인한다.
4. 실시간: 컨트롤보다 자막에 시선이 머문다.
5. 종료: `END`를 한 번 확인하고 요약 또는 원문으로 바로 이동한다.
6. 회고: 누가 참여했는지 별도 탭에서 확인한다.

### 4. Anti-slop review

- 장식용 카드 중첩, 큰 홍보성 제목, 그라디언트 카드, 설명 문단을 추가하지 않는다.
- 커버 위 scrim은 QR 가독성이라는 기능적 이유로만 사용한다.
- 탭 한 개당 한 종류의 콘텐츠만 표시한다.
- 로딩이 아닌 상태에 로딩 애니메이션을 사용하지 않는다.
- END 모션은 위치·크기 변화 없이 opacity만 변화시킨다.

### 5. DESIGN.md alignment

- 표면: base → layered → float의 3단계만 사용한다.
- 본문은 `--nova-fg-primary`, 메타는 secondary/tertiary를 사용한다.
- 기본 본문은 15/22.5, 페이지 제목은 22/31 계열로 수렴시킨다.
- 반경은 8/12/16/999px 토큰만 사용한다.
- 그림자는 실제 부유 요소에만 사용한다.
- 새 raw hex, `9999px`, sub-pixel 글자 크기, 장식 그라디언트를 추가하지 않는다.

### 6. Responsive and accessibility

- 모든 버튼과 탭은 최소 44px 터치 영역을 가진다.
- 탭은 `role=tablist`, `role=tab`, `aria-selected`, `aria-controls`를 연결한다.
- 좌우 키로 탭 이동, Enter/Space 활성화를 지원한다.
- 프로필에는 이름을 accessible name으로 제공하고 색상만으로 화자를 구분하지 않는다.
- 16:9 커버는 장식 이미지로 처리하되 업로드 미리보기에는 대체 텍스트를 제공한다.
- 카운트다운에는 `role=timer`, 숫자에는 tabular figures를 사용한다.
- iPhone safe area, 320px 폭, iPad/desktop, 200% text scaling을 검증한다.
- 모든 반복 모션에 reduced-motion 정지 규칙을 둔다.

### 7. Resolved decisions

- Avatar overflow: 5명까지 표시 후 `+N`.
- Participant persistence: 종료 시점 스냅샷을 Electron 기록 메타에 저장.
- Cover crop: 중앙 cover 기본. 별도 초점 편집기는 이번 범위에서 제외.
- END: 종료 후에만, 시맨틱 레드, 저강도 opacity pulse.
- Countdown: 예정 시간이 있을 때만. 실제 로딩과 카운트다운은 서로 다른 상태로 표현.

## Whole-product Toss Audit

### P0 — 이번 구현에 포함

1. Captions의 Topics와 180줄 확정 자막 패널 제거.
2. Electron 기록 상세를 `요약 / 원문 / 참여자` 탭으로 변경.
3. 모바일 종료 화면의 중복 종료 문구 제거, `END`와 Leave 버튼 정리.
4. 모바일 종료 기록을 `요약 / 원문` 탭으로 변경.
5. 스테이지 B 레이아웃, 16:9 커버, 로딩/카운트다운, 참여자 프로필 스택.
6. 탭 전환 시 재요청 방지 및 기존 스크롤 상태 유지.

### P1 — 같은 구현 사이클에서 정리 권고

1. Live Call 생성 화면의 1–5 단계 배지와 중복 설명 제거.
2. 커버 안내를 `정사각형`에서 `16:9`로 교체하고 업로드 즉시 미리보기 제공.
3. Records 월간 달력은 한 날짜에 최대 2개만 보이고, 나머지는 `+N`; 선택 날짜의 전체 목록을 달력 아래에 표시.
4. Settings의 API 키·도메인·용어집·출력 세부값을 고급 섹션에 유지하고 기본 화면 높이를 줄인다.
5. 웹 조인 화면은 초대 링크로 진입하면 입장 방식 선택을 숨기고 필요한 필드와 입장 버튼만 보인다.
6. 실시간 모바일 툴바에서 PiP/전달방식 등 부차 기능을 overflow 또는 설정으로 이동해 자막 영역을 확보한다.

### P2 — 디자인 부채 정리

1. webapp의 기존 브랜드 토큰과 Electron NOVA 토큰을 역할 토큰으로 통합.
2. raw hex, `9999px`, 10.5/11.5/12.5/13.5px 글자 크기 제거.
3. Google Fonts 의존성과 사용하지 않는 EB Garamond 제거, Pretendard 400/500/600 자체 호스팅.
4. 필터 기반 라이트 모드를 실제 light token mapping으로 교체.
5. 불필요한 explanatory copy와 장식 카드/그림자를 화면 전체에서 정리.

## Task Breakdown

### Design agent — Electron

Owned files:

- `public/subtitle.html`
- `public/subtitle.css`
- `public/subtitle-dashboard.js`
- 대응되는 root 중복 파일

Work:

- Captions 정리, Live Call 생성 폼 정돈, Records 탭, Settings 밀도 조정.
- 탭·초점·키보드·빈 상태 구현.

### Design agent — Web live surfaces

Owned files:

- `webapp/components/live/LiveStageView.tsx`
- `webapp/components/live/LiveViewer.tsx`
- `webapp/components/live/MeetingMinutes.tsx`
- `webapp/components/live/MeetingSummaryCard.tsx`
- `webapp/app/globals.css`

Work:

- 승인된 Stage B, avatar stack, countdown/loading, END/Leave, 종료 탭.

### Backend agent

Owned files:

- Electron record import/session storage 경로
- 기존 participant/session transcript adapter 경로

Work:

- 종료 시 참여자 스냅샷을 기록 메타에 포함.
- 기존 응답과 호환되는 optional field로 제공.

### Security review

- 참여자 이름/부서/직함은 text node로만 렌더링한다.
- 커버 URL은 기존 안전한 업로드/허용 URL 경로만 사용한다.
- 기록 상세에서 다른 세션 참여자 데이터가 섞이지 않는지 session ownership을 검증한다.

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| 탭 변경으로 기존 상세 DOM selector가 깨짐 | High | 기존 테스트를 먼저 갱신하고 탭별 stable id 유지 |
| 참여자 스냅샷이 종료 후 누락 | High | 종료 직전/종료 응답 양쪽에서 동일 snapshot 저장, optional fallback |
| busy cover에서 QR 대비 저하 | High | 고정 scrim + QR white quiet zone + 대비 검사 |
| countdown과 실제 시작 상태 불일치 | Medium | 서버 scheduledAt 기준, 0 이후 Waiting으로 전환, 자동 시작으로 오해시키지 않음 |
| END 점멸이 접근성에 부담 | Medium | 느린 opacity, reduced-motion 정지, flash 빈도 3Hz 미만 |
| 달력 변경으로 기록 접근이 느려짐 | Medium | 선택 날짜 목록과 오늘 버튼 유지 |
| 대규모 token 정리가 기능 수정과 충돌 | Medium | P0/P1과 P2를 별도 커밋으로 분리 |

## Test Plan

1. Captions: Topics와 확정 자막 DOM이 보이지 않고 Start/Stop/overlay는 정상.
2. Records: 요약→원문→참여자 전환 시 fetch 횟수 증가 없음, 각 탭 스크롤 유지.
3. Participants: 0/1/5/6/50명, 동일 이름, 긴 이름, 퇴장 참가자 표시.
4. Stage: 커버 없음/16:9/세로 이미지/깨진 이미지, QR 대비와 crop 확인.
5. Countdown: 예정 없음, 10초 전, 0초, 과거 시간, 브라우저 백그라운드 복귀.
6. Motion: normal/reduced-motion, END는 종료 전 미노출·종료 후만 노출.
7. Mobile ended: 중복 종료 문구 0개, Leave 44px, Summary/Transcript 단일 패널.
8. Accessibility: 키보드 탭 이동, focus ring, screen reader name, 200% 확대.
9. Responsive: 320/390/768/1440/1920, iPhone safe area와 16:9 stage.
10. Regression: 기존 live UI, frontend, gateway, webapp typecheck/build 전체 통과.

## Not in scope

- 번역 품질·언어 판정·부분 자막 안정화 로직 변경.
- 참여자 사진 업로드 기능.
- 커버 이미지 수동 초점 편집기.
- 기존 Topics/확정 자막 데이터 삭제.
- 배포·Electron 재빌드·재설치.

## GSTACK REVIEW REPORT

- Initial design-plan score: 6/10
- Final design-plan score: 9/10
- Approved choices: Electron Records A, Stage B, Mobile Ended A
- Decisions resolved: 12
- Unresolved blockers: 0
- Main improvement: 화면별 요청을 정보 구조, 상태, 모션, 접근성, 데이터 보존, 테스트 기준이 포함된 구현 가능한 단일 계획으로 전환했다.
- Remaining risk: 전 제품 토큰 통합(P2)은 기능 UI 변경(P0/P1)과 분리해야 회귀 범위를 통제할 수 있다.

## Implementation Result — 2026-07-26

- Captions: Topics와 확정 기록 패널을 숨기고 현재 자막 미리보기 중심으로 정리했다.
- Settings: 기본/고급 탭으로 분리해 일상 설정의 밀도를 낮췄다.
- Records: 요약/원문/참여자 탭을 추가했으며 탭 전환은 기존 로컬 데이터만 사용한다.
- Live Call stage: 16:9 커버, 실제 로딩 상태, 예정 시간이 있을 때만 카운트다운, 참여자 아바타 스택을 적용했다.
- Mobile ended: END는 종료 후에만 Leave 왼쪽에 표시하고 저빈도 opacity 애니메이션과 reduced-motion 정지를 적용했다.
- Live Call subtitle: Host 또는 발언 참여자의 이름·부서·직급을 자막과 같은 lane에 배치해 1–3줄 변화에도 간격을 고정했다.
- Controller: 현재 디자인과 동작을 유지했으며 변경하지 않았다.
- 검증: root 854 pass/1 skip, web live 147 pass, gateway 345 pass, TypeScript 및 diff check 통과.
- 배포·Electron 재빌드·재설치는 사용자 승인 게이트까지 실행하지 않는다.
