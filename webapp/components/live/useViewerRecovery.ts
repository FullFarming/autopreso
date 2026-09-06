"use client";

import { useEffect, useRef, useState } from "react";

import { getViewerSurfaceRedirect } from "./viewer-surface-routing";

export function useViewerRecovery(restore: () => Promise<void>) {
  const [isRestoringViewer, setIsRestoringViewer] = useState(true);
  const viewerRestorePromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (getViewerSurfaceRedirect(
      window.location.pathname,
      window.navigator.userAgent,
      window.navigator.maxTouchPoints,
    )) return;
    if (!viewerRestorePromiseRef.current) {
      viewerRestorePromiseRef.current = restore().finally(() => setIsRestoringViewer(false));
    }
    void viewerRestorePromiseRef.current;
  }, [restore]);

  return { isRestoringViewer };
}
