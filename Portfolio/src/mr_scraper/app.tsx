import { useState } from "preact/hooks";
import { ApiError, fetchMaps, fetchMatchHistory, findPlayer, type MrMatch, type MrPlayer } from "./api.ts";
import {
  analyzeMatches,
  buildMapLookup,
  DEFAULT_GAME_MODES,
  gameModeName,
  OBJECTIVES,
  topHeroes,
  winRate,
  type Breakdown,
  type GameModeInfo,
  type MapLookup,
  type Objective,
  type PlayerAnalysis,
} from "./analysis.ts";
import { clearStored, usePersistentState } from "../shared/storage.ts";

// localStorage keys (see shared/storage.ts); bump the suffix if the saved shape changes.
const STORE = {
  players: "mr_scraper:players.v1",
  results: "mr_scraper:results.v1",
  maps: "mr_scraper:maps.v1",
  modes: "mr_scraper:modes.v1",
  selected: "mr_scraper:selected.v1",
} as const;

// The form always shows at least this many player inputs.
const MIN_PLAYER_SLOTS = 5;

// Marvel Rivals usernames: no tag, 2-20 visible characters.
const USERNAME_PATTERN = /^\S.{0,18}\S$/;

const RESULT_LABEL = { win: "W", loss: "L", draw: "D" } as const;

/** Raw fetch result per player; analysis is recomputed from this whenever the mode filter changes. */
type PlayerResult =
  | { status: "loading"; message: string }
  | { status: "error"; message: string }
  | { status: "done"; player: MrPlayer; matches: MrMatch[] };

type DonePlayer = { username: string; player: MrPlayer; matches: MrMatch[]; analysis: PlayerAnalysis };

type StoredMaps = { fetchedAt: number; maps: Parameters<typeof buildMapLookup>[0] };
const MAPS_TTL_MS = 24 * 60 * 60 * 1000;

function finishedOnly(results: Record<string, PlayerResult>): Record<string, PlayerResult> {
  return Object.fromEntries(Object.entries(results).filter(([, r]) => r.status !== "loading"));
}

const formatDate = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleDateString();

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

  return (
    <article class="sc-report">
      <header class="sc-report-header">
        <div>
          <h3>{player.player.name}</h3>
          <p class="sc-muted">
            UID {player.player.uid} · {player.matches.length} match{player.matches.length === 1 ? "" : "es"} fetched · {analysis.overall.games} counted
            {rate !== null && ` · ${rate}% win rate`}
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

function ResultsSummary({
  usernames,
  results,
  mapLookup,
}: {
  usernames: string[];
  results: Record<string, PlayerResult>;
  mapLookup: MapLookup;
}) {
  const [storedModes, setStoredModes] = usePersistentState<number[] | null>(STORE.modes, () => null);
  const [selectedPlayers, setSelectedPlayers] = usePersistentState<string[]>(STORE.selected, () => []);

  function togglePlayer(username: string) {
    setSelectedPlayers((cur) => (cur.includes(username) ? cur.filter((u) => u !== username) : [...cur, username]));
  }

  const finished = usernames.flatMap((username) => {
    const r = results[username];
    return r?.status === "done" ? [{ username, player: r.player, matches: r.matches }] : [];
  });
  const pending = usernames.flatMap((username) => {
    const r = results[username];
    return r && r.status !== "done" ? [{ username, status: r.status, message: r.message }] : [];
  });

  // Game modes present across everyone's raw history, before filtering.
  const modeTotals = new Map<number, GameModeInfo>();
  for (const p of finished) {
    for (const m of analyzeMatches(p.matches, mapLookup, new Set()).gameModes) {
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

  const done: DonePlayer[] = finished.map((p) => ({ ...p, analysis: analyzeMatches(p.matches, mapLookup, included) }));
  // Only show the "Other" column when someone actually has games there.
  const objectives = OBJECTIVES.filter((o) => o !== "Other" || done.some((p) => p.analysis.byObjective.Other.games > 0));
  const unknownMaps = new Set(done.flatMap((p) => p.analysis.unknownMapIds));
  const details = done.filter((p) => selectedPlayers.includes(p.username));

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
              <p class="sc-muted">Select one or more players to see their hero history, win rate and recent picks per objective mode.</p>
            </div>
          </header>

          {modesFound.length > 0 && (
            <fieldset class="mr-modes">
              <legend class="mr-modes-title">Game modes counted</legend>
              {modesFound.map((m) => (
                <label key={m.id} class="mr-mode">
                  <input type="checkbox" checked={included.has(m.id)} onChange={() => toggleMode(m.id)} />
                  {gameModeName(m.id, m.name)}
                  <span class="mr-mode-count">
                    #{m.id} · {m.games}
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          <div class="sc-table-scroll sc-summary-scroll">
            <table class="sc-table sc-summary">
              <thead>
                <tr>
                  <th>Player</th>
                  <th class="sc-map-head">Overall</th>
                  {objectives.map((o) => (
                    <th key={o} class="sc-map-head">
                      {o}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {done.map((p) => (
                  <tr key={p.username}>
                    <th scope="row" class="sc-player-cell">
                      <button
                        type="button"
                        class={`sc-player-button ${selectedPlayers.includes(p.username) ? "is-active" : ""}`}
                        aria-pressed={selectedPlayers.includes(p.username)}
                        onClick={() => togglePlayer(p.username)}
                      >
                        {p.player.name}
                      </button>
                    </th>
                    <TopHeroCell breakdown={p.analysis.overall} label="overall" />
                    {objectives.map((o) => (
                      <TopHeroCell key={o} breakdown={p.analysis.byObjective[o]} label={o} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {unknownMaps.size > 0 && (
            <p class="mr-note">
              {unknownMaps.size} map id{unknownMaps.size === 1 ? "" : "s"} could not be matched to a known map and counted under "Other":{" "}
              {[...unknownMaps].join(", ")}.
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
  const [storedMaps, setStoredMaps] = usePersistentState<StoredMaps | null>(STORE.maps, () => null);
  const [running, setRunning] = useState(false);
  const [mapsError, setMapsError] = useState<string | null>(null);

  const mapLookup = buildMapLookup(storedMaps?.maps ?? []);

  function updatePlayer(index: number, value: string) {
    setPlayers((prev) => prev.map((p, i) => (i === index ? value : p)));
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
    clearStored([STORE.modes, STORE.selected]);
  }

  const canRemove = players.length > MIN_PLAYER_SLOTS;
  const validNames = [...new Set(players.map((p) => p.trim()).filter((p) => USERNAME_PATTERN.test(p)))];

  async function ensureMaps(onRateLimit: (s: number, a: number) => void): Promise<void> {
    if (storedMaps && Date.now() - storedMaps.fetchedAt < MAPS_TTL_MS && storedMaps.maps.length > 0) return;
    try {
      const maps = await fetchMaps({ onRateLimit });
      setStoredMaps({ fetchedAt: Date.now(), maps });
      setMapsError(null);
    } catch (err) {
      // Not fatal: matches still tally, just without the objective split.
      setMapsError(err instanceof Error ? err.message : "Could not load the map list.");
    }
  }

  async function analyze(e: Event) {
    e.preventDefault();
    if (running || validNames.length === 0) return;
    setRunning(true);
    setResults(Object.fromEntries(validNames.map((n) => [n, { status: "loading", message: "Queued…" }])));

    const mapsRateLimit = (s: number, a: number) =>
      setResults((prev) => ({ ...prev, [validNames[0]]: { status: "loading", message: `Rate limited while loading maps. Retrying in ${s}s (attempt ${a})…` } }));
    await ensureMaps(mapsRateLimit);

    // Players are processed one at a time to stay well inside the API rate limit.
    for (const username of validNames) {
      const update = (r: PlayerResult) => setResults((prev) => ({ ...prev, [username]: r }));
      const onRateLimit = (secondsLeft: number, attempt: number) =>
        update({ status: "loading", message: `Rate limited by the API. Retrying in ${secondsLeft}s (attempt ${attempt})…` });
      try {
        update({ status: "loading", message: "Looking up player…" });
        const player = await findPlayer(username, { onRateLimit });
        update({ status: "loading", message: "Fetching match history…" });
        const matches = await fetchMatchHistory(player.uid, {
          onRateLimit,
          onPage: (fetched, total) => update({ status: "loading", message: `Fetched ${fetched}${total !== null ? ` of ${total}` : ""} matches…` }),
        });
        update({ status: "done", player, matches });
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
        <p class="sc-subtitle">Heroes played in competitive and custom matches, overall and per objective mode</p>
      </header>

      <section class="sc-panel">
        <h2>Hero tracker</h2>
        <p class="sc-muted">Pulls each player's recent match history from MarvelRivalsAPI.com.</p>

        <form class="sc-form" onSubmit={analyze}>
          <p class="sc-muted">Enter Marvel Rivals usernames. Add more boxes for extra players.</p>
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
                    placeholder="Username"
                    value={value}
                    autocomplete="off"
                    spellcheck={false}
                    aria-invalid={invalid}
                    disabled={running}
                    onInput={(e) => updatePlayer(i, (e.currentTarget as HTMLInputElement).value)}
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

        {mapsError && <p class="mr-note">Map list unavailable ({mapsError}); matches are tallied without the objective split.</p>}

        {validNames.some((n) => results[n]) && <ResultsSummary usernames={validNames} results={results} mapLookup={mapLookup} />}
      </section>
    </main>
  );
}
