const STATUS_URL = "data/status.json";
const CHANNELS_URL = "channels.json";
const POLL_INTERVAL_MS = 60_000;
const HIDDEN_KEY = "liveWall.hiddenChannelIds";
const ORDER_KEY = "liveWall.cardOrder";
const TRANSCRIPT_KEY = "liveWall.transcript";
const GITHUB_TOKEN_KEY = "liveWall.githubToken";
const YOUTUBE_API_KEY_KEY = "liveWall.youtubeApiKey";
const BASE_TITLE = "Airwave · Live Monitor Wall";
const SWEEP_REQUEST_PATH = ".sweep-request";
const EMBED_ORIGIN = "https://www.youtube-nocookie.com";

let lastLiveIds = new Set();
let lastStatus = null;
let audioFocusId = null;
let unmuteCampaign = 0;

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function base64ToUtf8(str) {
  return decodeURIComponent(escape(atob(str)));
}

function getGithubToken() {
  return localStorage.getItem(GITHUB_TOKEN_KEY) || "";
}

function getYoutubeApiKey() {
  return localStorage.getItem(YOUTUBE_API_KEY_KEY) || "";
}

function setCredentials(token, key) {
  if (token) localStorage.setItem(GITHUB_TOKEN_KEY, token);
  if (key) localStorage.setItem(YOUTUBE_API_KEY_KEY, key);
}

function clearCredentials() {
  localStorage.removeItem(GITHUB_TOKEN_KEY);
  localStorage.removeItem(YOUTUBE_API_KEY_KEY);
}

function repoInfo() {
  const owner = location.hostname.split(".")[0];
  const repo = location.pathname.split("/").filter(Boolean)[0] || "";
  return { owner, repo };
}

async function githubApiRequest(path, options = {}) {
  const token = getGithubToken();
  if (!token) throw new Error("No GitHub token saved. Add one in the Connection section.");
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      if (body.message) detail = `: ${body.message}`;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(`GitHub API ${res.status}${detail}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function fetchChannelsFile() {
  const { owner, repo } = repoInfo();
  const data = await githubApiRequest(`/repos/${owner}/${repo}/contents/channels.json`);
  return { sha: data.sha, json: JSON.parse(base64ToUtf8(data.content)) };
}

async function writeChannelsFile(json, sha, message) {
  const { owner, repo } = repoInfo();
  const content = utf8ToBase64(JSON.stringify(json, null, 2) + "\n");
  return githubApiRequest(`/repos/${owner}/${repo}/contents/channels.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, content, sha }),
  });
}

function normalizeHandle(raw) {
  const trimmed = raw.trim();
  const urlMatch = trimmed.match(/youtube\.com\/@([\w.-]+)/i);
  const bare = urlMatch ? urlMatch[1] : trimmed.replace(/^@+/, "");
  return `@${bare}`;
}

async function resolveHandle(rawHandle) {
  const key = getYoutubeApiKey();
  if (!key) throw new Error("No YouTube API key saved. Add one in the Connection section.");
  const handle = normalizeHandle(rawHandle);
  if (handle === "@") throw new Error("Enter a channel handle, e.g. @somechannel.");

  const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=${encodeURIComponent(
    handle.slice(1)
  )}&key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error?.message || `YouTube API ${res.status}`);
  }
  const item = body.items?.[0];
  if (!item) throw new Error(`No channel found for ${handle}.`);
  return { channelId: item.id, name: item.snippet.title, handle };
}

function slugify(handle, existingIds) {
  const base =
    handle
      .replace(/^@/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "channel";
  let candidate = base;
  let n = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}-${n}`;
    n++;
  }
  return candidate;
}

const grid = document.getElementById("grid");
const emptyState = document.getElementById("empty-state");
const lastCheckedEl = document.getElementById("last-checked");
const healthSummaryEl = document.getElementById("health-summary");
const healthDetailEl = document.getElementById("health-detail");
const hiddenListEl = document.getElementById("hidden-list");
const trackedListEl = document.getElementById("tracked-list");
const settingsPanel = document.getElementById("settings-panel");
const settingsBackdrop = document.getElementById("settings-backdrop");
const onairLamp = document.getElementById("onair-lamp");
const onairText = document.getElementById("onair-text");
const sweepBtn = document.getElementById("sweep-now");
const connectSummaryEl = document.getElementById("connect-summary");
const connectFormEl = document.getElementById("connect-form");
const connectTokenPreviewEl = document.getElementById("connect-token-preview");
const connectKeyStatusEl = document.getElementById("connect-key-status");
const disconnectBtn = document.getElementById("disconnect-btn");
const githubTokenInput = document.getElementById("github-token-input");
const youtubeKeyInput = document.getElementById("youtube-key-input");
const saveCredentialsBtn = document.getElementById("save-credentials-btn");
const connectStatusEl = document.getElementById("connect-status");
const addHandleInput = document.getElementById("add-handle-input");
const addChannelBtn = document.getElementById("add-channel-btn");
const addChannelStatusEl = document.getElementById("add-channel-status");

function setFormStatus(el, message, kind) {
  el.textContent = message;
  el.classList.remove("error", "success");
  if (kind) el.classList.add(kind);
}

function maskToken(token) {
  if (token.length <= 4) return "****";
  return `****${token.slice(-4)}`;
}

function renderConnectSection() {
  const token = getGithubToken();
  const key = getYoutubeApiKey();
  const connected = Boolean(token);

  connectSummaryEl.hidden = !connected;
  connectFormEl.hidden = connected;

  if (connected) {
    connectTokenPreviewEl.textContent = maskToken(token);
    connectKeyStatusEl.textContent = key ? "set" : "not set";
  }
}

function scrollToConnect() {
  document.getElementById("connect-section").scrollIntoView({ behavior: "smooth" });
}

saveCredentialsBtn.addEventListener("click", () => {
  const token = githubTokenInput.value.trim();
  const key = youtubeKeyInput.value.trim();
  if (!token && !key) {
    setFormStatus(connectStatusEl, "Enter at least a GitHub token.", "error");
    return;
  }
  setCredentials(token, key);
  githubTokenInput.value = "";
  youtubeKeyInput.value = "";
  setFormStatus(connectStatusEl, "Saved.", "success");
  renderConnectSection();
});

// Credentials also save without the Save click: on blur/Enter of each field,
// and any action that needs them adopts whatever is typed but unsaved —
// pasting a token and going straight to "Sweep now" used to silently lose it.
function adoptPendingCredentials() {
  const token = githubTokenInput.value.trim();
  const key = youtubeKeyInput.value.trim();
  if (!token && !key) return;
  setCredentials(token, key);
  githubTokenInput.value = "";
  youtubeKeyInput.value = "";
  setFormStatus(connectStatusEl, "Saved.", "success");
  renderConnectSection();
}

githubTokenInput.addEventListener("change", () => {
  const v = githubTokenInput.value.trim();
  if (!v) return;
  localStorage.setItem(GITHUB_TOKEN_KEY, v);
  setFormStatus(connectStatusEl, "GitHub token saved ✓", "success");
});

youtubeKeyInput.addEventListener("change", () => {
  const v = youtubeKeyInput.value.trim();
  if (!v) return;
  localStorage.setItem(YOUTUBE_API_KEY_KEY, v);
  setFormStatus(connectStatusEl, "YouTube key saved ✓", "success");
});

for (const input of [githubTokenInput, youtubeKeyInput]) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      input.blur(); // fires the change handler above
      adoptPendingCredentials();
    }
  });
}

disconnectBtn.addEventListener("click", () => {
  clearCredentials();
  setFormStatus(connectStatusEl, "", null);
  renderConnectSection();
});

async function addChannel() {
  adoptPendingCredentials();
  const rawHandle = addHandleInput.value.trim();
  if (!getGithubToken() || !getYoutubeApiKey()) {
    setFormStatus(addChannelStatusEl, "Add both credentials in the Connection section first.", "error");
    scrollToConnect();
    return;
  }
  if (!rawHandle) {
    setFormStatus(addChannelStatusEl, "Enter a channel handle first.", "error");
    return;
  }

  addChannelBtn.disabled = true;
  setFormStatus(addChannelStatusEl, `Looking up ${rawHandle}…`, null);

  try {
    const resolved = await resolveHandle(rawHandle);
    const { sha, json } = await fetchChannelsFile();

    if (json.channels.some((c) => c.channelId === resolved.channelId)) {
      setFormStatus(addChannelStatusEl, `${resolved.name} is already tracked.`, "error");
      return;
    }

    const existingIds = new Set(json.channels.map((c) => c.id));
    const newChannel = {
      id: slugify(resolved.handle, existingIds),
      name: resolved.name,
      channelId: resolved.channelId,
      enabled: true,
    };
    json.channels.push(newChannel);

    setFormStatus(addChannelStatusEl, `Adding ${resolved.name}…`, null);
    await writeChannelsFile(json, sha, `chore: add channel (${resolved.name})`);

    channelsConfigCache = json.channels;
    renderTrackedList(channelsConfigCache, lastLiveIds);
    addHandleInput.value = "";
    setFormStatus(
      addChannelStatusEl,
      `Added ${resolved.name}. It'll appear on the wall within a sweep or two of going live.`,
      "success"
    );
  } catch (err) {
    setFormStatus(addChannelStatusEl, err.message, "error");
  } finally {
    addChannelBtn.disabled = false;
  }
}

addChannelBtn.addEventListener("click", addChannel);
addHandleInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addChannel();
});

function getHiddenIds() {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function setHiddenIds(set) {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set]));
}

function hideChannel(id) {
  const hidden = getHiddenIds();
  hidden.add(id);
  setHiddenIds(hidden);
  renderFromCache();
}

function restoreChannel(id) {
  const hidden = getHiddenIds();
  hidden.delete(id);
  setHiddenIds(hidden);
  renderFromCache();
}

function embedUrl(videoId) {
  const origin = encodeURIComponent(location.origin);
  return `${EMBED_ORIGIN}/embed/${videoId}?autoplay=1&mute=1&rel=0&modestbranding=1&playsinline=1&enablejsapi=1&origin=${origin}`;
}

function formatTime(iso) {
  if (!iso) return "never checked yet";
  const d = new Date(iso);
  return `last sweep ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function updateOnAir(liveCount) {
  if (liveCount > 0) {
    onairLamp.classList.add("on");
    onairText.textContent = liveCount === 1 ? "ON AIR" : `ON AIR · ${liveCount}`;
    document.title = `● ${liveCount} live — ${BASE_TITLE}`;
  } else {
    onairLamp.classList.remove("on");
    onairText.textContent = "STANDBY";
    document.title = BASE_TITLE;
  }
}

/* ---------- Player control (mute/unmute via the YouTube iframe API) ---------- */

function sendPlayerCommand(iframe, func, args = []) {
  iframe?.contentWindow?.postMessage(
    JSON.stringify({ event: "command", func, args }),
    EMBED_ORIGIN
  );
}

// The embed takes a few seconds to boot, so a single unMute would get lost.
// Keep nudging the focused player until it's audible (or focus moves on).
function beginUnmuteCampaign(card) {
  const token = ++unmuteCampaign;
  const id = card.dataset.channelId;
  let attempts = 0;
  const tick = () => {
    if (token !== unmuteCampaign || audioFocusId !== id) return;
    const iframe = card.isConnected ? card.querySelector("iframe") : null;
    if (iframe) {
      sendPlayerCommand(iframe, "unMute");
      sendPlayerCommand(iframe, "setVolume", [100]);
    }
    if (++attempts < 14) setTimeout(tick, 700);
  };
  tick();
}

function clearAudio() {
  audioFocusId = null;
  unmuteCampaign++;
  for (const card of grid.querySelectorAll(".card")) {
    card.classList.remove("audio");
    sendPlayerCommand(card.querySelector("iframe"), "mute");
    refreshCardButtons(card);
  }
}

// The Listen button toggles: clicking the card that already has audio mutes
// everything instead of being a no-op.
function toggleAudio(id) {
  if (audioFocusId === id) clearAudio();
  else setAudio(id);
}

function setAudio(id) {
  audioFocusId = id;
  for (const card of grid.querySelectorAll(".card")) {
    const isTarget = card.dataset.channelId === id;
    card.classList.toggle("audio", isTarget);
    if (!isTarget) {
      sendPlayerCommand(card.querySelector("iframe"), "mute");
    } else {
      if (!card.classList.contains("playing")) startPlaying(card);
      beginUnmuteCampaign(card);
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    refreshCardButtons(card);
  }
}

function clearAudioIfCard(card) {
  if (audioFocusId === card.dataset.channelId) {
    audioFocusId = null;
    unmuteCampaign++;
    card.classList.remove("audio");
  }
}

// Arrow-key spatial navigation: pick the nearest card whose center lies in
// the pressed direction, favoring same-row/column neighbors.
function moveAudio(dir) {
  const cards = [...grid.querySelectorAll(".card:not(.leaving)")];
  if (cards.length === 0) return;
  const current = audioFocusId
    ? cards.find((c) => c.dataset.channelId === audioFocusId)
    : null;
  if (!current) {
    setAudio(cards[0].dataset.channelId);
    return;
  }
  const cr = current.getBoundingClientRect();
  const cx = cr.left + cr.width / 2;
  const cy = cr.top + cr.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const card of cards) {
    if (card === current) continue;
    const r = card.getBoundingClientRect();
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    let primary;
    let secondary;
    if (dir === "left") { if (dx >= -4) continue; primary = -dx; secondary = Math.abs(dy); }
    else if (dir === "right") { if (dx <= 4) continue; primary = dx; secondary = Math.abs(dy); }
    else if (dir === "up") { if (dy >= -4) continue; primary = -dy; secondary = Math.abs(dx); }
    else { if (dy <= 4) continue; primary = dy; secondary = Math.abs(dx); }
    const score = primary + secondary * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = card;
    }
  }
  if (best) setAudio(best.dataset.channelId);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSettings();
    return;
  }
  const dirs = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  const dir = dirs[e.key];
  if (!dir) return;
  if (settingsPanel.classList.contains("open")) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  e.preventDefault();
  moveAudio(dir);
});

/* ---------- Drag-to-rearrange ----------
   Cards are repositioned with CSS `order`, never by moving DOM nodes —
   reparenting an <iframe> reloads it, which would restart playing feeds. */

function getCardOrder() {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setCardOrder(ids) {
  localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
}

function applyCardOrder() {
  const saved = getCardOrder();
  const pos = new Map(saved.map((id, i) => [id, i]));
  let next = saved.length;
  for (const card of grid.querySelectorAll(".card")) {
    const id = card.dataset.channelId;
    card.style.order = pos.has(id) ? pos.get(id) : next++;
  }
}

function orderedVisibleIds() {
  return [...grid.querySelectorAll(".card:not(.leaving)")]
    .sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0))
    .map((c) => c.dataset.channelId);
}

let drag = null;

function startDrag(e, card, handle) {
  if (drag || e.button > 0) return;
  e.preventDefault();
  const rect = card.getBoundingClientRect();
  drag = {
    card,
    handle,
    pointerId: e.pointerId,
    offX: e.clientX - rect.left,
    offY: e.clientY - rect.top,
    lastUnder: null,
  };
  card.classList.add("dragging");
  try {
    handle.setPointerCapture(e.pointerId);
  } catch {
    // capture can fail for already-released pointers; drag still works while
    // the pointer stays over the handle
  }
  handle.addEventListener("pointermove", onDragMove);
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { card } = drag;
  // Measure the card's untransformed slot so the float tracks the pointer
  // even after a live reorder moves the slot.
  const prev = card.style.transform;
  card.style.transform = "none";
  const base = card.getBoundingClientRect();
  card.style.transform = prev;
  const tx = e.clientX - drag.offX - base.left;
  const ty = e.clientY - drag.offY - base.top;
  card.style.transform = `translate(${tx}px, ${ty}px) scale(1.03)`;

  const under = document
    .elementsFromPoint(e.clientX, e.clientY)
    .find((el) => el.classList && el.classList.contains("card") && el !== card && !el.classList.contains("leaving"));
  if (under && under !== drag.lastUnder) {
    drag.lastUnder = under;
    reorderAround(card, under);
  } else if (!under) {
    drag.lastUnder = null;
  }
}

function reorderAround(card, under) {
  const ids = orderedVisibleIds();
  const from = ids.indexOf(card.dataset.channelId);
  const to = ids.indexOf(under.dataset.channelId);
  if (from === -1 || to === -1 || from === to) return;
  ids.splice(from, 1);
  ids.splice(to, 0, card.dataset.channelId);
  ids.forEach((id, i) => {
    const el = grid.querySelector(`.card[data-channel-id="${CSS.escape(id)}"]`);
    if (el) el.style.order = i;
  });
}

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { card, handle } = drag;
  handle.removeEventListener("pointermove", onDragMove);
  handle.removeEventListener("pointerup", endDrag);
  handle.removeEventListener("pointercancel", endDrag);
  card.classList.remove("dragging");
  card.style.transform = "";
  // Persist: current visible order first, then remembered channels that
  // aren't on the wall right now keep their old relative slots after it.
  const visibleOrder = orderedVisibleIds();
  const merged = visibleOrder.concat(getCardOrder().filter((id) => !visibleOrder.includes(id)));
  setCardOrder(merged);
  drag = null;
}

/* ---------- Cards ---------- */

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.52.86l10.5-6.5a1 1 0 0 0 0-1.72L9.52 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>',
  speaker:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a3.5 3.5 0 0 0-2-3.16v6.32a3.5 3.5 0 0 0 2-3.16zm-2-8.14v2.06A6.5 6.5 0 0 1 19 12a6.5 6.5 0 0 1-4.5 6.08v2.06A8.5 8.5 0 0 0 21 12a8.5 8.5 0 0 0-6.5-8.14z"/></svg>',
  hide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 6c4.7 0 8.6 2.9 10 7-.5 1.4-1.3 2.7-2.3 3.7l-1.5-1.5c.7-.7 1.3-1.4 1.7-2.2A9 9 0 0 0 12 8c-.7 0-1.4.1-2.1.2L8.3 6.6C9.5 6.2 10.7 6 12 6zM3.3 4.3l16.4 16.4-1.4 1.4-2.7-2.7c-1.1.4-2.3.6-3.6.6-4.7 0-8.6-2.9-10-7 .6-1.7 1.6-3.2 2.9-4.3L1.9 5.7l1.4-1.4zM12 18c.6 0 1.2-.1 1.8-.2l-1.6-1.6a3.5 3.5 0 0 1-3.4-3.4L6.3 10.3c-1 .8-1.8 1.7-2.3 2.7 1.4 3 4.4 5 8 5zm3.5-6.2-3.3-3.3h-.2a3.5 3.5 0 0 1 3.5 3.3z"/></svg>',
  drag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 7h16v2H4zm0 4h16v2H4zm0 4h16v2H4z"/></svg>',
};

function startPlaying(card) {
  if (card.classList.contains("playing")) return;
  const stage = card.querySelector(".card-stage");
  const iframe = document.createElement("iframe");
  iframe.src = embedUrl(card.dataset.videoId);
  iframe.title = card.dataset.name;
  iframe.allow =
    "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
  iframe.allowFullscreen = true;
  stage.appendChild(iframe);
  card.classList.add("playing");
  refreshCardButtons(card);
}

function stopPlaying(card) {
  const iframe = card.querySelector("iframe");
  if (iframe) iframe.remove();
  card.classList.remove("playing");
  clearAudioIfCard(card);
  refreshCardButtons(card);
}

function refreshCardButtons(card) {
  const listenBtn = card.querySelector(".card-listen");
  const hasAudio = card.classList.contains("audio");
  if (listenBtn) {
    listenBtn.classList.toggle("active", hasAudio);
    listenBtn.querySelector(".btn-text").textContent = hasAudio ? "Audio on" : "Listen";
    listenBtn.title = hasAudio
      ? "This feed has the audio — click again to mute"
      : "Play this feed's audio (mutes the others)";
  }
}

function buildCard(channel) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.channelId = channel.id;
  card.dataset.videoId = channel.videoId || "";
  card.dataset.name = channel.name;

  const stage = document.createElement("div");
  stage.className = "card-stage";

  const poster = document.createElement("button");
  poster.className = "card-poster";
  poster.type = "button";
  if (channel.thumbnail) poster.style.backgroundImage = `url("${channel.thumbnail}")`;
  const posterBadge = document.createElement("span");
  posterBadge.className = "poster-badge";
  posterBadge.innerHTML = `${ICONS.play}<span>PLAY FEED</span>`;
  poster.appendChild(posterBadge);
  poster.addEventListener("click", () => startPlaying(card));
  stage.appendChild(poster);

  const dragHandle = document.createElement("button");
  dragHandle.className = "card-drag";
  dragHandle.type = "button";
  dragHandle.title = "Drag to rearrange";
  dragHandle.setAttribute("aria-label", "Drag to rearrange");
  dragHandle.innerHTML = ICONS.drag;
  dragHandle.addEventListener("pointerdown", (e) => startDrag(e, card, dragHandle));
  stage.appendChild(dragHandle);

  const body = document.createElement("div");
  body.className = "card-body";

  const info = document.createElement("div");
  info.className = "card-info";

  const channelLine = document.createElement("div");
  channelLine.className = "card-channel";
  const chip = document.createElement("span");
  chip.className = "live-chip";
  const chipDot = document.createElement("span");
  chipDot.className = "live-chip-dot";
  chip.append(chipDot, document.createTextNode("LIVE"));
  const nameEl = document.createElement("span");
  nameEl.className = "channel-name";
  nameEl.textContent = channel.name;
  channelLine.append(chip, nameEl);

  const titleLine = document.createElement("div");
  titleLine.className = "card-title";
  titleLine.textContent = channel.title || "";
  titleLine.title = channel.title || "";
  info.append(channelLine, titleLine);

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const listenBtn = document.createElement("button");
  listenBtn.className = "card-action card-listen";
  listenBtn.type = "button";
  listenBtn.innerHTML = `${ICONS.speaker}<span class="btn-text">Listen</span>`;
  listenBtn.addEventListener("click", () => toggleAudio(channel.id));

  const stopBtn = document.createElement("button");
  stopBtn.className = "card-action card-stop";
  stopBtn.type = "button";
  stopBtn.title = "Stop this feed (stays on the wall as a preview)";
  stopBtn.innerHTML = `${ICONS.stop}<span class="btn-text">Stop</span>`;
  stopBtn.addEventListener("click", () => stopPlaying(card));

  const hideBtn = document.createElement("button");
  hideBtn.className = "card-action card-hide";
  hideBtn.type = "button";
  hideBtn.title = "Remove from the wall until restored from Settings";
  hideBtn.innerHTML = `${ICONS.hide}<span class="btn-text">Hide</span>`;
  hideBtn.addEventListener("click", () => hideChannel(channel.id));

  actions.append(listenBtn, stopBtn, hideBtn);
  body.append(info, actions);
  card.append(stage, body);
  refreshCardButtons(card);
  return card;
}

function updateCard(card, channel) {
  // Only touch the player if the stream itself changed, so a playing embed
  // is never restarted by the 60s poll.
  if (card.dataset.videoId !== (channel.videoId || "")) {
    card.dataset.videoId = channel.videoId || "";
    const poster = card.querySelector(".card-poster");
    if (poster && channel.thumbnail) poster.style.backgroundImage = `url("${channel.thumbnail}")`;
    const iframe = card.querySelector("iframe");
    if (iframe) {
      iframe.src = embedUrl(channel.videoId);
      if (audioFocusId === channel.id) beginUnmuteCampaign(card);
    }
  }
  if (card.dataset.name !== channel.name) {
    card.dataset.name = channel.name;
    const nameEl = card.querySelector(".channel-name");
    if (nameEl) nameEl.textContent = channel.name;
  }
  const titleLine = card.querySelector(".card-title");
  const title = channel.title || "";
  if (titleLine && titleLine.textContent !== title) {
    titleLine.textContent = title;
    titleLine.title = title;
  }
}

function retireCard(card) {
  if (card.classList.contains("leaving")) return;
  clearAudioIfCard(card);
  card.classList.add("leaving");
  card.addEventListener("animationend", () => card.remove(), { once: true });
  setTimeout(() => card.remove(), 600); // fallback if animations are disabled
}

function renderCards(liveChannels, hiddenIds) {
  const visible = liveChannels.filter((c) => !hiddenIds.has(c.id));
  const wantedIds = new Set(visible.map((c) => c.id));

  for (const card of [...grid.querySelectorAll(".card")]) {
    if (!wantedIds.has(card.dataset.channelId)) retireCard(card);
  }

  for (const channel of visible) {
    const existing = grid.querySelector(
      `.card[data-channel-id="${CSS.escape(channel.id)}"]:not(.leaving)`
    );
    if (existing) updateCard(existing, channel);
    else grid.appendChild(buildCard(channel));
  }

  emptyState.hidden = visible.length > 0;
  updateOnAir(visible.length);
  applyCardOrder();
}

function renderHiddenList(allChannelsById, hiddenIds) {
  hiddenListEl.innerHTML = "";
  if (hiddenIds.size === 0) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    li.textContent = "No hidden channels.";
    hiddenListEl.appendChild(li);
    return;
  }
  for (const id of hiddenIds) {
    const channel = allChannelsById.get(id);
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = channel ? channel.name : id;
    const restoreBtn = document.createElement("button");
    restoreBtn.className = "restore-btn";
    restoreBtn.type = "button";
    restoreBtn.textContent = "Restore";
    restoreBtn.addEventListener("click", () => restoreChannel(id));
    li.append(name, restoreBtn);
    hiddenListEl.appendChild(li);
  }
}

function minutesAgo(iso) {
  if (!iso) return null;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
}

function renderHealth(health) {
  const last24h = health?.last24h ?? { runs: 0, channelChecks: 0, errors: 0 };
  const lastRun = health?.lastRun ?? null;

  let statusClass = "unknown";
  let summaryText = "no sweeps yet";
  if (lastRun) {
    const mins = minutesAgo(lastRun.at);
    const allFailed = lastRun.checked > 0 && lastRun.errors === lastRun.checked;
    statusClass = allFailed ? "bad" : lastRun.errors > 0 ? "warn" : "ok";
    summaryText = `${last24h.runs} sweeps / 24h · last ${mins}m ago`;
  }

  healthSummaryEl.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = `status-dot ${statusClass}`;
  healthSummaryEl.append(dot, document.createTextNode(summaryText));

  healthDetailEl.innerHTML = "";
  const tiles = [
    ["Sweeps · 24h", String(last24h.runs)],
    ["Channel checks · 24h", String(last24h.channelChecks)],
    ["Errors · 24h", String(last24h.errors)],
    [
      "Last run",
      lastRun ? `${minutesAgo(lastRun.at)}m ago` : "never",
      lastRun ? `${lastRun.errors}/${lastRun.checked} errors` : "",
    ],
  ];
  for (const [label, value, sub] of tiles) {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const labelEl = document.createElement("span");
    labelEl.className = "stat-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "stat-value";
    valueEl.textContent = value;
    if (sub) {
      const subEl = document.createElement("small");
      subEl.textContent = ` ${sub}`;
      valueEl.appendChild(subEl);
    }
    tile.append(labelEl, valueEl);
    healthDetailEl.appendChild(tile);
  }
}

function renderTrackedList(channelsConfig, liveIds) {
  trackedListEl.innerHTML = "";
  if (channelsConfig.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    li.textContent = "No channels tracked yet — add one above.";
    trackedListEl.appendChild(li);
    return;
  }
  for (const channel of channelsConfig) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "channel-name";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    if (!channel.enabled) dot.classList.add("disabled");
    else if (liveIds.has(channel.id)) dot.classList.add("live");
    label.appendChild(dot);
    label.appendChild(
      document.createTextNode(
        channel.name + (channel.enabled ? "" : " (disabled)")
      )
    );

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeChannel(channel));

    li.append(label, removeBtn);
    trackedListEl.appendChild(li);
  }
}

async function removeChannel(channel) {
  adoptPendingCredentials();
  if (!getGithubToken()) {
    alert("Add a GitHub token in the Connection section first.");
    scrollToConnect();
    return;
  }
  if (!confirm(`Remove "${channel.name}" from your tracked channels?`)) return;

  try {
    const { sha, json } = await fetchChannelsFile();
    json.channels = json.channels.filter((c) => c.id !== channel.id);
    await writeChannelsFile(json, sha, `chore: remove channel (${channel.name})`);
    channelsConfigCache = json.channels;
    renderTrackedList(channelsConfigCache, lastLiveIds);
  } catch (err) {
    alert(`Couldn't remove "${channel.name}": ${err.message}`);
  }
}

/* ---------- Sweep now ---------- */

// Committing a timestamp to .sweep-request (via the Contents API the token
// already has) push-triggers the checker workflow immediately — the schedule
// is best-effort, but push triggers are not.
async function requestSweep() {
  adoptPendingCredentials();
  if (!getGithubToken()) {
    openSettings();
    scrollToConnect();
    setFormStatus(
      connectStatusEl,
      "Add a GitHub token here first — the Sweep button uses it to trigger the checker.",
      "error"
    );
    return;
  }

  const label = sweepBtn.querySelector(".btn-text");
  sweepBtn.disabled = true;
  label.textContent = "Requesting…";

  try {
    const { owner, repo } = repoInfo();
    let sha;
    try {
      const cur = await githubApiRequest(`/repos/${owner}/${repo}/contents/${SWEEP_REQUEST_PATH}`);
      sha = cur.sha;
    } catch {
      // file doesn't exist yet — the PUT below creates it
    }
    await githubApiRequest(`/repos/${owner}/${repo}/contents/${SWEEP_REQUEST_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "chore: request live sweep",
        content: utf8ToBase64(new Date().toISOString() + "\n"),
        ...(sha ? { sha } : {}),
      }),
    });
    label.textContent = "Sweep queued ✓";
    // Poll faster for a few minutes so the fresh results land without waiting
    // for the next 60s tick.
    const fast = setInterval(render, 20_000);
    setTimeout(() => clearInterval(fast), 4 * 60_000);
    setTimeout(() => {
      sweepBtn.disabled = false;
      label.textContent = "Sweep now";
    }, 60_000);
  } catch (err) {
    label.textContent = "Sweep failed";
    console.error("Sweep request failed", err);
    setTimeout(() => {
      sweepBtn.disabled = false;
      label.textContent = "Sweep now";
    }, 4_000);
  }
}

sweepBtn.addEventListener("click", requestSweep);

/* ---------- Data loading ---------- */

let channelsConfigCache = null;

async function loadChannelsConfig() {
  if (channelsConfigCache) return channelsConfigCache;
  const res = await fetch(`${CHANNELS_URL}?t=${Date.now()}`);
  const data = await res.json();
  channelsConfigCache = data.channels;
  return channelsConfigCache;
}

// Re-renders everything derived from the last fetched status (used by
// hide/restore so they respond instantly without a network round-trip).
function renderFromCache() {
  if (!lastStatus || !channelsConfigCache) return;
  const hiddenIds = getHiddenIds();
  const liveChannels = lastStatus.channels.filter((c) => c.live);
  const liveIds = new Set(liveChannels.map((c) => c.id));
  lastLiveIds = liveIds;
  const allChannelsById = new Map(channelsConfigCache.map((c) => [c.id, c]));

  lastCheckedEl.textContent = formatTime(lastStatus.generatedAt);
  renderHealth(lastStatus.health);
  renderCards(liveChannels, hiddenIds);
  renderHiddenList(allChannelsById, hiddenIds);
  renderTrackedList(channelsConfigCache, liveIds);
}

async function render() {
  try {
    const [statusRes] = await Promise.all([
      fetch(`${STATUS_URL}?t=${Date.now()}`),
      loadChannelsConfig(),
    ]);
    lastStatus = await statusRes.json();
    renderFromCache();
  } catch (err) {
    console.error("Failed to load live status", err);
    lastCheckedEl.textContent = "status unavailable";
  }
}

function openSettings() {
  settingsPanel.classList.add("open");
  settingsBackdrop.classList.add("open");
}

function closeSettings() {
  settingsPanel.classList.remove("open");
  settingsBackdrop.classList.remove("open");
}

document.getElementById("open-settings").addEventListener("click", openSettings);
document.getElementById("close-settings").addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", closeSettings);

/* ---------- Live captions, transcript, digest ---------- */

const captionsPanel = document.getElementById("captions-panel");
const captionsStatusEl = document.getElementById("captions-status");
const captionsStatusText = document.getElementById("captions-status-text");
const captionsStartBtn = document.getElementById("captions-start");
const liveCaptionEl = document.getElementById("live-caption");
const transcriptLogEl = document.getElementById("transcript-log");
const digestEl = document.getElementById("digest");
const digestSummaryEl = document.getElementById("digest-summary");
const digestPointsEl = document.getElementById("digest-points");
const digestQuotesEl = document.getElementById("digest-quotes");
const digestMetaEl = document.getElementById("digest-meta");
const summarizeBtn = document.getElementById("captions-summarize");

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;
let transcript = loadTranscript();

function loadTranscript() {
  try {
    const raw = localStorage.getItem(TRANSCRIPT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTranscript() {
  try {
    // A full day of talk is well under localStorage limits; cap defensively.
    localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(transcript.slice(-4000)));
  } catch {
    // storage full — drop the oldest half and retry once
    transcript = transcript.slice(-1500);
    try {
      localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(transcript));
    } catch {}
  }
}

function currentAudioChannelName() {
  if (!audioFocusId) return null;
  const card = grid.querySelector(`.card[data-channel-id="${CSS.escape(audioFocusId)}"]`);
  return card ? card.dataset.name : null;
}

function setCaptionsStatus(text, live) {
  captionsStatusText.textContent = text;
  captionsStatusEl.classList.toggle("live", Boolean(live));
}

function segTime(t) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function appendLogEntry(seg) {
  const emptyHint = transcriptLogEl.querySelector(".transcript-empty");
  if (emptyHint) emptyHint.remove();
  const entry = document.createElement("div");
  entry.className = "transcript-entry";
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.innerHTML = `${segTime(seg.t)}${seg.ch ? ` · <span class="ch"></span>` : ""}`;
  if (seg.ch) meta.querySelector(".ch").textContent = seg.ch;
  const text = document.createElement("span");
  text.textContent = seg.text;
  entry.append(meta, text);
  const nearBottom =
    transcriptLogEl.scrollHeight - transcriptLogEl.scrollTop - transcriptLogEl.clientHeight < 80;
  transcriptLogEl.appendChild(entry);
  if (nearBottom) transcriptLogEl.scrollTop = transcriptLogEl.scrollHeight;
}

function renderTranscriptLog() {
  transcriptLogEl.innerHTML = "";
  if (transcript.length === 0) {
    const p = document.createElement("p");
    p.className = "transcript-empty";
    p.textContent =
      "Nothing recorded yet. Start captions, give one feed the audio, and everything said lands here with timestamps.";
    transcriptLogEl.appendChild(p);
    return;
  }
  for (const seg of transcript.slice(-400)) appendLogEntry(seg);
  transcriptLogEl.scrollTop = transcriptLogEl.scrollHeight;
}

function addSegment(text) {
  const cleaned = text.trim();
  if (!cleaned) return;
  const seg = { t: Date.now(), ch: currentAudioChannelName(), text: cleaned };
  transcript.push(seg);
  saveTranscript();
  appendLogEntry(seg);
}

function startCaptions() {
  if (!SpeechRec) {
    setCaptionsStatus("needs Chrome or Edge", false);
    return;
  }
  if (listening) {
    stopCaptions();
    return;
  }
  listening = true;
  recognizer = new SpeechRec();
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.lang = "en-US";

  recognizer.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) addSegment(r[0].transcript);
      else interim += r[0].transcript;
    }
    liveCaptionEl.textContent = interim.trim();
    liveCaptionEl.classList.toggle("active", interim.trim().length > 0);
  };
  recognizer.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      stopCaptions();
      setCaptionsStatus("mic blocked — allow it in the address bar", false);
    } else if (e.error === "audio-capture") {
      stopCaptions();
      setCaptionsStatus("no input device found", false);
    }
    // no-speech / network / aborted: onend fires and we restart
  };
  // Chrome ends recognition after silence or ~1 minute; keep it rolling.
  recognizer.onend = () => {
    if (listening) {
      try {
        recognizer.start();
      } catch {}
    }
  };

  try {
    recognizer.start();
    setCaptionsStatus("listening", true);
    captionsStartBtn.textContent = "Stop captions";
  } catch {
    listening = false;
    setCaptionsStatus("couldn't start", false);
  }
}

function stopCaptions() {
  listening = false;
  if (recognizer) {
    try {
      recognizer.stop();
    } catch {}
    recognizer = null;
  }
  liveCaptionEl.classList.remove("active");
  setCaptionsStatus("off", false);
  captionsStartBtn.textContent = "Start captions";
}

/* --- Digest: summary, key points, verbatim quotes --- */

const STOPWORDS = new Set(
  ("the a an and or but if then so of to in on at by for with about as is are was were be been being " +
    "this that these those it its from we you they he she i not no yes do does did have has had will " +
    "would can could should our your their them his her us my me there here what when who how why which " +
    "just going go get got like know think really very well also because been more some out up down all").split(" ")
);

function words(text) {
  return text.toLowerCase().match(/[a-z']{3,}/g) || [];
}

function scoreSentences(sentences) {
  const freq = new Map();
  for (const s of sentences) {
    for (const w of words(s.text)) {
      if (!STOPWORDS.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  for (const s of sentences) {
    const ws = words(s.text).filter((w) => !STOPWORDS.has(w));
    let sum = 0;
    for (const w of ws) sum += freq.get(w) || 0;
    s.score = ws.length ? sum / Math.sqrt(ws.length + 3) : 0;
  }
  return sentences;
}

function transcriptSentences(segs) {
  const out = [];
  for (const seg of segs) {
    for (const raw of seg.text.split(/(?<=[.!?])\s+/)) {
      const text = raw.trim();
      if (text) out.push({ text, t: seg.t, ch: seg.ch });
    }
  }
  return out;
}

function extractiveDigest(segs) {
  const sentences = scoreSentences(transcriptSentences(segs));
  const byScore = [...sentences].sort((a, b) => b.score - a.score);
  const summaryPicks = byScore
    .slice(0, 4)
    .sort((a, b) => a.t - b.t)
    .map((s) => s.text);
  const points = byScore
    .filter((s) => words(s.text).length >= 6)
    .slice(0, 6)
    .map((s) => (s.text.length > 160 ? s.text.slice(0, 157) + "…" : s.text));
  return { summary: summaryPicks.join(" "), points };
}

function extractQuotes(segs) {
  const sentences = scoreSentences(transcriptSentences(segs));
  return sentences
    .filter((s) => {
      const n = words(s.text).length;
      return n >= 8 && n <= 45;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .sort((a, b) => a.t - b.t);
}

async function chromeAiDigest(text) {
  if (!("Summarizer" in self)) return null;
  const availability = await Summarizer.availability();
  if (availability === "unavailable") return null;
  if (availability !== "available") {
    digestMetaEl.textContent = "downloading Chrome's on-device model (one time)…";
  }
  const clipped = text.slice(-16000);
  const tldr = await Summarizer.create({ type: "tldr", format: "plain-text", length: "medium" });
  const summary = await tldr.summarize(clipped);
  tldr.destroy?.();
  const kp = await Summarizer.create({ type: "key-points", format: "plain-text", length: "medium" });
  const pointsRaw = await kp.summarize(clipped);
  kp.destroy?.();
  const points = pointsRaw
    .split(/\n+/)
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
  return { summary: summary.trim(), points };
}

async function summarizeTranscript() {
  const segs = transcript.slice(-1200);
  const fullText = segs.map((s) => s.text).join(" ");
  if (words(fullText).length < 40) {
    digestEl.hidden = false;
    digestSummaryEl.textContent = "";
    digestPointsEl.innerHTML = "";
    digestQuotesEl.innerHTML = "";
    digestMetaEl.textContent = "not enough transcript yet — let it listen for a minute or two first";
    return;
  }

  summarizeBtn.disabled = true;
  summarizeBtn.textContent = "Summarizing…";
  digestEl.hidden = false;

  let digest = null;
  let engine = "local extractive";
  try {
    digest = await chromeAiDigest(fullText);
    if (digest) engine = "Chrome on-device AI";
  } catch (err) {
    console.warn("Chrome Summarizer unavailable, using local fallback", err);
  }
  if (!digest) digest = extractiveDigest(segs);

  const quotes = extractQuotes(segs);

  digestSummaryEl.textContent = digest.summary;
  digestPointsEl.innerHTML = "";
  for (const point of digest.points) {
    const li = document.createElement("li");
    li.textContent = point;
    digestPointsEl.appendChild(li);
  }
  digestQuotesEl.innerHTML = "";
  for (const q of quotes) {
    const bq = document.createElement("blockquote");
    const body = document.createElement("span");
    body.textContent = `“${q.text}”`;
    const footer = document.createElement("footer");
    footer.textContent = `${segTime(q.t)}${q.ch ? ` · ${q.ch}` : ""}`;
    bq.append(body, footer);
    digestQuotesEl.appendChild(bq);
  }

  const spanMins = Math.max(1, Math.round((segs[segs.length - 1].t - segs[0].t) / 60000));
  digestMetaEl.textContent = `covers ~${spanMins} min of transcript · ${engine} · quotes are verbatim from the transcript`;
  summarizeBtn.disabled = false;
  summarizeBtn.textContent = "Summarize";
}

function downloadTranscript() {
  if (transcript.length === 0) return;
  const lines = transcript.map(
    (s) => `[${new Date(s.t).toLocaleString()}]${s.ch ? ` ${s.ch}:` : ""} ${s.text}`
  );
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `airwave-transcript-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function clearTranscript() {
  if (transcript.length && !confirm("Erase the recorded transcript?")) return;
  transcript = [];
  saveTranscript();
  digestEl.hidden = true;
  renderTranscriptLog();
}

function openCaptions() {
  captionsPanel.classList.add("open");
  document.body.classList.add("captions-open");
}

function closeCaptions() {
  captionsPanel.classList.remove("open");
  document.body.classList.remove("captions-open");
}

document.getElementById("toggle-captions").addEventListener("click", () => {
  if (captionsPanel.classList.contains("open")) closeCaptions();
  else openCaptions();
});
document.getElementById("close-captions").addEventListener("click", closeCaptions);
captionsStartBtn.addEventListener("click", startCaptions);
summarizeBtn.addEventListener("click", summarizeTranscript);
document.getElementById("captions-download").addEventListener("click", downloadTranscript);
document.getElementById("captions-clear").addEventListener("click", clearTranscript);
renderTranscriptLog();

renderConnectSection();
render();
setInterval(render, POLL_INTERVAL_MS);
