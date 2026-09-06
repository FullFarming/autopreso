# glossary_pack 최종 제거 — 2단계(컬럼 드롭) 계획

기준일: 2026-08-28. 1단계(런타임 제거)는 코드에 반영 완료:

- 게이트웨이는 `live_sessions.glossary_pack`을 더 이상 읽지 않는다 — REST select에서 제외,
  호스트 인가 게이트 비교 제거 (`media-gateway/src/supabase-adapters.js`).
- 파이프라인/폴리셔/재부착 동등성 어디에도 pack이 닿지 않는다
  (`glossary-packs.js`는 `buildDefaultDomainInstruction()`만 노출).
- 웹앱 admission 파서는 필드 부재를 허용한다 (`lib/security/live-admission-store.ts`).
- 웹앱 create 스키마에서 optional (`live-input-validation.ts`).
- 클라이언트(웹앱 store, electron, live-audio-client)는 호환을 위해 상수
  `"general_cre"`를 계속 보낸다 — RPC 파라미터가 아직 필수이기 때문.

## 2단계는 아래 순서로만 진행한다 (순서 위반 = 프로덕션 장애)

1. **모든 게이트웨이/웹앱 인스턴스가 1단계 빌드인지 확인** (구 빌드는
   `select=...,glossary_pack,...`을 보내므로 컬럼 드롭 시 PostgREST 400 →
   호스트 시작/입장 전면 실패).
2. 마이그레이션 A: 세션 RPC들( `create_live_session`, `update_live_session`,
   `create/update_live_session_with_event_v1/v2`,
   `activate_live_session_after_gateway_ready_v1` )을 **drop + create**로
   재정의하여 `p_glossary_pack text default 'general_cre'`(trailing, 무시됨)로
   완화하고, activate의 두 비교(`:989` replay match, `:1005` fence)를 삭제.
   각 함수의 revoke/grant 쌍을 새 시그니처로 재발급.
   ※ PostgREST는 named-args 호출이라 파라미터 순서 변경은 안전.
3. 클라이언트에서 상수 전송 제거 + `live-contract.ts`의 `LiveSession.glossaryPack`
   required → optional/삭제, `GLOSSARY_PACKS` enum·`glossaryPackInputSchema` 삭제.
   배포.
4. 마이그레이션 B (롤백 윈도 경과 후):
   - returns table에서 `glossary_pack` 제거(세션 RPC 6종 + `redeem_live_attendee_v3`,
     `restore_live_attendee_v2` → v-bump 필요; `create or replace`는 OUT 변경 불가).
   - `alter table public.live_sessions drop constraint live_sessions_glossary_pack_check;`
   - `alter table public.live_sessions drop column glossary_pack;`
   - 3단계와 같은 릴리스에 합치지 말 것 — 롤백 경로가 사라진다.

주의: `fingerprintGatewaySettings`(gateway-server.js)는 여전히 settings.glossaryPack을
해시에 포함한다(상수라 무해). 컬럼 드롭 릴리스에서 함께 제거하고, 라이브 세션이
없는 시점에 배포한다(지문 변경은 activate replay 분기와만 충돌).
