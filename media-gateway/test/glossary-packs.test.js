import assert from "node:assert/strict";
import test from "node:test";

import { buildDefaultDomainInstruction, glossaryContract } from "../src/glossary-packs.js";

// glossaryPack stopped selecting anything at runtime long ago: sessions carry
// their terminology through pinned compiled glossaries, and the polisher's
// standing domain instruction is the single CRE default below. The legacy
// hotel/fnb packs were dead weight and are gone.

test("the default domain instruction includes the base idiom contract", () => {
  const instruction = buildDefaultDomainInstruction();
  for (const idiom of glossaryContract.baseIdioms) {
    assert.match(instruction, new RegExp(escapeRegExp(idiom), "u"));
  }
});

test("the default domain instruction keeps the core CRE operating vocabulary", () => {
  const instruction = buildDefaultDomainInstruction().toLowerCase();
  for (const term of ["NOI", "cap rate", "market rent", "tenant improvement allowance", "percentage rent", "overage rent", "comp set"]) {
    assert.match(instruction, new RegExp(escapeRegExp(term.toLowerCase()), "u"));
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
