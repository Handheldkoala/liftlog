'use strict';
/* Lift Log social — opt-in. You share a short summary of your training (recent workouts, best lifts, rank) with
   friends you add by code. Only people on your own friends list can read it; your full data stays private.
   Cloud layout: codes/{CODE} = {uid} · profiles/{uid} = summary · profiles/{uid}/friends/{friendUid}
                 profiles/{uid}/likes/{workoutId_likerUid} · requests/{toUid}/in/{fromUid} */

const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const Social = {
  data: null,      // { friends: [{ uid, name, code, ok, p, likes }], requests: [], mine: [] }
  loading: false, err: '',
  get on() { return Sync.on && !!S.settings.social?.code; },
  get name() { return S.settings.social?.name || Sync.rec?.name || 'Lifter'; },

  async fb() { const f = await Sync.sdk(); if (!f.auth.currentUser) throw new Error('Signed out — sign in again'); return f; },
  ref(path) { return this.fb().then(f => f.fs.doc(f.db, path)); },

  async enable(name) {
    const { fs, db } = await this.fb(), uid = Sync.rec.uid;
    let code = '';
    for (let i = 0; i < 8 && !code; i++) {
      const c = Array.from({ length: 6 }, () => CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)]).join('');
      if (!(await fs.getDoc(fs.doc(db, 'codes/' + c))).exists()) code = c;
    }
    if (!code) throw new Error('Could not make a friend code — try again');
    await fs.setDoc(fs.doc(db, 'codes/' + code), { uid });
    S.settings.social = { code, name: name || this.name }; save(true);
    await this.publish(true);
  },
  async disable() {
    const { fs, db } = await this.fb(), uid = Sync.rec.uid, code = S.settings.social?.code;
    if (code) await fs.deleteDoc(fs.doc(db, 'codes/' + code)).catch(() => {});
    await fs.deleteDoc(fs.doc(db, 'profiles/' + uid)).catch(() => {});
    S.settings.social = null; save(true); this.data = null;
  },

  // What friends see. Kept small: no notes, no videos, no bodyweight.
  profile() {
    const ws = [...S.workouts].sort((a, b) => b.start - a.start);
    const M = sbdMains(), best = {};
    for (const k of ['s', 'b', 'd']) { const r = M[k] ? bestRecent(M[k].id) : null; if (r) best[k] = Math.round(r.v * 2) / 2; }
    let rank = null;
    const bw = latestBw(), sex = S.settings.sex;
    if (bw && sex && best.s && best.b && best.d) { const tot = best.s + best.b + best.d, L = levelAt(tot, kgTable('t', 'dots', bw, sex)); rank = { n: L.i + 1, name: L.name, total: Math.round(tot) }; }
    const recent = ws.slice(0, 15).map(w => ({
      id: w.id, name: w.name, start: w.start, dur: w.end - w.start, sets: wSets(w), vol: Math.round(wVolume(w)), prs: wPRs(w),
      lines: w.exercises.filter(e => e.sets.some(working)).slice(0, 5).map(e => {
        const x = ex(e.exId), ss = e.sets.filter(working), cardio = isCardio(x);
        const top = ss.reduce((m, s) => (!m || e1rm(num(s.w) || 0, num(s.r)) > e1rm(num(m.w) || 0, num(m.r))) ? s : m, null);
        return { n: x.name, i: x.icon, s: `${ss.length} × ${setLabel(top, undefined, cardio)}`, pr: ss.some(s => s.isPR) };
      }),
    }));
    const month = ws.filter(w => w.start > Date.now() - 30 * DAY).length;
    return { name: this.name, code: S.settings.social.code, total: ws.length, month, since: ws.length ? ws[ws.length - 1].start : 0, best, rank, recent };
  },
  async publish(force) {
    if (!this.on) return;
    const p = this.profile(), h = syncHash(JSON.stringify(p));
    if (!force && Sync.rec.ph === h) return;
    const { fs, db } = await this.fb();
    await fs.setDoc(fs.doc(db, 'profiles/' + Sync.rec.uid), { ...p, updated: fs.serverTimestamp() });
    Sync.rec.ph = h; Sync.persist();
  },

  async load() {
    if (!this.on || this.loading) return;
    this.loading = true; this.err = '';
    try {
      const { fs, db } = await this.fb(), uid = Sync.rec.uid;
      const [fr, rq, mine] = await Promise.all([
        fs.getDocs(fs.collection(db, `profiles/${uid}/friends`)),
        fs.getDocs(fs.collection(db, `requests/${uid}/in`)),
        fs.getDocs(fs.collection(db, `profiles/${uid}/likes`)),
      ]);
      const friends = await Promise.all(fr.docs.map(async d => {
        const f = { uid: d.id, ...d.data(), ok: false, p: null, likes: [] };
        try {
          const ps = await fs.getDoc(fs.doc(db, 'profiles/' + d.id));
          if (ps.exists()) {
            f.ok = true; f.p = ps.data(); f.name = f.p.name || f.name;
            f.likes = (await fs.getDocs(fs.collection(db, `profiles/${d.id}/likes`))).docs.map(x => x.data());
          }
        } catch { /* not accepted yet */ }
        return f;
      }));
      this.data = { friends, requests: rq.docs.map(d => ({ uid: d.id, ...d.data() })).filter(r => !friends.some(f => f.uid === r.uid && f.ok)),
        mine: mine.docs.map(d => d.data()).sort((a, b) => (b.ts?.toMillis?.() || 0) - (a.ts?.toMillis?.() || 0)) };
      // Someone who added you and whom you already added back: the request is no longer needed.
      for (const r of rq.docs) if (friends.some(f => f.uid === r.id)) fs.deleteDoc(r.ref).catch(() => {});
    } catch (e) { this.err = e.code === 'permission-denied' ? 'The cloud refused access' : (e.message || 'Could not load friends'); }
    this.loading = false;
    if (UI.tab === 'profile' && !document.activeElement?.matches?.('#view input, #view textarea')) render();
  },

  async addByCode(code) {
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) throw new Error('Friend codes have 6 letters and numbers');
    if (code === S.settings.social.code) throw new Error('That’s your own code');
    const { fs, db } = await this.fb(), uid = Sync.rec.uid;
    const c = await fs.getDoc(fs.doc(db, 'codes/' + code));
    if (!c.exists()) throw new Error('No one has that code');
    const fid = c.data().uid;
    await fs.setDoc(fs.doc(db, `profiles/${uid}/friends/${fid}`), { name: '', code, ts: Date.now() });
    await fs.setDoc(fs.doc(db, `requests/${fid}/in/${uid}`), { name: this.name, code: S.settings.social.code, ts: Date.now() });
  },
  async accept(r) {
    const { fs, db } = await this.fb(), uid = Sync.rec.uid;
    await fs.setDoc(fs.doc(db, `profiles/${uid}/friends/${r.uid}`), { name: r.name || '', code: r.code || '', ts: Date.now() });
    await fs.deleteDoc(fs.doc(db, `requests/${uid}/in/${r.uid}`)).catch(() => {});
  },
  async decline(r) { const { fs, db } = await this.fb(); await fs.deleteDoc(fs.doc(db, `requests/${Sync.rec.uid}/in/${r.uid}`)); },
  async remove(fid) {
    const { fs, db } = await this.fb(), uid = Sync.rec.uid;
    await fs.deleteDoc(fs.doc(db, `profiles/${uid}/friends/${fid}`));
    await fs.deleteDoc(fs.doc(db, `requests/${fid}/in/${uid}`)).catch(() => {});
  },
  async like(f, r, on) {
    const { fs, db } = await this.fb(), me = Sync.rec.uid, ref = fs.doc(db, `profiles/${f.uid}/likes/${r.id}_${me}`);
    if (on) await fs.setDoc(ref, { by: me, name: this.name, wid: r.id, wname: r.name, ts: fs.serverTimestamp() });
    else await fs.deleteDoc(ref);
  },
};

/* ---------- views ---------- */
const avatar = (name, cls = '') => `<span class="avatar ${cls}">${esc((name || '?').trim()[0]?.toUpperCase() || '?')}</span>`;
function socialIntro() {
  if (!Sync.ready) return `<div class="empty">Friends aren’t switched on yet.</div>`;
  if (!Sync.on) return `<div class="card soc-intro"><p class="ana-t">${I.person} Train with friends</p><p class="ana-s">Sign in, then add friends with a code to see each other’s workouts and give likes.</p>${signInButtons()}</div>`;
  return `<div class="card soc-intro"><p class="ana-t">${I.person} Train with friends</p>
    <p class="ana-s">Turn on sharing to get a friend code. Friends you add see your recent workouts (exercises and top sets), best squat, bench and deadlift, and your rank — never notes, videos or bodyweight.</p>
    <div class="field" style="margin:12px 0 8px"><input id="soc-name" value="${esc(Social.name)}" placeholder="Your name" aria-label="Name friends see"></div>
    <button class="big-btn" data-a="socEnable">Turn on sharing</button></div>`;
}
function feedItems() {
  const D = Social.data; if (!D) return [];
  return D.friends.filter(f => f.ok && f.p).flatMap(f => (f.p.recent || []).map(r => ({ f, r }))).sort((a, b) => b.r.start - a.r.start).slice(0, 40);
}
function feedCard({ f, r }, me = Sync.rec?.uid) {
  const likes = f.likes.filter(l => l.wid === r.id), liked = likes.some(l => l.by === me);
  return `<div class="card feed">
    <button class="feed-hd" data-a="openFriend" data-id="${f.uid}">${avatar(f.name)}<span class="row-main"><span class="row-t">${esc(f.name)}</span><span class="row-s">${esc(r.name)} · ${ago(r.start)}</span></span></button>
    <p class="feed-sum">${fmtDur(r.dur)} · ${r.sets} sets · ${fmtVol(r.vol)}${r.prs ? ` · <b>${r.prs} PR${r.prs > 1 ? 's' : ''}</b>` : ''}</p>
    <div class="feed-lines">${(r.lines || []).map(l => `<div><span class="row-ic">${icon(l.i, 20)}</span><span>${esc(l.n)}</span><span class="muted">${esc(l.s)}${l.pr ? '<span class="pr">PR</span>' : ''}</span></div>`).join('')}</div>
    <div class="feed-ft"><button class="like ${liked ? 'on' : ''}" data-a="socLike" data-f="${f.uid}" data-w="${r.id}" aria-pressed="${liked}">${svgIcon(UI_ICONS.heart, 20)}<span>${likes.length || ''}</span></button>
      <span class="muted small">${likes.length ? esc(likes.map(l => l.by === me ? 'You' : l.name).slice(0, 3).join(', ')) + (likes.length > 3 ? ` +${likes.length - 3}` : '') : ''}</span></div></div>`;
}
function friendsPane() {
  if (!Social.on) return socialIntro();
  const D = Social.data;
  if (!D && !Social.loading) setTimeout(() => Social.load(), 0);
  const code = S.settings.social.code;
  const reqs = D?.requests || [], friends = D?.friends || [];
  return `<div class="card code-card"><div><p class="k">Your friend code</p><p class="code">${code.slice(0, 3)} ${code.slice(3)}</p></div><button class="pill" data-a="socShare">Share</button></div>
    <div class="add-friend"><div class="field"><input id="add-code" maxlength="8" placeholder="Friend’s code" autocapitalize="characters" autocomplete="off" aria-label="Friend's code" enterkeyhint="go" value="${esc(UI.addCode || '')}"></div><button class="pill" data-a="socAdd">Add</button></div>
    <p class="err" id="add-err"></p>
    ${reqs.length ? `<div class="sec-hd"><h2>Requests</h2></div><div class="card list">${reqs.map(r => `<div class="row">${avatar(r.name)}<span class="row-main"><span class="row-t">${esc(r.name || 'Someone')}</span><span class="row-s">Wants to be friends</span></span>
      <button class="pill" data-a="socAccept" data-id="${r.uid}">Accept</button><button class="link danger small" data-a="socDecline" data-id="${r.uid}">Decline</button></div>`).join('')}</div>` : ''}
    <div class="sec-hd"><h2>Feed</h2>${Social.loading ? '<span class="muted small">Loading…</span>' : `<button class="link" data-a="socRefresh">Refresh</button>`}</div>
    ${Social.err ? `<p class="err">${esc(Social.err)}</p>` : ''}
    ${feedItems().map(x => feedCard(x)).join('') || `<div class="empty">${friends.length ? 'Your friends’ workouts show up here.' : 'Add a friend with their code, or share yours. When they add you back, their workouts show up here.'}</div>`}
    ${friends.length ? `<div class="sec-hd"><h2>Friends</h2></div><div class="card list">${friends.map(f => `<button class="row" data-a="openFriend" data-id="${f.uid}">${avatar(f.name || f.code)}<span class="row-main"><span class="row-t">${esc(f.name || 'Code ' + f.code)}</span><span class="row-s">${f.ok ? `${f.p?.month ?? 0} workouts in the last 30 days${f.p?.rank ? ' · ' + esc(f.p.rank.name) : ''}` : 'Waiting for them to add you back'}</span></span>${I.chevR}</button>`).join('')}</div>` : ''}
    <div class="sec-hd"></div><button class="big-btn ghost" data-a="socSettings">Sharing settings</button>`;
}
function openFriend(fid) {
  const f = Social.data?.friends.find(x => x.uid === fid); if (!f) return;
  const p = f.p;
  sheet(`<div class="sh-hd"><span></span><h3>${esc(f.name || 'Friend')}</h3><button class="link strong" data-a="closeSheet">Done</button></div>
    <div class="sh-body">${!f.ok ? `<div class="empty">${esc(f.name || 'They')} haven’t added you back yet. Once they do, their training shows up here.</div>` : `
      <div class="fr-hd">${avatar(f.name, 'big')}<div><p class="rank-name">${esc(f.name)}</p><p class="rank-sub">${p.total} workouts${p.since ? ' since ' + fmtDate(p.since, { month: 'short', year: 'numeric' }) : ''} · ${p.month} in the last 30 days</p></div></div>
      ${p.rank ? `<div class="card rank-hero">${ring(.5, p.rank.n)}<div class="rank-main"><p class="k">Rank</p><p class="rank-name">${esc(p.rank.name)}</p><p class="rank-sub">${p.rank.total} kg total</p></div></div>` : ''}
      ${p.best && Object.keys(p.best).length ? `<div class="stats three">${['s', 'b', 'd'].map(k => `<div class="stat"><div class="k">${LIFT_NAMES[k]}</div><div class="v">${p.best[k] ? fmtN(p.best[k]) : '–'}</div><div class="d">est. 1RM</div></div>`).join('')}</div>` : ''}
      <div class="sec-hd"><h2>Recent</h2></div>${(p.recent || []).map(r => feedCard({ f, r })).join('') || '<div class="empty">No workouts yet.</div>'}`}
    <div class="sec-hd"></div><button class="big-btn ghost danger" data-a="socRemove" data-id="${f.uid}">Remove friend</button></div>`, { cls: 'full' });
}
// "Me" view: your own profile and highlights.
function mePane() {
  const ws = [...S.workouts].sort((a, b) => b.start - a.start);
  const M = sbdMains(), best = {}; for (const k of ['s', 'b', 'd']) best[k] = M[k] ? bestRecent(M[k].id)?.v : 0;
  const bw = latestBw(), sex = S.settings.sex, tot = (best.s || 0) + (best.b || 0) + (best.d || 0);
  const L = bw && sex && best.s && best.b && best.d ? levelAt(tot, kgTable('t', 'dots', bw, sex)) : null;
  const likes = Social.on && Social.data ? Social.data.mine.slice(0, 5) : [];
  if (Social.on && !Social.data && !Social.loading) setTimeout(() => Social.load(), 0);
  return `${accountPane()}
    ${ws.length ? `<div class="sec-hd"><h2>Highlights</h2></div>
    ${L ? `<button class="card rank-hero" data-a="goRanks">${ring(L.frac, L.i + 1)}<div class="rank-main"><p class="k">Rank</p><p class="rank-name">${L.name}</p><p class="rank-sub">${fmtN(tot, 0)} kg total</p></div></button>` : ''}
    ${best.s || best.b || best.d ? `<div class="stats three">${['s', 'b', 'd'].map(k => `<div class="stat"><div class="k">${LIFT_NAMES[k]}</div><div class="v">${best[k] ? fmtN(best[k], 0) : '–'}</div><div class="d">est. 1RM, kg</div></div>`).join('')}</div>` : ''}
    ${likes.length ? `<div class="card list">${likes.map(l => `<div class="row">${avatar(l.name)}<span class="row-main"><span class="row-t">${esc(l.name)} liked ${esc(l.wname || 'your workout')}</span><span class="row-s">${l.ts?.toMillis ? ago(l.ts.toMillis()) : ''}</span></span><span class="like on">${svgIcon(UI_ICONS.heart, 18)}</span></div>`).join('')}</div>` : ''}
    <div class="sec-hd"><h2>Recent training</h2></div>${ws.slice(0, 3).map(workoutRow).join('')}` : ''}
    ${feedbackCard()}`;
}
const SOCIAL_ACTIONS = {
  async socEnable(el) {
    const n = $('#soc-name')?.value.trim(); if (!n) { $('#soc-name')?.focus(); return; }
    el.disabled = true;
    try { await Social.enable(n); toast('Sharing is on'); Social.load(); render(); }
    catch (e) { toast(e.message || 'Could not turn on sharing'); el.disabled = false; }
  },
  async socShare() {
    const code = S.settings.social.code, text = `Add me on Lift Log — my friend code is ${code}. https://handheldkoala.github.io/liftlog/`;
    try { if (navigator.share) { await navigator.share({ text }); return; } } catch (e) { if (e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast('Copied — paste it to your friend'); } catch { toast('Your code is ' + code); }
  },
  async socAdd(el) {
    const inp = $('#add-code'), err = $('#add-err'); err.textContent = '';
    el.disabled = true;
    try { await Social.addByCode(inp.value); UI.addCode = ''; inp.value = ''; toast('Friend added — they’ll see a request'); await Social.load(); }
    catch (e) { err.textContent = e.code === 'permission-denied' ? 'The cloud refused that — try again' : e.message; }
    el.disabled = false;
  },
  async socAccept(el) { const r = Social.data.requests.find(x => x.uid === el.dataset.id); try { await Social.accept(r); toast('You’re now friends'); Social.load(); } catch (e) { toast(e.message); } },
  async socDecline(el) { const r = Social.data.requests.find(x => x.uid === el.dataset.id); try { await Social.decline(r); Social.data.requests = Social.data.requests.filter(x => x !== r); render(); } catch (e) { toast(e.message); } },
  socRefresh() { Social.load(); render(); },
  openFriend(el) { openFriend(el.dataset.id); },
  async socRemove(el) {
    const f = Social.data.friends.find(x => x.uid === el.dataset.id); closeSheet(true);
    if (!await confirmSheet('Remove friend', { title: `Remove ${f.name || 'this friend'}?`, msg: 'They can no longer see your training, and you stop seeing theirs.' })) return;
    try { await Social.remove(f.uid); Social.data.friends = Social.data.friends.filter(x => x !== f); render(); } catch (e) { toast(e.message); }
  },
  async socLike(el) {
    const f = Social.data.friends.find(x => x.uid === el.dataset.f), r = f?.p?.recent.find(x => x.id === el.dataset.w); if (!r) return;
    const me = Sync.rec.uid, on = !f.likes.some(l => l.wid === r.id && l.by === me);
    f.likes = on ? [...f.likes, { by: me, name: Social.name, wid: r.id }] : f.likes.filter(l => !(l.wid === r.id && l.by === me));
    haptic();
    for (const b of $$(`[data-a="socLike"][data-f="${f.uid}"][data-w="${r.id}"]`)) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); const n = f.likes.filter(l => l.wid === r.id).length; b.querySelector('span').textContent = n || ''; }
    try { await Social.like(f, r, on); } catch (e) { toast('Could not save the like'); Social.load(); }
  },
  async socSettings() {
    const items = [{ label: 'Change my name', run: async () => { const n = await inputSheet('Name friends see', Social.name); if (n) { S.settings.social.name = n; save(); Social.publish(true).catch(() => {}); render(); } } },
      { label: 'Stop sharing', danger: true, run: async () => { if (await confirmSheet('Stop sharing', { title: 'Stop sharing?', msg: 'Your profile and friend code are removed. Friends no longer see your training.' })) { try { await Social.disable(); render(); toast('Sharing is off'); } catch (e) { toast(e.message); } } } }];
    const i = await actionSheet(items); if (i >= 0) items[i].run();
  },
  goRanks() { UI.tab = 'analyze'; UI.anaView = 'ranks'; UI.stack.analyze = []; render(); },
};
