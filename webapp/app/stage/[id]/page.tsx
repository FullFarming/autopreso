import LiveStageView from "@/components/live/LiveStageView";

export default async function StagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LiveStageView sessionId={id} />;
}
