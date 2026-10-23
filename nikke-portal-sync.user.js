// ==UserScript==
// @name         NIKKE Portal 저장 데이터 연동
// @namespace    https://ssissun.github.io/nikke-hub/
// @version      2.0.0
// @description  NIKKE Portal 같은 모음 페이지 안에서 연 사이트가 원래 사이트에 직접 들어갔을 때와 같은 저장 데이터(localStorage)를 쓰게 맞춥니다
// @match        *://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @updateURL    https://ssissun.github.io/nikke-portal/nikke-portal-sync.user.js
// @downloadURL  https://ssissun.github.io/nikke-portal/nikke-portal-sync.user.js
// ==/UserScript==

(() => {
  "use strict";

  const HUB_NAME = "nikke-hub-sync"; // 모음 페이지가 연동할 iframe에 붙이는 이름
  const PORTAL_ORIGIN = "https://ssissun.github.io";
  const HUB_FLAG = "nikke-hub-sync:hub";
  const K_ORIGINS = "origins"; // 모음 페이지 안에서 열린 적 있는 사이트 = 직접 접속 시 연동할 사이트
  const SKIP_KEY = /token|auth|session|jwt|credential|password|secret/i; // 로그인 정보로 보이는 키는 옮기지 않는다
  const POLL_MS = 2000;
  const MAX_BACKUPS = 20;

  // 덱마다 id가 있는 배열 → 통째로 덮지 않고 id 기준으로 합친다
  function mergeById(baseStr, localStr, sharedStr, preferLocal) {
    const parse = s => {
      if (s === undefined) return [];
      const a = JSON.parse(s);
      if (!Array.isArray(a) || a.some(d => !d || d.id == null)) throw new Error("not an id list");
      return a;
    };
    let b, l, s;
    try { b = parse(baseStr); l = parse(localStr); s = parse(sharedStr); } catch { return null; }
    const byId = a => new Map(a.map(d => [d.id, JSON.stringify(d)]));
    const B = byId(b), L = byId(l), S = byId(s);
    const value = [], lost = [];
    for (const id of new Set([...s.map(d => d.id), ...l.map(d => d.id)])) {
      const bv = B.get(id), lv = L.get(id), sv = S.get(id);
      let keep;
      if (lv === sv) keep = lv;
      else if (lv === undefined) keep = sv === bv ? undefined : sv; // 이쪽에서 지움: 저쪽이 고쳤으면 살림
      else if (sv === undefined) keep = lv === bv ? undefined : lv;
      else if (lv === bv) keep = sv;
      else if (sv === bv) keep = lv;
      else { keep = preferLocal ? lv : sv; lost.push(JSON.parse(preferLocal ? sv : lv)); }
      if (keep !== undefined) value.push(JSON.parse(keep));
    }
    return { value: JSON.stringify(value), lost: lost.length ? JSON.stringify(lost) : undefined };
  }

  const MERGERS = {
    "https://nikke-deck.com": { "saved-decks": mergeById },
  };

  const origin = location.origin;

  // ancestorOrigins가 없는 브라우저(Firefox)는 처음 열릴 때의 referrer로 판별
  function topOrigin() {
    const anc = location.ancestorOrigins;
    if (anc && anc.length) return anc[anc.length - 1];
    try { return new URL(document.referrer).origin; } catch { return null; }
  }

  function detectContext() {
    if (window.top === window) {
      const known = GM_getValue(K_ORIGINS, []).includes(origin) || GM_getValue(`shared:${origin}`) !== undefined;
      return known ? "direct" : null;
    }
    // 사이트가 window.name을 바꿔도 이 iframe 안에서는 처음 판별한 모음 페이지를 기억
    let hub = null;
    try {
      hub = sessionStorage.getItem(HUB_FLAG);
      if (!hub && window.name === HUB_NAME) { hub = topOrigin(); if (hub) sessionStorage.setItem(HUB_FLAG, hub); }
    } catch { hub = window.name === HUB_NAME ? topOrigin() : null; }
    if (!hub || hub === origin) return null; // 같은 출처끼리는 저장소가 같아서 맞출 것이 없다
    const list = GM_getValue(K_ORIGINS, []);
    if (!list.includes(origin)) GM_setValue(K_ORIGINS, [...list, origin]);
    return hub === PORTAL_ORIGIN ? "hub" : `hub:${hub}`; // 포털은 1.x와 같은 키를 써서 기존 연동 상태를 잇는다
  }

  const ctx = detectContext();
  if (!ctx) return;
  try { localStorage.length; } catch { return; }

  const K_SHARED = `shared:${origin}`;
  const K_BASE = `base:${origin}:${ctx}`;
  const K_BACKUP = `backup:${origin}`;
  const mergers = MERGERS[origin] || {};

  const kstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19) + "+09:00";

  function readLocal() {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!SKIP_KEY.test(k)) out[k] = localStorage.getItem(k);
    }
    return out;
  }
  const writeLocal = (k, v) => v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v);

  function updateShared(delta) {
    if (!Object.keys(delta).length) return;
    const shared = GM_getValue(K_SHARED, {});
    for (const [k, v] of Object.entries(delta)) {
      if (v === undefined) delete shared[k]; else shared[k] = v;
    }
    GM_setValue(K_SHARED, shared);
  }

  function addBackup(from, reason, data) {
    if (!Object.keys(data).length) return;
    const list = GM_getValue(K_BACKUP, []);
    list.unshift({ at: kstNow(), from, reason, data });
    GM_setValue(K_BACKUP, list.slice(0, MAX_BACKUPS));
  }

  let lastSynced = null;

  // 공유본(GM 저장소)과 이 칸의 localStorage를 맞춘다. base = 이 칸이 마지막으로 맞춘 값
  function sync(atLoad) {
    const local = readLocal();
    const localJson = JSON.stringify(local);
    if (!atLoad && localJson === lastSynced) return;

    const shared = GM_getValue(K_SHARED);
    if (!shared) {
      // 원본은 직접 접속한 쪽. 모음 페이지는 원본이 올라오기 전까지 아무것도 올리지 않는다
      if (ctx === "direct") { GM_setValue(K_SHARED, local); GM_setValue(K_BASE, local); }
      lastSynced = localJson;
      return;
    }

    let base = GM_getValue(K_BASE);
    // 사이트 데이터를 지운 경우: 전부 삭제로 올리지 않고 공유본에서 다시 받는다
    if (atLoad && base && !Object.keys(local).length) base = undefined;
    if (!base && !atLoad) return; // 처음 합류는 페이지를 새로 열 때만
    const joining = !base;
    const preferLocal = !joining && ctx === "direct"; // 충돌 시 직접 접속 쪽 값을 남긴다
    const lostFrom = preferLocal ? "shared" : ctx;

    const delta = {}, lost = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(shared), ...Object.keys(base || {})])) {
      if (SKIP_KEY.test(k)) continue;
      const l = local[k], s = shared[k], b = base?.[k];
      if (l === s) continue;
      const localChanged = joining || l !== b;
      const sharedChanged = joining || s !== b;
      let next, lostVal;
      if (!localChanged) {
        if (!atLoad) continue; // 실행 중인 페이지에는 받은 값을 넣지 않는다 (페이지가 들고 있는 값으로 다시 덮을 수 있음)
        next = s;
      } else if (!sharedChanged) {
        next = l;
      } else {
        const merged = mergers[k]?.(b, l, s, preferLocal);
        if (merged) { next = merged.value; lostVal = merged.lost; }
        else { next = preferLocal ? l : s; lostVal = preferLocal ? s : l; }
      }
      if (next !== l) writeLocal(k, next);
      if (next !== s) delta[k] = next;
      if (lostVal !== undefined) lost[k] = lostVal;
    }

    addBackup(lostFrom, joining ? "join" : "conflict", lost);
    updateShared(delta);
    const now = readLocal();
    GM_setValue(K_BASE, now);
    lastSynced = JSON.stringify(now);
  }

  const REASONS = { join: "첫 연동", conflict: "양쪽 동시 수정", restore: "복원 전 값" };
  const FROM = { hub: "포털", direct: "직접 접속", shared: "모음 페이지" };
  const fromLabel = from => FROM[from] || from.replace(/^hub:https?:\/\//, "");

  function restoreBackup() {
    const list = GM_getValue(K_BACKUP, []);
    if (!list.length) { alert("이 사이트에 저장된 백업이 없습니다."); return; }
    const lines = list.map((b, i) =>
      `${i + 1}. ${b.at.slice(0, 16).replace("T", " ")} · ${fromLabel(b.from)} · ${REASONS[b.reason]} · ${Object.keys(b.data).join(", ")}`);
    const pick = list[Number(prompt(`복원할 백업 번호를 입력하세요.\n\n${lines.join("\n")}`)) - 1];
    if (!pick) return;
    if (!confirm("백업한 값을 지금 데이터에 되살립니다. 덮어써지는 지금 값은 새 백업으로 남깁니다. 계속할까요?")) return;

    sync(false);
    const local = readLocal(), before = {}, delta = {};
    for (const [k, v] of Object.entries(pick.data)) {
      // id 목록은 지금 목록에 백업 항목을 다시 합친다 (같은 id는 백업 쪽을 살림)
      const merged = mergers[k]?.(undefined, v, local[k], true);
      const next = merged ? merged.value : v;
      const overwritten = merged ? merged.lost : local[k];
      if (next === local[k]) continue;
      if (overwritten !== undefined) before[k] = overwritten;
      writeLocal(k, next);
      delta[k] = next;
    }
    addBackup(ctx, "restore", before);
    if (GM_getValue(K_SHARED)) {
      updateShared(delta);
      GM_setValue(K_BASE, readLocal());
    }
    location.reload();
  }

  sync(true);
  setInterval(() => sync(false), POLL_MS);
  addEventListener("pagehide", () => sync(false));
  GM_registerMenuCommand("백업 복원", restoreBackup);
})();
