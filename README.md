# Live Wall

A tiny GitHub-hosted site that shows only the channels (from a list you control)
that are currently live streaming. No API key, no ads baked in beyond whatever
YouTube's own player shows, no build step.

## How it works

- `channels.json` is the list of channels you're tracking. Add or remove an
  entry to change what's tracked.
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
- Each live card has a **Hide** button — click it to dismiss that stream from
  your view (stored in your browser's localStorage, not synced anywhere).
  Restore hidden channels from the **Settings** panel in the top right.

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

Just edit `channels.json`:

```json
{
  "id": "short-unique-slug",
  "name": "Display Name",
  "channelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
  "enabled": true
}
```

- `id` is only used internally (hidden-channel storage, DOM keys) — keep it
  short and unique.
- Set `enabled: false` to keep a channel in the file without checking it.
- Commit and push; the next scheduled run (or a manual "Run workflow") will
  pick it up.

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
