'use strict';
/* Lift Log — first prototype. All data lives on the device in IndexedDB. */

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 864e5;
const pad2 = n => String(n).padStart(2, '0');
const num = v => { if (v === '' || v == null) return NaN; const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : NaN; };
const fmtN = (n, d = 1) => isFinite(n) ? String(Math.round(n * 10 ** d) / 10 ** d) : '–';
const fmtInt = n => Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
const fmtVol = kg => kg >= 10000 ? fmtN(kg / 1000, 1) + ' t' : fmtInt(kg) + ' kg';
const fmtClock = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`; };
const fmtDur = ms => { const m = Math.max(1, Math.round(ms / 6e4)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
const fmtDate = (t, o = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(t).toLocaleDateString('en-GB', o);
const fmtTime = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const isoDay = t => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const e1rm = (w, r) => (w > 0 && r > 0) ? (r === 1 ? w : w * (1 + r / 30)) : 0;

/* ---------- storage ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('liftlog', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('kv');
        d.createObjectStore('videos', { keyPath: 'id' }).createIndex('exId', 'exId');
      };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = DB.db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  get: k => DB.tx('kv', 'readonly', s => s.get(k)),
  set: (k, v) => DB.tx('kv', 'readwrite', s => s.put(v, k)),
  putVideo: v => DB.tx('videos', 'readwrite', s => s.put(v)),
  delVideo: id => DB.tx('videos', 'readwrite', s => s.delete(id)),
  allVideos: () => DB.tx('videos', 'readonly', s => s.getAll()),
  clearVideos: () => DB.tx('videos', 'readwrite', s => s.clear()),
};

/* ---------- data ---------- */
const CATS = ['Barbell', 'Hammer Strength', 'Machine', 'Dumbbell', 'Cable', 'Bodyweight', 'Other'];
const DEFAULT_EX = [
  ['Squat', 'Barbell', 'squat'], ['Bench Press', 'Barbell', 'bench'], ['Deadlift', 'Barbell', 'deadlift'],
  ['Pause Squat', 'Barbell', 'squat'], ['Front Squat', 'Barbell', 'squat'], ['Close-Grip Bench Press', 'Barbell', 'bench'],
  ['Larsen Press', 'Barbell', 'bench'], ['Sumo Deadlift', 'Barbell', 'deadlift'], ['Romanian Deadlift', 'Barbell', 'deadlift'],
  ['Overhead Press', 'Barbell', 'press'], ['Barbell Row', 'Barbell', 'row'],
  ['Iso-Lateral Bench Press', 'Hammer Strength', 'machine'], ['Iso-Lateral Incline Press', 'Hammer Strength', 'machine'],
  ['Iso-Lateral Decline Press', 'Hammer Strength', 'machine'], ['Iso-Lateral Shoulder Press', 'Hammer Strength', 'machine'],
  ['Iso-Lateral Row', 'Hammer Strength', 'machine'], ['Iso-Lateral High Row', 'Hammer Strength', 'machine'],
  ['Iso-Lateral Low Row', 'Hammer Strength', 'machine'], ['Iso-Lateral Front Lat Pulldown', 'Hammer Strength', 'machine'],
  ['Iso-Lateral Leg Press', 'Hammer Strength', 'machine'], ['V-Squat', 'Hammer Strength', 'machine'],
  ['Leg Extension', 'Machine', 'machine'], ['Lying Leg Curl', 'Machine', 'machine'], ['Seated Leg Curl', 'Machine', 'machine'], ['Pec Deck', 'Machine', 'machine'],
  ['Dumbbell Bench Press', 'Dumbbell', 'dumbbell'], ['Dumbbell Row', 'Dumbbell', 'dumbbell'], ['Lateral Raise', 'Dumbbell', 'dumbbell'], ['Dumbbell Curl', 'Dumbbell', 'dumbbell'],
  ['Lat Pulldown', 'Cable', 'cable'], ['Seated Cable Row', 'Cable', 'cable'], ['Triceps Pushdown', 'Cable', 'cable'], ['Face Pull', 'Cable', 'cable'],
  ['Pull-up', 'Bodyweight', 'pullup'], ['Dip', 'Bodyweight', 'dip'], ['Plank', 'Bodyweight', 'core'],
];
const freshState = () => ({
  v: 1,
  exercises: DEFAULT_EX.map(([name, cat, ic], i) => ({ id: 'x' + i, name, cat, icon: ic })),
  programs: [], workouts: [], body: [],
  settings: { effort: 'RPE' },
  active: null,
});
function migrate(st) {
  const f = freshState();
  for (const k of ['exercises', 'programs', 'workouts', 'body']) if (!Array.isArray(st[k])) st[k] = f[k];
  st.settings = Object.assign(f.settings, st.settings || {});
  if (st.active === undefined) st.active = null;
  return st;
}

let S;              // persisted app state
let VIDS = [];      // video records (blobs stay lazy)
const UI = {
  tab: 'train', stack: { train: [], history: [], library: [], body: [] }, scroll: {}, lastKey: '',
  histSort: 'new', histQ: '', libQ: '', exMetric: 'e1rm', exRange: 'all', bodyRange: '3m',
  urls: [], pick: null, sheetClose: null, picker: null, edit: null, vidTarget: null,
};

let saveTimer;
function save(now) {
  clearTimeout(saveTimer);
  const go = () => DB.set('state', S).catch(e => toast('Could not save: ' + e.message));
  if (now) go(); else saveTimer = setTimeout(go, 250);
}

const ex = id => S.exercises.find(e => e.id === id) || { id, name: 'Deleted exercise', cat: 'Other', icon: 'barbell', archived: true };
const performed = s => s.done && num(s.r) > 0;
const working = s => performed(s) && !s.warm;
function sessionsFor(exId) {
  const out = [];
  for (const w of S.workouts) for (const e of w.exercises) {
    if (e.exId !== exId) continue;
    const sets = e.sets.filter(performed);
    if (sets.length) out.push({ w, e, sets });
  }
  return out.sort((a, b) => b.w.start - a.w.start);
}
function bestE1rm(exId, extraSets = []) {
  let b = 0;
  for (const w of S.workouts) for (const e of w.exercises) if (e.exId === exId) for (const s of e.sets) if (working(s)) b = Math.max(b, e1rm(num(s.w) || 0, num(s.r)));
  for (const s of extraSets) b = Math.max(b, e1rm(num(s.w) || 0, num(s.r)));
  return b;
}
const wVolume = w => w.exercises.reduce((v, e) => v + e.sets.filter(working).reduce((a, s) => a + (num(s.w) || 0) * num(s.r), 0), 0);
const wSets = w => w.exercises.reduce((n, e) => n + e.sets.filter(working).length, 0);
const wPRs = w => w.exercises.reduce((n, e) => n + e.sets.filter(s => s.isPR).length, 0);
function effortText(s, et) {
  if (s.e === '' || s.e == null || et === 'off') return '';
  return et === 'RIR' ? ` · ${s.e} RIR` : ` @${s.e}`;
}
function setLabel(s, et) {
  const w = num(s.w);
  return (isFinite(w) && w > 0 ? fmtN(w) + ' × ' : '') + (num(s.r) || 0) + (et ? effortText(s, et) : '');
}

/* ---------- workouts ---------- */
const newSet = (pw = '', pr = '') => ({ id: uid(), w: '', r: '', e: '', done: false, doneAt: null, restAfter: null, pw: String(pw ?? ''), pr: String(pr ?? '') });
function makeEntry(exId, n = 3, reps = '') {
  const last = sessionsFor(exId)[0];
  const work = last ? last.sets.filter(s => !s.warm) : [];
  const sets = [];
  for (let i = 0; i < n; i++) {
    const ls = work[Math.min(i, work.length - 1)];
    sets.push(newSet(ls ? ls.w : '', reps !== '' ? reps : (ls ? ls.r : '')));
  }
  return { id: uid(), exId, et: S.settings.effort, sets };
}
function startWorkout(name, programId, items) {
  if (S.active) { goWorkout(); toast('Finish this workout first'); return; }
  S.active = { id: uid(), name: name || 'Workout', programId: programId || null, start: Date.now(), end: null, notes: '', lastDoneAt: null, lastLabel: '',
    exercises: (items || []).map(it => makeEntry(it.exId, Math.max(1, +it.sets || 3), it.reps ?? '')) };
  save(); UI.tab = 'train'; UI.stack.train = []; render('push');
}
function recomputeRests(w) {
  const done = [];
  for (const e of w.exercises) for (const s of e.sets) if (s.done && s.doneAt) done.push({ s, e });
  done.sort((a, b) => a.s.doneAt - b.s.doneAt);
  done.forEach((d, i) => { d.s.restAfter = i < done.length - 1 ? Math.round((done[i + 1].s.doneAt - d.s.doneAt) / 1000) : null; });
  const last = done[done.length - 1];
  w.lastDoneAt = last ? last.s.doneAt : null;
  w.lastLabel = last ? `${ex(last.e.exId).name} · ${setLabel(last.s)}` : '';
}
function markPRs(w) {
  for (const e of w.exercises) {
    const before = bestE1rm(e.exId);
    let best = before;
    for (const s of [...e.sets].filter(working).sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0))) {
      const v = e1rm(num(s.w) || 0, num(s.r));
      s.isPR = before > 0 && v > best + 1e-9;
      if (v > best) best = v;
    }
  }
}
function goWorkout() { UI.tab = 'train'; UI.stack.train = []; render(); }

/* ---------- navigation ---------- */
const TITLES = { train: 'Train', history: 'History', library: 'Library', body: 'Body' };
function routeTitle(r) {
  if (!r) return UI.tab === 'train' && S.active ? (S.active.name || 'Workout') : TITLES[UI.tab];
  if (r.v === 'program') return S.programs.find(p => p.id === r.id)?.name || 'Program';
  if (r.v === 'exercise') return ex(r.id).name;
  if (r.v === 'workout') return S.workouts.find(w => w.id === r.id)?.name || 'Workout';
  return '';
}
function backLabel() { const st = UI.stack[UI.tab]; const t = routeTitle(st[st.length - 2]); return t.length > 18 ? t.slice(0, 17) + '…' : t; }
function push(r) { UI.stack[UI.tab].push(r); render('push'); }
function back() { UI.stack[UI.tab].pop(); render('pop'); }

function render(anim) {
  const view = $('#view');
  UI.scroll[UI.lastKey] = view.scrollTop;
  const st = UI.stack[UI.tab], r = st[st.length - 1];
  const key = UI.tab + ':' + (r ? r.v + r.id : 'root') + (UI.tab === 'train' && !r && S.active ? S.active.id : '');
  for (const u of UI.urls) URL.revokeObjectURL(u);
  UI.urls = [];
  view.innerHTML = r ? ({ program: vProgram, exercise: vExercise, workout: vWorkout })[r.v](r.id) : ({ train: vTrain, history: vHistory, library: vLibrary, body: vBody })[UI.tab]();
  view.scrollTop = key === UI.lastKey ? UI.scroll[key] : (anim === 'push' ? 0 : UI.scroll[key] || 0);
  UI.lastKey = key;
  for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === UI.tab);
  if (anim && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const dx = anim === 'push' ? '28%' : '-28%';
    view.animate([{ transform: `translateX(${dx})`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.32,.72,0,1)' });
  }
  updateRestbar(true); tick();
}

/* ---------- small components ---------- */
function header(title, { back: b, right = '', sub = '', lead = '' } = {}) {
  return `<header class="hd">${b !== undefined ? `<div class="hd-bar"><button class="back" data-a="back">${I.chevL}<span>${esc(b)}</span></button>${right}</div>` : ''}
  <div class="hd-row"><div class="hd-lead">${lead}<h1>${esc(title)}</h1></div>${b === undefined ? right : ''}</div>${sub ? `<p class="hd-sub">${sub}</p>` : ''}</header>`;
}
const searchBox = (bind, val, ph = 'Search') => `<div class="search">${I.search}<input type="search" placeholder="${ph}" data-bind="${bind}" value="${esc(val)}" autocomplete="off" autocorrect="off"></div>`;
const seg = (action, opts, cur, cls = '') => `<div class="seg ${cls}" role="tablist">${opts.map(([v, l]) => `<button role="tab" aria-selected="${v === cur}" class="${v === cur ? 'on' : ''}" data-a="${action}" data-v="${v}">${l}</button>`).join('')}</div>`;
const exRow = (x, meta, a = 'openExercise', right = I.chevR) => `<button class="row" data-a="${a}" data-id="${x.id}"><span class="row-ic">${icon(x.icon)}</span><span class="row-main"><span class="row-t">${esc(x.name)}</span>${meta ? `<span class="row-s">${meta}</span>` : ''}</span>${right}</button>`;
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
  return header('Train', { right: `<button class="icon-btn" data-a="settings" aria-label="Settings">${I.gear}</button>` }) + `<div class="pad">
    <button class="big-btn" data-a="startEmpty">${I.plus} Start empty workout</button>
    <div class="sec-hd"><h2>Programs</h2><button class="link strong" data-a="newProgram">New</button></div>
    ${progs || `<div class="empty">Programs are workouts you've saved, ready to start with one tap.<button class="link" data-a="newProgram">Create a program</button></div>`}
    ${last ? `<div class="sec-hd"><h2>Last workout</h2></div>${workoutRow(last)}` : ''}
  </div>`;
}
function vActive() {
  const w = S.active;
  return `<header class="hd"><div class="hd-bar"><button class="link danger" data-a="discardWorkout">Discard</button><button class="pill" data-a="finishWorkout">Finish</button></div>
    <input class="title-input" data-bind="active.name" value="${esc(w.name)}" aria-label="Workout name" enterkeyhint="done">
    <p class="hd-sub"><span data-since="${w.start}"></span> · ${fmtDate(w.start)}, ${fmtTime(w.start)}</p></header>
    <div class="pad">${w.exercises.map(exCard).join('')}
    ${w.exercises.length ? '' : `<div class="empty">Add the first exercise to start logging.</div>`}
    <button class="big-btn ghost" data-a="addExToWorkout">${I.plus} Add exercise</button>
    <textarea class="notes" data-bind="active.notes" placeholder="Notes">${esc(w.notes)}</textarea></div>`;
}
function exCard(e, ei) {
  const x = ex(e.exId), w = S.active;
  const last = sessionsFor(e.exId)[0];
  const nv = VIDS.filter(v => v.workoutId === w.id && v.exId === e.exId).length;
  const hasE = e.et !== 'off';
  let n = 0;
  return `<section class="card excard">
    <div class="ex-hd"><button class="ex-title" data-a="openExercise" data-id="${x.id}">${icon(x.icon)}<span>${esc(x.name)}</span></button>
      <button class="icon-btn sm" data-a="addVideo" data-ex="${x.id}" data-w="${w.id}" aria-label="Add video">${I.video}${nv ? `<b>${nv}</b>` : ''}</button>
      <button class="icon-btn sm" data-a="exMenu" data-ei="${ei}" aria-label="More options">${I.more}</button></div>
    ${last ? `<p class="ex-last">Last time, ${fmtDate(last.w.start, { day: 'numeric', month: 'short' })}: ${last.sets.map(s => setLabel(s)).join(', ')}</p>` : ''}
    <div class="set-row head ${hasE ? '' : 'no-e'}"><span>Set</span><span>kg</span><span>Reps</span>${hasE ? `<button class="et" data-a="exMenu" data-ei="${ei}">${e.et}</button>` : ''}<span></span></div>
    ${e.sets.map((s, si) => setRow(e, s, ei, si, s.warm ? 'W' : ++n)).join('')}
    <button class="add-set" data-a="addSet" data-ei="${ei}">${I.plus} Add set</button></section>`;
}
function setRow(e, s, ei, si, label) {
  const hasE = e.et !== 'off';
  const live = s.done && s.restAfter == null && S.active.lastDoneAt === s.doneAt;
  const b = `set:${ei}:${si}`;
  return `<div class="set-row ${s.done ? 'done' : ''} ${hasE ? '' : 'no-e'}">
    <button class="set-n" data-a="setMenu" data-ei="${ei}" data-si="${si}" aria-label="Set ${label} options">${label}</button>
    <input inputmode="decimal" data-bind="${b}:w" value="${esc(s.w)}" placeholder="${esc(s.pw)}" aria-label="Weight in kg">
    <input inputmode="numeric" data-bind="${b}:r" value="${esc(s.r)}" placeholder="${esc(s.pr)}" aria-label="Reps">
    ${hasE ? `<input inputmode="decimal" data-bind="${b}:e" value="${esc(s.e)}" placeholder="–" aria-label="${e.et}">` : ''}
    <button class="check" data-a="toggleSet" data-ei="${ei}" data-si="${si}" aria-label="${s.done ? 'Mark not done' : 'Mark done'}">${I.check}</button></div>
    ${s.done ? `<div class="rest ${live ? 'live' : ''}">${I.timer}${live ? `<span data-since="${s.doneAt}"></span>&nbsp;resting` : `${fmtClock(s.restAfter || 0)} rest`}${s.isPR ? '<span class="pr">PR</span>' : ''}</div>` : ''}`;
}

/* ---------- Program editor ---------- */
function vProgram(id) {
  const p = S.programs.find(x => x.id === id);
  if (!p) return header('Program removed', { back: backLabel() });
  return `<header class="hd"><div class="hd-bar"><button class="back" data-a="back">${I.chevL}<span>${esc(backLabel())}</span></button></div>
    <input class="title-input" data-bind="prog:${id}:name" value="${esc(p.name)}" placeholder="Program name" aria-label="Program name" enterkeyhint="done"></header>
    <div class="pad"><button class="big-btn" data-a="startProgram" data-id="${id}">${svgIcon(UI_ICONS.play, 18)} Start workout</button>
    <div class="sec-hd"><h2>Exercises</h2></div>
    ${p.items.length ? `<div class="card list">${p.items.map((it, i) => { const x = ex(it.exId); return `<div class="row">
      <span class="row-ic">${icon(x.icon)}</span>
      <span class="row-main"><span class="row-t">${esc(x.name)}</span>
        <span class="row-s pfields"><input class="mini" inputmode="numeric" data-bind="pi:${id}:${i}:sets" value="${esc(it.sets)}" aria-label="Sets"> sets × <input class="mini" inputmode="numeric" data-bind="pi:${id}:${i}:reps" value="${esc(it.reps)}" placeholder="–" aria-label="Reps"> reps</span></span>
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
function vHistory() {
  const q = UI.histQ.trim().toLowerCase();
  let list = S.workouts.filter(w => !q || w.name.toLowerCase().includes(q) || w.exercises.some(e => ex(e.exId).name.toLowerCase().includes(q)));
  const by = { new: (a, b) => b.start - a.start, old: (a, b) => a.start - b.start, long: (a, b) => (b.end - b.start) - (a.end - a.start), vol: (a, b) => wVolume(b) - wVolume(a) };
  list.sort(by[UI.histSort]);
  const weekAgo = Date.now() - 7 * DAY;
  const sub = S.workouts.length ? `${S.workouts.length} workout${S.workouts.length > 1 ? 's' : ''} · ${S.workouts.filter(w => w.start > weekAgo).length} in the last 7 days` : '';
  let body = '';
  if (!S.workouts.length) body = `<div class="empty">Finished workouts show up here.</div>`;
  else if (!list.length) body = `<div class="empty">No workouts match “${esc(UI.histQ)}”.</div>`;
  else if (UI.histSort === 'new' || UI.histSort === 'old') {
    let m = '';
    for (const w of list) {
      const mm = fmtDate(w.start, { month: 'long', year: 'numeric' });
      if (mm !== m) { body += `<p class="month">${mm}</p>`; m = mm; }
      body += workoutRow(w);
    }
  } else body = list.map(workoutRow).join('');
  return header('History', { sub }) + `<div class="pad">${searchBox('histQ', UI.histQ, 'Search workouts or exercises')}
    ${seg('histSort', [['new', 'Newest'], ['old', 'Oldest'], ['long', 'Longest'], ['vol', 'Volume']], UI.histSort)}
    <div id="hist-list">${body}</div></div>`;
}
function vWorkout(id) {
  const w = S.workouts.find(x => x.id === id);
  if (!w) return header('Workout removed', { back: backLabel() });
  const prs = wPRs(w);
  return `<header class="hd"><div class="hd-bar"><button class="back" data-a="back">${I.chevL}<span>${esc(backLabel())}</span></button></div>
    <input class="title-input" data-bind="wk:${id}:name" value="${esc(w.name)}" aria-label="Workout name" enterkeyhint="done">
    <p class="hd-sub">${fmtDate(w.start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${fmtTime(w.start)}–${fmtTime(w.end)}</p></header>
    <div class="pad"><div class="stats">
      <div class="stat"><div class="k">Duration</div><div class="v">${fmtDur(w.end - w.start)}</div></div>
      <div class="stat"><div class="k">Volume</div><div class="v">${fmtVol(wVolume(w))}</div></div>
      <div class="stat"><div class="k">Working sets</div><div class="v">${wSets(w)}</div></div>
      <div class="stat"><div class="k">PRs</div><div class="v">${prs}</div></div></div>
    ${w.exercises.map(e => { const x = ex(e.exId); const vids = VIDS.filter(v => v.workoutId === w.id && v.exId === e.exId); let n = 0; return `<section class="card excard">
      <div class="ex-hd"><button class="ex-title" data-a="openExercise" data-id="${x.id}">${icon(x.icon)}<span>${esc(x.name)}</span></button>
      <button class="icon-btn sm" data-a="addVideo" data-ex="${x.id}" data-w="${w.id}" aria-label="Add video">${I.video}</button></div>
      <div style="margin-top:8px">${e.sets.map(s => `<div class="wd-set"><span class="n">${s.warm ? 'W' : ++n}</span><span>${setLabel(s, e.et)}${s.isPR ? '<span class="pr">PR</span>' : ''}</span><span class="r">${s.restAfter != null ? fmtClock(s.restAfter) + ' rest' : ''}</span></div>`).join('')}</div>
      ${vids.length ? vidGrid(vids) : ''}</section>`; }).join('')}
    ${w.notes ? `<div class="card"><div class="muted" style="font-size:13px;font-weight:600;margin-bottom:4px">Notes</div>${esc(w.notes).replace(/\n/g, '<br>')}</div>` : ''}
    <div class="sec-hd"></div>
    <button class="big-btn" data-a="repeatWorkout" data-id="${id}">Repeat this workout</button>
    <button class="big-btn ghost" data-a="saveAsProgram" data-id="${id}">Save as program</button>
    <button class="big-btn ghost danger" data-a="deleteWorkout" data-id="${id}">Delete workout</button></div>`;
}

/* ---------- Library ---------- */
function libList() {
  const q = UI.libQ.trim().toLowerCase();
  const counts = {};
  for (const w of S.workouts) for (const e of w.exercises) counts[e.exId] = (counts[e.exId] || 0) + 1;
  const list = S.exercises.filter(x => !x.archived && x.name.toLowerCase().includes(q));
  if (!list.length) return `<div class="empty">No exercise called “${esc(UI.libQ)}”.<button class="link" data-a="newExLib">Create it</button></div>`;
  return CATS.map(c => {
    const xs = list.filter(x => x.cat === c).sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0) || a.name.localeCompare(b.name));
    if (!xs.length) return '';
    return `<p class="grp-t">${c}</p><div class="card list">${xs.map(x => exRow(x, counts[x.id] ? `${counts[x.id]} session${counts[x.id] > 1 ? 's' : ''}` : '')).join('')}</div>`;
  }).join('');
}
function vLibrary() {
  return header('Library', { right: `<button class="icon-btn" data-a="newExLib" aria-label="New exercise">${I.plus}</button>` })
    + `<div class="pad">${searchBox('libQ', UI.libQ)}<div id="lib-list">${libList()}</div></div>`;
}
const RANGES = [['1m', '1M', 30], ['3m', '3M', 91], ['1y', '1Y', 365], ['all', 'All', Infinity]];
const inRange = (pts, r) => { const d = RANGES.find(x => x[0] === r)[2]; const from = Date.now() - d * DAY; return pts.filter(p => p.t >= from); };
function exSeries(id, metric) {
  return sessionsFor(id).map(({ w, sets }) => {
    const work = sets.filter(s => !s.warm);
    if (!work.length) return null;
    let v;
    if (metric === 'e1rm') v = Math.max(...work.map(s => e1rm(num(s.w) || 0, num(s.r))));
    else if (metric === 'top') v = Math.max(...work.map(s => num(s.w) || 0));
    else if (metric === 'reps') v = Math.max(...work.map(s => num(s.r) || 0));
    else v = work.reduce((a, s) => a + (num(s.w) || 0) * num(s.r), 0);
    return { t: w.start, v };
  }).filter(p => p && p.v > 0).reverse();
}
function vExercise(id) {
  const x = ex(id), ss = sessionsFor(id);
  const weighted = ss.some(({ sets }) => sets.some(s => num(s.w) > 0));
  const metrics = weighted ? [['e1rm', 'Est. 1RM'], ['top', 'Top weight'], ['vol', 'Volume']] : [['reps', 'Best reps'], ['vol', 'Volume']];
  if (!metrics.some(m => m[0] === UI.exMetric)) UI.exMetric = metrics[0][0];
  const m = UI.exMetric, unit = m === 'reps' ? 'reps' : 'kg';
  const pts = inRange(exSeries(id, m), UI.exRange);
  const all = ss.flatMap(o => o.sets.filter(s => !s.warm));
  const best = bestE1rm(id), heavy = Math.max(0, ...all.map(s => num(s.w) || 0));
  const vol = all.reduce((a, s) => a + (num(s.w) || 0) * num(s.r), 0);
  const vids = VIDS.filter(v => v.exId === id).sort((a, b) => b.date - a.date);
  return header(x.name, { back: backLabel(), right: `<button class="link" data-a="editEx" data-id="${id}">Edit</button>`, sub: esc(x.cat), lead: `<span class="hero-ic">${icon(x.icon, 32)}</span>` })
  + `<div class="pad">
    ${seg('exMetric', metrics, m)}
    ${chartCard(metrics.find(z => z[0] === m)[1], pts, unit, 'exRange', UI.exRange, m === 'vol')}
    <div class="stats">
      <div class="stat"><div class="k">Best est. 1RM</div><div class="v">${best ? fmtN(best) + ' kg' : '–'}</div></div>
      <div class="stat"><div class="k">Heaviest</div><div class="v">${heavy ? fmtN(heavy) + ' kg' : '–'}</div></div>
      <div class="stat"><div class="k">Sessions</div><div class="v">${ss.length}</div></div>
      <div class="stat"><div class="k">Total volume</div><div class="v">${fmtVol(vol)}</div></div></div>
    <div class="sec-hd"><h2>Videos</h2><button class="link strong" data-a="addVideo" data-ex="${id}">Add</button></div>
    ${vids.length ? vidGrid(vids) : `<div class="empty">Record a set or pick a video from your library to watch it back here.</div>`}
    <div class="sec-hd"><h2>History</h2>${ss.length ? `<span class="muted">${ss.length} session${ss.length > 1 ? 's' : ''}</span>` : ''}</div>
    ${ss.length ? ss.map(({ w, e, sets }) => `<button class="card" data-a="openWorkout" data-id="${w.id}">
      <div class="hist-hd"><span>${fmtDate(w.start, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span><span class="muted">${esc(w.name)}</span></div>
      <div class="hist-sets">${sets.map(s => `<span class="${s.warm ? 'w' : ''}">${setLabel(s, e.et)}${s.isPR ? '<span class="pr">PR</span>' : ''}</span>`).join('')}</div></button>`).join('')
      : `<div class="empty">Every set you log for ${esc(x.name)} will be listed here.</div>`}
  </div>`;
}

/* ---------- Body ---------- */
function vBody() {
  const all = [...S.body].sort((a, b) => a.date - b.date);
  const latest = all[all.length - 1];
  const pts = inRange(all.map(b => ({ t: b.date, v: b.kg })), UI.bodyRange);
  const avg7 = (() => { const from = Date.now() - 7 * DAY; const xs = all.filter(b => b.date >= from); return xs.length ? xs.reduce((a, b) => a + b.kg, 0) / xs.length : NaN; })();
  return header('Body') + `<div class="pad">
    <div class="card"><div class="bw">
      <input id="bw-val" inputmode="decimal" placeholder="${latest ? fmtN(latest.kg) : 'Weight'}" aria-label="Bodyweight in kg" enterkeyhint="done">
      <input id="bw-date" type="date" value="${isoDay(Date.now())}" max="${isoDay(Date.now())}" aria-label="Date">
      <button class="pill" data-a="logBw">Log</button></div><p class="err" id="bw-err"></p></div>
    ${chartCard('Bodyweight', pts, 'kg', 'bodyRange', UI.bodyRange)}
    <div class="stats">
      <div class="stat"><div class="k">Latest</div><div class="v">${latest ? fmtN(latest.kg) + ' kg' : '–'}</div></div>
      <div class="stat"><div class="k">7-day average</div><div class="v">${isFinite(avg7) ? fmtN(avg7) + ' kg' : '–'}</div></div></div>
    ${all.length ? `<div class="sec-hd"><h2>Entries</h2></div><div class="card list">${[...all].reverse().map(b => `<button class="row" data-a="bwMenu" data-id="${b.id}"><span class="row-main"><span class="row-t">${fmtN(b.kg)} kg</span></span><span class="row-v">${fmtDate(b.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span></button>`).join('')}</div>` : ''}
  </div>`;
}

/* ---------- Charts ---------- */
const CW = 320, CH = 150;
function chartCard(label, pts, unit, rangeAction, range, isVol) {
  const f = v => isVol ? fmtVol(v).replace(/ (kg|t)$/, ' <small>$1</small>') : `${fmtN(v)} <small>${unit}</small>`;
  const last = pts[pts.length - 1], first = pts[0];
  let delta = '', up = false;
  if (pts.length > 1) {
    const d = last.v - first.v; up = d > 0 && rangeAction !== 'bodyRange';
    delta = `${d > 0 ? '+' : d < 0 ? '−' : '±'}${isVol ? fmtVol(Math.abs(d)) : fmtN(Math.abs(d)) + ' ' + unit} since ${fmtDate(first.t, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  } else if (last) delta = fmtDate(last.t, { day: 'numeric', month: 'short', year: 'numeric' });
  return `<div class="card chart-card" data-unit="${unit}" data-vol="${isVol ? 1 : ''}"><p class="k">${label}</p>
    <p class="big">${last ? f(last.v) : '–'}</p><p class="delta ${up ? 'up' : ''}">${delta || '&nbsp;'}</p>
    ${chart(pts)}${seg(rangeAction, RANGES.map(r => [r[0], r[1]]), range, 'sm')}</div>`;
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
function chartScrub(e) {
  const svg = e.target.closest && e.target.closest('svg.chart[data-pts]');
  if (!svg) return;
  const data = JSON.parse(svg.dataset.pts), r = svg.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * CW;
  let best = data[0];
  for (const d of data) if (Math.abs(d[0] - x) < Math.abs(best[0] - x)) best = d;
  const card = svg.closest('.chart-card'), big = $('.big', card), dl = $('.delta', card);
  if (big.dataset.orig == null) { big.dataset.orig = big.innerHTML; dl.dataset.orig = dl.innerHTML; dl.dataset.cls = dl.className; }
  big.innerHTML = card.dataset.vol ? fmtVol(best[3]).replace(/ (kg|t)$/, ' <small>$1</small>') : `${fmtN(best[3])} <small>${card.dataset.unit}</small>`;
  dl.className = 'delta'; dl.textContent = fmtDate(best[2], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const cur = $('.cur', svg), hl = $('.hl', svg);
  cur.setAttribute('x1', best[0]); cur.setAttribute('x2', best[0]); cur.style.opacity = .35;
  hl.setAttribute('cx', best[0]); hl.setAttribute('cy', best[1]); hl.style.opacity = 1;
}
function chartEnd(svg) {
  const card = svg.closest('.chart-card'), big = $('.big', card), dl = $('.delta', card);
  if (big.dataset.orig != null) { big.innerHTML = big.dataset.orig; dl.innerHTML = dl.dataset.orig; dl.className = dl.dataset.cls; delete big.dataset.orig; }
  $('.cur', svg).style.opacity = 0; $('.hl', svg).style.opacity = 0;
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
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); }

/* Exercise picker */
function openPicker(onDone, title = 'Add exercises') {
  UI.picker = { sel: [], q: '', onDone };
  sheet(`<div class="sh-hd"><button class="link" data-a="closeSheet">Cancel</button><h3>${title}</h3><button class="link strong" data-a="pickerAdd" id="pk-add">Add</button></div>
    <div class="sh-body">${searchBox('pickerQ', '')}<div id="pk-list"></div>
    <button class="big-btn ghost" data-a="newExPicker">${I.plus} New exercise</button></div>`, { cls: 'full' });
  renderPicker();
}
function renderPicker() {
  const P = UI.picker, q = P.q.trim().toLowerCase();
  const list = S.exercises.filter(x => !x.archived && x.name.toLowerCase().includes(q));
  $('#pk-list').innerHTML = list.length ? CATS.map(c => {
    const xs = list.filter(x => x.cat === c);
    return xs.length ? `<p class="grp-t">${c}</p><div class="card list">${xs.map(x => exRow(x, '', 'pickerToggle', P.sel.includes(x.id) ? `<span class="check" style="background:var(--ink);border-color:var(--ink);color:var(--on-ink);width:26px;height:26px">${svgIcon(UI_ICONS.check, 16)}</span>` : `<span class="check" style="width:26px;height:26px"></span>`)).join('')}</div>` : '';
  }).join('') : `<div class="empty">No exercise called “${esc(P.q)}”.</div>`;
  $('#pk-add').textContent = P.sel.length ? `Add (${P.sel.length})` : 'Add';
}

/* Exercise editor */
function openExEdit(id) {
  const x = id ? ex(id) : { name: UI.picker?.q || '', cat: 'Barbell', icon: 'barbell' };
  UI.edit = { id, name: x.name, cat: x.cat, icon: x.icon };
  sheet(`<div class="sh-hd"><button class="link" data-a="closeSheet">Cancel</button><h3>${id ? 'Edit exercise' : 'New exercise'}</h3><button class="link strong" data-a="saveEx">Save</button></div>
    <div class="sh-body"><div class="field"><input data-bind="edit.name" value="${esc(x.name)}" placeholder="Name, e.g. Hammer Strength Pullover" aria-label="Exercise name"></div><p class="err" id="ex-err"></p>
    <p class="label">Category</p><div class="chips">${CATS.map(c => `<button class="chip ${c === x.cat ? 'on' : ''}" data-a="editCat" data-c="${c}">${c}</button>`).join('')}</div>
    <p class="label">Icon</p><div class="icon-grid">${Object.keys(EX_ICONS).map(k => `<button class="icon-cell ${k === x.icon ? 'on' : ''}" data-a="editIcon" data-k="${k}" aria-label="${k} icon">${icon(k, 30)}</button>`).join('')}</div>
    ${id ? `<div class="sec-hd"></div><button class="big-btn ghost danger" data-a="deleteEx" data-id="${id}">Delete exercise</button>` : ''}</div>`, { cls: 'full' });
  if (!id) setTimeout(() => $('[data-bind="edit.name"]')?.focus(), 350);
}

/* Settings */
async function openSettings() {
  let storage = '';
  try {
    const [est, persisted] = await Promise.all([navigator.storage?.estimate?.(), navigator.storage?.persisted?.()]);
    if (est) storage = `${fmtN(est.usage / 1048576, 1)} MB used`;
    storage += persisted ? ' · protected from automatic clean-up' : '';
  } catch {}
  sheet(`<div class="sh-hd"><span></span><h3>Settings</h3><button class="link strong" data-a="closeSheet">Done</button></div>
    <div class="sh-body">
    <p class="label">Effort per set</p>${seg('setEffort', [['RPE', 'RPE'], ['RIR', 'RIR'], ['off', 'Off']], S.settings.effort)}
    <p class="muted" style="font-size:13px;margin:-4px 4px 0">Default for new exercises. You can switch any exercise during a workout from its ⋯ menu.</p>
    <p class="label">Your data</p>
    <div class="card list">
      <button class="row" data-a="exportData"><span class="row-main"><span class="row-t">Export backup</span><span class="row-s">Saves workouts, programs and bodyweight as a file</span></span>${I.chevR}</button>
      <button class="row" data-a="importData"><span class="row-main"><span class="row-t">Import backup</span><span class="row-s">Replaces what's on this phone</span></span>${I.chevR}</button></div>
    <p class="muted" style="font-size:13px;margin:0 4px">${storage ? esc(storage) + '. ' : ''}Everything is stored only on this phone. Videos aren't included in the backup file.</p>
    <div class="sec-hd"></div>
    <button class="big-btn ghost danger" data-a="eraseAll">Erase all data</button></div>`, { cls: 'full' });
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

/* ---------- actions ---------- */
const A = {
  tab(el) {
    const t = el.dataset.tab;
    if (t === UI.tab) { if (UI.stack[t].length) { UI.stack[t] = []; render('pop'); } else $('#view').scrollTo({ top: 0, behavior: 'smooth' }); return; }
    UI.tab = t; render();
  },
  back, closeSheet: () => closeSheet(),
  pick(el) { const p = UI.pick; UI.pick = null; closeSheet(); p && p(+el.dataset.i); },
  goWorkout,
  settings: openSettings,

  startEmpty: () => startWorkout('Workout'),
  startProgram(el) { const p = S.programs.find(x => x.id === el.dataset.id); if (p) startWorkout(p.name, p.id, p.items); },
  openProgram(el) { push({ v: 'program', id: el.dataset.id }); },
  newProgram() {
    const p = { id: uid(), name: 'New program', items: [] };
    S.programs.push(p); save(); push({ v: 'program', id: p.id });
    setTimeout(() => { const i = $('.title-input'); i && (i.focus(), i.select()); }, 60);
  },
  addExToProgram(el) {
    const p = S.programs.find(x => x.id === el.dataset.id);
    openPicker(ids => { for (const id of ids) p.items.push({ id: uid(), exId: id, sets: 3, reps: '' }); save(); render(); });
  },
  async progItemMenu(el) {
    const p = S.programs.find(x => x.id === el.dataset.id), i = +el.dataset.i;
    const c = await actionSheet([{ label: 'Move up' }, { label: 'Move down' }, { label: 'Remove', danger: true }], { title: ex(p.items[i].exId).name });
    if (c === 0 && i > 0) [p.items[i - 1], p.items[i]] = [p.items[i], p.items[i - 1]];
    else if (c === 1 && i < p.items.length - 1) [p.items[i + 1], p.items[i]] = [p.items[i], p.items[i + 1]];
    else if (c === 2) p.items.splice(i, 1);
    else return;
    save(); render();
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

  addExToWorkout() {
    openPicker(ids => { for (const id of ids) S.active.exercises.push(makeEntry(id, 3)); save(); render(); setTimeout(() => $('#view').scrollTo({ top: 1e6, behavior: 'smooth' }), 50); });
  },
  async exMenu(el) {
    const ei = +el.dataset.ei, w = S.active, e = w.exercises[ei];
    const ets = ['RPE', 'RIR', 'off'].filter(t => t !== e.et);
    const c = await actionSheet([
      { label: 'Move up' }, { label: 'Move down' },
      ...ets.map(t => ({ label: t === 'off' ? 'Hide effort column' : `Use ${t}` })),
      { label: 'Remove exercise', danger: true }], { title: ex(e.exId).name });
    if (c === 0 && ei > 0) [w.exercises[ei - 1], w.exercises[ei]] = [w.exercises[ei], w.exercises[ei - 1]];
    else if (c === 1 && ei < w.exercises.length - 1) [w.exercises[ei + 1], w.exercises[ei]] = [w.exercises[ei], w.exercises[ei + 1]];
    else if (c === 2 || c === 3) e.et = ets[c - 2];
    else if (c === 4) { w.exercises.splice(ei, 1); recomputeRests(w); }
    else return;
    save(); render();
  },
  addSet(el) {
    const e = S.active.exercises[+el.dataset.ei];
    const prev = e.sets[e.sets.length - 1];
    e.sets.push(prev ? newSet(prev.w || prev.pw, prev.r || prev.pr) : newSet());
    save(); render();
  },
  async setMenu(el) {
    const w = S.active, e = w.exercises[+el.dataset.ei], si = +el.dataset.si, s = e.sets[si];
    const c = await actionSheet([{ label: s.warm ? 'Mark as working set' : 'Mark as warm-up' }, { label: 'Delete set', danger: true }]);
    if (c === 0) s.warm = !s.warm;
    else if (c === 1) { e.sets.splice(si, 1); recomputeRests(w); }
    else return;
    markActivePRs(); save(); render();
  },
  toggleSet(el) {
    const w = S.active, e = w.exercises[+el.dataset.ei], s = e.sets[+el.dataset.si];
    if (!s.done) {
      if (s.w === '' && s.pw !== '') s.w = s.pw;
      if (s.r === '' && /^\d+$/.test(s.pr)) s.r = s.pr;
      if (!(num(s.r) > 0)) { toast('Enter reps first'); $(`[data-bind="set:${el.dataset.ei}:${el.dataset.si}:r"]`)?.focus(); return; }
      s.done = true; s.doneAt = Date.now();
    } else { s.done = false; s.doneAt = null; s.isPR = false; }
    recomputeRests(w); markActivePRs(); save(); render();
  },
  async discardWorkout() {
    const nv = VIDS.filter(v => v.workoutId === S.active.id).length;
    if (!await confirmSheet('Discard workout', { title: 'Discard this workout?', msg: 'Nothing from it will be saved' + (nv ? `, including ${nv} video${nv > 1 ? 's' : ''}.` : '.') })) return;
    await deleteVideos(v => v.workoutId === S.active.id);
    S.active = null; save(true); render();
  },
  async finishWorkout() {
    const w = S.active;
    const pending = w.exercises.reduce((n, e) => n + e.sets.filter(s => !s.done && num(s.r) > 0).length, 0);
    const empty = w.exercises.reduce((n, e) => n + e.sets.filter(s => !s.done && !(num(s.r) > 0)).length, 0);
    const msg = [pending ? `${pending} unticked set${pending > 1 ? 's' : ''} with reps will be saved as done.` : '', empty ? `${empty} empty set${empty > 1 ? 's' : ''} will be removed.` : ''].filter(Boolean).join(' ');
    if (!await confirmSheet('Finish workout', { title: 'Finish workout?', msg, danger: false })) return;
    for (const e of w.exercises) {
      for (const s of e.sets) if (!s.done && num(s.r) > 0) { s.done = true; if (s.w === '') s.w = s.pw; }
      e.sets = e.sets.filter(s => s.done && num(s.r) > 0);
      for (const s of e.sets) { delete s.pw; delete s.pr; }
    }
    w.exercises = w.exercises.filter(e => e.sets.length);
    if (!w.exercises.length) {
      if (await confirmSheet('Discard workout', { title: 'No sets logged', msg: 'There is nothing to save. Discard the workout?' })) { await deleteVideos(v => v.workoutId === w.id); S.active = null; save(true); }
      render(); return;
    }
    w.end = Date.now(); recomputeRests(w); markPRs(w);
    delete w.lastDoneAt; delete w.lastLabel;
    S.workouts.push(w); S.active = null; save(true); render();
    const prs = w.exercises.flatMap(e => e.sets.filter(s => s.isPR).map(s => `${ex(e.exId).name}: ${setLabel(s)}`));
    sheet(`<div class="sh-body" style="padding-top:18px"><div class="done-hero"><div class="ok">${I.check}</div><h2>Workout saved</h2><p class="muted">${esc(w.name)} · ${fmtDur(w.end - w.start)}</p></div>
      <div class="stats"><div class="stat"><div class="k">Volume</div><div class="v">${fmtVol(wVolume(w))}</div></div><div class="stat"><div class="k">Working sets</div><div class="v">${wSets(w)}</div></div></div>
      ${prs.length ? `<p class="label">New personal records</p><div class="card">${prs.map(p => `<div>${esc(p)}</div>`).join('')}</div>` : ''}
      <button class="big-btn" data-a="closeSheet">Done</button></div>`);
  },

  openWorkout(el) { push({ v: 'workout', id: el.dataset.id }); },
  histSort(el) { UI.histSort = el.dataset.v; render(); },
  repeatWorkout(el) { const w = S.workouts.find(x => x.id === el.dataset.id); startWorkout(w.name, w.programId, w.exercises.map(e => ({ exId: e.exId, sets: e.sets.filter(s => !s.warm).length || e.sets.length }))); },
  saveAsProgram(el) {
    const w = S.workouts.find(x => x.id === el.dataset.id);
    const p = { id: uid(), name: w.name, items: w.exercises.map(e => ({ id: uid(), exId: e.exId, sets: e.sets.filter(s => !s.warm).length || e.sets.length, reps: '' })) };
    S.programs.push(p); save(); toast('Saved as program');
  },
  async deleteWorkout(el) {
    const w = S.workouts.find(x => x.id === el.dataset.id);
    const nv = VIDS.filter(v => v.workoutId === w.id).length;
    if (!await confirmSheet('Delete workout', { title: 'Delete this workout?', msg: `This can't be undone.${nv ? ` Its ${nv} video${nv > 1 ? 's' : ''} stay in the exercise library.` : ''}` })) return;
    S.workouts = S.workouts.filter(x => x !== w);
    for (const v of VIDS) if (v.workoutId === w.id) { v.workoutId = null; DB.putVideo(v); }
    save(); back();
  },

  openExercise(el) { push({ v: 'exercise', id: el.dataset.id }); },
  exMetric(el) { UI.exMetric = el.dataset.v; render(); },
  exRange(el) { UI.exRange = el.dataset.v; render(); },
  newExLib() { UI.picker = null; openExEdit(); },
  newExPicker() { openExEdit(); },
  editEx(el) { UI.picker = null; openExEdit(el.dataset.id); },
  editCat(el) { UI.edit.cat = el.dataset.c; $$('.chip').forEach(c => c.classList.toggle('on', c === el)); },
  editIcon(el) { UI.edit.icon = el.dataset.k; $$('.icon-cell').forEach(c => c.classList.toggle('on', c === el)); },
  saveEx() {
    const E = UI.edit, name = E.name.trim();
    if (!name) { $('#ex-err').textContent = 'Give the exercise a name'; return; }
    if (S.exercises.some(x => !x.archived && x.id !== E.id && x.name.toLowerCase() === name.toLowerCase())) { $('#ex-err').textContent = 'You already have an exercise with that name'; return; }
    let id = E.id;
    if (id) Object.assign(ex(id), { name, cat: E.cat, icon: E.icon });
    else { id = uid(); S.exercises.push({ id, name, cat: E.cat, icon: E.icon }); }
    save();
    const P = UI.picker; UI.picker = null;
    closeSheet();
    if (P && !E.id) P.onDone([id]); else render();
    toast(E.id ? 'Exercise updated' : 'Exercise created');
  },
  async deleteEx(el) {
    const x = ex(el.dataset.id);
    if (!await confirmSheet('Delete exercise', { title: `Delete “${x.name}”?`, msg: 'It disappears from the library. Logged sets and videos stay in your history.' })) return;
    x.archived = true; save();
    if (UI.stack[UI.tab].at(-1)?.id === x.id) back(); else render();
  },
  pickerToggle(el) {
    const P = UI.picker, id = el.dataset.id, i = P.sel.indexOf(id);
    i < 0 ? P.sel.push(id) : P.sel.splice(i, 1);
    renderPicker();
  },
  pickerAdd() { const P = UI.picker; if (!P.sel.length) { toast('Pick at least one exercise'); return; } UI.picker = null; closeSheet(); P.onDone(P.sel); },

  addVideo(el) {
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

  setEffort(el) { S.settings.effort = el.dataset.v; save(); $$('.sheet .seg button').forEach(b => b.classList.toggle('on', b === el)); },
  exportData,
  importData() { const i = $('#import-in'); i.value = ''; i.click(); },
  async eraseAll() {
    if (!await confirmSheet('Erase everything', { title: 'Erase all data?', msg: 'Every workout, program, bodyweight entry and video on this phone is deleted. Export a backup first if you might want it back.' })) return;
    S = freshState(); await DB.clearVideos(); VIDS = []; save(true);
    UI.stack = { train: [], history: [], library: [], body: [] }; UI.tab = 'train'; render(); toast('All data erased');
  },
};

function markActivePRs() {
  const w = S.active;
  for (const e of w.exercises) {
    const before = bestE1rm(e.exId);
    let best = before;
    for (const s of e.sets.filter(working).sort((a, b) => a.doneAt - b.doneAt)) {
      const v = e1rm(num(s.w) || 0, num(s.r));
      s.isPR = before > 0 && v > best + 1e-9;
      if (v > best) best = v;
    }
    for (const s of e.sets) if (!working(s)) s.isPR = false;
  }
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
      : `<button class="rb" data-a="goWorkout">${icon('barbell', 20)}<span class="rb-k">${esc(w.name)}</span><b data-since="${w.start}"></b><span class="rb-s">In progress</span></button>`;
  }
  rb.classList.remove('hide');
}
function tick() { const now = Date.now(); for (const el of $$('[data-since]')) el.textContent = fmtClock((now - +el.dataset.since) / 1000); }

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const fn = A[el.dataset.a];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('.title-input, .set-row input, .mini')) e.target.blur();
  if (e.key === 'Enter' && e.target.id === 'bw-val') A.logBw();
  if (e.key === 'Escape') closeSheet();
});
document.addEventListener('input', e => {
  const b = e.target.dataset.bind; if (!b) return;
  const v = e.target.value, p = b.split(':');
  if (p[0] === 'set') S.active.exercises[+p[1]].sets[+p[2]][p[3]] = v;
  else if (b === 'active.name') S.active.name = v;
  else if (b === 'active.notes') S.active.notes = v;
  else if (p[0] === 'prog') S.programs.find(x => x.id === p[1]).name = v;
  else if (p[0] === 'pi') { const it = S.programs.find(x => x.id === p[1]).items[+p[2]]; it[p[3]] = p[3] === 'sets' ? (parseInt(v) || '') : v; }
  else if (p[0] === 'wk') S.workouts.find(x => x.id === p[1]).name = v;
  else if (b === 'edit.name') { UI.edit.name = v; $('#ex-err').textContent = ''; return; }
  else if (b === 'libQ') { UI.libQ = v; $('#lib-list').innerHTML = libList(); return; }
  else if (b === 'histQ') { UI.histQ = v; const y = $('#view').scrollTop; const tmp = document.createElement('div'); tmp.innerHTML = vHistory(); $('#hist-list').innerHTML = $('#hist-list', tmp).innerHTML; $('#view').scrollTop = y; return; }
  else if (b === 'pickerQ') { UI.picker.q = v; renderPicker(); return; }
  if (p[0] === 'set' && S.active) { markActivePRs(); }
  save();
});
document.addEventListener('change', e => {
  if (e.target.matches('[data-bind^="set:"]') && S.active) {
    const s = S.active.exercises[+e.target.dataset.bind.split(':')[1]].sets[+e.target.dataset.bind.split(':')[2]];
    if (s.done) { recomputeRests(S.active); render(); }
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
    S = migrate(st); save(true); UI.stack = { train: [], history: [], library: [], body: [] }; render(); toast('Backup imported');
  } catch (err) { toast("That file isn't a Lift Log backup"); }
});
['pointerdown', 'pointermove'].forEach(t => document.addEventListener(t, e => { if (t === 'pointerdown' || e.pointerType === 'mouse' || e.buttons) chartScrub(e); }, { passive: true }));
['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, e => { if (e.pointerType !== 'mouse') $$('svg.chart').forEach(chartEnd); }));
document.addEventListener('pointerout', e => { const s = e.target.closest && e.target.closest('svg.chart'); if (s && !s.contains(e.relatedTarget)) chartEnd(s); });
document.addEventListener('visibilitychange', () => { if (document.hidden && S) save(true); else if (S) tick(); });

/* ---------- boot ---------- */
(async function boot() {
  for (const s of $$('[data-ic]')) { const k = s.dataset.ic; s.outerHTML = UI_ICONS[k] ? svgIcon(UI_ICONS[k], 24) : icon(k, 24); }
  try {
    await DB.open();
    S = migrate((await DB.get('state')) || freshState());
    VIDS = await DB.allVideos();
  } catch (e) {
    S = freshState();
    toast('Storage unavailable — data won’t be kept');
  }
  navigator.storage?.persist?.().catch(() => {});
  render();
  setInterval(tick, 1000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
