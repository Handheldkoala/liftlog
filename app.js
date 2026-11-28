'use strict';
/* Lift Log — screens, gestures and actions. Data model and maths are in data.js, cloud sync in sync.js. */

/* ---------- storage ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('liftlog', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('kv'); d.createObjectStore('videos', { keyPath: 'id' }).createIndex('exId', 'exId'); };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = DB.db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get: k => DB.tx('kv', 'readonly', s => s.get(k)),
  set: (k, v) => DB.tx('kv', 'readwrite', s => s.put(v, k)),
  putVideo: v => DB.tx('videos', 'readwrite', s => s.put(v)),
  delVideo: id => DB.tx('videos', 'readwrite', s => s.delete(id)),
  allVideos: () => DB.tx('videos', 'readonly', s => s.getAll()),
  clearVideos: () => DB.tx('videos', 'readwrite', s => s.clear()),
};

let S;          // persisted state
let VIDS = [];  // video records
const UI = {
  tab: 'train', stack: { train: [], history: [], progress: [], library: [], profile: [] }, scroll: {}, lastKey: '',
  histSort: 'new', histQ: '', histProg: 'all', libQ: '', libSort: 'sec', libOpen: new Set(['d-squat', 'd-bench-press', 'd-deadlift'].map(() => '')),
  exRange: 'all', exPage: 0, exFamily: false, e1rmLow: false, repN: 5, bodyRange: '3m', profSeg: 'me', fbKind: 'idea', progPeriod: 'month', heatMode: 'frac',
  editW: null, urls: [], pick: null, sheetClose: null, picker: null, edit: null, vidTarget: null, noClick: false,
};
UI.libOpen.clear();

let saveTimer;
function save(now) {
  clearTimeout(saveTimer);
  const go = () => DB.set('state', S).then(() => Sync.schedule()).catch(e => toast('Could not save: ' + e.message));
  if (now) go(); else saveTimer = setTimeout(go, 250);
}

/* ---------- haptics ---------- */
// iPhones don't expose vibration to web apps; Safari 18+ gives a light tick when a switch control is toggled.
const haptic = (() => {
  let lbl;
  return () => {
    try {
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      if (navigator.vibrate) { navigator.vibrate(8); return; }
      if (!lbl) {
        lbl = document.createElement('label'); lbl.setAttribute('aria-hidden', 'true');
        lbl.style.cssText = 'position:fixed;left:-99px;top:0;width:1px;height:1px;overflow:hidden;opacity:0';
        const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', ''); i.tabIndex = -1;
        lbl.appendChild(i); document.body.appendChild(lbl);
      }
      lbl.click();
    } catch {}
  };
})();

/* ---------- lookups ---------- */
const ex = id => S.exercises.find(e => e.id === id) || { id, name: 'Deleted exercise', sec: '', icon: 'barbell', m: { p: [], s: [] }, archived: true };
const secOf = x => S.sections.find(s => s.id === x.sec);
const isMain = x => !x.parent || !S.exercises.some(y => y.id === x.parent && !y.archived);
const kidsOf = id => S.exercises.filter(x => x.parent === id && !x.archived);
const mainOf = x => isMain(x) ? x : ex(x.parent);
const familyIds = id => { const m = mainOf(ex(id)); return [m.id, ...kidsOf(m.id).map(k => k.id)]; };
const isCardio = x => x.kind === 'cardio';
const getW = k => k === 'a' ? S.active : S.workouts.find(w => w.id === k);
const performed = s => s.done && num(s.r) > 0;
const working = s => performed(s) && !s.warm;

function sessionsFor(ids) {
  ids = new Set([].concat(ids));
  const out = [];
  for (const w of S.workouts) {
    let sets = [], first = null;
    for (const e of w.exercises) {
      if (!ids.has(e.exId)) continue;
      const ss = e.sets.filter(performed).map(s => ({ ...s, et: e.et, exId: e.exId }));
      if (ss.length) { sets = sets.concat(ss); first = first || e; }
    }
    if (sets.length) out.push({ w, e: first, sets });
  }
  return out.sort((a, b) => b.w.start - a.w.start);
}
function bestE1rm(exId) {
  let b = 0;
  for (const w of S.workouts) for (const e of w.exercises) if (e.exId === exId) for (const s of e.sets) if (working(s)) b = Math.max(b, e1rm(num(s.w) || 0, num(s.r)));
  return b;
}
const strengthEx = e => !isCardio(ex(e.exId));
const wVolume = w => w.exercises.filter(strengthEx).reduce((v, e) => v + e.sets.filter(working).reduce((a, s) => a + (num(s.w) || 0) * num(s.r), 0), 0);
const wSets = w => w.exercises.filter(strengthEx).reduce((n, e) => n + e.sets.filter(working).length, 0);
const wPRs = w => w.exercises.reduce((n, e) => n + e.sets.filter(s => s.isPR).length, 0);
function effortText(s, et) {
  et = et || s.et;
  if (s.e === '' || s.e == null || !et || et === 'off') return '';
  return et === 'RIR' ? ` · ${s.e} RIR` : ` @${s.e}`;
}
function setLabel(s, et, cardio) {
  const w = num(s.w);
  if (cardio) return `${num(s.r) || 0} min${w > 0 ? ' · ' + fmtN(w, 2) + ' km' : ''}`;
  return (w > 0 ? fmtN(w) + ' × ' : '') + (num(s.r) || 0) + (et !== undefined ? effortText(s, et) : '');
}

/* ---------- workouts ---------- */
const newSet = (pw = '', pr = '') => ({ id: uid(), w: '', r: '', e: '', done: false, doneAt: null, restAfter: null, pw: String(pw ?? ''), pr: String(pr ?? '') });
function placeholders(exId, n, reps) {
  const last = sessionsFor(exId)[0];
  const work = last ? last.sets.filter(s => !s.warm) : [];
  return Array.from({ length: n }, (_, i) => {
    const ls = work[Math.min(i, work.length - 1)];
    return [S.settings.autofill && ls ? ls.w : '', reps || (ls ? ls.r : '') || S.settings.defReps || ''];
  });
}
function makeEntry(exId, n, reps) {
  n = Math.max(1, +n || +S.settings.defSets || 3);
  return { id: uid(), exId, et: isCardio(ex(exId)) ? 'off' : S.settings.effort, fold: false, sets: placeholders(exId, n, reps).map(([w, r]) => newSet(w, r)) };
}
function startWorkout(name, programId, items) {
  if (S.active) { goWorkout(); toast('Finish this workout first'); return; }
  S.active = { id: uid(), name: name || '', programId: programId || null, start: Date.now(), end: null, notes: '', lastDoneAt: null, lastLabel: '',
    exercises: (items || []).map(it => makeEntry(it.exId, it.sets, it.reps)) };
  save(); UI.tab = 'train'; UI.stack.train = []; render('push');
}
function recomputeRests(w) {
  const done = [];
  for (const e of w.exercises) for (const s of e.sets) if (s.done && s.doneAt) done.push({ s, e });
  done.sort((a, b) => a.s.doneAt - b.s.doneAt);
  done.forEach((d, i) => { d.s.restAfter = i < done.length - 1 ? Math.round((done[i + 1].s.doneAt - d.s.doneAt) / 1000) : null; });
  const last = done[done.length - 1];
  w.lastDoneAt = last ? last.s.doneAt : null;
  w.lastLabel = last ? `${ex(last.e.exId).name} · ${setLabel(last.s, undefined, isCardio(ex(last.e.exId)))}` : '';
}
function recomputeAllPRs() {
  const best = {};
  for (const w of [...S.workouts].sort((a, b) => a.start - b.start)) for (const e of w.exercises) {
    const cardio = isCardio(ex(e.exId));
    for (const s of [...e.sets].sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0))) {
      s.isPR = false;
      if (cardio || !working(s)) continue;
      const v = e1rm(num(s.w) || 0, num(s.r)), b = best[e.exId] || 0;
      if (b > 0 && v > b + 1e-9) s.isPR = true;
      if (v > b) best[e.exId] = v;
    }
  }
}
function markActivePRs() {
  const w = S.active; if (!w) return;
  for (const e of w.exercises) {
    const before = bestE1rm(e.exId); let best = before;
    for (const s of e.sets) s.isPR = false;
    if (isCardio(ex(e.exId))) continue;
    for (const s of e.sets.filter(working).sort((a, b) => a.doneAt - b.doneAt)) {
      const v = e1rm(num(s.w) || 0, num(s.r));
      s.isPR = before > 0 && v > best + 1e-9;
      if (v > best) best = v;
    }
  }
}
function suggestName(w) {
  const p = w.programId && S.programs.find(x => x.id === w.programId);
  if (w.name) return w.name;
  if (p) return p.name;
  const lifts = [];
  for (const e of w.exercises) {
    const m = mainOf(ex(e.exId));
    if (m.sec === 's-sbd' && !lifts.includes(m.name.split(' ')[0])) lifts.push(m.name.split(' ')[0]);
  }
  if (lifts.length) return lifts.join(' & ') + ' day';
  const d = new Date(w.start), h = d.getHours();
  return d.toLocaleDateString('en-GB', { weekday: 'long' }) + ' ' + (h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening');
}
function goWorkout() { UI.tab = 'train'; UI.stack.train = []; closeSheet(true); render(); }

/* ---------- theme & screen ---------- */
const THEMES = [['auto', 'Automatic', 'Follows your iPhone'], ['light', 'White', ''], ['dark', 'Dark', ''], ['red', 'Black / red', ''], ['blue', 'Black / blue', '']];
function applyTheme() {
  const t = S.settings.theme;
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('ll-theme', t); } catch {}
  const dark = t !== 'light' && (t !== 'auto' || matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name="theme-color"]').setAttribute('content', dark ? '#000000' : '#f2f2f7');
}
let wakeLock = null;
async function syncWake() {
  const want = !!(S.active && S.settings.wake && document.visibilityState === 'visible');
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    else if (!want && wakeLock) { const l = wakeLock; wakeLock = null; await l.release(); }
  } catch {}
}

/* ---------- navigation ---------- */
const TITLES = { train: 'Train', history: 'History', progress: 'Progress', library: 'Library', profile: 'Profile' };
function routeTitle(r) {
  if (!r) return UI.tab === 'train' && S.active ? 'Workout' : TITLES[UI.tab];
  if (r.v === 'program') return S.programs.find(p => p.id === r.id)?.name || 'Program';
  if (r.v === 'exercise') return ex(r.id).name;
  if (r.v === 'workout') return S.workouts.find(w => w.id === r.id)?.name || 'Workout';
  return '';
}
function backLabel() { const st = UI.stack[UI.tab]; const t = routeTitle(st[st.length - 2]); return t.length > 18 ? t.slice(0, 17) + '…' : t; }
function push(r) { UI.stack[UI.tab].push(r); render('push'); }
function back() { const r = UI.stack[UI.tab].pop(); if (r && r.v === 'workout' && UI.editW === r.id) finishEditing(r.id); render('pop'); }

function render(anim) {
  const view = $('#view');
  UI.scroll[UI.lastKey] = view.scrollTop;
  const st = UI.stack[UI.tab], r = st[st.length - 1];
  const key = UI.tab + ':' + (r ? r.v + r.id : 'root') + (UI.tab === 'train' && !r && S.active ? S.active.id : '');
  for (const u of UI.urls) URL.revokeObjectURL(u);
  UI.urls = [];
  view.innerHTML = r ? ({ program: vProgram, exercise: vExercise, workout: vWorkout })[r.v](r.id)
    : ({ train: vTrain, history: vHistory, progress: vProgress, library: vLibrary, profile: vProfile })[UI.tab]();
  view.scrollTop = key === UI.lastKey ? UI.scroll[key] : (anim === 'push' ? 0 : UI.scroll[key] || 0);
  UI.lastKey = key;
  for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === UI.tab);
  if (anim && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const dx = anim === 'push' ? '28%' : '-28%';
    view.animate([{ transform: `translateX(${dx})`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.32,.72,0,1)' });
  }
  bindScrollers();
  updateRestbar(true); tick(); syncWake();
}

/* ---------- small components ---------- */
function header(title, { back: b, right = '', sub = '', lead = '' } = {}) {
  return `<header class="hd">${b !== undefined ? `<div class="hd-bar"><button class="back" data-a="back">${I.chevL}<span>${esc(b)}</span></button>${right}</div>` : ''}
  <div class="hd-row"><div class="hd-lead">${lead}<h1>${esc(title)}</h1></div>${b === undefined ? right : ''}</div>${sub ? `<p class="hd-sub">${sub}</p>` : ''}</header>`;
}
const searchBox = (bind, val, ph = 'Search') => `<div class="search">${I.search}<input type="search" placeholder="${ph}" data-bind="${bind}" value="${esc(val)}" autocomplete="off" autocorrect="off"></div>`;
const seg = (action, opts, cur, cls = '') => `<div class="seg ${cls}" role="tablist">${opts.map(([v, l]) => `<button role="tab" aria-selected="${v === cur}" class="${v === cur ? 'on' : ''}" data-a="${action}" data-v="${v}">${l}</button>`).join('')}</div>`;
const sw = (on, a, k) => `<button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" data-a="${a}" data-k="${k}"><span></span></button>`;
function exRow(x, { meta = '', a = 'openExercise', trail = I.chevR, sub = false, fam = '' } = {}) {
  return `<div class="row ${sub ? 'sub' : ''}"><button class="row-hit" data-a="${a}" data-id="${x.id}"><span class="row-ic">${icon(x.icon, sub ? 22 : 26)}</span><span class="row-main"><span class="row-t">${esc(x.name)}</span>${meta ? `<span class="row-s">${meta}</span>` : ''}</span></button>${fam}${trail}</div>`;
}
const famToggle = (x, a, open) => { const n = kidsOf(x.id).length; return n ? `<button class="var-tog ${open ? 'open' : ''}" data-a="${a}" data-id="${x.id}" aria-expanded="${open}">${n} variation${n > 1 ? 's' : ''}${I.chevR}</button>` : ''; };
function vidUrl(v) { const u = URL.createObjectURL(v.blob); UI.urls.push(u); return u; }
function vidGrid(list) {
  return `<div class="vgrid">${list.map(v => `<button class="vthumb" data-a="playVideo" data-id="${v.id}" aria-label="Play video from ${fmtDate(v.date)}"><video muted playsinline preload="metadata" src="${vidUrl(v)}#t=0.1"></video><span class="vplay">${svgIcon(UI_ICONS.play, 26)}</span><span class="vdate">${fmtDate(v.date, { day: 'numeric', month: 'short' })}</span></button>`).join('')}</div>`;
}

/* ---------- Train ---------- */
function vTrain() {
  if (S.active) return vActive();
  const progs = S.programs.map(p => `<div class="card prog" data-a="openProgram" data-id="${p.id}" role="button" tabindex="0">
    <div class="prog-main"><div class="prog-name">${esc(p.name)}</div><div class="prog-sub">${p.items.length ? esc(p.items.map(i => ex(i.exId).name).join(' · ')) : 'No exercises yet'}</div></div>
    <button class="pill" data-a="startProgram" data-id="${p.id}">Start</button></div>`).join('');
  const last = [...S.workouts].sort((a, b) => b.start - a.start)[0];
  return header('Train') + `<div class="pad">
    <button class="big-btn" data-a="startEmpty">${I.plus} Start empty workout</button>
    <div class="sec-hd"><h2>Programs</h2><button class="link strong" data-a="newProgram">New</button></div>
    ${progs || `<div class="empty">Programs are workouts you've saved, ready to start with one tap.<button class="link" data-a="newProgram">Create a program</button></div>`}
    ${last ? `<div class="sec-hd"><h2>Last workout</h2></div>${workoutRow(last)}` : ''}</div>`;
}
function vActive() {
  const w = S.active, anyOpen = w.exercises.some(e => !e.fold);
  return `<header class="hd"><div class="hd-bar"><button class="link danger" data-a="discardWorkout">Discard</button><button class="pill" data-a="finishWorkout">Finish</button></div>
    <div class="hd-row"><h1>${esc(w.name || (w.programId && S.programs.find(p => p.id === w.programId)?.name) || 'Workout')}</h1>
    ${w.exercises.length > 1 ? `<button class="link small" data-a="foldAll">${anyOpen ? 'Fold all' : 'Unfold all'}</button>` : ''}</div>
    <p class="hd-sub"><span data-since="${w.start}"></span> · ${fmtDate(w.start)}, ${fmtTime(w.start)}</p></header>
    <div class="pad"><div data-reorder="wex:a">${w.exercises.map((e, ei) => exCard(e, ei, 'a')).join('')}</div>
    ${w.exercises.length ? '' : `<div class="empty">Add the first exercise to start logging.</div>`}
    <button class="big-btn ghost" data-a="addExToWorkout" data-w="a">${I.plus} Add exercise</button>
    <textarea class="notes" data-bind="wn:a" placeholder="Workout notes">${esc(w.notes)}</textarea></div>`;
}
function foldSummary(e, x) {
  const done = e.sets.filter(s => s.done || (!e.live && performed(s)));
  const cardio = isCardio(x);
  let top = null;
  for (const s of done) if (!top || (num(s.w) || 0) > (num(top.w) || 0)) top = s;
  return `${done.length}/${e.sets.length} sets${top ? ' · ' + (cardio ? setLabel(top, undefined, true) : 'top ' + setLabel(top)) : ''}`;
}
function exCard(e, ei, k) {
  const w = getW(k), live = k === 'a', x = ex(e.exId), cardio = isCardio(x);
  const hasE = !cardio && e.et !== 'off';
  const fam = !isMain(x) || kidsOf(x.id).length > 0;
  const nv = VIDS.filter(v => v.workoutId === w.id && v.exId === e.exId).length;
  const cols = ['34px', '1fr', '1fr', hasE ? '58px' : '', live ? '40px' : ''].filter(Boolean).join(' ');
  const head = `<div class="ex-hd">${e.fold ? `<span class="drag" data-drag aria-label="Drag to reorder">${I.grip}</span>` : ''}
    <button class="ex-title" data-a="fold" data-w="${k}" data-ei="${ei}" aria-expanded="${!e.fold}">${icon(x.icon)}<span class="ex-name"><span>${esc(x.name)}</span>${e.fold ? `<small>${foldSummary(e, x)}</small>` : ''}</span><span class="fold-chev">${I.chevD}</span></button>
    <button class="icon-btn sm" data-a="addVideo" data-ex="${x.id}" data-w="${w.id}" aria-label="Add video">${I.video}${nv ? `<b>${nv}</b>` : ''}</button>
    <button class="icon-btn sm" data-a="exMenu" data-w="${k}" data-ei="${ei}" aria-label="More options">${I.more}</button></div>`;
  if (e.fold) return `<section class="card excard folded" data-ri="${ei}">${head}</section>`;
  const last = live ? sessionsFor(e.exId)[0] : null;
  let n = 0;
  return `<section class="card excard" data-ri="${ei}">${head}
    ${fam ? `<button class="var-chip" data-a="switchVar" data-w="${k}" data-ei="${ei}">${isMain(x) ? 'Variations' : 'Variation of ' + esc(mainOf(x).name)}${I.chevD}</button>` : ''}
    ${x.note ? `<p class="ex-note">${I.note}<span>${esc(x.note)}</span></p>` : ''}
    ${last ? `<p class="ex-last">Last time, ${fmtDate(last.w.start, { day: 'numeric', month: 'short' })}: ${last.sets.map(s => setLabel(s, undefined, cardio)).join(', ')}</p>` : ''}
    <div class="set-row head" style="grid-template-columns:${cols}"><span>Set</span><span>${cardio ? 'km' : 'kg'}</span><span>${cardio ? 'Min' : 'Reps'}</span>${hasE ? `<button class="et" data-a="exMenu" data-w="${k}" data-ei="${ei}">${e.et}</button>` : ''}${live ? '<span></span>' : ''}</div>
    ${e.sets.map((s, si) => setRow(e, s, k, ei, si, s.warm ? 'W' : ++n, cols, hasE, live, cardio)).join('')}
    <button class="add-set" data-a="addSet" data-w="${k}" data-ei="${ei}">${I.plus} Add set</button></section>`;
}
function setRow(e, s, k, ei, si, label, cols, hasE, live, cardio) {
  const w = getW(k);
  const liveRest = live && s.done && s.restAfter == null && w.lastDoneAt === s.doneAt;
  const b = `set:${k}:${ei}:${si}`;
  const pr = s.isPR ? '<span class="pr">PR</span>' : '';
  let rest = '';
  if (s.done && (liveRest || s.restAfter != null)) rest = `<div class="rest ${liveRest ? 'live' : ''}">${I.timer}${liveRest ? `<span data-since="${s.doneAt}"></span>&nbsp;resting` : `${fmtClock(s.restAfter)} rest`}${pr}</div>`;
  else if (pr) rest = `<div class="rest">${pr}</div>`;
  return `<div class="swipe" data-swipe data-w="${k}" data-ei="${ei}" data-si="${si}"><div class="swipe-bg">${I.trash}</div><div class="swipe-fg">
    <div class="set-row ${s.done && live ? 'done' : ''}" style="grid-template-columns:${cols}">
      <button class="set-n" data-a="setMenu" data-w="${k}" data-ei="${ei}" data-si="${si}" aria-label="Set ${label} options">${label}</button>
      <input inputmode="decimal" data-bind="${b}:w" value="${esc(s.w)}" placeholder="${esc(live ? s.pw : '')}" aria-label="${cardio ? 'Distance in km' : 'Weight in kg'}">
      <input inputmode="${cardio ? 'decimal' : 'numeric'}" data-bind="${b}:r" value="${esc(s.r)}" placeholder="${esc(live ? s.pr : '')}" aria-label="${cardio ? 'Minutes' : 'Reps'}">
      ${hasE ? `<input inputmode="decimal" data-bind="${b}:e" value="${esc(s.e)}" placeholder="–" aria-label="${e.et}">` : ''}
      ${live ? `<button class="check" data-a="toggleSet" data-ei="${ei}" data-si="${si}" aria-label="${s.done ? 'Mark not done' : 'Mark done'}">${I.check}</button>` : ''}
    </div>${rest}</div></div>`;
}

/* ---------- Program editor ---------- */
function vProgram(id) {
  const p = S.programs.find(x => x.id === id);
  if (!p) return header('Program removed', { back: backLabel() });
  return `<header class="hd"><div class="hd-bar"><button class="back" data-a="back">${I.chevL}<span>${esc(backLabel())}</span></button></div>
    <input class="title-input" data-bind="prog:${id}:name" value="${esc(p.name)}" placeholder="Program name" aria-label="Program name" enterkeyhint="done"></header>
    <div class="pad"><button class="big-btn" data-a="startProgram" data-id="${id}">${svgIcon(UI_ICONS.play, 18)} Start workout</button>
    <div class="sec-hd"><h2>Exercises</h2></div>
    ${p.items.length ? `<div class="card list" data-reorder="prog:${id}">${p.items.map((it, i) => { const x = ex(it.exId); return `<div class="row" data-ri="${i}">
      <span class="drag" data-drag aria-label="Drag to reorder">${I.grip}</span><span class="row-ic">${icon(x.icon)}</span>
      <span class="row-main"><span class="row-t">${esc(x.name)}</span>
        <span class="row-s pfields"><input class="mini" inputmode="numeric" data-bind="pi:${id}:${i}:sets" value="${esc(it.sets)}" aria-label="Sets"> sets × <input class="mini" inputmode="numeric" data-bind="pi:${id}:${i}:reps" value="${esc(it.reps)}" placeholder="–" aria-label="Reps"> ${isCardio(x) ? 'min' : 'reps'}</span></span>
      <button class="icon-btn sm" data-a="progItemMenu" data-id="${id}" data-i="${i}" aria-label="More options">${I.more}</button></div>`; }).join('')}</div>`
      : `<div class="empty">No exercises yet.</div>`}
    <button class="big-btn ghost" data-a="addExToProgram" data-id="${id}">${I.plus} Add exercise</button>
    <div class="sec-hd"></div>
    <button class="big-btn ghost" data-a="dupProgram" data-id="${id}">Duplicate program</button>
    <button class="big-btn ghost danger" data-a="deleteProgram" data-id="${id}">Delete program</button></div>`;
}

/* ---------- History ---------- */
function workoutRow(w) {
  const ids = [...new Set(w.exercises.map(e => e.exId))];
  const prs = wPRs(w);
  return `<button class="card" data-a="openWorkout" data-id="${w.id}">
    <div class="wrow-t"><span>${esc(w.name)}</span><span class="muted">${fmtDate(w.start)}</span></div>
    <div class="wrow-s">${fmtDur(w.end - w.start)} · ${fmtVol(wVolume(w))} · ${wSets(w)} sets${prs ? ` · ${prs} PR${prs > 1 ? 's' : ''}` : ''}</div>
    <div class="wrow-ic">${ids.slice(0, 10).map(id => icon(ex(id).icon, 22)).join('')}</div></button>`;
}
function histList() {
  const q = UI.histQ.trim().toLowerCase();
  const hasProg = w => w.programId && S.programs.some(p => p.id === w.programId);
  let list = S.workouts.filter(w => (!q || w.name.toLowerCase().includes(q) || w.exercises.some(e => ex(e.exId).name.toLowerCase().includes(q)))
    && (UI.histProg === 'all' || (UI.histProg === 'none' ? !hasProg(w) : w.programId === UI.histProg)));
  const by = { new: (a, b) => b.start - a.start, old: (a, b) => a.start - b.start, long: (a, b) => (b.end - b.start) - (a.end - a.start), vol: (a, b) => wVolume(b) - wVolume(a) };
  list.sort(by[UI.histSort]);
  if (!S.workouts.length) return `<div class="empty">Finished workouts show up here.</div>`;
  if (!list.length) return `<div class="empty">No workouts match.</div>`;
  if (UI.histSort !== 'new' && UI.histSort !== 'old') return list.map(workoutRow).join('');
  let m = '', out = '';
  for (const w of list) {
    const mm = fmtDate(w.start, { month: 'long', year: 'numeric' });
    if (mm !== m) { out += `<p class="month">${mm}</p>`; m = mm; }
    out += workoutRow(w);
  }
  return out;
}
function vHistory() {
  const weekAgo = Date.now() - 7 * DAY;
  const sub = S.workouts.length ? `${S.workouts.length} workout${S.workouts.length > 1 ? 's' : ''} · ${S.workouts.filter(w => w.start > weekAgo).length} in the last 7 days` : '';
  const progIds = [...new Set(S.workouts.map(w => w.programId).filter(id => id && S.programs.some(p => p.id === id)))];
  const chips = progIds.length ? `<div class="chip-row">${[['all', 'All'], ...progIds.map(id => [id, S.programs.find(p => p.id === id).name]), ['none', 'No program']]
    .map(([v, l]) => `<button class="chip ${UI.histProg === v ? 'on' : ''}" data-a="histProg" data-v="${v}">${esc(l)}</button>`).join('')}</div>` : '';
  return header('History', { sub }) + `<div class="pad">${searchBox('histQ', UI.histQ, 'Search workouts or exercises')}
    ${seg('histSort', [['new', 'Newest'], ['old', 'Oldest'], ['long', 'Longest'], ['vol', 'Volume']], UI.histSort)}${chips}
    <div id="hist-list">${histList()}</div></div>`;
}
function vWorkout(id) {
  const w = S.workouts.find(x => x.id === id);
  if (!w) return header('Workout removed', { back: backLabel() });
  const editing = UI.editW === id, prs = wPRs(w);
  const top = `<header class="hd"><div class="hd-bar"><button class="back" data-a="back">${I.chevL}<span>${esc(backLabel())}</span></button>
    <button class="link strong" data-a="${editing ? 'doneEditW' : 'editW'}" data-id="${id}">${editing ? 'Done' : 'Edit'}</button></div>
    ${editing ? `<input class="title-input" data-bind="wk:${id}:name" value="${esc(w.name)}" aria-label="Workout name" enterkeyhint="done">` : `<div class="hd-row"><h1>${esc(w.name)}</h1></div>`}
    <p class="hd-sub">${fmtDate(w.start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${fmtTime(w.start)}–${fmtTime(w.end)}</p></header>`;
  if (editing) return top + `<div class="pad"><p class="muted hint">Swipe a set left to delete it. Empty sets are removed when you tap Done.</p>
    <div data-reorder="wex:${id}">${w.exercises.map((e, ei) => exCard(e, ei, id)).join('')}</div>
    <button class="big-btn ghost" data-a="addExToWorkout" data-w="${id}">${I.plus} Add exercise</button>
    <textarea class="notes" data-bind="wn:${id}" placeholder="Workout notes">${esc(w.notes)}</textarea></div>`;
  return top + `<div class="pad"><div class="stats">
      <div class="stat"><div class="k">Duration</div><div class="v">${fmtDur(w.end - w.start)}</div></div>
      <div class="stat"><div class="k">Volume</div><div class="v">${fmtVol(wVolume(w))}</div></div>
      <div class="stat"><div class="k">Working sets</div><div class="v">${wSets(w)}</div></div>
      <div class="stat"><div class="k">PRs</div><div class="v">${prs}</div></div></div>
    ${w.exercises.map(e => { const x = ex(e.exId), cardio = isCardio(x); const vids = VIDS.filter(v => v.workoutId === w.id && v.exId === e.exId); let n = 0; return `<section class="card excard">
      <div class="ex-hd"><button class="ex-title" data-a="openExercise" data-id="${x.id}">${icon(x.icon)}<span class="ex-name"><span>${esc(x.name)}</span></span></button>
      <button class="icon-btn sm" data-a="addVideo" data-ex="${x.id}" data-w="${w.id}" aria-label="Add video">${I.video}</button></div>
      <div style="margin-top:8px">${e.sets.map(s => `<div class="wd-set"><span class="n">${s.warm ? 'W' : ++n}</span><span>${setLabel(s, e.et, cardio)}${s.isPR ? '<span class="pr">PR</span>' : ''}</span><span class="r">${s.restAfter != null ? fmtClock(s.restAfter) + ' rest' : ''}</span></div>`).join('')}</div>
      ${vids.length ? vidGrid(vids) : ''}</section>`; }).join('')}
    ${w.notes ? `<div class="card"><div class="muted" style="font-size:13px;font-weight:600;margin-bottom:4px">Notes</div>${esc(w.notes).replace(/\n/g, '<br>')}</div>` : ''}
    <div class="sec-hd"></div>
    <button class="big-btn" data-a="repeatWorkout" data-id="${id}">Repeat this workout</button>
    <button class="big-btn ghost" data-a="saveAsProgram" data-id="${id}">Save as program</button>
    <button class="big-btn ghost danger" data-a="deleteWorkout" data-id="${id}">Delete workout</button></div>`;
}
function finishEditing(id) {
  const w = S.workouts.find(x => x.id === id);
  UI.editW = null;
  if (!w) return;
  for (const e of w.exercises) { e.sets = e.sets.filter(s => num(s.r) > 0); for (const s of e.sets) { s.done = true; delete s.pw; delete s.pr; } }
  w.exercises = w.exercises.filter(e => e.sets.length);
  if (!w.name.trim()) w.name = suggestName({ ...w, name: '' });
  recomputeAllPRs(); save();
}

/* ---------- Library ---------- */
function useCounts() { const c = {}; for (const w of S.workouts) for (const e of w.exercises) c[e.exId] = (c[e.exId] || 0) + 1; return c; }
const sessionsText = n => n ? `${n} session${n > 1 ? 's' : ''}` : '';
function libList() {
  const q = UI.libQ.trim().toLowerCase(), counts = useCounts();
  const live = S.exercises.filter(x => !x.archived);
  if (q || UI.libSort === 'used') {
    let list = live.filter(x => x.name.toLowerCase().includes(q));
    if (!list.length) return `<div class="empty">No exercise called “${esc(UI.libQ)}”.<button class="link" data-a="newExLib">Create it</button></div>`;
    if (UI.libSort === 'used') {
      list.sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0) || a.name.localeCompare(b.name));
      const used = list.filter(x => counts[x.id]), rest = list.filter(x => !counts[x.id]);
      return (used.length ? `<p class="grp-t">Most used</p><div class="card list">${used.map(x => exRow(x, { meta: sessionsText(counts[x.id]) })).join('')}</div>` : `<div class="empty">Log a workout and your most used exercises will appear first.</div>`)
        + (rest.length ? `<p class="grp-t">Not used yet</p><div class="card list">${rest.map(x => exRow(x)).join('')}</div>` : '');
    }
    return S.sections.map(s => { const xs = list.filter(x => x.sec === s.id).sort((a, b) => a.name.localeCompare(b.name)); return xs.length ? `<p class="grp-t">${esc(s.name)}</p><div class="card list">${xs.map(x => exRow(x, { meta: isMain(x) ? sessionsText(counts[x.id]) : 'Variation of ' + esc(mainOf(x).name) })).join('')}</div>` : ''; }).join('');
  }
  return S.sections.map(s => {
    const mains = live.filter(x => x.sec === s.id && isMain(x)).sort((a, b) => s.id === 's-sbd' ? 0 : a.name.localeCompare(b.name));
    const orphans = live.filter(x => x.sec === s.id && !isMain(x) && ex(x.parent).sec !== s.id);
    const rows = mains.map(x => {
      const open = UI.libOpen.has(x.id);
      return exRow(x, { meta: sessionsText(counts[x.id]), fam: famToggle(x, 'libFam', open) })
        + (open ? kidsOf(x.id).sort((a, b) => a.name.localeCompare(b.name)).map(k => exRow(k, { meta: sessionsText(counts[k.id]), sub: true })).join('') : '');
    }).join('') + orphans.map(x => exRow(x, { meta: 'Variation of ' + esc(mainOf(x).name) })).join('');
    return `<p class="grp-t">${esc(s.name)}</p>${rows ? `<div class="card list">${rows}</div>` : `<div class="empty small">No exercises in this section yet.</div>`}`;
  }).join('');
}
function vLibrary() {
  return header('Library', { right: `<span class="hd-actions"><button class="link" data-a="editSections">Sections</button><button class="icon-btn" data-a="newExLib" aria-label="New exercise">${I.plus}</button></span>` })
    + `<div class="pad">${searchBox('libQ', UI.libQ)}${seg('libSort', [['sec', 'By section'], ['used', 'Most used']], UI.libSort)}<div id="lib-list">${libList()}</div></div>`;
}

/* ---------- Exercise detail ---------- */
const RANGES = [['1m', '1M', 30], ['3m', '3M', 91], ['1y', '1Y', 365], ['all', 'All', Infinity]];
const inRange = (pts, r) => { const d = RANGES.find(x => x[0] === r)[2]; const from = Date.now() - d * DAY; return pts.filter(p => p.t >= from); };
function seriesOf(sess, fn) {
  return sess.map(({ w, sets }) => { const work = sets.filter(s => !s.warm); if (!work.length) return null; const v = fn(work); return isFinite(v) && v > 0 ? { t: w.start, v } : null; }).filter(Boolean).reverse();
}
const maxOf = (arr, f) => arr.reduce((m, s) => Math.max(m, f(s)), 0);
function exPages(id) {
  const x = ex(id), sess = sessionsFor(UI.exFamily ? familyIds(id) : id);
  if (isCardio(x)) return [
    { key: 'dur', label: 'Time', unit: 'min', pts: seriesOf(sess, ws => ws.reduce((a, s) => a + (num(s.r) || 0), 0)) },
    { key: 'dist', label: 'Distance', unit: 'km', pts: seriesOf(sess, ws => ws.reduce((a, s) => a + (num(s.w) || 0), 0)) }];
  const weighted = sess.some(({ sets }) => sets.some(s => num(s.w) > 0));
  if (!weighted && sess.length) return [
    { key: 'reps', label: 'Best set', unit: 'reps', pts: seriesOf(sess, ws => maxOf(ws, s => num(s.r) || 0)) },
    { key: 'tot', label: 'Total reps', unit: 'reps', pts: seriesOf(sess, ws => ws.reduce((a, s) => a + (num(s.r) || 0), 0)) }];
  const low = UI.e1rmLow;
  return [
    { key: 'e1rm', label: 'Est. 1RM', unit: 'kg', note: low ? 'Sets of 1–5 reps' : 'Best set each session', toggle: true,
      pts: seriesOf(sess, ws => maxOf(ws.filter(s => !low || num(s.r) <= 5), s => e1rm(num(s.w) || 0, num(s.r)))) },
    { key: 'rpe', label: 'RPE-adjusted 1RM', unit: 'kg', note: 'Counts how hard each set was · only sets with RPE/RIR',
      pts: seriesOf(sess, ws => maxOf(ws, rpeE1rm)) },
    { key: 'rep', label: `${UI.repN}-rep max`, unit: 'kg', note: `Heaviest weight for ${UI.repN}+ reps`, wheel: true,
      pts: seriesOf(sess, ws => maxOf(ws.filter(s => num(s.r) >= UI.repN), s => num(s.w) || 0)) },
    { key: 'top', label: 'Top weight', unit: 'kg', note: 'Heaviest weight lifted', pts: seriesOf(sess, ws => maxOf(ws, s => num(s.w) || 0)) },
    { key: 'vol', label: 'Volume', unit: 'kg', vol: true, note: 'Weight × reps, working sets', pts: seriesOf(sess, ws => ws.reduce((a, s) => a + (num(s.w) || 0) * num(s.r), 0)) },
  ];
}
function pageCard(p) {
  const extra = (p.toggle ? `<button class="chip mini-chip ${UI.e1rmLow ? 'on' : ''}" data-a="e1rmLow">1–5 reps only</button>` : '')
    + (p.wheel ? wheel() : '');
  return chartCard({ label: p.label, pts: inRange(p.pts, UI.exRange), unit: p.unit, isVol: p.vol, note: p.note, extra, id: 'pg-' + p.key });
}
function wheel() {
  return `<div class="wheel" data-wheel aria-label="Number of reps"><div class="wheel-track">${Array.from({ length: 15 }, (_, i) => i + 1)
    .map(n => `<button class="wheel-n ${n === UI.repN ? 'on' : ''}" data-a="wheelPick" data-n="${n}">${n}</button>`).join('')}</div></div>`;
}
function vExercise(id) {
  const x = ex(id), main = mainOf(x), hasFam = kidsOf(main.id).length > 0;
  const sess = sessionsFor(UI.exFamily ? familyIds(id) : id);
  const pages = exPages(id);
  if (UI.exPage >= pages.length) UI.exPage = 0;
  const all = sess.flatMap(o => o.sets.filter(s => !s.warm));
  const cardio = isCardio(x);
  const best = cardio ? 0 : maxOf(all, s => e1rm(num(s.w) || 0, num(s.r))), heavy = maxOf(all, s => num(s.w) || 0);
  const vol = all.reduce((a, s) => a + (num(s.w) || 0) * num(s.r), 0);
  const vids = VIDS.filter(v => (UI.exFamily ? familyIds(id) : [id]).includes(v.exId)).sort((a, b) => b.date - a.date);
  const subBits = [esc(secOf(x)?.name || '')];
  if (!isMain(x)) subBits.push(`Variation of <button class="inline-link" data-a="openExercise" data-id="${main.id}">${esc(main.name)}</button>`);
  return header(x.name, { back: backLabel(), right: `<button class="link" data-a="editEx" data-id="${id}">Edit</button>`, sub: subBits.join(' · '), lead: `<span class="hero-ic">${icon(x.icon, 32)}</span>` })
  + `<div class="pad">
    ${hasFam ? seg('exFamily', [['0', 'This lift'], ['1', 'With variations']], UI.exFamily ? '1' : '0') : ''}
    <div class="carousel" data-carousel>${pages.map(p => `<div class="page">${pageCard(p)}</div>`).join('')}</div>
    ${pages.length > 1 ? `<div class="dots">${pages.map((p, i) => `<span class="${i === UI.exPage ? 'on' : ''}"></span>`).join('')}</div>` : ''}
    ${seg('exRange', RANGES.map(r => [r[0], r[1]]), UI.exRange)}
    ${cardio ? '' : `<div class="stats">
      <div class="stat"><div class="k">Best est. 1RM</div><div class="v">${best ? fmtN(best) + ' kg' : '–'}</div></div>
      <div class="stat"><div class="k">Heaviest</div><div class="v">${heavy ? fmtN(heavy) + ' kg' : '–'}</div></div>
      <div class="stat"><div class="k">Sessions</div><div class="v">${sess.length}</div></div>
      <div class="stat"><div class="k">Total volume</div><div class="v">${fmtVol(vol)}</div></div></div>`}
    ${x.note ? `<div class="card ex-note-card">${I.note}<span>${esc(x.note)}</span></div>` : ''}
    <div class="sec-hd"><h2>Videos</h2><button class="link strong" data-a="addVideo" data-ex="${id}">Add</button></div>
    ${vids.length ? vidGrid(vids) : `<div class="empty">Record a set or pick a video from your library to watch it back here.</div>`}
    <div class="sec-hd"><h2>History</h2>${sess.length ? `<span class="muted">${sess.length} session${sess.length > 1 ? 's' : ''}</span>` : ''}</div>
    ${sess.length ? sess.map(({ w, sets }) => `<button class="card" data-a="openWorkout" data-id="${w.id}">
      <div class="hist-hd"><span>${fmtDate(w.start, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span><span class="muted">${esc(w.name)}</span></div>
      <div class="hist-sets">${sets.map(s => `<span class="${s.warm ? 'w' : ''}">${UI.exFamily && s.exId !== id ? `<em>${esc(ex(s.exId).name)}</em> ` : ''}${setLabel(s, s.et, cardio)}${s.isPR ? '<span class="pr">PR</span>' : ''}</span>`).join('')}</div></button>`).join('')
      : `<div class="empty">Every set you log for ${esc(x.name)} will be listed here.</div>`}
  </div>`;
}

/* ---------- Progress ---------- */
const PERIODS = [['week', 'Week', 7], ['month', 'Month', 30], ['3m', '3 months', 91], ['year', 'Year', 365]];
function muscleSets(ws, mode) {
  const t = Object.fromEntries(MUSCLES.map(m => [m[0], 0]));
  for (const w of ws) for (const e of w.exercises) {
    const x = ex(e.exId); if (isCardio(x)) continue;
    const n = e.sets.filter(working).length; if (!n) continue;
    for (const p of x.m.p) if (p in t) t[p] += n;
    if (mode === 'frac') for (const s of x.m.s) if (s in t) t[s] += n * .5;
  }
  return t;
}
function progressData(days) {
  const now = Date.now(), from = now - days * DAY, pfrom = from - days * DAY;
  const all = [...S.workouts].sort((a, b) => a.start - b.start);
  const cur = all.filter(w => w.start >= from), prev = all.filter(w => w.start >= pfrom && w.start < from);
  const series = {};
  for (const w of all) for (const e of w.exercises) {
    if (isCardio(ex(e.exId))) continue;
    const b = maxOf(e.sets.filter(working), s => e1rm(num(s.w) || 0, num(s.r)));
    if (b > 0) (series[e.exId] = series[e.exId] || []).push({ t: w.start, v: b });
  }
  const mx = ps => maxOf(ps, p => p.v);
  const improving = [], dropping = [], plateaus = [];
  for (const [id, pts] of Object.entries(series)) {
    const before = pts.filter(p => p.t < from), inCur = pts.filter(p => p.t >= from), inPrev = pts.filter(p => p.t >= pfrom && p.t < from);
    if (inCur.length && before.length) {
      const bc = mx(inCur), bb = mx(before);
      if (bc > bb + 1e-9) improving.push({ id, d: bc - bb, pct: (bc - bb) / bb, v: bc });
      else if (inPrev.length) { const bp = mx(inPrev); if (bc < bp * .975) dropping.push({ id, d: bc - bp, pct: (bc - bp) / bp, v: bc }); }
    }
    let best = 0, bestT = 0;
    for (const p of pts) if (p.v > best + 1e-9) { best = p.v; bestT = p.t; }
    const since = pts.filter(p => p.t > bestT).length, recent = pts.filter(p => p.t >= now - 42 * DAY).length;
    if (now - bestT > 28 * DAY && since >= 3 && recent >= 2) plateaus.push({ id, weeks: Math.floor((now - bestT) / (7 * DAY)), since, v: best });
  }
  improving.sort((a, b) => b.pct - a.pct); dropping.sort((a, b) => a.pct - b.pct); plateaus.sort((a, b) => b.weeks - a.weeks);
  const prs = cur.flatMap(w => w.exercises.flatMap(e => e.sets.filter(s => s.isPR).map(s => ({ w, e, s }))));
  const weeks = Math.max(1, days / 7);
  const heat = muscleSets(cur, UI.heatMode);
  for (const k in heat) heat[k] /= weeks;
  const focus = [];
  if (cur.length) {
    const frac = muscleSets(cur, 'frac'); for (const k in frac) frac[k] /= weeks;
    const vals = MUSCLES.map(m => frac[m[0]]).filter(v => v > 0).sort((a, b) => a - b);
    const median = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
    const skip = new Set(['forearms', 'adductors']);
    const none = MUSCLES.filter(([k]) => !skip.has(k) && frac[k] === 0).map(m => m[1]);
    if (none.length) focus.push({ t: `Not trained: ${none.join(', ')}`, s: 'No direct or indirect sets in this period.' });
    for (const [k, n] of MUSCLES) if (!skip.has(k) && frac[k] > 0 && frac[k] < median * .4) focus.push({ t: `${n} is low`, s: `${fmtN(frac[k])} sets a week, against a typical ${fmtN(median)} for your other muscles.` });
    const push = frac.chest + frac.fdelt + frac.triceps, pull = frac.lats + frac.traps + frac.rdelt + frac.biceps;
    if (pull > 0 && push > pull * 1.5) focus.push({ t: 'More pushing than pulling', s: `${fmtN(push)} pushing vs ${fmtN(pull)} pulling sets a week. Extra rows or pulldowns balance the shoulders.` });
    if (frac.quads > 0 && frac.hams < frac.quads * .4) focus.push({ t: 'Hamstrings lag behind quads', s: `${fmtN(frac.hams)} vs ${fmtN(frac.quads)} sets a week.` });
  }
  const sum = ws => ({ n: ws.length, sets: ws.reduce((a, w) => a + wSets(w), 0), vol: ws.reduce((a, w) => a + wVolume(w), 0), prs: ws.reduce((a, w) => a + wPRs(w), 0) });
  return { cur: sum(cur), prev: sum(prev), improving, dropping, plateaus, prs, heat, focus, weeks };
}
const FIG_FRONT = [
  ['', 'circle', { cx: 50, cy: 13, r: 8.5 }], ['', 'rect', { x: 46, y: 20, width: 8, height: 8, rx: 3 }],
  ['sdelt', 'ellipse', { cx: 28, cy: 37, rx: 6, ry: 7.5 }, 1], ['fdelt', 'ellipse', { cx: 33.5, cy: 35, rx: 6, ry: 6.5 }, 1],
  ['chest', 'rect', { x: 37, y: 30, width: 12.5, height: 18, rx: 5 }, 1], ['biceps', 'rect', { x: 20.5, y: 44, width: 9, height: 19, rx: 4.5 }, 1],
  ['forearms', 'rect', { x: 17, y: 65, width: 8.5, height: 23, rx: 4.2 }, 1], ['', 'circle', { cx: 21.2, cy: 92, r: 3.2 }, 1],
  ['abs', 'rect', { x: 40, y: 50, width: 20, height: 29, rx: 5 }], ['', 'rect', { x: 37, y: 80.5, width: 26, height: 8, rx: 4 }],
  ['quads', 'rect', { x: 36, y: 89, width: 13, height: 40, rx: 6 }, 1], ['adductors', 'rect', { x: 45.4, y: 91, width: 3.8, height: 25, rx: 1.9 }, 1],
  ['calves', 'rect', { x: 38, y: 132, width: 10, height: 36, rx: 5 }, 1], ['', 'ellipse', { cx: 43, cy: 173, rx: 6, ry: 3 }, 1],
];
const FIG_BACK = [
  ['', 'circle', { cx: 50, cy: 13, r: 8.5 }], ['', 'rect', { x: 46, y: 20, width: 8, height: 8, rx: 3 }],
  ['lats', 'path', { d: 'M38 41 L47 52 L46.5 72 L41 71 L35 52 Z' }], ['lats', 'path', { d: 'M62 41 L53 52 L53.5 72 L59 71 L65 52 Z' }],
  ['traps', 'path', { d: 'M50 23 L61 31 L57 50 L43 50 L39 31 Z' }], ['rdelt', 'ellipse', { cx: 30, cy: 35.5, rx: 6.5, ry: 7 }, 1],
  ['triceps', 'rect', { x: 20.5, y: 44, width: 9, height: 19, rx: 4.5 }, 1], ['forearms', 'rect', { x: 17, y: 65, width: 8.5, height: 23, rx: 4.2 }, 1],
  ['', 'circle', { cx: 21.2, cy: 92, r: 3.2 }, 1], ['lowback', 'rect', { x: 43, y: 58, width: 14, height: 21, rx: 4 }],
  ['glutes', 'rect', { x: 37, y: 80.5, width: 12.5, height: 17, rx: 6 }, 1], ['hams', 'rect', { x: 37, y: 99.5, width: 12, height: 30, rx: 6 }, 1],
  ['calves', 'ellipse', { cx: 43, cy: 146, rx: 5.5, ry: 14 }, 1], ['', 'ellipse', { cx: 43, cy: 173, rx: 6, ry: 3 }, 1],
];
function mirror(type, a) {
  const b = { ...a };
  if (type === 'rect') b.x = 100 - a.x - a.width; else if ('cx' in a) b.cx = 100 - a.cx;
  return b;
}
function heatFill(v) { return v > 0 ? `fill:var(--acc);fill-opacity:${(.2 + .8 * Math.min(1, v / 20)).toFixed(2)}` : 'fill:var(--fill2)'; }
function figure(shapes, heat, label) {
  const el = (m, type, a) => `<${type} ${Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ')} ${m ? `class="mz" data-a="muscleInfo" data-m="${m}" style="${heatFill(heat[m])}"` : 'class="mz-n"'}/>`;
  return `<figure class="fig"><svg viewBox="0 0 100 180" role="img" aria-label="${label}">${shapes.map(([m, type, a, mir]) => el(m, type, a) + (mir ? el(m, type, mirror(type, a)) : '')).join('')}</svg><figcaption>${label}</figcaption></figure>`;
}
function hlRow(id, right, sub) {
  const x = ex(id);
  return `<button class="row hl-row" data-a="openExercise" data-id="${id}"><span class="row-ic">${icon(x.icon, 24)}</span><span class="row-main"><span class="row-t">${esc(x.name)}</span><span class="row-s">${sub}</span></span><span class="hl-v">${right}</span></button>`;
}
function deltaTxt(a, b, f = v => v) { const d = a - b; return d === 0 ? 'Same as before' : `${d > 0 ? '+' : '−'}${f(Math.abs(d))} vs previous`; }
function vProgress() {
  const [pk, plabel, days] = PERIODS.find(p => p[0] === UI.progPeriod);
  const D = progressData(days);
  const seg1 = seg('progPeriod', PERIODS.map(p => [p[0], p[1]]), pk);
  if (!S.workouts.length) return header('Progress') + `<div class="pad">${seg1}<div class="empty">Finish a few workouts and your progress, plateaus and weekly muscle volume show up here.</div></div>`;
  const per = plabel.toLowerCase();
  const card = (title, ic, body) => `<p class="grp-t hl-t">${I[ic]}${title}</p><div class="card list">${body}</div>`;
  let hl = '';
  if (D.prs.length) hl += card('New records', 'trophy', D.prs.slice(-6).reverse().map(({ w, e, s }) => hlRow(e.exId, setLabel(s), `Est. 1RM ${fmtN(e1rm(num(s.w) || 0, num(s.r)))} kg · ${fmtDate(w.start, { day: 'numeric', month: 'short' })}`)).join('')
    + (D.prs.length > 6 ? `<p class="more-note">and ${D.prs.length - 6} more</p>` : ''));
  if (D.improving.length) hl += card('Getting stronger', 'up', D.improving.slice(0, 6).map(r => hlRow(r.id, `+${fmtN(r.d)} kg`, `Est. 1RM ${fmtN(r.v)} kg · +${fmtN(r.pct * 100)}%`)).join(''));
  if (D.plateaus.length) hl += card('Plateaus', 'flat', D.plateaus.slice(0, 6).map(r => hlRow(r.id, `${r.weeks} wk`, `No new best in ${r.weeks} weeks · ${r.since} sessions since ${fmtN(r.v)} kg`)).join(''));
  if (D.dropping.length) hl += card('Going down', 'down', D.dropping.slice(0, 6).map(r => hlRow(r.id, `−${fmtN(-r.d)} kg`, `Est. 1RM ${fmtN(r.v)} kg vs previous ${per}`)).join(''));
  if (D.focus.length) hl += card('Focus points', 'target', D.focus.map(f => `<div class="row focus-row"><span class="row-main"><span class="row-t">${esc(f.t)}</span><span class="row-s">${esc(f.s)}</span></span></div>`).join(''));
  if (!hl) hl = `<div class="empty">No highlights this ${per} yet. Keep logging and changes in your lifts appear here.</div>`;
  const sorted = MUSCLES.map(([k, n]) => [k, n, D.heat[k]]).sort((a, b) => b[2] - a[2]);
  return header('Progress', { sub: `Last ${days} days` }) + `<div class="pad">${seg1}
    <div class="stats">
      <div class="stat"><div class="k">Workouts</div><div class="v">${D.cur.n}</div><div class="d">${deltaTxt(D.cur.n, D.prev.n)}</div></div>
      <div class="stat"><div class="k">Working sets</div><div class="v">${D.cur.sets}</div><div class="d">${deltaTxt(D.cur.sets, D.prev.sets)}</div></div>
      <div class="stat"><div class="k">Volume</div><div class="v">${fmtVol(D.cur.vol)}</div><div class="d">${deltaTxt(D.cur.vol, D.prev.vol, fmtVol)}</div></div>
      <div class="stat"><div class="k">PRs</div><div class="v">${D.cur.prs}</div><div class="d">${deltaTxt(D.cur.prs, D.prev.prs)}</div></div></div>
    ${hl}
    <div class="sec-hd"><h2>Weekly sets per muscle</h2></div>
    <div class="card heat-card">
      ${seg('heatMode', [['frac', 'Fractional'], ['prim', 'Primary only']], UI.heatMode)}
      <p class="muted hint">${UI.heatMode === 'frac' ? 'Main muscles count 1 set, helping muscles ½ set. A bench set counts as 1 chest, ½ triceps and ½ front delts.' : 'Only the main muscle of each exercise counts.'} Averaged per week over the last ${days} days.</p>
      <div class="figs">${figure(FIG_FRONT, D.heat, 'Front')}${figure(FIG_BACK, D.heat, 'Back')}</div>
      <div class="legend"><span>0</span><i></i><span>20+ sets/week</span></div>
      <p class="heat-info" id="heat-info">Tap a muscle to see its sets.</p>
    </div>
    <div class="card list">${sorted.map(([k, n, v]) => `<div class="mbar" data-a="muscleInfo" data-m="${k}"><span>${n}</span><span class="bar"><i style="width:${Math.min(100, v / 20 * 100)}%"></i></span><b>${fmtN(v)}</b></div>`).join('')}</div>
  </div>`;
}

/* ---------- Body ---------- */
function bodyPane() {
  const all = [...S.body].sort((a, b) => a.date - b.date);
  const latest = all[all.length - 1];
  const pts = inRange(all.map(b => ({ t: b.date, v: b.kg })), UI.bodyRange);
  const from = Date.now() - 7 * DAY, xs = all.filter(b => b.date >= from), avg7 = xs.length ? xs.reduce((a, b) => a + b.kg, 0) / xs.length : NaN;
  return `<div class="card"><div class="bw">
      <input id="bw-val" inputmode="decimal" placeholder="${latest ? fmtN(latest.kg) : 'Weight'}" aria-label="Bodyweight in kg" enterkeyhint="done">
      <input id="bw-date" type="date" value="${isoDay(Date.now())}" max="${isoDay(Date.now())}" aria-label="Date">
      <button class="pill" data-a="logBw">Log</button></div><p class="err" id="bw-err"></p></div>
    ${chartCard({ label: 'Bodyweight', pts, unit: 'kg', neutral: true, extra: seg('bodyRange', RANGES.map(r => [r[0], r[1]]), UI.bodyRange, 'sm') })}
    <div class="stats">
      <div class="stat"><div class="k">Latest</div><div class="v">${latest ? fmtN(latest.kg) + ' kg' : '–'}</div></div>
      <div class="stat"><div class="k">7-day average</div><div class="v">${isFinite(avg7) ? fmtN(avg7) + ' kg' : '–'}</div></div></div>
    ${all.length ? `<div class="sec-hd"><h2>Entries</h2></div><div class="card list">${[...all].reverse().map(b => `<button class="row" data-a="bwMenu" data-id="${b.id}"><span class="row-main"><span class="row-t">${fmtN(b.kg)} kg</span></span><span class="row-v">${fmtDate(b.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span></button>`).join('')}</div>` : ''}`;
}

/* ---------- Profile ---------- */
function vProfile() {
  return header('Profile', { right: `<button class="icon-btn" data-a="settings" aria-label="Settings">${I.gear}</button>` })
    + `<div class="pad">${seg('profSeg', [['me', 'Account'], ['body', 'Body']], UI.profSeg, 'top')}${UI.profSeg === 'body' ? bodyPane() : accountPane()}</div>`;
}
function signInButtons() {
  if (!Sync.ready) return `<p class="muted hint">Sign-in isn't switched on yet.</p>`;
  setTimeout(() => Sync.sdk().catch(() => {}), 0);   // load early so the sign-in window can open straight from the tap
  return `<button class="big-btn" data-a="signInGoogle">Continue with Google</button><button class="link block" data-a="signInEmail">Use email instead</button>`;
}
function accountPane() {
  const r = Sync.rec, who = r ? (r.name || r.email || 'Signed in') : 'Guest';
  const first = S.workouts.reduce((m, w) => Math.min(m, w.start), Infinity);
  const month = S.workouts.filter(w => w.start > Date.now() - 30 * DAY).length;
  const acct = r ? `<div class="card"><div class="acct"><span class="avatar">${esc(who.trim()[0].toUpperCase())}</span><span class="row-main"><span class="row-t">${esc(who)}</span>${r.name && r.email ? `<span class="row-s">${esc(r.email)}</span>` : ''}</span></div>
      <p class="sync-line" data-sync-label>${esc(Sync.label())}</p>
      <div class="btn-row"><button class="pill" data-a="syncNow">Sync now</button><button class="link danger" data-a="signOut">Sign out</button></div></div>`
    : `<div class="card"><div class="acct"><span class="avatar">${I.person}</span><span class="row-main"><span class="row-t">Guest</span><span class="row-s">Your data is only on this phone</span></span></div>
      <p class="muted hint">Sign in to back up your training and see it on your PC. Videos stay on this phone.</p>${signInButtons()}</div>`;
  return `${acct}
    <div class="stats three">
      <div class="stat"><div class="k">Workouts</div><div class="v">${S.workouts.length}</div></div>
      <div class="stat"><div class="k">Last 30 days</div><div class="v">${month}</div></div>
      <div class="stat"><div class="k">Since</div><div class="v">${isFinite(first) ? fmtDate(first, { month: 'short', year: 'numeric' }) : '–'}</div></div></div>
    <div class="sec-hd"><h2>Feedback</h2></div>
    <div class="card fb">${seg('fbKind', [['idea', 'Idea'], ['bug', 'Problem'], ['other', 'Other']], UI.fbKind, 'sm')}
      <textarea class="notes" id="fb-text" rows="4" maxlength="4000" placeholder="What would make Lift Log better?"></textarea>
      <button class="pill" data-a="sendFeedback">Send</button></div>
    <p class="muted hint">Goes straight to the developer${r ? ', with your account so they can follow up' : ''}.</p>`;
}
function authMsg(e) {
  const c = (e && e.code) || '';
  return ({
    'auth/popup-blocked': 'The sign-in window was blocked. Try again.',
    'auth/network-request-failed': 'No internet connection',
    'auth/invalid-credential': 'Wrong email or password', 'auth/wrong-password': 'Wrong email or password', 'auth/user-not-found': 'No account with that email — create one',
    'auth/email-already-in-use': 'That email already has an account — sign in instead',
    'auth/weak-password': 'Use at least 6 characters', 'auth/invalid-email': 'That email address doesn’t look right',
    'auth/unauthorized-domain': 'This website isn’t allowed to sign in yet',
    'auth/too-many-requests': 'Too many tries — wait a minute',
  })[c] || (e && e.message) || 'Could not sign in';
}
function welcome() {
  sheet(`<div class="sh-body welcome"><img class="wl-ic" src="icons/icon-180.png" alt="">
    <h2>Welcome to Lift Log</h2><p class="muted">Sign in to back up your training and see it on your PC — or keep everything on this phone.</p>
    ${signInButtons()}<button class="big-btn ghost" data-a="closeSheet">Continue as guest</button>
    <p class="muted hint center">You can sign in later under Profile.</p></div>`, { cls: 'full' });
}

/* ---------- Charts ---------- */
const CW = 320, CH = 150;
function chartHead(pts, unit, isVol, neutral) {
  const f = v => isVol ? fmtVol(v).replace(/ (kg|t)$/, ' <small>$1</small>') : `${fmtN(v)} <small>${unit}</small>`;
  const last = pts[pts.length - 1], first = pts[0];
  let delta = '', up = false;
  if (pts.length > 1) {
    const d = last.v - first.v; up = d > 0 && !neutral;
    delta = `${d > 0 ? '+' : d < 0 ? '−' : '±'}${isVol ? fmtVol(Math.abs(d)) : fmtN(Math.abs(d)) + ' ' + unit} since ${fmtDate(first.t, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  } else if (last) delta = fmtDate(last.t, { day: 'numeric', month: 'short', year: 'numeric' });
  return { big: last ? f(last.v) : '–', delta: delta || '&nbsp;', up };
}
function chartCard({ label, pts, unit, isVol, neutral, note = '', extra = '', id = '' }) {
  const h = chartHead(pts, unit, isVol, neutral);
  return `<div class="card chart-card" ${id ? `id="${id}"` : ''} data-unit="${unit}" data-vol="${isVol ? 1 : ''}"><p class="k">${esc(label)}</p>
    <p class="big">${h.big}</p><p class="delta ${h.up ? 'up' : ''}">${h.delta}</p>
    <div class="chart-slot">${chart(pts)}</div>${note ? `<p class="chart-note">${esc(note)}</p>` : ''}${extra}</div>`;
}
function chart(pts) {
  if (pts.length < 2) return `<div class="chart-empty">${pts.length ? 'Log one more to see the graph' : 'Nothing logged in this period'}</div>`;
  const pl = 2, pr = 34, pt = 10, pb = 22, W = CW - pl - pr, H = CH - pt - pb;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  let lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
  const padv = (hi - lo) * .15 || Math.max(1, hi * .05); lo -= padv; hi += padv;
  const X = t => pl + (t1 === t0 ? W / 2 : (t - t0) / (t1 - t0) * W), Y = v => pt + (1 - (v - lo) / (hi - lo)) * H;
  const xy = pts.map(p => [X(p.t), Y(p.v)]);
  const line = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  const grid = [0, .5, 1].map(f => { const v = hi - f * (hi - lo), y = Y(v); return `<line class="gl" x1="${pl}" x2="${pl + W}" y1="${y}" y2="${y}"/><text x="${CW - 2}" y="${y + 3.5}" text-anchor="end">${fmtN(v, v >= 100 ? 0 : 1)}</text>`; }).join('');
  const data = pts.map((p, i) => [+xy[i][0].toFixed(1), +xy[i][1].toFixed(1), p.t, +p.v.toFixed(2)]);
  return `<svg class="chart" viewBox="0 0 ${CW} ${CH}" data-pts="${esc(JSON.stringify(data))}" role="img" aria-label="Graph of ${pts.length} entries">
    ${grid}<path class="ar" d="${line}L${xy[xy.length - 1][0]} ${pt + H}L${xy[0][0]} ${pt + H}Z"/><path class="ln" d="${line}"/>
    ${pts.length <= 40 ? xy.map(p => `<circle class="dot" cx="${p[0]}" cy="${p[1]}" r="2.6"/>`).join('') : ''}
    <line class="cur" x1="0" x2="0" y1="${pt}" y2="${pt + H}"/><circle class="hl" r="4.5" cx="0" cy="0"/>
    <text x="${pl}" y="${CH - 5}">${fmtDate(t0, { day: 'numeric', month: 'short' })}</text><text x="${pl + W}" y="${CH - 5}" text-anchor="end">${fmtDate(t1, { day: 'numeric', month: 'short' })}</text></svg>`;
}
function chartScrubAt(svg, clientX) {
  const data = JSON.parse(svg.dataset.pts), r = svg.getBoundingClientRect();
  const x = (clientX - r.left) / r.width * CW;
  let best = data[0];
  for (const d of data) if (Math.abs(d[0] - x) < Math.abs(best[0] - x)) best = d;
  const card = svg.closest('.chart-card'), big = $('.big', card), dl = $('.delta', card);
  if (big.dataset.orig == null) { big.dataset.orig = big.innerHTML; dl.dataset.orig = dl.innerHTML; dl.dataset.cls = dl.className; }
  if (svg.dataset.last !== String(best[2])) { if (svg.dataset.last) haptic(); svg.dataset.last = best[2]; }
  big.innerHTML = card.dataset.vol ? fmtVol(best[3]).replace(/ (kg|t)$/, ' <small>$1</small>') : `${fmtN(best[3])} <small>${card.dataset.unit}</small>`;
  dl.className = 'delta'; dl.textContent = fmtDate(best[2], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const cur = $('.cur', svg), hl = $('.hl', svg);
  cur.setAttribute('x1', best[0]); cur.setAttribute('x2', best[0]); cur.style.opacity = .35;
  hl.setAttribute('cx', best[0]); hl.setAttribute('cy', best[1]); hl.style.opacity = 1;
}
function chartEnd(svg) {
  if (!svg || !svg.isConnected) return;
  const card = svg.closest('.chart-card'), big = $('.big', card), dl = $('.delta', card);
  if (big.dataset.orig != null) { big.innerHTML = big.dataset.orig; dl.innerHTML = dl.dataset.orig; dl.className = dl.dataset.cls; delete big.dataset.orig; }
  delete svg.dataset.last;
  $('.cur', svg).style.opacity = 0; $('.hl', svg).style.opacity = 0;
}

/* ---------- carousel & wheel ---------- */
function bindScrollers() {
  const car = $('[data-carousel]');
  if (car) {
    requestAnimationFrame(() => { car.scrollLeft = UI.exPage * car.clientWidth; });
    let t;
    car.addEventListener('scroll', () => {
      const i = Math.round(car.scrollLeft / car.clientWidth);
      if (i !== UI.exPage) { UI.exPage = i; $$('.dots span').forEach((d, j) => d.classList.toggle('on', j === i)); }
      clearTimeout(t);
    }, { passive: true });
  }
  for (const wh of $$('[data-wheel]')) {
    const step = () => wh.querySelector('.wheel-n')?.offsetWidth || 44;
    requestAnimationFrame(() => { wh.scrollLeft = (UI.repN - 1) * step(); });
    let t, shown = UI.repN;
    wh.addEventListener('scroll', () => {
      const n = Math.min(15, Math.max(1, Math.round(wh.scrollLeft / step()) + 1));
      if (n !== shown) { shown = n; haptic(); $$('.wheel-n', wh).forEach(b => b.classList.toggle('on', +b.dataset.n === n)); }
      clearTimeout(t);
      t = setTimeout(() => { if (n !== UI.repN) { UI.repN = n; refreshRepPage(); } }, 140);
    }, { passive: true });
  }
}
function refreshRepPage() {
  const id = UI.stack[UI.tab].at(-1)?.id; if (!id) return;
  const p = exPages(id).find(q => q.key === 'rep'), card = $('#pg-rep'); if (!p || !card) return;
  const pts = inRange(p.pts, UI.exRange), h = chartHead(pts, 'kg');
  $('.k', card).textContent = p.label; $('.big', card).innerHTML = h.big;
  const d = $('.delta', card); d.innerHTML = h.delta; d.className = 'delta' + (h.up ? ' up' : '');
  $('.chart-slot', card).innerHTML = chart(pts); $('.chart-note', card).textContent = p.note;
}

/* ---------- sheets ---------- */
function sheet(html, { cls = '', onClose } = {}) {
  closeSheet(true);
  const root = $('#sheet-root');
  root.innerHTML = `<div class="scrim" data-a="closeSheet"></div><div class="sheet ${cls}" role="dialog" aria-modal="true">${cls.includes('bare') ? '' : '<div class="grabber"></div>'}${html}</div>`;
  root.classList.add('open'); void root.offsetHeight; root.classList.add('in');
  UI.sheetClose = onClose || null;
}
function closeSheet(instant) {
  const root = $('#sheet-root');
  if (!root.classList.contains('open')) return;
  const cb = UI.sheetClose; UI.sheetClose = null; cb && cb();
  if (instant === true) { root.className = ''; root.innerHTML = ''; return; }
  root.classList.remove('in');
  setTimeout(() => { if (!root.classList.contains('in')) { root.className = ''; root.innerHTML = ''; } }, 320);
}
function actionSheet(items, { title = '', msg = '' } = {}) {
  return new Promise(res => {
    const done = i => { if (UI.pick === done) UI.pick = null; res(i); };
    sheet(`<div class="as">${title || msg ? `<div class="as-head">${title ? `<p class="t">${esc(title)}</p>` : ''}${msg ? `<p>${esc(msg)}</p>` : ''}</div>` : ''}
      <div class="as-group">${items.map((it, i) => `<button class="as-btn ${it.danger ? 'danger' : ''}" data-a="pick" data-i="${i}">${esc(it.label)}</button>`).join('')}</div>
      <button class="as-btn as-cancel" data-a="pick" data-i="-1">Cancel</button></div>`, { cls: 'bare', onClose: () => { if (UI.pick === done) done(-1); } });
    UI.pick = done;
  });
}
const confirmSheet = async (label, opts = {}) => (await actionSheet([{ label, danger: opts.danger !== false }], opts)) === 0;
let toastT;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (undo ? '<button class="toast-undo">Undo</button>' : '');
  t.classList.toggle('has-undo', !!undo);
  if (undo) t.querySelector('button').onclick = () => { t.classList.remove('show'); undo(); };
  t.classList.add('show'); clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), undo ? 4000 : 1800);
}

/* Exercise picker */
function openPicker(onDone, title = 'Add exercises') {
  UI.picker = { sel: [], q: '', onDone, open: new Set() };
  sheet(`<div class="sh-hd"><button class="link" data-a="closeSheet">Cancel</button><h3>${title}</h3><button class="link strong" data-a="pickerAdd" id="pk-add">Add</button></div>
    <div class="sh-body">${searchBox('pickerQ', '')}<div id="pk-list"></div>
    <button class="big-btn ghost" data-a="newExPicker">${I.plus} New exercise</button></div>`, { cls: 'full' });
  renderPicker();
}
function renderPicker() {
  const P = UI.picker, q = P.q.trim().toLowerCase();
  const mark = id => P.sel.includes(id) ? `<span class="pick on">${svgIcon(UI_ICONS.check, 16)}</span>` : `<span class="pick"></span>`;
  const live = S.exercises.filter(x => !x.archived);
  let html;
  if (q) {
    const list = live.filter(x => x.name.toLowerCase().includes(q));
    html = list.length ? `<div class="card list">${list.map(x => exRow(x, { a: 'pickerToggle', trail: mark(x.id), meta: isMain(x) ? '' : 'Variation of ' + esc(mainOf(x).name) })).join('')}</div>` : `<div class="empty">No exercise called “${esc(P.q)}”.</div>`;
  } else html = S.sections.map(s => {
    const rows = live.filter(x => x.sec === s.id && isMain(x)).sort((a, b) => s.id === 's-sbd' ? 0 : a.name.localeCompare(b.name)).map(x => {
      const open = P.open.has(x.id);
      return exRow(x, { a: 'pickerToggle', trail: mark(x.id), fam: famToggle(x, 'pickerFam', open) })
        + (open ? kidsOf(x.id).sort((a, b) => a.name.localeCompare(b.name)).map(k => exRow(k, { a: 'pickerToggle', trail: mark(k.id), sub: true })).join('') : '');
    }).join('');
    return rows ? `<p class="grp-t">${esc(s.name)}</p><div class="card list">${rows}</div>` : '';
  }).join('');
  $('#pk-list').innerHTML = html;
  $('#pk-add').textContent = P.sel.length ? `Add (${P.sel.length})` : 'Add';
}

/* Exercise editor */
function openExEdit(id, preset = {}) {
  const x = id ? ex(id) : { name: UI.picker?.q || '', sec: preset.sec || S.sections[0].id, icon: 'barbell', m: { p: [], s: [] }, parent: preset.parent || '', note: '' };
  if (!id && preset.parent) { const p = ex(preset.parent); x.sec = p.sec; x.icon = p.icon; x.m = cloneM(p.m); }
  UI.edit = { id, name: x.name, sec: x.sec, icon: x.icon, m: cloneM(x.m), parent: x.parent || '', kind: x.kind || '', note: x.note || '', touchedM: !!id };
  const mains = S.exercises.filter(y => !y.archived && isMain(y) && y.id !== id && !isCardio(y)).sort((a, b) => a.name.localeCompare(b.name));
  const hasKids = id && kidsOf(id).length;
  sheet(`<div class="sh-hd"><button class="link" data-a="closeSheet">Cancel</button><h3>${id ? 'Edit exercise' : 'New exercise'}</h3><button class="link strong" data-a="saveEx">Save</button></div>
    <div class="sh-body"><div class="field"><input data-bind="edit.name" value="${esc(x.name)}" placeholder="Name, e.g. Hammer Strength Pullover" aria-label="Exercise name"></div><p class="err" id="ex-err"></p>
    <p class="label">Section</p><div class="chips" id="sec-chips">${S.sections.map(s => `<button class="chip ${s.id === x.sec ? 'on' : ''}" data-a="editSec" data-id="${s.id}">${esc(s.name)}</button>`).join('')}</div>
    <p class="label">Variation of</p>
    ${hasKids ? `<p class="muted hint">This is a main lift with ${kidsOf(id).length} variations, so it can't be a variation itself.</p>` : `<select class="select" data-bind="edit.parent" aria-label="Variation of"><option value="">None, it's its own lift</option>${mains.map(m => `<option value="${m.id}" ${m.id === x.parent ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`}
    <p class="label">Logged as</p>${seg('editKind', [['', 'Weight & reps'], ['cardio', 'Time & distance']], x.kind || '')}
    <p class="label">Muscles</p><p class="muted hint">Tap once for main muscle (1 set), twice for helping muscle (½ set).</p>
    <div class="chips" id="m-chips">${muscleChips(UI.edit.m)}</div>
    <p class="label">Note</p><textarea class="notes small" data-bind="edit.note" placeholder="Seat height, grip, cues…">${esc(x.note || '')}</textarea>
    <p class="label">Icon</p><div class="icon-grid">${Object.keys(EX_ICONS).map(k => `<button class="icon-cell ${k === x.icon ? 'on' : ''}" data-a="editIcon" data-k="${k}" aria-label="${k} icon">${icon(k, 30)}</button>`).join('')}</div>
    ${id ? `<div class="sec-hd"></div><button class="big-btn ghost" data-a="newVariation" data-id="${isMain(x) ? id : x.parent}">${I.plus} New variation of ${esc(mainOf(x).name)}</button><button class="big-btn ghost danger" data-a="deleteEx" data-id="${id}">Delete exercise</button>` : ''}</div>`, { cls: 'full' });
  if (!id) setTimeout(() => $('[data-bind="edit.name"]')?.focus(), 350);
}
function muscleChips(m) {
  return MUSCLES.map(([k, n]) => { const st = m.p.includes(k) ? 'p' : m.s.includes(k) ? 's' : ''; return `<button class="chip mchip ${st}" data-a="editMuscle" data-k="${k}">${n}${st === 'p' ? ' · 1' : st === 's' ? ' · ½' : ''}</button>`; }).join('');
}

/* Sections editor */
function openSections() {
  sheet(`<div class="sh-hd"><span></span><h3>Sections</h3><button class="link strong" data-a="closeSections">Done</button></div>
    <div class="sh-body"><p class="muted hint">Drag to reorder. Tap a name to rename it.</p><div id="sec-list"></div>
    <button class="big-btn ghost" data-a="addSection">${I.plus} New section</button></div>`, { cls: 'full', onClose: () => { save(); render(); } });
  renderSections();
}
function renderSections() {
  const counts = {}; for (const x of S.exercises) if (!x.archived) counts[x.sec] = (counts[x.sec] || 0) + 1;
  $('#sec-list').innerHTML = `<div class="card list" data-reorder="sections">${S.sections.map((s, i) => `<div class="row" data-ri="${i}">
    <span class="drag" data-drag aria-label="Drag to reorder">${I.grip}</span>
    <input class="sec-name" data-bind="secname:${s.id}" value="${esc(s.name)}" aria-label="Section name" enterkeyhint="done">
    <span class="row-v">${counts[s.id] || 0}</span>
    <button class="icon-btn sm del" data-a="delSection" data-id="${s.id}" aria-label="Delete ${esc(s.name)}">${I.minus}</button></div>`).join('')}</div>`;
}

/* Settings */
async function openSettings() {
  let storage = '';
  try {
    const [est, persisted] = await Promise.all([navigator.storage?.estimate?.(), navigator.storage?.persisted?.()]);
    if (est) storage = `${fmtN(est.usage / 1048576, 1)} MB used`;
    storage += persisted ? ' · protected from automatic clean-up' : '';
  } catch {}
  const st = S.settings;
  sheet(`<div class="sh-hd"><span></span><h3>Settings</h3><button class="link strong" data-a="closeSheet">Done</button></div>
    <div class="sh-body">
    <p class="label">Appearance</p>
    <div class="card list">${THEMES.map(([k, n, sub]) => `<button class="row theme-row" data-a="setTheme" data-k="${k}"><span class="swatch sw-${k}"></span><span class="row-main"><span class="row-t">${n}</span>${sub ? `<span class="row-s">${sub}</span>` : ''}</span><span class="tick ${st.theme === k ? 'on' : ''}">${I.check}</span></button>`).join('')}</div>
    <p class="label">Workouts</p>
    <div class="card list">
      <div class="row"><span class="row-main"><span class="row-t">Default sets</span><span class="row-s">For new exercises in a workout or program</span></span>
        <span class="stepper"><button data-a="stepPref" data-k="defSets" data-d="-1" aria-label="Fewer">${I.minus}</button><b id="pref-defSets">${st.defSets}</b><button data-a="stepPref" data-k="defSets" data-d="1" aria-label="More">${I.plus}</button></span></div>
      <div class="row"><span class="row-main"><span class="row-t">Default reps</span><span class="row-s">Used when there's no earlier session</span></span><input class="mini" inputmode="numeric" data-bind="pref:defReps" value="${esc(st.defReps)}" placeholder="–" aria-label="Default reps"></div>
      <div class="row"><span class="row-main"><span class="row-t">Bar weight</span><span class="row-s">For the plate calculator</span></span><input class="mini" inputmode="decimal" data-bind="pref:bar" value="${esc(st.bar)}" aria-label="Bar weight in kg"> <span class="muted">kg</span></div>
      <div class="row"><span class="row-main"><span class="row-t">Fill in last weights</span><span class="row-s">Suggests what you lifted last time</span></span>${sw(st.autofill, 'togglePref', 'autofill')}</div>
      <div class="row"><span class="row-main"><span class="row-t">Keep screen on</span><span class="row-s">While a workout is running</span></span>${sw(st.wake, 'togglePref', 'wake')}</div>
    </div>
    <p class="label">Effort per set</p>${seg('setEffort', [['RPE', 'RPE'], ['RIR', 'RIR'], ['off', 'Off']], st.effort)}
    <p class="muted hint">Default for new exercises. Switch any exercise during a workout from its ⋯ menu.</p>
    <p class="label">Library</p>
    <div class="card list"><button class="row" data-a="editSections"><span class="row-main"><span class="row-t">Edit sections</span><span class="row-s">${S.sections.length} sections</span></span>${I.chevR}</button></div>
    <p class="label">Your data</p>
    <div class="card list">
      <button class="row" data-a="exportData"><span class="row-main"><span class="row-t">Export backup</span><span class="row-s">Saves workouts, programs and bodyweight as a file</span></span>${I.chevR}</button>
      <button class="row" data-a="importData"><span class="row-main"><span class="row-t">Import backup</span><span class="row-s">Replaces what's on this phone</span></span>${I.chevR}</button></div>
    <p class="muted hint">${storage ? esc(storage) + '. ' : ''}${Sync.on ? 'Synced to your account, except videos.' : 'Everything is stored only on this phone.'} Videos aren't included in the backup file.</p>
    <div class="sec-hd"></div>
    <button class="big-btn ghost danger" data-a="eraseAll">Erase all data</button>
    <p class="muted hint center">Lift Log ${APP_VERSION}</p></div>`, { cls: 'full' });
}
async function exportData() {
  const name = `liftlog-backup-${isoDay(Date.now())}.json`;
  const file = new File([JSON.stringify({ app: 'liftlog', exported: Date.now(), state: S })], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Lift Log backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function whatsNew() {
  sheet(`<div class="sh-hd"><span></span><h3>What's new</h3><button class="link strong" data-a="closeSheet">Done</button></div>
    <div class="sh-body"><h2 style="margin:4px 4px 12px">Lift Log ${APP_VERSION}</h2><div class="card list news">
    ${[['person', 'Profile and sync', 'Sign in with Google to back up your training and see it on your PC. Or stay a guest — everything still works offline.'],
      ['note', 'Send feedback', 'Ideas and problems go straight to the developer from Profile.'],
      ['scale', 'Body moved', 'Bodyweight now lives in Profile, next to your account. Settings are there too.']]
      .map(([ic, t, s]) => `<div class="row"><span class="row-ic">${I[ic]}</span><span class="row-main"><span class="row-t">${t}</span><span class="row-s">${s}</span></span></div>`).join('')}</div>
    ${Sync.on ? '' : `<div style="height:16px"></div>${signInButtons()}`}</div>`, { cls: 'full' });
}

/* ---------- actions ---------- */
const A = {
  tab(el) {
    const t = el.dataset.tab;
    if (t === UI.tab) { if (UI.stack[t].length) { if (UI.editW) finishEditing(UI.editW); UI.stack[t] = []; render('pop'); } else $('#view').scrollTo({ top: 0, behavior: 'smooth' }); return; }
    UI.tab = t; render();
  },
  back, closeSheet: () => closeSheet(),
  pick(el) { const p = UI.pick; UI.pick = null; closeSheet(); p && p(+el.dataset.i); },
  goWorkout, settings: openSettings,

  profSeg(el) { UI.profSeg = el.dataset.v; render(); },
  fbKind(el) { UI.fbKind = el.dataset.v; for (const b of el.parentElement.children) { const on = b === el; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); } },
  async sendFeedback(el) {
    const t = $('#fb-text'), text = t.value.trim();
    if (text.length < 3) { t.focus(); return; }
    if (!Sync.ready) { toast('Feedback isn’t switched on yet'); return; }
    el.disabled = true;
    try { await Sync.feedback(text, UI.fbKind); t.value = ''; toast('Thanks — feedback sent'); }
    catch { toast('Couldn’t send — check your connection'); }
    el.disabled = false;
  },
  async signInGoogle(el) {
    if (!Sync.fb) { try { await Sync.sdk(); toast('Ready — tap again'); } catch { toast('No internet connection'); } return; }
    el.disabled = true;
    try { await Sync.signInGoogle(); closeSheet(); toast('Signed in'); render(); }
    catch (e) { if (!/popup-closed|cancelled-popup/.test(e.code || '')) toast(authMsg(e)); }
    el.disabled = false;
  },
  signInEmail() {
    sheet(`<div class="sh-hd"><button class="link" data-a="closeSheet">Cancel</button><h3>Email</h3><span></span></div>
      <div class="sh-body"><div class="field"><input id="em-mail" type="email" autocomplete="username" placeholder="Email" aria-label="Email"></div>
      <div class="field" style="margin-top:8px"><input id="em-pass" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password"></div>
      <p class="err" id="em-err"></p><div style="height:12px"></div>
      <button class="big-btn" data-a="emailGo">Sign in</button><div style="height:8px"></div>
      <button class="big-btn ghost" data-a="emailGo" data-k="new">Create account</button></div>`);
  },
  async emailGo(el) {
    const m = $('#em-mail').value.trim(), pw = $('#em-pass').value, err = $('#em-err');
    if (!m || !pw) { err.textContent = 'Enter your email and a password'; return; }
    el.disabled = true; err.textContent = '';
    try { await Sync.signInEmail(m, pw, el.dataset.k === 'new'); closeSheet(); toast('Signed in'); render(); }
    catch (e) { err.textContent = authMsg(e); }
    el.disabled = false;
  },
  async signOut() {
    if (!await confirmSheet('Sign out', { title: 'Sign out?', msg: 'Your data stays on this phone and in your account. Changes made while signed out aren’t synced.' })) return;
    await Sync.signOut(); render(); toast('Signed out');
  },
  syncNow() { Sync.run(true); },

  startEmpty: () => startWorkout(''),
  startProgram(el) { const p = S.programs.find(x => x.id === el.dataset.id); if (p) startWorkout('', p.id, p.items); },
  openProgram(el) { push({ v: 'program', id: el.dataset.id }); },
  newProgram() {
    const p = { id: uid(), name: 'New program', items: [] };
    S.programs.push(p); save(); push({ v: 'program', id: p.id });
    setTimeout(() => { const i = $('.title-input'); i && (i.focus(), i.select()); }, 60);
  },
  addExToProgram(el) {
    const p = S.programs.find(x => x.id === el.dataset.id);
    openPicker(ids => { for (const id of ids) p.items.push({ id: uid(), exId: id, sets: S.settings.defSets, reps: S.settings.defReps || '' }); save(); render(); });
  },
  async progItemMenu(el) {
    const p = S.programs.find(x => x.id === el.dataset.id), i = +el.dataset.i;
    const c = await actionSheet([{ label: 'Remove', danger: true }], { title: ex(p.items[i].exId).name });
    if (c !== 0) return;
    p.items.splice(i, 1); save(); render();
  },
  dupProgram(el) {
    const p = S.programs.find(x => x.id === el.dataset.id);
    const c = { id: uid(), name: p.name + ' copy', items: p.items.map(i => ({ ...i, id: uid() })) };
    S.programs.splice(S.programs.indexOf(p) + 1, 0, c); save();
    UI.stack.train.pop(); UI.stack.train.push({ v: 'program', id: c.id }); render('push'); toast('Program duplicated');
  },
  async deleteProgram(el) {
    const p = S.programs.find(x => x.id === el.dataset.id);
    if (!await confirmSheet('Delete program', { title: `Delete “${p.name}”?`, msg: 'Workouts you already logged with it are kept.' })) return;
    S.programs = S.programs.filter(x => x !== p); save(); back();
  },

  fold(el) { const e = getW(el.dataset.w).exercises[+el.dataset.ei]; e.fold = !e.fold; save(); render(); },
  foldAll() { const w = S.active, any = w.exercises.some(e => !e.fold); for (const e of w.exercises) e.fold = any; save(); render(); },
  addExToWorkout(el) {
    const k = el.dataset.w, w = getW(k);
    openPicker(ids => {
      for (const id of ids) { const e = makeEntry(id); if (k !== 'a') for (const s of e.sets) { s.pw = ''; s.pr = ''; } w.exercises.push(e); }
      save(); render(); setTimeout(() => $('#view').scrollTo({ top: 1e6, behavior: 'smooth' }), 50);
    });
  },
  async exMenu(el) {
    const k = el.dataset.w, ei = +el.dataset.ei, w = getW(k), e = w.exercises[ei], x = ex(e.exId);
    const fam = !isMain(x) || kidsOf(x.id).length > 0;
    const items = [];
    if (fam) items.push({ label: 'Switch variation', run: () => A.switchVar(el) });
    items.push({ label: x.note ? 'Edit note' : 'Add note', run: () => openNote(x.id) });
    items.push({ label: 'View history and graphs', run: () => push({ v: 'exercise', id: x.id }) });
    if (!isCardio(x)) for (const t of ['RPE', 'RIR', 'off'].filter(t => t !== e.et)) items.push({ label: t === 'off' ? 'Hide effort column' : `Use ${t}`, run: () => { e.et = t; save(); render(); } });
    items.push({ label: 'Remove exercise', danger: true, run: () => { w.exercises.splice(ei, 1); if (k === 'a') { recomputeRests(w); markActivePRs(); } save(); render(); } });
    const c = await actionSheet(items, { title: x.name });
    if (c >= 0) items[c].run();
  },
  switchVar(el) {
    const k = el.dataset.w, ei = +el.dataset.ei, e = getW(k).exercises[ei], x = ex(e.exId), main = mainOf(x);
    const fam = [main, ...kidsOf(main.id).sort((a, b) => a.name.localeCompare(b.name))];
    UI.varTarget = { k, ei };
    sheet(`<div class="sh-hd"><span></span><h3>${esc(main.name)}</h3><button class="link strong" data-a="closeSheet">Done</button></div>
      <div class="sh-body"><div class="card list">${fam.map(f => exRow(f, { a: 'pickVar', trail: f.id === x.id ? `<span class="tick on">${I.check}</span>` : '', meta: f.id === main.id ? 'Main lift' : '' })).join('')}</div>
      <button class="big-btn ghost" data-a="newVariation" data-id="${main.id}">${I.plus} New variation</button></div>`);
  },
  pickVar(el) {
    const { k, ei } = UI.varTarget, e = getW(k).exercises[ei], id = el.dataset.id;
    if (id !== e.exId) {
      e.exId = id;
      if (k === 'a') { const ph = placeholders(id, e.sets.length, ''); e.sets.forEach((s, i) => { if (!s.done) { s.pw = ph[i][0]; s.pr = ph[i][1]; } }); markActivePRs(); }
      save();
    }
    closeSheet(); render();
  },
  newVariation(el) { UI.picker = null; const k = UI.varTarget; UI.afterVar = k ? { ...k } : null; openExEdit(null, { parent: el.dataset.id }); },
  addSet(el) {
    const k = el.dataset.w, e = getW(k).exercises[+el.dataset.ei], prev = e.sets[e.sets.length - 1];
    if (k === 'a') e.sets.push(prev ? newSet(prev.w || prev.pw, prev.r || prev.pr) : newSet('', S.settings.defReps));
    else e.sets.push({ ...newSet(), w: prev ? prev.w : '', r: prev ? prev.r : '', done: !!(prev && num(prev.r) > 0), pw: '', pr: '' });
    save(); render();
  },
  async setMenu(el) {
    const k = el.dataset.w, w = getW(k), e = w.exercises[+el.dataset.ei], si = +el.dataset.si, s = e.sets[si];
    const wt = num(s.w) || num(s.pw), cardio = isCardio(ex(e.exId));
    const items = [{ label: s.warm ? 'Mark as working set' : 'Mark as warm-up', run: () => { s.warm = !s.warm; } }];
    if (!cardio && wt > S.settings.bar) items.push({ label: `Plates for ${fmtN(wt)} kg`, run: () => showPlates(wt) });
    items.push({ label: 'Delete set', danger: true, run: () => deleteSet(k, +el.dataset.ei, si) });
    const c = await actionSheet(items);
    if (c < 0) return;
    const r = items[c].run();
    if (r === undefined && items[c].label.startsWith('Mark')) { if (k === 'a') markActivePRs(); else recomputeAllPRs(); save(); render(); }
  },
  toggleSet(el) {
    const w = S.active, e = w.exercises[+el.dataset.ei], s = e.sets[+el.dataset.si];
    if (!s.done) {
      if (s.w === '' && s.pw !== '') s.w = s.pw;
      if (s.r === '' && /^\d+([.,]\d+)?$/.test(s.pr)) s.r = s.pr;
      if (!(num(s.r) > 0)) { toast(isCardio(ex(e.exId)) ? 'Enter minutes first' : 'Enter reps first'); $(`[data-bind="set:a:${el.dataset.ei}:${el.dataset.si}:r"]`)?.focus(); return; }
      s.done = true; s.doneAt = Date.now(); haptic();
    } else { s.done = false; s.doneAt = null; }
    recomputeRests(w); markActivePRs(); save(); render();
  },
  async discardWorkout() {
    const nv = VIDS.filter(v => v.workoutId === S.active.id).length;
    if (!await confirmSheet('Discard workout', { title: 'Discard this workout?', msg: 'Nothing from it will be saved' + (nv ? `, including ${nv} video${nv > 1 ? 's' : ''}.` : '.') })) return;
    await deleteVideos(v => v.workoutId === S.active.id);
    S.active = null; save(true); render();
  },
  finishWorkout() {
    const w = S.active;
    const pending = w.exercises.reduce((n, e) => n + e.sets.filter(s => !s.done && num(s.r) > 0).length, 0);
    const empty = w.exercises.reduce((n, e) => n + e.sets.filter(s => !s.done && !(num(s.r) > 0)).length, 0);
    const msg = [pending ? `${pending} unticked set${pending > 1 ? 's' : ''} with reps will be saved as done.` : '', empty ? `${empty} empty set${empty > 1 ? 's' : ''} will be removed.` : ''].filter(Boolean).join(' ');
    sheet(`<div class="sh-hd"><button class="link" data-a="closeSheet">Cancel</button><h3>Finish workout</h3><button class="link strong" data-a="confirmFinish">Save</button></div>
      <div class="sh-body"><p class="label">Name</p><div class="field"><input id="finish-name" value="${esc(suggestName(w))}" aria-label="Workout name" enterkeyhint="done"></div>
      <p class="muted hint">${fmtDur(Date.now() - w.start)} · ${w.exercises.length} exercise${w.exercises.length === 1 ? '' : 's'}${msg ? '. ' + esc(msg) : ''}</p>
      <button class="big-btn" data-a="confirmFinish">Save workout</button></div>`);
    setTimeout(() => { const i = $('#finish-name'); if (i) { i.focus(); i.select(); } }, 400);
  },
  async confirmFinish() {
    const w = S.active, name = ($('#finish-name')?.value || '').trim();
    closeSheet(true);
    for (const e of w.exercises) {
      for (const s of e.sets) if (!s.done && num(s.r) > 0) { s.done = true; if (s.w === '') s.w = s.pw; }
      e.sets = e.sets.filter(s => s.done && num(s.r) > 0);
      for (const s of e.sets) { delete s.pw; delete s.pr; }
      e.fold = false;
    }
    w.exercises = w.exercises.filter(e => e.sets.length);
    if (!w.exercises.length) {
      if (await confirmSheet('Discard workout', { title: 'No sets logged', msg: 'There is nothing to save. Discard the workout?' })) { await deleteVideos(v => v.workoutId === w.id); S.active = null; save(true); }
      render(); return;
    }
    w.name = name || suggestName({ ...w, name: '' });
    w.end = Date.now(); recomputeRests(w);
    delete w.lastDoneAt; delete w.lastLabel;
    S.workouts.push(w); S.active = null; recomputeAllPRs(); save(true); render(); haptic();
    const prs = w.exercises.flatMap(e => e.sets.filter(s => s.isPR).map(s => `${ex(e.exId).name}: ${setLabel(s)}`));
    sheet(`<div class="sh-body" style="padding-top:18px"><div class="done-hero"><div class="ok">${I.check}</div><h2>${esc(w.name)}</h2><p class="muted">Saved · ${fmtDur(w.end - w.start)}</p></div>
      <div class="stats"><div class="stat"><div class="k">Volume</div><div class="v">${fmtVol(wVolume(w))}</div></div><div class="stat"><div class="k">Working sets</div><div class="v">${wSets(w)}</div></div></div>
      ${prs.length ? `<p class="label">New personal records</p><div class="card">${prs.map(p => `<div>${esc(p)}</div>`).join('')}</div>` : ''}
      <button class="big-btn" data-a="closeSheet">Done</button></div>`);
  },

  openWorkout(el) { push({ v: 'workout', id: el.dataset.id }); },
  editW(el) { UI.editW = el.dataset.id; render(); },
  doneEditW(el) { finishEditing(el.dataset.id); render(); toast('Workout updated'); },
  histSort(el) { UI.histSort = el.dataset.v; render(); },
  histProg(el) { UI.histProg = el.dataset.v; render(); },
  repeatWorkout(el) { const w = S.workouts.find(x => x.id === el.dataset.id); startWorkout(w.programId ? '' : w.name, w.programId, w.exercises.map(e => ({ exId: e.exId, sets: e.sets.filter(s => !s.warm).length || e.sets.length }))); },
  saveAsProgram(el) {
    const w = S.workouts.find(x => x.id === el.dataset.id);
    S.programs.push({ id: uid(), name: w.name, items: w.exercises.map(e => ({ id: uid(), exId: e.exId, sets: e.sets.filter(s => !s.warm).length || e.sets.length, reps: '' })) });
    save(); toast('Saved as program');
  },
  async deleteWorkout(el) {
    const w = S.workouts.find(x => x.id === el.dataset.id);
    const nv = VIDS.filter(v => v.workoutId === w.id).length;
    if (!await confirmSheet('Delete workout', { title: 'Delete this workout?', msg: `This can't be undone.${nv ? ` Its ${nv} video${nv > 1 ? 's' : ''} stay in the exercise library.` : ''}` })) return;
    S.workouts = S.workouts.filter(x => x !== w);
    for (const v of VIDS) if (v.workoutId === w.id) { v.workoutId = null; DB.putVideo(v); }
    recomputeAllPRs(); save(); back();
  },

  openExercise(el) { push({ v: 'exercise', id: el.dataset.id }); },
  exFamily(el) { UI.exFamily = el.dataset.v === '1'; render(); },
  exRange(el) { UI.exRange = el.dataset.v; render(); },
  e1rmLow() { UI.e1rmLow = !UI.e1rmLow; render(); },
  wheelPick(el) { const wh = el.closest('[data-wheel]'); wh.scrollTo({ left: (+el.dataset.n - 1) * el.offsetWidth, behavior: 'smooth' }); },
  libSort(el) { UI.libSort = el.dataset.v; render(); },
  libFam(el) { const id = el.dataset.id; UI.libOpen.has(id) ? UI.libOpen.delete(id) : UI.libOpen.add(id); $('#lib-list').innerHTML = libList(); },
  newExLib() { UI.picker = null; UI.varTarget = null; openExEdit(); },
  newExPicker() { UI.varTarget = null; openExEdit(); },
  editEx(el) { UI.picker = null; UI.varTarget = null; openExEdit(el.dataset.id); },
  editSec(el) { UI.edit.sec = el.dataset.id; $$('#sec-chips .chip').forEach(c => c.classList.toggle('on', c === el)); },
  editIcon(el) {
    UI.edit.icon = el.dataset.k; $$('.icon-cell').forEach(c => c.classList.toggle('on', c === el));
    if (!UI.edit.touchedM) { UI.edit.m = cloneM(MP[ICON_PRESET[el.dataset.k]] || MP.none); $('#m-chips').innerHTML = muscleChips(UI.edit.m); }
    if (!UI.edit.id && CARDIO_ICONS.has(el.dataset.k) && !UI.edit.kind) { UI.edit.kind = 'cardio'; $$('.sheet .seg button').forEach(b => b.classList.toggle('on', b.dataset.v === 'cardio')); }
  },
  editKind(el) { UI.edit.kind = el.dataset.v; $$('.sheet .seg button').forEach(b => b.classList.toggle('on', b === el)); },
  editMuscle(el) {
    const m = UI.edit.m, k = el.dataset.k; UI.edit.touchedM = true;
    if (m.p.includes(k)) { m.p = m.p.filter(x => x !== k); m.s.push(k); }
    else if (m.s.includes(k)) m.s = m.s.filter(x => x !== k);
    else m.p.push(k);
    $('#m-chips').innerHTML = muscleChips(m);
  },
  saveEx() {
    const E = UI.edit, name = E.name.trim();
    if (!name) { $('#ex-err').textContent = 'Give the exercise a name'; return; }
    if (S.exercises.some(x => !x.archived && x.id !== E.id && x.name.toLowerCase() === name.toLowerCase())) { $('#ex-err').textContent = 'You already have an exercise with that name'; return; }
    const parent = E.parent && E.parent !== E.id ? E.parent : '';
    const sec = parent ? ex(parent).sec : E.sec;
    let id = E.id;
    const fields = { name, sec, icon: E.icon, m: cloneM(E.m), note: E.note.trim() };
    if (E.kind) fields.kind = E.kind;
    if (id) { const x = ex(id); Object.assign(x, fields); if (!E.kind) delete x.kind; if (parent) x.parent = parent; else delete x.parent; }
    else { id = uid(); S.exercises.push({ id, ...fields, ...(parent ? { parent } : {}) }); }
    save();
    const P = UI.picker, V = UI.afterVar; UI.picker = null; UI.afterVar = null;
    closeSheet();
    if (P && !E.id) P.onDone([id]);
    else if (V && !E.id) { UI.varTarget = V; A.pickVar({ dataset: { id } }); }
    else render();
    toast(E.id ? 'Exercise updated' : 'Exercise created');
  },
  async deleteEx(el) {
    const x = ex(el.dataset.id);
    if (!await confirmSheet('Delete exercise', { title: `Delete “${x.name}”?`, msg: 'It disappears from the library. Logged sets and videos stay in your history.' })) return;
    x.archived = true; save();
    if (UI.stack[UI.tab].at(-1)?.id === x.id) back(); else render();
  },
  pickerToggle(el) { const P = UI.picker, id = el.dataset.id, i = P.sel.indexOf(id); i < 0 ? P.sel.push(id) : P.sel.splice(i, 1); renderPicker(); },
  pickerFam(el) { const P = UI.picker, id = el.dataset.id; P.open.has(id) ? P.open.delete(id) : P.open.add(id); renderPicker(); },
  pickerAdd() { const P = UI.picker; if (!P.sel.length) { toast('Pick at least one exercise'); return; } UI.picker = null; closeSheet(); P.onDone(P.sel); },

  editSections: openSections,
  closeSections() { closeSheet(); },
  addSection() { S.sections.push({ id: 's-' + uid(), name: 'New section' }); renderSections(); const inp = $$('.sec-name').at(-1); inp.focus(); inp.select(); },
  async delSection(el) {
    const s = S.sections.find(x => x.id === el.dataset.id);
    if (S.sections.length < 2) { toast('Keep at least one section'); return; }
    const inside = S.exercises.filter(x => x.sec === s.id && !x.archived);
    const others = S.sections.filter(x => x !== s);
    UI.sheetClose = null;
    if (inside.length) {
      const c = await actionSheet(others.map(o => ({ label: o.name })), { title: `Delete “${s.name}”`, msg: `Move its ${inside.length} exercise${inside.length > 1 ? 's' : ''} to:` });
      if (c >= 0) { for (const x of S.exercises) if (x.sec === s.id) x.sec = others[c].id; S.sections = others; save(); }
    } else { S.sections = others; save(); }
    openSections();
  },

  async addVideo(el) {
    const exId = el.dataset.ex;
    let workoutId = el.dataset.w || null;
    if (!workoutId && S.active && S.active.exercises.some(e => e.exId === exId)) workoutId = S.active.id;
    const w = workoutId && (S.active?.id === workoutId ? S.active : S.workouts.find(x => x.id === workoutId));
    UI.vidTarget = { exId, workoutId, date: w && w !== S.active ? w.start : Date.now() };
    const inp = $('#vid-in'); inp.value = ''; inp.click();
  },
  playVideo(el) {
    const v = VIDS.find(x => x.id === el.dataset.id); if (!v) return;
    const url = URL.createObjectURL(v.blob);
    const w = v.workoutId && S.workouts.find(x => x.id === v.workoutId);
    sheet(`<div class="sh-hd"><span></span><h3>${esc(ex(v.exId).name)}</h3><button class="link strong" data-a="closeSheet">Done</button></div>
      <div class="sh-body player"><video controls playsinline autoplay src="${url}"></video>
      <p class="muted" style="margin:10px 4px">${fmtDate(v.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${w ? ' · ' + esc(w.name) : ''}</p>
      <button class="big-btn ghost danger" data-a="deleteVideo" data-id="${v.id}">Delete video</button></div>`, { onClose: () => URL.revokeObjectURL(url) });
  },
  async deleteVideo(el) {
    const id = el.dataset.id;
    if (!await confirmSheet('Delete video', { title: 'Delete this video?', msg: "It's removed from this phone. This can't be undone." })) return;
    await deleteVideos(v => v.id === id); render();
  },

  progPeriod(el) { UI.progPeriod = el.dataset.v; render(); },
  heatMode(el) { UI.heatMode = el.dataset.v; render(); },
  muscleInfo(el) {
    const k = el.dataset.m, days = PERIODS.find(p => p[0] === UI.progPeriod)[2];
    const v = progressData(days).heat[k];
    const users = new Set();
    for (const w of S.workouts.filter(w => w.start >= Date.now() - days * DAY)) for (const e of w.exercises) { const x = ex(e.exId); if (x.m.p.includes(k) || (UI.heatMode === 'frac' && x.m.s.includes(k))) users.add(x.name); }
    const info = $('#heat-info');
    if (info) info.innerHTML = `<b>${MNAME[k]}</b>: ${fmtN(v)} sets a week${users.size ? ` · from ${esc([...users].slice(0, 4).join(', '))}${users.size > 4 ? '…' : ''}` : ''}`;
    $$('.mz').forEach(z => z.classList.toggle('sel', z.dataset.m === k));
  },

  bodyRange(el) { UI.bodyRange = el.dataset.v; render(); },
  logBw() {
    const v = num($('#bw-val').value), d = $('#bw-date').value;
    if (!(v >= 20 && v <= 400)) { $('#bw-err').textContent = 'Enter a weight between 20 and 400 kg'; return; }
    const [y, m, dd] = (d || isoDay(Date.now())).split('-').map(Number);
    const date = new Date(y, m - 1, dd, 12).getTime();
    const same = S.body.find(b => isoDay(b.date) === isoDay(date));
    if (same) same.kg = v; else S.body.push({ id: uid(), date, kg: v });
    save(); render(); toast(same ? 'Updated that day' : 'Bodyweight logged');
  },
  async bwMenu(el) {
    const b = S.body.find(x => x.id === el.dataset.id);
    if (!await confirmSheet('Delete entry', { title: `${fmtN(b.kg)} kg`, msg: fmtDate(b.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) })) return;
    S.body = S.body.filter(x => x !== b); save(); render();
  },

  setTheme(el) { S.settings.theme = el.dataset.k; applyTheme(); save(); $$('.theme-row .tick').forEach(t => t.classList.toggle('on', t.closest('.theme-row') === el)); },
  togglePref(el) { const k = el.dataset.k; S.settings[k] = !S.settings[k]; el.classList.toggle('on', S.settings[k]); el.setAttribute('aria-checked', S.settings[k]); save(); haptic(); syncWake(); },
  stepPref(el) { const k = el.dataset.k; S.settings[k] = Math.min(10, Math.max(1, (+S.settings[k] || 3) + +el.dataset.d)); $('#pref-' + k).textContent = S.settings[k]; save(); },
  setEffort(el) { S.settings.effort = el.dataset.v; save(); el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el)); },
  exportData,
  importData() { const i = $('#import-in'); i.value = ''; i.click(); },
  async eraseAll() {
    if (!await confirmSheet('Erase everything', { title: 'Erase all data?', msg: 'Every workout, program, bodyweight entry and video on this phone is deleted, and you’re signed out (your account keeps its copy). Export a backup first if you might want it back.' })) return;
    const theme = S.settings.theme;
    await Sync.signOut();
    S = freshState(); S.settings.theme = theme; await DB.clearVideos(); VIDS = []; save(true);
    UI.stack = { train: [], history: [], progress: [], library: [], profile: [] }; UI.tab = 'train'; render(); toast('All data erased');
  },
};

function openNote(id) {
  const x = ex(id);
  sheet(`<div class="sh-hd"><button class="link" data-a="closeSheet">Cancel</button><h3>Note</h3><button class="link strong" data-a="saveNote" data-id="${id}">Save</button></div>
    <div class="sh-body"><p class="muted hint">Shown every time you log ${esc(x.name)}. Good for seat height, grip or cues.</p>
    <textarea class="notes" id="note-in" placeholder="Seat 4, handles in position 2…">${esc(x.note || '')}</textarea></div>`);
  setTimeout(() => $('#note-in')?.focus(), 400);
}
A.saveNote = el => { ex(el.dataset.id).note = $('#note-in').value.trim(); save(); closeSheet(); render(); };
function showPlates(total) {
  const p = plates(total, +S.settings.bar || 20);
  const COLORS = { 25: '#d0342c', 20: '#1f5fbf', 15: '#e8b923', 10: '#2e9e4f', 5: '#f2f2f2', 2.5: '#222', 1.25: '#9a9a9a', .5: '#9a9a9a' };
  const H = { 25: 92, 20: 92, 15: 80, 10: 66, 5: 52, 2.5: 42, 1.25: 34, .5: 28 };
  sheet(`<div class="sh-hd"><span></span><h3>${fmtN(total)} kg</h3><button class="link strong" data-a="closeSheet">Done</button></div>
    <div class="sh-body"><p class="muted hint">${fmtN(+S.settings.bar || 20)} kg bar, then on each side:</p>
    <div class="plates"><span class="sleeve"></span>${p.out.map(x => `<span class="plate" style="height:${H[x]}px;background:${COLORS[x]}"><b>${fmtN(x, 2)}</b></span>`).join('')}</div>
    <p class="plate-list">${p.out.length ? p.out.map(x => fmtN(x, 2)).join(' + ') + ' kg per side' : 'Just the bar'}</p>
    ${p.rest > 0 ? `<p class="muted hint">${fmtN(p.rest * 2, 2)} kg can't be made with standard plates.</p>` : ''}</div>`);
}
function deleteSet(k, ei, si) {
  const w = getW(k), e = w.exercises[ei]; if (!e) return;
  const [removed] = e.sets.splice(si, 1);
  const after = () => { if (k === 'a') { recomputeRests(w); markActivePRs(); } else recomputeAllPRs(); save(); render(); };
  after();
  toast('Set deleted', () => { e.sets.splice(si, 0, removed); after(); });
}
async function deleteVideos(pred) {
  const gone = VIDS.filter(pred);
  for (const v of gone) await DB.delVideo(v.id);
  VIDS = VIDS.filter(v => !pred(v));
}

/* ---------- live timers ---------- */
let rbKey = null;
function updateRestbar(force) {
  const rb = $('#restbar'), w = S.active;
  const onWorkout = UI.tab === 'train' && !UI.stack.train.length;
  if (!w || (!w.lastDoneAt && onWorkout)) { rb.classList.add('hide'); rbKey = null; return; }
  const key = (w.lastDoneAt || 'start') + (onWorkout ? 'w' : 'o');
  if (key !== rbKey || force) {
    rbKey = key;
    rb.innerHTML = w.lastDoneAt
      ? `<button class="rb" data-a="goWorkout">${I.timer}<span class="rb-k">Rest</span><b data-since="${w.lastDoneAt}"></b><span class="rb-s">${esc(w.lastLabel)}</span></button>`
      : `<button class="rb" data-a="goWorkout">${icon('barbell', 20)}<span class="rb-k">Workout</span><b data-since="${w.start}"></b><span class="rb-s">In progress</span></button>`;
  }
  rb.classList.remove('hide');
}
function tick() { const now = Date.now(); for (const el of $$('[data-since]')) el.textContent = fmtClock((now - +el.dataset.since) / 1000); }

/* ---------- gestures: swipe to delete a set ---------- */
let SW = null;
document.addEventListener('pointerdown', e => {
  if (e.button > 0 || DR) return;
  const row = e.target.closest('[data-swipe]'); if (!row) return;
  SW = { row, fg: row.querySelector('.swipe-fg'), x0: e.clientX, y0: e.clientY, dx: 0, mode: null, id: e.pointerId, hist: [[e.timeStamp, e.clientX]], armed: false };
});
document.addEventListener('pointermove', e => {
  if (!SW || e.pointerId !== SW.id) return;
  const dx = e.clientX - SW.x0, dy = e.clientY - SW.y0;
  if (!SW.mode) {
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2 && dx < 0) {
      SW.mode = 'h'; try { SW.row.setPointerCapture(e.pointerId); } catch {}
      if (document.activeElement && SW.row.contains(document.activeElement)) document.activeElement.blur();
      SW.row.classList.add('swiping'); SW.fg.style.transition = 'none';
    } else if (Math.abs(dy) > 10 || dx > 10) { SW = null; return; } else return;
  }
  const w = SW.row.offsetWidth, x = Math.min(0, dx - (dx < 0 ? 10 : 0));
  SW.dx = x; SW.fg.style.transform = `translateX(${x}px)`;
  SW.row.style.setProperty('--p', Math.min(1, -x / (w * .4)).toFixed(3));
  const armed = -x > w * .4;
  if (armed !== SW.armed) { SW.armed = armed; SW.row.classList.toggle('armed', armed); haptic(); }
  SW.hist.push([e.timeStamp, e.clientX]); if (SW.hist.length > 6) SW.hist.shift();
});
function endSwipe(cancel) {
  if (!SW) return;
  const s = SW; SW = null;
  if (s.mode !== 'h') return;
  UI.noClick = true; setTimeout(() => { UI.noClick = false; }, 80);
  const [t0, x0] = s.hist[0], [t1, x1] = s.hist[s.hist.length - 1];
  const v = t1 > t0 ? (x1 - x0) / (t1 - t0) * 1000 : 0;          // px/s
  const projected = s.dx + (v / 1000) * .99 / (1 - .99) * 1;     // momentum projection (Apple's formula, d = .99)
  const w = s.row.offsetWidth;
  if (!cancel && (s.armed || (projected < -w * .6 && s.dx < -w * .25))) {
    s.fg.style.transition = 'transform .22s cubic-bezier(.32,.72,0,1)';
    s.fg.style.transform = `translateX(${-w}px)`;
    if (!s.armed) haptic();
    const h = s.row.offsetHeight;
    s.row.style.height = h + 'px';
    setTimeout(() => { s.row.style.transition = 'height .22s cubic-bezier(.32,.72,0,1), opacity .22s'; s.row.style.height = '0px'; s.row.style.opacity = '0'; }, 160);
    setTimeout(() => deleteSet(s.row.dataset.w, +s.row.dataset.ei, +s.row.dataset.si), 380);
  } else {
    s.fg.style.transition = 'transform .45s cubic-bezier(.32,.72,0,1)';
    s.fg.style.transform = 'translateX(0)';
    s.row.classList.remove('armed');
    s.row.style.setProperty('--p', 0);
    setTimeout(() => s.row.classList.remove('swiping'), 450);
  }
}
document.addEventListener('pointerup', () => endSwipe(false));
document.addEventListener('pointercancel', () => endSwipe(true));

/* ---------- gestures: drag to reorder ---------- */
let DR = null;
document.addEventListener('pointerdown', e => {
  const h = e.target.closest('[data-drag]'); if (!h) return;
  const list = h.closest('[data-reorder]'), item = h.closest('[data-ri]'); if (!list || !item) return;
  e.preventDefault();
  const items = [...list.children].filter(c => c.hasAttribute('data-ri'));
  const rects = items.map(i => i.getBoundingClientRect());
  const gap = items.length > 1 ? rects[1].top - rects[0].bottom : 0;
  DR = { list, item, items, rects, gap, from: items.indexOf(item), to: items.indexOf(item), y0: e.clientY, id: e.pointerId };
  try { h.setPointerCapture(e.pointerId); } catch {}
  item.classList.add('lifting'); haptic();
}, true);
document.addEventListener('pointermove', e => {
  if (!DR || e.pointerId !== DR.id) return;
  const dy = e.clientY - DR.y0, { rects, from, items } = DR;
  DR.item.style.transform = `translateY(${dy}px) scale(1.02)`;
  const c = rects[from].top + rects[from].height / 2 + dy;
  let to = from;
  rects.forEach((r, i) => { const mid = r.top + r.height / 2; if (i < from && c < mid) to = Math.min(to, i); if (i > from && c > mid) to = Math.max(to, i); });
  if (to !== DR.to) { DR.to = to; haptic(); }
  const hgt = rects[from].height + DR.gap;
  items.forEach((it, i) => { if (it === DR.item) return; const shift = (i > from && i <= to) ? -hgt : (i < from && i >= to) ? hgt : 0; it.style.transition = 'transform .25s cubic-bezier(.32,.72,0,1)'; it.style.transform = shift ? `translateY(${shift}px)` : ''; });
});
function endDrag() {
  if (!DR) return;
  const { list, from, to, items } = DR; DR = null;
  items.forEach(it => { it.style.transition = ''; it.style.transform = ''; it.classList.remove('lifting'); });
  UI.noClick = true; setTimeout(() => { UI.noClick = false; }, 80);
  if (from === to) return;
  const kind = list.dataset.reorder;
  const move = arr => { const [x] = arr.splice(from, 1); arr.splice(to, 0, x); };
  if (kind === 'sections') { move(S.sections); save(); renderSections(); return; }
  if (kind.startsWith('prog:')) move(S.programs.find(p => p.id === kind.slice(5)).items);
  if (kind.startsWith('wex:')) move(getW(kind.slice(4)).exercises);
  save(); render();
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

/* ---------- gestures: hold a graph to read values ---------- */
let SC = null;
document.addEventListener('touchstart', e => {
  const svg = e.target.closest && e.target.closest('svg.chart[data-pts]'); if (!svg) return;
  const t = e.touches[0];
  SC = { svg, x: t.clientX, y: t.clientY, on: false };
  SC.timer = setTimeout(() => { if (SC) { SC.on = true; chartScrubAt(svg, SC.x); haptic(); } }, 180);
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!SC) return;
  const t = e.touches[0];
  if (SC.on) { e.preventDefault(); chartScrubAt(SC.svg, t.clientX); }
  else if (Math.hypot(t.clientX - SC.x, t.clientY - SC.y) > 8) { clearTimeout(SC.timer); SC = null; }
}, { passive: false });
const endScrub = () => { if (SC) { clearTimeout(SC.timer); if (SC.on) chartEnd(SC.svg); SC = null; } };
document.addEventListener('touchend', endScrub);
document.addEventListener('touchcancel', endScrub);
document.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') { const svg = e.target.closest && e.target.closest('svg.chart[data-pts]'); if (svg) chartScrubAt(svg, e.clientX); } });
document.addEventListener('pointerout', e => { if (e.pointerType !== 'mouse') return; const s = e.target.closest && e.target.closest('svg.chart'); if (s && !s.contains(e.relatedTarget)) chartEnd(s); });

/* ---------- events ---------- */
document.addEventListener('click', e => { if (UI.noClick) { e.preventDefault(); e.stopPropagation(); } }, true);
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const fn = A[el.dataset.a];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('.title-input, .set-row input, .mini, .sec-name')) e.target.blur();
  if (e.key === 'Enter' && e.target.id === 'bw-val') A.logBw();
  if (e.key === 'Enter' && e.target.id === 'finish-name') A.confirmFinish();
  if (e.key === 'Escape') closeSheet();
});
document.addEventListener('input', e => {
  const b = e.target.dataset.bind; if (!b) return;
  const v = e.target.value, p = b.split(':');
  if (p[0] === 'set') {
    const w = getW(p[1]), s = w.exercises[+p[2]].sets[+p[3]]; s[p[4]] = v;
    if (p[1] === 'a') markActivePRs(); else s.done = num(s.r) > 0;
  }
  else if (p[0] === 'wn') getW(p[1]).notes = v;
  else if (p[0] === 'prog') S.programs.find(x => x.id === p[1]).name = v;
  else if (p[0] === 'pi') { const it = S.programs.find(x => x.id === p[1]).items[+p[2]]; it[p[3]] = p[3] === 'sets' ? (parseInt(v) || '') : v; }
  else if (p[0] === 'wk') S.workouts.find(x => x.id === p[1]).name = v;
  else if (p[0] === 'secname') S.sections.find(x => x.id === p[1]).name = v;
  else if (p[0] === 'pref') S.settings[p[1]] = p[1] === 'bar' ? (num(v) || 20) : v.replace(/[^\d]/g, '');
  else if (b === 'edit.name') { UI.edit.name = v; $('#ex-err').textContent = ''; return; }
  else if (b === 'edit.note') { UI.edit.note = v; return; }
  else if (b === 'libQ') { UI.libQ = v; $('#lib-list').innerHTML = libList(); return; }
  else if (b === 'histQ') { UI.histQ = v; $('#hist-list').innerHTML = histList(); return; }
  else if (b === 'pickerQ') { UI.picker.q = v; renderPicker(); return; }
  save();
});
document.addEventListener('change', e => {
  if (e.target.dataset.bind === 'edit.parent') {
    UI.edit.parent = e.target.value;
    if (e.target.value) { const p = ex(e.target.value); UI.edit.sec = p.sec; $$('#sec-chips .chip').forEach(c => c.classList.toggle('on', c.dataset.id === p.sec)); }
  }
  if (e.target.id === 'bw-val' || e.target.id === 'bw-date') $('#bw-err').textContent = '';
});
$('#vid-in').addEventListener('change', async e => {
  const files = [...e.target.files], T = UI.vidTarget; if (!files.length || !T) return;
  try {
    for (const f of files) {
      const v = { id: uid(), exId: T.exId, workoutId: T.workoutId, date: T.date, blob: f, type: f.type, name: f.name, size: f.size };
      await DB.putVideo(v); VIDS.push(v);
    }
    toast(files.length > 1 ? `${files.length} videos saved` : 'Video saved'); render();
  } catch (err) { toast('Could not save video: ' + (err.message || err.name)); }
});
$('#import-in').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const obj = JSON.parse(await f.text()), st = obj.state || obj;
    if (!Array.isArray(st.exercises) || !Array.isArray(st.workouts)) throw new Error('not a Lift Log backup');
    closeSheet(true);
    if (!await confirmSheet('Replace my data', { title: 'Import this backup?', msg: `${st.workouts.length} workouts from ${f.name}. Everything currently on this phone except videos is replaced.` })) return;
    S = migrate(st); recomputeAllPRs(); applyTheme(); save(true);
    UI.stack = { train: [], history: [], progress: [], library: [], profile: [] }; render(); toast('Backup imported');
  } catch (err) { toast("That file isn't a Lift Log backup"); }
});
document.addEventListener('visibilitychange', () => { if (!S) return; if (document.hidden) save(true); else { tick(); Sync.run(true); } syncWake(); });
window.addEventListener('online', () => Sync.run(true));
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => S && applyTheme());

/* ---------- boot ---------- */
(async function boot() {
  for (const s of $$('[data-ic]')) { const k = s.dataset.ic; s.outerHTML = UI_ICONS[k] ? svgIcon(UI_ICONS[k], 24) : icon(k, 24); }
  let fresh = false;
  try {
    await DB.open();
    const stored = await DB.get('state');
    fresh = !stored;
    S = migrate(stored || freshState());
    recomputeAllPRs();
    VIDS = await DB.allVideos();
    await Sync.load();
  } catch (e) {
    S = freshState(); fresh = true;
    toast('Storage unavailable — data won’t be kept');
  }
  applyTheme();
  navigator.storage?.persist?.().catch(() => {});
  const showNews = !fresh && S.seen !== APP_VERSION;
  S.seen = APP_VERSION; save(true);
  render();
  if (showNews) setTimeout(whatsNew, 400);
  else if (fresh && Sync.ready) setTimeout(welcome, 300);
  Sync.run(true);
  setInterval(tick, 1000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
