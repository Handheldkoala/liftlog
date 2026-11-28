'use strict';
/* Lift Log video analyzer (experimental). Everything runs on the phone: you tap the plate once, the app follows it
   frame by frame (template matching), works out bar speed per rep from the plate's known size (45 cm), and estimates
   reps in reserve from how fast the last rep moved. Logging RPE on analysed sets calibrates it to you. */

const PLATE_M = .45;                                     // standard 20/25 kg plate diameter
// Typical speed of a true 1RM ("minimal velocity threshold") and how much faster each rep in reserve moves.
const VBT = { squat: { mvt: .30, k: .05 }, bench: { mvt: .17, k: .035 }, deadlift: { mvt: .15, k: .045 }, other: { mvt: .25, k: .05 } };
function liftKind(exId) {
  const n = mainOf(ex(exId)).name.toLowerCase();
  if (/squat|leg press|lunge/.test(n)) return 'squat';
  if (/bench|press|dip|push/.test(n)) return 'bench';
  if (/deadlift|pull|row|rdl|good morning|hip thrust/.test(n)) return 'deadlift';
  return 'other';
}

/* ---------- tracking ---------- */
const TRACK_W = 240;                                         // width of the small frame used for tracking
function grayOf(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
  return g;
}
function cutTemplate(g, w, cx, cy, s) {
  const t = new Float32Array(s * s), x0 = Math.round(cx - s / 2), y0 = Math.round(cy - s / 2);
  let m = 0;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const v = g[(y0 + y) * w + x0 + x] || 0; t[y * s + x] = v; m += v; }
  m /= t.length; let n = 0;
  for (let i = 0; i < t.length; i++) { t[i] -= m; n += t[i] * t[i]; }
  return { t, s, n: Math.sqrt(n) || 1 };
}
// Normalised cross-correlation around (px, py); coarse pass every 2 px, then a fine pass.
function matchAt(g, w, h, T, px, py, R) {
  const { t, s, n } = T, half = s / 2;
  const score = (cx, cy) => {
    const x0 = Math.round(cx - half), y0 = Math.round(cy - half);
    if (x0 < 0 || y0 < 0 || x0 + s > w || y0 + s > h) return -2;
    let m = 0;
    for (let y = 0; y < s; y++) { const o = (y0 + y) * w + x0; for (let x = 0; x < s; x++) m += g[o + x]; }
    m /= s * s;
    let num = 0, den = 0;
    for (let y = 0; y < s; y++) { const o = (y0 + y) * w + x0, q = y * s; for (let x = 0; x < s; x++) { const v = g[o + x] - m; num += v * t[q + x]; den += v * v; } }
    return num / (n * (Math.sqrt(den) || 1));
  };
  let best = { x: px, y: py, c: -2 };
  for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) { const c = score(px + dx, py + dy); if (c > best.c) best = { x: px + dx, y: py + dy, c }; }
  const b0 = { ...best };
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = score(b0.x + dx, b0.y + dy); if (c > best.c) best = { x: b0.x + dx, y: b0.y + dy, c }; }
  return best;
}

/* ---------- maths: reps, speed, RIR ---------- */
// wr: how wide the plate looks compared with its height (1 from the side). Sideways movement shrinks by the same factor.
function analysePath(pts, pxPerM, wr = 1) {
  if (pts.length < 8) return null;
  const sm = pts.map((p, i) => { const a = pts.slice(Math.max(0, i - 2), i + 3); return { t: p.t, x: a.reduce((s, q) => s + q.x, 0) / a.length, y: a.reduce((s, q) => s + q.y, 0) / a.length }; });
  const ym = sm.map(p => p.y / pxPerM), xm = sm.map(p => p.x / pxPerM / Math.max(.3, wr));
  const v = sm.map((p, i) => { const a = sm[Math.max(0, i - 1)], b = sm[Math.min(sm.length - 1, i + 1)]; return b.t > a.t ? -(b.y - a.y) / pxPerM / (b.t - a.t) : 0; });
  // Concentric phases: the bar moving up steadily over at least 12 cm.
  const reps = []; let i = 0;
  while (i < v.length) {
    if (v[i] > .05) {
      let j = i; while (j + 1 < v.length && (v[j + 1] > .02 || (v[j + 2] ?? 0) > .05)) j++;
      const disp = ym[i] - ym[j], dur = sm[j].t - sm[i].t, peak = Math.max(...v.slice(i, j + 1));
      // Time the rep on the raw points, from 5 % to 95 % of the way up (smoothing would stretch it).
      const yb = pts[Math.max(0, i - 2)].y, yt = pts[Math.min(pts.length - 1, j + 2)].y, span = yb - yt;
      let ta = sm[i].t, tb = sm[j].t;
      for (let q = Math.max(0, i - 2); q <= Math.min(pts.length - 1, j + 2); q++) { const f = (yb - pts[q].y) / span; if (f < .05) ta = pts[q].t; if (f < .95) tb = pts[Math.min(pts.length - 1, q + 1)].t; }
      const mcv = tb - ta > .1 ? .9 * span / pxPerM / (tb - ta) : disp / dur;
      if (disp > .12 && dur > .15) reps.push({ mcv, peak, rom: disp, t0: sm[i].t, t1: sm[j].t });
      i = j + 1;
    } else i++;
  }
  const drift = (Math.max(...xm) - Math.min(...xm)) * 100;
  return { reps, drift, path: sm.map(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]) };
}
function vbtCal(mainId) {
  const pts = (S.settings.vbt?.[mainId] || []).slice(-12);
  if (pts.length < 3) return null;
  const mx = pts.reduce((a, p) => a + p.v, 0) / pts.length, my = pts.reduce((a, p) => a + p.rir, 0) / pts.length;
  let sxy = 0, sxx = 0; for (const p of pts) { sxy += (p.v - mx) * (p.rir - my); sxx += (p.v - mx) ** 2; }
  if (sxx < 1e-6) return null;
  const b = sxy / sxx; if (b <= 0) return null;
  return { a: my - b * mx, b, n: pts.length };
}
function estimateRir(exId, reps) {
  if (!reps.length) return null;
  const kind = liftKind(exId), P = VBT[kind], last = reps[reps.length - 1].mcv, cal = vbtCal(mainOf(ex(exId)).id);
  let rir, how;
  if (cal) { rir = cal.a + cal.b * last; how = `calibrated with ${cal.n} of your sets`; }
  else {
    let k = P.k;
    if (reps.length >= 3) { const loss = (reps[0].mcv - last) / (reps.length - 1); if (loss > .005) k = (k + loss) / 2; }
    rir = (last - P.mvt) / k; how = kind === 'other' ? 'general estimate' : `typical ${kind} speeds`;
  }
  rir = Math.max(0, Math.min(8, rir));
  return { rir: Math.round(rir * 2) / 2, how, last, kind };
}

/* ---------- screen ---------- */
let AN = null;
function openAnalyzer(vidId) {
  const v = VIDS.find(x => x.id === vidId); if (!v) return;
  const url = URL.createObjectURL(v.blob);
  AN = { v, url, phase: 'pick', cx: 0, cy: 0, r: 0, wr: 1, mode: S.settings.vbtMode || 'side', pts: [], stop: false };
  sheet(`<div class="sh-hd"><button class="link" data-a="closeSheet">Close</button><h3>Bar path</h3><span></span></div>
    <div class="sh-body vbt"><div class="vbt-stage"><canvas id="vbt-c"></canvas><video id="vbt-v" muted playsinline preload="auto" src="${url}"></video></div>
    <div id="vbt-ui"></div></div>`, { cls: 'full', onClose: () => { if (AN) { AN.stop = true; URL.revokeObjectURL(AN.url); AN = null; } } });
  const vid = $('#vbt-v');
  vid.addEventListener('loadeddata', async () => {
    // Some recordings don't state their length until the end has been seen once.
    if (!isFinite(vid.duration)) { await new Promise(res => { vid.ondurationchange = () => isFinite(vid.duration) && res(); vid.currentTime = 1e7; setTimeout(res, 3000); }); vid.ondurationchange = null; await new Promise(res => { vid.onseeked = res; vid.currentTime = 0; }); vid.onseeked = null; }
    if (!AN) return;
    setupStage(); if (v.analysis) showResult(v.analysis); else pickUI();
  }, { once: true });
  vid.addEventListener('seeked', () => AN && AN.phase === 'pick' && drawFrame());
  vid.load();
}
function setupStage() {
  const vid = $('#vbt-v'), c = $('#vbt-c'), vw = vid.videoWidth, vh = vid.videoHeight;
  const maxW = c.parentElement.clientWidth, maxH = Math.min(innerHeight * .55, 520);
  const k = Math.min(maxW / vw, maxH / vh);
  c.width = Math.round(vw * k); c.height = Math.round(vh * k); c.style.width = c.width + 'px'; c.style.height = c.height + 'px';
  AN.k = k; AN.sk = TRACK_W / vw; AN.sh = Math.round(vh * AN.sk);
  AN.small = document.createElement('canvas'); AN.small.width = TRACK_W; AN.small.height = AN.sh;
  AN.sctx = AN.small.getContext('2d', { willReadFrequently: true });
  if (!AN.r) AN.r = Math.round(c.height / 8);
  c.onpointerdown = e => { if (AN.phase !== 'pick') return; const r = c.getBoundingClientRect(); AN.cx = (e.clientX - r.left) * c.width / r.width; AN.cy = (e.clientY - r.top) * c.height / r.height; drawFrame(); haptic(); pickUI(); };
  drawFrame();
}
function drawFrame(path) {
  const c = $('#vbt-c'), vid = $('#vbt-v'); if (!c || !vid) return;
  const x = c.getContext('2d'); x.drawImage(vid, 0, 0, c.width, c.height);
  const acc = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || '#fff';
  if (AN.phase === 'pick' && AN.cx) { x.strokeStyle = acc; x.lineWidth = 2.5; x.beginPath(); x.ellipse(AN.cx, AN.cy, AN.r * (AN.mode === 'angle' ? AN.wr : 1), AN.r, 0, 0, Math.PI * 2); x.stroke(); x.beginPath(); x.arc(AN.cx, AN.cy, 3, 0, Math.PI * 2); x.fillStyle = acc; x.fill(); }
  const pts = path || AN.pts;
  if (pts.length > 1) {
    const f = AN.k / AN.sk; x.strokeStyle = '#ff9f0a'; x.lineWidth = 3; x.lineJoin = 'round'; x.beginPath();
    pts.forEach((p, i) => { const px = (p.x ?? p[0]) * f, py = (p.y ?? p[1]) * f; i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
  }
}
function pickUI() {
  const vid = $('#vbt-v'), d = vid.duration || 0;
  const ang = AN.mode === 'angle';
  $('#vbt-ui').innerHTML = `${seg('vbtMode', [['side', 'Side view · most accurate'], ['angle', 'Angled · up to 60°']], AN.mode, 'sm')}
    <p class="muted hint">${AN.cx ? `Make the ${ang ? 'oval' : 'circle'} match the plate, then start.` : 'Move to the start of the set, then tap the centre of the plate.'} ${ang ? 'Keep the phone level and still, at roughly the height of the bar. Speed is about 5–10% less precise than from the side.' : 'Film straight from the side with the phone still and the whole plate visible.'}</p>
    <p class="label">Position in video</p><input type="range" class="range" id="vbt-t" min="0" max="${d.toFixed(2)}" step="0.03" value="${vid.currentTime}">
    ${AN.cx ? `<p class="label">Plate ${ang ? 'height' : 'size'}</p><input type="range" class="range" id="vbt-r" min="8" max="${Math.round($('#vbt-c').height / 2.5)}" value="${AN.r}">` : ''}
    ${AN.cx && ang ? `<p class="label">Plate width <span class="muted" id="vbt-ang">${angTxt()}</span></p><input type="range" class="range" id="vbt-w" min="25" max="100" value="${Math.round(AN.wr * 100)}">` : ''}
    <button class="big-btn" data-a="vbtStart" ${AN.cx ? '' : 'disabled'}>Track the bar</button>`;
  $('#vbt-t').oninput = e => { vid.currentTime = +e.target.value; };
  if ($('#vbt-r')) $('#vbt-r').oninput = e => { AN.r = +e.target.value; drawFrame(); };
  if ($('#vbt-w')) $('#vbt-w').oninput = e => { AN.wr = +e.target.value / 100; $('#vbt-ang').textContent = angTxt(); drawFrame(); };
}
async function vbtTrack() {
  const vid = $('#vbt-v'); AN.phase = 'track'; AN.pts = []; AN.stop = false;
  $('#vbt-ui').innerHTML = `<div class="vbt-prog"><i id="vbt-p"></i></div><p class="muted hint center" id="vbt-msg">Following the plate…</p><button class="big-btn ghost" data-a="vbtStop">Stop here</button>`;
  const sc = AN.sk / AN.k, small = AN.sctx;
  const grab = () => { small.drawImage(vid, 0, 0, TRACK_W, AN.sh); return grayOf(small, TRACK_W, AN.sh); };
  let px = AN.cx * sc, py = AN.cy * sc;
  const wr = AN.mode === 'angle' ? AN.wr : 1;
  const side = Math.max(12, Math.min(48, Math.round(AN.r * Math.min(1, wr * 1.3) * sc * 1.6)));
  let g = grab(), T = cutTemplate(g, TRACK_W, px, py, side), lost = 0;
  const T0 = { t: T.t.slice(), s: T.s, n: T.n };
  const t0 = vid.currentTime; AN.pts.push({ t: t0, x: px, y: py });
  AN.pxPerM = (AN.r * 2 * sc) / PLATE_M;
  const step = t => {
    g = grab();
    const R = Math.max(8, Math.round(side * .6));
    // Match against both the first look of the plate (never drifts) and a slowly updated one (handles blur and lighting).
    const m0 = matchAt(g, TRACK_W, AN.sh, T0, px, py, R), m1 = matchAt(g, TRACK_W, AN.sh, T, px, py, R);
    let m = m0.c >= m1.c - .05 ? m0 : m1;
    if (m.c < .5) { const w = matchAt(g, TRACK_W, AN.sh, T0, px, py, side * 3); if (w.c > m.c) m = w; }   // fast move or a skipped frame
    if (m.c < .35) { if (++lost > 6) return false; return true; } lost = 0;
    px = m.x; py = m.y; AN.pts.push({ t, x: px, y: py });
    if (m.c > .75) { const N = cutTemplate(g, TRACK_W, px, py, side); for (let i = 0; i < T.t.length; i++) T.t[i] = T.t[i] * .9 + N.t[i] * .1; let n = 0; for (const v of T.t) n += v * v; T.n = Math.sqrt(n) || 1; }
    drawFrame(); const p = $('#vbt-p'); if (p) p.style.width = `${Math.min(100, (t - t0) / ((vid.duration - t0) || 1) * 100).toFixed(0)}%`;
    return true;
  };
  // Step through the video by seeking: slower than playing but works the same everywhere and never skips frames.
  const dt = 1 / 30;
  for (let t = t0 + dt; t < vid.duration && !AN?.stop; t += dt) {
    await new Promise(res => { vid.onseeked = res; vid.currentTime = t; });
    if (!AN) return;
    if (!step(t)) { $('#vbt-msg') && ($('#vbt-msg').textContent = 'Lost the plate — stopped here.'); break; }
  }
  vid.onseeked = null;
  if (!AN) return;
  finishTrack();
}
async function finishTrack() {
  const wr = AN.mode === 'angle' ? AN.wr : 1;
  const A = analysePath(AN.pts, AN.pxPerM, wr);
  if (!A || !A.reps.length) { AN.phase = 'pick'; AN.pts = []; pickUI(); toast('No reps found — try tapping the plate again'); return; }
  const est = estimateRir(AN.v.exId, A.reps);
  const res = { ...A, est, k: AN.k, sk: AN.sk, at: Date.now(), mode: AN.mode, angle: wr < 1 ? Math.round(Math.acos(wr) * 180 / Math.PI) : 0 };
  AN.v.analysis = res; await DB.putVideo(AN.v).catch(() => {});
  maybeCalibrate(AN.v, res);
  showResult(res);
}
// Find the set this video belongs to and its logged effort.
function setOfVideo(v) {
  const w = S.workouts.find(x => x.id === v.workoutId) || (S.active?.id === v.workoutId ? S.active : null); if (!w) return null;
  for (const e of w.exercises) for (const s of e.sets) if (s.id === v.setId) return { w, e, s };
  return null;
}
function maybeCalibrate(v, res) {
  const f = setOfVideo(v); if (!f || !res.est) return;
  const rpe = rpeOf({ e: f.s.e, et: f.e.et }); if (!isFinite(rpe)) return;
  const id = mainOf(ex(v.exId)).id;
  S.settings.vbt = S.settings.vbt || {};
  const list = (S.settings.vbt[id] = (S.settings.vbt[id] || []).filter(p => p.vid !== v.id));
  list.push({ vid: v.id, v: Math.round(res.est.last * 1000) / 1000, rir: 10 - rpe }); save();
  res.calibrated = true;
}
function showResult(r) {
  AN.phase = 'done'; drawFrame(r.path.map(([x, y]) => ({ x, y })));
  const f = setOfVideo(AN.v), est = r.est, maxV = Math.max(...r.reps.map(x => x.peak), .1);
  const logged = f && isFinite(rpeOf({ e: f.s.e, et: f.e.et }));
  $('#vbt-ui').innerHTML = `${est ? `<div class="card ana-card"><p class="ana-t">${I.target} About ${fmtN(est.rir)} rep${est.rir === 1 ? '' : 's'} in reserve${est.rir <= 4 ? ` · RPE ${fmtN(10 - est.rir)}` : ''}</p>
      <p class="ana-s">Last rep moved at ${fmtN(est.last, 2)} m/s (${est.how}). ${r.mode === 'angle' ? `Filmed at about ${r.angle}°, so speeds are roughly ±10%.` : ''} Treat it as a rough guide.</p></div>` : ''}
    <div class="stats three"><div class="stat"><div class="k">Reps</div><div class="v">${r.reps.length}</div></div>
      <div class="stat"><div class="k">Best rep</div><div class="v">${fmtN(Math.max(...r.reps.map(x => x.mcv)), 2)}</div><div class="d">m/s average</div></div>
      <div class="stat"><div class="k">Bar drift</div><div class="v">${fmtN(r.drift, 0)}</div><div class="d">cm sideways${r.mode === 'angle' ? ', corrected' : ''}</div></div></div>
    <div class="card list">${r.reps.map((x, i) => `<div class="mbar static"><span>Rep ${i + 1}</span><span class="bar"><i style="width:${(x.mcv / maxV * 100).toFixed(0)}%"></i></span><b>${fmtN(x.mcv, 2)}</b></div>`).join('')}</div>
    <p class="muted hint">Average upward speed per rep, in m/s. Speed dropping a lot from the first rep to the last means you were close to failure.${r.calibrated || logged ? ' Your logged RPE on this set was saved to calibrate future estimates.' : ''}</p>
    ${f && !logged && est && est.rir <= 4 ? `<button class="big-btn" data-a="vbtUse">Log RPE ${fmtN(10 - est.rir)} on this set</button>` : ''}
    <button class="big-btn ghost" data-a="vbtAgain">Track again</button>`;
}
function angTxt() {
  const a = Math.round(Math.acos(Math.min(1, AN.wr)) * 180 / Math.PI);
  return `· camera at about ${a}°${a > 60 ? ' — too steep, results will be off' : ''}`;
}
const VBT_ACTIONS = {
  vbtMode(el) { AN.mode = el.dataset.v; S.settings.vbtMode = AN.mode; save(); if (AN.mode === 'side') AN.wr = 1; else if (AN.wr === 1) AN.wr = .7; drawFrame(); pickUI(); },
  vbtOpen(el) { openAnalyzer(el.dataset.id); },
  vbtStart() { vbtTrack(); },
  vbtStop() { if (AN) AN.stop = true; },
  vbtAgain() { AN.phase = 'pick'; AN.pts = []; AN.cx = 0; delete AN.v.analysis; drawFrame(); pickUI(); },
  vbtUse() {
    const f = setOfVideo(AN.v), est = AN.v.analysis?.est; if (!f || !est) return;
    if (f.e.et === 'off') f.e.et = 'RPE';
    f.s.e = String(f.e.et === 'RIR' ? est.rir : 10 - est.rir); save(); toast('Saved on the set'); showResult(AN.v.analysis);
  },
};
