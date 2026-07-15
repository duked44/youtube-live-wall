#!/usr/bin/env node
// Checks every enabled channel in channels.json for a live broadcast right now
// (no API key, no quota). Writes data/status.json.
//
// Primary path: YouTube's public innertube JSON endpoints (the same ones the
// youtube.com frontend calls) — resolve_url on the channel's /live URL yields
// a videoId only when a stream is live or scheduled, then player yields
// videoDetails.isLive. Fallback path: scrape the /live HTML page for the
// embedded ytInitialPlayerResponse blob. The JSON endpoints are the primary
// because datacenter IPs (Actions runners) get bot-walled on HTML pages
// frequently, which used to read as a silent "not live".

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 12_000;
// Modest pacing keeps dozens of sequential requests from tripping YouTube's
// rate-based bot detection on the runner's shared IP.
const DELAY_BETWEEN_CHANNELS_MS = 900;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractPlayerResponse(html) {
  const marker = "var ytInitialPlayerResponse = ";
  const start = html.indexOf(marker);
  if (start === -1) return null;

  const jsonStart = start + marker.length;
  // Walk forward to find the matching closing brace for the JSON object,
  // since the blob is followed by ";" then more script content.
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = jsonStart; i < html.length; i++) {
    const ch = html[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        const jsonStr = html.slice(jsonStart, i + 1);
        try {
          return JSON.parse(jsonStr);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// YouTube serves datacenter IPs (like Actions runners) reCAPTCHA/bot-check
// pages instead of real HTML far too often for page scraping to be reliable
// at this channel count. The innertube JSON endpoints — the same ones the
// youtube.com frontend itself calls, no API key or quota involved — are far
// less aggressively walled, so they are the primary path; the HTML scrape
// stays as a fallback.
const COOKIE = "SOCS=CAI; CONSENT=YES+1";

const INNERTUBE_CONTEXT = {
  client: { clientName: "WEB", clientVersion: "2.20250101.00.00" },
};

async function innertube(endpoint, payload) {
  const res = await fetchWithTimeout(`https://www.youtube.com/youtubei/v1/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: JSON.stringify({ context: INNERTUBE_CONTEXT, ...payload }),
  });
  if (!res.ok) throw new Error(`innertube ${endpoint} HTTP ${res.status}`);
  return res.json();
}

async function checkChannelViaInnertube(channel) {
  // /live resolves to a watchEndpoint only when a stream is live or in a
  // waiting room; otherwise it resolves back to the channel (browseEndpoint).
  const resolved = await innertube("navigation/resolve_url", {
    url: `https://www.youtube.com/channel/${channel.channelId}/live`,
  });
  const videoId = resolved?.endpoint?.watchEndpoint?.videoId;
  if (!videoId) {
    return { ...baseResult(channel), live: false };
  }

  const player = await innertube("player", { videoId });
  const videoDetails = player?.videoDetails;
  if (!videoDetails) {
    const status = player?.playabilityStatus;
    const reason = status?.reason || status?.status || "no videoDetails";
    return { ...baseResult(channel), error: `player blocked: ${reason}` };
  }

  // isLive is false for scheduled/waiting-room streams (isUpcoming) — those
  // must not appear on the wall.
  if (!videoDetails.isLive) {
    return { ...baseResult(channel), live: false };
  }

  return {
    ...baseResult(channel),
    live: true,
    videoId: videoDetails.videoId || videoId,
    title: videoDetails.title ?? null,
    thumbnail: `https://i.ytimg.com/vi/${videoDetails.videoId || videoId}/hqdefault.jpg`,
  };
}

function classifyWallPage(html) {
  if (html.includes("consent.youtube.com")) return "consent wall served instead of page";
  if (html.includes("google.com/sorry") || html.includes("recaptcha"))
    return "bot check served instead of page";
  return null;
}

async function checkChannelViaHtml(channel) {
  const url = `https://www.youtube.com/channel/${channel.channelId}/live`;
  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: COOKIE,
    },
  });

  if (!res.ok) {
    return { ...baseResult(channel), error: `HTTP ${res.status}` };
  }

  const html = await res.text();
  const playerResponse = extractPlayerResponse(html);
  const videoDetails = playerResponse?.videoDetails;

  if (!playerResponse) {
    // No player blob at all: either a genuinely-offline channel page, or a
    // wall page. Surface the wall case as an error so health tracking sees it.
    const wall = classifyWallPage(html);
    if (wall) return { ...baseResult(channel), error: wall };
    return { ...baseResult(channel), live: false };
  }

  const isLive = Boolean(videoDetails?.isLive);
  if (!isLive) {
    return { ...baseResult(channel), live: false };
  }

  return {
    ...baseResult(channel),
    live: true,
    videoId: videoDetails.videoId,
    title: videoDetails.title ?? null,
    thumbnail: videoDetails.videoId
      ? `https://i.ytimg.com/vi/${videoDetails.videoId}/hqdefault.jpg`
      : null,
  };
}

async function checkChannel(channel) {
  try {
    return await checkChannelViaInnertube(channel);
  } catch {
    return checkChannelViaHtml(channel);
  }
}

function baseResult(channel) {
  return {
    id: channel.id,
    name: channel.name,
    channelId: channel.channelId,
    live: false,
  };
}

const RUN_LOG_WINDOW_MS = 24 * 60 * 60 * 1000;

async function readRunLog(outDir) {
  try {
    const raw = await readFile(path.join(outDir, "run-log.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function main() {
  const channelsRaw = await readFile(path.join(ROOT, "channels.json"), "utf8");
  const { channels } = JSON.parse(channelsRaw);
  const enabled = channels.filter((c) => c.enabled);

  const results = [];
  for (const channel of enabled) {
    let result;
    // One retry per channel: transient network blips and one-off wall pages
    // shouldn't mark a channel offline for a whole 5-minute cycle.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        result = await checkChannel(channel);
      } catch (err) {
        result = { ...baseResult(channel), error: String(err?.message ?? err) };
      }
      if (!result.error) break;
      if (attempt === 1) await sleep(1500);
    }
    results.push(result);
    await sleep(DELAY_BETWEEN_CHANNELS_MS);
  }

  const now = new Date();
  const errorCount = results.filter((r) => r.error).length;

  const outDir = path.join(ROOT, "data");
  await mkdir(outDir, { recursive: true });

  const runLog = await readRunLog(outDir);
  runLog.push({ time: now.toISOString(), checked: results.length, errors: errorCount });
  const cutoff = now.getTime() - RUN_LOG_WINDOW_MS;
  const recentRuns = runLog.filter((entry) => new Date(entry.time).getTime() >= cutoff);

  const health = {
    last24h: {
      runs: recentRuns.length,
      channelChecks: recentRuns.reduce((sum, r) => sum + r.checked, 0),
      errors: recentRuns.reduce((sum, r) => sum + r.errors, 0),
    },
    lastRun: { at: now.toISOString(), checked: results.length, errors: errorCount },
  };

  const status = {
    generatedAt: now.toISOString(),
    channels: results,
    health,
  };

  await writeFile(
    path.join(outDir, "run-log.json"),
    JSON.stringify(recentRuns, null, 2) + "\n",
    "utf8"
  );
  await writeFile(
    path.join(outDir, "status.json"),
    JSON.stringify(status, null, 2) + "\n",
    "utf8"
  );

  const liveCount = results.filter((r) => r.live).length;
  console.log(
    `Checked ${results.length} channels, ${liveCount} live, ${errorCount} errors. ` +
      `Last 24h: ${health.last24h.runs} runs, ${health.last24h.errors} errors.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
