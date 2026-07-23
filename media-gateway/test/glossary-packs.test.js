import assert from "node:assert/strict";
import test from "node:test";

import { buildGlossaryInstruction, glossaryContract } from "../src/glossary-packs.js";

test("every industry pack includes the same base idiom contract", () => {
  for (const pack of ["general_cre", "hotel", "fnb"]) {
    const instruction = buildGlossaryInstruction(pack);
    for (const idiom of glossaryContract.baseIdioms) assert.match(instruction, new RegExp(escapeRegExp(idiom), "u"));
  }
});

test("industry packs contain the required core operating vocabulary", () => {
  const expectedTerms = {
    general_cre: ["NOI", "cap rate", "market rent", "tenant improvement allowance", "percentage rent", "overage rent", "comp set"],
    hotel: ["ADR", "occupancy", "RevPAR", "TRevPAR", "GOPPAR", "flow-through", "flex", "competitive set"],
    fnb: ["covers", "table turn", "food cost", "prime cost", "percentage rent", "tenant improvement allowance", "common area maintenance"],
  };
  for (const [pack, terms] of Object.entries(expectedTerms)) {
    const instruction = buildGlossaryInstruction(pack);
    for (const term of terms) assert.match(instruction.toLowerCase(), new RegExp(escapeRegExp(term.toLowerCase()), "u"));
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
