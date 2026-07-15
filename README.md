# Airwave — live monitor wall

A tiny GitHub-hosted site that shows only the channels (from a list you control)
that are currently live streaming. No ads baked in beyond whatever YouTube's
own player shows, no build step. Live-checking itself needs no API key; adding
a channel by @handle from the site's Settings panel optionally uses a YouTube
API key just for that one lookup (see "Adding / removing channels" below).

## How it works

- `channels.json` is the list of channels you're tracking. Normally you don't
  edit this by hand — use the **Settings** panel on the site (see "Adding /
  removing channels" below). It's still a plain JSON file you *can* hand-edit
  as a fallback.
- A GitHub Actions workflow (`.github/workflows/check-live.yml`) runs every
  ~5 minutes (GitHub's fastest supported schedule interval), checks each
  enabled channel's public `/live` page, and writes the result to
  `data/status.json`. This costs no API quota because it doesn't use the
  YouTube Data API — it reads the same public page a browser would.
- `index.html` / `app.js` fetch `data/status.json` on a 60-second timer and
  render a card (with an embedded, privacy-enhanced player) for every channel
  that's currently live. Channels that aren't live simply don't appear.
- Each live check run also appends to `data/run-log.json` (pruned to a
  rolling 24-hour window) so the site can show a small health tracker —
  checks in the last 24h, and how many of those hit an error. There's no
  external quota being tracked here (see "Notes" below); it's a pacing/health
  gauge, not a countdown to a limit.
- Live cards start as lightweight thumbnail previews — click **Play feed** to
  start streaming one. Only feeds you start consume bandwidth/CPU, and a
  **Stop** button drops a feed back to its preview.
- One feed at a time owns the audio, marked by a white ring. Click **Listen**
  on any card to move the audio there (click it again to mute everything), or
  use the **arrow keys** to shift the ring between cards YouTube-TV-style (a
  not-yet-playing card starts automatically when the ring lands on it).
- Hover a card and grab the **≡ handle** (top-left of the video) to drag the
  tile to a different spot on the wall. The arrangement is remembered in your
  browser.
- Each live card also has a **Hide** button — click it to dismiss that stream
  from your view entirely (stored in your browser's localStorage, not synced
  anywhere). Restore hidden channels from the **Settings** panel in the top
  right.
- The **Sweep now** header button commits a timestamp to `.sweep-request`
  (using your saved GitHub token), which push-triggers the checker workflow
  immediately — useful because GitHub's cron schedule is best-effort and often
  runs sparser than the nominal 5 minutes.

## Setup

1. **Add your channels.** Edit `channels.json`. For each channel you need its
   Channel ID (the `UC...` string, not the `@handle`):
   - Go to the channel's page, click **...more** / the channel name to open
     the About tab, then **Share channel > Copy channel ID**. Or view page
     source and search for `"channelId"`.
2. **Push this repo to GitHub** (if you haven't already) and enable
   **GitHub Pages**: repo Settings > Pages > Source > deploy from the `main`
   branch, root folder.
3. **Enable Actions** if prompted (Settings > Actions > allow workflows), and
   make sure workflow permissions allow read/write (Settings > Actions >
   General > Workflow permissions > "Read and write permissions") so the
   scheduled job can commit `data/status.json` back to the repo.
4. Optionally trigger the workflow once by hand: Actions tab >
   "Check live channels" > Run workflow, so you don't have to wait for the
   first scheduled run.

## Adding / removing channels

Open the site, click **Settings**, and set up two credentials once (both are
stored only in your browser's `localStorage` — never committed to the repo):

1. **GitHub token** — lets the page commit changes to `channels.json`
   directly. Create a **fine-grained personal access token** at
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new):
   - Repository access: **Only select repositories** → this repo.
   - Permissions: **Contents → Read and write**. Nothing else needed.
   - Consider a short expiration (e.g. 90 days) and just regenerate it when it
     lapses — narrower blast radius if it ever leaks.
2. **YouTube Data API key** — lets the page resolve an `@handle` you type
   into a channel ID. Create one at
   [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
   (enable "YouTube Data API v3" on the project first). Optionally restrict
   the key to your `*.github.io` referrer so it can't be used from elsewhere
   if it leaks. Each lookup costs ~1 quota unit out of the free 10,000/day —
   this is the one place the project *does* touch the official API, and it's
   negligible even if you add channels constantly.

Paste both into the Settings panel and hit **Save**. After that:

- **Add a channel**: type its `@handle` (or paste the full channel URL) into
  the "Add a channel" box and click **Add channel**. It resolves the handle,
  commits the updated `channels.json`, and shows up as live within about 5
  minutes of actually going live (whenever the next scheduled check lands).
- **Remove a channel**: click **Remove** next to it in the "Tracked channels"
  list, confirm, done.

Only someone with your saved token can add/remove channels — visiting the
site itself doesn't expose it to anyone else.

`channels.json` still has the same shape under the hood if you ever want to
hand-edit it instead (e.g. to bulk-import channels, or set `enabled: false`
to pause one without removing it):

```json
{
  "id": "short-unique-slug",
  "name": "Display Name",
  "channelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
  "enabled": true
}
```

## Notes and known limitations

- The live-check is a lightweight page scrape, not the official API. It's the
  same technique most no-key "who's live" dashboards use and is quota-free,
  but if YouTube changes their page structure it could stop detecting live
  status until the script is updated.
- There's no hard external limit on how often this can run — GitHub Actions
  minutes are free/unlimited for public repos, and the scrape approach
  doesn't touch any YouTube API quota. The real ceiling is GitHub's 5-minute
  cron floor, plus the practical risk that polling too aggressively from
  GitHub's shared (datacenter) IP ranges could get flagged by YouTube's bot
  detection and start serving CAPTCHA/consent pages instead of the real page.
  That's what the health tracker on the site is watching for — a spike in
  errors, not a quota being used up.
- Embeds use `youtube-nocookie.com` (YouTube's privacy-enhanced mode). This
  reduces tracking/cookies but does **not** guarantee an ad-free player —
  YouTube/the channel owner still control whether ads run on a given stream.
  There's no supported "no ads" embed parameter.
- Scheduled GitHub Actions can run a few minutes late under load, so treat
  "every 5 minutes" as approximate.
