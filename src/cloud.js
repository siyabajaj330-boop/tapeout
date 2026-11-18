// Accounts and sync: Firebase Authentication (Google only) + Cloud Firestore (Lite).
// Loaded lazily after the first render, so the site works even if this chunk
// is blocked or Google services are unreachable.
import { initializeApp } from 'firebase/app';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup,
  signOut, deleteUser, reauthenticateWithPopup,
} from 'firebase/auth';
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs, serverTimestamp,
} from 'firebase/firestore/lite';

let auth, db, provider;

export function init(config) {
  const app = initializeApp(config);
  auth = getAuth(app);
  db = getFirestore(app);
  provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
}

export function onUser(cb) {
  return onAuthStateChanged(auth, (u) => cb(u ? {
    uid: u.uid,
    name: u.displayName || '',
    email: u.email || '',
    photo: u.photoURL || '',
  } : null));
}

// Pop-up sign-in only. Redirect sign-in breaks in browsers that partition third-party
// storage when the auth domain differs from the site's domain, so it isn't offered.
export async function signIn() {
  await signInWithPopup(auth, provider);
}

export function signOutUser() {
  return signOut(auth);
}

const userRef = (uid) => doc(db, 'users', uid);

export async function loadProgress(uid) {
  const snap = await getDoc(userRef(uid));
  return snap.exists() ? snap.data() : null;
}

export async function saveProgress(uid, p) {
  await setDoc(userRef(uid), {
    v: 1,
    solved: p.solved,
    revealed: p.revealed,
    attempts: p.attempts,
    hints: p.hints,
    rubric: p.rubric,
    split: p.split,
    updatedAt: serverTimestamp(),
  });
}

export async function loadNotes(uid) {
  const qs = await getDocs(collection(db, 'users', uid, 'notes'));
  const out = {};
  qs.forEach((d) => { out[d.id] = d.data(); });
  return out;
}

export async function saveNote(uid, pid, text, scratch) {
  await setDoc(doc(db, 'users', uid, 'notes', pid), { text, scratch, updatedAt: serverTimestamp() });
}

// Deletes the user's notes, progress document, and finally their sign-in record.
export async function deleteAccount() {
  const u = auth.currentUser;
  if (!u) return;
  const qs = await getDocs(collection(db, 'users', u.uid, 'notes'));
  for (const d of qs.docs) await deleteDoc(d.ref);
  await deleteDoc(userRef(u.uid));
  try {
    await deleteUser(u);
  } catch (e) {
    if (e && e.code === 'auth/requires-recent-login') {
      await reauthenticateWithPopup(u, provider);
      await deleteUser(u);
    } else {
      throw e;
    }
  }
}
