'use strict';
/* Lift Log sync — Google sign-in through Firebase. This phone stays the main copy and works offline;
   changes are sent up and pulled down in the background. Videos never leave the device.
   Cloud layout: users/{uid}/meta/main = exercises, sections, programs, bodyweight, settings
                 users/{uid}/w/{workoutId} = one finished workout (a deleted one keeps a {del:true} marker) */

// The web config is not a secret: access is limited by the Firestore rules (each account reads only its own data).
const FB_CONFIG = {
  apiKey: 'AIzaSyBU10g7hslXAnV0GinIkN2fo5MBvBwHZ1A',
  authDomain: 'liftlog-5baa0.firebaseapp.com',
  projectId: 'liftlog-5baa0',
  storageBucket: 'liftlog-5baa0.firebasestorage.app',
  messagingSenderId: '825907351672',
  appId: '1:825907351672:web:d449d69cf08f89bab15d8d',
};
const FB_V = '11.0.2';

const syncHash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + s.length.toString(36); };
// PR badges are recalculated on each device, so they're left out of what's synced.
const syncJSON = o => JSON.stringify(o, (k, v) => k === 'isPR' ? undefined : v);
const metaOf = st => ({ sections: st.sections, exercises: st.exercises, programs: st.programs, splits: st.splits, body: st.body, events: st.events, settings: Object.assign({}, st.settings, { theme: undefined }) });
function mergeById(remote, local) { const m = new Map(); for (const x of remote || []) m.set(x.id, x); for (const x of local || []) m.set(x.id, x); return [...m.values()]; }

const Sync = {
  rec: null,        // { uid, name, email, hash: {workoutId: hash}, meta: hash, lastPull: ms, at: ms }
  fb: null, loading: null, timer: null, running: false, again: false,
  state: 'idle',    // idle | syncing | error | offline
  err: '',
  get ready() { return !!FB_CONFIG; },
  get on() { return !!this.rec?.uid; },

  async load() { try { this.rec = (await DB.get('sync')) || null; } catch { this.rec = null; } },
  persist() { return DB.set('sync', this.rec).catch(() => {}); },

  sdk() {
    if (!FB_CONFIG) return Promise.reject(new Error('Sync is not set up yet'));
    if (this.fb) return Promise.resolve(this.fb);
    return this.loading ||= (async () => {
      const base = `https://www.gstatic.com/firebasejs/${FB_V}/`;
      const [appM, authM, fs] = await Promise.all(['firebase-app', 'firebase-auth', 'firebase-firestore'].map(n => import(base + n + '.js')));
      const app = appM.initializeApp(FB_CONFIG);
      const auth = authM.getAuth(app);
      await auth.authStateReady();
      this.fb = { authM, fs, auth, db: fs.getFirestore(app) };
      return this.fb;
    })().catch(e => { this.loading = null; throw e; });
  },

  async linked(user) {
    const same = this.rec?.uid === user.uid;
    this.rec = same ? Object.assign(this.rec, { name: user.displayName || '', email: user.email || '' })
      : { uid: user.uid, name: user.displayName || '', email: user.email || '', hash: {}, meta: '', lastPull: 0, at: 0 };
    await this.persist(); refreshAccount();
    this.run(true);
  },
  async signInGoogle() {
    const { authM, auth } = await this.sdk();
    const r = await authM.signInWithPopup(auth, new authM.GoogleAuthProvider());
    await this.linked(r.user);
  },
  async signInEmail(email, pass, create) {
    const { authM, auth } = await this.sdk();
    const r = create ? await authM.createUserWithEmailAndPassword(auth, email, pass) : await authM.signInWithEmailAndPassword(auth, email, pass);
    await this.linked(r.user);
  },
  async signOut() {
    try { const { authM, auth } = await this.sdk(); await authM.signOut(auth); } catch {}
    this.rec = null; this.state = 'idle'; this.err = ''; await DB.set('sync', null).catch(() => {});
  },

  schedule(ms = 5000) { if (!this.on) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), ms); },

  // force: also pull when nothing changed here (app opened, came back online, "Sync now").
  async run(force) {
    if (!this.on || !S) return;
    if (this.running) { this.again = true; return; }
    if (!navigator.onLine) { this.state = 'offline'; refreshAccount(); return; }
    const meta = metaOf(S), mh = syncHash(syncJSON(meta));
    const dirty = mh !== this.rec.meta || S.workouts.some(w => this.rec.hash[w.id] !== syncHash(syncJSON(w))) || Object.keys(this.rec.hash).some(id => !S.workouts.some(w => w.id === id));
    if (!force && !dirty && Date.now() - this.rec.at < 60000) return;
    this.running = true; this.state = 'syncing'; refreshAccount();
    try {
      const { fs, auth, db } = await this.sdk();
      if (!auth.currentUser || auth.currentUser.uid !== this.rec.uid) throw Object.assign(new Error('Signed out — sign in again to keep syncing'), { signedOut: true });
      const R = this.rec, base = `users/${R.uid}`;
      let changed = false;

      // 1. Pull workouts changed elsewhere since the last pull.
      const snap = await fs.getDocs(fs.query(fs.collection(db, base + '/w'), fs.where('ts', '>', fs.Timestamp.fromMillis(R.lastPull))));
      let maxTs = R.lastPull;
      for (const d of snap.docs) {
        const x = d.data(), id = d.id, ts = x.ts?.toMillis?.() || 0;
        if (ts > maxTs) maxTs = ts;
        if (S.active?.id === id || UI.editW === id) continue;
        const i = S.workouts.findIndex(w => w.id === id), local = S.workouts[i];
        const lh = local ? syncHash(syncJSON(local)) : null;
        if (local && R.hash[id] !== undefined && lh !== R.hash[id]) continue;   // edited here too: this phone's version wins
        if (x.del) { if (local) { S.workouts.splice(i, 1); changed = true; } delete R.hash[id]; continue; }
        const rh = syncHash(x.j);
        if (lh === rh) { R.hash[id] = rh; continue; }
        const w = JSON.parse(x.j);
        if (local) S.workouts[i] = w; else S.workouts.push(w);
        R.hash[id] = rh; changed = true;
      }

      // 2. Exercises, programs, bodyweight and settings: one document.
      const mref = fs.doc(db, base + '/meta/main'), md = await fs.getDoc(mref);
      if (md.exists()) {
        const r = md.data();
        if (r.h !== R.meta) {
          const rm = JSON.parse(r.j), localChanged = mh !== R.meta;
          if (!localChanged) Object.assign(S, { sections: rm.sections, exercises: rm.exercises, programs: rm.programs, body: rm.body, events: rm.events || [], splits: rm.splits || [], settings: Object.assign({}, S.settings, rm.settings, { theme: S.settings.theme }) });
          else {   // changed on both sides (or first sign-in on this device): keep everything from both
            S.sections = mergeById(rm.sections, S.sections); S.exercises = mergeById(rm.exercises, S.exercises);
            S.programs = mergeById(rm.programs, S.programs); S.body = mergeById(rm.body, S.body); S.events = mergeById(rm.events, S.events); S.splits = mergeById(rm.splits, S.splits);
          }
          changed = true;
        }
      }
      const nm = syncJSON(metaOf(S)), nh = syncHash(nm);
      if (!md.exists() || md.data().h !== nh) await fs.setDoc(mref, { j: nm, h: nh, ts: fs.serverTimestamp() });
      R.meta = nh;

      // 3. Push workouts finished, edited or deleted on this phone.
      const ops = [];
      for (const w of S.workouts) { const j = syncJSON(w), h = syncHash(j); if (R.hash[w.id] !== h) ops.push([w.id, { j, del: false }, h]); }
      for (const id of Object.keys(R.hash)) if (!S.workouts.some(w => w.id === id)) ops.push([id, { j: '', del: true }, null]);
      for (let k = 0; k < ops.length; k += 400) {
        const b = fs.writeBatch(db);
        for (const [id, data] of ops.slice(k, k + 400)) b.set(fs.doc(db, base + '/w/' + id), Object.assign(data, { ts: fs.serverTimestamp() }));
        await b.commit();
        for (const [id, , h] of ops.slice(k, k + 400)) { if (h) R.hash[id] = h; else delete R.hash[id]; }
      }

      R.lastPull = maxTs; R.at = Date.now(); this.state = 'idle'; this.err = '';
      await this.persist();
      if (changed) {
        recomputeAllPRs(); save(true);
        if (!document.activeElement?.matches?.('#view input, #view textarea')) render();
      }
    } catch (e) {
      this.state = navigator.onLine ? 'error' : 'offline';
      this.err = e.signedOut ? e.message : (e.code === 'permission-denied' ? 'The cloud refused access' : (e.message || 'Sync failed'));
    } finally {
      this.running = false; refreshAccount();
      if (this.again) { this.again = false; this.schedule(1000); }
    }
  },

  async feedback(text, kind) {
    const { fs, db } = await this.sdk();
    await fs.addDoc(fs.collection(db, 'feedback'), { text, kind, v: APP_VERSION, uid: this.rec?.uid || null, ts: fs.serverTimestamp() });
  },

  label() {
    if (!this.on) return 'Your data is only on this phone';
    if (this.state === 'syncing') return 'Syncing…';
    if (this.state === 'offline') return 'Offline — syncs when you’re back online';
    if (this.state === 'error') return this.err;
    return this.rec.at ? 'Synced ' + ago(this.rec.at) : 'Not synced yet';
  },
};

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return fmtDate(t, { day: 'numeric', month: 'short' });
}
// Updates the sync line without re-rendering the whole screen.
function refreshAccount() { for (const el of $$('[data-sync-label]')) { el.textContent = Sync.label(); el.classList.toggle('err', Sync.state === 'error'); } }
