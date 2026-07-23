// Gemini Live Translation does not accept instructions; these packs are used
// only by the Meeting text-translation stage, where prompt constraints exist.
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

const INDUSTRY_TERMS = Object.freeze({
  general_cre: [
    "NOI: net operating income",
    "cap rate: capitalization rate",
    "market rent: rent achievable in the current open market",
    "tenant improvement allowance: landlord contribution to tenant fit-out",
    "percentage rent: rent calculated as a percentage of tenant sales",
    "overage rent: percentage rent above an agreed sales breakpoint",
    "comp set: comparable or competitive property set",
  ],
  hotel: [
    "ADR: average daily rate",
    "occupancy: percentage of available rooms sold",
    "RevPAR: revenue per available room",
    "TRevPAR: total revenue per available room",
    "GOPPAR: gross operating profit per available room",
    "flow-through: share of incremental revenue converted to profit",
    "flex: reduction of expenses as revenue declines",
    "competitive set: hotels used for performance benchmarking",
  ],
  fnb: [
    "covers: number of guests served",
    "table turn: reuse of a table for a new party",
    "food cost: ingredient cost as a share of food sales",
    "prime cost: combined cost of ingredients and direct labor",
    "percentage rent: rent calculated as a percentage of restaurant sales",
    "tenant improvement allowance: landlord contribution to restaurant fit-out",
    "common area maintenance: tenant share of operating common areas",
  ],
});

export function buildGlossaryInstruction(glossaryPack) {
  const industryTerms = INDUSTRY_TERMS[glossaryPack];
  if (!industryTerms) throw new Error("INVALID_GLOSSARY_PACK");
  return [
    "Translate naturally while preserving names, numbers, and business meaning.",
    "Interpret these base idioms by meaning:",
    ...BASE_IDIOMS.map((entry) => `- ${entry}`),
    `Apply this ${glossaryPack} glossary:`,
    ...industryTerms.map((entry) => `- ${entry}`),
  ].join("\n");
}

export const glossaryContract = Object.freeze({
  baseIdioms: BASE_IDIOMS,
  industryTerms: INDUSTRY_TERMS,
});
