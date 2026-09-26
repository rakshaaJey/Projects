import { useState } from "preact/hooks";
import { fetchCompetitiveMatches, lookupAccount, HenrikError, type Account } from "./henrik.ts";
import { analyzeMatches, topAgents, winRate, type ActBreakdown, type MapBreakdown } from "./analysis.ts";
import { clearStored, usePersistentState } from "../shared/storage.ts";

// localStorage keys (see storage.ts); bump the suffix if the saved shape changes.
const STORE = {
  scraper: "val_scraper:scraper.v1",
  players: "val_scraper:tracker.players.v1",
  results: "val_scraper:tracker.results.v1",
  act: "val_scraper:tracker.act.v1",
  selected: "val_scraper:tracker.selected.v1",
} as const;

type Scraper = "vlr" | "tracker";

const scrapers: { id: Scraper; label: string; description: string }[] = [
  { id: "vlr", label: "VLR Scraper", description: "Pull match and player data from vlr.gg" },
  { id: "tracker", label: "Tracker Scraper", description: "Agents per map from competitive history" },
];

// The form always shows at least this many player inputs.
const MIN_PLAYER_SLOTS = 5;

// Riot IDs look like "SpaceRock#R0CK": a name, a hash, then a tag.
const RIOT_ID_PATTERN = /^[^#]{3,16}#[A-Za-z0-9]{3,5}$/;

type PlayerResult =
  | { status: "loading"; message: string }
  | { status: "error"; message: string }
  | { status: "done"; account: Account; acts: ActBreakdown[]; matchCount: number };

function splitRiotId(id: string): { name: string; tag: string } {
  const hash = id.lastIndexOf("#");
  return { name: id.slice(0, hash), tag: id.slice(hash + 1) };
}

type DonePlayer = { riotId: string; account: Account; acts: ActBreakdown[]; matchCount: number };

const RESULT_LABEL = { win: "W", loss: "L", draw: "D" } as const;

/**
 * Summary cell: the player's most played agent on a map. When several agents
 * share the top count, the name is highlighted and the hover card marks the
 * agents it is tied with.
 */
function TopAgentCell({ entry }: { entry: MapBreakdown | undefined }) {
  const tied = entry ? topAgents(entry.agents) : [];
  const top = tied[0];

  if (!entry || !top) return <td class="sc-empty">—</td>;

  const tiedNames = new Set(tied.slice(1).map((a) => a.agent));
  const isTie = tiedNames.size > 0;
  const alsoPlayed = entry.agents.filter((a) => a.agent !== top.agent);

  return (
    <td>
      <span
        class={`sc-top ${isTie ? "is-tied" : ""}`}
        tabindex={0}
        aria-label={isTie ? `${top.agent}, tied with ${[...tiedNames].join(", ")}` : undefined}
      >
        <span class="sc-agent-name">{top.agent}</span>
        <span class="sc-hover-card" role="tooltip">
          <span class="sc-hover-title">
            {isTie
              ? `Tied for most played on ${entry.map}`
              : alsoPlayed.length
                ? `Also played on ${entry.map}`
                : `Only agent played on ${entry.map}`}
          </span>
          {alsoPlayed.length > 0 && (
            <ul class="sc-hover-list">
              {alsoPlayed.map((a) => (
                <li key={a.agent} class={tiedNames.has(a.agent) ? "is-tied" : ""}>
                  <span class="sc-agent-name">
                    {a.agent}
                    {tiedNames.has(a.agent) && <span class="sc-tied-mark"> tied</span>}
                  </span>
                  <span class="sc-agent-record">
                    ×{a.games} · {a.wins}W-{a.losses}L{a.draws ? `-${a.draws}D` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </span>
      </span>{" "}
      <span class="sc-agent-record">
        ×{top.games} of {entry.games}
      </span>
    </td>
  );
}

/** Per-map detail for one player in one act: agent history, win/loss, recent agents. */
function PlayerDetail({ player, act }: { player: DonePlayer; act: ActBreakdown | undefined }) {
  const { account, matchCount } = player;
  const actRate = act ? winRate({ wins: act.maps.reduce((n, m) => n + m.wins, 0), losses: act.maps.reduce((n, m) => n + m.losses, 0) }) : null;
  return (
    <article class="sc-report">
      <header class="sc-report-header">
        <div>
          <h3>
            {account.name}#{account.tag}
          </h3>
          <p class="sc-muted">
            {account.region.toUpperCase()} · level {account.account_level} · {matchCount} competitive match{matchCount === 1 ? "" : "es"} on record
            {act && ` · ${act.games} in ${act.act}`}
            {actRate !== null && ` · ${actRate}% win rate`}
          </p>
        </div>
      </header>

      {!act ? (
        <p class="sc-muted">No competitive matches for this player in the selected act.</p>
      ) : (
        <div class="sc-table-scroll">
          <table class="sc-table sc-detail">
            <thead>
              <tr>
                <th>Map</th>
                <th class="sc-num">W / L</th>
                <th>Agent history</th>
                <th>Most recent</th>
              </tr>
            </thead>
            <tbody>
              {act.maps.map((m) => {
                const rate = winRate(m);
                return (
                  <tr key={m.map}>
                    <td class="sc-map">
                      {m.map}
                      <span class="sc-map-games">
                        {m.games} game{m.games === 1 ? "" : "s"}
                      </span>
                    </td>
                    <td class="sc-num">
                      <span class="sc-record">
                        {m.wins}W-{m.losses}L{m.draws ? `-${m.draws}D` : ""}
                      </span>
                      <span class="sc-rate">{rate === null ? "—" : `${rate}%`}</span>
                    </td>
                    <td>
                      <ul class="sc-agents">
                        {m.agents.map((a) => (
                          <li key={a.agent} class="sc-agent">
                            <span class="sc-agent-name">{a.agent}</span>
                            <span class="sc-agent-games">×{a.games}</span>
                            <span class="sc-agent-record" title="wins-losses">
                              {a.wins}W-{a.losses}L{a.draws ? `-${a.draws}D` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <ol class="sc-recent" aria-label="Most recent games, newest first">
                        {m.recent.map((g) => (
                          <li
                            key={g.startedAt}
                            class={`sc-recent-game is-${g.result}`}
                            title={`${new Date(g.startedAt).toLocaleDateString()} · ${g.result}`}
                          >
                            {g.agent}
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

/**
 * Summary of every analyzed player: one row per map, one column per player,
 * each cell showing that player's most played agent on the map. Column
 * headers are buttons that open the player's full breakdown below.
 */
function ResultsSummary({ ids, results }: { ids: string[]; results: Record<string, PlayerResult> }) {
  const [selectedAct, setSelectedAct] = usePersistentState<string | null>(STORE.act, () => null);
  const [selectedPlayers, setSelectedPlayers] = usePersistentState<string[]>(STORE.selected, () => []);

  function togglePlayer(riotId: string) {
    setSelectedPlayers((cur) => (cur.includes(riotId) ? cur.filter((id) => id !== riotId) : [...cur, riotId]));
  }

  const done: DonePlayer[] = ids.flatMap((riotId) => {
    const r = results[riotId];
    return r?.status === "done" ? [{ riotId, ...r }] : [];
  });
  const pending = ids.flatMap((id) => {
    const r = results[id];
    return r && r.status !== "done" ? [{ id, status: r.status, message: r.message }] : [];
  });

  // Union of acts across players, newest first.
  const actsByKey = new Map<string, string>();
  for (const p of done) for (const a of p.acts) if ((actsByKey.get(a.act) ?? "") < a.latestMatchAt) actsByKey.set(a.act, a.latestMatchAt);
  const acts = [...actsByKey.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([act]) => act);
  const act = selectedAct && acts.includes(selectedAct) ? selectedAct : acts[0];

  const actFor = (p: DonePlayer) => p.acts.find((a) => a.act === act);

  // Union of maps in the selected act, ordered by total games across players.
  const mapTotals = new Map<string, number>();
  for (const p of done) for (const m of actFor(p)?.maps ?? []) mapTotals.set(m.map, (mapTotals.get(m.map) ?? 0) + m.games);
  const maps = [...mapTotals.entries()].sort((a, b) => b[1] - a[1]).map(([map]) => map);

  const details = done.filter((p) => selectedPlayers.includes(p.riotId));

  return (
    <section class="sc-results" aria-live="polite">
      {pending.length > 0 && (
        <ul class="sc-status-list">
          {pending.map((p) => (
            <li key={p.id} class={`sc-status is-${p.status}`}>
              <strong>{p.id}</strong> <span class="sc-muted">{p.message}</span>
            </li>
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <>
          <header class="sc-report-header">
            <div>
              <h3>Most played agent per map</h3>
              <p class="sc-muted">Select one or more players to see their agent history, win rate and recent picks per map.</p>
            </div>
            {acts.length > 0 && (
              <label class="sc-act-picker">
                <span>Act</span>
                <select value={act} onChange={(e) => setSelectedAct((e.currentTarget as HTMLSelectElement).value)}>
                  {acts.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </header>

          {maps.length === 0 ? (
            <p class="sc-muted">No competitive matches found in this act.</p>
          ) : (
            <div class="sc-table-scroll sc-summary-scroll">
              <table class="sc-table sc-summary">
                <thead>
                  <tr>
                    <th>Player</th>
                    {maps.map((map) => (
                      <th key={map} class="sc-map-head">
                        {map}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {done.map((p) => {
                    const playerAct = actFor(p);
                    return (
                      <tr key={p.riotId}>
                        <th scope="row" class="sc-player-cell">
                          <button
                            type="button"
                            class={`sc-player-button ${selectedPlayers.includes(p.riotId) ? "is-active" : ""}`}
                            aria-pressed={selectedPlayers.includes(p.riotId)}
                            onClick={() => togglePlayer(p.riotId)}
                          >
                            {p.account.name}
                            <span class="sc-player-tag">#{p.account.tag}</span>
                          </button>
                        </th>
                        {maps.map((map) => (
                          <TopAgentCell key={`${map}:${act}`} entry={playerAct?.maps.find((m) => m.map === map)} />
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {details.map((p) => (
            <PlayerDetail key={p.riotId} player={p} act={actFor(p)} />
          ))}
        </>
      )}
    </section>
  );
}

/** Drops in-flight entries so a reload never restores a "loading" state that will not resolve. */
function finishedOnly(results: Record<string, PlayerResult>): Record<string, PlayerResult> {
  return Object.fromEntries(Object.entries(results).filter(([, r]) => r.status !== "loading"));
}

function TrackerForm() {
  const [players, setPlayers] = usePersistentState<string[]>(STORE.players, () => Array(MIN_PLAYER_SLOTS).fill(""));
  const [results, setResults] = usePersistentState<Record<string, PlayerResult>>(STORE.results, () => ({}), finishedOnly);
  const [running, setRunning] = useState(false);

  function clearAll() {
    setPlayers(Array(MIN_PLAYER_SLOTS).fill(""));
    setResults({});
    clearStored([STORE.act, STORE.selected]);
  }

  function updatePlayer(index: number, value: string) {
    setPlayers((prev) => prev.map((p, i) => (i === index ? value : p)));
  }

  function addPlayer() {
    setPlayers((prev) => [...prev, ""]);
  }

  function removePlayer(index: number) {
    setPlayers((prev) => (prev.length > MIN_PLAYER_SLOTS ? prev.filter((_, i) => i !== index) : prev));
  }

  const canRemove = players.length > MIN_PLAYER_SLOTS;
  const validIds = [...new Set(players.map((p) => p.trim()).filter((p) => RIOT_ID_PATTERN.test(p)))];

  async function analyze(e: Event) {
    e.preventDefault();
    if (running || validIds.length === 0) return;
    setRunning(true);
    setResults(Object.fromEntries(validIds.map((id) => [id, { status: "loading", message: "Queued…" }])));

    // Players are processed one at a time to stay well inside the API rate limit.
    for (const id of validIds) {
      const update = (r: PlayerResult) => setResults((prev) => ({ ...prev, [id]: r }));
      const onRateLimit = (secondsLeft: number, attempt: number) =>
        update({ status: "loading", message: `Rate limited by the API. Retrying in ${secondsLeft}s (attempt ${attempt})…` });
      try {
        const { name, tag } = splitRiotId(id);
        update({ status: "loading", message: "Looking up account…" });
        const account = await lookupAccount(name, tag, { onRateLimit });
        update({ status: "loading", message: "Fetching competitive matches…" });
        const matches = await fetchCompetitiveMatches(account.region, account.name, account.tag, {
          onRateLimit,
          onPage: (fetched, total) => update({ status: "loading", message: `Fetched ${fetched} of ${total} matches…` }),
        });
        update({ status: "done", account, acts: analyzeMatches(matches), matchCount: matches.length });
      } catch (err) {
        const message = err instanceof HenrikError || err instanceof Error ? err.message : "Something went wrong.";
        update({ status: "error", message });
      }
    }
    setRunning(false);
  }

  return (
    <>
      <form class="sc-form" onSubmit={analyze}>
        <p class="sc-muted">Enter Riot IDs in the form name#tag. Add more boxes for extra players.</p>
        <div class="sc-fields">
          {players.map((value, i) => {
            const trimmed = value.trim();
            const invalid = trimmed !== "" && !RIOT_ID_PATTERN.test(trimmed);
            const inputId = `tracker-player-${i + 1}`;
            return (
              <div class={`sc-field ${canRemove ? "has-remove" : ""}`} key={inputId}>
                <label for={inputId}>Player {i + 1}</label>
                <input
                  id={inputId}
                  type="text"
                  class={`sc-input ${invalid ? "is-invalid" : ""}`}
                  placeholder="SpaceRock#R0CK"
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
          <button type="submit" class="sc-add sc-primary" disabled={running || validIds.length === 0}>
            {running ? "Analyzing…" : `Analyze ${validIds.length || ""} player${validIds.length === 1 ? "" : "s"}`}
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

      {validIds.some((id) => results[id]) && <ResultsSummary ids={validIds} results={results} />}
    </>
  );
}

export function ValScraper() {
  const [active, setActive] = usePersistentState<Scraper | null>(STORE.scraper, () => null);
  const current = scrapers.find((s) => s.id === active);

  return (
    <main class="sc-scraper">
      <header class="sc-header">
        <h1>val_scraper</h1>
        <p class="sc-subtitle">Choose a data source to get started</p>
      </header>

      <div class="sc-buttons">
        {scrapers.map((s) => (
          <button
            key={s.id}
            type="button"
            class={`sc-button ${active === s.id ? "is-active" : ""}`}
            aria-pressed={active === s.id}
            onClick={() => setActive(s.id)}
          >
            <span class="sc-button-label">{s.label}</span>
            <span class="sc-button-desc">{s.description}</span>
          </button>
        ))}
      </div>

      <section class="sc-panel">
        {current ? (
          <>
            <h2>{current.label}</h2>
            <p class="sc-muted">{current.description}</p>
          </>
        ) : (
          <p class="sc-muted">No scraper selected.</p>
        )}
        {/* Kept mounted (just hidden) so switching panels never discards an analysis in progress. */}
        <div hidden={active !== "tracker"}>
          <TrackerForm />
        </div>
      </section>
    </main>
  );
}
