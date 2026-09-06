"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { viewerMessages } from "@/lib/system-language/viewer-messages";

interface ViewerLaneHealthNoticeProps {
  isVisible: boolean;
  isIncomplete?: boolean;
  onViewSource: () => void;
}

export function ViewerLaneHealthNotice({ isVisible, isIncomplete = false, onViewSource }: ViewerLaneHealthNoticeProps) {
  const t = useSystemText(viewerMessages);
  if (!isVisible) return null;
  return (
    <div className="live-viewer-lane-health" role="status" aria-live="polite">
      <span>{isIncomplete
        ? t("일부 번역 기록을 복구하지 못했어요. 원문에서 확인해 주세요.")
        : t("선택한 번역을 잠시 표시할 수 없습니다. 원문 자막은 계속 제공됩니다.")}</span>
      <button type="button" onClick={onViewSource}>{t("원문 보기")}</button>
    </div>
  );
}
