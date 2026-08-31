# GCP 지원 케이스 초안 — Cloud Run 인스턴스 기동 불가 (프로젝트 국한)

콘솔 → 지원 → 사례 만들기에서 아래 내용을 붙여넣으면 됩니다.
(제출 전 최신 상태 재확인: `curl -s -o /dev/null -w "%{http_code}" https://realtime-noel-media-gateway-4rivtugkhq-du.a.run.app/health` 가 200이면 복구된 것이므로 제출 불필요)

---

**Title:** Cloud Run containers fail to start project-wide — no container logs, health check timeout (project studied-sled-460400-u2)

**Priority:** P2 (production service down)

**Description:**

Since approximately 2026-08-15 13:00 UTC, every new Cloud Run instance in project `studied-sled-460400-u2` fails to start. This affects all services, all images, and multiple regions within this project.

Failure signature (identical across all attempts):
1. `Starting new instance. Reason: DEPLOYMENT_ROLLOUT` appears in `run.googleapis.com/varlog/system`.
2. Then **zero** container stdout/stderr and zero further system logs (no TCP probe failure lines, no container exit lines) for the full 4-minute startup window.
3. `HealthCheckContainerError` / "The user-provided container failed to start and listen on the port defined by PORT=8080".

What we ruled out by experiment (all reproduced today):
- **Not our app/image:** Google's own `us-docker.pkg.dev/cloudrun/container/hello` on a freshly created service fails identically (revision `probe-hello-00001-c2q`, asia-northeast3, ~14:15 UTC; also `probe-hello-tokyo-00001-ch5` in asia-northeast1 ~14:20 UTC).
- **Not the runtime command:** a trivial `node -e "require('http').createServer(...).listen(PORT)"` override fails identically (revision `realtime-noel-media-gateway-00079-fod`).
- **Not Secret Manager env resolution:** clearing all secret-backed env vars still fails (revision `realtime-noel-media-gateway-00080-rem`).
- **Not the sandbox generation:** gen2 fails identically (revision `realtime-noel-media-gateway-00081-dum`).
- **Not region:** asia-northeast3 and asia-northeast1 both fail.
- **Not account-wide:** the same hello image deploys and serves fine in another project on the same billing account (`gen-lang-client-0321430669`, asia-northeast3, ~14:35 UTC).
- Billing enabled; no org policies; Binary Authorization not enabled; Cloud Run quotas normal; `roles/run.serviceAgent` binding for service-726872210143@serverless-robot-prod.iam.gserviceaccount.com present; no active incidents on Service Health for this project.

Impact: our production WebSocket gateway `realtime-noel-media-gateway` (asia-northeast3) is **down** — its min-instance was recycled by the platform and the replacement instance cannot start, so all requests return 503. Example failed revisions to inspect: `realtime-noel-media-gateway-00078-cus`, `00079-fod`, `00080-rem`, `00081-dum`, `probe-hello-00001-c2q`.

Request: please investigate why instance creation stalls after scheduling (before container exec) for this project, and restore instance startup capability.
