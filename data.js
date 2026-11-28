'use strict';
/* Lift Log — data model: default sections and exercises, muscle map, migration from v1, strength maths. */

const APP_VERSION = '3.2';

/* ---------- small helpers shared with app.js ---------- */
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
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------- strength maths ---------- */
// Epley for 2+ reps; a single is exactly what was lifted.
const e1rm = (w, r) => (w > 0 && r > 0) ? (r === 1 ? w : w * (1 + r / 30)) : 0;
// Share of 1RM you can lift for N reps to failure (RTS-style table, 1–12 reps).
const RTS = [1, .955, .922, .892, .863, .837, .811, .786, .762, .739, .707, .68];
function pctFor(n) {
  if (n <= 1) return 1;
  if (n <= 12) { const i = Math.floor(n), f = n - i; return RTS[i - 1] + (i < 12 ? (RTS[i] - RTS[i - 1]) * f : 0); }
  return .68 * (1 + 12 / 30) / (1 + n / 30);
}
// RPE from a set's effort field; RIR is turned into RPE (10 − RIR).
function rpeOf(s) {
  const v = num(s.e);
  if (!isFinite(v)) return NaN;
  if (s.et === 'RPE' && v >= 5 && v <= 10) return v;
  if (s.et === 'RIR' && v >= 0 && v <= 5) return 10 - v;
  return NaN;
}
// 1RM that accounts for how hard the set was: reps + reps left in the tank = reps to failure.
function rpeE1rm(s) {
  const w = num(s.w), r = num(s.r), rpe = rpeOf(s);
  if (!(w > 0 && r > 0 && isFinite(rpe))) return 0;
  return w / pctFor(r + (10 - rpe));
}
function plates(total, bar) {
  let side = (total - bar) / 2;
  if (!(side >= 0)) return null;
  const out = [];
  for (const p of [25, 20, 15, 10, 5, 2.5, 1.25, .5]) while (side >= p - 1e-9) { out.push(p); side -= p; }
  return { out, rest: Math.round(side * 100) / 100 };
}

/* ---------- muscles ---------- */
const MUSCLES = [['chest', 'Chest'], ['fdelt', 'Front delts'], ['sdelt', 'Side delts'], ['rdelt', 'Rear delts'], ['triceps', 'Triceps'], ['biceps', 'Biceps'],
  ['forearms', 'Forearms'], ['lats', 'Lats'], ['traps', 'Upper back & traps'], ['lowback', 'Lower back'], ['abs', 'Abs'], ['glutes', 'Glutes'],
  ['quads', 'Quads'], ['hams', 'Hamstrings'], ['adductors', 'Adductors'], ['calves', 'Calves']];
const MNAME = Object.fromEntries(MUSCLES);
const M = (p, s = '') => ({ p: p.split(' ').filter(Boolean), s: s.split(' ').filter(Boolean) });
const cloneM = m => ({ p: [...(m?.p || [])], s: [...(m?.s || [])] });
// Primary muscles count as 1 set, secondary as ½ set.
const MP = {
  squat: M('quads glutes', 'adductors lowback'), bench: M('chest', 'triceps fdelt'), cgbench: M('chest triceps', 'fdelt'),
  dead: M('glutes hams lowback', 'quads traps forearms'), rdl: M('hams glutes', 'lowback'), ohp: M('fdelt', 'triceps sdelt'),
  row: M('lats traps', 'biceps rdelt'), pull: M('lats', 'biceps traps'), chin: M('lats biceps', 'traps'),
  press: M('chest', 'triceps fdelt'), incline: M('chest fdelt', 'triceps'), shpress: M('fdelt', 'triceps sdelt'),
  legpress: M('quads', 'glutes adductors'), legext: M('quads'), legcurl: M('hams'), hip: M('glutes', 'hams'), calf: M('calves'),
  lat: M('sdelt'), rear: M('rdelt', 'traps'), fly: M('chest', 'fdelt'), curl: M('biceps', 'forearms'), tri: M('triceps'),
  dip: M('chest triceps', 'fdelt'), shrug: M('traps'), backext: M('lowback glutes', 'hams'), abs: M('abs'),
  pullover: M('lats', 'chest triceps'), lunge: M('quads glutes', 'adductors hams'), adduct: M('adductors'), none: M(''),
};
// Fallback muscles for custom exercises, guessed from the icon picked.
const ICON_PRESET = { squat: 'squat', bench: 'bench', deadlift: 'dead', press: 'ohp', row: 'row', dumbbell: 'press', kettlebell: 'hip', pullup: 'pull',
  dip: 'dip', core: 'abs', legext: 'legext', legcurl: 'legcurl', seatedcurl: 'legcurl', pulldown: 'pull', hspulldown: 'pull', latraise: 'lat',
  pecdeck: 'fly', pullover: 'pullover', hacksquat: 'legpress', pendulum: 'legpress', hipthrust: 'hip', calf: 'calf', preacher: 'curl', cablefly: 'fly',
  shrug: 'shrug', backext: 'backext', crunch: 'abs', legpress: 'legpress', chestpress: 'press', shoulderpress: 'shpress', seatedrow: 'row',
  curl: 'curl', pushdown: 'tri', lunge: 'lunge', smith: 'squat' };
const CARDIO_ICONS = new Set(['bike', 'rower', 'treadmill', 'stairs', 'cardio']);

/* ---------- defaults ---------- */
const DEFAULT_SECTIONS = [['sbd', 'SBD'], ['hsm', 'Hammer Strength machines'], ['hsp', 'Hammer Strength plate loaded'], ['cab', 'Cables'],
  ['bar', 'Barbells'], ['db', 'Dumbbells'], ['bw', 'Bodyweight'], ['cardio', 'Cardio'], ['mx', 'Matrix machines']];
// Gym packages: sections that belong to one gym's machines and can be hidden in Settings.
const PACKS = [['powerhouse', 'Powerhouse', 'Hammer Strength machines and plate-loaded'], ['puregym', 'PureGym', 'Matrix machines']];
const SEC_PACK = { 's-hsm': 'powerhouse', 's-hsp': 'powerhouse', 's-mx': 'puregym' };
// [name, section, icon, muscle preset, variation of]
const DX = [
  ['Squat', 'sbd', 'squat', 'squat'], ['Bench Press', 'sbd', 'bench', 'bench'], ['Deadlift', 'sbd', 'deadlift', 'dead'],
  ...['Pause Squat', 'Tempo Squat', 'Pin Squat', 'Box Squat', 'High-Bar Squat', 'Front Squat', 'Safety Bar Squat'].map(n => [n, 'sbd', 'squat', 'squat', 'Squat']),
  ['Close-Grip Bench Press', 'sbd', 'bench', 'cgbench', 'Bench Press'],
  ...['Larsen Press', 'Touch-and-Go Bench', 'Spoto Press', 'Pin Press', 'Feet-Up Bench', 'Wide-Grip Bench'].map(n => [n, 'sbd', 'bench', 'bench', 'Bench Press']),
  ...['Sumo Deadlift', 'Deficit Deadlift', 'Paused Deadlift', 'Block Pull'].map(n => [n, 'sbd', 'deadlift', 'dead', 'Deadlift']),
  ['Romanian Deadlift', 'sbd', 'deadlift', 'rdl', 'Deadlift'], ['Stiff-Leg Deadlift', 'sbd', 'deadlift', 'rdl', 'Deadlift'],

  ['Leg Extension', 'hsm', 'legext', 'legext'], ['Lying Leg Curl', 'hsm', 'legcurl', 'legcurl'], ['Seated Leg Curl', 'hsm', 'seatedcurl', 'legcurl'],
  ['Chest Press', 'hsm', 'chestpress', 'press'], ['Shoulder Press', 'hsm', 'shoulderpress', 'shpress'], ['Machine Lat Pulldown', 'hsm', 'hspulldown', 'pull'],
  ['Seated Row', 'hsm', 'seatedrow', 'row'], ['Pec Deck', 'hsm', 'pecdeck', 'fly'], ['Rear Delt Fly', 'hsm', 'pecdeck', 'rear'],
  ['Seated Lateral Raise', 'hsm', 'latraise', 'lat'], ['Lat Pullover', 'hsm', 'pullover', 'pullover'], ['Hip Adduction', 'hsm', 'machine', 'adduct'],
  ['Calf Raise', 'hsm', 'calf', 'calf'], ['Ab Crunch', 'hsm', 'crunch', 'abs'],

  ['Iso-Lateral Bench Press', 'hsp', 'chestpress', 'press'], ['Iso-Lateral Incline Press', 'hsp', 'chestpress', 'incline'],
  ['Iso-Lateral Decline Press', 'hsp', 'chestpress', 'press'], ['Iso-Lateral Shoulder Press', 'hsp', 'shoulderpress', 'shpress'],
  ['Iso-Lateral Row', 'hsp', 'seatedrow', 'row'], ['Iso-Lateral High Row', 'hsp', 'seatedrow', 'row'], ['Iso-Lateral Low Row', 'hsp', 'seatedrow', 'row'],
  ['Iso-Lateral Front Lat Pulldown', 'hsp', 'hspulldown', 'pull'], ['Iso-Lateral Leg Press', 'hsp', 'legpress', 'legpress'],
  ['V-Squat', 'hsp', 'hacksquat', 'legpress'], ['Hack Squat', 'hsp', 'hacksquat', 'legpress'], ['Pendulum Squat', 'hsp', 'pendulum', 'legpress'],
  ['Belt Squat', 'hsp', 'machine', 'legpress'],

  ['Lat Pulldown', 'cab', 'pulldown', 'pull'], ['Seated Cable Row', 'cab', 'seatedrow', 'row'], ['Triceps Pushdown', 'cab', 'pushdown', 'tri'],
  ['Overhead Triceps Extension', 'cab', 'cable', 'tri'], ['Cable Fly', 'cab', 'cablefly', 'fly'], ['Cable Lateral Raise', 'cab', 'cable', 'lat'],
  ['Face Pull', 'cab', 'cable', 'rear'], ['Cable Curl', 'cab', 'curl', 'curl'],

  ['Overhead Press', 'bar', 'press', 'ohp'], ['Barbell Row', 'bar', 'row', 'row'], ['Hip Thrust', 'bar', 'hipthrust', 'hip'],
  ['Barbell Curl', 'bar', 'curl', 'curl'], ['Barbell Shrug', 'bar', 'shrug', 'shrug'], ['Good Morning', 'bar', 'deadlift', 'rdl'],
  ['Smith Machine Squat', 'bar', 'smith', 'squat'],

  ['Dumbbell Bench Press', 'db', 'dumbbell', 'press'], ['Incline Dumbbell Press', 'db', 'dumbbell', 'incline'], ['Dumbbell Shoulder Press', 'db', 'dumbbell', 'shpress'],
  ['Dumbbell Row', 'db', 'dumbbell', 'row'], ['Lateral Raise', 'db', 'dumbbell', 'lat'], ['Rear Delt Raise', 'db', 'dumbbell', 'rear'],
  ['Dumbbell Curl', 'db', 'curl', 'curl'], ['Hammer Curl', 'db', 'curl', 'curl'], ['Preacher Curl', 'db', 'preacher', 'curl'],
  ['Bulgarian Split Squat', 'db', 'lunge', 'lunge'], ['Dumbbell Shrug', 'db', 'shrug', 'shrug'],

  ['Pull-up', 'bw', 'pullup', 'pull'], ['Chin-up', 'bw', 'pullup', 'chin'], ['Dip', 'bw', 'dip', 'dip'], ['Push-up', 'bw', 'body', 'press'],
  ['Back Extension', 'bw', 'backext', 'backext'], ['Hanging Leg Raise', 'bw', 'pullup', 'abs'], ['Plank', 'bw', 'core', 'abs'], ['Walking Lunge', 'bw', 'lunge', 'lunge'],

  ['Bike', 'cardio', 'bike', 'none'], ['Rower', 'cardio', 'rower', 'none'], ['Treadmill', 'cardio', 'treadmill', 'none'], ['Stair Climber', 'cardio', 'stairs', 'none'],

  // Standard Matrix selectorised lineup (PureGym); a PureGym member can add their gym's extras.
  ...[['Chest Press', 'chestpress', 'press'], ['Converging Chest Press', 'chestpress', 'press'], ['Shoulder Press', 'shoulderpress', 'shpress'],
    ['Pec Fly / Rear Delt', 'pecdeck', 'fly'], ['Lat Pulldown', 'hspulldown', 'pull'], ['Diverging Lat Pulldown', 'hspulldown', 'pull'],
    ['Seated Row', 'seatedrow', 'row'], ['Diverging Seated Row', 'seatedrow', 'row'], ['Leg Press', 'legpress', 'legpress'],
    ['Leg Extension', 'legext', 'legext'], ['Seated Leg Curl', 'seatedcurl', 'legcurl'], ['Prone Leg Curl', 'legcurl', 'legcurl'],
    ['Hip Abductor', 'machine', 'hip'], ['Hip Adductor', 'machine', 'adduct'], ['Glute', 'machine', 'hip'],
    ['Biceps Curl', 'preacher', 'curl'], ['Triceps Extension', 'pushdown', 'tri'], ['Triceps Press', 'dip', 'tri'],
    ['Abdominal', 'crunch', 'abs'], ['Back Extension', 'backext', 'backext'], ['Calf Raise', 'calf', 'calf'],
    ['Assisted Chin / Dip', 'pullup', 'chin']].map(([n, ic, pre]) => ['Matrix ' + n, 'mx', ic, pre]),
];
function defaultExercises() {
  const out = DX.map(([name, sec, ic, pre, parent]) => {
    const x = { id: 'd-' + slug(name), name, sec: 's-' + sec, icon: ic, m: cloneM(MP[pre]) };
    if (sec === 'cardio') x.kind = 'cardio';
    if (parent) x.parent = 'd-' + slug(parent);
    return x;
  });
  return out;
}
const defaultSettings = () => ({ theme: 'auto', effort: 'RPE', defSets: 3, defReps: '', autofill: true, wake: true, bar: 20, sex: '', packs: { powerhouse: true, puregym: false } });
const freshState = () => ({
  v: 3, seen: APP_VERSION,
  sections: DEFAULT_SECTIONS.map(([k, name]) => ({ id: 's-' + k, name, ...(SEC_PACK['s-' + k] ? { pack: SEC_PACK['s-' + k] } : {}) })),
  exercises: defaultExercises(), programs: [], splits: [], workouts: [], body: [], events: [],
  settings: defaultSettings(), active: null,
});

/* ---------- migration ---------- */
function migrate(st) {
  const f = freshState();
  for (const k of ['exercises', 'programs', 'splits', 'workouts', 'body', 'events']) if (!Array.isArray(st[k])) st[k] = f[k];
  st.settings = Object.assign(defaultSettings(), st.settings || {});
  st.settings.packs = Object.assign(defaultSettings().packs, st.settings.packs || {});
  if (st.active === undefined) st.active = null;

  if (!(st.v >= 2)) {
    // v1 → v2: categories become editable sections, SBD gets variations, every exercise gets muscles.
    st.sections = f.sections;
    const CAT = { Barbell: 's-bar', 'Hammer Strength': 's-hsp', Machine: 's-hsm', Dumbbell: 's-db', Cable: 's-cab', Bodyweight: 's-bw' };
    const defs = new Map(f.exercises.map(x => [x.name.toLowerCase(), x]));
    const nameOfDef = id => f.exercises.find(y => y.id === id)?.name;
    for (const x of st.exercises) {
      const d = defs.get(x.name.toLowerCase());
      if (d) {
        x.sec = d.sec; x.icon = d.icon; x.m = cloneM(d.m);
        if (d.kind) x.kind = d.kind;
        x._parent = d.parent ? nameOfDef(d.parent) : '';
      } else {
        x.sec = CAT[x.cat] || ensureOther(st);
        x.m = cloneM(MP[ICON_PRESET[x.icon]] || MP.none);
      }
      delete x.cat;
    }
    const have = new Set(st.exercises.map(x => x.name.toLowerCase()));
    for (const d of f.exercises) if (!have.has(d.name.toLowerCase())) {
      const c = { ...d, m: cloneM(d.m), _parent: d.parent ? nameOfDef(d.parent) : '' };
      delete c.parent; st.exercises.push(c);
    }
    const idByName = new Map(st.exercises.map(x => [x.name.toLowerCase(), x.id]));
    for (const x of st.exercises) if ('_parent' in x) { if (x._parent) x.parent = idByName.get(x._parent.toLowerCase()); delete x._parent; }
    for (const w of [...st.workouts, ...(st.active ? [st.active] : [])]) for (const e of w.exercises) if (e.fold === undefined) e.fold = false;
    st.v = 2;
    st.seen = st.seen || '1';
  }
  if (!Array.isArray(st.sections) || !st.sections.length) st.sections = f.sections;
  if (!(st.v >= 3)) {
    // v2 → v3: gym packages. Tag Hammer Strength sections, add the Matrix section and its exercises.
    for (const s of st.sections) if (SEC_PACK[s.id]) s.pack = SEC_PACK[s.id];
    for (const s of f.sections) if (s.pack && !st.sections.some(x => x.id === s.id)) st.sections.push({ ...s });
    const have = new Set(st.exercises.map(x => x.id));
    for (const d of f.exercises) if (d.sec === 's-mx' && !have.has(d.id)) st.exercises.push({ ...d, m: cloneM(d.m) });
    st.v = 3;
  }
  const secIds = new Set(st.sections.map(s => s.id));
  for (const x of st.exercises) {
    if (!secIds.has(x.sec)) x.sec = st.sections[0].id;
    if (!x.m) x.m = cloneM(MP[ICON_PRESET[x.icon]] || MP.none);
  }
  return st;
}
function ensureOther(st) {
  let s = st.sections.find(x => x.id === 's-other');
  if (!s) { s = { id: 's-other', name: 'Other' }; st.sections.push(s); }
  return s.id;
}
