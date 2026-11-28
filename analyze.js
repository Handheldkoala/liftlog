'use strict';
/* Lift Log — Analyze tab: Progress (in app.js), Analyzer and Ranks. */

const ANA_VIEWS = [['progress', 'Progress'], ['analyzer', 'Analyzer'], ['ranks', 'Ranks']];
function vAnalyze() {
  const v = UI.anaView;
  const body = v === 'ranks' ? ranksPane() : v === 'analyzer' ? analyzerPane() : progressPane();
  return header('Analyze') + `<div class="pad">${seg('anaView', ANA_VIEWS, v, 'top')}${body}</div>`;
}

/* ---------- effort ---------- */
// Sets far from failure build less muscle; RIR 0–3 counts fully, then less and less.
function effortWeight(s, et) {
  const rpe = rpeOf({ e: s.e, et });
  if (!isFinite(rpe)) return 1;
  const rir = 10 - rpe;
  return rir <= 3 ? 1 : rir <= 4 ? .75 : rir <= 5 ? .5 : .25;
}
// Weekly-set zones for the heatmap.
const ZONES = [[0, 'None'], [.1, 'Low'], [4, 'Building'], [10, 'Productive'], [20.5, 'High']];
const zoneOf = v => { let i = 0; while (i + 1 < ZONES.length && v >= ZONES[i + 1][0]) i++; return i; };
const ZONE_OP = [0, .28, .52, .8, 1];

/* ---------- SBD lookups ---------- */
function sbdMains() {
  const mains = S.exercises.filter(x => !x.archived && !x.parent && !isCardio(x));
  const find = re => mains.find(x => x.sec === 's-sbd' && re.test(x.name)) || mains.find(x => re.test(x.name));
  return { s: find(/^(back )?squat$/i) || find(/squat/i), b: find(/^bench( press)?$/i) || find(/bench/i), d: find(/^(conventional )?deadlift$/i) || find(/deadlift/i) };
}
// Best estimated 1RM from sets of 10 reps or fewer (more reps estimate poorly).
function bestRecent(exId, days = 183) {
  const from = Date.now() - days * DAY; let best = null;
  for (const w of S.workouts) if (w.start >= from) for (const e of w.exercises) if (e.exId === exId) for (const s of e.sets) {
    if (!working(s) || num(s.r) > 10) continue;
    const v = e1rm(num(s.w) || 0, num(s.r));
    if (!best || v > best.v) best = { v, s, t: w.start };
  }
  return best;
}
const latestBw = () => { const b = [...S.body].sort((a, c) => c.date - a.date)[0]; return b ? b.kg : 0; };

/* ---------- ranks ---------- */
const DOTS_C = { m: [-0.000001093, 0.0007391293, -0.1918759221, 24.0900756, -307.75076], f: [-0.0000010706, 0.0005158568, -0.1126655495, 13.6175032, -57.96288] };
function dotsDen(bw, sex) { const c = DOTS_C[sex === 'f' ? 'f' : 'm'], x = Math.min(Math.max(bw, 40), sex === 'f' ? 150 : 210); return c[0] * x ** 4 + c[1] * x ** 3 + c[2] * x ** 2 + c[3] * x + c[4]; }
const dots = (kg, bw, sex) => kg * 500 / dotsDen(bw, sex);
// Ten levels, scaled for people training in a normal gym. Level 10 is roughly national-level strength.
const LEVELS = ['Starter', 'Novice', 'Apprentice', 'Regular', 'Solid', 'Strong', 'Powerful', 'Formidable', 'Exceptional', 'Legend'];
const DOTS_AT = [0, 120, 170, 210, 250, 290, 330, 370, 410, 460];
const SHARE = { s: .36, b: .24, d: .40 };   // typical share of the total for each lift
const BW_AT = { s: [0, .5, .75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.6], b: [0, .35, .5, .7, .85, 1, 1.2, 1.4, 1.6, 1.9], d: [0, .6, .9, 1.15, 1.4, 1.7, 2, 2.3, 2.6, 3] };
const BW_F = { s: .75, b: .62, d: .75 };
const LIFT_NAMES = { s: 'Squat', b: 'Bench press', d: 'Deadlift' };

// Thresholds in kg at this bodyweight, so every level reads as "lift X kg".
function kgTable(key, mode, bw, sex) {
  if (mode === 'dots') { const k = dotsDen(bw, sex) / 500; return DOTS_AT.map(d => d * k * (key === 't' ? 1 : SHARE[key])); }
  const t = key === 't' ? BW_AT.s.map((_, i) => ['s', 'b', 'd'].reduce((a, l) => a + BW_AT[l][i] * (sex === 'f' ? BW_F[l] : 1), 0))
    : BW_AT[key].map(v => v * (sex === 'f' ? BW_F[key] : 1));
  return t.map(r => r * bw);
}
function levelAt(kg, table) {
  let i = 0; while (i + 1 < table.length && kg >= table[i + 1]) i++;
  const next = table[i + 1];
  return { i, name: LEVELS[i], frac: next ? (kg - table[i]) / (next - table[i]) : 1, need: next ? next - kg : 0 };
}
function ring(frac, n) {
  const r = 34, c = 2 * Math.PI * r;
  return `<svg class="ring" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="${r}" class="ring-bg"/><circle cx="40" cy="40" r="${r}" class="ring-fg" stroke-dasharray="${(c * Math.max(.02, frac)).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 40 40)"/><text x="40" y="47" text-anchor="middle">${n}</text></svg>`;
}
function ranksPane() {
  const st = S.settings, sex = st.sex, bw = latestBw(), mode = UI.rankMode;
  const sexSeg = `<p class="label">Compared with</p>${seg('setSex', [['m', 'Men'], ['f', 'Women']], sex || '')}`;
  if (!sex) return `<div class="empty">Ranks compare your squat, bench and deadlift with your bodyweight. Pick who to compare with to start.</div>${sexSeg}`;
  if (!bw) return `<div class="empty">Log your bodyweight to see your ranks.<button class="link" data-a="goBody">Log bodyweight</button></div>${sexSeg}`;
  const M = sbdMains(), best = {};
  for (const k of ['s', 'b', 'd']) best[k] = M[k] ? bestRecent(M[k].id) : null;
  if (!best.s && !best.b && !best.d) return `<div class="empty">Log a squat, bench press or deadlift and your ranks show up here.</div>${sexSeg}`;
  const total = ['s', 'b', 'd'].reduce((a, k) => a + (best[k]?.v || 0), 0), full = best.s && best.b && best.d;
  const tt = kgTable('t', mode, bw, sex), L = levelAt(total, tt);
  const score = mode === 'dots' ? `${fmtN(dots(total, bw, sex), 0)} DOTS` : `${fmtN(total / bw, 2)}× bodyweight`;
  const hero = full ? `<div class="card rank-hero">${ring(L.frac, L.i + 1)}<div class="rank-main"><p class="k">Overall</p><p class="rank-name">${L.name}</p>
      <p class="rank-sub">${score} · ${fmtN(total, 0)} kg total</p>
      <p class="rank-next">${L.need ? `+${fmtN(Math.ceil(L.need / 2.5) * 2.5)} kg on your total to reach <b>${LEVELS[L.i + 1]}</b>` : 'Top level — outstanding.'}</p></div></div>`
    : `<div class="empty small">Log all three lifts to get an overall rank.</div>`;
  const rows = ['s', 'b', 'd'].map(k => {
    const b = best[k]; if (!b) return `<div class="row"><span class="row-ic">${icon(M[k]?.icon || 'barbell', 24)}</span><span class="row-main"><span class="row-t">${LIFT_NAMES[k]}</span><span class="row-s">Not logged in the last 6 months</span></span></div>`;
    const l = levelAt(b.v, kgTable(k, mode, bw, sex));
    return `<button class="row rank-row" data-a="openExercise" data-id="${M[k].id}"><span class="row-ic">${icon(M[k].icon, 24)}</span><span class="row-main"><span class="row-t">${LIFT_NAMES[k]}</span>
      <span class="row-s">${fmtN(b.v)} kg est. · ${fmtN(b.v / bw, 2)}× bw${l.need ? ` · +${fmtN(Math.ceil(l.need / 2.5) * 2.5)} kg to ${LEVELS[l.i + 1]}` : ''}</span><span class="lvl-bar"><i style="width:${(l.frac * 100).toFixed(0)}%"></i></span></span>
      <span class="lvl-chip">${l.i + 1} · ${l.name}</span></button>`;
  }).join('');
  const strongest = ['s', 'b', 'd'].filter(k => best[k]).map(k => [k, best[k].v / (kgTable(k, mode, bw, sex)[6] || 1)]).sort((a, c) => c[1] - a[1]);
  const note = full && strongest.length === 3 ? `<p class="muted hint">Your ${LIFT_NAMES[strongest[0][0]].toLowerCase()} is your strongest lift for your size; the ${LIFT_NAMES[strongest[2][0]].toLowerCase()} has the most room to grow.</p>` : '';
  const ladder = tt.map((kg, i) => `<div class="row ladder-row ${i === L.i && full ? 'on' : ''}"><span class="lvl-n">${i + 1}</span><span class="row-main"><span class="row-t">${LEVELS[i]}</span></span><span class="row-v">${i ? fmtN(Math.round(kg / 2.5) * 2.5, 1) + ' kg' : '–'}</span></div>`).join('');
  return `${seg('rankMode', [['dots', 'DOTS'], ['bw', '× Bodyweight']], mode, 'sm')}
    <p class="muted hint">${mode === 'dots' ? 'DOTS evens out bodyweight, so lifters of every size can be compared fairly.' : 'Plain multiples of your bodyweight — simple, but kinder to lighter lifters.'}</p>
    ${hero}<div class="card list">${rows}</div>${note}
    <div class="sec-hd"><h2>Levels</h2><span class="muted small">Total at ${fmtN(bw)} kg</span></div><div class="card list">${ladder}</div>
    <p class="muted hint">Based on your best estimated 1RM from the last 6 months (sets of 10 or fewer reps). Levels are scaled for people who train in a normal gym — level 10 is roughly national-level strength.</p>
    ${sexSeg}`;
}

/* ---------- analyzer ---------- */
const pctTxt = p => { const v = Math.round(p * 1000) / 10; return v > 0 ? `+${v}%` : v < 0 ? `−${-v}%` : 'no change'; };
const round25 = v => Math.floor(v / 2.5 + 1e-9) * 2.5;
function liftTrend(exId) {
  const sess = sessionsFor(exId).filter(x => x.w.start >= Date.now() - 70 * DAY).reverse();   // oldest first
  if (sess.length < 3) return null;
  const pts = sess.map(x => {
    const ws = x.sets.filter(s => !s.warm);
    const v = maxOf(ws, s => rpeE1rm(s) || e1rm(num(s.w) || 0, num(s.r)));
    const rp = ws.map(rpeOf).filter(isFinite);
    return { t: x.w.start, v, rpe: rp.length ? rp.reduce((a, b) => a + b, 0) / rp.length : NaN, ws };
  }).filter(p => p.v > 0);
  if (pts.length < 3) return null;
  const last = pts.slice(-2), before = pts.slice(-5, -2);
  const avg = (a, f) => { const v = a.map(f).filter(isFinite); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN; };
  const lv = avg(last, p => p.v), bv = avg(before, p => p.v), pct = (lv - bv) / bv;
  const lr = avg(last, p => p.rpe), br = avg(before, p => p.rpe);
  const harder = isFinite(lr) && isFinite(br) && lr >= br + .5;
  const tired = pct < -.05 || (pct < -.02 && harder);
  // Next time: same reps as the last top set, aimed at RPE 8.
  const top = pts[pts.length - 1].ws.reduce((m, s) => (!m || (num(s.w) || 0) > (num(m.w) || 0)) ? s : m, null);
  let next = null;
  if (top && num(top.w) > 0) {
    const reps = num(top.r), base = rpeE1rm(top) || e1rm(num(top.w), reps);
    const wt = round25(base * pctFor(reps + 2));
    if (wt > 0) next = { reps, w: tired ? round25(wt * .9) : wt, rpe: tired ? 7 : 8 };
  }
  return { exId, pct, tired, harder, next, n: pts.length };
}
function analyzerPane() {
  if (S.workouts.length < 3) return `<div class="empty">Log a few more workouts and the analyzer can spot trends, fatigue and what to lift next time.</div>`;
  const now = Date.now(), recent = S.workouts.filter(w => w.start >= now - 60 * DAY);
  const counts = {}; for (const w of recent) for (const e of w.exercises) if (!isCardio(ex(e.exId)) && e.sets.some(working)) counts[e.exId] = (counts[e.exId] || 0) + 1;
  const main = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => liftTrend(id)).filter(Boolean);
  // Overall direction
  const avgPct = main.length ? main.reduce((a, t) => a + t.pct, 0) / main.length : 0;
  const dir = avgPct > .01 ? ['up', 'Getting stronger', `Your main lifts are up ${fmtN(avgPct * 100)}% on average over the last few sessions.`]
    : avgPct < -.02 ? ['down', 'Slipping a little', `Your main lifts are down ${fmtN(-avgPct * 100)}% on average. Often that's fatigue, not lost strength.`]
    : ['flat', 'Holding steady', 'Your main lifts are about where they were a few sessions ago.'];
  // Recovery
  const tired = main.filter(t => t.tired);
  const wk = d => S.workouts.filter(w => w.start >= now - d * DAY && w.start < now - (d - 7) * DAY).reduce((a, w) => a + wSets(w), 0);
  const thisWk = wk(7), prevAvg = (wk(14) + wk(21) + wk(28)) / 3, jump = prevAvg > 0 ? thisWk / prevAvg - 1 : 0;
  const fatigue = tired.length >= 2 || (tired.length === 1 && jump > .3);
  const recov = fatigue
    ? `<div class="card ana-card warn"><p class="ana-t">${I.down} Signs of fatigue</p><p class="ana-s">${tired.map(t => esc(ex(t.exId).name)).join(', ')} ${tired.length > 1 ? 'are' : 'is'} going down while sets feel harder${jump > .3 ? `, and you did ${fmtN(jump * 100, 0)}% more sets this week` : ''}. A lighter week — same exercises, about half the sets at RPE 6–7 — usually brings strength back up. Check sleep and food too.</p></div>`
    : `<div class="card ana-card"><p class="ana-t">${I.check} Recovery looks fine</p><p class="ana-s">No lift is dropping while effort climbs.${jump > .3 ? ` You did ${fmtN(jump * 100, 0)}% more sets this week than usual — keep an eye on how the next sessions feel.` : ''}</p></div>`;
  // Next session
  const nexts = main.filter(t => t.next).map(t => hlRow(t.exId, `${t.next.reps} × ${fmtN(t.next.w)}`, `${t.tired ? 'Ease off: ' : ''}aim for RPE ${t.next.rpe} · ${pctTxt(t.pct)} lately`)).join('');
  // Rep ranges and effort, last 30 days
  const sets30 = S.workouts.filter(w => w.start >= now - 30 * DAY).flatMap(w => w.exercises.filter(e => !isCardio(ex(e.exId))).flatMap(e => e.sets.filter(working).map(s => ({ ...s, et: e.et }))));
  const bars = (rows, total) => rows.map(([l, n]) => `<div class="mbar static"><span>${l}</span><span class="bar"><i style="width:${total ? (n / total * 100).toFixed(0) : 0}%"></i></span><b>${total ? fmtN(n / total * 100, 0) : 0}%</b></div>`).join('');
  const rr = [['1–5 reps', s => num(s.r) <= 5], ['6–10 reps', s => num(s.r) >= 6 && num(s.r) <= 10], ['11–15 reps', s => num(s.r) >= 11 && num(s.r) <= 15], ['16+ reps', s => num(s.r) >= 16]].map(([l, f]) => [l, sets30.filter(f).length]);
  const withE = sets30.filter(s => isFinite(rpeOf(s)));
  const er = [['RPE 6 or less', v => v <= 6], ['RPE 7', v => v > 6 && v <= 7.5], ['RPE 8', v => v > 7.5 && v <= 8.5], ['RPE 9', v => v > 8.5 && v <= 9.5], ['RPE 10', v => v > 9.5]].map(([l, f]) => [l, withE.filter(s => f(rpeOf(s))).length]);
  // SBD balance and meet total
  const M = sbdMains(), b = {}; for (const k of ['s', 'b', 'd']) b[k] = M[k] ? bestRecent(M[k].id, 120)?.v : 0;
  let bal = '';
  if (b.s && b.b && b.d) {
    const bs = b.b / b.s, ds = b.d / b.s, tips = [];
    if (bs < .6) tips.push('Bench is low compared with your squat — more pressing volume would help.'); else if (bs > .85) tips.push('Squat is low compared with your bench — more leg work would help.');
    if (ds < 1) tips.push('Deadlift is low compared with your squat — pulls and hinges could use attention.'); else if (ds > 1.35) tips.push('Squat lags your deadlift — squat a bit more often.');
    const bw = latestBw(), sex = S.settings.sex || 'm', tot = b.s + b.b + b.d;
    bal = `<div class="sec-hd"><h2>Big three</h2></div><div class="card ana-card"><p class="ana-t">${I.trophy} Estimated meet total: ${fmtN(Math.round(tot / 2.5) * 2.5)} kg${bw ? ` · ${fmtN(dots(tot, bw, sex), 0)} DOTS` : ''}</p>
      <p class="ana-s">Squat ${fmtN(b.s)} · Bench ${fmtN(b.b)} · Deadlift ${fmtN(b.d)} kg (best estimates, last 4 months). Bench is ${fmtN(bs * 100, 0)}% of your squat and deadlift ${fmtN(ds * 100, 0)}% — typical is 60–85% and 100–135%.</p>
      ${tips.length ? `<p class="ana-s strong">${tips.join(' ')}</p>` : '<p class="ana-s strong">Nicely balanced.</p>'}</div>`;
  }
  return `<div class="card ana-card"><p class="ana-t">${I[dir[0]]} ${dir[1]}</p><p class="ana-s">${dir[2]}</p></div>
    ${recov}
    ${nexts ? `<div class="sec-hd"><h2>Next session</h2></div><div class="card list">${nexts}</div><p class="muted hint">From your last top set and its RPE, aimed at RPE 8 for the same reps.</p>` : ''}
    ${bal}
    <div class="sec-hd"><h2>Consistency</h2></div>${calendar()}
    <div class="sec-hd"><h2>Last 30 days</h2></div>
    <div class="card list">${bars(rr, sets30.length)}</div>
    <div class="card list">${withE.length ? bars(er, withE.length) : '<p class="muted hint" style="padding:12px 16px;margin:0">Log RPE or RIR on your sets to see how hard you train.</p>'}</div>
    <p class="muted hint">${sets30.length} working sets${sets30.length ? `, ${fmtN(withE.length / sets30.length * 100, 0)}% with RPE or RIR` : ''}. Most strength comes from sets at RPE 7–9.</p>`;
}
// Last 16 weeks, one square per day, Monday first.
function calendar() {
  const days = new Set(S.workouts.map(w => isoDay(w.start)));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 15 * 7);
  let cells = '', weeks = 0, streak = 0, counting = true;
  const perWeek = [];
  for (let wk = 0; wk < 16; wk++) {
    let n = 0;
    for (let d = 0; d < 7; d++) {
      const t = new Date(start); t.setDate(start.getDate() + wk * 7 + d);
      const on = days.has(isoDay(t)), fut = t > today; if (on) n++;
      cells += `<i class="${on ? 'on' : ''}${fut ? ' fut' : ''}" style="grid-column:${wk + 1};grid-row:${d + 1}"></i>`;
    }
    perWeek.push(n); if (n) weeks++;
  }
  for (let i = perWeek.length - 1; i >= 0; i--) { if (perWeek[i] >= 2) streak++; else if (i === perWeek.length - 1) continue; else break; }
  const avg = perWeek.slice(-8).reduce((a, b) => a + b, 0) / 8;
  return `<div class="card cal-card"><div class="cal">${cells}</div><p class="muted hint">${fmtN(avg)} workouts a week lately${streak > 1 ? ` · ${streak} weeks in a row with 2 or more` : ''}.</p></div>`;
}

/* ---------- workout overview ---------- */
// Calories: time under load at an effort-based MET, rest at a light MET, plus a little afterburn.
// Based on the Compendium of Physical Activities (resistance training 3.5–6 MET). Roughly ±30%.
function workoutKcal(w) {
  const bw = latestBw() || 80, dur = Math.max(0, (w.end - w.start) / 36e5);
  let work = 0, workMet = 0, cardio = 0;
  for (const e of w.exercises) {
    const x = ex(e.exId);
    for (const s of e.sets.filter(performed)) {
      if (isCardio(x)) { cardio += (num(s.r) || 0) / 60; continue; }
      const t = ((num(s.r) || 0) * 4 + 10) / 3600, rpe = rpeOf({ e: s.e, et: e.et });
      const met = isFinite(rpe) ? Math.min(8, Math.max(4, rpe - 2)) : 5.5;
      work += t; workMet += t * met;
    }
  }
  const rest = Math.max(0, dur - work - cardio);
  return Math.round((workMet + rest * 2 + cardio * 7) * bw * 1.08);
}
function workoutBadges(w) {
  const prior = S.workouts.filter(o => o.start < w.start), out = [];
  let best = null;
  for (const e of w.exercises) {
    const x = ex(e.exId); if (isCardio(x)) continue;
    const ws = e.sets.filter(working); if (!ws.length) continue;
    const name = esc(x.name);
    for (const s of ws) { const v = e1rm(num(s.w) || 0, num(s.r)); if (!best || v > best.v) best = { v, s, x }; }
    const prs = ws.filter(s => s.isPR);
    if (prs.length) out.push(['trophy', 'New est. 1RM', `${name} · ${fmtN(maxOf(prs, s => e1rm(num(s.w) || 0, num(s.r))))} kg`]);
    const before = prior.flatMap(o => o.exercises.filter(y => y.exId === e.exId));
    if (!before.length) { out.push(['plus', 'First time', name]); continue; }
    const topW = maxOf(ws, s => num(s.w) || 0), priorW = maxOf(before.flatMap(y => y.sets.filter(working)), s => num(s.w) || 0);
    if (topW > priorW && topW > 0) out.push(['up', 'Heaviest ever', `${name} · ${fmtN(topW)} kg`]);
    const last = prior.filter(o => o.exercises.some(y => y.exId === e.exId)).sort((a, b) => b.start - a.start)[0];
    const vol = es => es.reduce((a, s) => a + (num(s.w) || 0) * num(s.r), 0);
    const lv = vol(last.exercises.filter(y => y.exId === e.exId).flatMap(y => y.sets.filter(working))), cv = vol(ws);
    if (lv > 0 && cv / lv - 1 >= .1) out.push(['chart', 'More volume', `${name} · +${fmtN((cv / lv - 1) * 100, 0)}% vs last time`]);
  }
  if (best) out.unshift(['barbell', 'Best set', `${esc(best.x.name)} · ${setLabel(best.s)}`]);
  return out.slice(0, 9);
}
function workoutOverview(w) {
  const badges = workoutBadges(w), kcal = workoutKcal(w);
  const heat = muscleSets([w], 'frac'); for (const k in heat) heat[k] *= 2.5;   // one session ≈ a quarter of a week's sets
  return `${badges.length ? `<div class="badges">${badges.map(([ic, t, s]) => `<div class="badge"><span class="b-ic">${ic === 'barbell' ? icon('barbell', 20) : I[ic]}</span><span class="b-t">${t}</span><span class="b-s">${s}</span></div>`).join('')}</div>` : ''}
    <div class="card ov-card"><div class="figs ov-figs">${figure(FIG_FRONT, heat, 'Front')}${figure(FIG_BACK, heat, 'Back')}</div>
    <div class="ov-kcal"><p class="k">Calories</p><p class="v">≈ ${kcal} <small>kcal</small></p><p class="muted">Estimated from time under load, how hard your sets were and your bodyweight. Treat it as a rough guide (±30%).</p></div></div>`;
}

/* ---------- events: injuries, breaks, form changes ---------- */
const EV_KINDS = [['injury', 'Injury'], ['break', 'Break'], ['form', 'Form change'], ['other', 'Other']];
const EV_SCOPES = [['all', 'Everything'], ['upper', 'Upper body'], ['lower', 'Lower body'], ['push', 'Pushing'], ['pull', 'Pulling'], ['muscle', 'A muscle'], ['exercise', 'An exercise']];
const GROUPS = { upper: 'chest fdelt sdelt rdelt triceps biceps forearms lats traps', lower: 'glutes quads hams adductors calves lowback', push: 'chest fdelt sdelt triceps', pull: 'lats traps rdelt biceps forearms' };
// Does an event concern this exercise? With no exercise (bodyweight graph) only "Everything" events count.
function eventHits(ev, exId) {
  if (ev.scope === 'all') return true;
  if (!exId) return false;
  const x = ex(exId);
  if (ev.scope === 'exercise') return ev.ref === exId || familyIds(exId).includes(ev.ref);
  if (ev.scope === 'muscle') return x.m.p.includes(ev.ref);
  const g = GROUPS[ev.scope]; return !!g && x.m.p.some(m => g.split(' ').includes(m));
}
const eventsFor = exId => (S.events || []).filter(ev => eventHits(ev, exId)).sort((a, b) => a.date - b.date);
function evScopeLabel(ev) {
  if (ev.scope === 'exercise') return ex(ev.ref).name;
  if (ev.scope === 'muscle') return MNAME[ev.ref] || 'Muscle';
  return (EV_SCOPES.find(s => s[0] === ev.scope) || ['', ''])[1];
}
function eventRow(ev) {
  return `<button class="row" data-a="editEvent" data-id="${ev.id}"><span class="ev-dot k-${ev.kind}"></span><span class="row-main"><span class="row-t">${esc(ev.title)}</span><span class="row-s">${fmtDate(ev.date, { day: 'numeric', month: 'short', year: 'numeric' })} · ${esc(evScopeLabel(ev))}${ev.note ? ' · ' + esc(ev.note) : ''}</span></span>${I.chevR}</button>`;
}
function eventsCard(list, preset) {
  return `<div class="sec-hd"><h2>Events</h2><button class="link strong" data-a="newEvent" ${preset ? `data-scope="${preset.scope}" data-ref="${preset.ref || ''}"` : ''}>Add</button></div>
    ${list.length ? `<div class="card list">${[...list].reverse().map(eventRow).join('')}</div>` : `<div class="empty small">Mark injuries, breaks or form changes. They show as dots on your graphs.</div>`}`;
}
function evNote(pts, evs) {
  if (pts.length < 2 || !evs.length) return '';
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, inR = evs.filter(e => e.date >= t0 && e.date <= t1);
  return inR.length ? `<p class="ev-note">${inR.slice(-3).map(e => `<span><i class="ev-dot k-${e.kind}"></i>${fmtDate(e.date, { day: 'numeric', month: 'short' })} · ${esc(e.title)}</span>`).join('')}</p>` : '';
}
function openEvent(ev) {
  UI.ev = ev;
  const isNew = !S.events.some(e => e.id === ev.id);
  sheet(`<div class="sh-hd"><button class="link" data-a="closeSheet">Cancel</button><h3>${isNew ? 'New event' : 'Edit event'}</h3><button class="link strong" data-a="saveEvent">Save</button></div><div class="sh-body" id="ev-body"></div>`, { cls: 'full' });
  renderEvent();
}
function renderEvent() {
  const ev = UI.ev, b = $('#ev-body'); if (!b) return;
  const exOpts = S.exercises.filter(x => !x.archived).sort((a, c) => a.name.localeCompare(c.name)).map(x => `<option value="${x.id}" ${x.id === ev.ref ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const mOpts = MUSCLES.map(([k, n]) => `<option value="${k}" ${k === ev.ref ? 'selected' : ''}>${n}</option>`).join('');
  b.innerHTML = `<div class="field"><input id="ev-title" value="${esc(ev.title)}" placeholder="e.g. Tweaked left shoulder" aria-label="Title"></div>
    <p class="label">Type</p><div class="chip-row wrap">${EV_KINDS.map(([k, n]) => `<button class="chip ${ev.kind === k ? 'on' : ''}" data-a="evSet" data-f="kind" data-v="${k}">${n}</button>`).join('')}</div>
    <p class="label">Affects</p><div class="chip-row wrap">${EV_SCOPES.map(([k, n]) => `<button class="chip ${ev.scope === k ? 'on' : ''}" data-a="evSet" data-f="scope" data-v="${k}">${n}</button>`).join('')}</div>
    ${ev.scope === 'exercise' ? `<select class="select" id="ev-ref" aria-label="Exercise">${exOpts}</select>` : ev.scope === 'muscle' ? `<select class="select" id="ev-ref" aria-label="Muscle">${mOpts}</select>` : ''}
    <p class="label">Date</p><div class="field"><input id="ev-date" type="date" value="${isoDay(ev.date)}" max="${isoDay(Date.now())}" aria-label="Date"></div>
    <p class="label">Note</p><textarea class="notes small" id="ev-note" placeholder="Optional">${esc(ev.note || '')}</textarea>
    <p class="err" id="ev-err"></p>
    ${S.events.some(e => e.id === ev.id) ? `<div class="sec-hd"></div><button class="big-btn ghost danger" data-a="delEvent">Delete event</button>` : ''}`;
}
// Keeps what was typed when a chip re-renders the sheet.
function readEventForm() {
  const ev = UI.ev; if (!ev || !$('#ev-title')) return ev;
  ev.title = $('#ev-title').value; ev.note = $('#ev-note').value;
  const d = $('#ev-date').value; if (d) { const [y, m, dd] = d.split('-').map(Number); ev.date = new Date(y, m - 1, dd, 12).getTime(); }
  if ($('#ev-ref')) ev.ref = $('#ev-ref').value;
  return ev;
}
const EV_ACTIONS = {
  newEvent(el) { openEvent({ id: uid(), title: '', kind: 'injury', scope: el.dataset.scope || 'all', ref: el.dataset.ref || '', date: Date.now(), note: '' }); },
  editEvent(el) { const ev = S.events.find(e => e.id === el.dataset.id); if (ev) openEvent({ ...ev }); },
  evSet(el) {
    const ev = readEventForm(); ev[el.dataset.f] = el.dataset.v;
    if (el.dataset.f === 'scope') ev.ref = ev.scope === 'exercise' ? (S.exercises.some(x => x.id === ev.ref) ? ev.ref : S.exercises[0].id) : ev.scope === 'muscle' ? (MNAME[ev.ref] ? ev.ref : 'chest') : '';
    renderEvent();
  },
  saveEvent() {
    const ev = readEventForm();
    if (!ev.title.trim()) { $('#ev-err').textContent = 'Give the event a short title'; return; }
    ev.title = ev.title.trim(); ev.note = ev.note.trim();
    const i = S.events.findIndex(e => e.id === ev.id); if (i >= 0) S.events[i] = ev; else S.events.push(ev);
    save(); closeSheet(); render(); toast('Event saved');
  },
  async delEvent() {
    const id = UI.ev.id; closeSheet(true);
    if (!await confirmSheet('Delete event', { title: 'Delete this event?', msg: 'It disappears from your graphs.' })) return;
    S.events = S.events.filter(e => e.id !== id); save(); render();
  },
};

/* ---------- paste a program as text ---------- */
// Understands lines like "Squat 4x5", "Bench press – 3 × 8-10", "Lat pulldown: 3 sets of 12". Lines such as
// "Day 1 – Push" or "Upper:" start a new day; several days become a split.
function parseProgram(text) {
  const days = []; let cur = null;
  const newDay = name => { cur = { name: name || `Day ${days.length + 1}`, items: [] }; days.push(cur); };
  for (let raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s\-•*·>#]+|\s+$/g, '').replace(/^\d+[.)]\s+/, '');
    if (!line) continue;
    const m = line.match(/^(.+?)[\s:\-–—,]+(\d+)\s*(?:x|×|sets? of|sets? x)\s*(\d+(?:\s*[-–]\s*\d+)?)/i)
      || line.match(/^(.+?)[\s:\-–—,]+(\d+)\s*sets?\b(?:.*?(\d+(?:\s*[-–]\s*\d+)?)\s*reps?)?/i);
    if (m) {
      if (!cur) newDay('');
      cur.items.push({ text: m[1].trim().replace(/[\s:\-–—,]+$/, ''), sets: Math.min(12, parseInt(m[2]) || 3), reps: (m[3] || '').replace(/\s/g, '').replace('–', '-') });
    } else if (line.length <= 40 && !/\d+\s*(x|×)/.test(line)) newDay(line.replace(/[:\s]+$/, ''));
  }
  for (const d of days) for (const it of d.items) it.match = matchExercise(it.text);
  return days.filter(d => d.items.length);
}
function matchExercise(name) {
  const ALIAS = { rdl: 'romanian deadlift', sldl: 'stiff leg deadlift', ohp: 'overhead press', db: 'dumbbell', bb: 'barbell', cgbp: 'close grip bench press', bss: 'bulgarian split squat', ghr: 'glute ham raise' };
  const n = name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').map(w => ALIAS[w] || w).join(' ');
  const live = S.exercises.filter(x => !x.archived && !packOff(x));
  const exact = live.find(x => x.name.toLowerCase() === n); if (exact) return exact;
  const words = n.split(' ').filter(w => w.length > 2 && !['the', 'and', 'with'].includes(w));
  let best = null, bs = 0;
  for (const x of live) {
    const xn = x.name.toLowerCase(), xw = xn.split(/[^a-z0-9]+/);
    const hit = words.filter(w => xw.some(v => v.startsWith(w.slice(0, 5)) || w.startsWith(v.slice(0, 5)))).length;
    // Most of the typed words must match, so "Nordic curl" doesn't become "Cable curl".
    if (!words.length || hit / words.length < .66) continue;
    const sc = hit / Math.max(words.length, xw.length) + (xn.includes(n) || n.includes(xn) ? .5 : 0);
    if (sc > bs) { bs = sc; best = x; }
  }
  return bs >= .5 ? best : null;
}
function openPasteProgram() {
  sheet(`<div class="sh-hd"><button class="link" data-a="closeSheet">Cancel</button><h3>Paste a program</h3><button class="link strong" data-a="createPasted">Create</button></div>
    <div class="sh-body"><textarea class="notes" id="paste-in" rows="8" placeholder="Day 1 – Upper\nBench press 4x5\nBarbell row 4x8\n\nDay 2 – Lower\nSquat 4x5\nRomanian deadlift 3x8-10"></textarea>
    <p class="muted hint">One exercise per line, like “Squat 4x5”. A line without sets, like “Day 2 – Lower”, starts a new day.</p><div id="paste-prev"></div></div>`, { cls: 'full' });
  $('#paste-in').addEventListener('input', previewPaste);
  setTimeout(() => $('#paste-in')?.focus(), 80);
}
function previewPaste() {
  const days = parseProgram($('#paste-in').value); UI.pasted = days;
  $('#paste-prev').innerHTML = days.map(d => `<p class="grp-t">${esc(d.name)}</p><div class="card list">${d.items.map(it => `<div class="row"><span class="row-ic">${icon(it.match ? it.match.icon : 'barbell', 22)}</span><span class="row-main"><span class="row-t">${esc(it.match ? it.match.name : it.text)}</span><span class="row-s">${it.sets} sets${it.reps ? ' × ' + esc(it.reps) : ''}${it.match ? '' : ' · new exercise'}</span></span></div>`).join('')}</div>`).join('');
}
const PASTE_ACTIONS = {
  createPasted() {
    const days = UI.pasted || [];
    if (!days.length) { toast('Paste at least one line like “Squat 4x5”'); return; }
    const sp = days.length > 1 ? { id: uid(), name: 'Pasted split' } : null;
    if (sp) S.splits.push(sp);
    let first = null;
    for (const d of days) {
      const items = d.items.map(it => {
        let x = it.match;
        if (!x) { x = { id: uid(), name: it.text.replace(/\b\w/g, c => c.toUpperCase()), sec: ensureOther(S), icon: 'barbell', m: cloneM(MP.none) }; S.exercises.push(x); it.match = x; }
        return { id: uid(), exId: x.id, sets: it.sets, reps: it.reps };
      });
      const p = { id: uid(), name: d.name, items, ...(sp ? { split: sp.id } : {}) };
      S.programs.push(p); first = first || p;
    }
    save(); closeSheet();
    if (sp) { render(); toast(`${days.length} days added as a split — rename it from its ⋯ menu`); }
    else { UI.stack.train = [{ v: 'program', id: first.id }]; render('push'); toast('Program created'); }
  },
};
