'use strict';
/* RPE / RIR guide: what the numbers mean and how to rate sets consistently. Opened from the ⓘ on the effort column. */

const RPE_SCALE = [
  ['10', '0', 'Max effort', 'No more reps possible, and no more weight either.'],
  ['9.5', '0–1', '', 'No more reps, but a little more weight might have gone up.'],
  ['9', '1', 'Very hard', 'One more rep left, no more.'],
  ['8.5', '1–2', '', 'Definitely one more, maybe two.'],
  ['8', '2', 'Hard', 'Two more reps left.'],
  ['7.5', '2–3', '', 'Two more for sure, maybe three.'],
  ['7', '3', 'Moderate', 'Three more reps left. The bar still moves fast.'],
  ['6', '4+', 'Easy', 'Four or more left. Warm-ups, speed work, light days.'],
];
const RPE_TRY = {
  0: ['That’s RPE 10', 'a true max. If you could have added a little weight, call it 9.5.'],
  1: ['That’s RPE 9 (RIR 1)', 'if you’re unsure between 1 and 2 more, use 8.5.'],
  2: ['That’s RPE 8 (RIR 2)', 'the sweet spot for most heavy work.'],
  3: ['That’s RPE 7 (RIR 3)', 'solid work that still leaves plenty in the tank.'],
  4: ['That’s RPE 6 or lower (RIR 4+)', 'a warm-up or light set.'],
};
function rpeGuide(k, ei) {
  const e = k != null && ei != null ? getW(k)?.exercises[ei] : null;
  UI.rpeTarget = e ? { k, ei } : null;
  const tips = [
    ['timer', 'Rate straight away', 'Log it right after the set, before you rest — memory softens quickly.'],
    ['target', 'Count reps, not pain', 'High-rep sets burn and leave you breathless, but only the reps you had left count. A brutal set of 15 can still be RPE 7.'],
    ['check', 'Clean reps only', 'Count reps you could do with the same technique. A grinder with a broken back angle doesn’t count.'],
    ['chart', 'Watch the bar speed', 'When the last rep clearly slows down you are usually at RPE 8–9. A true grind is 9.5–10. The video analyzer can measure this for you.'],
    ['up', 'Most people guess too low early on', 'Far from failure, people tend to think they have fewer reps left than they really do. Close to failure, guesses get much better.'],
    ['trophy', 'Calibrate now and then', 'Once in a while, take a safe set (a machine, or with a spotter) to true failure. It teaches you what RPE 10 really feels like.'],
  ];
  const aims = [['Heavy squat, bench, deadlift', 'RPE 7–9. Leave a rep or two and keep technique tight.'], ['Accessories and machines', 'RPE 8–10. Safe to push close to failure.'],
    ['Back-off and volume sets', 'RPE 6–8.'], ['Deload or light day', 'RPE 5–6.']];
  sheet(`<div class="sh-hd"><span></span><h3>RPE and RIR</h3><button class="link strong" data-a="closeSheet">Done</button></div>
    <div class="sh-body rpe-g">
    <p class="lead">After a set, ask yourself one question: <b>how many more clean reps could I have done?</b> That number is your <b>RIR</b> (reps in reserve). <b>RPE</b> is the same thing counted from the top: RPE = 10 − RIR.</p>
    <div class="card rpe-q"><p class="k">Try it: I could have done…</p>
      <div class="chip-row wrap">${['0', '1', '2', '3', '4+'].map(n => `<button class="chip" data-a="rpeTry" data-n="${n}">${n} more</button>`).join('')}</div>
      <p class="rpe-ans" id="rpe-ans">Pick one to see the rating.</p></div>
    <div class="card list rpe-tab"><div class="rpe-r hd"><b>RPE</b><b>RIR</b><span>What it feels like</span></div>
      ${RPE_SCALE.map(([r, i, n, d]) => `<div class="rpe-r ${r.includes('.') ? 'half' : ''}"><b>${r}</b><b>${i}</b><span>${n ? `<strong>${n}.</strong> ` : ''}${d}</span></div>`).join('')}</div>
    <div class="sec-hd"><h2>Rating it accurately</h2></div>
    <div class="card list rpe-tips">${tips.map(([ic, t, s]) => `<div class="row"><span class="row-ic">${I[ic]}</span><span class="row-main"><span class="row-t">${t}</span><span class="row-s">${s}</span></span></div>`).join('')}</div>
    <div class="sec-hd"><h2>What to aim for</h2></div>
    <div class="card list rpe-tips">${aims.map(([t, s]) => `<div class="row"><span class="row-main" style="padding-left:16px"><span class="row-t">${t}</span><span class="row-s">${s}</span></span></div>`).join('')}</div>
    ${e ? `<p class="label">${esc(ex(e.exId).name)} uses</p>${seg('rpeEt', [['RPE', 'RPE'], ['RIR', 'RIR'], ['off', 'Off']], e.et)}<p class="muted hint">RPE and RIR mean the same thing — pick whichever feels more natural. Half points like 8.5 are fine.</p>`
      : `<p class="muted hint">Pick RPE or RIR in Settings, or for one exercise by tapping RPE above its sets.</p>`}
    </div>`, { cls: 'full' });
}
const RPE_ACTIONS = {
  rpeGuide(el) { rpeGuide(el.dataset.w ?? null, el.dataset.ei != null ? +el.dataset.ei : null); },
  rpeTry(el) {
    const n = el.dataset.n, [t, s] = RPE_TRY[n === '4+' ? 4 : +n];
    for (const b of el.parentElement.children) b.classList.toggle('on', b === el);
    $('#rpe-ans').innerHTML = `<b>${t}</b> — ${s}`;
    haptic();
  },
  rpeEt(el) {
    const T = UI.rpeTarget; if (!T) return;
    const e = getW(T.k).exercises[T.ei]; e.et = el.dataset.v; save(); render();
    for (const b of el.parentElement.children) { const on = b === el; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
  },
};
