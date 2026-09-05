# 컨트롤러·버튼·모달 디자인 QA — 2026-09-05

final result: passed within the locally verified UI scope

- 승인된 컨트롤러, 단일 열 캡션, 문단형 참가자 기록과 실제 화면을 비교했다. 모달 겹침, 낮은 화면의 컨트롤러 잘림, 투명도 0 복원, 무표기 발언 버튼을 수정했다.
- 최종 자동 검사: desktop 1,703 pass/16 skip/0 fail; web 974+77 pass/0 fail; 양쪽 TypeScript 및 diff 검사 통과.
- 375×568 실제 브라우저에서 입력폼 저장 버튼과 고정 하단 영역의 겹침 없음, 16px 좌우 여백과 긴 문구 줄바꿈을 확인했다. 컨트롤러는 높이 600px 모의 화면에서 검증했다.
- 실제 인증/음성 제공자/물리적 다중 모니터, Drive·녹음·결제·예약 QR 후속 범위의 완료를 뜻하지 않는다. 배포하지 않았다.
- 상세 증거와 A1–A8 검수: [검수 보고서](docs/superpowers/status/2026-09-05-ui-polish-verification.md).

---

# 호스트 원문 연속 화자·문단 후속 QA — 2026-08-31

final result: passed

- 범위: 호스트 기록의 원문 표시만 개선. 참여자 화면, 저장된 원문, API, Excel 데이터와 실제 이메일 발송은 변경하지 않았다.
- 같은 화자의 연속 발언은 이름·시각을 한 번만 표시하고 문장과 문단으로 이어진다. 화자 변경, 순번 누락, 기록 공백은 구분하며 교정 표시와 발언별 최초 전사는 유지한다.
- 사용자 첨부 이미지와 수정 캡처를 같은 비교 입력에서 확인했다. 반복 메타데이터와 데모의 임의 번호 제거는 요청에 따른 변경이다. 첨부는 확대·크롭된 화면이므로 동일 배율 비교라고 주장하지 않는다. 기존 본문 토큰, 문단 16px·화자 32px 간격을 유지했다.
- 캡처: `.codex-artifacts/live-recap-20260831/host-original-paragraphs.jpg`, `host-original-paragraphs-mobile.jpg`. 실제 CSS viewport 919px와 390px에서 가로 넘침 없음, 긴 한글 문장 줄바꿈과 문단 간격 확인.
- 브라우저 정상 흐름: 원문 탭에서 50개 발언/17문단/화자 묶음 1개 → 더 보기 후 75개 발언/25문단/화자 묶음 1개. 탭 전환 후 다시 표시하는 흐름도 확인했다.
- 적대적 검사: 동명이인·다른 참여자 ID·불명확 화자 분리, 50→51 연결과 50→52 분리, 열린 기록 공백, 잘못된 시간, 긴 미완성 문장, 숫자·줄바꿈·HTML 유사 문자열·교정 원문 보존 통과. 인증·CSRF·SSRF와 DB 동시성은 변경 범위에 해당하지 않는다.
- 자동 검사: web 676 live + 76 core = 752개, root 관련 85개 통과. TypeScript와 diff 공백 검사 통과. 독립 검토에서 차단 결함 없음. 이 후속 작업에서 운영 데이터 연결 및 배포는 수행하지 않았다.
- 개발 중 새 helper가 생성되기 전의 모듈 미발견 로그가 남아 있었으나, 구현 완료 후 페이지 로드와 모든 원문 조작이 성공했다. 최종 검사 구간(07:04 UTC 이후)에 새 error/warn 로그 없음.

---

# NOVA 라이브·종료 기록·수신 신청 QA — 2026-08-31

final result: passed

## 범위와 시각 근거

이번 결과는 승인된 로컬 구현의 디자인 QA다. 운영 DB·배포·실제 이메일 발송 완료를 뜻하지 않는다. 아래 이전 QA 기록은 그대로 보존한다.

- 시안: `/Users/kyeongmankim/Realtime/autopreso/docs/superpowers/specs/assets/2026-08-31-live-viewer-approved-no-footer.png` (1484×1060); 호스트 `/Users/kyeongmankim/Realtime/autopreso/docs/superpowers/specs/assets/2026-08-31-host-records-export.png` (1487×1058).
- 라이브 PC: `/Users/kyeongmankim/Realtime/autopreso/.codex-artifacts/live-recap-20260831/participant-live-final.jpg`.
- 라이브 모바일: `/Users/kyeongmankim/Realtime/autopreso/.codex-artifacts/live-recap-20260831/participant-mobile-live-final.jpg`.
- 종료 화면 상단/하단: `/Users/kyeongmankim/Realtime/autopreso/.codex-artifacts/live-recap-20260831/participant-ended-top.jpg`, `/Users/kyeongmankim/Realtime/autopreso/.codex-artifacts/live-recap-20260831/participant-ended-bottom.jpg`.
- 호스트 PC: `/Users/kyeongmankim/Realtime/autopreso/.codex-artifacts/live-recap-20260831/host-records-desktop-final.jpg`; 모바일: `/Users/kyeongmankim/Realtime/autopreso/.codex-artifacts/live-recap-20260831/host-records-final.jpg`.
- CSS viewport: 1280×900 및 390×844; 추가 320×844 경계 검사. 브라우저 캡처 결과는 화면 맞춤 출력으로 모바일 375×812, 호스트 1265×889이며 CSS viewport와 1:1 픽셀 비교라고 주장하지 않는다. fullPage 출력은 밀도 불일치가 있어 판정에서 제외하고 실제 viewport와 스크롤 후 캡처를 사용했다.
- source와 구현 이미지를 같은 비교 입력에 함께 열었다. 전체 레이아웃과 별도로 캡슐 버튼·자막 상태·종료 고지/신청 버튼·호스트 표 영역을 확인했다. 시안은 두 화면을 나란히 둔 보드여서 실제 휴대전화 폭과 내용량은 다르다.
- 호스트 시연 상단의 예시 데이터 제어와 일부 캡처의 Next.js 개발 도구는 운영 화면에 없는 개발 표시로 비교에서 제외했다. 공급자 발송 상태는 사용자 요청에 따라 수신 신청/취소로 바꿨다.

## 비교 이력과 수정

1. P1 — 제목·자막용 t1/t3 토큰이 정의되지 않아 모두 일반 본문 크기로 표시됨. DESIGN.md의 30/40, 22/31 값을 viewer 범위에 연결했다. PC 제목과 자막, 모바일 자막 위계 재확인.
2. P2 — 모바일 좌우 여백이 0으로 표시됨. 콘텐츠에 24px padding과 border-box를 적용했다. 320px에서 마이크 x=24, width=272, height=56이며 가로 넘침 없음.
3. P2 — 라이브 자막 부모/자식의 중첩 스크롤과 최초 자동 스크롤로 첫 화자 줄이 사라짐. flex 높이와 overflow를 조정했다. 최종 390px DOM: viewer-reading-scroll 한 개만 넘치는 스크롤 영역, 높이 438/내용 541, scrollTop=0. 마이크 하단 유지.
4. P1 — 종료 화면이 100dvh 고정 영역에 잘려 신청 버튼으로 스크롤 불가. 종료 상태는 자연 문서 스크롤로 분리했다. 수정 후 문서 높이 1286px 이상, 하단 스크롤 시 CTA y=706.5..762.5 (viewport844)로 실제 도달. 이메일·목적 고지가 버튼 위에 보인다.
5. P2 — 수집 공백이 있는 원문을 전체 녹취로 오해할 가능성. 서버의 실제 미수집 시각/사유를 원문·요약 화면과 XLSX에 표시했다. 없는 발언을 추정해 채우지 않는다.

후속 캡처에서 위 P1/P2 문제는 해소됐다. 새로운 확정 P0/P1/P2는 없다.

## 필수 시각 항목

- 글꼴/위계: 기존 Pretendard, 일반 UI 16px, 제목/라이브 자막 위계 복원. 확정 자막은 흰색, 작성 중은 회색. 긴 한글은 줄바꿈되며 잘리지 않는다.
- 여백/레이아웃: 모바일 24px, PC 최대 콘텐츠 폭 760px, 56px 마이크·신청 CTA. 라이브 마이크는 캡슐, 종료 CTA는 기존 버튼 규칙. 4탭·검색·표와 우측 전체 내보내기 계층을 유지한다.
- 색: 실제 CTA computed background `rgb(0,113,227)`. charcoal/white/blue 기존 토큰을 재사용한다. 추가 장식 그라디언트나 다색 강조를 넣지 않았다.
- 이미지/아이콘: 실제 아이콘 라이브러리 마이크·검색·다운로드를 사용한다. 인물 아바타는 제거했다. 시안 배경을 이미지로 붙인 화면이 아니다.
- 문구: 요청한 하단 ‘웹 열람은 종료 후 ~ 별도 보관’ 삭제. 라이브 요약 CTA와 마이크 아래 발언하기 문구 없음. 종료 화면은 수신 신청만 저장하며 실제 이메일 발송을 주장하지 않는다.

## 실제 조작 검사

- 호스트: 4탭 전환, 전체 45명 중 마지막 참가자 검색, 원문 50→75건 더 보기, 전체 Excel 다운로드, 읽기 실패와 Excel 실패 표시.
- 검색 결과 1명 상태에서 받은 `/Users/kyeongmankim/Downloads/NOVA-라이브콜-로컬예시.xlsx`를 ExcelJS로 다시 열어 5개 시트와 참여자45/신청45/원문75+공백1을 확인했다. 브라우저 download 이벤트 대기는 시간초과했지만 실제 다운로드 파일과 내용으로 완료를 확인했다.
- 참여자: 권한 없음에서 마이크0개, 6시간 만료에서 원문/요약/신청 버튼 제거, 수신 신청 성공 및 실패, native details 클릭·Enter 펼침, 종료 하단 접근.
- 320px/390px에서 가로 넘침 없음. PC/모바일은 같은 컴포넌트와 데이터 계약을 사용한다.
- 최종 시연 두 탭 console warning/error 없음. 실제 DB 복구와 이메일 저장은 단위·로컬 PostgreSQL 테스트로 검증했으며 시연에는 격리된 예시 데이터를 쓴다.

## 남은 운영 검증

실제 Supabase 전체 마이그레이션 적용, 인증된 브라우저와 운영 게이트웨이 연결, Electron 실제 기기의 마이크 권한·오디오, Cloud Run 축소 비용은 배포 전 별도 검증이 필요하다. 로컬 시연은 production에서 404이며 원격 DB·이메일에 접근하지 않는다.

---

# NOVA Web — Three-color palette and language search QA (2026-08-31)

final result: passed

## Scope and decision

- Existing web admin, participant and login surfaces reuse three base colors: charcoal `#15151A`, white `#FFFFFF`, action blue `#0071E3`. Muted text, separators and disabled states derive from their opacity; errors, meaningful status colors and machine-readable QR colors are exceptions.
- Ordinary UI retains Pretendard 16px/400; headings and actual captions retain their established hierarchy. No new route, backend policy, schema, external AI call or deployment was introduced in this iteration.
- Session and glossary translation pickers now search the canonical language registry by Korean, English, native name or code. Empty search hides the full registry. Selected rows use minus buttons; search results use plus buttons.
- Existing C6 service policy always includes English and Korean and permits three total caption languages. The host picker now shows both as fixed basic captions, with one optional translation. Legacy selections are preserved visibly and saving is blocked if their union exceeds three; nothing is silently discarded. Glossary targets retain their separate, larger limit and exclude the source language.

## Reference and comparison

- User reference, unchanged copy: `/Users/kyeongmankim/.codex/visualizations/2026/08/31/01a0554d-c47f-7903-a9f6-5b154496da7b/palette-source.png` (1776 × 1572 source pixels).
- Admin language region: `/Users/kyeongmankim/.codex/visualizations/2026/08/31/01a0554d-c47f-7903-a9f6-5b154496da7b/palette-language-final.png` (1440 × 900 local viewport, workspace 100%).
- Modal: `/Users/kyeongmankim/.codex/visualizations/2026/08/31/01a0554d-c47f-7903-a9f6-5b154496da7b/palette-modal-final.png` (1024 × 900).
- Small modal: `/Users/kyeongmankim/.codex/visualizations/2026/08/31/01a0554d-c47f-7903-a9f6-5b154496da7b/palette-mobile-final.png` (320 × 900).
- Width measurements: `/Users/kyeongmankim/.codex/visualizations/2026/08/31/01a0554d-c47f-7903-a9f6-5b154496da7b/palette-measurements.json`.
- Reference and final admin capture were opened together in the same comparison tool input. Both focus on the scrolled language region and creation footer. Source CSS density and browser zoom are unknown, so comparison is by corresponding regions rather than a claimed pixel-perfect clone. The shorter search list, smaller consistent typography, basic-language labels and blue action treatment are intentional requested changes.
- Full-view judgment: rail, workspace, cards and footer share one continuous charcoal background; no former black/gray rectangular seams remain. Focused judgment: selected and result rows align, controls remain 44px, long names scroll inside their row, and modal form controls have consistent widths and 8px corners.

## Comparison history and fixes

1. P2: changing shared surface colors exposed low-contrast leave-button and speaking-status text. Replaced the former with the semantic error token and the latter with white. Contrast: 5.341:1 and 18.196:1 respectively.
2. P2: invite QR quiet zone previously depended on surrounding white UI. Increased the QR library margin to four modules, independent of the dark surface.
3. P2: glossary dialog input selectors overrode the new search component, producing a nested border and duplicate focus outline. Excluded search from generic dialog input/focus styling; verified one blue wrapper outline, no internal border or padding. Ordinary inputs/select now use the same 8px corners.
4. Final recheck: white on blue 4.697:1; white on charcoal 18.196:1. Four existing contrast tests now resolve actual CSS aliases and alpha compositing instead of assuming obsolete literal colors. The contrast checks remain at AA 4.5:1, with resolver failure cases tested.

## Interaction and adversarial verification

| Scenario | Result | Evidence |
|---|---|---|
| A1 repeated additions | PASS | Functional updater tests reject duplicate language and fourth caption language; UI disables additions at 3/3. |
| A2 authorization | N/A for changed surface | No endpoint/authentication change. Existing web suite passed; no production credential mutation. |
| A3 CSRF | N/A for changed surface | Search operates locally and introduces no network mutation. |
| A4 HTML-like search | PASS | `<script>alert(1)</script>` remains input text and produces the empty-result notice; no HTML insertion. |
| A5 SSRF | N/A | No external URL fetch added by picker. |
| A6 input boundaries | PASS | Empty query, unknown text, code, native Japanese and normalized Korean covered; browser `ja`, Korean search, Japanese Enter addition and no-result state checked. IME composition guard statically reviewed, not physically simulated. |
| A7 stale selection | PASS | Required captions cannot be removed; legacy overflow is preserved and blocked before save. Changing glossary source removes conflicting target and clears generated prompt; zero targets disables generation. Browser confirmed these transitions. |
| A8 width/scroll/zoom | PASS | Widths 320/768/1024/1440 stay within document width. Workspace scrolls at narrow widths; zoom buttons reach 50% and 150% and reset. At 320px the modal is 288px wide at x=16, max-height 868px, with 44px language actions. |

- Browser normal scenario: search Japanese → add → 3/3 → remove → 2/3; native-name Enter addition returns focus to search.
- Browser failure scenarios: no matching language; maximum reached; source-target conflict leading to no glossary targets. All report or disable the relevant action without losing unrelated selections.
- Shared color check: body, rail and workspace compute to `rgb(21,21,26)` at every measured width. Login action computes to blue background, white text and the ordinary Pretendard font.
- Automated verification: web suite **682/682**, root UI/test-registration suite **84/84**, TypeScript check and `git diff --check` passed. This package has no lint script. No new production build was run for this UI iteration.
- Independent design, language-contract and adversarial reviews completed. No unresolved P0/P1/P2 defect was found in the changed scope.

## Limits and handoff

- Local browser used `LIVE_EXTERNAL_ENV=disabled`; saved-session and glossary service load errors are expected and were not hidden. Real provider calls, actual session creation/persistence, production credentials and deployment were not retested or modified by this UI verification.
- Working preview: `http://localhost:3000/admin`. Production remains unchanged; deployment requires the user's explicit request.
- Earlier QA history below is retained as historical evidence and does not describe this iteration's language grid or palette.

---

# NOVA SEED Option 1 — Product Design QA (2026-08-21)

## Comparison target

- Source visual truth: `/Users/kyeongmankim/.codex/generated_images/01a0243f-b69a-7f92-be20-3171787a209e/exec-655d1233-0f82-457f-86ed-b382dd0db2e7.png`
- Desktop captions implementation: `/Users/kyeongmankim/Realtime/autopreso/.codex-artifacts/nova-product-design-final-2026-08-21/01-desktop-captions-final.png`
- Desktop Live Call implementation: `/Users/kyeongmankim/Realtime/autopreso/.codex-artifacts/nova-product-design-final-2026-08-21/02-desktop-live-call-final.png`
- Web login implementation: `/Users/kyeongmankim/Realtime/autopreso/.codex-artifacts/nova-product-design-final-2026-08-21/03-web-login-final.png`
- 390px participant implementation: `/Users/kyeongmankim/Realtime/autopreso/.codex-artifacts/nova-product-design-final-2026-08-21/04-mobile-join-final.png`
- Source and implementation in one comparison input: `/Users/kyeongmankim/Realtime/autopreso/.codex-artifacts/nova-product-design-final-2026-08-21/05-design-comparison.png`
- Local implementation routes: `http://127.0.0.1:3210/subtitle.html`, `http://127.0.0.1:3203/login`, `http://127.0.0.1:3203/watch`

## Viewport and normalization

- Source pixels: 1586 x 992.
- Desktop implementation pixels: 1440 x 900.
- Live Call and login evidence: 1440 x 900.
- Mobile evidence: 390 x 844.
- Comparison canvas: 1265 x 878. Both source and implementation are rendered at the same CSS width in the same page; the second row magnifies the preview and controls together.
- Browser density: local Codex in-app browser capture. Desktop reference and implementation are compared by normalized CSS width; mobile is captured from an actual 390 x 844 same-origin frame so responsive media queries receive a 390px layout viewport.

## State

- Source: captions-ready configuration with a representative bilingual preview.
- Implementation: captions-ready configuration with a realistic Korean preview, selected Korean/English outputs, overlay on, and transport ready.
- Live Call evidence: idle setup state with session, admission, language and start actions visible.
- Web evidence: unauthenticated host login and participant join states. No production credential or external session was used.

## Full-view comparison

- The 220px dark navigation rail, dominant caption preview, restrained neutral palette and fixed transport follow the selected Option 1 composition.
- Captions, Live Call, Records and Settings expose only one active rail item at a time.
- Configuration is expressed through SEED-style Field, List and Status contracts instead of stacked cards.
- The preview remains the dominant region; status and configuration are subordinate.
- Web login, participant join, Live Interpreter, Meeting Coach and Records reuse the same NOVA tokens, concise Korean copy and flat row hierarchy.

## Focused-region comparison

### Navigation and shell

- The left rail is 220px with grouped sections, one selected state and 44px interaction geometry.
- Repeated decorative copy, step badges, orphaned search UI and legacy `--cw-*` color aliases are removed.

### Caption preview and configuration

- The default preview uses realistic meeting copy and clears when a live session owns the surface.
- Language output is a flat selectable list; the existing maximum-three-output contract remains intact.
- The bottom transport stays visible and keeps start, stop, restart and overlay state together.

### Live Call and supporting surfaces

- Live Call uses flat Field/List rows and a single high-emphasis start action.
- Live Interpreter is preview-first at desktop and uses a 66% preview / scrollable settings split at 420px.
- Meeting Coach prep, record and response windows share the NOVA header and preview-first hierarchy.
- Records uses flat search/list, explicit status text, skeleton, empty, error/retry and duplicate-action protection.

## Interaction and accessibility checks

- Desktop rail navigation: Captions and Live Call activate independently; final Live Call state has exactly one `aria-current="page"` item.
- Participant join: entering email and a six-digit code plus required consent enables the primary action.
- Mobile join: 390 x 844 has no horizontal overflow; controls remain at least 44px.
- Focus-visible and reduced-motion contracts are present in focused tests.
- Status is not expressed by color alone; buttons and disclosure controls retain accessible names.
- No JavaScript runtime error was observed in the final desktop captures. The web screenshots show only the Next.js development indicator, which is absent from production output.

## Comparison history

### Pass 1 — blocked

- P1: desktop Captions and Live Call could both appear active.
- Fix: primary navigation state now owns one `aria-current` item.

- P1: desktop Live Call primary action did not carry the selected high-emphasis brand treatment.
- Fix: the action now uses the NOVA brand token with accessible contrast.

### Pass 2 — blocked

- P2: login and participant join retained mixed English and explanatory ledes.
- Fix: visible product copy is concise Korean; only identity names and language names remain multilingual where required.

- P2: legacy radius, gradient, invert and raw status-color patterns remained in shared CSS.
- Fix: replaced them with NOVA semantic radius, surface, focus and status tokens. The only gradient-like rule left is the allowed transcript `mask-image` fade from DESIGN §8.4.

### Pass 3 — passed

- Source and implementation were placed in one combined comparison input and reviewed together.
- No actionable P0, P1 or P2 visual, responsive, accessibility or interaction finding remains.
- Residual P3: authenticated host and real Supabase Records data were not opened because no production credential was used; contracts are covered by focused tests, typecheck and build.

## Adversarial verification

| Scenario | Result | Evidence |
|---|---|---|
| Option 1 consistency | PASS | 220px rail, preview-first shell, flat rows, fixed transport in final captures |
| Mobile/device | PASS | 390 x 844 participant capture; Live Interpreter/Coach 420px checks; Records 360px tests |
| Accessibility | PASS | 44px targets, focus-visible, reduced-motion and semantic status tests |
| Mixed copy | PASS | concise Korean host/join/coach copy; explanatory ledes removed |
| Forbidden visual patterns | PASS | no runtime `9999px`, `filter: invert`, `--cw-*`, raw gradient; one documented mask fade allowed |
| State/error/duplicate action | PASS | one active nav item; records retry and duplicate-action guards; explicit empty/error states |
| XSS/CSP | PASS | no `dangerouslySetInnerHTML`; local Coach CSP and `frame-ancestors 'self'` contracts pass |
| Contract regression | PASS | web 499 live + 68 core; focused desktop/supporting 154; typecheck and build pass |

## Verification

- Web full tests: 499 live + 68 core passed.
- Web and root TypeScript: passed.
- Web production build: passed, 22 routes generated.
- Desktop/supporting focused tests: 154/154 passed.
- Desktop captions + Live UI focused tests after the final copy change: 121/121 passed.
- Root full suite: 1331 passed, 2 timing/performance failures, 1 skipped under full parallel load; both failures passed when rerun alone.
- Diff whitespace check: passed.
- Independent read-only adversarial review: no P0/P1/P2 findings.

final result: passed
