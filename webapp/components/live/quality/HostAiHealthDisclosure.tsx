"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { hostMessages } from "@/lib/system-language/host-messages";

import { validateHostAiHealthRows, type AiHealthRow } from "./host-ai-health";

export type { AiHealthRow, AiHealthState, HostAiHealthRows } from "./host-ai-health";

export function HostAiHealthDisclosure({ rows }: { rows: readonly AiHealthRow[] }) {
  const t = useSystemText(hostMessages);
  const validatedRows = validateHostAiHealthRows(rows);
  const attentionRows = validatedRows.filter((row) => row.state === "degraded" || row.state === "unavailable");
  const requiresAttention = attentionRows.length > 0;
  return (
    <details className="live-ai-health" open={requiresAttention ? true : undefined}>
      <summary>{t("AI 상태")}</summary>
      <div className="live-ai-health-rows">
        {validatedRows.map((row) => (
          <div key={row.id} className="live-ai-health-row" data-health-state={row.state}>
            <span>{t(row.label)}</span>
            <strong>{t(row.stateLabel)}</strong>
            {row.actionLabel && row.onAction ? (
              <button type="button" onClick={row.onAction}>{t(row.actionLabel)}</button>
            ) : <span aria-hidden="true" />}
          </div>
        ))}
      </div>
      <p className="live-ai-health-announcement" role="status" aria-live="polite">
        {attentionRows.map((row) => `${t(row.label)} ${t(row.stateLabel)}`).join(". ")}
      </p>
    </details>
  );
}
