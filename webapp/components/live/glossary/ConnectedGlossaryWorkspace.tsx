"use client";

import { useSystemText } from "@/components/system-language/SystemLanguageProvider";
import { glossaryMessages, formatGlossaryStatus } from "@/lib/system-language/glossary-messages";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GlossaryDocumentV1, GlossaryDocumentVersion, GlossaryPreset } from "@/lib/glossary-presets/types";
import {
  GlossaryClientError,
  activateGlossaryVersion,
  createGlossaryPreset,
  duplicateGlossaryPreset,
  extractGlossaryCandidates,
  listGlossaryPresets,
  listGlossaryVersions,
  readGlossaryVersion,
  saveGlossaryVersion,
  validateGlossaryImport,
  type GlossaryFetcher,
} from "./glossary-client";
import {
  buildEditedGlossaryDocument,
  createEmptyGlossaryDocument,
  extractedCandidatesToEditable,
  presentPreset,
  presentTerm,
  presentVersions,
  type EditableGlossaryTerm,
} from "./glossary-controller";
import type { GlossaryImportPreviewPresentation, GlossarySessionSelection, GlossaryValidationIssue } from "./glossary-presentation";
import { GlossaryRegistrationError, parsePastedGlossary, presentGlossaryLanguageTags } from "./glossary-registration";
import type { GlossaryRegistrationPreview } from "./GlossaryRegistrationDialog";
import { GlossaryWorkspace, type GlossaryWorkspaceAction } from "./GlossaryWorkspace";
import styles from "./glossary.module.css";

interface ConnectedGlossaryWorkspaceProps {
  readonly sessionSelectionLabel: string;
  readonly onSessionSelection: (selection: GlossarySessionSelection) => Promise<"pinned" | "pending">;
  readonly fetcher?: GlossaryFetcher;
}

export function ConnectedGlossaryWorkspace({ sessionSelectionLabel, onSessionSelection, fetcher = fetch }: ConnectedGlossaryWorkspaceProps) {
  const t = useSystemText(glossaryMessages);
  const [presets, setPresets] = useState<GlossaryPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<GlossaryPreset | null>(null);
  const [versions, setVersions] = useState<GlossaryDocumentVersion[]>([]);
  const [document, setDocument] = useState<GlossaryDocumentV1 | null>(null);
  const [editableTerms, setEditableTerms] = useState<EditableGlossaryTerm[]>([]);
  const [importDocument, setImportDocument] = useState<GlossaryDocumentV1 | null>(null);
  const [importPreview, setImportPreview] = useState<GlossaryImportPreviewPresentation | null>(null);
  const [registrationDocument, setRegistrationDocument] = useState<GlossaryDocumentV1 | null>(null);
  const [registrationPreview, setRegistrationPreview] = useState<GlossaryRegistrationPreview | null>(null);
  const [registrationStatus, setRegistrationStatus] = useState("");
  const [validationIssues, setValidationIssues] = useState<GlossaryValidationIssue[]>([]);
  const [feedback, setFeedback] = useState("용어집을 불러오는 중입니다.");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(true);
  const [isDraft, setIsDraft] = useState(false);
  const loadGenerationRef = useRef(0);
  const initialLoadRef = useRef<Promise<void> | null>(null);

  const loadSelectedPreset = useCallback(async (preset: GlossaryPreset) => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    const nextVersions = await listGlossaryVersions(fetcher, preset.id);
    const latestVersion = Math.max(0, ...nextVersions.map((item) => item.version));
    const versionToRead = preset.activeDocumentVersion ?? latestVersion;
    const record = versionToRead > 0 ? await readGlossaryVersion(fetcher, preset.id, versionToRead) : null;
    if (generation !== loadGenerationRef.current) return;
    setSelectedPreset(preset);
    setVersions(nextVersions);
    setDocument(record?.document ?? null);
    setEditableTerms((record?.document.terms ?? []).map((term) => ({ term, status: "approved" })));
    setIsDraft(false);
    setValidationIssues([]);
    setImportDocument(null);
    setImportPreview(null);
  }, [fetcher]);

  const refresh = useCallback(async (preferredPresetId?: string) => {
    const nextPresets = await listGlossaryPresets(fetcher);
    setPresets(nextPresets);
    const nextSelected = nextPresets.find((preset) => preset.id === preferredPresetId)
      ?? nextPresets.find((preset) => preset.id === selectedPreset?.id)
      ?? nextPresets[0];
    if (nextSelected) await loadSelectedPreset(nextSelected);
    else {
      setSelectedPreset(null);
      setVersions([]);
      setDocument(null);
      setEditableTerms([]);
    }
  }, [fetcher, loadSelectedPreset, selectedPreset?.id]);

  useEffect(() => {
    if (!initialLoadRef.current) initialLoadRef.current = refresh();
    void initialLoadRef.current.then(() => setFeedback("용어집 목록을 불러왔습니다."), (reason: unknown) => {
      setError(toSafeError(reason));
      setFeedback("");
    }).finally(() => setIsBusy(false));
  }, [refresh]);

  const run = useCallback(async (work: () => Promise<void>) => {
    setIsBusy(true);
    setError("");
    try { await work(); } catch (reason: unknown) { setError(toSafeError(reason)); }
    finally { setIsBusy(false); }
  }, []);

  const startDraft = useCallback(() => {
    const now = new Date().toISOString();
    const nextDocument = createEmptyGlossaryDocument(now);
    setSelectedPreset({
      id: "draft", name: nextDocument.name, domain: nextDocument.domain, languagePair: { a: "ko", b: "en" }, targetLanguages: ["en"],
      version: 1, activeDocumentVersion: null, activeDocumentFingerprint: null, updatedAt: now,
    });
    setDocument(nextDocument);
    setVersions([]);
    setEditableTerms([]);
    setIsDraft(true);
    setFeedback("새 용어집 초안을 만들었습니다.");
  }, []);

  const handleAction = useCallback((action: GlossaryWorkspaceAction) => {
    if (action.type === "create") { startDraft(); return; }
    if (action.type === "close-registration") {
      setRegistrationDocument(null);
      setRegistrationPreview(null);
      setRegistrationStatus("");
      return;
    }
    if (action.type === "add-term") {
      const id = `manual-${crypto.randomUUID()}`;
      const targetLanguage = document?.targetLanguages[0] ?? "en";
      setEditableTerms((current) => [...current, { status: "approved", term: {
        id, source: "", translations: { [targetLanguage]: "" }, aliases: [], pronunciation: null,
        doNotTranslate: false, forbiddenTranslations: [], context: null, examples: [], tags: [], priority: 50,
        provenance: { kind: "manual", label: "관리자 입력" },
      } }]);
      return;
    }
    if (action.type === "remove-term" || action.type === "reject-candidate") {
      setEditableTerms((current) => current.filter((item) => item.term.id !== action.termId));
      setFeedback(action.type === "reject-candidate" ? "AI 후보를 제외했습니다." : "용어를 삭제했습니다.");
      return;
    }
    if (action.type === "approve-candidate") {
      setEditableTerms((current) => current.map((item) => item.term.id === action.termId ? { ...item, status: "approved" } : item));
      setFeedback("AI 후보를 승인했습니다. 저장 전까지 서버에는 반영되지 않습니다.");
      return;
    }
    void run(async () => {
      if (action.type === "validate-registration") {
        setRegistrationDocument(null);
        setRegistrationPreview(null);
        let parsed: GlossaryDocumentV1;
        try {
          parsed = parsePastedGlossary(action.text, new Date().toISOString());
        } catch (reason: unknown) {
          const message = reason instanceof GlossaryRegistrationError ? reason.message : "붙여 넣은 내용을 해석할 수 없습니다.";
          setRegistrationStatus(message);
          throw new GlossaryClientError(message, "INVALID_REGISTRATION_PASTE");
        }
        const validated = await validateGlossaryImport(fetcher, JSON.stringify(parsed));
        setRegistrationDocument(validated);
        setRegistrationPreview({ name: validated.name, termCount: validated.terms.length, languageTags: presentGlossaryLanguageTags(validated) });
        setRegistrationStatus("검증을 마쳤습니다. 언어집 등록 버튼으로 저장하세요.");
        return;
      }
      if (action.type === "confirm-registration") {
        if (!registrationDocument) throw new GlossaryClientError("먼저 붙여 넣은 내용을 검증해 주세요.", "REGISTRATION_REQUIRED");
        const created = await createGlossaryPreset(fetcher, registrationDocument);
        setRegistrationDocument(null);
        setRegistrationPreview(null);
        setRegistrationStatus("");
        await refresh(created.id);
        setFeedback("언어집을 등록했습니다. 활성화는 별도로 진행해 주세요.");
        return;
      }
      if (action.type === "choose-import") {
        if (action.file.size > 5_000_000 || (action.file.type && action.file.type !== "application/json")) {
          throw new GlossaryClientError("5MB 이하의 JSON 용어집 파일을 선택해 주세요.", "INVALID_IMPORT_FILE");
        }
        const validated = await validateGlossaryImport(fetcher, await action.file.text());
        setImportDocument(validated);
        setImportPreview({ fileName: action.file.name, approvedCount: validated.terms.length, candidateCount: 0, ignoredCount: 0 });
        setFeedback("가져오기 검증을 마쳤습니다. 아직 저장되지 않았습니다.");
        return;
      }
      if (action.type === "confirm-import") {
        if (!importDocument) throw new GlossaryClientError("먼저 JSON 파일을 검증해 주세요.", "IMPORT_REQUIRED");
        const created = await createGlossaryPreset(fetcher, importDocument);
        await refresh(created.id);
        setFeedback("검증한 용어집을 저장했습니다. 활성화는 별도로 진행해 주세요.");
        return;
      }
      if (!selectedPreset || !document) throw new GlossaryClientError("먼저 용어집을 선택해 주세요.", "PRESET_REQUIRED");
      if (action.type === "extract-pdf") {
        if (action.file.size > 10_000_000 || action.file.type !== "application/pdf") {
          throw new GlossaryClientError("10MB 이하의 PDF 파일을 선택해 주세요.", "INVALID_PDF_FILE");
        }
        const candidates = await extractGlossaryCandidates(fetcher, action.file, {
          sourceLanguage: document.sourceLanguage, targetLanguages: document.targetLanguages, domain: document.domain,
        });
        const extracted = extractedCandidatesToEditable(candidates);
        setEditableTerms((current) => [...current, ...extracted]);
        setFeedback(`AI 후보 ${extracted.length}개를 검토 목록에 추가했습니다. 후보를 개별 승인해 주세요.`);
        return;
      }
      if (action.type === "save-draft") {
        const built = buildEditedGlossaryDocument(document, editableTerms, action.edits, new Date().toISOString());
        setValidationIssues(built.issues);
        if (!built.document) { setFeedback("입력 내용을 확인해 주세요."); return; }
        if (isDraft) {
          const created = await createGlossaryPreset(fetcher, { ...built.document, version: 1 });
          await refresh(created.id);
        } else {
          await saveGlossaryVersion(fetcher, selectedPreset.id, selectedPreset.version, built.document);
          await refresh(selectedPreset.id);
        }
        setFeedback("새 버전을 저장했습니다. 활성화는 별도로 진행해 주세요.");
        return;
      }
      const latestVersion = Math.max(0, ...versions.map((item) => item.version));
      if (action.type === "activate-version") {
        await activateGlossaryVersion(fetcher, selectedPreset.id, action.version, selectedPreset.version);
        await refresh(selectedPreset.id);
        setFeedback(`버전 ${action.version}을 활성화했습니다.`);
        return;
      }
      if (action.type === "duplicate") {
        if (!latestVersion) throw new GlossaryClientError("복제할 버전을 먼저 저장해 주세요.", "VERSION_REQUIRED");
        const duplicate = await duplicateGlossaryPreset(fetcher, selectedPreset.id, latestVersion, `${selectedPreset.name} 복사본`);
        await refresh(duplicate.id);
        setFeedback("용어집을 복제했습니다.");
        return;
      }
      if (action.type === "export") {
        if (!latestVersion) throw new GlossaryClientError("내보낼 버전을 먼저 저장해 주세요.", "VERSION_REQUIRED");
        const record = await readGlossaryVersion(fetcher, selectedPreset.id, latestVersion);
        downloadDocument(record.document, selectedPreset.id, latestVersion);
        setFeedback("용어집 파일을 준비했습니다.");
        return;
      }
      if (action.type === "select-session") {
        if (selectedPreset.activeDocumentVersion !== action.version) throw new GlossaryClientError("활성 버전만 세션에 사용할 수 있습니다.", "ACTIVE_VERSION_REQUIRED");
        const result = await onSessionSelection({ presetId: selectedPreset.id, presetName: selectedPreset.name, version: action.version });
        setFeedback(result === "pinned" ? "세션에 용어집을 적용했습니다." : "세션 생성 후 적용할 용어집으로 대기 중입니다.");
      }
    });
  }, [document, editableTerms, fetcher, importDocument, isDraft, onSessionSelection, refresh, run, selectedPreset, startDraft, versions]);

  const selectedLatestVersion = Math.max(0, ...versions.map((item) => item.version));
  const presentationPresets = useMemo(() => presets.map((preset) => presentPreset(
    preset,
    preset.id === selectedPreset?.id ? selectedLatestVersion : preset.activeDocumentVersion ?? 0,
    preset.id === selectedPreset?.id ? editableTerms.length : null,
  )), [editableTerms.length, presets, selectedLatestVersion, selectedPreset?.id]);
  const selectedPresentation = selectedPreset ? presentPreset(selectedPreset, selectedLatestVersion, editableTerms.length) : null;

  if (!selectedPresentation || !document) return (
    <section className={styles.empty} aria-label={t("용어집 관리")}>
      <p role={error ? "alert" : "status"}>{formatGlossaryStatus(error || feedback || "저장된 용어집이 없습니다.", t)}</p>
      {error && <button type="button" disabled={isBusy} onClick={() => { initialLoadRef.current = null; void run(() => refresh()); }}>{t("다시 불러오기")}</button>}
      <button type="button" disabled={isBusy} onClick={startDraft}>{t("새 용어집")}</button>
    </section>
  );
  return (
    <div>
      <GlossaryWorkspace presets={isDraft ? [selectedPresentation, ...presentationPresets] : presentationPresets}
        selectedPreset={selectedPresentation} terms={editableTerms.map((item) => presentTerm(item, document.targetLanguages[0] ?? "", document.targetLanguages))}
        versions={presentVersions(versions, selectedPresentation.activeVersion, document)} validationIssues={validationIssues}
        importPreview={importPreview} registrationPreview={registrationPreview}
        registrationStatus={error || registrationStatus}
        sessionSelectionLabel={feedback || sessionSelectionLabel} isBusy={isBusy}
        onSelectPreset={(presetId) => { const preset = presets.find((item) => item.id === presetId); if (preset) void run(() => loadSelectedPreset(preset)); }}
        onAction={handleAction} />
      {error && <p className={styles.announcement} role="alert">{formatGlossaryStatus(error, t)}</p>}
    </div>
  );
}

function toSafeError(reason: unknown): string {
  return reason instanceof GlossaryClientError ? reason.message : "용어집을 처리할 수 없습니다. 다시 시도해 주세요.";
}

function downloadDocument(document: GlossaryDocumentV1, presetId: string, version: number): void {
  const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(document)], { type: "application/json" }));
  const anchor = documentNode().createElement("a");
  anchor.href = objectUrl;
  anchor.download = `glossary-${presetId}-v${version}.json`;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

function documentNode(): Document { return globalThis.document; }
