import type { StoredMatch } from "./henrik.ts";

export type MatchResult = "win" | "loss" | "draw";

export type AgentTally = {
  agent: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  lastPlayedAt: string; // ISO of the newest game on this agent, used to break ties
};

/** Agents sharing the top game count on a map (length 1 when there is no tie). */
export function topAgents(agents: AgentTally[]): AgentTally[] {
  if (agents.length === 0) return [];
  return agents.filter((a) => a.games === agents[0].games);
}

export type RecentGame = {
  agent: string;
  result: MatchResult;
  startedAt: string; // ISO
};

export type MapBreakdown = {
  map: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  agents: AgentTally[]; // sorted by games desc
  recent: RecentGame[]; // newest first, capped at RECENT_LIMIT
};

export type ActBreakdown = {
  act: string; // e.g. "e9a3"
  actId: string;
  games: number;
  latestMatchAt: string; // ISO, used to order acts newest-first
  maps: MapBreakdown[]; // sorted by games desc
};

// How many of the latest games to keep per map for the "recently played" view.
export const RECENT_LIMIT = 5;

export function matchOutcome(match: StoredMatch): MatchResult {
  const team = match.stats.team.toLowerCase();
  const own = team === "red" ? match.teams.red : match.teams.blue;
  const other = team === "red" ? match.teams.blue : match.teams.red;
  if (own === other) return "draw";
  return own > other ? "win" : "loss";
}

/** Win rate as a percentage of decided games (draws excluded); null when no decided games. */
export function winRate(m: { wins: number; losses: number }): number | null {
  const decided = m.wins + m.losses;
  return decided === 0 ? null : Math.round((m.wins / decided) * 100);
}

/**
 * Groups competitive matches by act, then by map, then by agent, so the
 * result answers "which agents does this player play on each map in this act",
 * along with the map's win/loss record and the agents from the latest games.
 * Acts are ordered newest-first so `acts[0]` is the current act.
 */
export function analyzeMatches(matches: StoredMatch[]): ActBreakdown[] {
  type MapAcc = { agents: Map<string, AgentTally>; wins: number; losses: number; draws: number; recent: RecentGame[] };
  const acts = new Map<string, { actId: string; latest: string; maps: Map<string, MapAcc> }>();

  // Newest first, so the first games seen per map are the most recent ones.
  const ordered = [...matches].sort((a, b) => (a.meta.started_at < b.meta.started_at ? 1 : -1));

  for (const m of ordered) {
    const actKey = m.meta.season.short || m.meta.season.id || "unknown";
    let act = acts.get(actKey);
    if (!act) {
      act = { actId: m.meta.season.id, latest: m.meta.started_at, maps: new Map() };
      acts.set(actKey, act);
    }
    if (m.meta.started_at > act.latest) act.latest = m.meta.started_at;

    const mapName = m.meta.map.name || "Unknown map";
    let mapAcc = act.maps.get(mapName);
    if (!mapAcc) {
      mapAcc = { agents: new Map(), wins: 0, losses: 0, draws: 0, recent: [] };
      act.maps.set(mapName, mapAcc);
    }

    const agentName = m.stats.character.name || "Unknown agent";
    let tally = mapAcc.agents.get(agentName);
    if (!tally) {
      // Matches are visited newest-first, so the first sighting is the latest game.
      tally = { agent: agentName, games: 0, wins: 0, losses: 0, draws: 0, lastPlayedAt: m.meta.started_at };
      mapAcc.agents.set(agentName, tally);
    }

    const result = matchOutcome(m);
    tally.games++;
    if (result === "win") {
      tally.wins++;
      mapAcc.wins++;
    } else if (result === "loss") {
      tally.losses++;
      mapAcc.losses++;
    } else {
      tally.draws++;
      mapAcc.draws++;
    }
    if (mapAcc.recent.length < RECENT_LIMIT) mapAcc.recent.push({ agent: agentName, result, startedAt: m.meta.started_at });
  }

  const byGames = <T extends { games: number }>(a: T, b: T) => b.games - a.games;
  // Most games first; among equals, the agent played most recently comes first.
  const byGamesThenRecency = (a: AgentTally, b: AgentTally) =>
    b.games - a.games || (a.lastPlayedAt < b.lastPlayedAt ? 1 : a.lastPlayedAt > b.lastPlayedAt ? -1 : 0);

  return [...acts.entries()]
    .map(([act, data]) => {
      const maps: MapBreakdown[] = [...data.maps.entries()]
        .map(([map, acc]) => {
          const agents = [...acc.agents.values()].sort(byGamesThenRecency);
          return {
            map,
            games: acc.wins + acc.losses + acc.draws,
            wins: acc.wins,
            losses: acc.losses,
            draws: acc.draws,
            agents,
            recent: acc.recent,
          };
        })
        .sort(byGames);
      return {
        act,
        actId: data.actId,
        games: maps.reduce((n, m) => n + m.games, 0),
        latestMatchAt: data.latest,
        maps,
      };
    })
    .sort((a, b) => (a.latestMatchAt < b.latestMatchAt ? 1 : -1));
}
