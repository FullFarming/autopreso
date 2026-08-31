export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function distanceFromLiveEdge(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

export function isPinnedToLiveEdge(metrics: ScrollMetrics): boolean {
  return distanceFromLiveEdge(metrics) <= 48;
}

export function resolveLanguageSelectorPresentation(optionCount: number, isCompact: boolean): "segmented" | "select" {
  return optionCount <= 3 && !isCompact ? "segmented" : "select";
}

