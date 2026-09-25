#!/usr/bin/env node
'use strict';

// FPL mini-league weekly report.
// Fetches data from the public (undocumented) FPL API, computes weekly
// awards for a classic mini-league, and prints/posts a Slack-formatted
// summary. See README.md for usage.

try {
  process.loadEnvFile();
} catch {
  // No .env file (e.g. in CI, where secrets come from the environment) — fine.
}

const BASE_URL = 'https://fantasy.premierleague.com/api/';
const SNAPSHOT_PATH = new URL('./data/last-standings.json', import.meta.url);
const MAPPING_PATH = new URL('./manager-mapping.json', import.meta.url);
const USER_AGENT = 'Mozilla/5.0 (compatible; fpl-report/1.0; +https://github.com/)';

// ---------------------------------------------------------------------------
// CLI args / config
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { post: false, dryRun: false, gw: null, listManagers: false, seasonReview: false };
  for (const raw of argv) {
    if (raw === '--post') args.post = true;
    else if (raw === '--season-review') args.seasonReview = true;
    else if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--list-managers') args.listManagers = true;
    else if (raw.startsWith('--gw=')) {
      const n = Number(raw.slice('--gw='.length));
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--gw must be a positive integer, got "${raw.slice('--gw='.length)}"`);
      }
      args.gw = n;
    } else {
      throw new Error(`Unrecognised argument "${raw}"`);
    }
  }
  return args;
}

function loadConfig() {
  const leagueId = process.env.FPL_LEAGUE_ID;
  if (!leagueId || !/^\d+$/.test(leagueId)) {
    throw new Error(
      'FPL_LEAGUE_ID is not set (or not numeric). Set it in .env or as an environment variable.'
    );
  }
  return {
    leagueId,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || null,
  };
}

// Optional FPL entry ID -> Slack user ID mapping, so the report can
// @mention managers instead of printing their FPL name. Absent file (or
// absent entry) just falls back to the plain name — never a hard failure,
// since keeping this file up to date is a manual chore.
async function loadManagerMapping() {
  const fs = await import('node:fs/promises');
  try {
    const raw = await fs.readFile(MAPPING_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    requireShape(parsed, (p) => p && typeof p === 'object' && !Array.isArray(p), 'manager-mapping.json should be an object');
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Failed to read manager-mapping.json: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Fetch layer — the only place that talks to the network.
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FplHttpError extends Error {
  constructor(status, path, body) {
    super(`FPL API returned ${status} for ${path}. Body: ${body.slice(0, 300)}`);
    this.status = status;
  }
}

async function fplGet(path, { retries = 3 } = {}) {
  const url = BASE_URL + path;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    } catch (networkErr) {
      lastErr = new Error(`Network error fetching ${path}: ${networkErr.message}`);
      if (attempt < retries) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }

    if (res.status >= 500 && attempt < retries) {
      await sleep(300 * 2 ** attempt);
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    const bodyText = await res.text();

    if (!res.ok) {
      throw new FplHttpError(res.status, path, bodyText);
    }
    if (!contentType.includes('application/json')) {
      throw new Error(
        `FPL API returned non-JSON content-type "${contentType}" for ${path} — the endpoint likely ` +
          `changed or is serving an error page. Body: ${bodyText.slice(0, 300)}`
      );
    }
    try {
      return JSON.parse(bodyText);
    } catch (parseErr) {
      throw new Error(`FPL API returned unparseable JSON for ${path}: ${parseErr.message}`);
    }
  }
  throw lastErr;
}

function requireShape(value, predicate, description) {
  if (!predicate(value)) {
    throw new Error(
      `Unexpected API shape — ${description}. The FPL API may have changed. Got: ` +
        `${JSON.stringify(value)?.slice(0, 300)}`
    );
  }
  return value;
}

// Small concurrency limiter so per-manager requests don't hammer the API.
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        runNext();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
}

// ---------------------------------------------------------------------------
// Gameweek auto-detection
// ---------------------------------------------------------------------------

function detectGameweek(events, override) {
  if (override != null) {
    const event = events.find((e) => e.id === override);
    if (!event) {
      throw new Error(`--gw=${override} does not match any event id in bootstrap-static/events`);
    }
    return { gw: override, event };
  }

  const settled = events.filter((e) => e.finished && e.data_checked).sort((a, b) => b.id - a.id);
  if (settled.length > 0) {
    return { gw: settled[0].id, event: settled[0] };
  }

  const finished = events.filter((e) => e.finished).sort((a, b) => b.id - a.id);
  if (finished.length > 0) {
    console.warn(
      `Warning: GW${finished[0].id} is finished but not yet data_checked — bonus points may still change.`
    );
    return { gw: finished[0].id, event: finished[0] };
  }

  return { gw: null, event: null };
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

async function fetchBootstrap() {
  const data = await fplGet('bootstrap-static/');
  requireShape(data, (d) => Array.isArray(d?.events), 'bootstrap-static/.events should be an array');
  requireShape(data, (d) => Array.isArray(d?.elements), 'bootstrap-static/.elements should be an array');

  const elementInfo = new Map();
  for (const el of data.elements) {
    requireShape(el, (e) => typeof e?.id === 'number', 'bootstrap-static/.elements[].id should be a number');
    elementInfo.set(el.id, { webName: el.web_name, nowCost: el.now_cost });
  }
  return { events: data.events, elementInfo };
}

async function fetchLeagueStandings(leagueId) {
  const results = [];
  let page = 1;
  let leagueName = null;
  for (;;) {
    const data = await fplGet(`leagues-classic/${leagueId}/standings/?page_standings=${page}`);
    requireShape(
      data,
      (d) => d?.standings && Array.isArray(d.standings.results),
      `leagues-classic/${leagueId}/standings/.standings.results should be an array`
    );
    leagueName = leagueName ?? data.league?.name ?? `League ${leagueId}`;
    results.push(...data.standings.results);
    if (!data.standings.has_next) break;
    page += 1;
    if (page > 50) throw new Error(`leagues-classic/${leagueId}/standings/ did not terminate pagination`);
  }
  if (results.length === 0) {
    throw new Error(`League ${leagueId} returned zero entries — check FPL_LEAGUE_ID is correct`);
  }
  return { leagueName, entries: results };
}

// Returns Map<elementId, {points, cleanSheets, minutes}>. Callers that only need
// points can do `.get(id)?.points`.
async function fetchLiveGwStats(gw) {
  const data = await fplGet(`event/${gw}/live/`);
  requireShape(data, (d) => Array.isArray(d?.elements), `event/${gw}/live/.elements should be an array`);
  const stats = new Map();
  for (const el of data.elements) {
    requireShape(
      el,
      (e) =>
        typeof e?.id === 'number' &&
        e?.stats &&
        typeof e.stats.total_points === 'number' &&
        typeof e.stats.clean_sheets === 'number' &&
        typeof e.stats.minutes === 'number',
      `event/${gw}/live/.elements[].stats.total_points/clean_sheets/minutes should be numbers`
    );
    stats.set(el.id, { points: el.stats.total_points, cleanSheets: el.stats.clean_sheets, minutes: el.stats.minutes });
  }
  return stats;
}

// Returns null when the manager hadn't joined yet for this gameweek (the
// picks endpoint 404s for entries that started later than `gw` — e.g. a
// manager who joined the mini-league mid-season). Any other failure still
// throws, since that's a real API problem rather than an expected absence.
async function fetchManagerData(entryId, gw, limit) {
  let picks;
  try {
    picks = await limit(() => fplGet(`entry/${entryId}/event/${gw}/picks/`));
  } catch (err) {
    if (err instanceof FplHttpError && err.status === 404) return null;
    throw err;
  }

  const [transfers, history] = await Promise.all([
    limit(() => fplGet(`entry/${entryId}/transfers/`)),
    limit(() => fplGet(`entry/${entryId}/history/`)),
  ]);

  requireShape(
    picks,
    (p) => Array.isArray(p?.picks) && p?.entry_history,
    `entry/${entryId}/event/${gw}/picks/ should have .picks[] and .entry_history`
  );
  requireShape(transfers, (t) => Array.isArray(t), `entry/${entryId}/transfers/ should be an array`);
  requireShape(history, (h) => Array.isArray(h?.current), `entry/${entryId}/history/.current should be an array`);

  requireShape(
    picks.automatic_subs,
    (a) => Array.isArray(a),
    `entry/${entryId}/event/${gw}/picks/.automatic_subs should be an array`
  );

  return {
    picks: picks.picks.map((p) => ({
      element: p.element,
      position: p.position,
      multiplier: p.multiplier,
      isCaptain: !!p.is_captain,
    })),
    automaticSubs: picks.automatic_subs.map((s) => ({ elementIn: s.element_in, elementOut: s.element_out })),
    activeChip: picks.active_chip || null,
    entryHistory: picks.entry_history,
    transfersThisGw: transfers
      .filter((t) => t.event === gw)
      .map((t) => ({ elementIn: t.element_in, elementOut: t.element_out })),
    transfersSeasonCount: transfers.length,
    seasonHistory: history.current,
  };
}

async function collectLeagueData(leagueId, gw) {
  const { leagueName, entries } = await fetchLeagueStandings(leagueId);
  const limit = createLimiter(6);

  const results = await Promise.all(
    entries.map(async (entry) => {
      const detail = await fetchManagerData(entry.entry, gw, limit);
      if (detail == null) return null; // hadn't joined yet as of this gameweek
      const eh = detail.entryHistory;
      return {
        entry: entry.entry,
        playerName: entry.player_name,
        entryName: entry.entry_name,
        leagueRank: entry.rank,
        leagueLastRank: entry.last_rank,
        seasonTotal: entry.total,
        gwPoints: eh.points,
        pointsOnBench: eh.points_on_bench,
        // entry_history.value is already total team value including bank
        // money (confirmed against squad now_cost sums) — do not add bank again.
        teamValue: eh.value / 10,
        activeChip: detail.activeChip,
        eventTransfers: eh.event_transfers,
        eventTransfersCost: eh.event_transfers_cost,
        picks: detail.picks,
        automaticSubs: detail.automaticSubs,
        transfersThisGw: detail.transfersThisGw,
        transfersSeasonCount: detail.transfersSeasonCount,
        seasonHistory: detail.seasonHistory,
      };
    })
  );

  const managers = results.filter((m) => m != null);
  const skipped = results.length - managers.length;
  if (skipped > 0) {
    console.error(`Skipped ${skipped} manager(s) who joined the league after gameweek ${gw}`);
  }

  return { leagueName, managers };
}

// ---------------------------------------------------------------------------
// Snapshot (for rank-delta calculation across runs)
// ---------------------------------------------------------------------------

async function readSnapshot() {
  const fs = await import('node:fs/promises');
  try {
    const raw = await fs.readFile(SNAPSHOT_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to read snapshot at ${SNAPSHOT_PATH}: ${err.message}`);
  }
}

async function writeSnapshot(snapshot) {
  const fs = await import('node:fs/promises');
  const dir = new URL('./data/', import.meta.url);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = new URL(`./last-standings.json.tmp-${process.pid}`, dir);
  await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  await fs.rename(tmpPath, SNAPSHOT_PATH);
}

function buildStandingsMap(managers) {
  const map = {};
  for (const m of managers) {
    map[m.entry] = { rank: m.leagueRank, total: m.seasonTotal, playerName: m.playerName };
  }
  return map;
}

// Decide which prior standings to diff against, and what the snapshot file
// should look like after this run. Keeps one extra generation so re-running
// the script for the same gameweek doesn't collapse deltas to zero.
function resolveBaseline(existingSnapshot, gw, generatedAt, currentStandingsMap) {
  let baseline = null;
  let nextSnapshot;

  if (!existingSnapshot || !existingSnapshot.current) {
    nextSnapshot = { current: { gameweek: gw, generatedAt, standings: currentStandingsMap }, previous: null };
  } else if (existingSnapshot.current.gameweek === gw) {
    // Re-run for a gameweek we already recorded — diff against what was
    // previous *before* that first run, and leave the file untouched.
    baseline = existingSnapshot.previous;
    nextSnapshot = existingSnapshot;
  } else if (existingSnapshot.current.gameweek < gw) {
    baseline = existingSnapshot.current;
    nextSnapshot = {
      current: { gameweek: gw, generatedAt, standings: currentStandingsMap },
      previous: existingSnapshot.current,
    };
  } else {
    // Snapshot is ahead of the gameweek being requested (e.g. --gw override
    // pointing backwards). Don't guess a baseline; don't overwrite forward progress.
    nextSnapshot = existingSnapshot;
  }

  return { baseline, nextSnapshot };
}

// Rolling per-manager rank history, independent of the current/previous
// baseline above — used for streak detection (Green/Red Streak). Capped at
// 40 entries (a season is 38 gameweeks) so the file doesn't grow unbounded
// across seasons if the repo is reused.
const RANK_HISTORY_LIMIT = 40;

function updateRankHistory(existingRankHistory, gw, managers) {
  const rankHistory = { ...(existingRankHistory || {}) };
  for (const m of managers) {
    const key = String(m.entry);
    const existing = (rankHistory[key] || []).filter((h) => h.gameweek !== gw);
    existing.push({ gameweek: gw, rank: m.leagueRank });
    existing.sort((a, b) => a.gameweek - b.gameweek);
    rankHistory[key] = existing.slice(-RANK_HISTORY_LIMIT);
  }
  return rankHistory;
}

// ---------------------------------------------------------------------------
// Insight calculations — each takes the manager array (+ context) and
// returns null when there's nothing meaningful to report.
// ---------------------------------------------------------------------------

// A "winner" where literally every eligible manager tied isn't an award —
// e.g. every squad is worth exactly £100m before GW1 kicks off. Suppress
// those rather than listing the whole league.
function topBy(managers, selector) {
  const withValues = managers.map((m) => ({ m, v: selector(m) })).filter((x) => x.v != null);
  if (withValues.length === 0) return null;
  const max = Math.max(...withValues.map((x) => x.v));
  const winners = withValues.filter((x) => x.v === max).map((x) => x.m);
  if (winners.length === withValues.length && withValues.length > 1) return null;
  return { value: max, winners };
}

function managerOfTheWeek(managers) {
  return topBy(managers, (m) => m.gwPoints);
}

// Second-highest distinct gameweek score (i.e. excludes ties with the
// winning score) — mirrors "Runner/s Up" alongside Manager of the Week.
function runnerUp(managers, motw) {
  if (!motw) return null;
  const remaining = managers.filter((m) => m.gwPoints < motw.value);
  return topBy(remaining, (m) => m.gwPoints);
}

function averagePoints(managers) {
  if (managers.length === 0) return null;
  const total = managers.reduce((sum, m) => sum + m.gwPoints, 0);
  return total / managers.length;
}

function mostTransfersThisSeason(managers) {
  return topBy(managers, (m) => (m.transfersSeasonCount > 0 ? m.transfersSeasonCount : null));
}

function rankMovers(managers, baselineStandings) {
  const deltas = [];
  for (const m of managers) {
    let prevRank = null;
    if (baselineStandings && baselineStandings[m.entry]) {
      prevRank = baselineStandings[m.entry].rank;
    } else if (m.leagueLastRank && m.leagueLastRank > 0) {
      prevRank = m.leagueLastRank;
    }
    if (prevRank == null) continue;
    deltas.push({ m, delta: prevRank - m.leagueRank });
  }
  if (deltas.length === 0) return { risers: null, fallers: null, hasBaseline: false };

  const maxDelta = Math.max(...deltas.map((d) => d.delta));
  const minDelta = Math.min(...deltas.map((d) => d.delta));
  return {
    hasBaseline: true,
    risers: maxDelta > 0 ? { value: maxDelta, winners: deltas.filter((d) => d.delta === maxDelta).map((d) => d.m) } : null,
    fallers: minDelta < 0 ? { value: minDelta, winners: deltas.filter((d) => d.delta === minDelta).map((d) => d.m) } : null,
  };
}

function perTransferHitCost(m) {
  if (!m.eventTransfers || !m.eventTransfersCost) return 0;
  return m.eventTransfersCost / m.eventTransfers;
}

function bestWorstTransfers(managers, elementLivePoints) {
  const scored = [];
  for (const m of managers) {
    const hit = perTransferHitCost(m);
    for (const t of m.transfersThisGw) {
      const pointsIn = elementLivePoints.get(t.elementIn) ?? 0;
      const pointsOut = elementLivePoints.get(t.elementOut) ?? 0;
      scored.push({ m, elementIn: t.elementIn, elementOut: t.elementOut, net: pointsIn - pointsOut - hit });
    }
  }
  if (scored.length === 0) return { best: null, worst: null };

  const maxNet = Math.max(...scored.map((s) => s.net));
  const minNet = Math.min(...scored.map((s) => s.net));
  return {
    best: { value: maxNet, winners: scored.filter((s) => s.net === maxNet) },
    worst: { value: minNet, winners: scored.filter((s) => s.net === minNet) },
  };
}

function mostPointsOnBench(managers) {
  return topBy(managers, (m) => m.pointsOnBench);
}

function bestTeamValue(managers) {
  return topBy(managers, (m) => m.teamValue);
}

function tallyElements(managers, pickFilter) {
  const counts = new Map();
  for (const m of managers) {
    for (const p of m.picks) {
      if (!pickFilter(p)) continue;
      counts.set(p.element, (counts.get(p.element) || 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  const max = Math.max(...counts.values());
  const winners = [...counts.entries()].filter(([, c]) => c === max).map(([element]) => element);
  return { value: max, elements: winners };
}

function mostCaptained(managers) {
  return tallyElements(managers, (p) => p.isCaptain);
}

function mostOwned(managers) {
  return tallyElements(managers, () => true);
}

function tallyTransferElements(managers, key) {
  const counts = new Map();
  for (const m of managers) {
    for (const t of m.transfersThisGw) {
      const el = t[key];
      counts.set(el, (counts.get(el) || 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  const max = Math.max(...counts.values());
  const winners = [...counts.entries()].filter(([, c]) => c === max).map(([element]) => element);
  return { value: max, elements: winners };
}

function mostTransferredIn(managers) {
  return tallyTransferElements(managers, 'elementIn');
}

function mostTransferredOut(managers) {
  return tallyTransferElements(managers, 'elementOut');
}

// Biggest points swing gained from an automatic bench substitution (a
// starter blanked/didn't play and the bench pushed someone on instead).
function superSub(managers, elementLivePoints) {
  const scored = [];
  for (const m of managers) {
    for (const sub of m.automaticSubs) {
      const pointsIn = elementLivePoints.get(sub.elementIn) ?? 0;
      const pointsOut = elementLivePoints.get(sub.elementOut) ?? 0;
      scored.push({ m, elementIn: sub.elementIn, elementOut: sub.elementOut, swing: pointsIn - pointsOut });
    }
  }
  if (scored.length === 0) return null;
  const max = Math.max(...scored.map((s) => s.swing));
  if (max <= 0) return null;
  return { value: max, winners: scored.filter((s) => s.swing === max) };
}

function computeOwnershipCounts(managers) {
  const counts = new Map();
  for (const m of managers) {
    for (const p of m.picks) {
      counts.set(p.element, (counts.get(p.element) || 0) + 1);
    }
  }
  return counts;
}

// Highest-scoring captain pick among those owned by a small share of the
// league — a differential captaincy that paid off, as opposed to everyone
// captaining the same template player.
function differentialCaptain(managers, elementLivePoints, ownershipCounts, managerCount, maxOwnershipShare) {
  const candidates = [];
  for (const m of managers) {
    const captainPick = m.picks.find((p) => p.isCaptain);
    if (!captainPick) continue;
    const ownershipCount = ownershipCounts.get(captainPick.element) || 0;
    if (ownershipCount / managerCount >= maxOwnershipShare) continue;
    const basePoints = elementLivePoints.get(captainPick.element) ?? 0;
    const captainPoints = basePoints * captainPick.multiplier;
    candidates.push({ m, element: captainPick.element, ownershipCount, captainPoints });
  }
  if (candidates.length === 0) return null;
  const max = Math.max(...candidates.map((c) => c.captainPoints));
  if (max <= 0) return null;
  return { value: max, winners: candidates.filter((c) => c.captainPoints === max) };
}

// Pair of managers whose 15-man squads differ by the fewest players.
function teamTwins(managers) {
  if (managers.length < 2) return null;
  const squads = managers.map((m) => ({ m, set: new Set(m.picks.map((p) => p.element)) }));

  let best = null;
  for (let i = 0; i < squads.length; i++) {
    for (let j = i + 1; j < squads.length; j++) {
      const a = squads[i].set;
      const b = squads[j].set;
      let diff = 0;
      for (const el of a) if (!b.has(el)) diff++;
      for (const el of b) if (!a.has(el)) diff++;
      if (best === null || diff < best.diff) {
        best = { diff, pair: [squads[i].m, squads[j].m] };
      }
    }
  }
  return best;
}

// Manager who paid a transfer-hit penalty and still scored below the
// league average that gameweek — the hit didn't pay off.
function freeHitRegret(managers, avgPoints) {
  if (avgPoints == null) return null;
  const candidates = managers
    .filter((m) => m.eventTransfersCost > 0 && m.gwPoints < avgPoints)
    .map((m) => ({ m, regret: m.eventTransfersCost + (avgPoints - m.gwPoints) }));
  if (candidates.length === 0) return null;
  const max = Math.max(...candidates.map((c) => c.regret));
  return { value: max, winners: candidates.filter((c) => c.regret === max) };
}

// Longest current run of consecutive gameweeks moving the same direction
// in league rank (falling rank number = climbing the table).
function computeStreak(history) {
  if (!history || history.length < 2) return 0;
  const sorted = [...history].sort((a, b) => a.gameweek - b.gameweek);
  let streak = 0;
  let direction = null;
  for (let i = sorted.length - 1; i > 0; i--) {
    const delta = sorted[i - 1].rank - sorted[i].rank; // positive = climbed since previous week
    const thisDirection = delta > 0 ? 'up' : delta < 0 ? 'down' : null;
    if (thisDirection == null) break;
    if (direction == null) direction = thisDirection;
    if (thisDirection !== direction) break;
    streak++;
  }
  return { streak, direction };
}

function rankStreaks(managers, rankHistory) {
  const streaks = [];
  for (const m of managers) {
    const result = computeStreak(rankHistory?.[String(m.entry)]);
    if (result && result.streak >= 2) streaks.push({ m, streak: result.streak, direction: result.direction });
  }
  if (streaks.length === 0) return { rising: null, falling: null };

  const rising = streaks.filter((s) => s.direction === 'up');
  const falling = streaks.filter((s) => s.direction === 'down');
  const maxRising = rising.length > 0 ? Math.max(...rising.map((s) => s.streak)) : null;
  const maxFalling = falling.length > 0 ? Math.max(...falling.map((s) => s.streak)) : null;

  return {
    rising: maxRising != null ? { value: maxRising, winners: rising.filter((s) => s.streak === maxRising) } : null,
    falling: maxFalling != null ? { value: maxFalling, winners: falling.filter((s) => s.streak === maxFalling) } : null,
  };
}

function stdDev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// Lowest week-to-week variance in gameweek score across the season so far.
function mostConsistent(managers) {
  const candidates = managers
    .filter((m) => m.seasonHistory && m.seasonHistory.length >= 3)
    .map((m) => ({ m, stdDev: stdDev(m.seasonHistory.map((h) => h.points)) }));
  if (candidates.length === 0) return null;
  const min = Math.min(...candidates.map((c) => c.stdDev));
  return { value: min, winners: candidates.filter((c) => c.stdDev === min) };
}

// True bench = squad positions 12-15 (the 4 non-playing slots), excluding
// anyone brought on via an automatic substitution (they effectively played).
// Bench Boost weeks have no real bench (every slot scores), so they're
// skipped entirely rather than counted as 4 free bench-weeks.
const BENCH_POSITIONS = new Set([12, 13, 14, 15]);

function computeBenchWarmerUpdates(managers, gw) {
  const updates = {};
  for (const m of managers) {
    if (m.activeChip === 'bboost') continue;
    const autoSubbedIn = new Set(m.automaticSubs.map((s) => s.elementIn));
    for (const p of m.picks) {
      if (!BENCH_POSITIONS.has(p.position) || autoSubbedIn.has(p.element)) continue;
      updates[`${m.entry}:${p.element}`] = { entry: m.entry, element: p.element, gameweek: gw };
    }
  }
  return updates;
}

// Re-running for a gameweek already recorded (lastGameweek === gw) must not
// re-increment the streak — otherwise repeat runs inflate it.
function updateBenchWarmerStreaks(existingStreaks, gw, updates) {
  const next = {};
  for (const [key, entry] of Object.entries(updates)) {
    const prior = existingStreaks?.[key];
    let streak = 1;
    if (prior) {
      if (prior.lastGameweek === gw) streak = prior.streak;
      else if (prior.lastGameweek === gw - 1) streak = prior.streak + 1;
    }
    next[key] = { ...entry, lastGameweek: gw, streak };
  }
  return next;
}

function longestSufferingBenchWarmer(benchWarmerStreaks, managers) {
  if (!benchWarmerStreaks) return null;
  const entries = Object.values(benchWarmerStreaks).filter((e) => e.streak >= 2);
  if (entries.length === 0) return null;
  const managerByEntry = new Map(managers.map((m) => [m.entry, m]));
  const max = Math.max(...entries.map((e) => e.streak));
  const winners = entries
    .filter((e) => e.streak === max)
    .map((e) => ({ m: managerByEntry.get(e.entry), element: e.element }))
    .filter((w) => w.m); // drop entries for managers no longer in the league
  if (winners.length === 0) return null;
  return { value: max, winners };
}

// Highest-scoring player who was actually started (not benched) by at
// least one manager in the league this gameweek.
function playerOfTheWeek(managers, elementLiveStats) {
  const startedElements = new Set();
  for (const m of managers) {
    for (const p of m.picks) {
      if (!BENCH_POSITIONS.has(p.position)) startedElements.add(p.element);
    }
  }
  if (startedElements.size === 0) return null;

  const scored = [...startedElements].map((element) => ({
    element,
    points: elementLiveStats.get(element)?.points ?? 0,
  }));
  const max = Math.max(...scored.map((s) => s.points));
  if (max <= 0) return null;
  return { value: max, elements: scored.filter((s) => s.points === max).map((s) => s.element) };
}

// Most clean sheets across a manager's starting XI this gameweek.
function theWall(managers, elementLiveStats) {
  const scored = managers.map((m) => {
    let cleanSheets = 0;
    for (const p of m.picks) {
      if (BENCH_POSITIONS.has(p.position)) continue;
      cleanSheets += elementLiveStats.get(p.element)?.cleanSheets ?? 0;
    }
    return { m, cleanSheets };
  });
  const max = Math.max(...scored.map((s) => s.cleanSheets));
  if (max <= 0) return null;
  const winners = scored.filter((s) => s.cleanSheets === max);
  if (winners.length === scored.length && scored.length > 1) return null;
  return { value: max, winners: winners.map((s) => s.m) };
}

function computeInsights(managers, elementLivePoints, baselineStandings, rankHistory, benchWarmerStreaks, elementLiveStats) {
  const motw = managerOfTheWeek(managers);
  const avg = averagePoints(managers);
  return {
    motw,
    runnerUp: runnerUp(managers, motw),
    averagePoints: avg,
    rankMovers: rankMovers(managers, baselineStandings),
    transfers: bestWorstTransfers(managers, elementLivePoints),
    bench: mostPointsOnBench(managers),
    teamValue: bestTeamValue(managers),
    transfersSeason: mostTransfersThisSeason(managers),
    captained: mostCaptained(managers),
    owned: mostOwned(managers),
    transferredIn: mostTransferredIn(managers),
    transferredOut: mostTransferredOut(managers),
    superSub: superSub(managers, elementLivePoints),
    differentialCaptain: differentialCaptain(
      managers,
      elementLivePoints,
      computeOwnershipCounts(managers),
      managers.length,
      0.1
    ),
    teamTwins: teamTwins(managers),
    freeHitRegret: freeHitRegret(managers, avg),
    rankStreaks: rankStreaks(managers, rankHistory),
    mostConsistent: mostConsistent(managers),
    benchWarmer: longestSufferingBenchWarmer(benchWarmerStreaks, managers),
    playerOfTheWeek: playerOfTheWeek(managers, elementLiveStats),
    theWall: theWall(managers, elementLiveStats),
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function escapeMrkdwn(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// @mentions the manager's Slack user if manager-mapping.json has an entry
// for their FPL entry ID, otherwise falls back to "Player Name (Team Name)".
function mention(m, mapping) {
  const slackId = mapping[String(m.entry)];
  if (slackId) return `<@${slackId}>`;
  return `${escapeMrkdwn(m.playerName)} (${escapeMrkdwn(m.entryName)})`;
}

function mentionList(winners, mapping) {
  return winners.map((m) => mention(m, mapping)).join(', ');
}

function playerLabel(elementId, elementInfo) {
  const info = elementInfo.get(elementId);
  return info ? escapeMrkdwn(info.webName) : `Unknown player #${elementId}`;
}

function formatPercent(count, total) {
  const pct = (count / total) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

// Slack renders every section block with its own visual padding, so lines
// are grouped into a single block per logical section (joined by newlines)
// rather than one block per line — dividers still separate the groups.
function buildBlocks({ leagueName, gw, insights, elementInfo, managerCount, mapping }) {
  const blocks = [];
  const section = (text) => blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  const group = (lines) => {
    if (lines.length > 0) section(lines.join('\n'));
  };

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `GW ${gw} Summary — ${leagueName}`, emoji: true },
  });
  section(`_${managerCount} managers_`);
  blocks.push({ type: 'divider' });

  const {
    motw,
    runnerUp: ru,
    averagePoints: avg,
    rankMovers: rm,
    transfers,
    bench,
    teamValue,
    transfersSeason,
    captained,
    owned,
    transferredIn,
    transferredOut,
    superSub,
    differentialCaptain,
    teamTwins,
    freeHitRegret,
    rankStreaks,
    mostConsistent,
    benchWarmer,
    playerOfTheWeek,
    theWall,
  } = insights;

  const headlines = [];
  if (motw) {
    headlines.push(`:first_place_medal: *Manager${motw.winners.length > 1 ? 's' : ''} of the Week:* ${mentionList(motw.winners, mapping)} — ${motw.value}pts :fire:`);
  }
  if (ru) {
    headlines.push(`:second_place_medal: *Runner${ru.winners.length > 1 ? 's' : ''} Up:* ${mentionList(ru.winners, mapping)} — ${ru.value}pts`);
  }
  if (avg != null) {
    headlines.push(`:bar_chart: *Average points:* ${Math.round(avg * 10) / 10}pts`);
  }
  if (playerOfTheWeek) {
    const label = playerOfTheWeek.elements.map((e) => playerLabel(e, elementInfo)).join(', ');
    headlines.push(`:soccer: *Player of the Week:* ${label} — ${playerOfTheWeek.value}pts`);
  }
  if (bench) {
    headlines.push(`:sob: *Bench Watch:* ${mentionList(bench.winners, mapping)} left ${bench.value}pts on the bench`);
  }
  if (superSub) {
    const w = superSub.winners[0];
    headlines.push(
      `:muscle: *Super Sub:* ${mention(w.m, mapping)} — auto-sub ${playerLabel(w.elementIn, elementInfo)} in for ${playerLabel(w.elementOut, elementInfo)} gained +${superSub.value}pts`
    );
  }
  if (benchWarmer) {
    const w = benchWarmer.winners[0];
    headlines.push(
      `:zzz: *Longest-Suffering Bench Warmer:* ${playerLabel(w.element, elementInfo)} has warmed ${mention(w.m, mapping)}'s bench for ${benchWarmer.value} straight weeks`
    );
  }
  if (theWall) {
    headlines.push(`:bricks: *The Wall:* ${mentionList(theWall.winners, mapping)} — ${theWall.value} clean sheet${theWall.value === 1 ? '' : 's'} in the XI`);
  }
  group(headlines);

  blocks.push({ type: 'divider' });

  const transferLines = [':arrows_counterclockwise: *Transfers:*'];
  if (transfers.best) {
    const w = transfers.best.winners[0];
    transferLines.push(
      `:trophy: Best transfer this week: ${mention(w.m, mapping)} +${transfers.best.value.toFixed(1)} net pts (${playerLabel(w.elementIn, elementInfo)} in, ${playerLabel(w.elementOut, elementInfo)} out)`
    );
  }
  if (transfers.worst) {
    const w = transfers.worst.winners[0];
    transferLines.push(
      `:fire_extinguisher: Worst transfer this week: ${mention(w.m, mapping)} ${transfers.worst.value.toFixed(1)} net pts (${playerLabel(w.elementIn, elementInfo)} in, ${playerLabel(w.elementOut, elementInfo)} out)`
    );
  }
  if (!transfers.best && !transfers.worst) {
    transferLines.push(':shrug: No transfers made this gameweek.');
  }
  if (transfersSeason) {
    transferLines.push(`:recycle: Most transfers this season: ${mentionList(transfersSeason.winners, mapping)} ${transfersSeason.value} transfers`);
  }
  if (teamValue) {
    transferLines.push(`:moneybag: Best Team Value: ${mentionList(teamValue.winners, mapping)} £${teamValue.value.toFixed(1)}m`);
  }
  if (freeHitRegret) {
    const w = freeHitRegret.winners[0];
    transferLines.push(`:grimacing: *Hit Regret:* ${mention(w.m, mapping)} took a hit and still scored below average this week`);
  }
  group(transferLines);

  const rankLines = [];
  if (!rm.hasBaseline) {
    rankLines.push(':chart_with_upwards_trend: _Rank movers: no baseline yet — will appear from next week\'s run._');
  } else {
    if (rm.risers) {
      rankLines.push(`:arrow_up: *Biggest rank rise:* ${mentionList(rm.risers.winners, mapping)} — up ${rm.risers.value} place${rm.risers.value === 1 ? '' : 's'}`);
    }
    if (rm.fallers) {
      rankLines.push(`:arrow_down: *Biggest rank fall:* ${mentionList(rm.fallers.winners, mapping)} — down ${Math.abs(rm.fallers.value)} place${Math.abs(rm.fallers.value) === 1 ? '' : 's'}`);
    }
  }
  if (rankStreaks.rising) {
    rankLines.push(`:chart_with_upwards_trend: *On the Rise:* ${mentionList(rankStreaks.rising.winners.map((s) => s.m), mapping)} — climbing for ${rankStreaks.rising.value} straight weeks`);
  }
  if (rankStreaks.falling) {
    rankLines.push(`:chart_with_downwards_trend: *In Freefall:* ${mentionList(rankStreaks.falling.winners.map((s) => s.m), mapping)} — falling for ${rankStreaks.falling.value} straight weeks`);
  }
  if (mostConsistent) {
    rankLines.push(`:scales: *Most Consistent:* ${mentionList(mostConsistent.winners.map((c) => c.m), mapping)} — scores within ±${mostConsistent.value.toFixed(1)}pts of their average all season`);
  }
  group(rankLines);

  blocks.push({ type: 'divider' });

  const highlightLines = [':star: *Player Highlights*'];
  if (captained) {
    const label = captained.elements.map((e) => playerLabel(e, elementInfo)).join(', ');
    highlightLines.push(`:dart: Most captained: ${label} - ${formatPercent(captained.value, managerCount)} (${captained.value}/${managerCount})`);
  }
  if (owned) {
    const label = owned.elements.map((e) => playerLabel(e, elementInfo)).join(', ');
    highlightLines.push(`:purple_heart: Most owned: ${label} - ${formatPercent(owned.value, managerCount)} (${owned.value}/${managerCount})`);
  }
  if (transferredIn) {
    highlightLines.push(`:+1: Most transferred in: ${transferredIn.elements.map((e) => playerLabel(e, elementInfo)).join(', ')} (${transferredIn.value})`);
  }
  if (transferredOut) {
    highlightLines.push(`:-1: Most transferred out: ${transferredOut.elements.map((e) => playerLabel(e, elementInfo)).join(', ')} (${transferredOut.value})`);
  }
  if (differentialCaptain) {
    const w = differentialCaptain.winners[0];
    highlightLines.push(
      `:gem: Differential Captain: ${mention(w.m, mapping)} — ${playerLabel(w.element, elementInfo)} (${formatPercent(w.ownershipCount, managerCount)} owned) banked ${differentialCaptain.value}pts`
    );
  }
  if (teamTwins && teamTwins.diff <= 2) {
    const [a, b] = teamTwins.pair;
    highlightLines.push(
      `:busts_in_silhouette: Team Twins: ${mention(a, mapping)} & ${mention(b, mapping)} — squads differ by just ${teamTwins.diff} player${teamTwins.diff === 1 ? '' : 's'}`
    );
  }
  group(highlightLines);

  return blocks;
}

function blocksToText(blocks) {
  const lines = [];
  for (const b of blocks) {
    if (b.type === 'header') lines.push(`\n=== ${b.text.text} ===`);
    else if (b.type === 'divider') lines.push('-'.repeat(40));
    else if (b.type === 'section') {
      // Strip mrkdwn bold/italic markers for plain console reading. The
      // italics regex requires whitespace/string-boundary around the
      // underscores so it doesn't mangle emoji shortcodes like
      // ":first_place_medal:", which contain underscores mid-word.
      lines.push(
        b.text.text
          .replace(/\*(.+?)\*/g, '$1')
          .replace(/(^|\s)_(.+?)_(\s|$)/g, '$1$2$3')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
      );
    }
  }
  return lines.join('\n');
}

async function postToSlack(webhookUrl, blocks) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Slack webhook POST failed with ${res.status}: ${body.slice(0, 500)}`);
  }
}

// ---------------------------------------------------------------------------
// Season review (--season-review) — a one-off "season so far" post, e.g. for
// an international break. Read-only: never touches the weekly snapshot.
// ---------------------------------------------------------------------------

async function fetchManagerSeason(entryId, gw, limit) {
  const [history, transfers] = await Promise.all([
    limit(() => fplGet(`entry/${entryId}/history/`)),
    limit(() => fplGet(`entry/${entryId}/transfers/`)),
  ]);
  requireShape(history, (h) => Array.isArray(h?.current), `entry/${entryId}/history/.current should be an array`);
  requireShape(history, (h) => Array.isArray(h?.chips), `entry/${entryId}/history/.chips should be an array`);
  requireShape(transfers, (t) => Array.isArray(t), `entry/${entryId}/transfers/ should be an array`);

  const seasonHistory = history.current.filter((h) => h.event <= gw);

  // One picks call per gameweek played, for season captaincy totals.
  const picksByGw = new Map();
  await Promise.all(
    seasonHistory.map(async (h) => {
      let picks;
      try {
        picks = await limit(() => fplGet(`entry/${entryId}/event/${h.event}/picks/`));
      } catch (err) {
        if (err instanceof FplHttpError && err.status === 404) return;
        throw err;
      }
      requireShape(picks, (p) => Array.isArray(p?.picks), `entry/${entryId}/event/${h.event}/picks/.picks should be an array`);
      picksByGw.set(
        h.event,
        picks.picks.map((p) => ({
          element: p.element,
          multiplier: p.multiplier,
          isCaptain: !!p.is_captain,
          isViceCaptain: !!p.is_vice_captain,
        }))
      );
    })
  );

  return {
    seasonHistory,
    chips: history.chips.filter((c) => c.event <= gw).map((c) => ({ name: c.name, event: c.event })),
    transfers: transfers
      .filter((t) => t.event <= gw)
      .map((t) => ({ event: t.event, elementIn: t.element_in, elementOut: t.element_out })),
    picksByGw,
  };
}

async function collectSeasonData(leagueId, gw) {
  const { leagueName, entries } = await fetchLeagueStandings(leagueId);
  const limit = createLimiter(6);

  const managers = await Promise.all(
    entries.map(async (entry) => {
      const detail = await fetchManagerSeason(entry.entry, gw, limit);
      const playedGws = new Set(detail.seasonHistory.map((h) => h.event));
      return {
        entry: entry.entry,
        playerName: entry.player_name,
        entryName: entry.entry_name,
        leagueRank: entry.rank,
        seasonTotal: entry.total,
        // Season-long totals (fewest transfers, bench points, ...) are only
        // fair between managers who've played every gameweek so far.
        fullSeason: Array.from({ length: gw }, (_, i) => i + 1).every((g) => playedGws.has(g)),
        ...detail,
      };
    })
  );

  const liveByGw = new Map();
  for (let g = 1; g <= gw; g++) {
    console.error(`Fetching event/${g}/live/ ...`);
    liveByGw.set(g, await fetchLiveGwStats(g));
  }

  return { leagueName, managers, liveByGw };
}

// Mirror of topBy for "fewest/lowest" awards.
function bottomBy(managers, selector) {
  const result = topBy(managers, (m) => {
    const v = selector(m);
    return v == null ? null : -v;
  });
  return result && { value: -result.value, winners: result.winners };
}

function sumHistory(m, field, skipEvents = new Set()) {
  return m.seasonHistory.filter((h) => !skipEvents.has(h.event)).reduce((sum, h) => sum + (h[field] || 0), 0);
}

function chipEvents(m, chipName) {
  return new Set(m.chips.filter((c) => c.name === chipName).map((c) => c.event));
}

// League rank (ties share a rank) by cumulative points after gameweek g,
// among managers who'd played that gameweek.
function leagueRanksAfter(managers, g) {
  const totals = [];
  for (const m of managers) {
    const h = m.seasonHistory.find((x) => x.event === g);
    if (h) totals.push({ m, total: h.total_points });
  }
  const ranks = new Map();
  for (const t of totals) {
    ranks.set(t.m.entry, 1 + totals.filter((o) => o.total > t.total).length);
  }
  return ranks;
}

function seasonTable(managers, size) {
  const sorted = [...managers].sort((a, b) => a.leagueRank - b.leagueRank);
  if (sorted.length === 0) return null;
  const leaderTotal = sorted[0].seasonTotal;
  return sorted.slice(0, size).map((m) => ({ m, gap: leaderTotal - m.seasonTotal }));
}

function movesSinceGw1(managers, gw) {
  if (gw < 2) return { risers: null, fallers: null };
  const startRanks = leagueRanksAfter(managers, 1);
  const deltas = managers
    .filter((m) => startRanks.has(m.entry))
    .map((m) => ({ m, delta: startRanks.get(m.entry) - m.leagueRank }));
  if (deltas.length === 0) return { risers: null, fallers: null };
  const maxDelta = Math.max(...deltas.map((d) => d.delta));
  const minDelta = Math.min(...deltas.map((d) => d.delta));
  return {
    risers: maxDelta > 0 ? { value: maxDelta, winners: deltas.filter((d) => d.delta === maxDelta).map((d) => d.m) } : null,
    fallers: minDelta < 0 ? { value: minDelta, winners: deltas.filter((d) => d.delta === minDelta).map((d) => d.m) } : null,
  };
}

// Weeks spent top of the league (ties at the top count for everyone tied).
function topDog(managers, gw) {
  const weeksTop = new Map();
  for (let g = 1; g <= gw; g++) {
    const ranks = leagueRanksAfter(managers, g);
    for (const m of managers) {
      if (ranks.get(m.entry) === 1) weeksTop.set(m, (weeksTop.get(m) || 0) + 1);
    }
  }
  if (weeksTop.size === 0) return null;
  return [...weeksTop.entries()].map(([m, weeks]) => ({ m, weeks })).sort((a, b) => b.weeks - a.weeks);
}

// Net points gained from transfers: for each transfer, the incoming player's
// points minus the outgoing player's, from the transfer gameweek through `gw`,
// minus hits taken. Chained transfers telescope (A->B then B->C nets out to
// the players actually held each week). Free Hit transfers are skipped since
// the squad reverts the following week.
function transferNet(m, liveByGw, gw) {
  if (m.transfers.length === 0) return null;
  const freeHitEvents = chipEvents(m, 'freehit');
  let net = 0;
  for (const t of m.transfers) {
    if (freeHitEvents.has(t.event)) continue;
    for (let g = t.event; g <= gw; g++) {
      const live = liveByGw.get(g);
      net += (live?.get(t.elementIn)?.points ?? 0) - (live?.get(t.elementOut)?.points ?? 0);
    }
  }
  return net - sumHistory(m, 'event_transfers_cost');
}

// Season captain points. If the captain didn't play, the vice-captain takes
// the armband (and the multiplier, so a Triple Captain passes on 3x).
function seasonCaptainPoints(m, liveByGw) {
  let total = 0;
  for (const [g, picks] of m.picksByGw) {
    const live = liveByGw.get(g);
    const captain = picks.find((p) => p.isCaptain);
    if (!captain || !live) continue;
    const vice = picks.find((p) => p.isViceCaptain);
    const multiplier = captain.multiplier >= 2 ? captain.multiplier : 2;
    let armband = captain.element;
    if ((live.get(captain.element)?.minutes ?? 0) === 0 && vice && (live.get(vice.element)?.minutes ?? 0) > 0) {
      armband = vice.element;
    }
    total += (live.get(armband)?.points ?? 0) * multiplier;
  }
  return total;
}

// Chips reset at GW20 (two sets per season since 2025/26), so "in hand"
// only looks at the current half.
const CHIP_LABELS = { wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain' };
const SECOND_HALF_START_GW = 20;

function chipsInHand(managers, gw) {
  if (managers.length === 0) return null;
  const halfStart = gw >= SECOND_HALF_START_GW ? SECOND_HALF_START_GW : 1;
  const chipsThisHalf = (m) => m.chips.filter((c) => c.event >= halfStart);
  const holding = Object.entries(CHIP_LABELS).map(([name, label]) => ({
    label,
    count: managers.filter((m) => !chipsThisHalf(m).some((c) => c.name === name)).length,
  }));
  return {
    holding,
    untouched: managers.filter((m) => chipsThisHalf(m).length === 0).length,
    total: managers.length,
    secondHalf: halfStart > 1,
  };
}

function computeSeasonInsights(managers, liveByGw, gw) {
  const full = managers.filter((m) => m.fullSeason);
  const withNet = full.map((m) => ({ m, net: transferNet(m, liveByGw, gw) }));
  const netOf = new Map(withNet.map((x) => [x.m, x.net]));
  const captainOf = new Map(full.map((m) => [m, seasonCaptainPoints(m, liveByGw)]));
  const directorOfFootball = topBy(full, (m) => netOf.get(m));

  return {
    table: seasonTable(managers, 10),
    moves: movesSinceGw1(managers, gw),
    topDog: topDog(managers, gw),
    casual: bottomBy(full, (m) => m.transfers.length),
    sackTheManager: bottomBy(full, (m) => netOf.get(m)),
    directorOfFootball: directorOfFootball && directorOfFootball.value > 0 ? directorOfFootball : null,
    hitAddict: topBy(full, (m) => {
      const hits = sumHistory(m, 'event_transfers_cost');
      return hits > 0 ? hits : null;
    }),
    benchRegret: topBy(full, (m) => sumHistory(m, 'points_on_bench', chipEvents(m, 'bboost'))),
    armbandMerchant: topBy(full, (m) => captainOf.get(m)),
    captainCalamity: bottomBy(full, (m) => captainOf.get(m)),
    chips: chipsInHand(managers, gw),
  };
}

// A long list of tied names reads badly in Slack — collapse it past a few.
function winnersText(winners, mapping, max = 3) {
  if (winners.length > max) return `${winners.length} managers tied`;
  return mentionList(winners, mapping);
}

function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}

function buildSeasonBlocks({ leagueName, gw, insights, managerCount, mapping }) {
  const blocks = [];
  const section = (text) => blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  const group = (lines) => {
    if (lines.length > 0) section(lines.join('\n'));
  };
  const {
    table,
    moves,
    topDog: leaders,
    casual,
    sackTheManager,
    directorOfFootball,
    hitAddict,
    benchRegret,
    armbandMerchant,
    captainCalamity,
    chips,
  } = insights;

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `Season So Far (GW1–${gw}) — ${leagueName}`, emoji: true },
  });
  section(`_The story after ${gw} gameweek${gw === 1 ? '' : 's'} · ${managerCount} managers_`);
  blocks.push({ type: 'divider' });

  if (table) {
    const lines = [`:trophy: *Top ${table.length}*`];
    for (const [i, row] of table.entries()) {
      const gap = i === 0 ? '' : ` _(-${row.gap})_`;
      lines.push(`${row.m.leagueRank}. ${mention(row.m, mapping)} — ${row.m.seasonTotal}pts${gap}`);
    }
    group(lines);
  }

  const moveLines = [];
  if (moves.risers) {
    moveLines.push(`:rocket: *Biggest climber since GW1:* ${winnersText(moves.risers.winners, mapping)} — up ${moves.risers.value} place${moves.risers.value === 1 ? '' : 's'}`);
  }
  if (moves.fallers) {
    const n = Math.abs(moves.fallers.value);
    moveLines.push(`:parachute: *Biggest faller since GW1:* ${winnersText(moves.fallers.winners, mapping)} — down ${n} place${n === 1 ? '' : 's'}`);
  }
  group(moveLines);

  blocks.push({ type: 'divider' });

  const awardLines = [':medal: *Season Awards*'];
  if (leaders && leaders.length > 0) {
    const top = leaders.slice(0, 3).map((l) => `${mention(l.m, mapping)} (${l.weeks} week${l.weeks === 1 ? '' : 's'})`);
    awardLines.push(`:crown: *Top Dog:* weeks spent top of the league — ${top.join(', ')}`);
  }
  if (casual) {
    const hasnt = casual.winners.length === 1 ? "hasn't" : "haven't";
    const detail = casual.value === 0 ? `${hasnt} made a single transfer` : `just ${casual.value} transfer${casual.value === 1 ? '' : 's'} all season`;
    awardLines.push(`:sloth: *The Casual:* ${winnersText(casual.winners, mapping)} — ${detail}`);
  }
  if (sackTheManager) {
    awardLines.push(`:fire: *Sack the Manager:* ${winnersText(sackTheManager.winners, mapping)} — transfers have netted ${signed(sackTheManager.value)}pts (after hits)`);
  }
  if (directorOfFootball) {
    awardLines.push(`:briefcase: *Director of Football:* ${winnersText(directorOfFootball.winners, mapping)} — transfers have netted ${signed(directorOfFootball.value)}pts (after hits)`);
  }
  if (hitAddict) {
    awardLines.push(`:money_with_wings: *Hit Addict:* ${winnersText(hitAddict.winners, mapping)} — ${hitAddict.value}pts spent on hits`);
  }
  if (benchRegret) {
    awardLines.push(`:sob: *Bench Regret:* ${winnersText(benchRegret.winners, mapping)} — ${benchRegret.value}pts left on the bench`);
  }
  if (armbandMerchant) {
    awardLines.push(`:muscle: *Armband Merchant:* ${winnersText(armbandMerchant.winners, mapping)} — ${armbandMerchant.value}pts from captains`);
  }
  if (captainCalamity) {
    awardLines.push(`:clown_face: *Captain Calamity:* ${winnersText(captainCalamity.winners, mapping)} — only ${captainCalamity.value}pts from captains`);
  }
  group(awardLines);

  if (chips) {
    blocks.push({ type: 'divider' });
    const chipLines = [`:black_joker: *Chips in Hand*${chips.secondHalf ? ' _(second-half chips)_' : ''}`];
    chipLines.push(chips.holding.map((h) => `${h.label} ${h.count}/${chips.total}`).join(' · '));
    if (chips.untouched > 0) {
      chipLines.push(`${chips.untouched} manager${chips.untouched === 1 ? " hasn't" : "s haven't"} played a single chip yet`);
    }
    group(chipLines);
  }

  return blocks;
}

async function runSeasonReview(config, args, gw) {
  console.error(`Building season review through Gameweek ${gw}`);
  console.error(`Fetching leagues-classic/${config.leagueId}/standings/ and per-manager history ...`);
  const { leagueName, managers, liveByGw } = await collectSeasonData(config.leagueId, gw);
  console.error(`Fetched data for ${managers.length} managers`);

  const mapping = await loadManagerMapping();
  const insights = computeSeasonInsights(managers, liveByGw, gw);
  const blocks = buildSeasonBlocks({ leagueName, gw, insights, managerCount: managers.length, mapping });

  console.log(blocksToText(blocks));

  if (args.post) {
    console.error('Posting to Slack ...');
    await postToSlack(config.slackWebhookUrl, blocks);
    console.error('Posted to Slack.');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (args.post && !config.slackWebhookUrl) {
    throw new Error('--post was passed but SLACK_WEBHOOK_URL is not set.');
  }

  console.error('Fetching bootstrap-static/ ...');
  const { events, elementInfo } = await fetchBootstrap();

  const { gw, event } = detectGameweek(events, args.gw);
  if (gw == null) {
    console.log('No gameweek has finished yet this season — nothing to report.');
    return;
  }

  if (args.seasonReview) {
    await runSeasonReview(config, args, gw);
    return;
  }

  console.error(`Reporting on Gameweek ${gw}${event?.data_checked ? '' : ' (bonus not yet finalised)'}`);

  console.error(`Fetching leagues-classic/${config.leagueId}/standings/ ...`);
  const { leagueName, managers } = await collectLeagueData(config.leagueId, gw);
  console.error(`Fetched data for ${managers.length} managers`);

  if (args.listManagers) {
    console.log('FPL entry ID -> player name (team name), for building manager-mapping.json:\n');
    for (const m of managers) {
      console.log(`"${m.entry}": "",  // ${m.playerName} (${m.entryName})`);
    }
    return;
  }

  console.error(`Fetching event/${gw}/live/ ...`);
  const elementLiveStats = await fetchLiveGwStats(gw);
  const elementLivePoints = new Map([...elementLiveStats].map(([id, s]) => [id, s.points]));

  const mapping = await loadManagerMapping();

  const existingSnapshot = await readSnapshot();
  const generatedAt = new Date().toISOString();
  const currentStandingsMap = buildStandingsMap(managers);
  const { baseline, nextSnapshot } = resolveBaseline(existingSnapshot, gw, generatedAt, currentStandingsMap);
  const rankHistory = updateRankHistory(existingSnapshot?.rankHistory, gw, managers);
  const benchWarmerUpdates = computeBenchWarmerUpdates(managers, gw);
  const benchWarmerStreaks = updateBenchWarmerStreaks(existingSnapshot?.benchWarmerStreaks, gw, benchWarmerUpdates);

  const insights = computeInsights(
    managers,
    elementLivePoints,
    baseline?.standings ?? null,
    rankHistory,
    benchWarmerStreaks,
    elementLiveStats
  );
  const blocks = buildBlocks({ leagueName, gw, insights, elementInfo, managerCount: managers.length, mapping });

  console.log(blocksToText(blocks));

  if (!args.dryRun) {
    await writeSnapshot({ ...nextSnapshot, rankHistory, benchWarmerStreaks });
    console.error(`Snapshot updated at data/last-standings.json`);
  } else {
    console.error('Skipped snapshot write (--dry-run)');
  }

  if (args.post) {
    console.error('Posting to Slack ...');
    await postToSlack(config.slackWebhookUrl, blocks);
    console.error('Posted to Slack.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exitCode = 1;
});
