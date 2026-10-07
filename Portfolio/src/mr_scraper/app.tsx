import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  ApiError,
  clearDebugLog,
  debugLog,
  fetchRecentMatches,
  findPlayer,
  loadHeroStats,
  subscribeDebug,
  type DebugEntry,
  type MrHeroStats,
  type MrMatch,
  type MrPlayer,
} from "./api.ts";
import { bracketFor, heroMeta, metaFactor, pct, recommendBans, type BanSuggestion, type MetaBracket } from "./bans.ts";
import { heroPortrait } from "./data/portraits.ts";
import { rankBadge } from "./data/ranks.ts";
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
  debug: "mr_scraper:debug.v1",
} as const;

// The form always shows at least this many player inputs (a full team).
const MIN_PLAYER_SLOTS = 6;

/** Pads a saved player list from an older default up to the current minimum. */
const padPlayers = (list: string[]) => (list.length >= MIN_PLAYER_SLOTS ? list : [...list, ...Array(MIN_PLAYER_SLOTS - list.length).fill("")]);

// Marvel Rivals usernames: 2-20 visible characters (a numeric UID also fits).
const USERNAME_PATTERN = /^\S.{0,18}\S$/;

// Each season adds up to 120 matches (rivalsdata.com) or 20 (rivalsmeta.com); cap how far back the page will look.
const MAX_SEASONS_BACK = 5;

const RESULT_LABEL = { win: "W", loss: "L", draw: "D" } as const;

/** Raw fetch result per player; analysis is recomputed from this whenever the mode filter changes. */
type PlayerResult =
  | { status: "loading"; message: string }
  | { status: "error"; message: string }
  | { status: "done"; player: MrPlayer; matches: MrMatch[]; seasons: number[]; rank?: RankSummary; historyPrivate?: boolean };

type DonePlayer = {
  username: string;
  player: MrPlayer;
  matches: MrMatch[];
  seasons: number[];
  rank?: RankSummary;
  /** The player hides their history in-game; the matches were indexed by the source before that and may be stale. */
  historyPrivate?: boolean;
  analysis: PlayerAnalysis;
};

function finishedOnly(results: Record<string, PlayerResult>): Record<string, PlayerResult> {
  return Object.fromEntries(Object.entries(results).filter(([, r]) => r.status !== "loading"));
}

const formatDate = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleDateString();

/** Marks a current rank with no ranked game yet this season: the level is only the soft-reset placement. */
const PLACEMENT_MARK = "*";
const PLACEMENT_NOTE = "no ranked game yet this season, so this is the placement level";

const currentRankTitle = (entry: RankEntry) =>
  entry.games === 0 ? `${seasonLabel(entry.season)} · ${PLACEMENT_NOTE}` : `${seasonLabel(entry.season)} · ${entry.games} ranked game${entry.games === 1 ? "" : "s"}`;

/** One rank line: tier-coloured name plus score, e.g. "Diamond 2 · 4,120 RS". */
function RankLabel({ entry, peak }: { entry: RankEntry | null; peak?: boolean }) {
  if (!entry) return <span class="mr-rank is-unranked">Unranked</span>;
  const level = peak ? entry.maxLevel : entry.level;
  const score = peak ? entry.maxScore : entry.score;
  return (
    <span class={`mr-rank is-${rankTier(level)}`} title={peak ? `Highest rank reached, ${seasonLabel(entry.season)}` : currentRankTitle(entry)}>
      <span class="mr-rank-name">
        {rankName(level)}
        {!peak && level > 0 && entry.games === 0 && PLACEMENT_MARK}
      </span>
      {level > 0 && score > 0 && <span class="mr-rank-score">{formatScore(score)}</span>}
    </span>
  );
}

/**
 * A rank as a tile for the summary table. Current: the tier badge with the exact
 * rank underneath ("Diamond 2", then the score). Peak: the badge, the exact rank
 * and the season it was reached in; the score is in the tooltip.
 */
function RankTile({ entry, peak }: { entry: RankEntry | null; peak?: boolean }) {
  const level = entry ? (peak ? entry.maxLevel : entry.level) : 0;
  const score = entry ? (peak ? entry.maxScore : entry.score) : 0;
  const tier = rankTier(level);
  const badge = rankBadge(tier);
  const title = !entry
    ? peak
      ? "No ranked game recorded"
      : "No ranked game this season"
    : peak
      ? `${rankName(level)}${score > 0 ? ` · ${formatScore(score)}` : ""} · highest rank reached, ${seasonLabel(entry.season)}`
      : currentRankTitle(entry);
  return (
    <span class={`mr-rank-tile mr-rank is-${tier}`} title={title}>
      {badge ? <img class="mr-rank-badge" src={badge} width={56} height={56} alt={rankName(level)} loading="lazy" decoding="async" /> : <span class="mr-rank-badge is-empty" />}
      {peak && entry ? (
        <>
          <span class="mr-rank-name">{rankName(level)}</span>
          <span class="mr-rank-score">{seasonLabel(entry.season)}</span>
        </>
      ) : (
        <>
          <span class="mr-rank-name">
            {rankName(level)}
            {level > 0 && entry?.games === 0 && PLACEMENT_MARK}
          </span>
          {level > 0 && score > 0 && <span class="mr-rank-score">{formatScore(score)}</span>}
        </>
      )}
    </span>
  );
}

/** Hero lists show at most this many heroes, most played first (a 5 x 2 grid in the hero-pool card, with the tenth slot for "more"). */
const HERO_LIST_LIMIT = 9;

/** Current and peak rank stacked, for the detail header. */
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

type HeroStatsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; season: number; bracket: string; stats: MrHeroStats };

/** The top heroes worth banning against this lineup, from hero overlap weighted by the current ranked meta. */
function BanSuggestions({ lineup, statsState, bracket, excluded }: { lineup: DonePlayer[]; statsState: HeroStatsState; bracket: MetaBracket; excluded: number }) {
  const meta = useMemo(() => (statsState.status === "done" ? heroMeta(statsState.stats, bracket) : null), [statsState, bracket]);
  const suggestions = useMemo(
    () => recommendBans(lineup.map((p) => ({ name: p.player.name, analysis: p.analysis })), meta),
    [lineup, meta],
  );
  // The tier list has no bracket below Diamond, so the data may cover a narrower bracket than the lineup's; say which.
  const metaNote =
    statsState.status === "done"
      ? `${statsState.stats.rates?.bracket ?? bracket.label} ranked, ${seasonLabel(statsState.season)}`
      : statsState.status === "loading"
        ? "loading current meta…"
        : statsState.status === "error"
          ? `meta unavailable (${statsState.message})`
          : "meta not loaded";

  // Which card's reasoning is open underneath the row.
  const [openHero, setOpenHero] = useState<string | null>(null);
  const open = suggestions.find((s) => s.hero === openHero) ?? null;

  return (
    <section class="mr-bans" aria-label="Suggested bans">
      <header class="sc-report-header">
        <div>
          <h3>Suggested bans</h3>
          <p class="sc-muted">
            Heroes this lineup leans on, weighted by the current meta ({metaNote}). Click a ban to see how its score came about.
            {excluded > 0 && ` ${excluded} player${excluded === 1 ? " is" : "s are"} left out; click the tick beside a player's name to count them.`}
          </p>
        </div>
      </header>
      {suggestions.length === 0 ? (
        <p class="mr-note">
          {lineup.length === 0 ? "Every player is left out of the ban calculation." : "No hero data in the selected game modes yet, so there is nothing to base a ban on."}
        </p>
      ) : (
        <>
          <ol class="mr-ban-list">
            {suggestions.map((s, i) => (
              <BanCard
                key={s.hero}
                index={i + 1}
                suggestion={s}
                lineupSize={lineup.length}
                open={open?.hero === s.hero}
                onToggle={() => setOpenHero(open?.hero === s.hero ? null : s.hero)}
              />
            ))}
          </ol>
          {open && <BanReasoning suggestion={open} />}
        </>
      )}
    </section>
  );
}

/** The hero's portrait at a given pixel size; nothing for a hero without one, so text layouts stay intact. */
function HeroPortrait({ hero, size }: { hero: string; size: number }) {
  const src = heroPortrait(hero);
  if (!src) return null;
  return <img class="mr-hero-img" src={src} width={size} height={size} alt="" loading="lazy" decoding="async" />;
}

/** One suggested ban as a card in the row; clicking it opens its reasoning beneath the row. */
function BanCard({ index, suggestion: s, lineupSize, open, onToggle }: { index: number; suggestion: BanSuggestion; lineupSize: number; open: boolean; onToggle: () => void }) {
  const regulars = s.players.filter((p) => p.games >= 2);
  const oneTricks = s.players.filter((p) => p.oneTrick).length;
  return (
    <li>
      <button
        type="button"
        class={`mr-ban-card ${s.metaOnly ? "is-meta-only" : ""} ${open ? "is-open" : ""}`}
        aria-expanded={open}
        aria-label={`Ban ${index}: ${s.hero}`}
        onClick={onToggle}
      >
        <HeroPortrait hero={s.hero} size={88} />
        <span class="mr-ban-text">
          <span class="mr-ban-hero">{s.hero}</span>
          <span class="mr-ban-summary">
            {s.metaOnly ? "meta ban" : `played by ${regulars.length || s.players.length} of ${lineupSize}`}
            {oneTricks > 0 && <span class="mr-one-trick">One-trick</span>}
          </span>
          <span class="mr-ban-meta">
            {s.meta ? (
              <>
                <span title="Win rate in the current meta">{pct(s.meta.winRate, 1)} WR</span>
                <span title="Share of matches where this hero was banned">{pct(s.meta.banRate)} banned</span>
              </>
            ) : (
              <span>no meta data</span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

/** The reasoning behind one ban's score: who plays the hero, and how the lineup score and meta factor combine. */
function BanReasoning({ suggestion: s }: { suggestion: BanSuggestion }) {
  const regulars = s.players.filter((p) => p.games >= 2);
  const oneTricks = s.players.filter((p) => p.oneTrick).length;
  const factor = metaFactor(s.meta);
  const lineupScore = s.score / factor;
  return (
    <div class="mr-ban-reasoning" role="region" aria-label={`Why ban ${s.hero}`}>
      <p class="mr-ban-reasoning-title">
        <HeroPortrait hero={s.hero} size={28} /> {s.hero}
      </p>
      {s.players.length > 0 && (
        <ul class="mr-ban-players">
          {s.players.map((p) => (
            <li key={p.name} class={p.oneTrick ? "is-one-trick" : ""}>
              <span class="mr-ban-player">
                {p.name}
                {p.oneTrick && <span class="mr-one-trick">One-trick</span>}
              </span>
              <span class="mr-ban-share" title={`${p.games} of their counted games`}>
                {pct(p.share)} of games
              </span>
            </li>
          ))}
        </ul>
      )}
      <p class="mr-ban-why">
        {s.metaOnly ? (
          <>Nobody in this lineup plays {s.hero}; it is here purely as a strong meta ban.</>
        ) : (
          <>
            Lineup score {lineupScore.toFixed(2)}: the players' shares of games on {s.hero} add up to {s.overlap.toFixed(2)}
            {oneTricks > 0 && `, plus 0.5 for ${oneTricks === 1 ? "a one-trick" : `${oneTricks} one-tricks`}`}
            {regulars.length > 1 && `, plus 0.25 for each regular beyond the first (${regulars.length} regulars)`}.
          </>
        )}{" "}
        {s.meta ? (
          <>
            Meta factor ×{factor.toFixed(2)}: 1 plus the win-rate edge over 50% ({pct(s.meta.winRate, 1)} WR) plus the ban rate ({pct(s.meta.banRate)}),
            with a {pct(s.meta.pickRate, 1)} pick rate. Final score {s.score.toFixed(2)}.
          </>
        ) : (
          <>No meta data for this hero, so the lineup score stands as is: {s.score.toFixed(2)}.</>
        )}
      </p>
    </div>
  );
}

/** The debug terminal: the data layer's own log of requests, cache hits, retries and fallbacks, newest at the bottom. */
function DebugTerminal() {
  const [entries, setEntries] = useState<readonly DebugEntry[]>([]);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => subscribeDebug((all) => setEntries([...all])), []);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);
  const time = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour12: false });
  return (
    <div class="mr-terminal-wrap">
      <div class="mr-terminal-bar">
        <span>backend log · {entries.length} line{entries.length === 1 ? "" : "s"}</span>
        <button type="button" class="sc-clear" onClick={clearDebugLog} disabled={entries.length === 0}>
          Clear
        </button>
      </div>
      <pre class="mr-terminal" ref={ref} aria-live="polite">
        {entries.length === 0 ? "idle — run an analysis to see what the data layer does" : entries.map((e) => `${time(e.at)}  ${e.text}`).join("\n")}
      </pre>
    </div>
  );
}

/** Role badge: Tank / DPS / Support when one role has most of the games, otherwise Flex. Hover for the split. */
function RoleBadge({ role }: { role: PlayerRole | null }) {
  if (!role) return null;
  const split = role.shares.map((s) => `${ROLE_LABELS[s.role]} ${Math.round(s.share * 100)}% (${s.games})`).join(" · ");
  return (
    <span class={`mr-role is-${role.role}`} title={split}>
      {role.label}
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

/** Share of a breakdown's games spent on one hero, as a whole percent. */
const share = (games: number, total: number) => (total > 0 ? `${Math.round((games / total) * 100)}%` : "—");

/** "62% WR", or "— WR" when every game was a draw. */
function wrLabel(b: { wins: number; losses: number }): string {
  const rate = winRate(b);
  return rate === null ? "— WR" : `${rate}% WR`;
}

const record = (b: { wins: number; losses: number; draws: number }) => `${b.wins}W-${b.losses}L${b.draws ? `-${b.draws}D` : ""}`;

/**
 * Places a cell's hover card so it never pushes the page out: above the cell
 * when it would run past the bottom of the viewport or of the page content
 * (which would lengthen the page), and right-aligned when it would run off the
 * right edge. Runs as the card is about to show, so it can be measured. On
 * narrow screens the card is laid out inline by CSS and needs no placing.
 */
function placeHoverCard(e: Event) {
  const host = e.currentTarget as HTMLElement;
  const card = host.querySelector<HTMLElement>(".sc-hover-card");
  if (!card || window.matchMedia("(max-width: 900px)").matches) return;
  host.classList.remove("opens-up", "opens-left");
  card.style.maxHeight = "";
  const hostRect = host.getBoundingClientRect();
  // The results pane scrolls on its own, so it is the box the card must stay inside (the viewport, when stacked).
  const pane = host.closest(".mr-main")?.getBoundingClientRect();
  const top = Math.max(0, pane?.top ?? 0);
  const bottom = Math.min(window.innerHeight, pane?.bottom ?? Infinity);
  const right = Math.min(window.innerWidth, pane?.right ?? Infinity);
  const roomBelow = bottom - 8 - (hostRect.bottom + 8);
  const roomAbove = hostRect.top - 8 - (top + 8);
  const height = card.offsetHeight;
  if (height > roomBelow) {
    const up = height <= roomAbove || roomAbove > roomBelow;
    if (up) host.classList.add("opens-up");
    // Room on neither side: take the larger one and let the card scroll inside it.
    if (height > (up ? roomAbove : roomBelow)) card.style.maxHeight = `${Math.max(120, up ? roomAbove : roomBelow)}px`;
  }
  if (hostRect.left + card.offsetWidth > right - 16) host.classList.add("opens-left");
}

/** Summary cell: most played hero in one breakdown, with tie highlight and a hover card of the rest. */
function TopHeroCell({ breakdown, label }: { breakdown: Breakdown; label: string }) {
  const tied = topHeroes(breakdown.heroes);
  const top = tied[0];
  if (!top) return <td class="sc-empty">—</td>;

  const tiedNames = new Set(tied.slice(1).map((h) => h.hero));
  const isTie = tiedNames.size > 0;

  return (
    <td>
      <span
        class={`sc-top ${isTie ? "is-tied" : ""}`}
        tabindex={0}
        aria-label={isTie ? `${top.hero}, tied with ${[...tiedNames].join(", ")}` : undefined}
        onMouseEnter={placeHoverCard}
        onFocus={placeHoverCard}
      >
        <span class="sc-hero-tile is-main">
          <HeroPortrait hero={top.hero} size={48} />
          <span class="sc-hero-tile-name">{top.hero}</span>
          <span class="sc-hero-tile-stat">
            {top.games} of {breakdown.games}
          </span>
          <span class="sc-hero-tile-stat">{wrLabel(top)}</span>
        </span>
        {/* The whole hero pool for this mode, most played first, as portrait tiles. */}
        <span class="sc-hover-card" role="tooltip">
          <span class="sc-hover-title">
            {isTie ? `Tied for most played · hero pool (${label})` : `Hero pool (${label})`}
          </span>
          <ul class="sc-hero-grid">
            {breakdown.heroes.slice(0, HERO_LIST_LIMIT).map((h) => (
              <li
                key={h.hero}
                class={`sc-hero-tile ${h.hero === top.hero ? "is-top" : ""} ${tiedNames.has(h.hero) ? "is-tied" : ""}`}
                title={`${h.hero} · ${h.games} of ${breakdown.games} games · ${record(h)}`}
              >
                <HeroPortrait hero={h.hero} size={48} />
                <span class="sc-hero-tile-name">{h.hero}</span>
                <span class="sc-hero-tile-stat">
                  {h.games} of {breakdown.games}
                </span>
                <span class="sc-hero-tile-stat">{wrLabel(h)}</span>
              </li>
            ))}
            {breakdown.heroes.length > HERO_LIST_LIMIT && (
              <li class="sc-hero-tile is-more" title={breakdown.heroes.slice(HERO_LIST_LIMIT).map((h) => `${h.hero} (${h.games})`).join(", ")}>
                <span class="sc-hero-tile-name">+{breakdown.heroes.length - HERO_LIST_LIMIT} more</span>
                <span class="sc-hero-tile-stat">{breakdown.heroes.slice(HERO_LIST_LIMIT).reduce((n, h) => n + h.games, 0)} games</span>
              </li>
            )}
          </ul>
        </span>
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
            {player.historyPrivate && (
              <>
                {" · "}
                <span class="mr-one-trick" title="This player hides their battle history in-game. These matches were indexed before that and may be out of date.">
                  History now private
                </span>
              </>
            )}
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
                <th class="sc-num">Win %</th>
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
                        <span class="sc-record" title={record(r.breakdown)}>
                          {rowRate === null ? "—" : `${rowRate}%`}
                        </span>
                      </td>
                      <td>
                        <ul class="sc-agents">
                          {r.breakdown.heroes.slice(0, HERO_LIST_LIMIT).map((h) => (
                            <li key={h.hero} class="sc-agent" title={`${h.games} of ${r.breakdown.games} games · ${record(h)}`}>
                              <HeroPortrait hero={h.hero} size={20} />
                              <span class="sc-agent-name">{h.hero}</span>
                              <span class="sc-agent-games">{share(h.games, r.breakdown.games)}</span>
                              <span class="sc-agent-record">{wrLabel(h)}</span>
                            </li>
                          ))}
                          {r.breakdown.heroes.length > HERO_LIST_LIMIT && (
                            <li class="sc-agent is-more" title={r.breakdown.heroes.slice(HERO_LIST_LIMIT).map((h) => `${h.hero} (${h.games})`).join(", ")}>
                              <span class="sc-agent-name">+{r.breakdown.heroes.length - HERO_LIST_LIMIT} more</span>
                            </li>
                          )}
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
                              <HeroPortrait hero={g.hero} size={18} />
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

  // Hero stats for the ban suggestions, fetched once per season and rank bracket and cached.
  const banLineup = done.filter((p) => !banExcluded.includes(p.username));
  const bracket = bracketFor(banLineup.map((p) => (p.rank?.current && p.rank.current.games > 0 ? p.rank.current.level : 0)));
  const metaSeason = done.reduce<number | null>((best, p) => (p.seasons.length ? Math.max(best ?? 0, ...p.seasons) : best), null);
  const [statsState, setStatsState] = useState<HeroStatsState>({ status: "idle" });
  useEffect(() => {
    if (metaSeason === null || done.length === 0) return;
    if (statsState.status === "done" && statsState.season === metaSeason && statsState.bracket === bracket.label) return;
    let cancelled = false;
    setStatsState({ status: "loading" });
    loadHeroStats(metaSeason, bracket)
      .then((stats) => !cancelled && setStatsState({ status: "done", season: metaSeason, bracket: bracket.label, stats }))
      .catch((err) => !cancelled && setStatsState({ status: "error", message: err instanceof Error ? err.message : "failed to load" }));
    return () => {
      cancelled = true;
    };
  }, [metaSeason, done.length, bracket.label]);

  return (
    <section class="sc-results">
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
                  <th class="mr-rank-head">Current rank</th>
                  <th class="mr-rank-head">Peak rank</th>
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
                        <span class="mr-player-head">
                          {/* Big tick: whether this player's heroes count towards the suggested bans. */}
                          <button
                            type="button"
                            class={`mr-ban-tick ${banExcluded.includes(p.username) ? "" : "is-on"}`}
                            aria-pressed={!banExcluded.includes(p.username)}
                            aria-label={`Count ${p.player.name} in the suggested bans`}
                            title={banExcluded.includes(p.username) ? "Left out of the suggested bans; click to count them" : "Counted in the suggested bans; click to leave them out"}
                            onClick={() => toggleBanPlayer(p.username)}
                          >
                            ✓
                          </button>
                          <button
                            type="button"
                            class={`sc-player-button ${selectedPlayers.includes(p.username) ? "is-active" : ""}`}
                            aria-pressed={selectedPlayers.includes(p.username)}
                            onClick={() => togglePlayer(p.username)}
                          >
                            {p.player.name}
                          </button>
                        </span>
                        <span class="mr-badges">
                          <RoleBadge role={playerRole(p.analysis.overall)} />
                          <OneTrickBadge trick={trick} />
                        </span>
                      </th>
                      {p.rank ? (
                        <>
                          <td class="mr-rank-cell">
                            <RankTile entry={p.rank.current && p.rank.current.level > 0 ? p.rank.current : null} />
                          </td>
                          <td class="mr-rank-cell">
                            <RankTile entry={p.rank.peak} peak />
                          </td>
                        </>
                      ) : (
                        <td class="mr-rank-cell sc-muted" colSpan={2}>
                          Re-run to load ranks
                        </td>
                      )}
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
  /** Shows the backend log under the form, and the reason under a failed name. */
  const [debug, setDebug] = usePersistentState<boolean>(STORE.debug, () => false);
  const [running, setRunning] = useState(false);
  /** Aborts the analysis in progress; the Cancel button calls it. */
  const abortRef = useRef<AbortController | null>(null);

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
  /** Drops the row, or just empties it while the form is at its minimum size. */
  function removePlayer(index: number) {
    setPlayers((prev) => (prev.length > MIN_PLAYER_SLOTS ? prev.filter((_, i) => i !== index) : prev.map((p, i) => (i === index ? "" : p))));
  }
  function clearAll() {
    setPlayers(Array(MIN_PLAYER_SLOTS).fill(""));
    setResults({});
    clearStored([STORE.modes, STORE.selected, STORE.banExcluded]);
  }

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
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    debugLog(`run started: ${validNames.length} player${validNames.length === 1 ? "" : "s"}, ${seasonsBack} earlier season${seasonsBack === 1 ? "" : "s"}`);

    // Players are processed one at a time to be gentle on the upstream site.
    for (const username of validNames) {
      const update = (r: PlayerResult) => setResults((prev) => ({ ...prev, [username]: r }));
      if (signal.aborted) {
        update({ status: "error", message: "Cancelled." });
        continue;
      }
      let lastAttempt = 0;
      const onRateLimit = (secondsLeft: number, attempt: number) => {
        if (attempt !== lastAttempt) {
          lastAttempt = attempt;
          debugLog(`rate limited (429); waiting ${secondsLeft}s before retry ${attempt} of 3`);
        }
        update({ status: "loading", message: `The stats API is not answering. Retrying in ${secondsLeft}s (attempt ${attempt} of 3)…` });
      };
      debugLog(`── ${username}`);
      try {
        update({ status: "loading", message: "Looking up player…" });
        const player = await findPlayer(username, { onRateLimit, signal });
        update({ status: "loading", message: `Fetching match history for ${player.name}…` });
        const { name, matches, seasons, historyPrivate, rank, source } = await fetchRecentMatches(player.uid, {
          seasonsBack,
          onRateLimit,
          signal,
          onSeason: (season, fetched) =>
            update({ status: "loading", message: `Fetched ${fetched} matches${season !== null ? ` through ${seasonLabel(season)}` : ""}…` }),
        });
        if (historyPrivate && matches.length === 0) {
          debugLog(`${player.name}: history private and nothing cached`);
          update({
            status: "error",
            message: `${player.name}'s match history is private. They can show it in-game under Career > Settings > Battle History visibility.`,
          });
          continue;
        }
        debugLog(`${name || player.name}: done, ${matches.length} matches over ${seasons.length} season${seasons.length === 1 ? "" : "s"} via ${source}`);
        update({ status: "done", player: { ...player, name: name || player.name, source }, matches, seasons, rank, historyPrivate });
      } catch (err) {
        if (signal.aborted) {
          debugLog(`${username}: cancelled`);
          update({ status: "error", message: "Cancelled." });
          continue;
        }
        const message = err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong.";
        debugLog(`${username}: failed — ${message}`);
        update({ status: "error", message });
      }
    }
    debugLog(signal.aborted ? "run cancelled" : "run finished");
    abortRef.current = null;
    setRunning(false);
  }

  return (
    <main class="sc-scraper mr-app">
      {/* Sidebar: the player form and the progress of the run. Main: everything the run produced. */}
      <aside class="mr-sidebar">
        <header class="sc-header">
          <h1>MR_Scraper</h1>
          <p class="sc-subtitle">Heroes played in competitive and custom matches, overall and per objective mode, with current and peak rank</p>
        </header>

        <section class="sc-panel mr-search">
          <h2>Hero tracker</h2>

        <form class="sc-form" onSubmit={analyze}>
          <div class="sc-fields">
            {players.map((value, i) => {
              const trimmed = value.trim();
              const invalid = trimmed !== "" && !USERNAME_PATTERN.test(trimmed);
              const inputId = `mr-player-${i + 1}`;
              // The run's progress for this name colours the field: sweeping while loading, green when done, red on failure.
              const result = results[trimmed];
              const status = result?.status;
              const message = result && result.status !== "done" ? result.message : undefined;
              const removes = players.length > MIN_PLAYER_SLOTS;
              return (
                <div class={`sc-field has-remove ${status ? `is-${status}` : ""}`} key={inputId}>
                  <label for={inputId}>Player {i + 1}</label>
                  <input
                    id={inputId}
                    type="text"
                    class={`sc-input ${invalid ? "is-invalid" : ""}`}
                    placeholder="Name or UID"
                    value={value}
                    autocomplete="off"
                    spellcheck={false}
                    aria-invalid={invalid}
                    disabled={running}
                    title={message}
                    onInput={(e) => updatePlayer(i, (e.currentTarget as HTMLInputElement).value)}
                    onPaste={(e) => pasteList(i, e)}
                  />
                  <button
                    type="button"
                    class="sc-remove"
                    aria-label={removes ? `Remove player ${i + 1}` : `Clear player ${i + 1}`}
                    title={removes ? "Remove this player" : "Clear this name"}
                    disabled={running}
                    onClick={() => removePlayer(i)}
                  >
                    ×
                  </button>
                  {status === "error" && debug && (
                    <p class="sc-field-note" role="alert">
                      {message}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {debug && <DebugTerminal />}
          <div class="sc-form-actions">
            <button type="submit" class="sc-add sc-primary" disabled={running || validNames.length === 0}>
              {running ? "Analyzing…" : validNames.length ? `Analyze ${validNames.length} player${validNames.length === 1 ? "" : "s"}` : "Analyze"}
            </button>
            {running && (
              <button type="button" class="sc-add" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            )}
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
            <label class="mr-mode mr-debug-toggle" title="Show what the data layer is doing, and why a name failed">
              <input type="checkbox" checked={debug} onChange={(e) => setDebug((e.currentTarget as HTMLInputElement).checked)} />
              Debug
            </label>
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

        </section>
      </aside>

      <section class="mr-main" aria-label="Results">
        {validNames.some((n) => results[n]?.status === "done") ? (
          <ResultsSummary usernames={validNames} results={results} />
        ) : (
          <p class="mr-empty sc-muted">
            {running ? "Looking players up…" : "Enter player names or UIDs on the left and run the analysis. Results appear here."}
          </p>
        )}
      </section>
    </main>
  );
}
