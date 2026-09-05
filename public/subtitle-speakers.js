const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function validateSpeakerDraft(speakers, activeOnsiteSpeakerId) {
  if (!Array.isArray(speakers) || speakers.length > 30) throw new Error("발언자는 최대 30명까지 등록할 수 있습니다.");
  if (activeOnsiteSpeakerId && !speakers.some(value => value.id === activeOnsiteSpeakerId)) throw new Error("등록된 현장 발언자를 선택해 주세요.");
  const ids = new Set(); const participants = new Set();
  return speakers.map(speaker => {
    if (!UUID.test(speaker.id) || ids.has(speaker.id)) throw new Error("발언자 정보를 확인해 주세요.");
    ids.add(speaker.id);
    const text = (key, maximum, required = false) => {
      const value = typeof speaker[key] === "string" ? speaker[key].normalize("NFC").trim() : "";
      if ((required && !value) || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("이름은 40자, 회사와 부서는 80자 이내로 입력해 주세요.");
      return value;
    };
    if (speaker.participantId && (!UUID.test(speaker.participantId) || participants.has(speaker.participantId))) throw new Error("온라인 참여자 연결이 중복되었습니다.");
    if (speaker.participantId) participants.add(speaker.participantId);
    if (speaker.photoAssetId && !UUID.test(speaker.photoAssetId)) throw new Error("사진을 다시 선택해 주세요.");
    if (activeOnsiteSpeakerId && !speakers.some(value => value.id === activeOnsiteSpeakerId)) throw new Error("등록된 현장 발언자를 선택해 주세요.");
    return { id: speaker.id, version: speaker.version || 1, displayName: text("displayName", 40, true),
      company: text("company", 80), department: text("department", 80), photoAssetId: speaker.photoAssetId || null, participantId: speaker.participantId || null };
  });
}

function resultError(result) {
  const conflict = /CONFLICT|REVISION/u.test(result?.code ?? "");
  return new Error(conflict ? "다른 화면에서 명단이 변경되었습니다. 새로고침한 뒤 다시 수정해 주세요." : "발언자 정보를 저장하거나 불러오지 못했습니다. 다시 시도해 주세요.");
}

export function createSpeakerRosterModel(bridge, onChange = (_state) => {}) {
  let state = { sessionId: null, revision: 0, appliedRevision: 0, activeOnsiteSpeakerId: null, speakers: [], dirty: false, busy: false, error: "" };
  let loaded = false;
  const photos = new Map();
  function update(patch) { state = { ...state, ...patch }; onChange(getState()); }
  function getState() { return { ...state, pending: state.revision > state.appliedRevision, speakers: state.speakers.map(speaker => ({ ...speaker })) }; }
  function accept(data) {
    if (!data || data.sessionId !== state.sessionId || !Number.isSafeInteger(data.revision)
      || !Number.isSafeInteger(data.appliedRevision) || data.appliedRevision > data.revision) throw resultError(null);
    validateSpeakerDraft(data.speakers, data.activeOnsiteSpeakerId);
    loaded = true;
    update({ revision: data.revision, appliedRevision: data.appliedRevision, speakers: data.speakers,
      activeOnsiteSpeakerId: data.activeOnsiteSpeakerId, dirty: false, error: "" });
  }
  async function refresh() {
    if (!state.sessionId || state.busy || state.dirty) return;
    const id = state.sessionId;
    const result = await bridge.getLiveCallSpeakers(id);
    if (id !== state.sessionId || state.dirty || state.busy) return;
    if (!result?.ok) throw resultError(result);
    accept(result.data);
  }
  async function save() {
    if (state.busy) throw new Error("발언자 정보를 저장 중입니다.");
    if (!state.sessionId) return;
    update({ busy: true, error: "" });
    try {
      if (!loaded) {
        const result = await bridge.getLiveCallSpeakers(state.sessionId);
        if (!result?.ok) throw resultError(result);
        if (state.dirty && (result.data?.speakers?.length || result.data?.revision > 0)) throw new Error("이 세션에는 이미 발언자가 있습니다. 새로고침한 뒤 수정해 주세요.");
        if (state.dirty) { update({ revision: result.data.revision, appliedRevision: result.data.appliedRevision }); loaded = true; }
        else { accept(result.data); return; }
      }
      if (!state.dirty) return;
      let speakers = validateSpeakerDraft(state.speakers, state.activeOnsiteSpeakerId);
      for (const [id, photo] of photos) {
        const result = await bridge.uploadLiveCallSpeakerPhoto(state.sessionId, photo);
        if (!result?.ok) throw resultError(result);
        speakers = speakers.map(speaker => speaker.id === id ? { ...speaker, photoAssetId: result.data.photoAssetId } : speaker);
        update({ speakers }); photos.delete(id);
      }
      const result = await bridge.saveLiveCallSpeakers(state.sessionId, { expectedRevision: state.revision, speakers, activeOnsiteSpeakerId: state.activeOnsiteSpeakerId });
      if (!result?.ok) throw resultError(result);
      accept(result.data);
    } catch (error) { update({ error: error.message }); throw error; }
    finally { update({ busy: false }); }
  }
  async function persistForSession(sessionId) {
    if (state.sessionId && state.sessionId !== sessionId && state.dirty) throw new Error("이전 세션의 발언자 저장을 먼저 완료해 주세요.");
    if (state.sessionId !== sessionId) { loaded = false; update({ sessionId }); }
    return save();
  }
  return { getState, refresh, save, persistForSession,
    setDraft(speakers, activeOnsiteSpeakerId) {
      if (state.busy) throw new Error("발언자 정보를 저장 중입니다.");
      const normalized = validateSpeakerDraft(speakers, activeOnsiteSpeakerId);
      for (const id of photos.keys()) if (!normalized.some(speaker => speaker.id === id)) photos.delete(id);
      update({ speakers: normalized, activeOnsiteSpeakerId, dirty: true, error: "" });
    },
    setPhoto(id, photo) {
      if (!PHOTO_TYPES.has(photo?.contentType) || !(photo?.bytes instanceof Uint8Array) || photo.bytes.byteLength > MAX_PHOTO_BYTES || photo.bytes.byteLength === 0) throw new Error("2MB 이하의 JPEG, PNG, WebP 사진을 선택해 주세요.");
      photos.set(id, photo); update({ dirty: true });
    },
    async loadSession(sessionId) { if (state.dirty) throw new Error("수정 중인 발언자 정보를 먼저 저장해 주세요."); loaded = false; update({ sessionId, error: "" }); await refresh(); },
    async reload() { photos.clear(); update({ dirty: false }); await refresh(); },
    reset() { if (state.busy) return; photos.clear(); loaded = false; update({ sessionId: null, revision: 0, appliedRevision: 0, activeOnsiteSpeakerId: null, speakers: [], dirty: false, error: "" }); },
  };
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function action(text, handler) {
  const button = element("button", text);
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}
function statusText(state) {
  if (state.error) return state.error;
  if (state.busy) return "저장 중";
  if (state.dirty) return state.sessionId ? "저장하지 않은 변경 사항" : "세션 생성 시 저장됩니다";
  if (state.pending) return "저장됨 · 실시간 적용 대기";
  return state.sessionId ? "실시간 적용됨" : "등록된 발언자가 없습니다";
}

export function createSpeakerIdentity(speaker, sessionId, bridge) {
  const identity = element("span", undefined, "speaker-identity");
  const avatar = element("span", speaker?.displayName?.slice(0, 1) || "?", "speaker-avatar");
  avatar.setAttribute("aria-hidden", "true");
  const text = element("span", undefined, "speaker-identity-text");
  text.append(element("strong", speaker?.displayName || "발언자 미지정"));
  const affiliation = [speaker?.company, speaker?.department].filter(Boolean).join(" · ");
  if (affiliation) text.append(element("span", affiliation, "speaker-muted"));
  identity.append(avatar, text);
  if (speaker?.photoAssetId && sessionId && bridge?.liveCallReadSpeakerPhoto) {
    void readSpeakerPhoto(sessionId, speaker.photoAssetId, bridge).then(url => {
      if (!url) return;
      const image = element("img"); image.alt = ""; image.src = url;
      image.onerror = () => { avatar.textContent = speaker.displayName.slice(0, 1); };
      avatar.replaceChildren(image);
    }).catch(() => {});
  }
  return identity;
}

export function mountSpeakerRoster(root, bridge) {
  if (!root || !bridge) return null;
  root.classList.add("speaker-roster");
  const heading = element("div", undefined, "speaker-heading");
  heading.append(element("h2", "발언자"));
  const add = action("발언자 추가", () => openEditor(null));
  heading.append(add);
  const sessionLabel = element("p", "새 세션 명단", "speaker-muted");
  const list = element("div", undefined, "speaker-list");
  const status = element("p", "", "speaker-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const tools = element("div", undefined, "speaker-actions");
  const save = action("저장", () => run(() => model.save()));
  const reload = action("새로고침", () => run(() => model.reload()));
  const current = action("현재 세션", () => run(async () => {
    const state = await bridge.getLiveCallState();
    if (!state?.sessionId) throw new Error("준비하거나 진행 중인 세션이 없습니다.");
    await model.loadSession(state.sessionId);
  }));
  const reset = action("새 명단", () => { model.reset(); });
  for (const [button, key] of [[save, "speaker-save"], [reload, "speaker-reload"], [current, "speaker-current"], [reset, "speaker-reset"]]) button.dataset.novaHelp = key;
  tools.append(save, reload, current, reset);
  const draftNotice = element("p", "새로고침이나 초기화하면 저장하지 않은 변경 사항이 지워집니다.", "speaker-muted"); draftNotice.hidden = true;
  root.append(heading, sessionLabel, list, tools, draftNotice, status);
  let listKey = "";
  const model = createSpeakerRosterModel(bridge, render);
  async function run(operation) {
    try { await operation(); } catch (error) { status.textContent = error.message; }
  }
  function render(state) {
    status.textContent = statusText(state);
    draftNotice.hidden = !state.dirty;
    sessionLabel.textContent = state.sessionId ? "선택한 세션의 발언자 명단" : "새 세션 명단";
    add.disabled = state.busy || state.speakers.length >= 30;
    save.hidden = !state.sessionId; save.disabled = state.busy || !state.dirty;
    reload.hidden = !state.sessionId; reload.disabled = state.busy;
    current.disabled = state.busy || state.dirty; reset.disabled = state.busy;
    reset.textContent = state.dirty ? "초기화" : "새 명단";
    const key = JSON.stringify([state.sessionId, state.speakers, state.activeOnsiteSpeakerId, state.busy]);
    if (listKey === key) return;
    listKey = key;
    list.replaceChildren();
    if (!state.speakers.length) list.append(element("p", "발언자를 추가해 주세요.", "speaker-muted"));
    for (const speaker of state.speakers) {
      const row = element("div", undefined, "speaker-row");
      row.append(createSpeakerIdentity(speaker, state.sessionId, bridge));
      const buttons = element("div", undefined, "speaker-actions");
      const choose = action(speaker.id === state.activeOnsiteSpeakerId ? "현장 선택됨" : "현장 선택", () => run(async () => {
        model.setDraft(model.getState().speakers, speaker.id);
        if (state.sessionId) await model.save();
      }));
      choose.dataset.novaHelp = "speaker-select";
      choose.setAttribute("aria-label", `${speaker.displayName} 현장 발언자로 선택`);
      choose.setAttribute("aria-pressed", String(speaker.id === state.activeOnsiteSpeakerId));
      choose.disabled = state.busy;
      const edit = action("수정", () => openEditor(speaker)); edit.setAttribute("aria-label", `${speaker.displayName} 프로필 수정`); edit.disabled = state.busy;
      buttons.append(choose, edit); row.append(buttons); list.append(row);
    }
  }
  const dialog = element("dialog", undefined, "speaker-editor");
  const form = element("form", undefined, "speaker-editor-layout");
  const header = element("header"); const title = element("h2", "발언자 추가");
  title.id = "speaker-editor-title"; dialog.setAttribute("aria-labelledby", title.id);
  const close = action("닫기", () => dialog.close()); header.append(title, close);
  const body = element("div", undefined, "speaker-editor-body");
  const fields = {};
  for (const [key, label, length] of [["displayName", "이름", 40], ["company", "회사", 80], ["department", "부서", 80]]) {
    const wrapper = element("label", label); const input = element("input");
    input.name = key; input.maxLength = length; input.required = key === "displayName"; input.autocomplete = "off";
    wrapper.append(input); body.append(wrapper); fields[key] = input;
  }
  const photoLabel = element("label", "사진 · JPEG, PNG, WebP · 최대 2MB");
  const photo = element("input"); photo.type = "file"; photo.accept = "image/jpeg,image/png,image/webp";
  photoLabel.append(photo); body.append(photoLabel);
  const mappingLabel = element("label", "온라인 참여자 연결");
  const mapping = element("select"); mappingLabel.append(mapping); body.append(mappingLabel);
  const mappingStatus = element("p", "", "speaker-muted"); body.append(mappingStatus);
  const preview = element("div", undefined, "speaker-photo-preview"); body.append(preview);
  const error = element("p", "", "speaker-status"); error.setAttribute("role", "alert"); body.append(error);
  const footer = element("footer"); const submit = element("button", "저장"); submit.type = "submit";
  const remove = action("발언자 삭제", async () => {
    if (!editing || model.getState().busy) return;
    const state = model.getState();
    try {
      model.setDraft(state.speakers.filter(speaker => speaker.id !== editing.id), state.activeOnsiteSpeakerId === editing.id ? null : state.activeOnsiteSpeakerId);
      if (state.sessionId) await model.save();
      dialog.close(); add.focus();
    } catch (failure) { error.textContent = failure.message; }
  });
  const cancel = action("닫기", () => dialog.close()); footer.append(remove, cancel, submit);
  form.append(header, body, footer); dialog.append(form); document.body.append(dialog);
  let editing = null; let opening = 0;
  let localPhotoUrl = null;
  const releasePhotoPreview = () => { if (localPhotoUrl) URL.revokeObjectURL(localPhotoUrl); localPhotoUrl = null; };
  dialog.addEventListener("close", releasePhotoPreview);
  photo.addEventListener("change", () => {
    releasePhotoPreview(); preview.replaceChildren(); error.textContent = "";
    const file = photo.files?.[0];
    if (!file) return;
    if (!PHOTO_TYPES.has(file.type) || file.size > MAX_PHOTO_BYTES || file.size === 0) {
      error.textContent = "2MB 이하의 JPEG, PNG, WebP 사진을 선택해 주세요.";
      photo.value = "";
      return;
    }
    localPhotoUrl = URL.createObjectURL(file);
    const image = element("img"); image.alt = "선택한 발언자 사진"; image.src = localPhotoUrl;
    image.width = 80; image.height = 80; image.style.objectFit = "cover";
    preview.append(image);
  });
  async function openEditor(speaker) {
    editing = speaker; const token = ++opening;
    remove.hidden = !speaker;
    const state = model.getState();
    for (const [key, input] of Object.entries(fields)) input.value = speaker?.[key] || "";
    photo.value = ""; error.textContent = ""; title.textContent = speaker ? "발언자 수정" : "발언자 추가";
    preview.replaceChildren(); if (speaker) preview.append(createSpeakerIdentity(speaker, state.sessionId, bridge));
    mapping.replaceChildren(); const none = element("option", "연결 안 함"); none.value = ""; mapping.append(none);
    mapping.disabled = !state.sessionId;
    mappingStatus.textContent = state.sessionId ? "참여자 불러오는 중" : "세션 생성 후 참여자를 연결할 수 있습니다.";
    dialog.showModal(); fields.displayName.focus();
    if (!state.sessionId) return;
    try {
      const result = await bridge.listLiveCallSpeakerParticipants(state.sessionId);
      if (token !== opening || !dialog.open) return;
      if (!result?.ok) throw resultError(result);
      const participants = result.data?.participants || [];
      const currentParticipant = participants.find(participant => participant.participantId === speaker?.participantId);
      if (speaker?.participantId && !currentParticipant) {
        const old = element("option", "기존 연결 · 현재 목록에 없음"); old.value = speaker.participantId; mapping.append(old);
      }
      for (const participant of participants) {
        const option = element("option", `${participant.displayName || "참여자"}${participant.isPresent ? " · 접속 중" : " · 오프라인"}`);
        option.value = participant.participantId;
        option.disabled = state.speakers.some(value => value.id !== speaker?.id && value.participantId === participant.participantId);
        mapping.append(option);
      }
      mapping.value = speaker?.participantId || "";
      mappingStatus.textContent = participants.length ? "" : "입장한 참여자가 없습니다.";
    } catch { mapping.disabled = true; mappingStatus.textContent = "참여자를 불러오지 못했습니다. 닫고 다시 시도해 주세요."; }
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    submit.disabled = true; close.disabled = true; cancel.disabled = true; error.textContent = "";
    try {
      const state = model.getState();
      const id = editing?.id || crypto.randomUUID();
      const speaker = { id, version: editing?.version || 1, displayName: fields.displayName.value,
        company: fields.company.value, department: fields.department.value, photoAssetId: editing?.photoAssetId || null,
        participantId: mapping.disabled ? editing?.participantId || null : mapping.value || null };
      const speakers = editing ? state.speakers.map(value => value.id === id ? speaker : value) : [...state.speakers, speaker];
      validateSpeakerDraft(speakers, state.activeOnsiteSpeakerId);
      const file = photo.files?.[0];
      if (file && (!PHOTO_TYPES.has(file.type) || file.size > MAX_PHOTO_BYTES || file.size === 0)) throw new Error("2MB 이하의 JPEG, PNG, WebP 사진을 선택해 주세요.");
      model.setDraft(speakers, state.activeOnsiteSpeakerId);
      // 2026-09-05 fix: Retain this exact profile ID on an upload/save retry; another submit must not add a duplicate.
      editing = speaker;
      if (file) { model.setPhoto(id, { contentType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }); photo.value = ""; }
      if (state.sessionId) await model.save();
      dialog.close(); add.focus();
    } catch (failure) { error.textContent = failure.message; }
    finally { submit.disabled = false; close.disabled = false; cancel.disabled = false; }
  });
  dialog.addEventListener("cancel", event => { if (model.getState().busy) event.preventDefault(); });
  render(model.getState());
  const timer = window.setInterval(() => {
    if (root.closest(".workspace-page")?.classList.contains("is-active") && !dialog.open) void run(() => model.refresh());
  }, 2000);
  window.addEventListener("pagehide", () => { window.clearInterval(timer); dialog.remove(); }, { once: true });
  return model;
}

export function mountSpeakerController(root, trigger, bridge) {
  if (!root || !trigger || !bridge?.getLiveCallSpeakers) return;
  const current = root.querySelector("[data-speaker-current]");
  const list = root.querySelector("[data-speaker-options]");
  const status = root.querySelector("[data-speaker-status]");
  const retry = root.querySelector("[data-speaker-retry]");
  let state = null; let busy = false; let sessionId = null; let renderKey = "";
  let currentFloor = null;
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const active = await bridge.getLiveCallState();
      trigger.hidden = !active?.sessionId;
      if (!active?.sessionId) { root.hidden = true; sessionId = null; state = null; return; }
      if (sessionId !== active.sessionId) { state = null; renderKey = ""; }
      sessionId = active.sessionId;
      currentFloor = active.bridge?.floorSnapshot?.holder?.participantId || null;
      const result = await bridge.getLiveCallSpeakers(sessionId);
      if (!result?.ok) throw resultError(result);
      state = result.data;
      render(); retry.hidden = true;
    } catch (error) { status.textContent = error.message; retry.hidden = false; }
    finally { busy = false; }
  }
  function render() {
    const online = currentFloor ? state.speakers.find(speaker => speaker.participantId === currentFloor) : null;
    const selected = currentFloor ? online : state.speakers.find(speaker => speaker.id === state.activeOnsiteSpeakerId);
    const label = currentFloor ? (selected?.displayName || "온라인 참여자") : (selected?.displayName || "현장 발언자 미지정");
    trigger.querySelector("span").textContent = label;
    status.textContent = state.revision > state.appliedRevision ? "저장됨 · 실시간 적용 대기" : "실시간 적용됨";
    const key = JSON.stringify([sessionId, state.speakers, state.activeOnsiteSpeakerId, currentFloor]);
    if (renderKey === key) return;
    renderKey = key;
    current.replaceChildren(createSpeakerIdentity(selected || { displayName: label }, sessionId, bridge));
    current.append(element("p", currentFloor ? "온라인 발언 중 · 현장 선택은 온라인 발언 종료 후 적용" : "현장 발언 · 호스트 지정", "speaker-muted"));
    list.replaceChildren();
    if (!state.speakers.length) list.append(element("p", "메인 화면의 Live Call에서 발언자를 추가해 주세요.", "speaker-muted"));
    for (const speaker of state.speakers) {
      const button = action("", () => { void select(speaker.id); });
      button.className = "speaker-choice";
      button.append(createSpeakerIdentity(speaker, sessionId, bridge));
      button.setAttribute("aria-pressed", String(speaker.id === state.activeOnsiteSpeakerId));
      button.setAttribute("aria-label", `${speaker.displayName} 현장 발언자로 선택`);
      list.append(button);
    }
    const clear = action("현장 발언자 지정 해제", () => { void select(null); });
    list.append(clear);
  }
  async function select(id) {
    if (busy || !state) return;
    busy = true; retry.hidden = true;
    for (const button of list.querySelectorAll("button")) button.disabled = true;
    status.textContent = "저장 중";
    try {
      const result = await bridge.saveLiveCallSpeakers(sessionId, { expectedRevision: state.revision, speakers: state.speakers, activeOnsiteSpeakerId: id });
      if (!result?.ok) throw resultError(result);
      state = result.data; renderKey = ""; render();
    } catch (error) { status.textContent = error.message; retry.hidden = false; }
    finally { busy = false; for (const button of list.querySelectorAll("button")) button.disabled = false; }
  }
  retry.addEventListener("click", () => { void refresh(); });
  trigger.addEventListener("click", () => { void refresh(); });
  const timer = window.setInterval(() => { void refresh(); }, 2000);
  window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
  void refresh();
}

const speakerPhotoCache = new Map();
const speakerPhotoLoads = new Map();
let speakerPhotoCacheBytes = 0;
const speakerLabelRequests = new WeakMap();

export async function readSpeakerPhoto(sessionId, photoAssetId, bridge) {
  if (!UUID.test(sessionId) || !UUID.test(photoAssetId) || !bridge?.liveCallReadSpeakerPhoto) return null;
  const key = `${sessionId}:${photoAssetId}`;
  if (speakerPhotoCache.has(key)) return speakerPhotoCache.get(key);
  if (speakerPhotoLoads.has(key)) return speakerPhotoLoads.get(key);
  const pending = (async () => {
    const result = await bridge.liveCallReadSpeakerPhoto({ sessionId, photoAssetId });
    if (!result?.ok || !PHOTO_TYPES.has(result.data?.contentType) || typeof result.data?.imageBase64 !== "string"
      || !result.data.imageBase64 || result.data.imageBase64.length > Math.ceil(MAX_PHOTO_BYTES * 4 / 3) + 4
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(result.data.imageBase64)) return null;
    const url = `data:${result.data.contentType};base64,${result.data.imageBase64}`;
    while (speakerPhotoCache.size >= 30 || speakerPhotoCacheBytes + url.length > 12 * 1024 * 1024) {
      const first = speakerPhotoCache.keys().next().value;
      if (!first) break;
      speakerPhotoCacheBytes -= speakerPhotoCache.get(first).length;
      speakerPhotoCache.delete(first);
    }
    // 2026-09-05 fix: Concurrent overlay lanes may finish one photo simultaneously; account for the existing entry once.
    if (!speakerPhotoCache.has(key)) { speakerPhotoCache.set(key, url); speakerPhotoCacheBytes += url.length; }
    return url;
  })();
  speakerPhotoLoads.set(key, pending);
  try { return await pending; }
  finally { if (speakerPhotoLoads.get(key) === pending) speakerPhotoLoads.delete(key); }

}

export function renderCaptionSpeakerProfile(label, profile, sessionId, bridge, fallbackText = "") {
  const request = {};
  speakerLabelRequests.set(label, request);
  if (!profile || typeof profile.displayName !== "string" || !profile.displayName.trim()) {
    if (label.textContent !== fallbackText) label.textContent = fallbackText;
    return;
  }
  const name = profile.displayName.trim().slice(0, 40);
  const affiliation = [profile.company, profile.department].filter(value => typeof value === "string" && value.trim()).map(value => value.trim().slice(0, 80));
  const avatar = document.createElement("span");
  avatar.className = "speaker-caption-avatar"; avatar.textContent = name.slice(0, 1);
  avatar.setAttribute("aria-hidden", "true");
  Object.assign(avatar.style, { width: "28px", height: "28px", flex: "0 0 28px", display: "inline-grid", placeItems: "center", overflow: "hidden", borderRadius: "980px", marginRight: "8px" });
  const text = document.createElement("span"); text.textContent = [name, ...affiliation].join(" · ");
  Object.assign(text.style, { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" });
  label.replaceChildren(avatar, text);
  if (!profile.photoAssetId) return;
  void readSpeakerPhoto(sessionId, profile.photoAssetId, bridge).then(url => {
    if (!url || speakerLabelRequests.get(label) !== request) return;
    const image = document.createElement("img"); image.alt = ""; image.src = url;
    image.onerror = () => { if (speakerLabelRequests.get(label) === request) avatar.textContent = name.slice(0, 1); };
    Object.assign(image.style, { width: "100%", height: "100%", objectFit: "cover" });
    avatar.replaceChildren(image);
  }).catch(() => {});
}
