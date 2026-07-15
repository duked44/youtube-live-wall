const STATUS_URL = "data/status.json";
const CHANNELS_URL = "channels.json";
const POLL_INTERVAL_MS = 60_000;
const HIDDEN_KEY = "liveWall.hiddenChannelIds";
const GITHUB_TOKEN_KEY = "liveWall.githubToken";
const YOUTUBE_API_KEY_KEY = "liveWall.youtubeApiKey";
const BASE_TITLE = "Airwave · Live Monitor Wall";

let lastLiveIds = new Set();
let lastStatus = null;

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

disconnectBtn.addEventListener("click", () => {
  clearCredentials();
  setFormStatus(connectStatusEl, "", null);
  renderConnectSection();
});

async function addChannel() {
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
      `Added ${resolved.name}. It'll appear on the wall within ~5 minutes of going live.`,
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
  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&rel=0&modestbranding=1`;
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

const HIDE_ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 6c4.7 0 8.6 2.9 10 7-.5 1.4-1.3 2.7-2.3 3.7l-1.5-1.5c.7-.7 1.3-1.4 1.7-2.2A9 9 0 0 0 12 8c-.7 0-1.4.1-2.1.2L8.3 6.6C9.5 6.2 10.7 6 12 6zM3.3 4.3l16.4 16.4-1.4 1.4-2.7-2.7c-1.1.4-2.3.6-3.6.6-4.7 0-8.6-2.9-10-7 .6-1.7 1.6-3.2 2.9-4.3L1.9 5.7l1.4-1.4zM12 18c.6 0 1.2-.1 1.8-.2l-1.6-1.6a3.5 3.5 0 0 1-3.4-3.4L6.3 10.3c-1 .8-1.8 1.7-2.3 2.7 1.4 3 4.4 5 8 5zm3.5-6.2-3.3-3.3h-.2a3.5 3.5 0 0 1 3.5 3.3z"/></svg>';

function buildCard(channel) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.channelId = channel.id;
  card.dataset.videoId = channel.videoId || "";

  const video = document.createElement("div");
  video.className = "card-video";
  const iframe = document.createElement("iframe");
  iframe.src = embedUrl(channel.videoId);
  iframe.title = channel.name;
  iframe.allow =
    "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
  iframe.allowFullscreen = true;
  video.appendChild(iframe);

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

  const hideBtn = document.createElement("button");
  hideBtn.className = "card-hide";
  hideBtn.type = "button";
  hideBtn.innerHTML = `${HIDE_ICON_SVG}Hide`;
  hideBtn.addEventListener("click", () => hideChannel(channel.id));

  body.append(info, hideBtn);
  card.append(video, body);
  return card;
}

function updateCard(card, channel) {
  // Only touch the iframe if the stream itself changed, so a playing
  // embed is never restarted by the 60s poll.
  if (card.dataset.videoId !== (channel.videoId || "")) {
    card.dataset.videoId = channel.videoId || "";
    const iframe = card.querySelector("iframe");
    if (iframe) iframe.src = embedUrl(channel.videoId);
  }
  const nameEl = card.querySelector(".channel-name");
  if (nameEl && nameEl.textContent !== channel.name) nameEl.textContent = channel.name;
  const titleLine = card.querySelector(".card-title");
  const title = channel.title || "";
  if (titleLine && titleLine.textContent !== title) {
    titleLine.textContent = title;
    titleLine.title = title;
  }
}

function retireCard(card) {
  if (card.classList.contains("leaving")) return;
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
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSettings();
});

renderConnectSection();
render();
setInterval(render, POLL_INTERVAL_MS);
