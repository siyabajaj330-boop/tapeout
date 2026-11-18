import DATA from './content.json';
import { FIREBASE_CONFIG } from './firebase-config.js';

const REPO = 'https://github.com/siyabajaj330-boop/tapeout';
const GUEST_KEY = 'tapeout.v0';
const LAST_UID = 'tapeout.lastUid';
const userKey = (uid) => 'tapeout.u.' + uid;
const app = document.getElementById('app');

/* ---------- index ---------- */
const TR = {}, PROB = {};
let LIVE = 0, TOTAL = 0;
DATA.tracks.forEach((t) => {
  t.live = []; t.total = 0;
  t.sections.forEach((s, si) => s.items.forEach((it) => {
    t.total++; TOTAL++;
    if (!it.planned) { t.live.push(it.id); LIVE++; PROB[it.id] = { p: it, t, s, si }; }
  }));
  TR[t.id] = t;
});
const FOLLOWUPS = LIVE * 3;
const TOPICS = DATA.tracks.reduce((n, t) => n + t.sections.length, 0);
const code = (id) => id.toUpperCase();

const LAYOUT = {
  dv: { rows: 6, pos: [[0, 50], [1, 26], [1, 74], [2, 74], [2, 26], [3, 50], [4, 50], [5, 26], [5, 74]],
    edges: [[0, 1], [0, 2], [1, 4], [2, 3], [4, 5], [3, 5], [5, 6], [6, 7], [6, 8]] },
  rtl: { rows: 6, pos: [[0, 50], [1, 26], [1, 74], [2, 26], [3, 50], [4, 26], [4, 74], [2, 74], [5, 50]],
    edges: [[0, 1], [0, 2], [1, 7], [2, 3], [3, 4], [7, 4], [4, 5], [4, 6], [6, 8]] },
  arch: { rows: 5, pos: [[0, 26], [1, 26], [0, 74], [1, 74], [2, 74], [3, 50], [2, 26], [4, 26], [4, 74]],
    edges: [[0, 1], [2, 3], [1, 6], [3, 4], [6, 5], [4, 5], [5, 7], [5, 8], [0, 2]] },
};

/* ---------- progress store ----------
   solved / revealed hold signed timestamps: > 0 means set, < 0 means cleared at |t|.
   Merges keep the newest entry per problem, so devices converge. */
const blank = () => ({ solved: {}, revealed: {}, attempts: {}, hints: {}, rubric: {}, notes: {}, scratch: {}, split: 50 });
function normalize(o) {
  const m = blank();
  if (!o || typeof o !== 'object') return m;
  for (const k of ['solved', 'revealed', 'attempts', 'hints', 'rubric', 'notes', 'scratch']) {
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) {
      for (const [id, v] of Object.entries(o[k])) {
        if (k === 'rubric') { if (Array.isArray(v)) m.rubric[id] = v.map(Boolean).slice(0, 20); }
        else if (k === 'notes' || k === 'scratch') { if (typeof v === 'string') m[k][id] = v.slice(0, 20000); }
        else if (typeof v === 'number' && isFinite(v)) m[k][id] = v;
        else if (v === true) m[k][id] = 1; // older format
      }
    }
  }
  if (typeof o.split === 'number' && o.split >= 30 && o.split <= 70) m.split = o.split;
  return m;
}
function merge(a, b) {
  const m = blank();
  for (const k of ['solved', 'revealed']) {
    for (const id of new Set([...Object.keys(a[k]), ...Object.keys(b[k])])) {
      const x = a[k][id] || 0, y = b[k][id] || 0;
      m[k][id] = Math.abs(x) >= Math.abs(y) ? x : y;
    }
  }
  for (const k of ['attempts', 'hints']) {
    for (const id of new Set([...Object.keys(a[k]), ...Object.keys(b[k])])) m[k][id] = Math.max(a[k][id] || 0, b[k][id] || 0);
  }
  for (const id of new Set([...Object.keys(a.rubric), ...Object.keys(b.rubric)])) {
    const x = a.rubric[id] || [], y = b.rubric[id] || [];
    m.rubric[id] = Array.from({ length: Math.max(x.length, y.length) }, (_, i) => !!(x[i] || y[i]));
  }
  for (const k of ['notes', 'scratch']) m[k] = Object.assign({}, b[k], a[k]);
  m.split = a.split || b.split || 50;
  return m;
}
function readLocal(key) { try { const raw = localStorage.getItem(key); return raw ? normalize(JSON.parse(raw)) : blank(); } catch (e) { return blank(); } }
function writeLocal(key, m) { try { localStorage.setItem(key, JSON.stringify(m)); } catch (e) {} }
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

let ident = null;                 // signed-in user {uid, name, email, photo}
let authState = 'off';            // off | pending | ready
const lastUid = lsGet(LAST_UID);
let M = lastUid ? readLocal(userKey(lastUid)) : readLocal(GUEST_KEY);
if (lastUid && FIREBASE_CONFIG.apiKey) authState = 'pending';

const isSolved = (id) => (M.solved[id] || 0) > 0;
const isRevealed = (id) => (M.revealed[id] || 0) > 0;
const solvedCount = (ids) => ids.filter(isSolved).length;
const allSolved = () => Object.keys(PROB).filter(isSolved).length;

function save() {
  writeLocal(ident ? userKey(ident.uid) : GUEST_KEY, M);
  if (ident) scheduleCloud();
}

/* ---------- cloud sync ---------- */
let cloud = null, cloudTimer = null, notesTimer = null, lastWrite = 0, retry = 0, forceNext = false;
let syncState = 'ok';
const dirtyNotes = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setSync(s) {
  syncState = s;
  const el = document.getElementById('syncline');
  if (el) { el.className = 'sync ' + s; el.lastChild.textContent = syncText(); }
}
function syncText() {
  return syncState === 'busy' ? 'Saving…' : syncState === 'err' ? 'Offline. Will retry automatically' : 'All progress saved to your account';
}
function scheduleCloud() {
  clearTimeout(cloudTimer);
  setSync('busy');
  cloudTimer = setTimeout(pushCloud, 2500);
}
function progressPayload(m) {
  const pick = (o) => Object.fromEntries(Object.entries(o).filter(([id]) => /^(dv|rtl|arch)-[a-z0-9]{2,4}$/.test(id)).slice(0, 400));
  return { solved: pick(m.solved), revealed: pick(m.revealed), attempts: pick(m.attempts), hints: pick(m.hints), rubric: pick(m.rubric), split: Math.round(Math.min(70, Math.max(30, m.split || 50))) };
}
async function pushCloud() {
  cloudTimer = null;
  if (!ident || !cloud) return;
  const uid = ident.uid;
  try {
    let data = M;
    if (!forceNext) {
      const remote = await cloud.loadProgress(uid);
      if (remote) data = merge(M, normalize(remote));
    }
    forceNext = false;
    const wait = 2300 - (Date.now() - lastWrite);
    if (wait > 0) await sleep(wait);
    await cloud.saveProgress(uid, progressPayload(data));
    lastWrite = Date.now();
    retry = 0;
    if (ident && ident.uid === uid) {
      const changed = allSolvedIn(data) !== allSolved();
      M = Object.assign(data, { notes: M.notes, scratch: M.scratch });
      writeLocal(userKey(uid), M);
      if (changed) refreshCounts();
    }
    setSync(cloudTimer ? 'busy' : 'ok');
  } catch (e) {
    setSync('err');
    retry++;
    if (!cloudTimer) cloudTimer = setTimeout(pushCloud, Math.min(60000, 3000 * 2 ** retry));
  }
}
function allSolvedIn(m) { return Object.keys(PROB).filter((id) => (m.solved[id] || 0) > 0).length; }
function scheduleNote(pid) {
  if (!ident) return;
  dirtyNotes.add(pid);
  clearTimeout(notesTimer);
  setSync('busy');
  notesTimer = setTimeout(pushNotes, 2500);
}
async function pushNotes() {
  notesTimer = null;
  if (!ident || !cloud) return;
  const uid = ident.uid;
  for (const pid of [...dirtyNotes]) {
    dirtyNotes.delete(pid);
    try {
      await cloud.saveNote(uid, pid, (M.notes[pid] || '').slice(0, 20000), (M.scratch[pid] || '').slice(0, 20000));
    } catch (e) {
      dirtyNotes.add(pid);
      setSync('err');
      notesTimer = setTimeout(pushNotes, 8000);
      return;
    }
  }
  if (!cloudTimer) setSync('ok');
}
function flushNow() {
  if (cloudTimer) { clearTimeout(cloudTimer); pushCloud(); }
  if (notesTimer) { clearTimeout(notesTimer); pushNotes(); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });

async function bootCloud() {
  if (!FIREBASE_CONFIG.apiKey) { authState = 'off'; return; }
  try {
    cloud = await import('./cloud.js');
    cloud.init(FIREBASE_CONFIG);
  } catch (e) {
    cloud = null; authState = 'off';
    if (ident || lastUid) toast('err', 'Couldn’t reach sign-in. Your progress is still saved in this browser.');
    renderNav();
    return;
  }
  cloud.onUser(async (u) => {
    if (u) await onSignedIn(u);
    else onSignedOut();
  });
}

async function onSignedIn(u) {
  if (ident && ident.uid === u.uid) return;
  ident = u;
  authState = 'ready';
  lsSet(LAST_UID, u.uid);
  const cached = readLocal(userKey(u.uid));
  const guest = readLocal(GUEST_KEY);
  let remote = null, notes = {};
  setSync('busy');
  renderNav();
  try {
    const r = await cloud.loadProgress(u.uid);
    remote = r ? normalize(r) : null;
    notes = await cloud.loadNotes(u.uid);
  } catch (e) {
    toast('err', 'Couldn’t load your saved progress. Working from this browser and retrying in the background.');
  }
  let merged = merge(cached, remote || blank());
  for (const [pid, n] of Object.entries(notes)) {
    if (n && typeof n.text === 'string' && n.text) merged.notes[pid] = n.text.slice(0, 20000);
    if (n && typeof n.scratch === 'string' && n.scratch) merged.scratch[pid] = n.scratch.slice(0, 20000);
  }
  const guestSolved = allSolvedIn(guest);
  const guestHasData = Object.keys(guest.solved).length || Object.keys(guest.notes).length || Object.keys(guest.scratch).length || Object.keys(guest.hints).length;
  if (guestHasData) {
    merged = merge(merged, guest);
    for (const pid of new Set([...Object.keys(guest.notes), ...Object.keys(guest.scratch)])) if (!notes[pid]) dirtyNotes.add(pid);
    lsSet(GUEST_KEY, null);
    if (guestSolved) toast('ok', 'Added ' + guestSolved + ' solved problem' + (guestSolved === 1 ? '' : 's') + ' from this browser to your account.');
  }
  if (!ident || ident.uid !== u.uid) return;
  M = merged;
  writeLocal(userKey(u.uid), M);
  route();
  pushCloud();
  if (dirtyNotes.size) { clearTimeout(notesTimer); notesTimer = setTimeout(pushNotes, 2600); }
}
function onSignedOut() {
  const was = ident;
  ident = null;
  authState = 'ready';
  lsSet(LAST_UID, null);
  clearTimeout(cloudTimer); clearTimeout(notesTimer); cloudTimer = notesTimer = null; dirtyNotes.clear();
  M = readLocal(GUEST_KEY);
  if (was || lastUid) route(); else renderNav();
}
async function doSignIn(btn) {
  if (!cloud) { toast('err', 'Sign-in isn’t available right now. Your progress is still saved in this browser.'); return; }
  if (btn) btn.disabled = true;
  try {
    await cloud.signIn();
  } catch (e) {
    const c = e && e.code;
    if (c === 'auth/popup-blocked') {
      toast('err', 'Your browser blocked the sign-in window. Allow pop-ups for this site, then try again.');
    } else if (c === 'auth/network-request-failed') {
      toast('err', 'Couldn’t reach Google. Check your connection and try again.');
    } else if (c !== 'auth/popup-closed-by-user' && c !== 'auth/cancelled-popup-request') {
      toast('err', 'Sign-in didn’t complete. Please try again.');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}
async function doSignOut() {
  closeMenu();
  if (cloudTimer || notesTimer) {
    clearTimeout(cloudTimer); clearTimeout(notesTimer);
    try { await pushCloud(); await pushNotes(); } catch (e) {}
  }
  try { await cloud.signOutUser(); toast('ok', 'Signed out. Your progress is saved to your account.'); } catch (e) { toast('err', 'Couldn’t sign out. Please try again.'); }
}
async function doDeleteAccount(btn) {
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  const uid = ident && ident.uid;
  try {
    clearTimeout(cloudTimer); clearTimeout(notesTimer); cloudTimer = notesTimer = null; dirtyNotes.clear();
    await cloud.deleteAccount();
    if (uid) lsSet(userKey(uid), null);
    lsSet(LAST_UID, null);
    closeModal();
    toast('ok', 'Your account and all of its data were deleted.');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Delete everything';
    toast('err', 'Couldn’t delete your account. Please try again.');
  }
}

/* ---------- formatting ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => esc(s).replace(/\{\{(.+?)\}\}/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
const KW = new Set(('module endmodule input output inout logic bit int integer real initial begin end fork join join_any join_none ' +
  'class endclass function endfunction task endtask virtual pure extends new rand randc constraint solve before if else ' +
  'case endcase unique default always always_ff always_comb always_latch assign posedge negedge or typedef enum ' +
  'covergroup endgroup coverpoint bins cross ignore_bins illegal_bins binsof intersect property endproperty assert ' +
  'cover disable iff return void this super for while repeat static automatic parameter localparam wire reg string null').split(' '));
const SV_RE = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")|(`[A-Za-z_]\w*)|(\$[A-Za-z_]\w*)|(\d+'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ_]+|#\d+(?:\.\d+)?(?:fs|ps|ns|us|ms|s)?\b|\b\d+(?:\.\d+)?(?:fs|ps|ns|us|ms)?\b)|([A-Za-z_]\w*)/g;
const ASM_RE = /(#[^\n]*)|(^[ \t]*[a-z]+(?=[ \t]))|(\bx\d+\b)|(-?\b\d+\b)/gm;
function hl(src, lang) {
  if (lang === 'text') return esc(src);
  const re = lang === 'asm' ? ASM_RE : SV_RE;
  let out = '', last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    const t = m[0];
    const cls = lang === 'asm'
      ? (m[1] ? 'com' : m[2] ? 'kw' : m[3] ? 'sys' : m[4] ? 'num' : null)
      : (m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'mac' : m[4] ? 'sys' : m[5] ? 'num' : (m[6] && KW.has(t)) ? 'kw' : null);
    out += cls ? '<span class="t-' + cls + '">' + esc(t) + '</span>' : esc(t);
    last = m.index + t.length;
  }
  return out + esc(src.slice(last));
}
const codeBlock = (x, lang) => '<div class="code"><pre><code>' + hl(x, lang || 'sv') + '</code></pre></div>';
const blocks = (arr) => (arr || []).map((b) => {
  if (b.t === 'p') return '<p>' + fmt(b.x) + '</p>';
  if (b.t === 'ul') return '<ul>' + b.x.map((i) => '<li>' + fmt(i) + '</li>').join('') + '</ul>';
  if (b.t === 'code') return codeBlock(b.x, b.lang);
  return '';
}).join('');
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 6 6 6-6 6"/>',
  chevLeft: '<path d="m15 6-6 6 6 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  bulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  doc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  flag: '<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  github: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3.1-.3 6.4-1.5 6.4-6.9A5.4 5.4 0 0 0 20 4.8 5 5 0 0 0 19.9 1S18.7.7 16 2.5a13.4 13.4 0 0 0-7 0C6.3.7 5.1 1 5.1 1A5 5 0 0 0 5 4.8a5.4 5.4 0 0 0-1.5 3.8c0 5.4 3.3 6.6 6.4 6.9a3.4 3.4 0 0 0-.9 2.6V22"/>',
  sim: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 14V9h3v5h3V9h4"/>',
};
const icon = (n, cls) => '<svg class="ic ' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[n] + '</svg>';
const GOOGLE_G = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.5 0 20.1 0 24s1 7.5 2.7 10.7l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
function ring(done, total) {
  const r = 8, c = 2 * Math.PI * r, off = c * (1 - (total ? done / total : 0));
  return '<svg class="ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="bg" cx="10" cy="10" r="' + r + '"/><circle class="fg" cx="10" cy="10" r="' + r + '" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '"/></svg>';
}
const pct = (a, b) => (b ? Math.round(100 * a / b) : 0);
const lvl = (l) => String(l).toLowerCase();

/* ---------- waveform ---------- */
function waveSVG(w, opts = {}) {
  const L = 64, W = 54, H = 32, top = 26, N = w.cycles;
  const rows = [{ name: 'clk', clk: true }].concat(w.signals);
  if (opts.resultRow) rows.push({ name: 'assert', result: true });
  const width = L + N * W + 10, height = top + rows.length * H + 4;
  const xs = (k) => L + (k - 0.5) * W;
  let s = '<svg class="wave" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + esc(opts.label || 'Timing diagram') + '">';
  for (let k = 1; k <= N; k++) {
    const x = xs(k);
    s += '<text class="w-cyc" x="' + x + '" y="14" text-anchor="middle">' + k + '</text><line class="w-grid" x1="' + x + '" y1="20" x2="' + x + '" y2="' + (height - 4) + '"/>';
  }
  rows.forEach((r, i) => {
    const y0 = top + i * H, hi = y0 + 6, lo = y0 + H - 8, mid = (hi + lo) / 2;
    let d;
    s += '<text class="w-name" x="' + (L - 12) + '" y="' + (mid + 4) + '" text-anchor="end">' + esc(r.name) + '</text>';
    if (r.clk) {
      d = 'M' + L + ',' + lo;
      for (let k = 1; k <= N; k++) { const xe = xs(k); d += ' H' + xe + ' V' + hi + ' H' + (xe + W / 2) + ' V' + lo; }
      s += '<path class="w-clk" d="' + d + '"/>';
    } else if (r.result) {
      if (opts.marks) {
        opts.marks.forEach((mk) => {
          const mx = xs(mk.cycle);
          s += '<g class="w-mark ' + mk.kind + '"><rect x="' + (mx - 18) + '" y="' + (mid - 9) + '" width="36" height="18" rx="9"/><text x="' + mx + '" y="' + (mid + 3.5) + '" text-anchor="middle">' + esc(mk.label) + '</text></g>';
        });
      } else s += '<text class="w-q" x="' + (L + 6) + '" y="' + (mid + 4) + '">solve to see results</text>';
    } else {
      const v = r.values, yv = (c) => (c === '1' ? hi : lo);
      d = 'M' + L + ',' + yv(v[0]);
      for (let k = 1; k < N; k++) { const b = L + k * W; if (v[k] !== v[k - 1]) d += ' H' + (b - 3) + ' L' + (b + 3) + ',' + yv(v[k]); }
      d += ' H' + (L + N * W);
      s += '<path class="w-sig" d="' + d + '"/>';
    }
  });
  return s + '</svg>';
}

/* ---------- toasts, modal, menu ---------- */
function toast(kind, text) {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = icon(kind === 'err' ? 'xCircle' : kind === 'ok' ? 'checkCircle' : 'help') + '<span></span>';
  el.lastChild.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}
function openModal(html) {
  let w = document.getElementById('modal');
  if (!w) { w = document.createElement('div'); w.id = 'modal'; w.className = 'modal-wrap'; document.body.appendChild(w); }
  w.innerHTML = '<div class="scrim" data-act="modal-close"></div><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-t">' + html + '</div>';
  w.hidden = false;
  const b = w.querySelector('[data-act="modal-close"].btn');
  if (b) b.focus();
}
function closeModal() { const w = document.getElementById('modal'); if (w) w.hidden = true; }
function closeMenu() { const m = document.getElementById('acctmenu'); if (m) { m.hidden = true; const b = document.getElementById('acctbtn'); if (b) b.setAttribute('aria-expanded', 'false'); } }

/* ---------- shell ---------- */
let navActive = 'home';
function renderNav() {
  const a = navActive;
  document.getElementById('links').innerHTML =
    '<a href="#practice"' + (a === 'practice' ? ' aria-current="page"' : '') + '>Practice</a>' +
    '<a href="#roadmap"' + (a === 'roadmap' ? ' aria-current="page"' : '') + '>Roadmap</a>' +
    '<a href="#about"' + (a === 'about' ? ' aria-current="page"' : '') + '>About</a>';
  const n = allSolved();
  let h = '<a class="solvedpill" href="#practice" title="Problems solved">' + ring(n, LIVE) + '<b>' + n + '</b><span class="lbl">/ ' + LIVE + ' solved</span></a>';
  if (authState === 'pending' && !ident) h += '<span class="avatar ph" aria-label="Loading account"></span>';
  else if (ident) {
    const initials = (ident.name || ident.email || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
    const photo = /^https:\/\/lh3\.googleusercontent\.com\//.test(ident.photo) ? '<img src="' + esc(ident.photo) + '" alt="" referrerpolicy="no-referrer">' : esc(initials);
    h += '<div class="acct"><button class="avatar" id="acctbtn" data-act="menu" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">' + photo + '</button>' +
      '<div class="menu" id="acctmenu" role="menu" hidden><div class="menu-id"><b>' + esc(ident.name || 'Signed in') + '</b><span>' + esc(ident.email) + '</span>' +
      '<div class="sync ' + syncState + '" id="syncline"><i></i><span>' + esc(syncText()) + '</span></div></div>' +
      '<a role="menuitem" href="#practice">' + icon('list') + 'My progress</a>' +
      '<a role="menuitem" href="#privacy">' + icon('shield') + 'Privacy</a><hr>' +
      '<button role="menuitem" data-act="signout">' + icon('logout') + 'Sign out</button>' +
      '<button role="menuitem" class="danger" data-act="delete">' + icon('trash') + 'Delete account and data</button></div></div>';
  } else if (cloud || (FIREBASE_CONFIG.apiKey && authState !== 'off')) {
    h += '<button class="signin" data-act="signin">' + GOOGLE_G + '<span>Sign in</span></button>';
  }
  document.getElementById('navr').innerHTML = h;
}
function refreshCounts() { renderNav(); }
function shell(active, wsMode) {
  document.body.classList.toggle('ws-mode', !!wsMode);
  navActive = active;
  renderNav();
}
function footer() {
  return '<footer class="foot"><div class="foot-in container"><span>© 2026 Tapeout · Built by Siya Bajaj</span>' +
    '<nav aria-label="Footer"><a href="#practice">Practice</a><a href="#roadmap">Roadmap</a><a href="#about">About</a><a href="#privacy">Privacy</a><a href="' + REPO + '/issues" target="_blank" rel="noopener">Report an issue</a></nav>' +
    '<span id="resetbox">' + (ident ? 'Progress syncs to your account.' : 'Progress is saved in this browser.') + ' <button class="linkbtn" data-act="reset">Reset progress</button></span></div></footer>';
}
const statusIcon = (id, planned) => planned
  ? '<span class="st-lock" title="Coming soon">' + icon('lock') + '</span>'
  : (isSolved(id) ? '<span class="st-done" title="Solved">' + icon('checkCircle') + '</span>' : '<span class="st-todo" title="Not solved">' + icon('circle') + '</span>');
function row(it, withKind = true) {
  const kind = withKind ? '<td class="c-k">' + esc(it.kind) + '</td>' : '';
  if (it.planned) {
    return '<tr class="soon"><td class="c-st">' + statusIcon(it.id, true) + '</td><td>' + esc(it.title) + '<span class="soon-tag">Soon</span></td>' + kind +
      '<td class="c-d"><span class="diff ' + lvl(it.level) + '">' + esc(it.level) + '</span></td></tr>';
  }
  return '<tr class="prow" data-href="#' + it.id + '"><td class="c-st">' + statusIcon(it.id) + '</td><td><a href="#' + it.id + '">' + esc(it.title) + '</a></td>' + kind +
    '<td class="c-d"><span class="diff ' + lvl(it.level) + '">' + esc(it.level) + '</span></td></tr>';
}
function nextUp(t) { for (const id of t.live) if (!isSolved(id)) return id; return t.live[0]; }
const signInAvailable = () => !!(cloud || FIREBASE_CONFIG.apiKey);

/* ---------- landing ---------- */
function renderHome() {
  shell('home');
  document.title = 'Tapeout: hardware interview prep for new grads';
  const hero = PROB['dv-06'] && PROB['dv-06'].p;
  let h = '<section class="hero"><div class="container hero-grid"><div>';
  h += '<span class="badge">' + icon('zap') + 'Early access · ' + LIVE + ' problems live</span>';
  h += '<h1>Hardware interview prep, finally structured.</h1>';
  h += '<p class="sub">Curated problem lists for design verification, RTL design and computer architecture interviews. Every problem gives instant feedback, hints when you’re stuck, a worked solution, and the follow-up questions interviewers ask next.</p>';
  h += '<div class="cta"><a class="btn btn-primary" href="#' + (allSolved() ? nextUp(TR.dv) : 'practice') + '">' + (allSolved() ? 'Continue practicing' : 'Start practicing') + icon('arrowRight') + '</a><a class="btn btn-secondary" href="#roadmap">View roadmap</a></div>';
  h += '<p class="fine">Free. ' + (signInAvailable() ? 'Sign in with Google to sync progress across devices.' : 'No account needed.') + '</p></div>';
  if (hero) {
    h += '<div class="preview" aria-label="Example problem">';
    h += '<div class="pv-tabs"><span class="on">' + icon('doc') + 'Description</span><span>' + icon('bulb') + 'Hints</span><span>' + icon('book') + 'Solution</span></div>';
    h += '<div class="pv-body"><h3>' + esc(hero.title) + '</h3><div class="p-meta"><span class="dpill medium">Medium</span><span class="tag">Assertions (SVA)</span><span class="tag">DV 75</span></div>';
    h += codeBlock('@(posedge clk) req |-> ##[1:2] gnt;', 'sv');
    h += '<div class="wavebox">' + waveSVG(hero.wave, { label: 'Timing diagram of clk, req and gnt over 8 cycles' }) + '</div>';
    h += '<div class="pv-opts"><span>A. It never fails</span><span>B. Cycle 5</span><span>C. Cycle 7</span><span>D. Cycle 8</span></div></div>';
    h += '<div class="pv-foot"><span>DV 75 · Assertions (SVA)</span><a class="btn btn-primary btn-sm" href="#dv-06">Try this problem</a></div></div>';
  }
  h += '</div></section>';
  h += '<section class="stats container" style="padding:0"><div><b>' + TOTAL + '</b><span>problems across three lists</span></div><div><b>' + LIVE + '</b><span>live now, auto-graded</span></div>' +
    '<div><b>' + TOPICS + '</b><span>topics across DV, RTL and architecture</span></div><div><b>' + FOLLOWUPS + '</b><span>interviewer follow-ups</span></div></section>';
  h += '<section class="block container"><div class="block-head"><h2>Three curated lists</h2><p>75 problems per track, grouped by topic and ordered from the questions every loop asks to the ones that separate strong candidates.</p></div><div class="cards3">';
  DATA.tracks.forEach((t) => {
    const sv = solvedCount(t.live);
    const chips = t.sections.slice(0, 4).map((s) => '<span class="tag">' + esc(s.title) + '</span>').join('') + '<span class="tag">+' + (t.sections.length - 4) + ' more</span>';
    h += '<a class="tcard" href="#practice-' + t.id + '"><div class="tcard-top"><span class="tcode">' + esc(t.list) + '</span><span class="tcount">' + t.live.length + ' of ' + t.total + ' live</span></div>' +
      '<h3>' + esc(t.name) + '</h3><p>' + esc(t.blurb) + '</p><div class="tchips">' + chips + '</div>' +
      '<div class="tprog"><div class="bar"><i style="width:' + pct(sv, t.live.length) + '%"></i></div><span>' + sv + ' / ' + t.live.length + ' solved</span></div>' +
      '<span class="tgo">Open ' + esc(t.list) + icon('arrowRight') + '</span></a>';
  });
  h += '</div></section>';
  h += '<section class="block container"><div class="block-head"><h2>Every problem, taught like an interview</h2><p>Problems are written the way a good interviewer runs a question: find the trap, reason it through, then keep digging.</p></div><div class="cards4">';
  [['target', 'Feedback on every mistake', 'Pick a common wrong answer and Tapeout tells you exactly which misconception led you there.'],
    ['bulb', 'Hints before solutions', 'Two hints per problem nudge you forward without giving the answer away.'],
    ['book', 'Worked solutions', 'Step-by-step reasoning, corrected code, timing diagrams, and the rule to remember.'],
    ['msg', 'Interviewer follow-ups', 'Three follow-up questions on every problem, because real interviewers never stop at the first answer.']].forEach((f) => {
    h += '<div class="fcard"><div class="fi">' + icon(f[0]) + '</div><h3>' + f[1] + '</h3><p>' + f[2] + '</p></div>';
  });
  h += '</div></section>';
  h += '<section class="container" style="padding:0"><div class="band"><div><h2>Start with your first problem</h2><p>' + (ident ? 'Your progress syncs to your account as you go.' : 'Your progress saves automatically as you go.') + '</p></div><div class="cta"><a class="btn btn-primary" href="#' + nextUp(TR.dv) + '">Start ' + esc(TR.dv.list) + icon('arrowRight') + '</a><a class="btn btn-secondary" href="#' + nextUp(TR.rtl) + '">Start ' + esc(TR.rtl.list) + '</a></div></div></section>';
  h += footer();
  app.innerHTML = h;
}

/* ---------- practice ---------- */
const ui = { q: '', avail: false, closed: {}, tab: 'desc', pid: null, drawer: null };
function renderPractice(filter) {
  shell('practice');
  document.title = 'Practice · Tapeout';
  const n = allSolved();
  let h = '<div class="container page"><div class="page-head"><div><h1>Practice</h1><p>Curated problem lists for hardware interviews, grouped by topic.</p></div>' +
    '<div class="overall">' + ring(n, LIVE) + '<div><b>' + n + ' / ' + LIVE + '</b><span>live problems solved</span></div></div></div>';
  h += '<div class="toolbar"><nav class="seg" aria-label="Lists"><a href="#practice"' + (!filter ? ' aria-current="page"' : '') + '>All</a>';
  DATA.tracks.forEach((t) => { h += '<a href="#practice-' + t.id + '"' + (filter === t.id ? ' aria-current="page"' : '') + '>' + esc(t.list) + '</a>'; });
  h += '</nav><div class="tools-r"><label class="search">' + icon('search') + '<span class="sr-only">Search problems</span><input id="q" type="search" maxlength="80" placeholder="Search problems" value="' + esc(ui.q) + '"></label>' +
    '<label class="toggle"><input type="checkbox" id="avail"' + (ui.avail ? ' checked' : '') + '>Available only</label></div></div>';
  h += '<div id="plist"></div></div>' + footer();
  app.innerHTML = h;
  drawList(filter);
}
function drawList(filter) {
  const q = ui.q.trim().toLowerCase();
  let h = '', any = false;
  DATA.tracks.forEach((t) => {
    if (filter && filter !== t.id) return;
    let th = '';
    t.sections.forEach((s, si) => {
      const items = s.items.filter((it) => (!ui.avail || !it.planned) && (!q || it.title.toLowerCase().includes(q)));
      if (!items.length) return;
      any = true;
      const live = s.items.filter((it) => !it.planned).map((it) => it.id);
      const sv = solvedCount(live), key = t.id + ':' + si, closed = ui.closed[key] && !q;
      th += '<div class="acc' + (closed ? ' closed' : '') + '"><button class="acc-h" data-act="acc" data-key="' + key + '" aria-expanded="' + !closed + '">' + icon('chevDown', 'chev') +
        '<span class="acc-t">' + esc(s.title) + '</span><span class="acc-c">' + sv + ' / ' + live.length + ' solved · ' + s.items.length + ' problems</span>' +
        '<div class="bar sm"><i style="width:' + pct(sv, live.length) + '%"></i></div></button>' +
        '<div class="acc-b"><table class="ptable"><thead><tr><th class="c-st">Status</th><th>Problem</th><th class="c-k">Type</th><th class="c-d">Difficulty</th></tr></thead><tbody>' +
        items.map((it) => row(it)).join('') + '</tbody></table></div></div>';
    });
    if (th) {
      if (!filter) h += '<div class="tgroup"><h2>' + esc(t.list) + '</h2><span>' + esc(t.name) + ' · ' + solvedCount(t.live) + ' / ' + t.live.length + ' solved</span></div>';
      h += th;
    }
  });
  const el = document.getElementById('plist');
  if (any) el.innerHTML = h;
  else { el.innerHTML = '<div class="empty">No problems match “<span></span>”.</div>'; el.querySelector('span').textContent = ui.q; }
}

/* ---------- roadmap ---------- */
function renderRoadmap(tid) {
  shell('roadmap');
  const t = TR[tid], L = LAYOUT[tid];
  document.title = 'Roadmap · ' + t.list + ' · Tapeout';
  const rowH = 118, H = L.rows * rowH;
  let h = '<div class="container page"><div class="page-head"><div><h1>Roadmap</h1><p>Work through each list topic by topic. Select a topic to see its problems.</p></div>' +
    '<div class="overall">' + ring(solvedCount(t.live), t.live.length) + '<div><b>' + solvedCount(t.live) + ' / ' + t.live.length + '</b><span>' + esc(t.list) + ' live problems solved</span></div></div></div>';
  h += '<nav class="seg" aria-label="Lists">';
  DATA.tracks.forEach((x) => { h += '<a href="#roadmap-' + x.id + '"' + (x.id === tid ? ' aria-current="page"' : '') + '>' + esc(x.list) + '</a>'; });
  h += '</nav><div class="rm-card"><div class="rm" style="height:' + H + 'px"><svg viewBox="0 0 100 ' + H + '" preserveAspectRatio="none" aria-hidden="true">';
  const pos = (i) => ({ x: L.pos[i][1], y: (L.pos[i][0] + 0.5) * rowH });
  const secDone = (i) => { const live = t.sections[i].items.filter((it) => !it.planned); return live.length && live.every((it) => isSolved(it.id)); };
  L.edges.forEach(([a0, b0]) => {
    const a = pos(a0), b = pos(b0), my = (a.y + b.y) / 2;
    const d = a.y === b.y ? 'M' + a.x + ',' + a.y + ' L' + b.x + ',' + b.y : 'M' + a.x + ',' + a.y + ' C' + a.x + ',' + my + ' ' + b.x + ',' + my + ' ' + b.x + ',' + b.y;
    h += '<path d="' + d + '"' + (secDone(a0) ? ' class="lit"' : '') + '/>';
  });
  h += '</svg>';
  t.sections.forEach((s, i) => {
    const p = pos(i), live = s.items.filter((it) => !it.planned).map((it) => it.id);
    const sv = solvedCount(live), soon = s.items.length - live.length;
    const cls = !live.length ? ' none' : (sv === live.length ? ' done' : '');
    h += '<button class="node' + cls + '" style="left:' + p.x + '%;top:' + p.y + 'px" data-act="node" data-i="' + i + '">' +
      '<span class="node-t">' + esc(s.title) + '</span><span class="bar sm"><i style="width:' + pct(sv, live.length || 1) + '%"></i></span>' +
      '<span class="node-c">' + (live.length ? sv + ' / ' + live.length + ' solved' : 'Coming soon') + (soon && live.length ? ' · ' + soon + ' soon' : '') + '</span></button>';
  });
  h += '</div></div></div>' + footer();
  h += '<div class="drawer-wrap" id="dw" hidden><div class="scrim" data-act="close"></div><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="dw-t" id="drawer"></aside></div>';
  app.innerHTML = h;
  if (ui.drawer && ui.drawer.t === tid) openDrawer(tid, ui.drawer.i);
}
function openDrawer(tid, i) {
  const t = TR[tid], s = t.sections[i];
  if (!t || !s) return;
  const live = s.items.filter((it) => !it.planned).map((it) => it.id), sv = solvedCount(live);
  ui.drawer = { t: tid, i };
  document.getElementById('drawer').innerHTML = '<div class="dw-head"><div><div class="eyebrow">' + esc(t.list) + '</div><h2 id="dw-t">' + esc(s.title) + '</h2></div>' +
    '<button class="iconbtn" data-act="close" aria-label="Close">' + icon('x') + '</button></div>' +
    '<div class="dw-prog"><div class="bar"><i style="width:' + pct(sv, live.length || 1) + '%"></i></div><span>' + sv + ' / ' + live.length + ' solved · ' + s.items.length + ' total</span></div>' +
    '<div class="ptable-wrap"><table class="ptable"><thead><tr><th class="c-st">Status</th><th>Problem</th><th class="c-d">Difficulty</th></tr></thead><tbody>' +
    s.items.map((it) => row(it, false)).join('') + '</tbody></table></div>';
  const dw = document.getElementById('dw');
  dw.hidden = false;
  const c = dw.querySelector('.iconbtn[data-act="close"]');
  if (c) c.focus();
}
function closeDrawer() { const dw = document.getElementById('dw'); if (dw) dw.hidden = true; ui.drawer = null; }

/* ---------- about & privacy ---------- */
function renderAbout() {
  shell('about');
  document.title = 'About · Tapeout';
  let h = '<div class="container page"><article class="prose">';
  h += '<div class="kicker">About Tapeout</div><h1>Structured prep for the interviews hardware candidates actually face.</h1>';
  h += '<p>Tapeout is interview prep for new-grad hardware roles: design verification, RTL design and computer architecture. Software candidates have curated roadmaps and problem lists. Hardware candidates mostly have scattered PDFs, forum threads, and whatever their coursework happened to cover. Tapeout closes that gap with curated lists, problems that teach the reasoning, and the follow-up questions interviewers ask next.</p>';
  h += '<div class="founder"><div class="av" aria-hidden="true">SB</div><div><h2>Siya Bajaj</h2><div class="role">Founder · Electrical and Computer Engineering, Carnegie Mellon University</div>' +
    '<p>I’m an Electrical and Computer Engineering student at Carnegie Mellon, graduating in 2027. I came to CMU planning to work in software, and did software engineering internships at Leidos and Walmart Global Tech. Then digital systems design (18-240) and logic design and verification (18-341) changed my plans: I fell for hardware design and verification.</p>' +
    '<p>When I started interviewing for design verification and silicon roles, I found plenty of prep for software interviews and almost none for hardware. The topics that came up most, like UVM, SystemVerilog classes, timing and cache coherence, were the ones coursework covered least. Tapeout is the prep I wanted: a clear roadmap, problems that teach the why, and practice for where an interviewer goes next.</p>' +
    '<div class="links-row"><a class="btn btn-secondary btn-sm" href="https://github.com/siyabajaj330-boop" target="_blank" rel="noopener">' + icon('github') + 'GitHub</a><a class="btn btn-secondary btn-sm" href="' + REPO + '/issues" target="_blank" rel="noopener">' + icon('msg') + 'Send feedback</a></div></div></div>';
  h += '<h2>How problems are made</h2><p>Accuracy is the whole point of a prep tool, so every problem goes through the same process before it’s published.</p></article>';
  h += '<div class="principles">' + [
    ['pen', 'Written by hand', 'Each problem, hint, solution and follow-up is written and reviewed by a person, then worked through in full before release.'],
    ['sim', 'Checked in simulation', 'Answers that depend on how code behaves are run in open-source simulators (Verilator and Icarus Verilog) where the tools support it. Every numeric answer is recomputed by script.'],
    ['flag', 'Open to corrections', 'Every problem has a Report an issue link. Corrections are reviewed and fixed quickly.'],
  ].map((f) => '<div class="fcard"><div class="fi">' + icon(f[0]) + '</div><h3>' + f[1] + '</h3><p>' + f[2] + '</p></div>').join('') + '</div>';
  h += '<article class="prose"><h2>What’s next</h2><p>' + LIVE + ' of ' + TOTAL + ' problems are live today, and new ones are added as they’re written and verified. The roadmap shows everything planned, so you can see what’s coming in each list.</p></article>';
  h += '</div>' + footer();
  app.innerHTML = h;
}
function renderPrivacy() {
  shell('');
  document.title = 'Privacy · Tapeout';
  const h = '<div class="container page"><article class="prose"><div class="kicker">Privacy</div><h1>Your data, plainly explained.</h1><p class="updated">Last updated November 17, 2026</p>' +
    '<h2>If you don’t sign in</h2><p>Your progress, notes and scratchpad are saved in your browser’s local storage. They never leave your device, and Tapeout can’t see them.</p>' +
    '<h2>If you sign in with Google</h2><ul><li><strong>Account.</strong> Sign-in is handled by Firebase Authentication, a Google service. It stores your name, email address and profile photo link so you can sign in.</li>' +
    '<li><strong>Progress.</strong> Problems solved, attempts, hints revealed, and your notes and scratchpad text are stored in Cloud Firestore (also a Google service), tied to your account.</li>' +
    '<li><strong>Access.</strong> Database rules allow only you to read or change your data. Nobody else using Tapeout can see it.</li></ul>' +
    '<h2>What Tapeout doesn’t do</h2><ul><li>No ads, and no analytics or tracking scripts.</li><li>No selling or sharing of your data.</li><li>Fonts and code are served from Tapeout itself, so no third-party requests are made until you choose to sign in.</li></ul>' +
    '<h2>Deleting your data</h2><p>Signed in: open your account menu and choose <strong>Delete account and data</strong>. This permanently deletes your progress, notes and sign-in record. Signed out: use <strong>Reset progress</strong> at the bottom of any page to clear this browser.</p>' +
    '<h2>Questions</h2><p>Open an issue on <a href="' + REPO + '/issues" target="_blank" rel="noopener">GitHub</a>.</p></article></div>' + footer();
  app.innerHTML = h;
}

/* ---------- workspace ---------- */
let flash = null;
function issueLink(pid) {
  const p = PROB[pid].p;
  const q = new URLSearchParams({ title: '[' + code(pid) + '] ' + p.title + ': ', body: 'Problem: ' + code(pid) + ' (' + p.title + ')\n\nWhat’s wrong:\n\n\nWhat you expected:\n' });
  return REPO + '/issues/new?' + q.toString();
}
function renderProblem(pid) {
  const e = PROB[pid], p = e.p, t = e.t;
  if (ui.pid !== pid) { ui.pid = pid; ui.tab = 'desc'; }
  shell('practice', true);
  document.title = p.title + ' · ' + t.list + ' · Tapeout';
  const solved = isSolved(pid);
  const idx = t.live.indexOf(pid), prev = t.live[idx - 1], next = t.live[idx + 1];
  let h = '<div class="ws" id="ws" style="--left:' + (M.split || 50) + '%">';
  h += '<div class="ws-bar"><a class="btn btn-ghost btn-sm" href="#practice-' + t.id + '">' + icon('list') + esc(t.list) + '</a><div class="ws-arrows">' +
    (prev ? '<a class="iconbtn" href="#' + prev + '" aria-label="Previous problem">' + icon('chevLeft') + '</a>' : '<span class="iconbtn" aria-disabled="true">' + icon('chevLeft') + '</span>') +
    (next ? '<a class="iconbtn" href="#' + next + '" aria-label="Next problem">' + icon('chevRight') + '</a>' : '<span class="iconbtn" aria-disabled="true">' + icon('chevRight') + '</span>') +
    '</div><span class="ws-crumb">' + esc(t.name) + ' / ' + esc(e.s.title) + '</span><span class="ws-r">' + (solved ? '<span class="solved-badge">' + icon('checkCircle') + 'Solved</span>' : '') +
    '<a class="iconbtn" href="' + esc(issueLink(pid)) + '" target="_blank" rel="noopener" title="Report an issue with this problem" aria-label="Report an issue with this problem">' + icon('flag') + '</a></span></div>';
  h += '<div class="ws-main"><section class="pane"><div class="tabs" role="tablist" id="tabs"></div><div class="pane-body" id="lp" role="tabpanel"></div></section>';
  h += '<div class="divider" id="divider" role="separator" aria-orientation="vertical" aria-label="Resize panels" tabindex="0"></div>';
  h += '<section class="pane"><div class="pane-head">' + icon(p.type === 'design' ? 'pen' : 'target') + (p.type === 'design' ? 'Your design' : 'Your answer') + '</div>' +
    '<div class="pane-body" id="rp"></div><div class="console" id="console" role="status" aria-live="polite" hidden></div><div class="pane-foot" id="pfoot"></div></section></div></div>';
  app.innerHTML = h;
  drawTabs(pid); drawLeft(pid); drawRight(pid); initDivider();
  if (flash) { showConsole(flash.kind, flash.title, flash.body); flash = null; }
  else if (solved && p.type !== 'design') showConsole('ok', 'Solved', solvedActions(pid));
}
const solutionOpen = (pid) => isSolved(pid) || isRevealed(pid);
function drawTabs(pid) {
  const p = PROB[pid].p, nh = Math.min(M.hints[pid] || 0, p.hints.length);
  const tabs = [['desc', 'doc', 'Description', ''], ['hints', 'bulb', 'Hints', '<span class="cnt">' + nh + '/' + p.hints.length + '</span>'],
    ['sol', solutionOpen(pid) ? 'book' : 'lock', 'Solution', ''], ['notes', 'pen', 'Notes', '']];
  document.getElementById('tabs').innerHTML = tabs.map((x) => '<button class="tab" role="tab" data-act="tab" data-tab="' + x[0] + '" aria-selected="' + (ui.tab === x[0]) + '">' + icon(x[1]) + x[2] + x[3] + '</button>').join('');
}
function drawLeft(pid) {
  const e = PROB[pid], p = e.p, el = document.getElementById('lp');
  let h = '';
  if (ui.tab === 'desc') {
    h += '<h1 class="p-title" id="ptitle">' + esc(p.title) + '</h1><div class="p-meta"><span class="dpill ' + lvl(p.level) + '">' + esc(p.level) + '</span>' +
      '<span class="tag">' + esc(p.kind) + '</span><span class="tag">' + esc(e.s.title) + '</span><span class="tag">~' + p.mins + ' min</span></div>';
    h += blocks(p.prompt);
    if (p.wave) h += '<div class="wavebox">' + waveSVG(p.wave, { resultRow: true, marks: isSolved(pid) ? p.wave.marks : null, label: 'Timing diagram' }) + '</div>';
    h += '<div class="callout"><h3>' + icon('help') + 'Why interviewers ask this</h3><p>' + fmt(p.why) + '</p></div>';
  } else if (ui.tab === 'hints') {
    const nh = M.hints[pid] || 0;
    p.hints.forEach((x, i) => {
      h += '<div class="hintcard"><h3><span>' + icon('bulb') + 'Hint ' + (i + 1) + '</span>' + (i === nh ? '<button class="btn btn-secondary btn-sm" data-act="hint">Reveal</button>' : '') + '</h3>' + (i < nh ? '<p>' + fmt(x) + '</p>' : '') + '</div>';
    });
    if (nh >= p.hints.length) h += '<p class="hint-line">Still stuck? The Solution tab walks through the full reasoning.</p>';
  } else if (ui.tab === 'sol') {
    if (!solutionOpen(pid)) {
      h += '<div class="locked"><span class="lk">' + icon('lock') + '</span><h3>Solve it first</h3><p>The solution unlocks when you submit a correct answer. Working it out yourself is what sticks in an interview.</p>' +
        '<button class="btn btn-secondary btn-sm" data-act="reveal">' + (p.type === 'design' ? 'Show reference design anyway' : 'Show solution anyway') + '</button></div>';
    } else {
      h += '<div class="solution">' + blocks(p.solution) + '</div><h2 class="fu-h">Interviewer follow-ups</h2>';
      p.followups.forEach((f) => {
        h += '<details class="fu"><summary>' + icon('chevRight') + '<span>' + fmt(f.q) + '</span></summary><div class="fua"><p>' + fmt(f.a) + '</p>' + (f.code ? codeBlock(f.code, f.lang) : '') + '</div></details>';
      });
    }
  } else if (ui.tab === 'notes') {
    h += '<label class="sr-only" for="notes">Your notes</label><textarea class="notes" id="notes" maxlength="20000" placeholder="Jot down the trap, the rule, or anything you want to remember for the interview."></textarea>' +
      '<p class="hint-line">' + (ident ? 'Notes sync to your account.' : 'Notes save in this browser. Sign in to keep them across devices.') + '</p>';
  }
  el.innerHTML = h;
  const ta = document.getElementById('notes');
  if (ta) ta.value = M.notes[pid] || '';
  el.scrollTop = 0;
}
function drawRight(pid) {
  const p = PROB[pid].p, solved = isSolved(pid);
  let h = '<p class="q">' + fmt(p.question) + '</p>', f;
  if (p.type === 'mcq') {
    h += '<fieldset class="opts"><legend class="sr-only">' + esc(p.question.replace(/\{\{|\}\}/g, '')) + '</legend>';
    p.options.forEach((o, i) => {
      const right = o.id === p.answer;
      h += '<label class="opt' + (solved && right ? ' is-right' : '') + '" id="lab-' + o.id + '"><input type="radio" name="ans" value="' + o.id + '"' + (solved && right ? ' checked' : '') + '>' +
        '<span class="key" aria-hidden="true">' + String.fromCharCode(65 + i) + '</span><span class="opt-body">';
      if (o.code) { if (o.text && o.text !== o.code) h += '<span>' + fmt(o.text) + '</span>'; h += codeBlock(o.code, 'sv'); } else h += fmt(o.text);
      h += '<span class="why" id="why-' + o.id + '"' + (solved && !right ? '' : ' hidden') + '>' + (o.why ? fmt(o.why) : '') + '</span></span></label>';
    });
    h += '</fieldset>';
  } else if (p.type === 'numeric' || p.type === 'text') {
    const val = solved ? (p.type === 'numeric' ? String(p.answer) : p.accept[0]) : '';
    h += '<div class="field"><label class="sr-only" for="ans-in">Your answer</label><input id="ans-in" type="text" maxlength="40" autocomplete="off" spellcheck="false"' + (p.type === 'numeric' ? ' inputmode="decimal"' : '') +
      ' placeholder="' + esc(p.placeholder || 'Your answer') + '" value="' + esc(val) + '">' + (p.unit ? '<span class="unit">' + esc(p.unit) + '</span>' : '') + '</div>';
  } else if (p.type === 'design') {
    const rb = M.rubric[pid] || [];
    h += '<div class="sublabel" style="margin-top:0"><span>Scratchpad</span><a href="https://www.edaplayground.com/" target="_blank" rel="noopener">Open EDA Playground' + icon('ext') + '</a></div>' +
      '<label class="sr-only" for="scratch">Scratchpad</label><textarea class="notes scratch" id="scratch" maxlength="20000" spellcheck="false" placeholder="// Sketch your design here: data structures, checks, pseudo-code."></textarea>';
    h += '<div class="sublabel"><span>Self-check</span></div><ul class="rubric">';
    p.rubric.forEach((r, i) => { h += '<li><label for="rb-' + i + '"><input type="checkbox" id="rb-' + i + '" data-act="rubric" data-i="' + i + '"' + (rb[i] ? ' checked' : '') + '><span>' + fmt(r) + '</span></label></li>'; });
    h += '</ul>';
  }
  document.getElementById('rp').innerHTML = h;
  const sc = document.getElementById('scratch');
  if (sc) sc.value = M.scratch[pid] || '';
  if (p.type === 'design') {
    f = '<span class="kbd">Compare with the reference design when you’re done</span>' + (solved ? '<button class="btn btn-secondary btn-sm" data-act="undone">' + icon('check') + 'Completed · Undo</button>' : '<button class="btn btn-ok" data-act="done">Mark complete</button>');
  } else {
    f = '<span class="kbd"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to submit</span><button class="btn btn-ok" data-act="submit">Submit</button>';
  }
  document.getElementById('pfoot').innerHTML = f;
}
function solvedActions(pid) {
  const t = PROB[pid].t, next = t.live[t.live.indexOf(pid) + 1];
  let h = '<div class="cta"><button class="btn btn-secondary btn-sm" data-act="tab" data-tab="sol">' + icon('book') + 'View solution</button>' +
    (next ? '<a class="btn btn-primary btn-sm" href="#' + next + '">Next problem' + icon('arrowRight') + '</a>' : '<a class="btn btn-primary btn-sm" href="#practice-' + t.id + '">Back to ' + esc(t.list) + '</a>') + '</div>';
  if (!ident && signInAvailable()) h += '<div class="nudge"><span>Sign in to keep your progress across devices.</span><button class="signin" data-act="signin">' + GOOGLE_G + '<span>Sign in with Google</span></button></div>';
  return h;
}
function showConsole(kind, title, body) {
  const c = document.getElementById('console');
  if (!c) return;
  c.className = 'console ' + kind;
  c.innerHTML = '<div class="c-title">' + icon(kind === 'ok' ? 'checkCircle' : kind === 'bad' ? 'xCircle' : 'help') + esc(title) + '</div>' + (body || '');
  c.hidden = false;
}
const norm = (s) => String(s).toLowerCase().replace(/[\s_]/g, '').replace(/^(\d*'b|0b)/, '');
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 0) + 1e-9;
function submit(pid) {
  const p = PROB[pid].p;
  let ok = false, msg = '';
  if (p.type === 'mcq') {
    const sel = app.querySelector('input[name="ans"]:checked');
    if (!sel) { showConsole('info', 'Pick an answer first', ''); return; }
    ok = sel.value === p.answer;
    app.querySelectorAll('.opt').forEach((l) => l.classList.remove('is-right', 'is-wrong'));
    app.querySelectorAll('.why').forEach((w) => { w.hidden = true; });
    if (!ok) {
      document.getElementById('lab-' + sel.value).classList.add('is-wrong');
      const o = p.options.find((x) => x.id === sel.value), w = document.getElementById('why-' + sel.value);
      if (w && o && o.why) w.hidden = false;
      msg = o && o.why ? fmt(o.why) : 'Try another option, or open a hint.';
    }
  } else {
    const rawv = document.getElementById('ans-in').value;
    if (p.type === 'numeric') {
      const clean = rawv.replace(/[, ]/g, '');
      if (!clean) { showConsole('info', 'Enter a number first', ''); return; }
      const v = Number(clean);
      if (!isFinite(v)) { showConsole('info', 'That isn’t a number', '<p>Enter digits only, like 42 or 2.5.</p>'); return; }
      ok = near(v, p.answer, p.tol);
      if (!ok) { const tr = (p.traps || []).find((x) => near(v, x.v, x.tol)); msg = tr ? fmt(tr.msg) : 'Check your working step by step, or open a hint.'; }
    } else {
      const n = norm(rawv);
      if (!n) { showConsole('info', 'Enter an answer first', ''); return; }
      ok = p.accept.map(norm).includes(n);
      if (!ok) { const tt = (p.traps || []).find((x) => norm(x.v) === n); msg = tt ? fmt(tt.msg) : 'Not a match. Open a hint if you’re stuck.'; }
    }
  }
  M.attempts[pid] = Math.min((M.attempts[pid] || 0) + 1, 9999);
  if (ok) {
    const tries = M.attempts[pid];
    M.solved[pid] = Date.now();
    save();
    flash = { kind: 'ok', title: 'Accepted', body: '<p>' + (tries === 1 ? 'Solved on your first try.' : 'Solved in ' + tries + ' attempts.') + ' The solution and interviewer follow-ups are unlocked.</p>' + solvedActions(pid) };
    renderProblem(pid);
  } else {
    save();
    showConsole('bad', 'Wrong answer', '<p>' + msg + '</p><p class="kbd">Attempt ' + M.attempts[pid] + '</p>');
  }
}
function initDivider() {
  const d = document.getElementById('divider'), ws = document.getElementById('ws');
  if (!d) return;
  const setSplit = (v) => { v = Math.min(70, Math.max(30, v)); M.split = Math.round(v); ws.style.setProperty('--left', v + '%'); };
  d.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); d.setPointerCapture(ev.pointerId); ws.classList.add('dragging');
    const r = ws.querySelector('.ws-main').getBoundingClientRect();
    const mv = (e2) => setSplit((e2.clientX - r.left) / r.width * 100);
    const up = () => { d.removeEventListener('pointermove', mv); d.removeEventListener('pointerup', up); ws.classList.remove('dragging'); writeLocal(ident ? userKey(ident.uid) : GUEST_KEY, M); };
    d.addEventListener('pointermove', mv); d.addEventListener('pointerup', up);
  });
  d.addEventListener('keydown', (e2) => {
    if (e2.key === 'ArrowLeft' || e2.key === 'ArrowRight') { e2.preventDefault(); setSplit((M.split || 50) + (e2.key === 'ArrowLeft' ? -2 : 2)); writeLocal(ident ? userKey(ident.uid) : GUEST_KEY, M); }
  });
}

/* ---------- events ---------- */
const currentRoute = () => location.hash.slice(1);
const currentPid = () => (PROB[currentRoute()] ? currentRoute() : null);
const practiceFilter = () => { const h = currentRoute(); return h.startsWith('practice-') && TR[h.slice(9)] ? h.slice(9) : null; };
let typingTimer = null;
document.addEventListener('click', (ev) => {
  const menu = document.getElementById('acctmenu');
  if (menu && !menu.hidden && !ev.target.closest('.acct')) closeMenu();
  const r = ev.target.closest('tr.prow');
  if (r && !ev.target.closest('a')) { location.hash = r.getAttribute('data-href'); return; }
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const act = b.getAttribute('data-act'), pid = currentPid();
  switch (act) {
    case 'signin': doSignIn(b); return;
    case 'menu': { const m = document.getElementById('acctmenu'); const open = m.hidden; m.hidden = !open; b.setAttribute('aria-expanded', String(open)); return; }
    case 'signout': doSignOut(); return;
    case 'delete':
      closeMenu();
      openModal('<h2 id="modal-t">Delete your account and data?</h2><p>This permanently deletes your progress, notes and sign-in record for ' + esc(ident ? ident.email : 'this account') + '. It can’t be undone.</p>' +
        '<div class="cta"><button class="btn btn-secondary" data-act="modal-close">Cancel</button><button class="btn btn-danger" data-act="delete-yes">Delete everything</button></div>');
      return;
    case 'delete-yes': doDeleteAccount(b); return;
    case 'modal-close': closeModal(); return;
    case 'reset':
      document.getElementById('resetbox').innerHTML = 'Clear all progress' + (ident ? ' in your account' : ' in this browser') + '? <button class="linkbtn" data-act="reset-yes">Yes, clear</button> · <button class="linkbtn" data-act="reset-no">Cancel</button>';
      return;
    case 'reset-yes': {
      const now = Date.now(), fresh = blank();
      if (ident) {
        for (const k of ['solved', 'revealed']) for (const id of Object.keys(M[k])) fresh[k][id] = -now;
        for (const id of new Set([...Object.keys(M.notes), ...Object.keys(M.scratch)])) dirtyNotes.add(id);
        forceNext = true;
        clearTimeout(notesTimer); notesTimer = setTimeout(pushNotes, 2600);
      }
      M = fresh; save(); route(); toast('ok', 'Progress cleared.');
      return;
    }
    case 'reset-no': route(); return;
    case 'acc': { const k = b.getAttribute('data-key'); ui.closed[k] = !ui.closed[k]; b.parentNode.classList.toggle('closed', ui.closed[k]); b.setAttribute('aria-expanded', String(!ui.closed[k])); return; }
    case 'node': { const rh = currentRoute(); openDrawer(rh.startsWith('roadmap-') ? rh.slice(8) : 'dv', Number(b.getAttribute('data-i'))); return; }
    case 'close': closeDrawer(); return;
    default: break;
  }
  if (!pid) return;
  const p = PROB[pid].p;
  switch (act) {
    case 'tab': ui.tab = b.getAttribute('data-tab'); drawTabs(pid); drawLeft(pid); return;
    case 'submit': submit(pid); return;
    case 'hint': M.hints[pid] = Math.min((M.hints[pid] || 0) + 1, p.hints.length); save(); drawTabs(pid); drawLeft(pid); return;
    case 'reveal': M.revealed[pid] = Date.now(); save(); drawTabs(pid); drawLeft(pid); return;
    case 'done': M.solved[pid] = Date.now(); save(); ui.tab = 'sol'; flash = { kind: 'ok', title: 'Marked complete', body: '<p>Compare your design with the reference in the Solution tab.</p>' }; renderProblem(pid); return;
    case 'undone': M.solved[pid] = -Date.now(); save(); renderProblem(pid); return;
    default: break;
  }
});
document.addEventListener('change', (ev) => {
  const pid = currentPid();
  if (ev.target.id === 'avail') { ui.avail = ev.target.checked; drawList(practiceFilter()); return; }
  const c = ev.target.closest('[data-act="rubric"]');
  if (c && pid) { const arr = (M.rubric[pid] || []).slice(); arr[Number(c.getAttribute('data-i'))] = c.checked; M.rubric[pid] = arr.map(Boolean); save(); }
});
document.addEventListener('input', (ev) => {
  const pid = currentPid();
  if (ev.target.id === 'q') { ui.q = ev.target.value.slice(0, 80); drawList(practiceFilter()); return; }
  if (pid && (ev.target.id === 'notes' || ev.target.id === 'scratch')) {
    (ev.target.id === 'notes' ? M.notes : M.scratch)[pid] = ev.target.value.slice(0, 20000);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { writeLocal(ident ? userKey(ident.uid) : GUEST_KEY, M); scheduleNote(pid); }, 500);
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { closeDrawer(); closeMenu(); closeModal(); return; }
  const pid = currentPid();
  if (!pid) return;
  if ((ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) || (ev.key === 'Enter' && ev.target.id === 'ans-in')) {
    if (PROB[pid].p.type !== 'design') { ev.preventDefault(); submit(pid); }
  }
});

/* ---------- routing ---------- */
let lastView = null;
function route() {
  const h = currentRoute();
  let view = h;
  closeMenu();
  if (h === 'practice' || (h.startsWith('practice-') && TR[h.slice(9)])) renderPractice(practiceFilter());
  else if (h === 'roadmap' || (h.startsWith('roadmap-') && TR[h.slice(8)])) {
    const tid = h.slice(8) || 'dv';
    if (!ui.drawer || ui.drawer.t !== tid) ui.drawer = null;
    renderRoadmap(tid);
  } else if (h === 'about') renderAbout();
  else if (h === 'privacy') renderPrivacy();
  else if (PROB[h]) renderProblem(h);
  else { renderHome(); view = 'home'; }
  if (view !== lastView) { window.scrollTo(0, 0); lastView = view; }
}
window.addEventListener('hashchange', route);
window.addEventListener('storage', (ev) => {
  // Keep tabs consistent when another tab changes progress.
  if (ev.key === GUEST_KEY && !ident) { M = readLocal(GUEST_KEY); route(); }
  if (ident && ev.key === userKey(ident.uid)) { M = readLocal(userKey(ident.uid)); route(); }
});
route();
bootCloud();
