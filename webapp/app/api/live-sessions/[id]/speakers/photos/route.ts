import type { NextRequest } from "next/server";
import { speakerRosterHandlers } from "@/lib/live/speaker-roster/runtime";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return speakerRosterHandlers().postPhoto(request, (await context.params).id);
}
