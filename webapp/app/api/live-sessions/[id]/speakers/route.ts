import type { NextRequest } from "next/server";
import { speakerRosterHandlers } from "@/lib/live/speaker-roster/runtime";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return speakerRosterHandlers().get(request, (await context.params).id);
}
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return speakerRosterHandlers().put(request, (await context.params).id);
}
