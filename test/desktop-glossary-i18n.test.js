import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { getLanguage, hasKey, MESSAGES, setLanguage, t } from "../public/subtitle-i18n.js";

const source = readFileSync(new URL("../public/subtitle-dashboard.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/subtitle.html", import.meta.url), "utf8");
function declaration(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end + 2);
}
function element(tagName) {
  return {
    tagName, dataset: {}, children: [], textContent: "", hidden: false,
    classList: { toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {},
    addEventListener() {},
  };
}
function context(extra = {}) {
  return vm.createContext({ t, hasKey, document: { createElement: element }, ...extra });
}
test.afterEach(() => setLanguage("ko"));

test("glossary rows localize built-in copy in all UI languages without changing user names or domains", () => {
  const ctx = context();
  vm.runInContext(`${declaration("hostTargetLanguages")}\n${declaration("glossarySelectionOption")}`, ctx);
  const builtin = Object.freeze({ sourceId: "common_business", label: "공통 비즈니스", description: "회의·발표 기본 표현", targetLanguages: ["en"] });
  const user = Object.freeze({ id: "common_business", name: "내 고객 전용 용어집", domain: "절대 바꾸지 않을 입력", activeDocumentVersion: 2, languagePair: { a: "ko", b: "en" } });
  for (const language of ["ko", "en", "ja"]) {
    setLanguage(language);
    const builtinLabel = ctx.glossarySelectionOption(builtin, "builtin", new Set(), ["ja"], "ko").children[0];
    assert.equal(builtinLabel.children[1].children[0].textContent, MESSAGES[language]["glossary.builtin.common_business.label"]);
    assert.equal(builtinLabel.children[1].children[1].textContent, MESSAGES[language]["glossary.selection.targetIncompatible"]);
    assert.equal(builtinLabel.title, MESSAGES[language]["glossary.builtin.common_business.description"]);
    assert.equal(builtinLabel.children[0].disabled, true);
    const userLabel = ctx.glossarySelectionOption(user, "host", new Set(["host:common_business"]), ["en"], "ko").children[0];
    assert.equal(userLabel.children[1].children[0].textContent, user.name);
    assert.equal(userLabel.title, user.domain);
    assert.equal(userLabel.children[0].checked, true);
    assert.equal(userLabel.children[0].dataset.documentVersion, "2");
  }
});

test("glossary language refresh preserves unsaved selections and detail state without IO", () => {
  const selected = [{ sourceKind: "host", sourceId: "unsaved", documentVersion: 2 }];
  const settings = Object.freeze({ glossaries: [{ sourceKind: "builtin", sourceId: "common_business" }], glossary: "원문 = untouched" });
  const selectionStatus = element("p");
  const presetStatus = element("p");
  const customStatus = element("p");
  /** @type {{glossaries: typeof selected, glossary: string} | undefined} */
  let rendered;
  let detailRenders = 0;
  const detailState = { query: "사용자 검색", language: "ja", terms: [{ source: "원문", translations: { ja: "原文" } }] };
  const noIO = () => { throw new Error("language repaint must not fetch, save, or restart the engine"); };
  const ctx = context({
    glossarySelectionStatus: selectionStatus, glossaryPresetStatus: presetStatus,
    glossarySelectionStatusState: { key: "glossary.selection.checkConflicts", kind: "", values: {} },
    glossaryPresetStatusState: { key: "", kind: "", values: {} },
    glossaryCustomStatusState: { key: "", values: {}, message: "" },
    state: { settings }, selectedGlossaries: () => selected,
    renderGlossarySelections: (value) => { rendered = value; },
    renderGlossaryDetail: () => { detailRenders += 1; }, glossaryDetailState: detailState,
    document: { getElementById: (id) => id === "glossary-detail-overlay" ? { hidden: false } : id === "glossary-custom-status" ? customStatus : null },
    fetch: noIO, saveSettings: noIO, reconfigureRunningSession: noIO,
  });
  for (const name of ["setGlossarySelectionStatus", "setGlossaryPresetStatus", "setGlossaryCustomStatus", "refreshGlossarySystemLanguagePresentation"]) {
    vm.runInContext(declaration(name), ctx);
  }
  ctx.setGlossarySelectionStatus("glossary.selection.selected", "", { count: 2 });
  ctx.setGlossaryPresetStatus("glossary.error.DESKTOP_BRIDGE_UNAVAILABLE", "error");
  ctx.setGlossaryCustomStatus("glossary.detailCustomSaved", { line: "고객 이름 = Customer name" });
  for (const language of ["en", "ja", "ko"]) {
    setLanguage(language);
    ctx.refreshGlossarySystemLanguagePresentation();
    assert.equal(selectionStatus.textContent, t("glossary.selection.selected", { count: 2 }));
    assert.equal(presetStatus.textContent, t("glossary.error.DESKTOP_BRIDGE_UNAVAILABLE"));
    assert.equal(customStatus.textContent, t("glossary.detailCustomSaved", { line: "고객 이름 = Customer name" }));
    assert.ok(rendered);
    assert.equal(rendered.glossaries, selected);
    assert.equal(rendered.glossary, settings.glossary);
    assert.equal(detailState.query, "사용자 검색");
    assert.equal(detailState.language, "ja");
  }
  assert.equal(detailRenders, 3);
  assert.equal(settings.glossaries[0].sourceId, "common_business");
});

test("open glossary details translate only chrome and keep original terms, targets, and context verbatim", () => {
  const nodes = new Map(["title", "meta", "languages", "terms", "more"].map((name) => [`glossary-detail-${name}`, element("div")]));
  const term = Object.freeze({ source: "<script>고객 원문</script>", translations: Object.freeze({ en: "Customer original", ja: "お客様の原文" }), context: "사용자 작성 문맥" });
  const detail = { label: "공통 비즈니스", sourceKind: "builtin", sourceId: "common_business", sourceLanguage: "ko", targetLanguages: ["en", "ja"], terms: [term], language: "ja", query: "고객" };
  const ctx = context({
    document: { createElement: element, getElementById: (id) => nodes.get(id) },
    glossaryDetailState: detail, GLOSSARY_DETAIL_RENDER_CAP: 200,
  });
  vm.runInContext(`${declaration("glossaryDetailFilteredTerms")}\n${declaration("renderGlossaryDetail")}`, ctx);
  for (const language of ["en", "ja", "ko"]) {
    setLanguage(language);
    ctx.renderGlossaryDetail();
    assert.equal(nodes.get("glossary-detail-title").textContent, t("glossary.builtin.common_business.label"));
    assert.deepEqual(nodes.get("glossary-detail-terms").children[0].children.map((child) => child.textContent), [term.source, term.translations.ja, term.context]);
    assert.equal(detail.language, "ja");
    assert.equal(detail.query, "고객");
  }
  detail.sourceKind = "host";
  detail.label = "고객 전용 원래 제목";
  ctx.renderGlossaryDetail();
  assert.equal(nodes.get("glossary-detail-title").textContent, detail.label);
});

test("legacy built-in preset titles localize but user and cached preset names remain verbatim", () => {
  const ctx = context();
  vm.runInContext(declaration("glossaryPresetDisplayName"), ctx);
  for (const language of ["ko", "en", "ja"]) {
    setLanguage(language);
    const preset = { id: "hotel-investment-en-ko", label: "호텔 투자 (EN↔KO)", source: "builtin" };
    assert.equal(ctx.glossaryPresetDisplayName(preset), t("glossary.presetLabel.hotel-investment-en-ko"));
    assert.equal(ctx.glossaryPresetDisplayName({ ...preset, source: "user", name: "사용자 제목" }), "사용자 제목");
    assert.equal(ctx.glossaryPresetDisplayName({ ...preset, source: "cached", name: "사용자 제목" }), "사용자 제목");
  }
});

test("glossary group labels use declarative translation while dynamic status retains its own message", () => {
  for (const key of ["glossary.selection.legend", "glossary.selection.builtins", "glossary.selection.users"]) {
    assert.ok(html.includes(`data-i18n="${key}"`), key);
    for (const language of ["ko", "en", "ja"]) assert.equal(typeof MESSAGES[language][key], "string", `${language}:${key}`);
  }
  assert.doesNotMatch(html, /id="glossary-selection-status"[^>]*data-i18n=/u);
  assert.ok(source.includes("subscribeToLanguage(refreshGlossarySystemLanguagePresentation)"));
  assert.equal(getLanguage(), "ko");
});
