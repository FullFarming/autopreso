import { redirect } from "next/navigation";

import { buildParticipantEntryUrl } from "@/components/live/viewer-surface-routing";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(buildParticipantEntryUrl(await searchParams));
}
