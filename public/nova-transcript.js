export const MAX_TRANSCRIPT_ROWS = 200;

const MAX_TRANSCRIPT_TEXT_LENGTH = 4_000;
const MAX_TRANSCRIPT_ID_LENGTH = 128;
const MAX_TRANSCRIPT_META_LENGTH = 120;
const DEFAULT_LATEST_THRESHOLD = 48;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * @typedef {object} NovaTranscriptElement
 * @property {string} className
 * @property {boolean} hidden
 * @property {unknown} parentNode
 * @property {number} scrollTop
 * @property {number} scrollHeight
 * @property {number} clientHeight
 * @property {string} textContent
 * @property {((options: { top: number, behavior?: ScrollBehavior }) => void) | undefined} [scrollTo]
 * @property {(child: unknown) => unknown} appendChild
 * @property {(child: unknown) => unknown} removeChild
 * @property {(name: string, value: string) => void} setAttribute
 * @property {((type: string, listener: () => void) => void) | undefined} [addEventListener]
 * @property {((type: string, listener: () => void) => void) | undefined} [removeEventListener]
 */

/** @typedef {{ createElement: (tagName: string) => unknown }} NovaTranscriptDocument */

/**
 * @typedef {object} NovaTranscriptRendererOptions
 * @property {unknown} container
 * @property {unknown} [scrollElement]
 * @property {unknown} [documentRef]
 * @property {number} [maxRows]
 * @property {number} [latestThreshold]
 * @property {ScrollBehavior} [scrollBehavior]
 * @property {Partial<Record<"row" | "metadata" | "avatar" | "speaker" | "time" | "type" | "status" | "source" | "translation", string>>} [classNames]
 * @property {(state: Readonly<{ isAtLatest: boolean, hasUnseenLatest: boolean }>) => void} [onLatestChange]
 */

function normalizeString(value, limit) {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFC").replace(CONTROL_CHARACTERS, "").trim();
  return Array.from(normalized).slice(0, limit).join("");
}

function normalizeLimit(value) {
  if (!Number.isFinite(value) || value < 1) return MAX_TRANSCRIPT_ROWS;
  return Math.min(Math.floor(value), MAX_TRANSCRIPT_ROWS);
}

function normalizeFilterValues(value) {
  if (!value) return new Set();
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : [value];
  return new Set(values.map((item) => normalizeString(item, MAX_TRANSCRIPT_META_LENGTH)).filter(Boolean));
}

function normalizeFilters(filters = {}) {
  return Object.freeze({
    query: normalizeString(filters.query, MAX_TRANSCRIPT_TEXT_LENGTH).toLocaleLowerCase(),
    types: normalizeFilterValues(filters.types),
    statuses: normalizeFilterValues(filters.statuses),
  });
}

export function normalizeTranscriptEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError("Transcript entry must be an object.");
  }

  const id = normalizeString(entry.id, MAX_TRANSCRIPT_ID_LENGTH);
  if (!id) throw new TypeError("Transcript entry id is required.");

  return Object.freeze({
    id,
    sourceText: normalizeString(entry.sourceText, MAX_TRANSCRIPT_TEXT_LENGTH),
    translatedText: normalizeString(entry.translatedText, MAX_TRANSCRIPT_TEXT_LENGTH),
    speaker: normalizeString(entry.speaker, MAX_TRANSCRIPT_META_LENGTH),
    time: normalizeString(entry.time, MAX_TRANSCRIPT_META_LENGTH),
    type: normalizeString(entry.type, MAX_TRANSCRIPT_META_LENGTH) || "general",
    status: normalizeString(entry.status, MAX_TRANSCRIPT_META_LENGTH) || "final",
  });
}

export function upsertTranscriptEntry(entries, entry, options = {}) {
  const currentEntries = Array.isArray(entries) ? entries : [];
  const normalizedEntry = normalizeTranscriptEntry(entry);
  const existingIndex = currentEntries.findIndex((item) => item.id === normalizedEntry.id);
  const nextEntries = existingIndex >= 0
    ? currentEntries.map((item, index) => (index === existingIndex ? normalizedEntry : item))
    : [...currentEntries, normalizedEntry];

  return Object.freeze(nextEntries.slice(-normalizeLimit(options.limit)));
}

export function filterTranscriptEntries(entries, filters = {}) {
  const normalizedFilters = normalizeFilters(filters);
  const currentEntries = Array.isArray(entries) ? entries : [];

  return currentEntries.filter((entry) => {
    if (normalizedFilters.types.size > 0 && !normalizedFilters.types.has(entry.type)) return false;
    if (normalizedFilters.statuses.size > 0 && !normalizedFilters.statuses.has(entry.status)) return false;
    if (!normalizedFilters.query) return true;

    const searchableText = [
      entry.sourceText,
      entry.translatedText,
      entry.speaker,
      entry.time,
      entry.type,
      entry.status,
    ].join(" ").normalize("NFC").toLocaleLowerCase();
    return searchableText.includes(normalizedFilters.query);
  });
}

export function isTranscriptAtLatest(element, options = {}) {
  if (!element) return true;
  const threshold = Number.isFinite(options.threshold)
    ? Math.max(0, options.threshold)
    : DEFAULT_LATEST_THRESHOLD;
  const remainingDistance = element.scrollHeight - element.clientHeight - element.scrollTop;
  return remainingDistance <= threshold;
}

export function scrollTranscriptToLatest(element, options = {}) {
  if (!element) return;
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ top: element.scrollHeight, behavior: options.behavior });
    return;
  }
  element.scrollTop = element.scrollHeight;
}

function compatibleClassName(baseClassName, alias) {
  const normalizedAlias = normalizeString(alias, MAX_TRANSCRIPT_META_LENGTH);
  return normalizedAlias ? `${baseClassName} ${normalizedAlias}` : baseClassName;
}

function createTextElement(documentRef, tagName, className, alias = "") {
  const createdElement = documentRef.createElement(tagName);
  if (!createdElement || typeof createdElement !== "object" || !("appendChild" in createdElement)) {
    throw new TypeError("The transcript document returned an invalid element.");
  }
  const element = /** @type {NovaTranscriptElement} */ (createdElement);
  element.className = compatibleClassName(className, alias);
  return element;
}

function createTranscriptRow(documentRef, classNames) {
  const row = createTextElement(documentRef, "article", "nova-transcript-row", classNames.row);
  const metadata = createTextElement(documentRef, "header", "nova-transcript-row__metadata", classNames.metadata);
  const avatar = classNames.avatar
    ? createTextElement(documentRef, "span", "nova-transcript-row__avatar", classNames.avatar)
    : null;
  const speaker = createTextElement(documentRef, "span", "nova-transcript-row__speaker", classNames.speaker);
  const time = createTextElement(documentRef, "time", "nova-transcript-row__time", classNames.time);
  const type = createTextElement(documentRef, "span", "nova-transcript-row__type", classNames.type);
  const status = createTextElement(documentRef, "span", "nova-transcript-row__status", classNames.status);
  const source = createTextElement(documentRef, "p", "nova-transcript-row__source", classNames.source);
  const translation = createTextElement(documentRef, "p", "nova-transcript-row__translation", classNames.translation);

  if (avatar) {
    avatar.setAttribute("aria-hidden", "true");
    metadata.appendChild(avatar);
  }
  metadata.appendChild(speaker);
  metadata.appendChild(time);
  metadata.appendChild(type);
  metadata.appendChild(status);
  row.appendChild(metadata);
  row.appendChild(source);
  row.appendChild(translation);

  return { row, avatar, speaker, time, type, status, source, translation };
}

function updateTranscriptRow(nodes, entry) {
  nodes.row.setAttribute("data-transcript-id", entry.id);
  nodes.row.setAttribute("data-transcript-type", entry.type);
  nodes.row.setAttribute("data-transcript-status", entry.status);
  if (nodes.avatar) nodes.avatar.textContent = Array.from(entry.speaker || "S")[0]?.toLocaleUpperCase() || "S";
  nodes.speaker.textContent = entry.speaker;
  nodes.time.textContent = entry.time;
  nodes.type.textContent = entry.type;
  nodes.status.textContent = entry.status;
  nodes.source.textContent = entry.sourceText;
  nodes.translation.textContent = entry.translatedText;
}

/**
 * @param {NovaTranscriptRendererOptions} options
 */
export function createNovaTranscriptRenderer(options) {
  const {
    container,
    scrollElement = container,
    documentRef = globalThis.document,
    maxRows = MAX_TRANSCRIPT_ROWS,
    latestThreshold = DEFAULT_LATEST_THRESHOLD,
    scrollBehavior = "auto",
    classNames = {},
    onLatestChange = () => {},
  } = options ?? /** @type {NovaTranscriptRendererOptions} */ ({ container: null });
  if (!container || typeof container !== "object" || !("appendChild" in container)
    || typeof container.appendChild !== "function") {
    throw new TypeError("A transcript container is required.");
  }
  if (!documentRef || typeof documentRef !== "object" || !("createElement" in documentRef)
    || typeof documentRef.createElement !== "function") {
    throw new TypeError("A document with createElement is required.");
  }

  const transcriptContainer = /** @type {NovaTranscriptElement} */ (container);
  if (!scrollElement || typeof scrollElement !== "object" || !("scrollTop" in scrollElement)) {
    throw new TypeError("A transcript scroll element is required.");
  }
  const transcriptScrollElement = /** @type {NovaTranscriptElement} */ (scrollElement);
  const transcriptDocument = /** @type {NovaTranscriptDocument} */ (documentRef);
  const compatibleClassNames = classNames && typeof classNames === "object" ? classNames : {};

  const rowLimit = normalizeLimit(maxRows);
  const rowNodes = new Map();
  let entries = Object.freeze([]);
  let filters = normalizeFilters();
  let hasUnseenLatest = false;
  let isAtLatest = isTranscriptAtLatest(transcriptScrollElement, { threshold: latestThreshold });

  const viewState = () => Object.freeze({ isAtLatest, hasUnseenLatest });
  const notifyLatestChange = () => onLatestChange(viewState());

  const render = () => {
    const activeIds = new Set(entries.map((entry) => entry.id));
    const visibleIds = new Set(filterTranscriptEntries(entries, filters).map((entry) => entry.id));

    for (const [id, nodes] of rowNodes) {
      if (activeIds.has(id)) continue;
      if (nodes.row.parentNode === transcriptContainer && typeof transcriptContainer.removeChild === "function") {
        transcriptContainer.removeChild(nodes.row);
      }
      rowNodes.delete(id);
    }

    for (const entry of entries) {
      const nodes = rowNodes.get(entry.id) ?? createTranscriptRow(transcriptDocument, compatibleClassNames);
      if (!rowNodes.has(entry.id)) rowNodes.set(entry.id, nodes);
      updateTranscriptRow(nodes, entry);
      nodes.row.hidden = !visibleIds.has(entry.id);
      transcriptContainer.appendChild(nodes.row);
    }
  };

  const followLatestIfNeeded = (wasAtLatest) => {
    if (wasAtLatest) {
      scrollTranscriptToLatest(transcriptScrollElement, { behavior: scrollBehavior });
      isAtLatest = true;
      hasUnseenLatest = false;
    } else {
      isAtLatest = false;
      hasUnseenLatest = true;
    }
    notifyLatestChange();
  };

  const handleScroll = () => {
    isAtLatest = isTranscriptAtLatest(transcriptScrollElement, { threshold: latestThreshold });
    if (isAtLatest) hasUnseenLatest = false;
    notifyLatestChange();
  };

  transcriptScrollElement.addEventListener?.("scroll", handleScroll);

  return Object.freeze({
    update(entry) {
      const wasAtLatest = isTranscriptAtLatest(transcriptScrollElement, { threshold: latestThreshold });
      entries = upsertTranscriptEntry(entries, entry, { limit: rowLimit });
      render();
      followLatestIfNeeded(wasAtLatest);
      return viewState();
    },
    replace(nextEntries) {
      const wasAtLatest = isTranscriptAtLatest(transcriptScrollElement, { threshold: latestThreshold });
      entries = (Array.isArray(nextEntries) ? nextEntries : []).reduce(
        (currentEntries, entry) => upsertTranscriptEntry(currentEntries, entry, { limit: rowLimit }),
        Object.freeze([]),
      );
      render();
      followLatestIfNeeded(wasAtLatest);
      return viewState();
    },
    setFilters(nextFilters = {}) {
      filters = normalizeFilters(nextFilters);
      render();
      return filterTranscriptEntries(entries, filters);
    },
    render,
    getEntries() {
      return entries.slice();
    },
    getViewState: viewState,
    moveToLatest() {
      scrollTranscriptToLatest(transcriptScrollElement, { behavior: scrollBehavior });
      isAtLatest = true;
      hasUnseenLatest = false;
      notifyLatestChange();
      return viewState();
    },
    destroy() {
      transcriptScrollElement.removeEventListener?.("scroll", handleScroll);
    },
  });
}
