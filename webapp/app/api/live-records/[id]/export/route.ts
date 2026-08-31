import { NextRequest } from "next/server";
import { requireHost } from "@/lib/auth/live-auth";
import { parseSessionId } from "@/lib/live/validation";
import { SupabaseLiveAdmissionStore } from "@/lib/security/live-admission-store";
import { privateNoStoreHeaders } from "@/lib/security/live-topic-validation";
import { createLiveRecapService, enforceRecordExportRateLimit, recapRouteError, recordExportPrepared } from "@/lib/live-recap/http";
import { buildLiveRecordWorkbook } from "@/lib/live-recap/xlsx";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { hostId } = await requireHost(request);
    const sessionId = parseSessionId((await context.params).id);
    await enforceRecordExportRateLimit(hostId, new SupabaseLiveAdmissionStore());
    const snapshot = await createLiveRecapService().readExportSnapshot(sessionId, hostId);
    const bytes = await buildLiveRecordWorkbook(snapshot);
    recordExportPrepared(hostId, sessionId, snapshot.snapshotId, bytes.byteLength);
    return new Response(Uint8Array.from(bytes).buffer, {
      headers: {
        ...privateNoStoreHeaders(),
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="nova-record-${sessionId}.xlsx"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Length": String(bytes.byteLength),
      },
    });
  } catch (error: unknown) { return recapRouteError(error); }
}
