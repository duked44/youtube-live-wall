#!/usr/bin/env node
// Checks every enabled channel in channels.json for a live broadcast right now,
// using the public /live page (no API key, no quota). Writes data/status.json.
//
// How it works: YouTube's channel "/live" URL serves the watch page directly
// when a stream is live, embedding a ytInitialPlayerResponse JSON blob with
// videoDetails.isLive. When nothing is live, that flag is absent/false.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 12_000;
const DELAY_BETWEEN_CHANNELS_MS = 350;

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

async function checkChannel(channel) {
  const url = `https://www.youtube.com/channel/${channel.channelId}/live`;
  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok) {
    return { ...baseResult(channel), error: `HTTP ${res.status}` };
  }

  const html = await res.text();
  const playerResponse = extractPlayerResponse(html);
  const videoDetails = playerResponse?.videoDetails;

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
    try {
      results.push(await checkChannel(channel));
    } catch (err) {
      results.push({ ...baseResult(channel), error: String(err?.message ?? err) });
    }
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
