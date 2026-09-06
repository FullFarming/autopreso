export type ViewerSurfacePath = "/watch" | "/m/watch";

export function buildParticipantEntryUrl(searchParams: Record<string, string | string[] | undefined>): string {
  const language = searchParams.language;
  if (typeof language !== "string" || !language) return "/watch";
  return `/watch?${new URLSearchParams({ language })}`;
}

export function isIpadUserAgent(userAgent: string, maxTouchPoints: number): boolean {
  return /\biPad\b/iu.test(userAgent)
    || (/\bMacintosh\b/iu.test(userAgent) && /\bMobile\//iu.test(userAgent) && maxTouchPoints > 1);
}

export function getViewerSurfaceRedirect(
  pathname: string,
  userAgent: string,
  maxTouchPoints: number,
): ViewerSurfacePath | null {
  if (pathname === "/m/watch" && isIpadUserAgent(userAgent, maxTouchPoints)) return "/watch";
  if (pathname === "/watch" && /\b(?:iPhone|iPod)\b/iu.test(userAgent)) return "/m/watch";
  return null;
}

export function buildViewerSurfaceUrl(target: ViewerSurfacePath, search: string, hash: string): string {
  return `${target}${search}${hash}`;
}
