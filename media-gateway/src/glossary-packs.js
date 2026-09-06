import { getBuiltInGlossary } from "../../packages/caption-core/index.js";

// Session terminology flows through pinned compiled glossaries (translation
// prompts + the bounded STT vocabulary path). What remains here is only the
// polisher's standing default-domain instruction; the legacy per-pack
// selection (hotel/fnb) is gone — glossaryPack never reached a prompt.
const BASE_IDIOMS = Object.freeze([
  "현주소: current landscape or current state, never a physical address",
  "숙제: remaining challenge in business contexts, never homework",
  "옥석 가리기: separating the wheat from the chaff",
  "큰 그림: big picture",
  "마중물: catalyst or pump-priming",
  "dry powder: 대기 자금 or uncommitted investment capital",
  "ballpark figure: an approximate estimate, not a literal place",
  "touch base: make brief contact, not physical touching",
  "on the same page: share the same understanding",
  "move the needle: create a meaningful measurable change",
  "soft landing: 연착륙",
  "headwinds and tailwinds: 역풍 and 훈풍",
]);

const DEFAULT_DOMAIN_TERMS = Object.freeze([
    "NOI: net operating income",
    "cap rate: capitalization rate",
    "market rent: rent achievable in the current open market",
    "tenant improvement allowance: landlord contribution to tenant fit-out",
    "percentage rent: rent calculated as a percentage of tenant sales",
    "overage rent: percentage rent above an agreed sales breakpoint",
    "comp set: comparable or competitive property set",
    // Service-line vocabulary from the CRE consulting townhall decks. Each of
    // these has a plausible everyday reading that is wrong in a CRE session.
    "PM: property management of a building, never project management (that is PDS)",
    "PDS: project and development services",
    "disposition advisory: a mandate to sell an asset, never waste disposal",
    "plant disposal: the sale of a factory, never scrapping or discarding it",
    "tenant representation: advising the tenant side of a lease, a service line",
    "principal work: acting as principal on a deal rather than as an agent",
    "identified stock assets: existing building stock, never equities and never accounting inventory",
    "assigned: a mandate that has been won, never merely allocated",
    "closed: a transaction that has completed, never shut down",
    "key wins: mandates newly won in the period, never victories in a contest",
    "collaboration that delivers: collaboration that produces results, never courier delivery",
    "share of voice: share of press coverage in the market",
    "pax: the number of people a space accommodates",
    "GFA: gross floor area, as opposed to net leasable area",
]);

export function buildDefaultDomainInstruction() {
  return [
    "Translate naturally while preserving names, numbers, and business meaning.",
    // Korean counts in myriads, English business speech in million/billion —
    // the magnitude must survive the notation change, so spell the rule out.
    "Convert number SCALES into the target language's business notation, keeping the magnitude and currency identical and never applying an exchange rate:",
    "- Korean 만/억/조 are 10^4/10^8/10^12; English output uses million/billion/trillion (3,000억 원 = KRW 300 billion, 5,000만 원 = KRW 50 million, 1조 5,000억 원 = KRW 1.5 trillion).",
    "- Korean output reverses it (KRW 300 billion = 3,000억 원, USD 30 million = 3,000만 달러); never leave 'billion'/'million' or a bare 억/조 in the wrong language.",
    "- Percentages, years, quarters, floor areas, and headcounts are copied as spoken.",
    "Interpret these base idioms by meaning:",
    ...BASE_IDIOMS.map((entry) => `- ${entry}`),
    "Apply this commercial real estate glossary:",
    ...DEFAULT_DOMAIN_TERMS.map((entry) => `- ${entry}`),
  ].join("\n");
}

export function resolveBuiltInGlossaryDocument(sourceId, documentVersion) {
  if (documentVersion !== 1) throw new Error("INVALID_BUILT_IN_GLOSSARY_VERSION");
  const glossary = getBuiltInGlossary(sourceId);
  if (!glossary || glossary.document.version !== documentVersion) {
    throw new Error("UNKNOWN_BUILT_IN_GLOSSARY");
  }
  return glossary.document;
}

export const glossaryContract = Object.freeze({
  baseIdioms: BASE_IDIOMS,
  defaultDomainTerms: DEFAULT_DOMAIN_TERMS,
});
