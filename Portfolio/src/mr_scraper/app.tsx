import { useEffect, useMemo, useState } from "preact/hooks";
import { ApiError, fetchRecentMatches, findPlayer, loadHeroStats, type MrHeroStats, type MrMatch, type MrPlayer } from "./api.ts";
import { bracketFor, heroMeta, pct, recommendBans, type BanSuggestion, type MetaBracket } from "./bans.ts";
import {
  analyzeMatches,
  DEFAULT_GAME_MODES,
  gameModeName,
  OBJECTIVES,
  ONE_TRICK_ALPHA,
  ONE_TRICK_MIN_GAMES,
  oneTrick,
  playerRole,
  ROLE_MAIN_SHARE,
  topHeroes,
  winRate,
  type Breakdown,
  type GameModeInfo,
  type Objective,
  type OneTrick,
  type PlayerAnalysis,
  type PlayerRole,
} from "./analysis.ts";
import { clearStored, usePersistentState } from "../shared/storage.ts";
import { formatScore, rankName, rankTier, seasonLabel, type RankEntry, type RankSummary } from "./rank.ts";
import { ROLE_LABELS } from "./data/roles.ts";

// localStorage keys (see shared/storage.ts); bump the suffix if the saved shape changes.
const STORE = {
  players: "mr_scraper:players.v1",
  results: "mr_scraper:results.v2",
  banExcluded: "mr_scraper:banExcluded.v1",
  seasonsBack: "mr_scraper:seasonsBack.v1",
  modes: "mr_scraper:modes.v1",
  selected: "mr_scraper:selected.v1",
} as const;

// The form always shows at least this many player inputs (a full team).
const MIN_PLAYER_SLOTS = 6;

/** Pads a saved player list from an older default up to the current minimum. */
const padPlayers = (list: string[]) => (list.length >= MIN_PLAYER_SLOTS ? list : [...list, ...Array(MIN_PLAYER_SLOTS - list.length).fill("")]);

// Marvel Rivals usernames: 2-20 visible characters (a numeric UID also fits).
const USERNAME_PATTERN = /^\S.{0,18}\S$/;

// Each season adds up to 120 matches (MarvelRivalsAPI.com) or 20 (rivalsmeta.com); cap how far back the page will look.
const MAX_SEASONS_BACK = 5;

const RESULT_LABEL = { win: "W", loss: "L", draw: "D" } as const;

/** Raw fetch result per player; analysis is recomputed from this whenever the mode filter changes. */
type PlayerResult =
  | { status: "loading"; message: string }
  | { status: "error"; message: string }
  | { status: "done"; player: MrPlayer; matches: MrMatch[]; seasons: number[]; rank?: RankSummary };

type DonePlayer = { username: string; player: MrPlayer; matches: MrMatch[]; seasons: number[]; rank?: RankSummary; analysis: PlayerAnalysis };

function finishedOnly(results: Record<string, PlayerResult>): Record<string, PlayerResult> {
  return Object.fromEntries(Object.entries(results).filter(([, r]) => r.status !== "loading"));
}

const formatDate = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleDateString();

/** One rank line: tier-coloured name plus score, e.g. "Diamond 2 · 4,120 RS". */
function RankLabel({ entry, peak }: { entry: RankEntry | null; peak?: boolean }) {
  if (!entry) return <span class="mr-rank is-unranked">Unranked</span>;
  const level = peak ? entry.maxLevel : entry.level;
  const score = peak ? entry.maxScore : entry.score;
  return (
    <span
      class={`mr-rank is-${rankTier(level)}`}
      title={peak ? `Highest rank reached, ${seasonLabel(entry.season)}` : `${seasonLabel(entry.season)} · ${entry.games} ranked game${entry.games === 1 ? "" : "s"}`}
    >
      <span class="mr-rank-name">{rankName(level)}</span>
      {level > 0 && score > 0 && <span class="mr-rank-score">{formatScore(score)}</span>}
      {!peak && level > 0 && entry.games === 0 && <span class="mr-rank-score">0 games</span>}
    </span>
  );
}

/** Current and peak rank stacked, for the summary table and the detail header. */
function RankIndicator({ rank }: { rank?: RankSummary }) {
  if (!rank) return <span class="sc-muted">Re-run to load ranks</span>;
  const current = rank.current && rank.current.level > 0 ? rank.current : null;
  const peakBeatsCurrent = rank.peak && (!current || rank.peak.maxLevel > current.level || rank.peak.season !== current.season);
  return (
    <span class="mr-ranks">
      <span class="mr-rank-row">
        <span class="mr-rank-label">Now</span> <RankLabel entry={current} />
      </span>
      {rank.peak && (
        <span class="mr-rank-row">
          <span class="mr-rank-label">Peak</span> <RankLabel entry={rank.peak} peak />
          {peakBeatsCurrent && <span class="mr-rank-season">{seasonLabel(rank.peak.season)}</span>}
        </span>
      )}
    </span>
  );
}

type HeroStatsState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "done"; season: number; stats: MrHeroStats };

/** The top heroes worth banning against this lineup, from hero overlap weighted by the current ranked meta. */
function BanSuggestions({ lineup, statsState, bracket, excluded }: { lineup: DonePlayer[]; statsState: HeroStatsState; bracket: MetaBracket; excluded: number }) {
  const meta = useMemo(() => (statsState.status === "done" ? heroMeta(statsState.stats, bracket) : null), [statsState, bracket]);
  const suggestions = useMemo(
    () => recommendBans(lineup.map((p) => ({ name: p.player.name, analysis: p.analysis })), meta),
    [lineup, meta],
  );
  const metaNote =
    statsState.status === "done"
      ? `${bracket.label} ranked, ${seasonLabel(statsState.season)}`
      : statsState.status === "loading"
        ? "loading current meta…"
        : statsState.status === "error"
          ? `meta unavailable (${statsState.message})`
          : "meta not loaded";

  return (
    <section class="mr-bans" aria-label="Suggested bans">
      <header class="sc-report-header">
        <div>
          <h3>Suggested bans</h3>
          <p class="sc-muted">
            Heroes this lineup leans on, weighted by the current meta ({metaNote}). Score = overlap across players, plus one-trick and multi-player
            bonuses, scaled by win rate and ban rate.
            {excluded > 0 && ` ${excluded} player${excluded === 1 ? " is" : "s are"} left out; tick "count in bans" in the table to include them.`}
          </p>
        </div>
      </header>
      {suggestions.length === 0 ? (
        <p class="mr-note">
          {lineup.length === 0 ? "Every player is left out of the ban calculation." : "No hero data in the selected game modes yet, so there is nothing to base a ban on."}
        </p>
      ) : (
        <ol class="mr-ban-list">
          {suggestions.map((s, i) => (
            <BanCard key={s.hero} index={i + 1} suggestion={s} lineupSize={lineup.length} />
          ))}
        </ol>
      )}
    </section>
  );
}

function BanCard({ index, suggestion: s, lineupSize }: { index: number; suggestion: BanSuggestion; lineupSize: number }) {
  const regulars = s.players.filter((p) => p.games >= 2);
  return (
    <li class={`mr-ban-card ${s.metaOnly ? "is-meta-only" : ""}`}>
      <div class="mr-ban-head">
        <span class="mr-ban-index">#{index}</span>
        <span class="mr-ban-hero">{s.hero}</span>
      </div>
      <p class="mr-ban-why">
        {s.metaOnly ? (
          <span class="sc-muted">Nobody in this lineup plays it; added as a strong meta ban.</span>
        ) : (
          <>
            Played by {regulars.length || s.players.length} of {lineupSize}
            {s.players.some((p) => p.oneTrick) && <span class="mr-one-trick">One-trick</span>}
          </>
        )}
      </p>
      {s.players.length > 0 && (
        <ul class="mr-ban-players">
          {s.players.map((p) => (
            <li key={p.name} class={p.oneTrick ? "is-one-trick" : ""}>
              <span class="mr-ban-player">{p.name}</span>
              <span class="mr-ban-share">
                {pct(p.share)} · ×{p.games}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p class="mr-ban-meta">
        {s.meta ? (
          <>
            <span title="Win rate">{pct(s.meta.winRate, 1)} WR</span>
            <span title="Share of matches where this hero was banned">{pct(s.meta.banRate)} banned</span>
            <span title="Share of team slots">{pct(s.meta.pickRate, 1)} picked</span>
          </>
        ) : (
          <span class="sc-muted">No meta data for this hero</span>
        )}
      </p>
    </li>
  );
}

/** Role badge: Tank / DPS / Support when one role has most of the games, otherwise Flex. Hover for the split. */
function RoleBadge({ role }: { role: PlayerRole | null }) {
  if (!role) return null;
  const split = role.shares.map((s) => `${ROLE_LABELS[s.role]} ${Math.round(s.share * 100)}% (${s.games})`).join(" · ");
  return (
    <span class={`mr-role is-${role.role}`} title={split}>
      {role.label}
      {role.role !== "flex" && <span class="mr-role-share">{Math.round(role.shares[0].share * 100)}%</span>}
    </span>
  );
}

/** Badge shown next to a player who almost only plays one hero. */
function OneTrickBadge({ trick }: { trick: OneTrick | null }) {
  if (!trick) return null;
  const pct = Math.round(trick.share * 100);
  return (
    <span
      class="mr-one-trick"
      title={`${trick.games} of ${trick.total} counted games on ${trick.hero}${trick.runnerUp ? `; next is ${trick.runnerUp.hero} with ${trick.runnerUp.games} (p = ${trick.pValue < 0.001 ? "<0.001" : trick.pValue.toFixed(3)})` : "; no other hero played"}`}
    >
      One-trick · {trick.hero} {pct}%
    </span>
  );
}

/** Summary cell: most played hero in one breakdown, with tie highlight and a hover card of the rest. */
function TopHeroCell({ breakdown, label }: { breakdown: Breakdown; label: string }) {
  const tied = topHeroes(breakdown.heroes);
  const top = tied[0];
  if (!top) return <td class="sc-empty">—</td>;

  const tiedNames = new Set(tied.slice(1).map((h) => h.hero));
  const isTie = tiedNames.size > 0;
  const alsoPlayed = breakdown.heroes.filter((h) => h.hero !== top.hero);

  return (
    <td>
      <span
        class={`sc-top ${isTie ? "is-tied" : ""}`}
        tabindex={0}
        aria-label={isTie ? `${top.hero}, tied with ${[...tiedNames].join(", ")}` : undefined}
      >
        <span class="sc-agent-name">{top.hero}</span>
        <span class="sc-hover-card" role="tooltip">
          <span class="sc-hover-title">
            {isTie ? `Tied for most played (${label})` : alsoPlayed.length ? `Also played (${label})` : `Only hero played (${label})`}
          </span>
          {alsoPlayed.length > 0 && (
            <ul class="sc-hover-list">
              {alsoPlayed.map((h) => (
                <li key={h.hero} class={tiedNames.has(h.hero) ? "is-tied" : ""}>
                  <span class="sc-agent-name">
                    {h.hero}
                    {tiedNames.has(h.hero) && <span class="sc-tied-mark"> tied</span>}
                  </span>
                  <span class="sc-agent-record">
                    ×{h.games} · {h.wins}W-{h.losses}L{h.draws ? `-${h.draws}D` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </span>
      </span>{" "}
      <span class="sc-agent-record">
        ×{top.games} of {breakdown.games}
      </span>
    </td>
  );
}

/** Per-objective detail for one player: hero history, win/loss, recent heroes. */
function PlayerDetail({ player, objectives }: { player: DonePlayer; objectives: Objective[] }) {
  const { analysis } = player;
  const rate = winRate(analysis.overall);
  const rows: { label: string; breakdown: Breakdown }[] = [
    { label: "Overall", breakdown: analysis.overall },
    ...objectives.map((o) => ({ label: o, breakdown: analysis.byObjective[o] })),
  ];
  const seasonsText =
    player.seasons.length > 1
      ? `${seasonLabel(Math.min(...player.seasons))}–${seasonLabel(Math.max(...player.seasons))}`
      : player.seasons.length === 1
        ? seasonLabel(player.seasons[0])
        : "";

  return (
    <article class="sc-report">
      <header class="sc-report-header">
        <div>
          <h3>
            {player.player.name} <RoleBadge role={playerRole(analysis.overall)} /> <OneTrickBadge trick={oneTrick(analysis.overall)} />
          </h3>
          <p class="mr-rank-line">
            <RankIndicator rank={player.rank} />
          </p>
          <p class="sc-muted">
            UID {player.player.uid} · {player.matches.length} match{player.matches.length === 1 ? "" : "es"} fetched{seasonsText && ` (${seasonsText})`} ·{" "}
            {analysis.overall.games} counted
            {rate !== null && ` · ${rate}% win rate`}
            {analysis.skippedNoHero > 0 && ` · ${analysis.skippedNoHero} skipped (no hero recorded)`}
            {player.player.candidates > 1 && ` · exact name match chosen from ${player.player.candidates} similar names`}
            {player.player.caseInsensitive && ` · matched ignoring letter case`}
            {player.player.source && ` · via ${player.player.source}`}
          </p>
        </div>
      </header>

      {analysis.overall.games === 0 ? (
        <p class="sc-muted">No matches in the selected game modes.</p>
      ) : (
        <div class="sc-table-scroll">
          <table class="sc-table sc-detail">
            <thead>
              <tr>
                <th>Mode</th>
                <th class="sc-num">W / L</th>
                <th>Hero history</th>
                <th>Most recent</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((r) => r.breakdown.games > 0)
                .map((r) => {
                  const rowRate = winRate(r.breakdown);
                  return (
                    <tr key={r.label}>
                      <td class="sc-map">
                        {r.label}
                        <span class="sc-map-games">
                          {r.breakdown.games} game{r.breakdown.games === 1 ? "" : "s"}
                        </span>
                      </td>
                      <td class="sc-num">
                        <span class="sc-record">
                          {r.breakdown.wins}W-{r.breakdown.losses}L{r.breakdown.draws ? `-${r.breakdown.draws}D` : ""}
                        </span>
                        <span class="sc-rate">{rowRate === null ? "—" : `${rowRate}%`}</span>
                      </td>
                      <td>
                        <ul class="sc-agents">
                          {r.breakdown.heroes.map((h) => (
                            <li key={h.hero} class="sc-agent">
                              <span class="sc-agent-name">{h.hero}</span>
                              <span class="sc-agent-games">×{h.games}</span>
                              <span class="sc-agent-record" title="wins-losses">
                                {h.wins}W-{h.losses}L{h.draws ? `-${h.draws}D` : ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td>
                        <ol class="sc-recent" aria-label="Most recent games, newest first">
                          {r.breakdown.recent.map((g) => (
                            <li
                              key={`${g.startedAt}:${g.hero}`}
                              class={`sc-recent-game is-${g.result}`}
                              title={`${formatDate(g.startedAt)} · ${g.map} · ${g.result}`}
                            >
                              {g.hero}
                              <span class="sc-recent-result">{RESULT_LABEL[g.result]}</span>
                            </li>
                          ))}
                        </ol>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

/** Which game_mode_ids to count. Defaults to competitive + custom; falls back to everything if neither is present. */
function resolveIncludedModes(stored: number[] | null, found: GameModeInfo[]): Set<number> {
  const available = new Set(found.map((m) => m.id));
  if (stored) {
    const kept = stored.filter((id) => available.has(id));
    if (kept.length > 0) return new Set(kept);
  }
  const defaults = DEFAULT_GAME_MODES.filter((id) => available.has(id));
  return new Set(defaults.length > 0 ? defaults : available);
}

function ResultsSummary({ usernames, results }: { usernames: string[]; results: Record<string, PlayerResult> }) {
  const [storedModes, setStoredModes] = usePersistentState<number[] | null>(STORE.modes, () => null);
  const [selectedPlayers, setSelectedPlayers] = usePersistentState<string[]>(STORE.selected, () => []);
  // Players left out of the ban suggestions (everyone counts by default).
  const [banExcluded, setBanExcluded] = usePersistentState<string[]>(STORE.banExcluded, () => []);

  function toggleBanPlayer(username: string) {
    setBanExcluded((cur) => (cur.includes(username) ? cur.filter((u) => u !== username) : [...cur, username]));
  }

  function togglePlayer(username: string) {
    setSelectedPlayers((cur) => (cur.includes(username) ? cur.filter((u) => u !== username) : [...cur, username]));
  }

  const finished = usernames.flatMap((username) => {
    const r = results[username];
    return r?.status === "done" ? [{ username, player: r.player, matches: r.matches, seasons: r.seasons, rank: r.rank }] : [];
  });
  const pending = usernames.flatMap((username) => {
    const r = results[username];
    return r && r.status !== "done" ? [{ username, status: r.status, message: r.message }] : [];
  });

  // Game modes present across everyone's raw history, before filtering.
  const modeTotals = new Map<number, GameModeInfo>();
  for (const p of finished) {
    for (const m of analyzeMatches(p.matches, new Set()).gameModes) {
      const info = modeTotals.get(m.id) ?? { id: m.id, name: m.name, games: 0 };
      info.games += m.games;
      modeTotals.set(m.id, info);
    }
  }
  const modesFound = [...modeTotals.values()].sort((a, b) => a.id - b.id);
  const included = resolveIncludedModes(storedModes, modesFound);

  function toggleMode(id: number) {
    const next = new Set(included);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setStoredModes([...next]);
  }

  const done: DonePlayer[] = finished.map((p) => ({ ...p, analysis: analyzeMatches(p.matches, included) }));
  // Only show the "Other" column when someone actually has games there.
  const objectives = OBJECTIVES.filter((o) => o !== "Other" || done.some((p) => p.analysis.byObjective.Other.games > 0));
  const unknownMaps = new Set(done.flatMap((p) => p.analysis.unknownMapIds));
  const details = done.filter((p) => selectedPlayers.includes(p.username));

  // Which seasons the fetched histories span, e.g. "S9.5–S10 (up to 40 matches per player)".
  const allSeasons = done.flatMap((p) => p.seasons);
  const coverage =
    allSeasons.length > 0
      ? (() => {
          const lo = Math.min(...allSeasons);
          const hi = Math.max(...allSeasons);
          const perPlayer = Math.max(...done.map((p) => p.matches.length));
          return `${lo === hi ? seasonLabel(hi) : `${seasonLabel(lo)}–${seasonLabel(hi)}`} (up to ${perPlayer} matches per player)`;
        })()
      : "";

  // Current-season hero stats for the ban suggestions, fetched once per season and cached.
  const metaSeason = done.reduce<number | null>((best, p) => (p.seasons.length ? Math.max(best ?? 0, ...p.seasons) : best), null);
  const [statsState, setStatsState] = useState<HeroStatsState>({ status: "idle" });
  useEffect(() => {
    if (metaSeason === null || done.length === 0) return;
    if (statsState.status === "done" && statsState.season === metaSeason) return;
    let cancelled = false;
    setStatsState({ status: "loading" });
    loadHeroStats(metaSeason)
      .then((stats) => !cancelled && setStatsState({ status: "done", season: metaSeason, stats }))
      .catch((err) => !cancelled && setStatsState({ status: "error", message: err instanceof Error ? err.message : "failed to load" }));
    return () => {
      cancelled = true;
    };
  }, [metaSeason, done.length]);
  const banLineup = done.filter((p) => !banExcluded.includes(p.username));
  const bracket = bracketFor(banLineup.map((p) => (p.rank?.current && p.rank.current.games > 0 ? p.rank.current.level : 0)));

  return (
    <section class="sc-results" aria-live="polite">
      {pending.length > 0 && (
        <ul class="sc-status-list">
          {pending.map((p) => (
            <li key={p.username} class={`sc-status is-${p.status}`}>
              <strong>{p.username}</strong> <span class="sc-muted">{p.message}</span>
            </li>
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <>
          <header class="sc-report-header">
            <div>
              <h3>Most played hero</h3>
              <p class="sc-muted">
                {coverage && `${coverage} · `}Select one or more players to see their hero history, win rate and recent picks per objective mode.
              </p>
            </div>
          </header>

          {modesFound.length > 0 && (
            <fieldset class="mr-modes">
              <legend class="mr-modes-title">Game modes counted</legend>
              {modesFound.map((m) => (
                <label key={m.id} class="mr-mode">
                  <input type="checkbox" checked={included.has(m.id)} onChange={() => toggleMode(m.id)} />
                  {gameModeName(m.id)}
                  <span class="mr-mode-count">
                    #{m.id} · {m.games}
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          <BanSuggestions lineup={banLineup} statsState={statsState} bracket={bracket} excluded={done.length - banLineup.length} />

          <div class="sc-table-scroll sc-summary-scroll">
            <table class="sc-table sc-summary">
              <thead>
                <tr>
                  <th>Player</th>
                  <th class="mr-rank-head">Rank</th>
                  <th class="sc-map-head">Overall</th>
                  {objectives.map((o) => (
                    <th key={o} class="sc-map-head">
                      {o}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {done.map((p) => {
                  const trick = oneTrick(p.analysis.overall);
                  return (
                    <tr key={p.username} class={trick ? "is-one-trick" : ""}>
                      <th scope="row" class="sc-player-cell">
                        <button
                          type="button"
                          class={`sc-player-button ${selectedPlayers.includes(p.username) ? "is-active" : ""}`}
                          aria-pressed={selectedPlayers.includes(p.username)}
                          onClick={() => togglePlayer(p.username)}
                        >
                          {p.player.name}
                        </button>
                        <span class="mr-badges">
                          <RoleBadge role={playerRole(p.analysis.overall)} />
                          <OneTrickBadge trick={trick} />
                        </span>
                        <label class="mr-ban-toggle" title="Include this player's heroes in the suggested bans">
                          <input type="checkbox" checked={!banExcluded.includes(p.username)} onChange={() => toggleBanPlayer(p.username)} />
                          count in bans
                        </label>
                      </th>
                      <td class="mr-rank-cell">
                        <RankIndicator rank={p.rank} />
                      </td>
                      <TopHeroCell breakdown={p.analysis.overall} label="overall" />
                      {objectives.map((o) => (
                        <TopHeroCell key={o} breakdown={p.analysis.byObjective[o]} label={o} />
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p class="mr-note">
            <span class="mr-role is-tank">Tank</span> <span class="mr-role is-dps">DPS</span> <span class="mr-role is-support">Support</span> = at least{" "}
            {Math.round(ROLE_MAIN_SHARE * 100)}% of counted games on that role; otherwise <span class="mr-role is-flex">Flex</span>. Hover a badge for the split.
          </p>

          {done.some((p) => oneTrick(p.analysis.overall)) && (
            <p class="mr-note">
              <span class="mr-one-trick">One-trick</span> = the most played hero leads the second most played by more than chance would explain (one-sided
              binomial test, p &lt; {ONE_TRICK_ALPHA}), with at least {ONE_TRICK_MIN_GAMES} counted games. Hover a badge for the numbers.
            </p>
          )}

          {unknownMaps.size > 0 && (
            <p class="mr-note">
              {unknownMaps.size} map id{unknownMaps.size === 1 ? "" : "s"} not in the map list yet, counted under "Other": {[...unknownMaps].join(", ")}.
            </p>
          )}

          {details.map((p) => (
            <PlayerDetail key={p.username} player={p} objectives={objectives} />
          ))}
        </>
      )}
    </section>
  );
}

export function MrScraper() {
  const [players, setPlayers] = usePersistentState<string[]>(STORE.players, () => Array(MIN_PLAYER_SLOTS).fill(""));
  const [results, setResults] = usePersistentState<Record<string, PlayerResult>>(STORE.results, () => ({}), finishedOnly);
  const [seasonsBack, setSeasonsBack] = usePersistentState<number>(STORE.seasonsBack, () => 0);
  const [running, setRunning] = useState(false);

  // Lists saved before the default grew to MIN_PLAYER_SLOTS entries get topped up once.
  useEffect(() => {
    setPlayers((prev) => padPlayers(prev));
  }, []);

  function updatePlayer(index: number, value: string) {
    setPlayers((prev) => prev.map((p, i) => (i === index ? value : p)));
  }

  /** Splits pasted text into names: one per line (tabs also separate), trimmed, blanks dropped. */
  function pastedNames(text: string): string[] {
    return text
      .split(/\r?\n|\t/)
      .map((n) => n.trim())
      .filter((n) => n !== "");
  }

  /** Pasting a list into a box fills that box and the ones after it, adding boxes when the list is longer. */
  function pasteList(index: number, e: ClipboardEvent) {
    const names = pastedNames(e.clipboardData?.getData("text") ?? "");
    if (names.length <= 1) return; // a single name pastes normally
    e.preventDefault();
    setPlayers((prev) => {
      const next = [...prev];
      names.forEach((name, i) => {
        while (next.length <= index + i) next.push("");
        next[index + i] = name;
      });
      return padPlayers(next);
    });
  }
  function addPlayer() {
    setPlayers((prev) => [...prev, ""]);
  }
  function removePlayer(index: number) {
    setPlayers((prev) => (prev.length > MIN_PLAYER_SLOTS ? prev.filter((_, i) => i !== index) : prev));
  }
  function clearAll() {
    setPlayers(Array(MIN_PLAYER_SLOTS).fill(""));
    setResults({});
    clearStored([STORE.modes, STORE.selected, STORE.banExcluded]);
  }

  const canRemove = players.length > MIN_PLAYER_SLOTS;
  const validNames = [...new Set(players.map((p) => p.trim()).filter((p) => USERNAME_PATTERN.test(p)))];

  function analyze(e: Event) {
    e.preventDefault();
    void runAnalysis(seasonsBack);
  }

  /** Changing how far back to look re-runs the analysis for players already on screen. */
  function changeSeasonsBack(next: number) {
    setSeasonsBack(next);
    if (!running && validNames.some((n) => results[n])) void runAnalysis(next);
  }

  async function runAnalysis(seasonsBack: number) {
    if (running || validNames.length === 0) return;
    setRunning(true);
    setResults(Object.fromEntries(validNames.map((n) => [n, { status: "loading", message: "Queued…" }])));

    // Players are processed one at a time to be gentle on the upstream site.
    for (const username of validNames) {
      const update = (r: PlayerResult) => setResults((prev) => ({ ...prev, [username]: r }));
      const onRateLimit = (secondsLeft: number, attempt: number) =>
        update({ status: "loading", message: `The stats API is not answering. Retrying in ${secondsLeft}s (attempt ${attempt} of 3)…` });
      try {
        update({ status: "loading", message: "Looking up player…" });
        const player = await findPlayer(username, { onRateLimit });
        update({ status: "loading", message: `Fetching match history for ${player.name} from ${player.source}…` });
        const { name, matches, seasons, historyPrivate, rank, source } = await fetchRecentMatches(player.uid, {
          seasonsBack,
          onRateLimit,
          onSeason: (season, fetched, source) =>
            update({ status: "loading", message: `Fetched ${fetched} matches${season !== null ? ` through ${seasonLabel(season)}` : ""} from ${source}…` }),
        });
        if (historyPrivate && matches.length === 0) {
          update({
            status: "error",
            message: `${player.name}'s match history is private. They can show it in-game under Career > Settings > Battle History visibility.`,
          });
          continue;
        }
        update({ status: "done", player: { ...player, name: name || player.name, source }, matches, seasons, rank });
      } catch (err) {
        const message = err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong.";
        update({ status: "error", message });
      }
    }
    setRunning(false);
  }

  return (
    <main class="sc-scraper">
      <header class="sc-header">
        <h1>MR_Scraper</h1>
        <p class="sc-subtitle">Heroes played in competitive and custom matches, overall and per objective mode, with current and peak rank</p>
      </header>

      <section class="sc-panel">
        <h2>Hero tracker</h2>
        <p class="sc-muted">
          Pulls each player's match history from MarvelRivalsAPI.com (up to 120 matches per season), falling back to rivalsmeta.com (last 20 per season)
          when it is unavailable. Meta data for the ban suggestions comes from rivalsmeta.com.
        </p>

        <form class="sc-form" onSubmit={analyze}>
          <p class="sc-muted">
            Enter exact Marvel Rivals usernames or UIDs (case matters; a numeric UID is used as-is). Paste a whole list, one name per line, into any box to
            fill several at once. Add more boxes for extra players.
          </p>
          <div class="sc-fields">
            {players.map((value, i) => {
              const trimmed = value.trim();
              const invalid = trimmed !== "" && !USERNAME_PATTERN.test(trimmed);
              const inputId = `mr-player-${i + 1}`;
              return (
                <div class={`sc-field ${canRemove ? "has-remove" : ""}`} key={inputId}>
                  <label for={inputId}>Player {i + 1}</label>
                  <input
                    id={inputId}
                    type="text"
                    class={`sc-input ${invalid ? "is-invalid" : ""}`}
                    placeholder="Username or UID"
                    value={value}
                    autocomplete="off"
                    spellcheck={false}
                    aria-invalid={invalid}
                    disabled={running}
                    onInput={(e) => updatePlayer(i, (e.currentTarget as HTMLInputElement).value)}
                    onPaste={(e) => pasteList(i, e)}
                  />
                  {canRemove && (
                    <button
                      type="button"
                      class="sc-remove"
                      aria-label={`Remove player ${i + 1}`}
                      title="Remove this player"
                      disabled={running}
                      onClick={() => removePlayer(i)}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div class="sc-form-actions">
            <button type="submit" class="sc-add sc-primary" disabled={running || validNames.length === 0}>
              {running ? "Analyzing…" : `Analyze ${validNames.length || ""} player${validNames.length === 1 ? "" : "s"}`}
            </button>
            <button type="button" class="sc-add" disabled={running} onClick={addPlayer}>
              + Add player
            </button>
            <label class="mr-seasons">
              <span>Earlier seasons</span>
              <select
                value={seasonsBack}
                disabled={running}
                onChange={(e) => changeSeasonsBack(Number((e.currentTarget as HTMLSelectElement).value))}
              >
                {Array.from({ length: MAX_SEASONS_BACK + 1 }, (_, n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "Current season only" : `+${n} season${n === 1 ? "" : "s"} back`}
                  </option>
                ))}
              </select>
            </label>
            <span class="sc-muted sc-count">
              {players.length} player{players.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              class="sc-clear"
              disabled={running || (players.every((p) => p.trim() === "") && Object.keys(results).length === 0)}
              onClick={clearAll}
            >
              Clear
            </button>
          </div>
        </form>

        {validNames.some((n) => results[n]) && <ResultsSummary usernames={validNames} results={results} />}
      </section>
    </main>
  );
}
