const STATUS_URL = "data/status.json";
const CHANNELS_URL = "channels.json";
const POLL_INTERVAL_MS = 60_000;
const HIDDEN_KEY = "liveWall.hiddenChannelIds";

const grid = document.getElementById("grid");
const emptyState = document.getElementById("empty-state");
const lastCheckedEl = document.getElementById("last-checked");
const hiddenListEl = document.getElementById("hidden-list");
const trackedListEl = document.getElementById("tracked-list");
const settingsPanel = document.getElementById("settings-panel");
const settingsBackdrop = document.getElementById("settings-backdrop");

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

function renderTrackedList(channelsConfig, liveIds) {
  trackedListEl.innerHTML = "";
  for (const channel of channelsConfig) {
    const li = document.createElement("li");
    const label = document.createElement("span");
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
    li.appendChild(label);
    trackedListEl.appendChild(li);
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
    const allChannelsById = new Map(channelsConfig.map((c) => [c.id, c]));

    lastCheckedEl.textContent = formatTime(status.generatedAt);
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

render();
setInterval(render, POLL_INTERVAL_MS);
