"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { viewerMessages } from "@/lib/system-language/viewer-messages";

import type { ReactNode } from "react";

import type { LiveSessionStatus } from "@/lib/live-contract";
import { TranslationLaneTabs, type TranslationLanePresentation } from "../translation";
import { ViewerLaneHealthNotice } from "./ViewerLaneHealthNotice";

interface ViewerLiveSurfaceProps {
  sessionStatus: LiveSessionStatus;
  selectedLane: TranslationLanePresentation | undefined;
  unavailableLanguages: readonly string[];
  incompleteLanguages?: readonly string[];
  lanes: readonly TranslationLanePresentation[];
  selectedLaneId: string;
  onSelectLane: (lane: TranslationLanePresentation) => void;
  renderPanel: (lane: TranslationLanePresentation) => ReactNode;
}

export function ViewerLiveSurface({
  sessionStatus, selectedLane, unavailableLanguages, incompleteLanguages = [], lanes, selectedLaneId,
  onSelectLane, renderPanel,
}: ViewerLiveSurfaceProps) {
  const t = useSystemText(viewerMessages);
  return (
    <>
      {sessionStatus === "paused" && (
        <div className="live-paused-banner" role="status">
          <span className="live-status-dot" aria-hidden="true" />
          {t("호스트가 자막을 잠시 멈췄습니다. 곧 이어집니다.")}
        </div>
      )}
      <ViewerLaneHealthNotice
        isVisible={selectedLane?.kind === "translation" && (unavailableLanguages.includes(selectedLane.language) || incompleteLanguages.includes(selectedLane.language))}
        isIncomplete={selectedLane?.kind === "translation" && incompleteLanguages.includes(selectedLane.language)}
        onViewSource={() => {
          const sourceLane = lanes.find((lane) => lane.kind === "source");
          if (sourceLane) onSelectLane(sourceLane);
        }}
      />
      <TranslationLaneTabs participantControls lanes={lanes} selectedLaneId={selectedLaneId}
        onChange={onSelectLane} renderPanel={renderPanel}
        ariaLabel={t("자막 언어")} emptyLabel={t("사용 가능한 자막 언어가 없습니다.")} />
    </>
  );
}
