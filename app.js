/* Moteur commun aux carnets (carnet-de-mots.html, carnet-it.html).
   Chaque page définit window.DECK (clés de stockage, fichiers, libellés) puis charge
   son fichier de données (BASE_ENTRIES, TYPE_LABELS, GROUP_LABELS, GROUP_OF, BLAGUE_TYPES). */
(function (root) {
"use strict";

/* ==========================================================================
   NOYAU — sans DOM, exporté tel quel sous Node pour pouvoir être testé
   ========================================================================== */
const DAY_MS = 86400000;
// Délai (en jours) avant de revoir une carte, selon sa « boîte ».
const INTERVALS = { 1: 1, 2: 3, 3: 7, 4: 21, 5: 60 };

function isoDay(d) {
  const m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
}
function dayNumber(d) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}
function b64enc(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64dec(str) { return decodeURIComponent(escape(atob(str))); }

function plainText(html) {
  return String(html == null ? "" : html)
    .replace(/<li>/gi, " • ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}
function fold(s) {
  return plainText(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function shuffle(list, rnd) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor((rnd || Math.random)() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ---------- opérations rejouables (une par fichier synchronisé) ---------- */
function applyWordOp(list, op) {
  if (op.type === "add") return list.concat([op.entry]);
  if (op.type === "delete") return list.filter(e => e.id !== op.id);
  if (op.type === "edit") return list.map(e => (e.id === op.id ? Object.assign({}, e, op.patch) : e));
  if (op.type === "seed") return op.list;
  if (op.type === "merge") {
    const known = {};
    list.forEach(e => { known[e.id] = true; });
    return list.concat(op.entries.filter(e => !known[e.id]));
  }
  return list;
}
function applyProgressOp(state, op) {
  let tags = Object.assign({}, state.tags), focus = Object.assign({}, state.focus);
  if (op.type === "tag") {
    if (op.value === null) delete tags[op.id]; else tags[op.id] = op.value;
  } else if (op.type === "focus") {
    if (op.value === null) delete focus[op.id]; else focus[op.id] = true;
  } else if (op.type === "merge") {
    tags = Object.assign({}, tags, op.tags);
    focus = Object.assign({}, focus, op.focus);
  }
  return { tags: tags, focus: focus };
}
function applyStudyOp(state, op) {
  const srs = Object.assign({}, state.srs), days = Object.assign({}, state.days);
  if (op.t === "srs") {
    if (op.b === null) delete srs[op.id]; else srs[op.id] = [op.b, op.d];
  } else if (op.t === "day") {
    days[op.k] = (days[op.k] || 0) + (op.n || 1);
  }
  return { srs: srs, days: days };
}
const normWords = raw => (Array.isArray(raw) ? raw : []);
const normProgress = raw => ({ tags: (raw && raw.tags) || {}, focus: (raw && raw.focus) || {} });
const normStudy = raw => ({ srs: (raw && raw.srs) || {}, days: (raw && raw.days) || {} });

/* ---------- fichier synchronisé avec GitHub ----------
   Le stockage local n'est qu'un cache : le fichier du dépôt fait référence. Chaque
   modification est appliquée tout de suite en local, mise en file, puis rejouée
   par-dessus la version distante la plus fraîche (PUT conditionnel au sha, nouvel
   essai en cas de conflit) pour que deux appareils fusionnent au lieu de s'écraser. */
function createStore(o) {
  let state = o.load();
  let inFlight = false, again = false, timer = null, pendingSince = 0;

  const readQueue = () => { try { return JSON.parse(o.storage.getItem(o.queueKey) || "[]"); } catch (e) { return []; } };
  const writeQueue = q => { o.storage.setItem(o.queueKey, JSON.stringify(q)); };
  const url = () => "https://api.github.com/repos/" + o.gh.owner + "/" + o.gh.repo + "/contents/" + o.path;
  const headers = extra => {
    const h = Object.assign({ Accept: "application/vnd.github+json" }, extra || {});
    const t = o.gh.token();
    if (t) h.Authorization = "Bearer " + t;
    return h;
  };
  const setStatus = s => { if (o.onStatus) o.onStatus(s); };

  async function get() {
    // no-store : sinon le navigateur peut resservir pendant 60 s la version d'avant notre propre PUT.
    const res = await o.fetch(url() + "?ref=" + encodeURIComponent(o.gh.branch), { headers: headers(), cache: "no-store" });
    if (res.status === 404) return { state: o.normalize(null), sha: null };
    if (!res.ok) throw new Error("GitHub GET " + res.status);
    const data = await res.json();
    let raw = null;
    try { raw = JSON.parse(b64dec((data.content || "").replace(/\n/g, ""))); } catch (e) { raw = null; }
    return { state: o.normalize(raw), sha: data.sha };
  }
  async function put(next, sha) {
    const body = { message: o.message(next), content: b64enc(JSON.stringify(next, null, 2)), branch: o.gh.branch };
    if (sha) body.sha = sha;
    const res = await o.fetch(url(), { method: "PUT", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) { const e = new Error("conflict"); e.conflict = true; throw e; }
    if (!res.ok) throw new Error("GitHub PUT " + res.status);
  }

  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(sync, ms);
  }

  async function sync() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!o.gh.token()) { setStatus("no-token"); return "no-token"; }
    if (inFlight) { again = true; return "busy"; }
    inFlight = true; again = false; pendingSince = 0;
    setStatus("syncing");
    let result = "error";
    try {
      for (let attempt = 0; attempt < 4 && result !== "synced"; attempt++) {
        const remote = await get();
        const sent = readQueue();
        if (!sent.length) {
          state = remote.state;
          o.save(state);
          result = "synced";
          break;
        }
        const merged = sent.reduce(o.apply, remote.state);
        try {
          await put(merged, remote.sha);
        } catch (e) {
          if (e && e.conflict) continue;
          throw e;
        }
        // Ne retirer de la file que ce qui vient d'être envoyé : une modification faite
        // pendant l'envoi reste en file et repart à la synchro suivante.
        const rest = readQueue().slice(sent.length);
        writeQueue(rest);
        state = rest.reduce(o.apply, merged);
        o.save(state);
        if (rest.length) again = true;
        result = "synced";
      }
      if (result !== "synced") throw new Error("Trop de conflits de synchro");
      setStatus("synced");
      if (o.onChange) o.onChange(state, "remote");
    } catch (e) {
      result = "error";
      setStatus("error");
      if (o.onError) o.onError(e);
    } finally {
      inFlight = false;
      if (again) schedule(300);
    }
    return result;
  }

  function enqueue(ops, immediate) {
    ops.forEach(op => { state = o.apply(state, op); });
    o.save(state);
    const q = readQueue();
    ops.forEach(op => { q.push(op); });
    writeQueue(q);
    if (o.onChange) o.onChange(state, "local");
    if (immediate || !o.debounce) return sync();
    // Regrouper une rafale (une session = dix réponses) en quelques envois au lieu de dix.
    const now = Date.now();
    if (!pendingSince) pendingSince = now;
    schedule(Math.max(0, Math.min(o.debounce, pendingSince + (o.maxWait || 8000) - now)));
    return null;
  }

  return {
    get: () => state,
    enqueue: enqueue,
    sync: sync,
    pending: () => readQueue().length,
    flush: () => (readQueue().length ? sync() : null),
  };
}

/* ---------- répétition espacée ---------- */
function isDue(tag, srs, today) {
  if (tag === "a_apprendre") return !srs || srs[1] <= today;
  if (tag === "appris") return !!srs && srs[1] <= today;
  return false;
}
function gradeResult(prev, knew, today) {
  if (!knew) return { b: 1, d: today + INTERVALS[1], tag: "a_apprendre" };
  const b = Math.max(2, Math.min(5, prev ? prev[0] + 1 : 2));
  return { b: b, d: today + INTERVALS[b], tag: "appris" };
}
function computeStreak(days, now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Une journée pas encore commencée ne casse pas la série : on compte à partir d'hier.
  if (!(days[isoDay(d)] > 0)) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days[isoDay(d)] > 0) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ---------- composition d'une session ----------
   c : { entries, source, size, today, tagOf(id), srsOf(id), isFocus(id), isNew(entry), funGroups, rnd } */
function buildSession(c) {
  const size = c.size || 10, rnd = c.rnd || Math.random;
  const fun = c.funGroups || [];
  const usable = c.entries.filter(e => e.def);
  const tag = e => c.tagOf(e.id), foc = e => c.isFocus(e.id);
  const due = e => isDue(tag(e), c.srsOf(e.id), c.today);
  const dueRank = e => {
    const s = c.srsOf(e.id);
    return (tag(e) === "a_apprendre" ? 0 : 1e6) + (s ? s[1] : -1e5);
  };
  const byDue = list => list.slice().sort((x, y) => dueRank(x) - dueRank(y));
  let picks;

  if (c.source === "focus") {
    const f = usable.filter(foc);
    picks = byDue(f.filter(due))
      .concat(shuffle(f.filter(e => !tag(e)), rnd), shuffle(f.filter(e => tag(e) && !due(e)), rnd))
      .slice(0, size);
  } else if (c.source === "todo") {
    const t = usable.filter(e => tag(e) === "a_apprendre");
    picks = byDue(t.filter(due)).concat(shuffle(t.filter(e => !due(e)), rnd)).slice(0, size);
  } else if (c.source === "libre") {
    picks = shuffle(usable.filter(e => fun.indexOf(e.group) === -1), rnd).slice(0, size);
  } else {
    const dueList = byDue(usable.filter(due));
    const fresh = usable.filter(e => !tag(e) && fun.indexOf(e.group) === -1);
    const fFocus = shuffle(fresh.filter(foc), rnd);
    const fNew = shuffle(fresh.filter(e => !foc(e) && c.isNew(e)), rnd);
    const fRest = shuffle(fresh.filter(e => !foc(e) && !c.isNew(e)), rnd);
    const nReview = Math.min(dueList.length, Math.ceil(size * 0.6));
    const nFresh = size - nReview;
    const nFocus = Math.min(fFocus.length, Math.ceil(nFresh / 2));
    const nNew = Math.min(fNew.length, Math.max(1, Math.floor(nFresh / 4)));
    const freshPick = fFocus.slice(0, nFocus).concat(fNew.slice(0, nNew), fRest, fFocus.slice(nFocus), fNew.slice(nNew)).slice(0, nFresh);
    picks = dueList.slice(0, nReview).concat(freshPick);
    if (picks.length < size) picks = picks.concat(dueList.slice(nReview, nReview + size - picks.length));
    picks = shuffle(picks, rnd);
  }

  const items = picks.map(e => ({ id: e.id }));
  if ((c.source || "mix") === "mix" && fun.length && items.length) {
    const used = {};
    picks.forEach(e => { used[e.id] = true; });
    const treats = usable.filter(e => fun.indexOf(e.group) !== -1 && !used[e.id]);
    if (treats.length) items.push({ id: treats[Math.floor(rnd() * treats.length)].id, bonus: true });
  }
  return items;
}

/* ---------- quiz ---------- */
const QUOTE_TYPES = { citation: true, humour: true };
function cleanAuthor(a) {
  if (!a || /apocryphe|attribu|anonyme|popularis|proverbe|r[ée]plique|formule/i.test(a)) return null;
  return plainText(a).split(/,| — | \(/)[0].trim() || null;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function lead(text, min) {
  const parts = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
  let out = "";
  for (let i = 0; i < parts.length && out.length < min; i++) out += parts[i];
  return out.trim();
}

/* c : { entries, groups, size, tagOf(id), isFocus(id), rnd } */
function buildQuiz(c) {
  const size = c.size || 10, rnd = c.rnd || Math.random;
  const inScope = c.entries.filter(e => e.def && c.groups.indexOf(e.group) !== -1);
  const defPool = inScope.filter(e => !QUOTE_TYPES[e.type] && e.def.indexOf("<ul>") === -1 && plainText(e.mot).length <= 60);
  const authPool = inScope.filter(e => QUOTE_TYPES[e.type] && cleanAuthor(e.auteur));
  const authors = [];
  authPool.forEach(e => { const a = cleanAuthor(e.auteur); if (authors.indexOf(a) === -1) authors.push(a); });

  let cands = defPool.map(e => ({ e: e, kind: "def" }));
  if (authors.length >= 4) cands = cands.concat(authPool.map(e => ({ e: e, kind: "author" })));
  const wanted = x => c.tagOf(x.e.id) === "a_apprendre" || c.isFocus(x.e.id);
  const pri = shuffle(cands.filter(wanted), rnd), rest = shuffle(cands.filter(x => !wanted(x)), rnd);
  const nPri = Math.min(pri.length, Math.ceil(size / 2));
  let chosen = pri.slice(0, nPri).concat(rest.slice(0, size - nPri));
  if (chosen.length < size) chosen = chosen.concat(pri.slice(nPri, nPri + size - chosen.length));
  chosen = shuffle(chosen, rnd);

  return chosen.map(x => {
    const e = x.e;
    let prompt, right, wrong;
    if (x.kind === "author") {
      right = cleanAuthor(e.auteur);
      prompt = plainText(e.mot);
      wrong = shuffle(authors.filter(a => a !== right), rnd).slice(0, 3);
    } else {
      right = plainText(e.mot);
      prompt = lead(plainText(e.def), 70);
      const names = [right], bare = right.replace(/\s*\([^)]*\)\s*/g, " ").trim();
      if (bare !== right) names.push(bare);
      names.forEach(n => { if (n.length >= 4) prompt = prompt.replace(new RegExp(escapeRe(n), "gi"), "▁▁▁"); });
      const others = defPool.filter(o => o !== e && plainText(o.mot) !== right);
      const sameType = shuffle(others.filter(o => o.type === e.type), rnd);
      const sameGroup = shuffle(others.filter(o => o.type !== e.type && o.group === e.group), rnd);
      const anyOther = shuffle(others.filter(o => o.group !== e.group), rnd);
      wrong = sameType.concat(sameGroup, anyOther).slice(0, 3).map(o => plainText(o.mot));
    }
    const options = shuffle([right].concat(wrong), rnd);
    return { id: e.id, kind: x.kind, prompt: prompt, options: options, answer: options.indexOf(right) };
  }).filter(q => q.options.length >= 2);
}

const Core = {
  INTERVALS, isoDay, dayNumber, plainText, fold, shuffle,
  applyWordOp, applyProgressOp, applyStudyOp, normWords, normProgress, normStudy,
  createStore, isDue, gradeResult, computeStreak, buildSession, buildQuiz, cleanAuthor,
};
if (typeof module !== "undefined" && module.exports) { module.exports = Core; return; }

/* ==========================================================================
   APPLICATION
   ========================================================================== */
const D = root.DECK;
if (!D || !root.BASE_ENTRIES) return;
const BASE = root.BASE_ENTRIES, TYPE_LABELS = root.TYPE_LABELS, GROUP_LABELS = root.GROUP_LABELS, GROUP_OF = root.GROUP_OF;
const BLAGUE_TYPES = root.BLAGUE_TYPES || [];
const K = D.keys, L = D.labels;
const LS = root.localStorage;
const SESSION_SIZE = 10, QUIZ_SIZE = 10, NEW_WINDOW_DAYS = 30;

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.prototype.slice.call((el || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = s => String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const readJSON = (key, fallback) => { try { const v = LS.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } };
const writeJSON = (key, val) => { try { LS.setItem(key, JSON.stringify(val)); } catch (e) { /* quota : l'état reste en mémoire */ } };
const today = () => Core.dayNumber(new Date());
const todayIso = () => Core.isoDay(new Date());
const capFirst = s => { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); };
const isBlague = t => BLAGUE_TYPES.indexOf(t) !== -1;
const isQuote = t => t === "citation" || t === "humour";
const TOUCH = !!(root.matchMedia && root.matchMedia("(hover: none)").matches);

/* ---------- données synchronisées ---------- */
const gh = {
  owner: "sebmgn", repo: "ameliorer-vocabulaire", branch: "main",
  token: () => { try { return LS.getItem("ghSyncToken") || ""; } catch (e) { return ""; } },
};
const syncStatus = { words: "idle", progress: "idle", study: "idle", at: null };
const onStatus = name => s => {
  syncStatus[name] = s;
  if (s === "synced") syncStatus.at = new Date();
  paintSync();
};
const storeBase = name => ({ storage: LS, fetch: (u, i) => root.fetch(u, i), gh: gh, onStatus: onStatus(name), onError: e => console.error("Synchro " + name, e) });

// Une seule fois par appareil : ce qui existait en local avant la première synchro est
// fusionné avec le fichier distant au lieu d'être écrasé par lui.
function migrateOnce(flagKey, queueKey, makeOp) {
  if (LS.getItem(flagKey) === "1") return;
  const op = makeOp();
  if (op) { const q = readJSON(queueKey, []); q.unshift(op); writeJSON(queueKey, q); }
  try { LS.setItem(flagKey, "1"); } catch (e) { /* ignore */ }
}

function loadProgressCache() {
  const p = { tags: readJSON(K.tags, {}) || {}, focus: readJSON(K.focus, {}) || {} };
  // Très ancien format (une simple liste de mots « appris »).
  const legacy = readJSON(K.legacyLearned, []);
  if (Array.isArray(legacy) && legacy.length && LS.getItem(K.tags) === null) {
    legacy.forEach(id => { p.tags[id] = "appris"; });
    writeJSON(K.tags, p.tags);
  }
  return p;
}
migrateOnce(K.wordsMigrated, K.wordsQueue, () => {
  const local = Core.normWords(readJSON(K.custom, []));
  return local.length ? { type: "merge", entries: local } : null;
});
migrateOnce(K.progressMigrated, K.progressQueue, () => {
  const p = loadProgressCache();
  return Object.keys(p.tags).length || Object.keys(p.focus).length ? { type: "merge", tags: p.tags, focus: p.focus } : null;
});

const wordsStore = Core.createStore(Object.assign(storeBase("words"), {
  path: D.paths.words, queueKey: K.wordsQueue,
  load: () => Core.normWords(readJSON(K.custom, [])), save: s => writeJSON(K.custom, s),
  normalize: Core.normWords, apply: Core.applyWordOp, message: s => "words: sync (" + s.length + ")",
  onChange: () => onWordsChanged(),
}));
const progressStore = Core.createStore(Object.assign(storeBase("progress"), {
  path: D.paths.progress, queueKey: K.progressQueue, debounce: 5000, maxWait: 30000,
  load: loadProgressCache, save: s => { writeJSON(K.tags, s.tags); writeJSON(K.focus, s.focus); },
  normalize: Core.normProgress, apply: Core.applyProgressOp, message: () => "progress: sync",
  onChange: () => refreshMeta(),
}));
const studyStore = Core.createStore(Object.assign(storeBase("study"), {
  path: D.paths.study, queueKey: K.studyQueue, debounce: 5000, maxWait: 30000,
  load: () => Core.normStudy(readJSON(K.study, null)), save: s => writeJSON(K.study, s),
  normalize: Core.normStudy, apply: Core.applyStudyOp, message: () => "study: sync",
  onChange: () => refreshMeta(),
}));
// La série de jours est commune aux deux carnets : on lit aussi (sans jamais l'écrire)
// le fichier d'étude de l'autre carnet. File toujours vide = simple lecture.
const otherStudy = D.otherStudy ? Core.createStore(Object.assign(storeBase("other"), {
  path: D.otherStudy.path, queueKey: D.otherStudy.peekKey + "-q", onStatus: null,
  load: () => Core.normStudy(readJSON(D.otherStudy.peekKey, null)), save: s => writeJSON(D.otherStudy.peekKey, s),
  normalize: Core.normStudy, apply: Core.applyStudyOp, message: () => "",
  onChange: () => refreshMeta(),
})) : null;
function allDays() {
  const days = Object.assign({}, studyStore.get().days);
  if (D.otherStudy) {
    // Ce que l'autre carnet a en local (pas encore envoyé) ou ce qu'on a lu sur GitHub : le plus grand des deux.
    const local = Core.normStudy(readJSON(D.otherStudy.cache, null)).days, remote = otherStudy.get().days;
    Object.keys(Object.assign({}, local, remote)).forEach(k => {
      days[k] = (days[k] || 0) + Math.max(local[k] || 0, remote[k] || 0);
    });
  }
  return days;
}
const stores = [wordsStore, progressStore, studyStore];
let lastSyncAll = 0;
function syncAll() { lastSyncAll = Date.now(); stores.forEach(s => { s.sync(); }); if (otherStudy) otherStudy.sync(); }

/* ---------- fiches ---------- */
let entries = [], byId = new Map();
function rebuildEntries() {
  const custom = wordsStore.get();
  custom.forEach(e => { e.group = GROUP_OF[e.type] || D.groups[0]; });
  entries = BASE.concat(custom);
  byId = new Map(entries.map(e => [String(e.id), e]));
}
const entryById = id => byId.get(String(id));
const tagOf = id => progressStore.get().tags[id] || null;
const isFocus = id => !!progressStore.get().focus[id];
const srsOf = id => studyStore.get().srs[id] || null;
function isNew(e) {
  if (!e.date) return false;
  const age = Date.now() - new Date(e.date + "T00:00:00").getTime();
  return age >= 0 && age < NEW_WINDOW_DAYS * DAY_MS;
}
const searchCache = new WeakMap();
function searchText(e) {
  let s = searchCache.get(e);
  if (s === undefined) {
    s = Core.fold([e.mot, e.def, e.syn, e.ex, e.auteur].join(" "));
    searchCache.set(e, s);
  }
  return s;
}

/* ---------- actions sur une fiche ---------- */
function setTag(id, value) {
  const next = tagOf(id) === value ? null : value;
  progressStore.enqueue([{ type: "tag", id: id, value: next }]);
  // Garder le calendrier de révision cohérent avec un statut posé à la main.
  const s = srsOf(id);
  if (next === "appris") {
    if (!s) studyStore.enqueue([{ t: "srs", id: id, b: 2, d: today() + Core.INTERVALS[3] }]);
  } else if (s) {
    studyStore.enqueue([{ t: "srs", id: id, b: null }]);
  }
}
function toggleFocus(id) {
  progressStore.enqueue([{ type: "focus", id: id, value: isFocus(id) ? null : true }]);
}
function countDay() {
  studyStore.enqueue([{ t: "day", k: todayIso(), n: 1 }]);
}
function applyGrade(e, knew) {
  const r = Core.gradeResult(srsOf(e.id), knew, today());
  studyStore.enqueue([{ t: "srs", id: e.id, b: r.b, d: r.d }, { t: "day", k: todayIso(), n: 1 }]);
  if (tagOf(e.id) !== r.tag) progressStore.enqueue([{ type: "tag", id: e.id, value: r.tag }]);
}

/* ---------- état d'écran ---------- */
const VIEWS = ["session", "browse", "quiz", "list", "focus", "add"];
const st = {
  view: "session",
  browse: { group: "tous", sub: null, tag: null, q: "", order: [], list: [], pos: 0, built: false },
  editingId: null,
};
let sess = null, sessCard = null, browseCard = null, quiz = null;

/* ==========================================================================
   CARTE
   ========================================================================== */
function badgesHTML(e, o) {
  const b = [];
  if (o && o.bonus) b.push('<span class="badge bonus">🎁 Bonus</span>');
  if (o && o.retry) b.push('<span class="badge retry">2ᵉ essai</span>');
  if (isNew(e)) b.push('<span class="badge new">Nouveau</span>');
  const t = tagOf(e.id);
  if (t === "a_apprendre") b.push('<span class="badge todo">À apprendre</span>');
  if (t === "appris") b.push('<span class="badge done">Appris</span>');
  if (isFocus(e.id)) b.push('<span class="badge focus" title="En focus">⭐</span>');
  return b.join("");
}
function cardHTML(e, o) {
  const blague = isBlague(e.type), quote = isQuote(e.type);
  const mot = quote ? capFirst(e.mot) : e.mot;
  const len = Core.plainText(e.mot).length;
  const size = len <= 14 ? "w1" : len <= 26 ? "w2" : len <= 55 ? "w3" : len <= 110 ? "w4" : "w5";
  const sec = (label, cls, html) => (html ? '<section class="sec"><h3>' + esc(label) + '</h3><div class="' + cls + '">' + html + "</div></section>" : "");
  return (
    '<div class="card' + (quote ? " is-quote" : "") + (blague ? " is-blague" : "") + '" data-cat="' + esc(e.type) + '" tabindex="0" role="button" aria-pressed="false" aria-label="Carte — Espace pour retourner">' +
      '<div class="card-inner">' +
        '<div class="face front">' +
          '<div class="face-top"><span class="chip-type">' + esc(TYPE_LABELS[e.type] || e.type) + '</span><span class="badges">' + badgesHTML(e, o) + "</span></div>" +
          '<div class="front-body">' +
            '<div class="emoji" aria-hidden="true">' + (e.emoji || "📝") + "</div>" +
            '<p class="word ' + size + '">' + (quote ? "«&nbsp;" + mot + "&nbsp;»" : mot) + "</p>" +
            (e.auteur ? '<p class="front-author">— ' + e.auteur + "</p>" : "") +
          "</div>" +
          '<p class="hint">' + (blague ? "La chute ? " : e.type === "enigme" ? "La réponse ? " : "") + (TOUCH ? "Touche la carte pour la retourner" : "Espace ou clic pour retourner") + "</p>" +
        "</div>" +
        '<div class="face back">' +
          '<div class="back-top"><span class="back-emoji" aria-hidden="true">' + (e.emoji || "📝") + '</span><span class="back-word ' + size + '">' + mot + "</span></div>" +
          sec((D.defLabels || {})[e.type] || (blague ? "Chute" : L.def), "definition" + (e.type === "blague_longue" ? " is-long" : ""), e.def || "<em>Définition à compléter…</em>") +
          sec(L.ex, "example", e.ex ? "«&nbsp;" + e.ex + "&nbsp;»" : "") +
          sec(L.syn, "synonyms", esc(e.syn || "")) +
          sec("Auteur", "author", e.auteur || "") +
        "</div>" +
      "</div>" +
    "</div>"
  );
}
function mountCard(host, e, o) {
  o = o || {};
  host.innerHTML = cardHTML(e, o);
  const el = host.firstElementChild;
  el.classList.add(o.dir === -1 ? "in-left" : o.dir === 1 ? "in-right" : "in");
  const api = {
    el: el, entry: e, flipped: false,
    flip: () => {
      api.flipped = !api.flipped;
      el.classList.toggle("is-flipped", api.flipped);
      el.setAttribute("aria-pressed", String(api.flipped));
      if (o.onFlip) o.onFlip(api.flipped);
    },
    refreshBadges: () => { const b = $(".badges", el); if (b) b.innerHTML = badgesHTML(e, o); },
  };
  el.addEventListener("click", ev => { if (!ev.target.closest("a,button")) api.flip(); });
  return api;
}
function tileHTML(e, extra) {
  const t = tagOf(e.id);
  return (
    '<span class="tile-emoji" aria-hidden="true">' + (e.emoji || "📝") + "</span>" +
    '<span class="tile-word">' + e.mot + "</span>" +
    (extra || "") +
    (t ? '<span class="tile-mark ' + (t === "appris" ? "done" : "todo") + '" aria-hidden="true">' + (t === "appris" ? "✓" : "🔖") + "</span>" : "") +
    (isFocus(e.id) ? '<span class="tile-mark" aria-hidden="true">⭐</span>' : "")
  );
}

/* ==========================================================================
   SESSION
   ========================================================================== */
const SOURCES = [["mix", "Mix du jour"], ["focus", "⭐ Focus"], ["todo", "🔖 À revoir"]];
function newSession(source) {
  const items = Core.buildSession({
    entries: entries, source: source, size: SESSION_SIZE, today: today(),
    tagOf: tagOf, srsOf: srsOf, isFocus: isFocus, isNew: isNew, funGroups: D.funGroups,
  });
  sess = { day: todayIso(), source: source, items: items, i: 0, good: 0, bad: 0, results: [] };
  writeJSON(K.session, sess);
  return sess;
}
function loadSession() {
  const s = readJSON(K.session, null);
  if (s && s.day === todayIso() && Array.isArray(s.items)) {
    s.items = s.items.filter(it => entryById(it.id));
    s.results = s.results || [];
    s.i = Math.min(s.i || 0, s.items.length);
    sess = s;
    return s;
  }
  return newSession("mix");
}
function sessionSub() {
  const due = entries.filter(e => e.def && Core.isDue(tagOf(e.id), srsOf(e.id), today())).length;
  return due + (due > 1 ? " cartes à revoir" : " carte à revoir") + " aujourd’hui · " + entries.filter(e => isFocus(e.id)).length + " en focus";
}
function renderSession(dir) {
  if (!sess) loadSession();
  const host = $("#v-session"), total = sess.items.length, finished = total > 0 && sess.i >= total;
  const title = sess.source === "focus" ? "Session Focus" : sess.source === "todo" ? "Session « à revoir »" : sess.source === "libre" ? "Révision libre" : "Session du jour";
  host.innerHTML =
    '<div class="view-head">' +
      '<div><h2 class="view-title">' + title + '</h2><p class="view-sub" id="session-sub">' + sessionSub() + "</p></div>" +
      '<div class="pills" role="group" aria-label="Contenu de la session">' +
        SOURCES.map(s => '<button type="button" class="pill' + (sess.source === s[0] ? " on" : "") + '" data-source="' + s[0] + '">' + s[1] + "</button>").join("") +
      "</div>" +
    "</div>" +
    (total ? '<div class="dots" aria-label="Avancement">' + sess.items.map((it, i) => {
      const r = sess.results[i];
      return '<i class="dot' + (r === "g" ? " good" : r === "b" ? " bad" : r === "x" ? " seen" : "") + (i === sess.i && !finished ? " cur" : "") + (it.bonus ? " bonus" : "") + '"></i>';
    }).join("") + '<span class="dots-count">' + Math.min(sess.i + (finished ? 0 : 1), total) + " / " + total + "</span></div>" : "") +
    '<div id="session-body"></div>';
  $$(".pill", host).forEach(p => p.addEventListener("click", () => {
    if (p.dataset.source === sess.source && !finished && total) return;
    newSession(p.dataset.source);
    renderSession(0);
  }));
  const body = $("#session-body");
  sessCard = null;
  if (!total) { renderSessionEmpty(body); return; }
  if (finished) { renderSessionDone(body); return; }
  const it = sess.items[sess.i], e = entryById(it.id);
  body.innerHTML = '<div class="stage solo"><div class="card-host"></div></div><div class="actions" id="session-actions"></div>' +
    '<p class="keys"><span><kbd>Espace</kbd> retourner · <kbd>A</kbd> je savais · <kbd>R</kbd> à revoir · <kbd>F</kbd> focus</span></p>';
  sessCard = mountCard($(".card-host", body), e, { dir: dir === undefined ? 1 : dir, bonus: it.bonus, retry: it.retry, onFlip: paintSessionActions });
  paintSessionActions();
}
function paintSessionActions() {
  const bar = $("#session-actions");
  if (!bar || !sessCard) return;
  const it = sess.items[sess.i], on = isFocus(it.id);
  const star = '<button type="button" class="iconbtn' + (on ? " on" : "") + '" data-act="focus" title="' + (on ? "Retirer du focus" : "Mettre en focus") + ' (F)" aria-pressed="' + on + '">⭐</button>';
  // Les deux réponses sont là dès le recto : on peut noter une carte sans la retourner.
  if (it.bonus) bar.innerHTML = (sessCard.flipped
    ? '<button type="button" class="btn primary" data-act="good">😄 Terminer la session <kbd>A</kbd></button>'
    : '<button type="button" class="btn primary" data-act="flip">Retourner la carte <kbd>Espace</kbd></button>') + star;
  else bar.innerHTML =
    '<button type="button" class="btn good" data-act="good">✓ Je savais <kbd>A</kbd></button>' +
    '<button type="button" class="btn again" data-act="bad">↻ À revoir <kbd>R</kbd></button>' + star;
  $$("[data-act]", bar).forEach(b => b.addEventListener("click", () => sessionAct(b.dataset.act)));
}
function sessionAct(act) {
  if (!sessCard || sessCard.leaving) return;
  if (act === "flip") { sessCard.flip(); return; }
  if (act === "focus") { toggleFocus(sess.items[sess.i].id); return; }
  const knew = act === "good", it = sess.items[sess.i], e = entryById(it.id);
  if (it.bonus) sess.results[sess.i] = "x";
  else {
    sess.results[sess.i] = knew ? "g" : "b";
    if (!it.retry) {
      applyGrade(e, knew);
      if (knew) sess.good++;
      else {
        sess.bad++;
        // Une carte ratée revient une fois en fin de session (avant la carte bonus).
        const last = sess.items[sess.items.length - 1];
        sess.items.splice(last && last.bonus ? sess.items.length - 1 : sess.items.length, 0, { id: it.id, retry: true });
      }
    }
  }
  sess.i++;
  writeJSON(K.session, sess);
  if (sess.i >= sess.items.length) stores.forEach(s => { s.flush(); });
  sessCard.leaving = true;
  sessCard.el.classList.add(knew ? "out-good" : "out-bad");
  setTimeout(() => { if (st.view === "session") renderSession(1); }, 190);
}
function weekHTML() {
  const days = allDays(), names = ["D", "L", "M", "M", "J", "V", "S"], out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const n = days[Core.isoDay(d)] || 0;
    out.push('<span class="d' + (n ? " hit" : "") + (i === 0 ? " today" : "") + '" title="' + n + " carte" + (n > 1 ? "s" : "") + '"><i>' + (n || "") + "</i>" + names[d.getDay()] + "</span>");
  }
  return '<div class="week">' + out.join("") + "</div>";
}
function confettiHTML() {
  const colors = ["#B23A3E", "#2E8B57", "#BF8A12", "#2662A8", "#C2478C", "#D9622B"];
  let h = "";
  for (let i = 0; i < 36; i++) {
    h += '<i style="left:' + Math.round(Math.random() * 100) + "%;background:" + colors[i % colors.length] +
      ";--x:" + Math.round(Math.random() * 160 - 80) + "px;--r:" + Math.round(Math.random() * 720 - 360) + "deg;--t:" +
      (1.3 + Math.random() * 1.2).toFixed(2) + "s;--d:" + (Math.random() * 0.35).toFixed(2) + 's"></i>';
  }
  return '<div class="confetti" aria-hidden="true">' + h + "</div>";
}
/* Petit texte de fin de session : une phrase par carte notée, le mot surligné
   en vert (je savais) ou en rouge (à revoir). Les phrases viennent des exemples des fiches. */
function recapSentence(e, ok) {
  const cls = ok ? "good" : "bad";
  const mark = html => '<mark class="' + cls + '" data-id="' + esc(e.id) + '">' + html + "</mark>";
  let ex = String(e.ex || "").trim();
  if (!ex) {
    // Citation sans exemple : la citation elle-même, avec son auteur.
    const who = Core.cleanAuthor(e.auteur);
    return "«&nbsp;" + mark(capFirst(e.mot).replace(/[\s.]+$/, "")) + "&nbsp;»" + (who ? ", disait " + who : "") + ".";
  }
  if (/<strong>/i.test(ex)) ex = ex.replace(/<strong>([\s\S]*?)<\/strong>/i, (m, inner) => mark(inner)).replace(/<\/?strong>/gi, "");
  else {
    const name = Core.plainText(e.mot), bare = name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    const hit = [name, bare].filter(n => n && ex.toLowerCase().indexOf(n.toLowerCase()) !== -1)[0];
    if (hit) {
      const i = ex.toLowerCase().indexOf(hit.toLowerCase());
      ex = ex.slice(0, i) + mark(ex.slice(i, i + hit.length)) + ex.slice(i + hit.length);
    } else ex = mark(e.mot) + " — " + ex;
  }
  ex = ex.replace(/^«\s*|\s*»$/g, "");
  return /[.!?…»]$/.test(Core.plainText(ex)) ? ex : ex + ".";
}
function recapHTML() {
  const parts = [];
  sess.items.forEach((it, i) => {
    const r = sess.results[i], e = entryById(it.id);
    if (it.bonus || it.retry || !e || (r !== "g" && r !== "b")) return;
    parts.push(recapSentence(e, r === "g"));
  });
  if (!parts.length) return "";
  return '<div class="recap"><p class="recap-title">Ta session en un texte</p><p class="recap-text">' + parts.join(" ") + "</p>" +
    '<p class="recap-legend"><mark class="good">vert</mark> je savais · <mark class="bad">rouge</mark> à revoir — clique un mot pour revoir sa carte</p></div>';
}
function renderSessionDone(body) {
  const streak = Core.computeStreak(allDays(), new Date());
  const graded = sess.good + sess.bad;
  const first = !sess.celebrated;
  sess.celebrated = true;
  writeJSON(K.session, sess);
  const line = graded
    ? "<strong>" + sess.good + "</strong> " + (sess.good > 1 ? "sues" : "sue") + " du premier coup" + (sess.bad ? " · <strong>" + sess.bad + "</strong> à revoir (elles reviendront demain)" : " — sans faute !")
    : "Session terminée.";
  body.innerHTML =
    '<div class="finish">' + (first ? confettiHTML() : "") +
      '<div class="done-emoji">' + (sess.bad === 0 && graded ? "🏆" : "🎉") + "</div>" +
      "<h2>Session terminée</h2>" +
      '<p class="done-line">' + line + "</p>" +
      '<p class="done-streak">🔥 <strong>' + streak + "</strong> jour" + (streak > 1 ? "s" : "") + " d’affilée</p>" +
      weekHTML() +
      recapHTML() +
      '<div class="actions">' +
        '<button type="button" class="btn primary" data-go="again">Encore ' + SESSION_SIZE + " cartes</button>" +
        '<button type="button" class="btn" data-go="quiz">⚡ Un quiz</button>' +
        '<button type="button" class="btn" data-go="browse">📖 Parcourir</button>' +
      "</div>" +
    "</div>";
  $$(".recap-text mark", body).forEach(m => m.addEventListener("click", () => openInBrowse(entryById(m.dataset.id), {})));
  $$("[data-go]", body).forEach(b => b.addEventListener("click", () => {
    if (b.dataset.go === "again") { newSession(sess.source); renderSession(0); } else go(b.dataset.go);
  }));
}
function renderSessionEmpty(body) {
  const msg = sess.source === "focus"
    ? ["⭐", "Aucune carte en focus", "Mets des cartes en focus avec l’étoile, depuis une session ou depuis Parcourir."]
    : sess.source === "todo"
      ? ["🌿", "Rien à revoir", "Aucune carte « à apprendre » pour l’instant."]
      : ["🌿", "Tout est à jour", "Rien à revoir et plus de nouvelle carte : reviens demain, ou révise librement."];
  body.innerHTML = '<div class="finish"><div class="done-emoji">' + msg[0] + "</div><h2>" + msg[1] + '</h2><p class="done-line">' + msg[2] + "</p>" +
    '<div class="actions"><button type="button" class="btn primary" data-s="mix">Mix du jour</button><button type="button" class="btn" data-s="libre">Révision libre</button></div></div>';
  $$("[data-s]", body).forEach(b => b.addEventListener("click", () => { newSession(b.dataset.s); renderSession(0); }));
}
function startSession(source) { newSession(source); go("session"); }

/* ==========================================================================
   QUIZ
   ========================================================================== */
function startQuiz() {
  quiz = {
    qs: Core.buildQuiz({ entries: entries, groups: D.quizGroups, size: QUIZ_SIZE, tagOf: tagOf, isFocus: isFocus }),
    i: 0, score: 0, picked: null, misses: [],
  };
}
function renderQuiz() {
  if (!quiz) startQuiz();
  const host = $("#v-quiz"), n = quiz.qs.length;
  const head = '<div class="view-head"><div><h2 class="view-title">Quiz express</h2><p class="view-sub">' + n + " questions tirées du carnet — une erreur envoie la carte dans « à apprendre ».</p></div></div>";
  if (!n) { host.innerHTML = head + '<p class="empty">Pas assez de fiches pour un quiz.</p>'; return; }
  if (quiz.i >= n) {
    const pct = quiz.score / n;
    host.innerHTML = head + '<div class="finish">' + (pct === 1 ? confettiHTML() : "") +
      '<div class="done-emoji">' + (pct === 1 ? "🏆" : pct >= 0.7 ? "🎉" : "💪") + "</div>" +
      "<h2>" + quiz.score + " / " + n + '</h2><p class="done-line">' + (pct === 1 ? "Sans faute." : pct >= 0.7 ? "Bien joué." : "Les cartes ratées sont passées dans « à apprendre ».") + "</p>" +
      (quiz.misses.length ? '<div class="tiles quiz-misses">' + quiz.misses.map(id => { const e = entryById(id); return e ? '<button type="button" class="tile" data-cat="' + esc(e.type) + '" data-id="' + esc(e.id) + '">' + tileHTML(e) + "</button>" : ""; }).join("") + "</div>" : "") +
      '<div class="actions"><button type="button" class="btn primary" data-q="again">Rejouer</button><button type="button" class="btn" data-q="session">🎯 Session du jour</button></div></div>';
    $$("[data-q]", host).forEach(b => b.addEventListener("click", () => { if (b.dataset.q === "again") { quiz = null; renderQuiz(); } else go("session"); }));
    $$(".quiz-misses .tile", host).forEach(t => t.addEventListener("click", () => openInBrowse(entryById(t.dataset.id), {})));
    return;
  }
  const q = quiz.qs[quiz.i], e = entryById(q.id), answered = quiz.picked !== null;
  host.innerHTML = head +
    '<div class="dots">' + quiz.qs.map((x, i) => '<i class="dot' + (x.result === true ? " good" : x.result === false ? " bad" : "") + (i === quiz.i ? " cur" : "") + '"></i>').join("") +
      '<span class="dots-count">' + (quiz.i + 1) + " / " + n + "</span></div>" +
    '<div class="quiz-card" data-cat="' + esc(e.type) + '">' +
      '<p class="quiz-kicker">' + (q.kind === "author" ? "Qui a dit ?" : L.quizDef) + "</p>" +
      '<p class="quiz-q' + (q.kind === "author" ? " is-quote" : "") + '">' + (q.kind === "author" ? "«&nbsp;" + esc(capFirst(q.prompt)) + "&nbsp;»" : esc(q.prompt)) + "</p>" +
      '<div class="options">' + q.options.map((opt, i) =>
        '<button type="button" class="opt' + (answered ? (i === q.answer ? " right" : i === quiz.picked ? " wrong" : " dim") : "") + '" data-i="' + i + '"' + (answered ? " disabled" : "") + "><kbd>" + (i + 1) + "</kbd><span>" + esc(opt) + "</span></button>").join("") +
      "</div>" +
      (answered ? '<div class="quiz-after"><span class="quiz-verdict ' + (quiz.picked === q.answer ? "ok" : "ko") + '">' + (quiz.picked === q.answer ? "✓ Exact" : "✗ C’était : " + esc(q.options[q.answer])) + '</span><button type="button" class="btn primary" id="quiz-next">' + (quiz.i + 1 >= n ? "Voir le score" : "Suivant") + " <kbd>Entrée</kbd></button></div>" : "") +
    "</div>";
  $$(".opt", host).forEach(b => b.addEventListener("click", () => quizPick(Number(b.dataset.i))));
  const next = $("#quiz-next");
  if (next) next.addEventListener("click", quizNext);
}
function quizPick(i) {
  if (!quiz || quiz.picked !== null || quiz.i >= quiz.qs.length) return;
  const q = quiz.qs[quiz.i];
  if (i < 0 || i >= q.options.length) return;
  quiz.picked = i;
  q.result = i === q.answer;
  if (q.result) { quiz.score++; countDay(); }
  else { quiz.misses.push(q.id); applyGrade(entryById(q.id), false); }
  renderQuiz();
}
function quizNext() {
  if (!quiz || quiz.picked === null) return;
  quiz.i++;
  quiz.picked = null;
  if (quiz.i >= quiz.qs.length) stores.forEach(s => { s.flush(); });
  renderQuiz();
}

/* ==========================================================================
   PARCOURIR
   ========================================================================== */
const STATS = [
  ["appris", "✓ Appris", e => tagOf(e.id) === "appris"],
  ["a_apprendre", "🔖 À apprendre", e => tagOf(e.id) === "a_apprendre"],
  ["focus", "⭐ Focus", e => isFocus(e.id)],
  ["untagged", "Sans étiquette", e => !tagOf(e.id) && !isFocus(e.id)],
  ["nouveautes", "🎉 Nouveautés", e => isNew(e)],
];
const statTest = key => STATS.filter(s => s[0] === key)[0][2];
function syncOrder() {
  const b = st.browse, known = {};
  b.order = b.order.filter(id => { known[id] = true; return !!entryById(id); });
  entries.forEach(e => { if (!known[e.id]) b.order.push(e.id); });
}
function refilter(keepId) {
  const b = st.browse, q = Core.fold(b.q), test = b.tag ? statTest(b.tag) : null;
  b.list = b.order.map(entryById).filter(e =>
    e && (b.group === "tous" || e.group === b.group) && (!b.sub || e.type === b.sub) && (!test || test(e)) && (!q || searchText(e).indexOf(q) !== -1)
  ).map(e => e.id);
  const at = keepId === undefined ? -1 : b.list.map(String).indexOf(String(keepId));
  b.pos = at === -1 ? 0 : at;
}
function buildBrowse() {
  const b = st.browse;
  b.built = true;
  $("#v-browse").innerHTML =
    '<div class="toolbar">' +
      '<div class="chips" id="group-chips"></div>' +
      '<div class="chips sub" id="sub-chips" hidden></div>' +
      '<div class="toolbar-row">' +
        '<div class="chips" id="stat-chips"></div>' +
        '<label class="search"><span aria-hidden="true">🔎</span><input id="search" type="search" placeholder="' + esc(L.searchPh) + '" autocomplete="off" aria-label="' + esc(L.searchPh) + '"></label>' +
      "</div>" +
      '<div class="progressbar" id="progressbar" aria-hidden="true"><i class="done"></i><i class="todo"></i></div>' +
      '<p class="filterline" id="filterline" hidden></p>' +
    "</div>" +
    '<div class="stage">' +
      '<button type="button" class="nav" id="prev" aria-label="Fiche précédente">‹</button>' +
      '<div class="stage-mid"><div class="counter" id="counter"></div><div class="card-host" id="browse-card"></div></div>' +
      '<button type="button" class="nav" id="next" aria-label="Fiche suivante">›</button>' +
    "</div>" +
    '<div class="actions" id="browse-actions"></div>' +
    '<p class="keys"><button type="button" class="link" id="shuffle">🔀 Mélanger</button><button type="button" class="link" id="reset-order">↺ Ordre d’origine</button>' +
      "<span><kbd>←</kbd> <kbd>→</kbd> naviguer · <kbd>Espace</kbd> retourner · <kbd>A</kbd> <kbd>S</kbd> <kbd>F</kbd> étiquettes · <kbd>/</kbd> chercher</span></p>" +
    '<details class="sommaire" id="sommaire"><summary>Sommaire — <span id="sommaire-count"></span></summary><div class="tiles" id="sommaire-grid"></div></details>';
  $("#prev").addEventListener("click", () => browseGo(-1));
  $("#next").addEventListener("click", () => browseGo(1));
  $("#shuffle").addEventListener("click", browseShuffle);
  $("#reset-order").addEventListener("click", () => { b.order = entries.map(e => e.id); refilter(); paintBrowse(0); });
  $("#search").addEventListener("input", ev => { b.q = ev.target.value; refilter(); paintBrowse(0); });
  $("#sommaire").addEventListener("toggle", paintSommaire);
}
function browseShuffle() {
  st.browse.order = Core.shuffle(st.browse.order);
  refilter();
  paintBrowse(0);
}
function paintGroupChips() {
  const b = st.browse;
  $("#group-chips").innerHTML = ["tous"].concat(D.groups).map(g => {
    const n = g === "tous" ? entries.length : entries.filter(e => e.group === g).length;
    return n || g === "tous" ? '<button type="button" class="chip' + (b.group === g ? " on" : "") + '" data-group="' + g + '">' + esc(GROUP_LABELS[g] || g) + " <small>" + n + "</small></button>" : "";
  }).join("");
  $$("#group-chips .chip").forEach(c => c.addEventListener("click", () => {
    b.group = c.dataset.group; b.sub = null;
    refilter(); paintBrowse(0);
  }));
  const subs = (D.subgroups || {})[b.group], subEl = $("#sub-chips");
  subEl.hidden = !subs;
  if (subs) {
    subEl.innerHTML = '<button type="button" class="chip sm' + (!b.sub ? " on" : "") + '" data-group="' + b.group + '" data-sub="">Toutes</button>' +
      subs.map(t => { const n = entries.filter(e => e.type === t).length; return n ? '<button type="button" class="chip sm' + (b.sub === t ? " on" : "") + '" data-group="' + b.group + '" data-sub="' + t + '">' + esc(TYPE_LABELS[t]) + " <small>" + n + "</small></button>" : ""; }).join("");
    $$("#sub-chips .chip").forEach(c => c.addEventListener("click", () => { b.sub = c.dataset.sub || null; refilter(); paintBrowse(0); }));
  }
}
function paintStatChips() {
  const b = st.browse;
  $("#stat-chips").innerHTML = STATS.map(s =>
    '<button type="button" class="chip stat' + (b.tag === s[0] ? " on" : "") + '" data-stat="' + s[0] + '">' + s[1] + " <small>" + entries.filter(s[2]).length + "</small></button>").join("");
  $$("#stat-chips .chip").forEach(c => c.addEventListener("click", () => {
    b.tag = b.tag === c.dataset.stat ? null : c.dataset.stat;
    refilter(); paintBrowse(0);
  }));
  const total = entries.length || 1, bar = $("#progressbar");
  $(".done", bar).style.width = (entries.filter(STATS[0][2]).length / total * 100) + "%";
  $(".todo", bar).style.width = (entries.filter(STATS[1][2]).length / total * 100) + "%";
  // Rappel du filtre actif quand il n'est pas visible dans les puces (type précis hors « blagues »).
  const line = $("#filterline"), hiddenSub = b.sub && !(D.subgroups || {})[b.group];
  line.hidden = !hiddenSub;
  if (hiddenSub) {
    line.innerHTML = "Filtre : <strong>" + esc(TYPE_LABELS[b.sub]) + "</strong>" + (b.tag ? " · " + STATS.filter(s => s[0] === b.tag)[0][1] : "") + ' <button type="button" class="link" id="clear-filters">✕ tout afficher</button>';
    $("#clear-filters").addEventListener("click", () => { b.group = "tous"; b.sub = null; b.tag = null; refilter(); paintBrowse(0); });
  }
}
function paintBrowseActions() {
  const bar = $("#browse-actions");
  if (!bar) return;
  if (!browseCard) { bar.innerHTML = ""; return; }
  const id = browseCard.entry.id, t = tagOf(id);
  bar.innerHTML =
    '<button type="button" class="btn tag todo' + (t === "a_apprendre" ? " on" : "") + '" data-act="a_apprendre" aria-pressed="' + (t === "a_apprendre") + '">🔖 À apprendre <kbd>A</kbd></button>' +
    '<button type="button" class="btn tag done' + (t === "appris" ? " on" : "") + '" data-act="appris" aria-pressed="' + (t === "appris") + '">✓ Appris <kbd>S</kbd></button>' +
    '<button type="button" class="btn tag focus' + (isFocus(id) ? " on" : "") + '" data-act="focus" aria-pressed="' + isFocus(id) + '">⭐ Focus <kbd>F</kbd></button>';
  $$("[data-act]", bar).forEach(x => x.addEventListener("click", () => browseAct(x.dataset.act)));
}
function browseAct(act) {
  if (!browseCard) return;
  if (act === "focus") toggleFocus(browseCard.entry.id); else setTag(browseCard.entry.id, act);
}
function paintSommaire() {
  const box = $("#sommaire"), b = st.browse;
  $("#sommaire-count").textContent = b.list.length + " fiche" + (b.list.length > 1 ? "s" : "");
  if (!box.open) return;
  $("#sommaire-grid").innerHTML = b.list.map((id, i) => {
    const e = entryById(id);
    return '<button type="button" class="tile' + (i === b.pos ? " cur" : "") + '" data-cat="' + esc(e.type) + '" data-i="' + i + '">' + tileHTML(e) + "</button>";
  }).join("");
  $$("#sommaire-grid .tile").forEach(t => t.addEventListener("click", () => {
    b.pos = Number(t.dataset.i);
    paintBrowse(0);
    $("#browse-card").scrollIntoView({ behavior: "smooth", block: "center" });
  }));
}
function paintBrowse(dir) {
  const b = st.browse, host = $("#browse-card"), n = b.list.length;
  paintGroupChips();
  paintStatChips();
  if (b.pos >= n) b.pos = Math.max(0, n - 1);
  $("#counter").textContent = n ? b.pos + 1 + " / " + n : "";
  $("#prev").disabled = !n || b.pos === 0;
  $("#next").disabled = !n || b.pos >= n - 1;
  if (!n) {
    browseCard = null;
    host.innerHTML = '<p class="empty">Aucune fiche ne correspond à ces filtres.</p>';
  } else browseCard = mountCard(host, entryById(b.list[b.pos]), { dir: dir });
  paintBrowseActions();
  paintSommaire();
}
function browseGo(delta) {
  const b = st.browse, next = b.pos + delta;
  if (next < 0 || next >= b.list.length) return;
  b.pos = next;
  paintBrowse(delta);
}
function enterBrowse() {
  const b = st.browse;
  if (!b.built) { buildBrowse(); syncOrder(); refilter(); }
  paintBrowse(0);
}
/* Ouvre Parcourir sur une fiche, avec des filtres donnés (précédent/suivant restent dans ce sous-ensemble). */
function openInBrowse(e, f) {
  if (!e) return;
  const b = st.browse;
  if (!b.built) { buildBrowse(); syncOrder(); }
  b.q = ""; $("#search").value = "";
  b.tag = f.tag || null;
  b.sub = f.type || null;
  b.group = f.type ? GROUP_OF[f.type] || "tous" : "tous";
  refilter(e.id);
  go("browse");
}

/* ==========================================================================
   MA LISTE / FOCUS
   ========================================================================== */
function renderList() {
  const host = $("#v-list");
  const section = (tag, title, empty) => {
    const items = entries.filter(e => tagOf(e.id) === tag);
    return '<div class="list-section"><div class="list-head"><h3>' + title + ' <span class="count">' + items.length + "</span></h3>" +
      (tag === "a_apprendre" && items.length ? '<button type="button" class="btn sm primary" id="review-todo">▶ Réviser en session</button>' : "") + "</div>" +
      (items.length ? '<div class="tiles">' + items.map(e =>
        '<div class="tile has-actions" data-cat="' + esc(e.type) + '" data-id="' + esc(e.id) + '" data-tag="' + tag + '" tabindex="0" role="button">' +
          '<span class="tile-emoji" aria-hidden="true">' + (e.emoji || "📝") + '</span><span class="tile-word">' + e.mot + "</span>" +
          '<span class="tile-actions">' + (tag === "a_apprendre"
            ? '<button type="button" class="mini done" data-set="appris" title="Marquer comme appris" aria-label="Marquer comme appris">✓</button>'
            : '<button type="button" class="mini todo" data-set="a_apprendre" title="Remettre dans « à apprendre »" aria-label="Remettre dans à apprendre">↩</button>') + "</span>" +
        "</div>").join("") + "</div>" : '<p class="empty left">' + empty + "</p>") + "</div>";
  };
  host.innerHTML =
    '<div class="view-head"><div><h2 class="view-title">Ma liste</h2><p class="view-sub">Clique sur une carte pour la parcourir avec celles du même statut.</p></div></div>' +
    section("a_apprendre", "🔖 À apprendre", "Rien ici : réponds « À revoir » en session, ou marque une carte depuis Parcourir.") +
    section("appris", "✓ Appris", "Les cartes sues en session arrivent ici.");
  const review = $("#review-todo");
  if (review) review.addEventListener("click", () => startSession("todo"));
  $$(".tile", host).forEach(t => {
    const open = () => openInBrowse(entryById(t.dataset.id), { tag: t.dataset.tag });
    t.addEventListener("click", ev => {
      const set = ev.target.closest("[data-set]");
      if (set) setTag(entryById(t.dataset.id).id, set.dataset.set); else open();
    });
    t.addEventListener("keydown", ev => { if (ev.target === t && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); open(); } });
  });
}
function renderFocus() {
  const host = $("#v-focus"), all = entries.filter(e => isFocus(e.id));
  const types = Object.keys(TYPE_LABELS), groupRank = t => { const i = D.groups.indexOf(GROUP_OF[t]); return i === -1 ? 99 : i; };
  const present = types.filter(t => all.some(e => e.type === t)).sort((a, b) => groupRank(a) - groupRank(b) || types.indexOf(a) - types.indexOf(b));
  host.innerHTML =
    '<div class="view-head"><div><h2 class="view-title">⭐ Focus <span class="count">' + all.length + '</span></h2><p class="view-sub">Tes cartes prioritaires, par catégorie. Un clic ouvre la carte ; précédent/suivant restent dans la catégorie.</p></div>' +
      (all.length ? '<div class="pills"><button type="button" class="btn sm primary" id="focus-session">▶ Session Focus</button><button type="button" class="btn sm" id="focus-all">Parcourir tout</button></div>' : "") + "</div>" +
    (all.length ? present.map(t => {
      const items = all.filter(e => e.type === t);
      return '<div class="list-section" data-cat="' + esc(t) + '"><div class="list-head"><h3 class="cat-title">' + esc(TYPE_LABELS[t]) + ' <span class="count">' + items.length + "</span></h3></div><div class=\"tiles\">" +
        items.map(e => '<div class="tile has-actions" data-cat="' + esc(e.type) + '" data-id="' + esc(e.id) + '" tabindex="0" role="button">' + tileHTML(e).replace('<span class="tile-mark" aria-hidden="true">⭐</span>', "") +
          '<span class="tile-actions"><button type="button" class="mini" data-unfocus title="Retirer du focus" aria-label="Retirer du focus">✕</button></span></div>').join("") + "</div></div>";
    }).join("") : '<p class="empty left">Aucune carte en focus pour l’instant — utilise l’étoile ⭐ sur une carte.</p>');
  const fs = $("#focus-session"), fa = $("#focus-all");
  if (fs) fs.addEventListener("click", () => startSession("focus"));
  if (fa) fa.addEventListener("click", () => openInBrowse(all[0], { tag: "focus" }));
  $$(".tile", host).forEach(t => {
    const e = entryById(t.dataset.id), open = () => openInBrowse(e, { tag: "focus", type: e.type });
    t.addEventListener("click", ev => { if (ev.target.closest("[data-unfocus]")) toggleFocus(e.id); else open(); });
    t.addEventListener("keydown", ev => { if (ev.target === t && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); open(); } });
  });
}

/* ==========================================================================
   AJOUTER
   ========================================================================== */
function typeOptionsHTML() {
  return D.groups.map(g => {
    const types = Object.keys(TYPE_LABELS).filter(t => GROUP_OF[t] === g);
    const opts = types.map(t => '<option value="' + t + '">' + esc(TYPE_LABELS[t]) + "</option>").join("");
    return types.length > 1 ? '<optgroup label="' + esc(GROUP_LABELS[g]) + '">' + opts + "</optgroup>" : opts;
  }).join("");
}
function autoBold(exHtml, motHtml) {
  if (!exHtml || !motHtml) return exHtml;
  const i = exHtml.toLowerCase().indexOf(motHtml.toLowerCase());
  return i === -1 ? exHtml : exHtml.slice(0, i) + "<strong>" + exHtml.slice(i, i + motHtml.length) + "</strong>" + exHtml.slice(i + motHtml.length);
}
function buildAdd() {
  const opts = typeOptionsHTML();
  $("#v-add").innerHTML =
    '<div class="view-head"><div><h2 class="view-title">Ajouter</h2><p class="view-sub">' + esc(L.addIntro) + "</p></div></div>" +
    '<div class="panel">' +
      '<label class="lbl" for="f-bulk">Ajout rapide — ' + esc(L.bulkHint) + "</label>" +
      '<textarea id="f-bulk" rows="4" placeholder="' + esc(L.bulkPh) + '"></textarea>' +
      '<div class="row"><select id="f-bulk-type" aria-label="Type">' + opts + '</select><button type="button" class="btn primary" id="bulk-add-btn">Ajouter la liste</button></div>' +
      '<p class="help">Chaque ligne devient une fiche avec juste son titre (les puces « - » et « * » sont ignorées). Tu complètes ensuite via ✏️ dans « Mes ajouts ».</p>' +
    "</div>" +
    '<form class="panel" id="add-form">' +
      '<p class="lbl">Ou une fiche complète</p>' +
      '<div class="row two"><div><label class="lbl" for="f-mot">' + esc(L.addMot) + '</label><input type="text" id="f-mot" required placeholder="' + esc(L.addMotPh) + '"></div>' +
        '<div><label class="lbl" for="f-type">Type</label><select id="f-type">' + opts + "</select></div></div>" +
      '<label class="lbl" for="f-emoji">Émoji</label><input type="text" id="f-emoji" placeholder="📝" maxlength="8">' +
      '<label class="lbl" for="f-def">' + esc(L.def) + '</label><textarea id="f-def" required placeholder="' + esc(L.addDefPh) + '"></textarea>' +
      '<label class="lbl" for="f-ex">' + esc(L.ex) + '</label><textarea id="f-ex" placeholder="' + esc(L.addExPh) + '"></textarea>' +
      '<label class="lbl" for="f-syn">' + esc(L.syn) + '</label><input type="text" id="f-syn" placeholder="séparés par des virgules">' +
      '<label class="lbl" for="f-auteur">Auteur <span class="opt-note">(pour une citation)</span></label><input type="text" id="f-auteur" placeholder="ex : Victor Hugo">' +
      '<div class="row"><button type="submit" class="btn primary" id="add-submit-btn">Ajouter au carnet</button><button type="button" class="link" id="edit-cancel-btn" hidden>Annuler la modification</button></div>' +
    "</form>" +
    '<div class="panel"><p class="lbl">Mes ajouts</p><div id="my-words"></div></div>';
  const form = $("#add-form"), val = id => $("#" + id).value.trim();
  const newId = i => "c" + Date.now().toString(36) + (i || "") + Math.random().toString(36).slice(2, 6);
  $("#edit-cancel-btn").addEventListener("click", resetAddForm);
  form.addEventListener("submit", ev => {
    ev.preventDefault();
    if (!val("f-mot") || !val("f-def")) return;
    const type = $("#f-type").value, mot = esc(val("f-mot"));
    const fields = {
      mot: mot, type: type, group: GROUP_OF[type] || D.groups[0], emoji: val("f-emoji") || "📝",
      def: esc(val("f-def")), ex: autoBold(esc(val("f-ex")), mot), syn: val("f-syn"), auteur: esc(val("f-auteur")),
    };
    if (st.editingId) wordsStore.enqueue([{ type: "edit", id: st.editingId, patch: fields }], true);
    else wordsStore.enqueue([{ type: "add", entry: Object.assign({ id: newId(), date: todayIso() }, fields) }], true);
    resetAddForm();
  });
  $("#bulk-add-btn").addEventListener("click", () => {
    const box = $("#f-bulk"), type = $("#f-bulk-type").value;
    const lines = box.value.split("\n").map(l => l.replace(/^\s*[-*•]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
    if (!lines.length) return;
    wordsStore.enqueue(lines.map((line, i) => ({
      type: "add",
      entry: { id: newId(i), mot: esc(line), type: type, group: GROUP_OF[type] || D.groups[0], emoji: "📝", def: "", ex: "", syn: "", date: todayIso() },
    })), true);
    box.value = "";
  });
}
function resetAddForm() {
  st.editingId = null;
  $("#add-form").reset();
  $("#add-submit-btn").textContent = "Ajouter au carnet";
  $("#edit-cancel-btn").hidden = true;
}
function renderAdd() {
  if (!$("#add-form")) buildAdd();
  const box = $("#my-words"), custom = wordsStore.get();
  if (!custom.length) { box.innerHTML = '<p class="empty left">' + esc(L.noAdds) + "</p>"; return; }
  box.innerHTML = custom.map(e =>
    '<div class="myrow" data-id="' + esc(e.id) + '"><span aria-hidden="true">' + (e.emoji || "📝") + '</span><span class="myrow-word">' + e.mot + (e.def ? "" : " <em>(à compléter)</em>") + '</span><span class="myrow-type">' + esc(TYPE_LABELS[e.type] || e.type) + "</span>" +
    '<button type="button" class="mini" data-edit aria-label="Modifier">✏️</button><button type="button" class="mini" data-del aria-label="Supprimer">✕</button></div>').join("");
  $$(".myrow", box).forEach(row => {
    const e = entryById(row.dataset.id);
    $("[data-edit]", row).addEventListener("click", () => {
      st.editingId = e.id;
      $("#f-mot").value = unesc(e.mot); $("#f-type").value = e.type;
      $("#f-emoji").value = e.emoji === "📝" ? "" : e.emoji || "";
      $("#f-def").value = unesc(e.def); $("#f-ex").value = unesc(String(e.ex || "").replace(/<\/?strong>/g, ""));
      $("#f-syn").value = e.syn || ""; $("#f-auteur").value = unesc(e.auteur || "");
      $("#add-submit-btn").textContent = "Enregistrer les modifications";
      $("#edit-cancel-btn").hidden = false;
      $("#add-form").scrollIntoView({ behavior: "smooth", block: "start" });
      $("#f-mot").focus();
    });
    $("[data-del]", row).addEventListener("click", () => {
      if (st.editingId === e.id) resetAddForm();
      wordsStore.enqueue([{ type: "delete", id: e.id }], true);
    });
  });
}

/* ==========================================================================
   EN-TÊTE : série, synchro, tableau
   ========================================================================== */
function paintStreak() {
  const days = allDays(), n = Core.computeStreak(days, new Date()), doneToday = days[todayIso()] || 0;
  const el = $("#streak");
  el.className = "streak" + (n ? " on" : "") + (doneToday ? " today" : "");
  el.innerHTML = "🔥 <strong>" + n + "</strong><span>jour" + (n > 1 ? "s" : "") + "</span>";
  el.title = n ? n + " jour" + (n > 1 ? "s" : "") + " d’affilée" + (doneToday ? " — " + doneToday + " carte" + (doneToday > 1 ? "s" : "") + " aujourd’hui" : " — pas encore de carte aujourd’hui") : "Fais une session pour lancer ta série";
}
function paintSync() {
  const chip = $("#sync-chip");
  if (!chip) return;
  const vals = [syncStatus.words, syncStatus.progress, syncStatus.study];
  const pending = stores.reduce((n, s) => n + s.pending(), 0);
  let state, label;
  if (!gh.token()) { state = "off"; label = "Non synchronisé"; }
  else if (vals.indexOf("error") !== -1) { state = "error"; label = "Erreur de synchro"; }
  else if (vals.indexOf("syncing") !== -1) { state = "busy"; label = "Synchro…"; }
  else if (syncStatus.at) { state = "ok"; label = "Synchronisé " + syncStatus.at.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }
  else { state = "busy"; label = "Synchro…"; }
  chip.dataset.state = state;
  $("#sync-label").textContent = label;
  const detail = $("#sync-detail");
  if (detail) detail.textContent = state === "off"
    ? "Tes étiquettes, ta série et tes ajouts restent sur cet appareil tant qu’aucun token n’est enregistré." + (pending ? " " + pending + " modification(s) en attente." : "")
    : state === "error" ? "Dernier envoi en échec — tout est gardé en local (" + pending + " modification(s) en attente), nouvel essai automatique."
    : "Étiquettes, focus, série et ajouts sont enregistrés dans ton dépôt GitHub et partagés entre tes appareils.";
}
function buildSyncPopover() {
  const pop = $("#sync-pop");
  pop.innerHTML =
    '<p class="lbl">Synchronisation</p><p class="help" id="sync-detail"></p>' +
    '<input type="password" id="sync-token-input" autocomplete="off" placeholder="Token GitHub (fine-grained)" aria-label="Token GitHub">' +
    '<div class="row"><button type="button" class="btn sm primary" id="sync-token-save">Enregistrer</button><button type="button" class="btn sm" id="sync-now">🔄 Resynchroniser</button><button type="button" class="link" id="sync-token-clear">Déconnecter</button></div>' +
    '<p class="help">Token <em>fine-grained</em> créé sur github.com → Settings → Developer settings, limité au dépôt <code>ameliorer-vocabulaire</code>, permission <strong>Contents : Read and write</strong>. À coller une fois par appareil ; il reste dans ce navigateur et n’est envoyé qu’à l’API GitHub.</p>';
  $("#sync-chip").addEventListener("click", ev => { ev.stopPropagation(); pop.hidden = !pop.hidden; paintSync(); });
  pop.addEventListener("click", ev => ev.stopPropagation());
  document.addEventListener("click", () => { pop.hidden = true; });
  $("#sync-token-save").addEventListener("click", () => {
    const v = $("#sync-token-input").value.trim();
    if (!v) return;
    try { LS.setItem("ghSyncToken", v); } catch (e) { /* ignore */ }
    $("#sync-token-input").value = "";
    syncAll();
  });
  $("#sync-now").addEventListener("click", syncAll);
  $("#sync-token-clear").addEventListener("click", () => { try { LS.removeItem("ghSyncToken"); } catch (e) { /* ignore */ } paintSync(); });
}
// Petite touche de culture générale : un tableau célèbre (domaine public) tiré au sort à chaque visite.
const ARTWORKS = [
  { file: "Mona_Lisa.jpg", title: "La Joconde", artist: "Léonard de Vinci", year: "v. 1503–1519" },
  { file: "Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg", title: "La Nuit étoilée", artist: "Vincent van Gogh", year: "1889" },
  { file: "Edvard_Munch_-_The_Scream_-_Google_Art_Project.jpg", title: "Le Cri", artist: "Edvard Munch", year: "1893" },
  { file: "Meisje_met_de_parel.jpg", title: "La Jeune Fille à la perle", artist: "Johannes Vermeer", year: "v. 1665" },
  { file: "Monet_-_Impression,_Sunrise.jpg", title: "Impression, soleil levant", artist: "Claude Monet", year: "1872" },
  { file: "Great_Wave_off_Kanagawa2.jpg", title: "La Grande Vague de Kanagawa", artist: "Hokusai", year: "v. 1831" },
];
function paintArt() {
  const list = ARTWORKS.concat(root.EXTRA_ARTWORKS || []), a = list[Math.floor(Math.random() * list.length)];
  const img = $("#art-img");
  img.src = "https://commons.wikimedia.org/wiki/Special:FilePath/" + encodeURIComponent(a.file) + "?width=400";
  img.alt = a.title + ", " + a.artist;
  img.addEventListener("error", () => { $("#art").hidden = true; });
  $("#art-caption").innerHTML = "<em>" + a.title + "</em><br>" + a.artist + ", " + a.year;
}

/* ==========================================================================
   COQUE, NAVIGATION, CLAVIER
   ========================================================================== */
const TABS = [["session", "🎯 Session"], ["browse", "📖 Parcourir"], ["quiz", "⚡ Quiz"], ["list", "🔖 Ma liste"], ["focus", "⭐ Focus"], ["add", "＋ Ajouter"]];
function buildShell() {
  const shell = document.createElement("div");
  shell.className = "shell";
  shell.innerHTML =
    '<header class="top">' +
      '<div class="brand"><div class="brand-mark" aria-hidden="true">' + D.mark + '</div><div><p class="eyebrow">' + esc(D.eyebrow) + "</p><h1>" + esc(D.title) + "</h1></div>" +
        '<nav class="deck-switch" aria-label="Changer de carnet">' + D.decks.map(d => '<a href="' + d.href + '"' + (d.current ? ' class="on" aria-current="page"' : "") + ">" + d.label + "</a>").join("") + "</nav></div>" +
      '<div class="top-right"><button type="button" class="streak" id="streak"></button>' +
        '<button type="button" class="syncchip" id="sync-chip" aria-haspopup="dialog"><i class="sync-dot"></i><span id="sync-label">Synchro</span></button>' +
        '<figure class="art" id="art"><img id="art-img" alt="" loading="lazy"><figcaption id="art-caption"></figcaption></figure></div>' +
      '<div class="popover" id="sync-pop" role="dialog" aria-label="Synchronisation" hidden></div>' +
    "</header>" +
    '<nav class="tabs" id="tabs" aria-label="Sections">' + TABS.map(t => '<button type="button" class="tab" data-view="' + t[0] + '">' + t[1] + "</button>").join("") + "</nav>" +
    "<main>" + VIEWS.map(v => '<section class="view" id="v-' + v + '" hidden></section>').join("") + "</main>";
  document.body.appendChild(shell);
  $$("#tabs .tab").forEach(t => t.addEventListener("click", () => go(t.dataset.view)));
  $("#streak").addEventListener("click", () => go("session"));
}
const RENDER = { session: () => renderSession(0), browse: enterBrowse, quiz: renderQuiz, list: renderList, focus: renderFocus, add: renderAdd };
function show(view) {
  if (VIEWS.indexOf(view) === -1) view = "session";
  st.view = view;
  $$(".view").forEach(v => { v.hidden = v.id !== "v-" + view; });
  $$("#tabs .tab").forEach(t => t.classList.toggle("on", t.dataset.view === view));
  RENDER[view]();
}
function go(view) {
  if (location.hash === "#" + view) show(view); else location.hash = view;
}
/* Rafraîchit ce qui dépend des étiquettes/de la série sans toucher à la carte affichée
   (pour ne pas la retourner sous les yeux de l'utilisateur à chaque synchro). */
function refreshMeta() {
  if (!$("#streak")) return;
  paintStreak();
  if (st.browse.built) { paintGroupChips(); paintStatChips(); paintBrowseActions(); if (browseCard) browseCard.refreshBadges(); }
  if (st.view === "session") {
    const sub = $("#session-sub");
    if (sub) sub.textContent = sessionSub();
    if (sessCard) { paintSessionActions(); sessCard.refreshBadges(); }
  }
  if (st.view === "list") renderList();
  if (st.view === "focus") renderFocus();
}
function onWordsChanged() {
  rebuildEntries();
  if (!$("#streak")) return;
  if (st.browse.built) {
    const cur = browseCard ? browseCard.entry : null, before = cur ? JSON.stringify(cur) : "";
    syncOrder();
    refilter(cur ? cur.id : undefined);
    const now = cur ? entryById(cur.id) : null;
    if (st.view === "browse" && (!now || JSON.stringify(now) !== before)) paintBrowse(0); else { paintGroupChips(); paintStatChips(); paintSommaire(); }
  }
  if (sess) { sess.items = sess.items.filter(it => entryById(it.id)); sess.i = Math.min(sess.i, sess.items.length); }
  if (st.view === "add") renderAdd();
  if (st.view === "session" && !sessCard) renderSession(0);
  refreshMeta();
}

const KEYS = {
  session: k => {
    if (!sessCard) return false;
    if (k === " " || k === "Enter") { sessionAct("flip"); return true; }
    if (k === "f") { sessionAct("focus"); return true; }
    if (k === "a" || k === "ArrowLeft") { sessionAct("good"); return true; }
    if (k === "r" || k === "ArrowRight") { sessionAct("bad"); return true; }
    return false;
  },
  browse: k => {
    if (k === "/") { $("#search").focus(); return true; }
    if (k === "ArrowRight") { browseGo(1); return true; }
    if (k === "ArrowLeft") { browseGo(-1); return true; }
    if (k === "m") { browseShuffle(); return true; }
    if (!browseCard) return false;
    if (k === " " || k === "Enter") { browseCard.flip(); return true; }
    if (k === "a") { browseAct("a_apprendre"); return true; }
    if (k === "s") { browseAct("appris"); return true; }
    if (k === "f") { browseAct("focus"); return true; }
    return false;
  },
  quiz: k => {
    if (!quiz) return false;
    if (/^[1-4]$/.test(k)) { quizPick(Number(k) - 1); return true; }
    if (k === "Enter" || k === "ArrowRight" || k === " ") { quizNext(); return true; }
    return false;
  },
};
document.addEventListener("keydown", ev => {
  const a = document.activeElement, tn = a ? a.tagName : "";
  if (tn === "INPUT" || tn === "TEXTAREA" || tn === "SELECT") { if (ev.key === "Escape") a.blur(); return; }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === "Escape") { const p = $("#sync-pop"); if (p) p.hidden = true; return; }
  // Sur un bouton, Espace/Entrée déclenchent déjà son clic : ne pas doubler l'action.
  if ((tn === "BUTTON" || tn === "A" || tn === "SUMMARY") && (ev.key === " " || ev.key === "Enter")) return;
  const handler = KEYS[st.view];
  if (handler && handler(ev.key.length === 1 ? ev.key.toLowerCase() : ev.key)) ev.preventDefault();
});

/* ---------- démarrage ---------- */
document.body.dataset.deck = D.id;
rebuildEntries();
buildShell();
buildSyncPopover();
paintArt();
paintStreak();
paintSync();

// Ancien lien venant de focus.html : ?focus=<id>&sub=<type>
const params = new URLSearchParams(location.search), legacyFocus = params.get("focus");
if (legacyFocus && entryById(legacyFocus)) {
  history.replaceState(null, "", location.pathname);
  openInBrowse(entryById(legacyFocus), { tag: "focus", type: params.get("sub") || null });
} else show((location.hash || "").slice(1) || "session");
root.addEventListener("hashchange", () => show((location.hash || "").slice(1)));

syncAll();
setInterval(() => { if (!document.hidden) syncAll(); }, 120000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stores.forEach(s => { s.flush(); });
  else {
    if (Date.now() - lastSyncAll > 30000) syncAll();
    // Nouvelle journée pendant que l'onglet dormait : repartir sur la session du jour.
    if (sess && sess.day !== todayIso()) { sess = null; if (st.view === "session") renderSession(0); }
    paintStreak();
  }
});
})(typeof window !== "undefined" ? window : globalThis);
