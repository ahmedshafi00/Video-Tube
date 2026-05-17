/* ============================================================
   firebase.js — Firebase Config, Auth, Firestore helpers

   ⚠️  HOW TO SET YOUR FIREBASE CONFIG:
   1. Go to https://console.firebase.google.com
   2. Select your project → ⚙️ Project Settings → Your Apps
   3. Click </> (Web) → Register app → copy the firebaseConfig
   4. Paste the values below replacing each quoted string
   ============================================================ */

// ─── 1. Firebase Config — PASTE YOUR REAL VALUES HERE ────────────
// Go to Firebase Console → Project Settings → Your Apps → Web App
// Copy the firebaseConfig object and replace the values below:

const firebaseConfig = {
  apiKey: "AIzaSyDSZDP9Ji_kemfBTBr01MSiLAh1f6zJ6x4",
  authDomain: "video-tube-4f290.firebaseapp.com",
  projectId: "video-tube-4f290",
  storageBucket: "video-tube-4f290.firebasestorage.app",
  messagingSenderId: "549786848372",
  appId: "1:549786848372:web:085029d034288a3e64d521"
};

// ─── 2. Initialise Firebase (compat SDK via CDN) ─────────────────
firebase.initializeApp(FIREBASE_CONFIG);

const auth = firebase.auth();
const db   = firebase.firestore();

// Persistence so Telegram WebApp session survives reloads
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

/* ============================================================
   FIREBASE COLLECTION STRUCTURE
   ============================================================

  users/{uid}
    tgId        : string   — Telegram user ID
    username    : string
    firstName   : string
    photoUrl    : string
    createdAt   : timestamp
    watchHistory: array of videoIds
    favorites   : array of videoIds
    role        : "user" | "admin"

  videos/{videoId}
    title       : string
    description : string
    thumbUrl    : string
    embedUrl    : string   — YouTube/MP4 embed URL
    category    : string
    tags        : array
    views       : number
    likes       : number
    duration    : string   — "12:34"
    createdAt   : timestamp
    updatedAt   : timestamp
    publishedBy : string   — admin uid

  unlockedVideos/{uid_videoId}
    uid         : string
    videoId     : string
    unlockedAt  : timestamp
    expiresAt   : timestamp  — unlockedAt + 24h

  views/{viewId}
    videoId     : string
    uid         : string
    watchedAt   : timestamp

  categories/{catId}
    name        : string
    slug        : string
    icon        : string   — emoji
    order       : number

  analytics/global
    totalUsers  : number
    totalVideos : number
    totalViews  : number
   ============================================================ */

// ─── 3. Auth helpers ────────────────────────────────────────────

/**
 * Register or update a user record from Telegram WebApp data.
 * @param {Object} tgUser — window.Telegram.WebApp.initDataUnsafe.user
 * @returns {firebase.User}
 */
async function loginWithTelegram(tgUser) {
  const uid      = "tg_" + tgUser.id;
  const email    = uid + "@tg.telegramapp.local";
  const password = "TG_" + tgUser.id + "_SECURE_SALT_v1";

  let firebaseUser;
  try {
    const cred = await auth.signInWithEmailAndPassword(email, password);
    firebaseUser = cred.user;
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      firebaseUser = cred.user;
    } else {
      throw e;
    }
  }

  // Upsert user document
  await db.collection("users").doc(uid).set({
    tgId:      String(tgUser.id),
    username:  tgUser.username  || "",
    firstName: tgUser.first_name || "",
    photoUrl:  tgUser.photo_url  || "",
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Increment global users count (idempotent with merge)
  const globalRef = db.collection("analytics").doc("global");
  await globalRef.set({
    totalUsers: firebase.firestore.FieldValue.increment(1)
  }, { merge: true });

  return { firebaseUser, uid };
}

async function adminLogin(email, password) {
  const cred = await auth.signInWithEmailAndPassword(email, password);
  const snap = await db.collection("users").doc(cred.user.uid).get();
  if (!snap.exists || snap.data().role !== "admin") {
    await auth.signOut();
    throw new Error("Not authorised as admin.");
  }
  return cred.user;
}

function logout() { return auth.signOut(); }

// ─── 4. Video helpers ────────────────────────────────────────────

function sanitiseEmbedUrl(url) {
  // Convert YouTube watch URLs → embed
  url = url.trim();
  const ytWatch  = /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([\w-]+)/;
  const ytShort  = /(?:https?:\/\/)?youtu\.be\/([\w-]+)/;
  let m;
  if ((m = url.match(ytWatch)))  return `https://www.youtube.com/embed/${m[1]}?rel=0&autoplay=1`;
  if ((m = url.match(ytShort)))  return `https://www.youtube.com/embed/${m[1]}?rel=0&autoplay=1`;
  // Accept direct MP4 or existing embed URLs
  if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(url)) return url;
  if (url.includes("youtube.com/embed") || url.includes("player.vimeo")) return url;
  throw new Error("Unsupported embed URL. Use YouTube or direct MP4.");
}

async function addVideo(data) {
  data.embedUrl  = sanitiseEmbedUrl(data.embedUrl);
  data.views     = 0;
  data.likes     = 0;
  data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
  data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  const ref = await db.collection("videos").add(data);
  await db.collection("analytics").doc("global").set({
    totalVideos: firebase.firestore.FieldValue.increment(1)
  }, { merge: true });
  return ref.id;
}

async function updateVideo(videoId, data) {
  if (data.embedUrl) data.embedUrl = sanitiseEmbedUrl(data.embedUrl);
  data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  await db.collection("videos").doc(videoId).update(data);
}

async function deleteVideo(videoId) {
  await db.collection("videos").doc(videoId).delete();
  await db.collection("analytics").doc("global").set({
    totalVideos: firebase.firestore.FieldValue.increment(-1)
  }, { merge: true });
}

async function getVideos({ category = null, limit = 12, after = null } = {}) {
  let q = db.collection("videos").orderBy("createdAt", "desc");
  if (category && category !== "all") q = q.where("category", "==", category);
  if (after) q = q.startAfter(after);
  q = q.limit(limit);
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getVideo(videoId) {
  const snap = await db.collection("videos").doc(videoId).get();
  if (!snap.exists) throw new Error("Video not found");
  return { id: snap.id, ...snap.data() };
}

async function searchVideos(term) {
  // Firestore doesn't support full-text; we do client-side after fetching
  const snap = await db.collection("videos").limit(200).get();
  const q    = term.toLowerCase();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(v =>
      v.title?.toLowerCase().includes(q) ||
      v.description?.toLowerCase().includes(q) ||
      v.tags?.some(t => t.toLowerCase().includes(q))
    );
}

async function incrementView(videoId, uid) {
  const batch = db.batch();
  batch.update(db.collection("videos").doc(videoId), {
    views: firebase.firestore.FieldValue.increment(1)
  });
  batch.set(db.collection("views").doc(), {
    videoId, uid, watchedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  batch.set(db.collection("analytics").doc("global"), {
    totalViews: firebase.firestore.FieldValue.increment(1)
  }, { merge: true });
  await batch.commit();
}

async function toggleLike(videoId, uid) {
  const ref  = db.collection("videos").doc(videoId);
  const snap = await ref.get();
  const data = snap.data();
  const likedBy = data.likedBy || [];
  const liked   = likedBy.includes(uid);
  await ref.update({
    likedBy: liked
      ? firebase.firestore.FieldValue.arrayRemove(uid)
      : firebase.firestore.FieldValue.arrayUnion(uid),
    likes: firebase.firestore.FieldValue.increment(liked ? -1 : 1)
  });
  return !liked;
}

// ─── 5. Unlock helpers ──────────────────────────────────────────

async function isVideoUnlocked(uid, videoId) {
  const docId = `${uid}_${videoId}`;
  const snap  = await db.collection("unlockedVideos").doc(docId).get();
  if (!snap.exists) return false;
  const data = snap.data();
  return data.expiresAt.toDate() > new Date();
}

async function unlockVideo(uid, videoId) {
  const docId     = `${uid}_${videoId}`;
  const now       = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24h
  await db.collection("unlockedVideos").doc(docId).set({
    uid, videoId,
    unlockedAt: firebase.firestore.Timestamp.fromDate(now),
    expiresAt:  firebase.firestore.Timestamp.fromDate(expiresAt)
  });
}

// ─── 6. Category helpers ─────────────────────────────────────────

async function getCategories() {
  const snap = await db.collection("categories").orderBy("order").get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function addCategory(data) {
  return db.collection("categories").add(data);
}

// ─── 7. User profile helpers ─────────────────────────────────────

async function getUserProfile(uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function addToHistory(uid, videoId) {
  await db.collection("users").doc(uid).update({
    watchHistory: firebase.firestore.FieldValue.arrayUnion(videoId)
  });
}

async function toggleFavorite(uid, videoId) {
  const snap = await db.collection("users").doc(uid).get();
  const favs = snap.data()?.favorites || [];
  const isFav = favs.includes(videoId);
  await db.collection("users").doc(uid).update({
    favorites: isFav
      ? firebase.firestore.FieldValue.arrayRemove(videoId)
      : firebase.firestore.FieldValue.arrayUnion(videoId)
  });
  return !isFav;
}

// ─── 8. Analytics ────────────────────────────────────────────────

async function getGlobalStats() {
  const snap = await db.collection("analytics").doc("global").get();
  return snap.exists ? snap.data() : { totalUsers: 0, totalVideos: 0, totalViews: 0 };
}

// ─── 9. Admin panel — all videos paged ───────────────────────────

async function getAllVideosAdmin({ limit = 20, after = null } = {}) {
  let q = db.collection("videos").orderBy("createdAt", "desc").limit(limit);
  if (after) q = q.startAfter(after);
  const snap = await q.get();
  return {
    videos: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs[snap.docs.length - 1] || null
  };
}
