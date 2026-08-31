import {
  GlossaryDocumentMergeError,
  compileGlossaryDocumentV1,
  mergeCompiledGlossariesV1,
  normalizeMergeKey,
} from "./glossary-document.js";

// resolveGlossarySelection is a thin catalog-level wrapper over the single
// production merge implementation, mergeCompiledGlossariesV1 — it validates a
// catalog selection, delegates the actual term folding, and reshapes merge
// failures into reportable results. It used to be a 266-line parallel merge
// with subtly different normalization (NFC vs NFKC) and conflict semantics;
// keeping one implementation means tests and production can no longer drift.

export const MAX_GLOSSARY_SELECTIONS = 5;

export function normalizeGlossarySelectionKey(value) {
  return normalizeMergeKey(value);
}

export function resolveGlossarySelection(input) {
  if (!input || typeof input !== "object") return failure("INVALID_GLOSSARY_SELECTION", []);
  const { catalog, selectedIds } = input;
  if (!Array.isArray(catalog) || !Array.isArray(selectedIds)
    || selectedIds.some((id) => typeof id !== "string" || !id.trim())) {
    return failure("INVALID_GLOSSARY_SELECTION", []);
  }
  if (selectedIds.length > MAX_GLOSSARY_SELECTIONS) {
    return failure("TOO_MANY_GLOSSARY_SELECTIONS", [String(selectedIds.length)]);
  }
  if (new Set(selectedIds).size !== selectedIds.length) {
    return failure("DUPLICATE_GLOSSARY_SELECTION", [...selectedIds].sort());
  }
  const catalogById = new Map();
  for (const entry of catalog) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id) {
      return failure("INVALID_GLOSSARY_CATALOG", []);
    }
    catalogById.set(entry.id, entry);
  }
  const unknown = selectedIds.filter((id) => !catalogById.has(id));
  if (unknown.length > 0) return failure("UNKNOWN_GLOSSARY_SELECTION", unknown.sort());
  // Sorting makes the merge click-order independent: merge output depends on
  // input order only through first-seen term identity and the domain string.
  const orderedIds = [...selectedIds].sort();
  if (orderedIds.length === 0) {
    return Object.freeze({
      ok: true,
      code: null,
      selectedIds: [],
      document: null,
      fingerprint: null,
      conflicts: [],
      stats: Object.freeze({ sourceTerms: 0, uniqueTerms: 0, duplicateTermsRemoved: 0, unresolvedConflicts: 0 }),
    });
  }
  const compiled = [];
  for (const id of orderedIds) {
    try {
      compiled.push(compileGlossaryDocumentV1(catalogById.get(id).document));
    } catch {
      return failure("INVALID_GLOSSARY_CATALOG", [id]);
    }
  }
  let merged;
  try {
    merged = mergeCompiledGlossariesV1(compiled, { selectionLimit: MAX_GLOSSARY_SELECTIONS });
  } catch (error) {
    if (error instanceof GlossaryDocumentMergeError) {
      if (error.code === "GLOSSARY_TRANSLATION_CONFLICT") {
        return Object.freeze({
          ok: false,
          code: error.code,
          selectedIds: orderedIds,
          conflicts: enrichConflicts(error.conflicts ?? [], orderedIds, compiled),
        });
      }
      return failure(error.code, (error.conflicts ?? []).map((value) => String(value)));
    }
    return failure("INVALID_GLOSSARY_CATALOG", []);
  }
  const sourceTerms = compiled.reduce((sum, document) => sum + document.terms.length, 0);
  return Object.freeze({
    ok: true,
    code: null,
    selectedIds: orderedIds,
    document: merged,
    fingerprint: merged.fingerprint,
    conflicts: [],
    stats: Object.freeze({
      sourceTerms,
      uniqueTerms: merged.terms.length,
      duplicateTermsRemoved: sourceTerms - merged.terms.length,
      unresolvedConflicts: 0,
    }),
  });
}

// Merge reports each conflict as {source, targetLanguage, left, right}; the
// selection surface additionally names the glossaries involved and the tied
// priority so the UI can tell the host WHICH packs disagree.
function enrichConflicts(conflicts, orderedIds, compiled) {
  return conflicts.map((conflict) => {
    const key = normalizeMergeKey(conflict.source);
    const glossaryIds = [];
    let priority = 0;
    for (const [index, document] of compiled.entries()) {
      const term = document.terms.find((candidate) => normalizeMergeKey(candidate.source) === key
        && typeof candidate.translations?.[conflict.targetLanguage] === "string");
      if (!term) continue;
      glossaryIds.push(orderedIds[index]);
      priority = Math.max(priority, term.priority ?? 0);
    }
    return Object.freeze({
      source: conflict.source,
      targetLanguage: conflict.targetLanguage,
      priority,
      translations: [conflict.left, conflict.right].sort(),
      glossaryIds: glossaryIds.sort(),
    });
  });
}

function failure(code, details) {
  return Object.freeze({ ok: false, code, details: Object.freeze([...details]), conflicts: Object.freeze([]) });
}
