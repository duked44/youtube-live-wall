const STATUS_URL = "data/status.json";
const CHANNELS_URL = "channels.json";
const POLL_INTERVAL_MS = 60_000;
const HIDDEN_KEY = "liveWall.hiddenChannelIds";
const GITHUB_TOKEN_KEY = "liveWall.githubToken";
const YOUTUBE_API_KEY_KEY = "liveWall.youtubeApiKey";

let lastLiveIds = new Set();

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
  render();
}

function restoreChannel(id) {
  const hidden = getHiddenIds();
  hidden.delete(id);
  setHiddenIds(hidden);
  render();
}

function embedUrl(videoId) {
  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&mute=1&rel=0&modestbranding=1`;
}

function formatTime(iso) {
  if (!iso) return "never checked yet";
  const d = new Date(iso);
  return `checked ${d.toLocaleTimeString()}`;
}

function renderCards(liveChannels, hiddenIds) {
  grid.innerHTML = "";
  const visible = liveChannels.filter((c) => !hiddenIds.has(c.id));

  emptyState.hidden = visible.length > 0;
  if (visible.length === 0) return;

  for (const channel of visible) {
    const card = document.createElement("article");
    card.className = "card";

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
    channelLine.innerHTML = `<span class="live-badge">LIVE</span> ${escapeHtml(channel.name)}`;
    const titleLine = document.createElement("div");
    titleLine.className = "card-title";
    titleLine.textContent = channel.title || "";
    titleLine.title = channel.title || "";
    info.append(channelLine, titleLine);

    const hideBtn = document.createElement("button");
    hideBtn.className = "card-hide";
    hideBtn.type = "button";
    hideBtn.textContent = "Hide";
    hideBtn.addEventListener("click", () => hideChannel(channel.id));

    body.append(info, hideBtn);
    card.append(video, body);
    grid.appendChild(card);
  }
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
  let summaryText = "no checks yet";
  if (lastRun) {
    const mins = minutesAgo(lastRun.at);
    const allFailed = lastRun.checked > 0 && lastRun.errors === lastRun.checked;
    statusClass = allFailed ? "bad" : lastRun.errors > 0 ? "warn" : "ok";
    summaryText = `${last24h.runs} checks in last 24h · last run ${mins}m ago`;
  }

  healthSummaryEl.innerHTML = `<span class="status-dot ${statusClass}"></span>${escapeHtml(
    summaryText
  )}`;

  healthDetailEl.innerHTML = "";
  const rows = [
    ["Checks in last 24h", String(last24h.runs)],
    ["Channel checks (24h)", String(last24h.channelChecks)],
    ["Errors (24h)", String(last24h.errors)],
    [
      "Last run",
      lastRun ? `${minutesAgo(lastRun.at)}m ago (${lastRun.errors}/${lastRun.checked} errors)` : "never",
    ],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    healthDetailEl.append(dt, dd);
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

let channelsConfigCache = null;

async function loadChannelsConfig() {
  if (channelsConfigCache) return channelsConfigCache;
  const res = await fetch(`${CHANNELS_URL}?t=${Date.now()}`);
  const data = await res.json();
  channelsConfigCache = data.channels;
  return channelsConfigCache;
}

async function render() {
  try {
    const [statusRes, channelsConfig] = await Promise.all([
      fetch(`${STATUS_URL}?t=${Date.now()}`),
      loadChannelsConfig(),
    ]);
    const status = await statusRes.json();
    const hiddenIds = getHiddenIds();
    const liveChannels = status.channels.filter((c) => c.live);
    const liveIds = new Set(liveChannels.map((c) => c.id));
    lastLiveIds = liveIds;
    const allChannelsById = new Map(channelsConfig.map((c) => [c.id, c]));

    lastCheckedEl.textContent = formatTime(status.generatedAt);
    renderHealth(status.health);
    renderCards(liveChannels, hiddenIds);
    renderHiddenList(allChannelsById, hiddenIds);
    renderTrackedList(channelsConfig, liveIds);
  } catch (err) {
    console.error("Failed to load live status", err);
    lastCheckedEl.textContent = "status unavailable";
  }
}

document.getElementById("open-settings").addEventListener("click", () => {
  settingsPanel.hidden = false;
  settingsBackdrop.hidden = false;
});

function closeSettings() {
  settingsPanel.hidden = true;
  settingsBackdrop.hidden = true;
}

document.getElementById("close-settings").addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", closeSettings);

renderConnectSection();
render();
setInterval(render, POLL_INTERVAL_MS);
