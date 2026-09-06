import type { NextRequest } from "next/server";
import { speakerRosterHandlers } from "@/lib/live/speaker-roster/runtime";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string; photoId: string }> }) {
  const { id, photoId } = await context.params;
  return speakerRosterHandlers().getPhoto(request, id, photoId);
}
