// Client-side CSV export for the conversation history.
// Columns: 날짜, 시간, 입력, 언어, 주제(빈값 허용), 번역 — UTF-8 BOM so Excel
// opens Korean/Japanese text correctly.

import type { SubtitleLine } from "./types";

const SOURCE_LABELS: Record<string, string> = {
  mic: "마이크",
  tab: "탭",
};

function csvEscape(value: string): string {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function buildHistoryCsv(lines: SubtitleLine[], topic = ""): string {
  const rows = [["날짜", "시간", "입력", "언어", "주제", "번역"]];
  for (const line of lines) {
    const date = new Date(line.at);
    rows.push([
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
      `${SOURCE_LABELS[line.source] ?? line.source} | ${line.sourceText}`,
      line.targetLanguage,
      topic,
      line.translatedText,
    ]);
  }
  const body = rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  return `\uFEFF${body}\r\n`;
}

export function downloadCsv(lines: SubtitleLine[], topic = "") {
  const csv = buildHistoryCsv(lines, topic);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const now = new Date();
  anchor.href = url;
  anchor.download = `realtime-noel-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
