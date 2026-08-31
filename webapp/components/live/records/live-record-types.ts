import type { ReactNode } from "react";
import type { TranslationLanePresentation } from "../translation";
import type { LiveRecordTopicSummary, RecordStatusPresentation } from "./live-records-presentation";

export type RecordSyncState = "pending" | "synced" | "failed" | "disabled";

export interface LiveRecordListItem {
  id: string;
  title: string;
  scheduledAt: string | null;
  status: RecordStatusPresentation;
  languages: readonly string[];
  participantCount: number;
  summaryState: RecordStatusPresentation;
  syncState: RecordSyncState;
}

export interface LiveRecordParticipant {
  id: string;
  email: string;
  company: string | null;
  department: string | null;
  jobTitle: string | null;
  privacyConsent: LiveRecordConsentPresentation;
  summaryConsent: LiveRecordConsentPresentation;
  marketingConsent: LiveRecordConsentPresentation;
}

export interface LiveRecordConsentPresentation {
  accepted: boolean;
  decidedAt: string | null;
}

export interface LiveRecordDetailPresentation extends LiveRecordListItem {
  lanes: readonly TranslationLanePresentation[];
  topics: readonly LiveRecordTopicSummary[];
  participants: readonly LiveRecordParticipant[];
  syncMessage: string;
  deletedAt: string | null;
}

export interface LiveRecordLanguagePanel {
  laneId: string;
  content: ReactNode;
}
