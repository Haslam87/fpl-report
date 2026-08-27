# fpl-report

Weekly FPL mini-league report. Pulls data from the public FPL API, computes
a set of awards for the gameweek, and prints/posts a Slack-formatted summary.

No dependencies — plain Node 22+ (`fetch`, `process.loadEnvFile()`).

## Setup

```
cp .env.example .env
# edit .env with your league ID and Slack webhook URL
```

## Usage

```
node fpl-report.js               # print report to console only
node fpl-report.js --post        # also post to Slack (requires SLACK_WEBHOOK_URL)
node fpl-report.js --gw=3        # force a specific gameweek instead of auto-detecting
node fpl-report.js --dry-run     # don't write data/last-standings.json
node fpl-report.js --list-managers --dry-run   # print FPL entry ID -> name, for building manager-mapping.json
```

The gameweek is auto-detected as the most recently finished, bonus-confirmed
event from `bootstrap-static/events`. Override with `--gw` for backfills or
debugging.

## Manager mentions

`manager-mapping.json` (FPL entry ID → Slack user ID) lets the report
`@mention` managers instead of printing their FPL name. It's optional — any
manager without an entry just falls back to "Player Name (Team Name)".

To fill it in:
1. `node fpl-report.js --list-managers --dry-run` — prints each manager's FPL
   entry ID next to their name, ready to paste into the JSON file.
2. In Slack, open each person's profile → `...` → **Copy member ID** to get
   their Slack user ID (looks like `U012ABC3DEF`).
3. Fill in the matching entry:
   ```json
   { "1884325": "U012ABC3DEF" }
   ```

Update it whenever someone joins the league.

## Insights

Manager of the Week, Runner Up, average points, bench watch, best/worst
transfer, most transfers this season, best team value, rank rise/fall, most
captained/owned, most transferred in/out, plus:

- **Super Sub** — biggest points swing from an automatic bench substitution
- **Differential Captain** — highest-scoring captain pick owned by <10% of the league
- **Team Twins** — the two closest squads in the league (shown when they differ by ≤2 players)
- **Hit Regret** — took a transfer hit and still scored below the league average
- **On the Rise / In Freefall** — longest current streak of consecutive weeks climbing/falling in rank
- **Most Consistent** — lowest week-to-week variance in score across the season
- **Longest-Suffering Bench Warmer** — player who's sat unused on the same manager's bench for the most consecutive weeks

Several of these need multiple gameweeks of history to say anything (streaks,
consistency, bench-warmer) and will be silent for the first few runs — this
is expected, not a bug.

## Snapshot

`data/last-standings.json` stores last run's league standings, plus rolling
per-manager rank history and bench-warmer streak state, so week-over-week
insights (rank rise/fall, streaks, bench warmer) can be computed as deltas.
It's overwritten (not appended) each run and is meant to be committed back to
the repo by CI — see the workflow.

## GitHub Actions

`.github/workflows/weekly-report.yml` runs on a Tuesday-morning cron (after
weekend fixtures + bonus points settle) and via manual `workflow_dispatch`.
Configure these repository secrets:

- `FPL_LEAGUE_ID`
- `SLACK_WEBHOOK_URL`

The workflow commits the updated snapshot back to the repo after each run.

## Failure behaviour

The FPL API is undocumented and occasionally changes shape. This script
fails loudly (non-zero exit, descriptive error naming the endpoint/field)
rather than silently producing an incomplete report.
