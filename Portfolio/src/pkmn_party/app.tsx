import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  buildRequest,
  checkSuggestion,
  DEFAULT_GOALS,
  FORMATS,
  levelForFormat,
  normalizeGoals,
  PLAYSTYLES,
  requestSuggestions,
  VGC_REGULATIONS,
  type CheckedSuggestion,
  type Goals,
} from "./ai.ts";
import { partyDefense, partyOffense, speedTiers, suggestTypes, type Member } from "./analysis.ts";
import { TYPE_COLORS, TYPES, type PokemonType } from "./data/typechart.ts";
import {
  abilitiesOf,
  allItems,
  allNatures,
  computeStats,
  getSpecies,
  legalMoves,
  natureLabel,
  searchSpecies,
  speciesTypes,
  spriteUrls,
  STAT_KEYS,
  STAT_LABELS,
  typeNames,
  type Move,
  type Species,
  type StatKey,
} from "./dex.ts";
import { defaultSet, EV_MAX, EV_TOTAL, evTotal, exportTeam, importTeam, MOVE_SLOTS, PARTY_SIZE, validateSet, type TeamSet } from "./sets.ts";
import { clearStored, usePersistentState } from "../shared/storage.ts";

// localStorage keys; bump the suffix if the saved shape changes.
const STORE = {
  team: "pkmn_party:team.v2",
  goals: "pkmn_party:goals.v1",
} as const;

const SUGGESTION_LIMIT = 12;

const typeLabel = (t: string) => t[0].toUpperCase() + t.slice(1);

function TypeBadge({ type }: { type: PokemonType }) {
  return (
    <span class="pk-type" style={{ "--pk-type": TYPE_COLORS[type] }}>
      {type}
    </span>
  );
}

function Sprite({ species, size = 96 }: { species: Species; size?: number }) {
  const urls = spriteUrls(species);
  const [src, setSrc] = useState(urls.primary);
  useEffect(() => setSrc(urls.primary), [species.id]);
  return <img class="pk-art" style={{ width: size, height: size }} src={src} alt="" loading="lazy" onError={() => src !== urls.fallback && setSrc(urls.fallback)} />;
}

/** Resolves a slot's set to what the analysis needs; null when the species is unknown. */
function toMember(set: TeamSet): Member | null {
  const species = getSpecies(set.species);
  if (!species) return null;
  const stats = computeStats(species, set.evs, set.ivs, set.level, set.nature);
  return { name: species.name, types: speciesTypes(species), speed: stats.spe, baseSpeed: species.baseStats.spe };
}

// ---------------------------------------------------------------------------
// Set editor
// ---------------------------------------------------------------------------

function SetEditor({ set, onChange }: { set: TeamSet; onChange: (next: TeamSet) => void }) {
  const species = getSpecies(set.species)!;
  const [moves, setMoves] = useState<Move[] | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    setMoves(null);
    legalMoves(species).then((list) => !cancelled && setMoves(list));
    return () => {
      cancelled = true;
    };
  }, [species.id]);
  useEffect(() => {
    let cancelled = false;
    validateSet(set).then((list) => !cancelled && setIssues(list));
    return () => {
      cancelled = true;
    };
  }, [set]);

  const total = evTotal(set.evs);
  const remaining = EV_TOTAL - total;
  const update = (patch: Partial<TeamSet>) => onChange({ ...set, ...patch });
  const setEv = (k: StatKey, raw: string) => update({ evs: { ...set.evs, [k]: Math.max(0, Math.min(EV_MAX, Math.round(Number(raw) || 0))) } });
  const setIv = (k: StatKey, raw: string) => update({ ivs: { ...set.ivs, [k]: Math.max(0, Math.min(31, Math.round(Number(raw) || 0))) } });
  const setMove = (i: number, value: string) => update({ moves: set.moves.map((m, j) => (j === i ? value : m)) });
  const moveListId = `pk-moves-${species.id}`;

  return (
    <div class="pk-editor">
      <div class="pk-editor-grid">
        <label class="pk-field">
          <span>Nickname</span>
          <input class="sc-input" type="text" value={set.name} maxLength={18} onInput={(e) => update({ name: (e.currentTarget as HTMLInputElement).value })} />
        </label>
        <label class="pk-field">
          <span>Ability</span>
          <select class="sc-input" value={set.ability} onChange={(e) => update({ ability: (e.currentTarget as HTMLSelectElement).value })}>
            {abilitiesOf(species).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label class="pk-field">
          <span>Item</span>
          <input class="sc-input" type="text" list="pk-items" value={set.item} placeholder="None" onInput={(e) => update({ item: (e.currentTarget as HTMLInputElement).value })} />
        </label>
        <label class="pk-field">
          <span>Nature</span>
          <select class="sc-input" value={set.nature} onChange={(e) => update({ nature: (e.currentTarget as HTMLSelectElement).value })}>
            {allNatures().map((n) => (
              <option key={n.name} value={n.name}>
                {natureLabel(n)}
              </option>
            ))}
          </select>
        </label>
        <label class="pk-field">
          <span>Tera type</span>
          <select class="sc-input" value={set.teraType} onChange={(e) => update({ teraType: (e.currentTarget as HTMLSelectElement).value })}>
            {typeNames().map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label class="pk-field">
          <span>Level</span>
          <input class="sc-input" type="number" min={1} max={100} value={set.level} onInput={(e) => update({ level: Math.max(1, Math.min(100, Number((e.currentTarget as HTMLInputElement).value) || 1)) })} />
        </label>
      </div>

      <div class="pk-evs">
        <div class="pk-evs-head">
          <span>EVs</span>
          <span class={remaining < 0 ? "is-over" : ""}>
            {total} / {EV_TOTAL} · {remaining} left
          </span>
        </div>
        <div class="pk-evs-grid">
          {STAT_KEYS.map((k) => (
            <label key={k} class="pk-ev">
              <span>{STAT_LABELS[k]}</span>
              <input class="sc-input" type="number" min={0} max={EV_MAX} step={4} value={set.evs[k]} onInput={(e) => setEv(k, (e.currentTarget as HTMLInputElement).value)} />
              <input class="pk-ev-slider" type="range" min={0} max={EV_MAX} step={4} value={set.evs[k]} onInput={(e) => setEv(k, (e.currentTarget as HTMLInputElement).value)} />
            </label>
          ))}
        </div>
        <details class="pk-ivs">
          <summary>IVs (default 31)</summary>
          <div class="pk-evs-grid">
            {STAT_KEYS.map((k) => (
              <label key={k} class="pk-ev">
                <span>{STAT_LABELS[k]}</span>
                <input class="sc-input" type="number" min={0} max={31} value={set.ivs[k]} onInput={(e) => setIv(k, (e.currentTarget as HTMLInputElement).value)} />
              </label>
            ))}
          </div>
        </details>
      </div>

      <div class="pk-moves">
        <div class="pk-evs-head">
          <span>Moves</span>
          <span>{moves ? `${moves.length} legal` : "loading learnset…"}</span>
        </div>
        <datalist id={moveListId}>
          {(moves ?? []).map((m) => (
            <option key={m.id} value={m.name}>
              {`${m.type} · ${m.category}${m.basePower ? ` · ${m.basePower} BP` : ""}`}
            </option>
          ))}
        </datalist>
        <div class="pk-editor-grid">
          {Array.from({ length: MOVE_SLOTS }, (_, i) => (
            <input key={i} class="sc-input" type="text" list={moveListId} placeholder={`Move ${i + 1}`} value={set.moves[i] ?? ""} onInput={(e) => setMove(i, (e.currentTarget as HTMLInputElement).value)} />
          ))}
        </div>
      </div>

      {issues.length > 0 && (
        <ul class="pk-issues">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Party slot
// ---------------------------------------------------------------------------

function Slot({ index, set, editing, onEdit, onRemove }: { index: number; set: TeamSet | null; editing: boolean; onEdit: () => void; onRemove: () => void }) {
  if (!set) {
    return (
      <li class="pk-slot is-empty">
        <span class="pk-slot-number">#{index + 1}</span>
        <span>Empty slot</span>
      </li>
    );
  }
  const species = getSpecies(set.species);
  if (!species) {
    return (
      <li class="pk-slot is-empty">
        <span class="pk-slot-number">#{index + 1}</span>
        <span>Unknown: {set.species}</span>
        <button type="button" class="sc-remove" aria-label="Remove" onClick={onRemove}>
          ×
        </button>
      </li>
    );
  }
  const stats = computeStats(species, set.evs, set.ivs, set.level, set.nature);
  const moves = set.moves.filter(Boolean);
  return (
    <li class={`pk-slot ${editing ? "is-editing" : ""}`}>
      <span class="pk-slot-number">#{index + 1}</span>
      <button type="button" class="sc-remove" aria-label={`Remove ${species.name}`} title="Remove" onClick={onRemove}>
        ×
      </button>
      <Sprite species={species} />
      <h3 class="pk-name">{set.name || species.name}</h3>
      {set.name && <span class="pk-dex">{species.name}</span>}
      <div class="pk-types">
        {speciesTypes(species).map((t) => (
          <TypeBadge key={t} type={t} />
        ))}
      </div>
      <dl class="pk-set-summary">
        <dt>Ability</dt>
        <dd>{set.ability || "—"}</dd>
        <dt>Item</dt>
        <dd>{set.item || "—"}</dd>
        <dt>Nature</dt>
        <dd>{set.nature || "—"}</dd>
        <dt>Tera</dt>
        <dd>{set.teraType || "—"}</dd>
      </dl>
      <ul class="pk-move-list">
        {Array.from({ length: MOVE_SLOTS }, (_, i) => (
          <li key={i} class={moves[i] ? "" : "is-empty"}>
            {moves[i] || "—"}
          </li>
        ))}
      </ul>
      <div class="pk-stats" aria-label={`Stats at level ${set.level}`}>
        {STAT_KEYS.map((k) => (
          <>
            <span>{STAT_LABELS[k]}</span>
            <span class="pk-bar">
              <span style={{ width: `${Math.min(100, (stats[k] / (k === "hp" ? 500 : 400)) * 100)}%` }} />
            </span>
            <span title={`base ${species.baseStats[k]}, ${set.evs[k]} EVs`}>{stats[k]}</span>
          </>
        ))}
      </div>
      <span class="pk-total">
        Lv {set.level} · BST {STAT_KEYS.reduce((s, k) => s + species.baseStats[k], 0)}
      </span>
      <button type="button" class={`sc-add pk-edit ${editing ? "is-active" : ""}`} onClick={onEdit}>
        {editing ? "Close editor" : "Edit set"}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function names(list: Member[]) {
  return list.map((p) => p.name).join(", ");
}

function Analysis({ members }: { members: Member[] }) {
  const defense = useMemo(() => partyDefense(members), [members]);
  const offense = useMemo(() => partyOffense(members), [members]);
  const suggestions = useMemo(() => suggestTypes(defense), [defense]);
  const tiers = useMemo(() => speedTiers(members), [members]);
  const uncovered = offense.filter((r) => r.best < 2);
  const problems = defense.filter((r) => r.net > 0).sort((a, b) => b.net - a.net);

  return (
    <section class="pk-analysis" aria-live="polite">
      <article class="sc-report">
        <header class="sc-report-header">
          <div>
            <h3>Defensive coverage</h3>
            <p class="sc-muted">
              For each attacking type: how many party members take super-effective damage versus how many resist or are immune. Highlighted cells are
              types the party struggles against.
              {problems.length > 0
                ? ` Biggest problems: ${problems
                    .slice(0, 3)
                    .map((r) => `${typeLabel(r.type)} (+${r.net})`)
                    .join(", ")}.`
                : " Nothing hits more of the party than it resists."}
            </p>
          </div>
        </header>
        <ul class="pk-grid">
          {defense.map((r) => {
            const tone = r.net > 0 ? "is-bad" : r.net < 0 ? "is-good" : "";
            return (
              <li key={r.type} class={`pk-cell ${tone}`}>
                <div class="pk-cell-head">
                  <TypeBadge type={r.type} />
                  <span class={`pk-net ${tone}`} title="weak minus resist/immune">
                    {r.net > 0 ? `+${r.net}` : r.net}
                  </span>
                </div>
                {r.weak.length > 0 && (
                  <span class="pk-who">
                    Weak: <strong>{names(r.weak)}</strong>
                    {r.veryWeak.length > 0 && ` (4×: ${names(r.veryWeak)})`}
                  </span>
                )}
                {r.resist.length > 0 && (
                  <span class="pk-who">
                    Resist: <strong>{names(r.resist)}</strong>
                  </span>
                )}
                {r.immune.length > 0 && (
                  <span class="pk-who">
                    Immune: <strong>{names(r.immune)}</strong>
                  </span>
                )}
                {r.weak.length === 0 && r.resist.length === 0 && r.immune.length === 0 && <span class="pk-who">Neutral</span>}
              </li>
            );
          })}
        </ul>
      </article>

      <article class="sc-report">
        <header class="sc-report-header">
          <div>
            <h3>Offensive coverage (STAB)</h3>
            <p class="sc-muted">
              Which defending types the party's own types hit super-effectively.
              {uncovered.length > 0 ? ` Not covered: ${uncovered.map((r) => typeLabel(r.type)).join(", ")}.` : " Every type is hit super-effectively by someone."}
            </p>
          </div>
        </header>
        <ul class="pk-grid">
          {offense.map((r) => (
            <li key={r.type} class={`pk-cell ${r.best >= 2 ? "is-good" : r.best < 1 ? "is-bad" : ""}`}>
              <div class="pk-cell-head">
                <TypeBadge type={r.type} />
                <span class={`pk-net ${r.best >= 2 ? "is-good" : r.best < 1 ? "is-bad" : ""}`}>{r.best === 0 ? "immune" : `${r.best}×`}</span>
              </div>
              <span class="pk-who">{r.by.length > 0 ? `Via ${r.by.map(typeLabel).join(", ")}` : "No super-effective STAB"}</span>
            </li>
          ))}
        </ul>
      </article>

      <article class="sc-report">
        <header class="sc-report-header">
          <div>
            <h3>Speed tiers</h3>
            <p class="sc-muted">Actual speed stats with nature, EVs and level applied, fastest first. Base speed in brackets.</p>
          </div>
        </header>
        <ol class="pk-speed">
          {tiers.map((m) => (
            <li key={m.name}>
              <span class="pk-speed-name">{m.name}</span>
              <span class="pk-speed-bar">
                <span style={{ width: `${Math.min(100, (m.speed / Math.max(1, tiers[0].speed)) * 100)}%` }} />
              </span>
              <span class="pk-speed-value">
                {m.speed} <small>({m.baseSpeed})</small>
              </span>
            </li>
          ))}
        </ol>
      </article>

      {suggestions.length > 0 && members.length < PARTY_SIZE && (
        <article class="sc-report">
          <header class="sc-report-header">
            <div>
              <h3>Types worth adding</h3>
              <p class="sc-muted">Types that resist the party's current problems, best first.</p>
            </div>
          </header>
          <ul class="pk-suggest">
            {suggestions.map((s) => (
              <li key={s.type}>
                <TypeBadge type={s.type} /> resists {s.patches.map(typeLabel).join(", ")}
              </li>
            ))}
          </ul>
        </article>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// AI suggestions
// ---------------------------------------------------------------------------

type SuggestState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "done"; items: CheckedSuggestion[]; notes: string };

function AiSuggestions({ state, onRun, onAdd, team }: { state: SuggestState; onRun: () => void; onAdd: (c: CheckedSuggestion) => void; team: TeamSet[] }) {
  return (
    <article class="sc-report pk-ai">
      <header class="sc-report-header">
        <div>
          <h3>AI suggestions</h3>
          <p class="sc-muted">
            Sends the team, your goals and the coverage analysis to ChatGPT (OpenAI's API) and asks for Pokémon with full sets. Every suggestion is
            checked against the dex before it appears; illegal moves are stripped.
          </p>
        </div>
        <button type="button" class="sc-add sc-primary" disabled={state.status === "loading"} onClick={onRun}>
          {state.status === "loading" ? "Thinking…" : team.length >= PARTY_SIZE ? "Suggest replacements" : "Suggest Pokémon"}
        </button>
      </header>
      {state.status === "error" && <p class="pk-error">{state.message}</p>}
      {state.status === "loading" && <p class="pk-hint">Asking the model. This usually takes 15 to 40 seconds.</p>}
      {state.status === "done" && (
        <>
          {state.notes && <p class="pk-notes">{state.notes}</p>}
          <ul class="pk-ai-list">
            {state.items.map((c, i) => (
              <li key={`${c.suggestion.species}-${i}`} class={`pk-ai-card ${c.set ? "" : "is-invalid"}`}>
                <div class="pk-ai-head">
                  {c.species && <Sprite species={c.species} size={64} />}
                  <div>
                    <h4 class="pk-name">{c.suggestion.species}</h4>
                    <span class="pk-dex">{c.suggestion.role}</span>
                    {c.suggestion.replaces && <span class="pk-dex"> · replaces {c.suggestion.replaces}</span>}
                    {c.species && (
                      <div class="pk-types">
                        {speciesTypes(c.species).map((t) => (
                          <TypeBadge key={t} type={t} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <p class="pk-why">{c.suggestion.why}</p>
                {c.set && (
                  <dl class="pk-set-summary">
                    <dt>Ability</dt>
                    <dd>{c.set.ability}</dd>
                    <dt>Item</dt>
                    <dd>{c.set.item || "—"}</dd>
                    <dt>Nature</dt>
                    <dd>{c.set.nature}</dd>
                    <dt>Tera</dt>
                    <dd>{c.set.teraType}</dd>
                    <dt>EVs</dt>
                    <dd>
                      {STAT_KEYS.filter((k) => c.set!.evs[k])
                        .map((k) => `${c.set!.evs[k]} ${STAT_LABELS[k]}`)
                        .join(" / ") || "none"}
                    </dd>
                    <dt>Moves</dt>
                    <dd>{c.set.moves.filter(Boolean).join(", ") || "—"}</dd>
                  </dl>
                )}
                {c.suggestion.alternatives.length > 0 && <span class="pk-dex">Alternatives: {c.suggestion.alternatives.join(", ")}</span>}
                {c.issues.length > 0 && (
                  <ul class="pk-issues">
                    {c.issues.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                )}
                {c.set && (
                  <button type="button" class="sc-add" onClick={() => onAdd(c)}>
                    {c.suggestion.replaces ? `Swap in for ${c.suggestion.replaces}` : "Add to party"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function PartyMaker() {
  const [team, setTeam] = usePersistentState<TeamSet[]>(STORE.team, () => []);
  const [storedGoals, setGoals] = usePersistentState<Goals>(STORE.goals, () => DEFAULT_GOALS);
  const goals = normalizeGoals(storedGoals);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [importText, setImportText] = useState("");
  const [suggest, setSuggest] = useState<SuggestState>({ status: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  const level = levelForFormat(goals.format);
  const full = team.length >= PARTY_SIZE;
  const matches = useMemo(() => searchSpecies(query, SUGGESTION_LIMIT), [query]);
  const members = useMemo(() => team.map(toMember).filter((m): m is Member => m !== null), [team]);
  const defense = useMemo(() => partyDefense(members), [members]);
  const offense = useMemo(() => partyOffense(members), [members]);
  const exportText = useMemo(() => exportTeam(team), [team]);

  function add(species: Species) {
    if (full) return;
    if (team.some((s) => s.species === species.name)) {
      setError(`${species.name} is already in the party.`);
      return;
    }
    setError(null);
    setTeam((cur) => [...cur, defaultSet(species, level)]);
    setQuery("");
    inputRef.current?.focus();
  }

  function addByName(raw: string) {
    const species = getSpecies(raw) ?? matches[0] ?? null;
    if (!species) {
      setError(`No Pokémon called "${raw}".`);
      return;
    }
    add(species);
  }

  function updateSlot(index: number, next: TeamSet) {
    setTeam((cur) => cur.map((s, i) => (i === index ? next : s)));
  }

  function remove(index: number) {
    setTeam((cur) => cur.filter((_, i) => i !== index));
    setEditing((cur) => (cur === index ? null : cur !== null && cur > index ? cur - 1 : cur));
  }

  function changeFormat(format: Goals["format"]) {
    const nextLevel = levelForFormat(format);
    setGoals({ ...goals, format });
    // Sets follow the format's level unless someone set a custom one.
    setTeam((cur) => cur.map((s) => (s.level === level ? { ...s, level: nextLevel } : s)));
  }

  function doImport() {
    const { sets, errors } = importTeam(importText, level);
    if (sets.length > 0) {
      setTeam(sets);
      setEditing(null);
      setImportText("");
    }
    setError(errors.length ? errors.join(" · ") : null);
  }

  function clearAll() {
    setTeam([]);
    setEditing(null);
    setQuery("");
    setError(null);
    setSuggest({ status: "idle" });
    clearStored([]);
  }

  async function runSuggest() {
    setSuggest({ status: "loading" });
    try {
      const res = await requestSuggestions(buildRequest(team, members, goals, defense, offense));
      const items = await Promise.all(res.suggestions.map((s) => checkSuggestion(s, level)));
      setSuggest({ status: "done", items, notes: res.team_notes ?? "" });
    } catch (err) {
      setSuggest({ status: "error", message: err instanceof Error ? err.message : "Something went wrong." });
    }
  }

  function addSuggestion(c: CheckedSuggestion) {
    if (!c.set) return;
    const set = c.set;
    setTeam((cur) => {
      if (cur.some((s) => s.species === set.species)) return cur;
      const replaceIndex = c.suggestion.replaces ? cur.findIndex((s) => s.species.toLowerCase() === c.suggestion.replaces.toLowerCase()) : -1;
      if (replaceIndex >= 0) return cur.map((s, i) => (i === replaceIndex ? set : s));
      return cur.length >= PARTY_SIZE ? cur : [...cur, set];
    });
    setError(null);
  }

  return (
    <main class="sc-scraper">
      <header class="sc-header">
        <h1>pkmn_party</h1>
        <p class="sc-subtitle">Build a competitive team of six: full sets, coverage analysis, and AI suggestions for the rest</p>
      </header>

      <section class="sc-panel">
        <h2>Goals</h2>
        <p class="sc-muted">These steer the AI suggestions and set the default level for new sets.</p>
        <div class="pk-goals">
          <label class="pk-field">
            <span>Format</span>
            <select class="sc-input" value={goals.format} onChange={(e) => changeFormat((e.currentTarget as HTMLSelectElement).value as Goals["format"])}>
              {FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label class="pk-field">
            <span>Playstyle</span>
            <select class="sc-input" value={goals.playstyle} onChange={(e) => setGoals({ ...goals, playstyle: (e.currentTarget as HTMLSelectElement).value })}>
              {PLAYSTYLES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          {goals.format === "vgc" && (
            <label class="pk-field">
              <span>VGC ruleset</span>
              <select class="sc-input" value={goals.ruleset} onChange={(e) => setGoals({ ...goals, ruleset: (e.currentTarget as HTMLSelectElement).value })}>
                {VGC_REGULATIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {goals.format === "vgc" && goals.ruleset === "custom" && (
            <label class="pk-field pk-field-wide">
              <span>Custom rules</span>
              <input
                class="sc-input"
                type="text"
                maxLength={600}
                placeholder="e.g. Regulation J: no restricted Legendaries, Paradox allowed, item clause"
                value={goals.customRules}
                onInput={(e) => setGoals({ ...goals, customRules: (e.currentTarget as HTMLInputElement).value })}
              />
            </label>
          )}
          <label class="pk-field pk-field-wide">
            <span>Notes for the AI</span>
            <input
              class="sc-input"
              type="text"
              maxLength={1000}
              placeholder="e.g. keep Garchomp as the main breaker, no Legendaries, want a Fairy answer"
              value={goals.notes}
              onInput={(e) => setGoals({ ...goals, notes: (e.currentTarget as HTMLInputElement).value })}
            />
          </label>
        </div>
      </section>

      <section class="sc-panel">
        <h2>Party</h2>
        <p class="sc-muted">Generation 9 data from Pokémon Showdown. Formes and regional variants work (e.g. "Ogerpon-Wellspring", "Ninetales-Alola").</p>

        <form
          class="pk-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) addByName(query);
          }}
        >
          <input
            ref={inputRef}
            type="text"
            class="sc-input"
            list="pk-species"
            placeholder={full ? "Party is full" : "Add a Pokémon by name"}
            value={query}
            autocomplete="off"
            spellcheck={false}
            disabled={full}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          />
          <datalist id="pk-species">
            {matches.map((s) => (
              <option key={s.id} value={s.name}>
                {`#${s.num} · ${s.types.join("/")}`}
              </option>
            ))}
          </datalist>
          <datalist id="pk-items">
            {allItems().map((i) => (
              <option key={i.id} value={i.name} />
            ))}
          </datalist>
          <button type="submit" class="sc-add sc-primary" disabled={full || query.trim() === ""}>
            Add
          </button>
          <span class="sc-muted sc-count">
            {team.length} / {PARTY_SIZE}
          </span>
          <button type="button" class="sc-clear" disabled={team.length === 0} onClick={clearAll}>
            Clear
          </button>
        </form>
        {error && <p class="pk-error">{error}</p>}

        <div class="pk-party-scroll">
          <ul class="pk-party" aria-label="Party">
            {Array.from({ length: PARTY_SIZE }, (_, i) => (
              <Slot
                key={team[i] ? `${team[i].species}-${i}` : `empty-${i}`}
                index={i}
                set={team[i] ?? null}
                editing={editing === i}
                onEdit={() => setEditing(editing === i ? null : i)}
                onRemove={() => remove(i)}
              />
            ))}
          </ul>
        </div>

        {editing !== null && team[editing] && getSpecies(team[editing].species) && (
          <div class="pk-editor-panel">
            <div class="pk-editor-title">
              <h3>
                Editing #{editing + 1} · {team[editing].name || team[editing].species}
              </h3>
              <button type="button" class="sc-add" onClick={() => setEditing(null)}>
                Done
              </button>
            </div>
            <SetEditor set={team[editing]} onChange={(next) => updateSlot(editing, next)} />
          </div>
        )}

        {members.length > 0 ? (
          <Analysis members={members} />
        ) : (
          <p class="pk-hint">Add Pokémon to see which of the {TYPES.length} types the party is weak to, what it hits hard, speed tiers, and which types would patch the gaps.</p>
        )}

        <AiSuggestions state={suggest} onRun={runSuggest} onAdd={addSuggestion} team={team} />
      </section>

      <section class="sc-panel">
        <h2>Import / export</h2>
        <p class="sc-muted">Pokémon Showdown's text format, so teams move between here, Showdown and Smogon unchanged.</p>
        <div class="pk-io">
          <label class="pk-field">
            <span>Export</span>
            <textarea class="pk-share" readOnly value={exportText} placeholder="Add Pokémon to get export text" onFocus={(e) => (e.currentTarget as HTMLTextAreaElement).select()} />
          </label>
          <label class="pk-field">
            <span>Import (replaces the party)</span>
            <textarea class="pk-share" value={importText} placeholder={"Garchomp @ Loaded Dice\nAbility: Rough Skin\n..."} onInput={(e) => setImportText((e.currentTarget as HTMLTextAreaElement).value)} />
            <button type="button" class="sc-add" disabled={importText.trim() === ""} onClick={doImport}>
              Import team
            </button>
          </label>
        </div>
      </section>
    </main>
  );
}
