import { notFound } from "next/navigation";
import { LiveRecordsDemo } from "@/components/live/records/demo/LiveRecordsDemo";
import { demoExportSnapshot } from "@/components/live/records/demo/records-demo-fixture";
import { buildLiveRecordWorkbook } from "@/lib/live-recap/xlsx";

export const dynamic = "force-dynamic";

export default async function LiveRecordsDemoPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const workbook = await buildLiveRecordWorkbook(demoExportSnapshot);
  return <LiveRecordsDemo workbookBase64={Buffer.from(workbook).toString("base64")} />;
}
