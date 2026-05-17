/* ============================================================
   app.js — Main Application Logic
   Telegram Mini App SDK + UI + Ad Unlock + Navigation
   ============================================================ */

/* ─── Global state ─────────────────────────────────────────── */
const APP = {
  currentUser:  null,      // Firebase auth user
  tgUser:       null,      // Telegram user object
  userDocId:    null,      // Firestore uid e.g. "tg_123456"
  currentPage:  "home",
  currentVideo: null,
  lastDoc:      null,      // for infinite scroll
  loading:      false,
  categories:   [],
  activeCategory: "all",
  searchTimeout: null,
  deferredPrompt: null,    // PWA install
};

/* ─── Monetag config — replace with your values ─────────────── */
const MONETAG = {
  zoneId:     "YOUR_MONETAG_ZONE_ID",       // Rewarded ad zone
  interstitialZoneId: "YOUR_INTERSTITIAL_ID",
  scriptSrc:  "https://greedyfor.com/400/YOUR_MONETAG_ZONE_ID",
};

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener("DOMContentLoaded", init);

async function init() {
  setupTelegram();
  setupPWA();
  await bootstrapAuth();
  setupNavigation();
  setupSearch();
  renderPage("home");
}

/* ─── Telegram WebApp SDK ─────────────────────────────────── */
function setupTelegram() {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  tg.ready();
  tg.expand();
  tg.setHeaderColor("#0a0a0f");
  tg.setBackgroundColor("#0a0a0f");

  const user = tg.initDataUnsafe?.user;
  if (user) {
    APP.tgUser = user;
    console.log("[TG] User detected:", user.username);
  }
}

/* ─── Auth bootstrap ─────────────────────────────────────── */
async function bootstrapAuth() {
  return new Promise((resolve) => {
    auth.onAuthStateChanged(async (firebaseUser) => {
      if (firebaseUser) {
        APP.currentUser = firebaseUser;
        APP.userDocId   = firebaseUser.email.split("@")[0]; // tg_12345
        updateHeaderAvatar();
        resolve();
        return;
      }

      if (APP.tgUser) {
        try {
          showToast("Signing in…", "info");
          const { firebaseUser: u, uid } = await loginWithTelegram(APP.tgUser);
          APP.currentUser = u;
          APP.userDocId   = uid;
          updateHeaderAvatar();
          showToast("Welcome, " + (APP.tgUser.first_name || "User") + "! 👋", "success");
        } catch (e) {
          console.error("Auth error:", e);
          showToast("Sign-in failed. Continuing as guest.", "error");
        }
      }
      resolve();
    });
  });
}

function updateHeaderAvatar() {
  const img = document.getElementById("header-avatar");
  if (!img) return;
  const photoUrl = APP.tgUser?.photo_url || "";
  img.src = photoUrl || "https://ui-avatars.com/api/?name=" +
    encodeURIComponent(APP.tgUser?.first_name || "U") + "&background=63b3ed&color=0a0a0f&size=64";
}

/* ─── PWA ────────────────────────────────────────────────── */
function setupPWA() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    APP.deferredPrompt = e;
    const banner = document.getElementById("install-banner");
    if (banner) banner.classList.remove("hidden");
  });

  document.getElementById("btn-install")?.addEventListener("click", async () => {
    if (!APP.deferredPrompt) return;
    APP.deferredPrompt.prompt();
    const { outcome } = await APP.deferredPrompt.userChoice;
    if (outcome === "accepted") showToast("App installed! 🎉", "success");
    APP.deferredPrompt = null;
    document.getElementById("install-banner")?.classList.add("hidden");
  });

  document.getElementById("btn-install-dismiss")?.addEventListener("click", () => {
    document.getElementById("install-banner")?.classList.add("hidden");
  });
}

/* ─── Navigation ─────────────────────────────────────────── */
function setupNavigation() {
  document.querySelectorAll("[data-nav]").forEach(el => {
    el.addEventListener("click", () => {
      const page = el.dataset.nav;
      renderPage(page);
    });
  });
}

function setActiveNav(page) {
  document.querySelectorAll(".nav-item").forEach(el => {
    el.classList.toggle("active", el.dataset.nav === page);
  });
}

async function renderPage(page, params = {}) {
  APP.currentPage = page;
  setActiveNav(page);

  // Hide all pages
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));

  const pageEl = document.getElementById("page-" + page);
  if (pageEl) pageEl.classList.add("active");

  switch (page) {
    case "home":
      await renderHome();
      break;
    case "search":
      renderSearch();
      break;
    case "profile":
      await renderProfile();
      break;
    case "watch":
      await renderWatch(params.videoId);
      break;
    case "favorites":
      await renderFavorites();
      break;
  }
}

/* ============================================================
   HOME PAGE
   ============================================================ */
async function renderHome() {
  // Load categories
  if (APP.categories.length === 0) {
    APP.categories = await getCategories().catch(() => []);
  }
  renderCategoryPills();

  // Reset pagination
  APP.lastDoc = null;
  const grid = document.getElementById("video-grid");
  grid.innerHTML = renderSkeletons(6);

  const videos = await getVideos({ category: APP.activeCategory, limit: 12 });
  APP.lastDoc = videos.length === 12 ? videos[videos.length - 1] : null;

  grid.innerHTML = "";
  if (videos.length === 0) {
    grid.innerHTML = `<div class="text-muted text-center" style="grid-column:1/-1;padding:40px 0">No videos yet.</div>`;
    return;
  }
  videos.forEach(v => grid.appendChild(makeVideoCard(v)));
  setupInfiniteScroll();
}

function renderCategoryPills() {
  const wrap = document.getElementById("category-pills");
  if (!wrap) return;
  const all = [{ id: "all", name: "All", icon: "🎬" }, ...APP.categories];
  wrap.innerHTML = all.map(c =>
    `<button class="pill${APP.activeCategory === (c.id || c.slug) ? " active" : ""}"
      data-cat="${c.id || c.slug}">${c.icon || ""} ${c.name}</button>`
  ).join("");

  wrap.querySelectorAll(".pill").forEach(btn => {
    btn.addEventListener("click", async () => {
      APP.activeCategory = btn.dataset.cat;
      wrap.querySelectorAll(".pill").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      await renderHome();
    });
  });
}

function makeVideoCard(video) {
  const div = document.createElement("div");
  div.className = "video-card";
  div.innerHTML = `
    <div class="card-thumb">
      <img src="${esc(video.thumbUrl)}" alt="${esc(video.title)}" loading="lazy"
           onerror="this.src='https://via.placeholder.com/320x180/111118/63b3ed?text=Video'">
      ${video.duration ? `<span class="card-duration">${esc(video.duration)}</span>` : ""}
      <span class="card-lock-badge" id="lock-${video.id}">🔒 Watch Ad</span>
    </div>
    <div class="card-body">
      <div class="card-title">${esc(video.title)}</div>
      <div class="card-meta">
        <span class="card-category">${esc(video.category || "General")}</span>
        <span>${fmtNum(video.views)} views</span>
      </div>
    </div>`;
  div.addEventListener("click", () => renderPage("watch", { videoId: video.id }));

  // Check unlock status asynchronously
  if (APP.userDocId) {
    isVideoUnlocked(APP.userDocId, video.id).then(unlocked => {
      const badge = div.querySelector(`#lock-${video.id}`);
      if (badge) {
        badge.textContent = unlocked ? "✅ Unlocked" : "🔒 Watch Ad";
        badge.classList.toggle("unlocked", unlocked);
      }
    });
  }
  return div;
}

function renderSkeletons(n) {
  return Array(n).fill(0).map(() => `
    <div class="skeleton-card">
      <div class="skeleton skeleton-thumb"></div>
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-meta"></div>
    </div>`).join("");
}

/* ─── Infinite Scroll ─────────────────────────────────────── */
function setupInfiniteScroll() {
  const sentinel = document.getElementById("scroll-sentinel");
  if (!sentinel) return;
  const observer = new IntersectionObserver(async ([entry]) => {
    if (entry.isIntersecting && !APP.loading && APP.lastDoc) {
      APP.loading = true;
      sentinel.innerHTML = `<div class="loader-dots"><span></span><span></span><span></span></div>`;
      const more = await getVideos({ category: APP.activeCategory, limit: 12, after: APP.lastDoc });
      APP.lastDoc = more.length === 12 ? more[more.length - 1] : null;
      const grid  = document.getElementById("video-grid");
      more.forEach(v => grid.appendChild(makeVideoCard(v)));
      sentinel.innerHTML = "";
      APP.loading = false;
    }
  }, { threshold: 0.1 });
  observer.observe(sentinel);
}

/* ============================================================
   WATCH PAGE
   ============================================================ */
async function renderWatch(videoId) {
  if (!videoId) return renderPage("home");
  const watchDiv = document.getElementById("page-watch");
  watchDiv.innerHTML = `<div style="padding:40px;text-align:center">${loaderHTML()}</div>`;
  watchDiv.classList.add("active");

  try {
    const video   = await getVideo(videoId);
    APP.currentVideo = video;
    const unlocked = APP.userDocId ? await isVideoUnlocked(APP.userDocId, videoId) : false;
    const liked    = APP.userDocId ? (video.likedBy || []).includes(APP.userDocId) : false;

    watchDiv.innerHTML = buildWatchHTML(video, unlocked, liked);
    attachWatchEvents(video, unlocked);

    // Track view
    if (APP.userDocId) {
      incrementView(videoId, APP.userDocId);
      addToHistory(APP.userDocId, videoId);
    }

    // Load related videos
    loadRelated(video.category, videoId);

    // Back button
    document.getElementById("watch-back")?.addEventListener("click", () => history.back());
    window.history.pushState({ page: "watch", videoId }, "", "?v=" + videoId);
  } catch (e) {
    watchDiv.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger)">
      Error loading video. <button class="btn btn-glass btn-sm" onclick="renderPage('home')">Go Home</button>
    </div>`;
  }
}

function buildWatchHTML(video, unlocked, liked) {
  return `
  <div class="watch-page">
    <!-- Back -->
    <div style="padding:12px;display:flex;align-items:center;gap:10px">
      <button id="watch-back" style="color:var(--text-secondary);font-size:22px;background:none;border:none;cursor:pointer">‹</button>
      <span class="truncate" style="font-size:14px;font-weight:600">${esc(video.title)}</span>
    </div>

    <!-- Player -->
    <div class="player-wrapper" id="player-wrapper">
      ${unlocked
        ? `<iframe src="${esc(video.embedUrl)}" allowfullscreen allow="autoplay; encrypted-media" id="player-iframe"></iframe>`
        : `<iframe src="${esc(video.thumbUrl)}" id="player-iframe" class="player-blur" style="pointer-events:none;aspect-ratio:16/9;width:100%;object-fit:cover;border:none"></iframe>
           <div class="ad-lock-overlay" id="ad-lock">
             <div class="lock-icon">🔒</div>
             <h3>Watch an Ad to Unlock</h3>
             <p>This video is locked. Watch a short ad to unlock it for 24 hours.</p>
             <button class="btn btn-primary" id="btn-watch-ad">▶ Watch Ad to Unlock</button>
             ${!APP.currentUser ? `<p style="font-size:11px;color:var(--danger)">Please sign in via Telegram first.</p>` : ""}
           </div>`}
    </div>

    <!-- Info -->
    <div class="video-info">
      <div class="video-title">${esc(video.title)}</div>
      <div class="video-stats">
        <span>👁 ${fmtNum(video.views)} views</span>
        <span>❤️ ${fmtNum(video.likes)} likes</span>
        <span>${esc(video.category || "General")}</span>
      </div>

      <!-- Action row -->
      <div class="action-row">
        <button class="action-btn${liked ? " liked" : ""}" id="btn-like">
          ${liked ? "❤️" : "🤍"} <span id="like-count">${fmtNum(video.likes)}</span>
        </button>
        <button class="action-btn" id="btn-share">🔗 Share</button>
        <button class="action-btn" id="btn-fav">⭐ Save</button>
        <button class="action-btn" id="btn-report">⚑ Report</button>
      </div>

      <!-- Description -->
      <div class="video-description desc-collapsed" id="video-desc">
        ${esc(video.description || "No description.")}
      </div>
      <button class="btn btn-glass btn-sm mt-8" id="btn-desc-toggle">Show more</button>

      <!-- Tags -->
      ${(video.tags||[]).length ? `
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px">
        ${video.tags.map(t=>`<span class="pill" style="padding:4px 10px;font-size:11px">#${esc(t)}</span>`).join("")}
      </div>` : ""}

      <!-- Related -->
      <div class="section-header mt-16">
        <span class="section-title">Related Videos</span>
      </div>
      <div id="related-grid" class="video-grid">${renderSkeletons(4)}</div>
    </div>
  </div>`;
}

function attachWatchEvents(video, unlocked) {
  // Like
  document.getElementById("btn-like")?.addEventListener("click", async () => {
    if (!APP.currentUser) { showToast("Sign in to like", "error"); return; }
    const nowLiked = await toggleLike(video.id, APP.userDocId);
    const btn = document.getElementById("btn-like");
    const cnt = document.getElementById("like-count");
    btn.classList.toggle("liked", nowLiked);
    btn.innerHTML = (nowLiked ? "❤️" : "🤍") + ` <span id="like-count">${parseInt(cnt.textContent.replace(/[^0-9]/g,"")) + (nowLiked?1:-1)}</span>`;
    showToast(nowLiked ? "Liked! ❤️" : "Unliked", "info");
  });

  // Share
  document.getElementById("btn-share")?.addEventListener("click", () => {
    const url = location.href;
    if (navigator.share) {
      navigator.share({ title: video.title, url });
    } else if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.openTelegramLink("https://t.me/share/url?url=" + encodeURIComponent(url) + "&text=" + encodeURIComponent(video.title));
    } else {
      navigator.clipboard.writeText(url);
      showToast("Link copied! 📋", "success");
    }
  });

  // Favorite
  document.getElementById("btn-fav")?.addEventListener("click", async () => {
    if (!APP.currentUser) { showToast("Sign in first", "error"); return; }
    const saved = await toggleFavorite(APP.userDocId, video.id);
    showToast(saved ? "Added to Favorites ⭐" : "Removed from Favorites", "info");
  });

  // Description toggle
  const desc = document.getElementById("video-desc");
  document.getElementById("btn-desc-toggle")?.addEventListener("click", () => {
    desc.classList.toggle("desc-collapsed");
    document.getElementById("btn-desc-toggle").textContent = desc.classList.contains("desc-collapsed") ? "Show more" : "Show less";
  });

  // Ad unlock button
  if (!unlocked) {
    document.getElementById("btn-watch-ad")?.addEventListener("click", () => {
      if (!APP.currentUser) {
        showToast("Please open this app via Telegram to sign in.", "error");
        return;
      }
      triggerMonetag(video.id);
    });
  }
}

async function loadRelated(category, excludeId) {
  try {
    const videos = await getVideos({ category, limit: 6 });
    const filtered = videos.filter(v => v.id !== excludeId);
    const grid = document.getElementById("related-grid");
    if (!grid) return;
    grid.innerHTML = "";
    filtered.forEach(v => grid.appendChild(makeVideoCard(v)));
    if (filtered.length === 0) grid.innerHTML = `<p class="text-muted">No related videos.</p>`;
  } catch {}
}

/* ============================================================
   MONETAG AD UNLOCK
   ============================================================ */
function triggerMonetag(videoId) {
  const btn = document.getElementById("btn-watch-ad");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Loading Ad…"; }
  showToast("Loading ad, please wait…", "info");

  // ── Option A: Monetag Rewarded (Onclick / Popunder) ──────────
  // This fires a rewarded ad. On completion we call onAdComplete.
  // Replace with actual Monetag SDK call per your plan.

  if (typeof window._mntgQ !== "undefined") {
    // Monetag SDK present — call rewarded show
    window._mntgQ.push({
      type: "rewarded",
      zoneId: MONETAG.zoneId,
      onComplete: () => onAdComplete(videoId),
      onError:    () => {
        showToast("Ad failed to load. Try again.", "error");
        if (btn) { btn.disabled = false; btn.textContent = "▶ Watch Ad to Unlock"; }
      }
    });
  } else {
    // ── Option B: Fallback — load Monetag script dynamically ──
    const script = document.createElement("script");
    script.src   = `https://greedyfor.com/400/${MONETAG.zoneId}`;
    script.async = true;

    // We give the user 8 seconds to interact with the ad popup
    script.onload = () => {
      showToast("Ad opened! Come back after watching.", "info");
      // Listen for page visibility to detect ad return
      let returned = false;
      const visHandler = async () => {
        if (document.visibilityState === "visible" && !returned) {
          returned = true;
          document.removeEventListener("visibilitychange", visHandler);
          // Simulate 3 second ad view before granting unlock
          await new Promise(r => setTimeout(r, 2000));
          onAdComplete(videoId);
        }
      };
      document.addEventListener("visibilitychange", visHandler);
      // Failsafe: auto-unlock after 12s (adjust per ad length)
      setTimeout(() => {
        if (!returned) { returned = true; onAdComplete(videoId); }
      }, 12000);
    };
    script.onerror = () => {
      showToast("Ad network unavailable. Try again later.", "error");
      if (btn) { btn.disabled = false; btn.textContent = "▶ Watch Ad to Unlock"; }
    };
    document.body.appendChild(script);
  }
}

async function onAdComplete(videoId) {
  try {
    await unlockVideo(APP.userDocId, videoId);
    showToast("🎉 Video unlocked for 24 hours!", "success");

    // Swap iframe to real player, remove lock overlay
    const wrapper = document.getElementById("player-wrapper");
    const video   = APP.currentVideo;
    if (wrapper && video) {
      wrapper.innerHTML = `<iframe src="${esc(video.embedUrl)}" allowfullscreen allow="autoplay; encrypted-media"></iframe>`;
    }
    document.getElementById("ad-lock")?.remove();

    // Update lock badge in home grid if visible
    const badge = document.querySelector(`#lock-${videoId}`);
    if (badge) { badge.textContent = "✅ Unlocked"; badge.classList.add("unlocked"); }
  } catch (e) {
    showToast("Unlock failed. " + e.message, "error");
  }
}

/* ============================================================
   SEARCH PAGE
   ============================================================ */
function renderSearch() {
  const input = document.getElementById("search-input");
  const grid  = document.getElementById("search-results");
  if (!input) return;
  input.value = "";
  if (grid) grid.innerHTML = `<p class="text-muted text-center" style="padding:30px">Search for videos above</p>`;
}

function setupSearch() {
  const input = document.getElementById("search-input");
  if (!input) return;
  input.addEventListener("input", () => {
    clearTimeout(APP.searchTimeout);
    const q = input.value.trim();
    if (q.length < 2) return;
    APP.searchTimeout = setTimeout(() => doSearch(q), 400);
  });
}

async function doSearch(q) {
  const grid = document.getElementById("search-results");
  if (!grid) return;
  grid.innerHTML = renderSkeletons(4);
  const results = await searchVideos(q);
  grid.innerHTML = "";
  if (results.length === 0) {
    grid.innerHTML = `<p class="text-muted text-center" style="padding:30px;grid-column:1/-1">No results for "${esc(q)}"</p>`;
    return;
  }
  results.forEach(v => grid.appendChild(makeVideoCard(v)));
}

/* ============================================================
   PROFILE PAGE
   ============================================================ */
async function renderProfile() {
  const wrap = document.getElementById("page-profile");
  if (!wrap) return;
  if (!APP.currentUser) {
    wrap.innerHTML = `<div style="padding:40px;text-align:center">
      <p class="text-muted">Open via Telegram to sign in automatically.</p>
    </div>`;
    return;
  }
  const profile = await getUserProfile(APP.userDocId).catch(() => null);
  const name    = profile?.firstName || APP.tgUser?.first_name || "User";
  const photo   = profile?.photoUrl  || APP.tgUser?.photo_url  || "";
  const history = profile?.watchHistory || [];
  const favs    = profile?.favorites    || [];

  wrap.innerHTML = `
    <div class="profile-header">
      <img class="profile-avatar" src="${photo || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=63b3ed&color=0a0a0f&size=128`}" alt="${esc(name)}">
      <div class="profile-name">${esc(name)}</div>
      ${profile?.username ? `<div class="text-muted">@${esc(profile.username)}</div>` : ""}
      <div class="profile-stats">
        <div class="stat-item"><div class="stat-num">${history.length}</div><div class="stat-label">Watched</div></div>
        <div class="stat-item"><div class="stat-num">${favs.length}</div><div class="stat-label">Favorites</div></div>
      </div>
    </div>
    <div class="main-content">
      <div class="section-header"><span class="section-title">Watch History</span></div>
      <div id="history-grid" class="video-grid">${renderSkeletons(4)}</div>
      <div class="section-header mt-16"><span class="section-title">Favorites</span></div>
      <div id="favs-grid" class="video-grid">${renderSkeletons(4)}</div>
    </div>`;

  // Load history videos
  loadVideoList(history.slice(-12).reverse(), "history-grid");
  loadVideoList(favs.slice(-12).reverse(), "favs-grid");
}

async function loadVideoList(ids, gridId) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  if (ids.length === 0) { grid.innerHTML = `<p class="text-muted" style="grid-column:1/-1">Nothing here yet.</p>`; return; }
  const videos = await Promise.all(ids.map(id => getVideo(id).catch(() => null)));
  grid.innerHTML = "";
  videos.filter(Boolean).forEach(v => grid.appendChild(makeVideoCard(v)));
}

async function renderFavorites() {
  const wrap = document.getElementById("page-favorites");
  if (!wrap) return;
  wrap.innerHTML = `<div class="main-content"><div class="section-header"><span class="section-title">My Favorites</span></div><div id="favs-main-grid" class="video-grid">${renderSkeletons(4)}</div></div>`;
  if (!APP.userDocId) { wrap.innerHTML = `<p class="text-muted text-center" style="padding:40px">Sign in to see favorites.</p>`; return; }
  const profile = await getUserProfile(APP.userDocId).catch(() => null);
  const favs = profile?.favorites || [];
  loadVideoList(favs.slice(-20).reverse(), "favs-main-grid");
}

/* ============================================================
   UTILITIES
   ============================================================ */
function showToast(msg, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const icons = { success: "✅", error: "❌", info: "ℹ️" };
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]||""}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function esc(str) {
  return String(str || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function fmtNum(n = 0) {
  if (n >= 1e6) return (n/1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n/1e3).toFixed(1) + "K";
  return String(n);
}

function loaderHTML() {
  return `<div class="loader-dots"><span></span><span></span><span></span></div>`;
}

// Handle browser back/forward
window.addEventListener("popstate", (e) => {
  const params = new URLSearchParams(location.search);
  const videoId = params.get("v");
  if (videoId) renderPage("watch", { videoId });
  else renderPage("home");
});

// Handle initial URL with ?v=xxx
window.addEventListener("load", () => {
  const params = new URLSearchParams(location.search);
  const videoId = params.get("v");
  if (videoId) renderPage("watch", { videoId });
});
