# NOVA

실시간 자막과 Live Call을 위한 데스크톱·웹 프로젝트입니다. 아직 alpha 단계입니다.

캔버스 / Excalidraw / Realtime Noel은 독립 Git 저장소
`../realtime-noel-canvas`로 분리했습니다. 이 프로젝트의 기본 주소는 NOVA만 엽니다.

## 실행

Node.js 24 이상이 필요합니다.

```sh
npm ci
npm run dev -- --no-open
# http://127.0.0.1:3317 — NOVA captions
npm run desktop
```

`webapp/`과 `media-gateway/`는 각각 별도 package.json/lockfile을 갖습니다.
각 디렉터리에서 의존성을 설치합니다. 웹과 게이트웨이 설정은
[운영 설정](docs/superpowers/status/2026-09-05-operator-setup.md)을 참고하세요.

## 저장소와 설정

- 현재 저장소: NOVA 자막·Live Call·설정, 기본 포트 3317.
- 형제 저장소 `../realtime-noel-canvas`: 캔버스·에이전트, 기본 포트 3319.
- NOVA 설정·기록: `~/.config/nova/`.
- 캔버스 설정: `~/.config/realtime-noel/`.
- NOVA는 기존 공유 위치의 자막 설정·기록·녹음만 최초에 가져옵니다. 원본과
  이미 존재하는 NOVA 데이터는 덮어쓰거나 삭제하지 않습니다.

[분리 결과와 실행 안내](docs/superpowers/status/2026-09-05-project-separation.md)

## 검증

```sh
npm run typecheck
npm test
npm run test:all
```

운영 배포는 자동 수행하지 않습니다. 라이브 API 키·인증·서버 설정은 운영 설정
문서의 절차를 따르며 비밀값을 소스 코드에 기록하지 않습니다.

## Credits

- [Excalidraw](https://github.com/excalidraw/excalidraw) - the whiteboard canvas, scene model, and rendering.
- [Moonshine](https://github.com/moonshine-ai/moonshine) the local speech-to-text model that makes the offline path possible.
- [Vercel AI SDK](https://github.com/vercel/ai) - tool-calling agent loop and provider abstraction.
