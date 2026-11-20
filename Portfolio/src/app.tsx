import { useState, useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";

import ieIcon from "./assets/desktop/System Information.png";
import folderIcon from "./assets/desktop/My Documents.png";
import notepadIcon from "./assets/desktop/Generic Text Document.png";
import contact from "./assets/desktop/Search for people.png";
import music from "./assets/desktop/My Music.png";
import games from "./assets/desktop/Game Controller.png";
import journalIcon from "./assets/desktop/Journal Note.png";
import videoIcon from "./assets/desktop/Generic Video.png";
import helpIcon from "./assets/desktop/HLP.png";

import bg3 from "./assets/games/bg3.jpg";
import stardewValley from "./assets/games/stardewValley.png";
import cs2 from "./assets/games/Cs2.jpg";
import eldenRing from "./assets/games/eldenRing.jpg";
import balatro from "./assets/games/balatro.jpg";
import marvelRivals from "./assets/games/marvelRivals.jpg";
import itTakesTwo from "./assets/games/itTakesTwo.jpg";
import ballXPit from "./assets/games/ballXPit.jpg";
import slimeRancher2 from "./assets/games/slimeRancher2.jpg";
import divinityOS2 from "./assets/games/divinityOS2.jpg";
import valorant from "./assets/games/valorant.jpg";
import pokemonBlack2 from "./assets/games/pokemonBlack2.jpg";
import fireEmblemThreeHouses from "./assets/games/fireEmblemThreeHouses.jpg";
import fireEmblemFortunesWeave from "./assets/games/fireEmblemFortunesWeave.jpg";
import pokemonPokopia from "./assets/games/pokemonPokopia.jpg";

import gameReviews from "./data/game-reviews.json";

import { DraggableIcon } from "./draggable";
import "./app.css";

const TASKBAR_H = 60;
const ICON_W = 80;
const ICON_H = 90;
const GRID_X = 90;
const GRID_Y = 100;

function snap(value: number, grid: number) {
  return Math.round(value / grid) * grid;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return mobile;
}

function getRandomGridPosition(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  occupied: Array<[number, number]>
): [number, number] {
  let x: number, y: number;
  let attempts = 0;

  do {
    x = snap(Math.random() * (maxX - minX) + minX, GRID_X);
    y = snap(Math.random() * (maxY - minY) + minY, GRID_Y);

    x = clamp(x, minX, maxX);
    y = clamp(y, minY, maxY);

    attempts++;
  } while (
    occupied.some(([ox, oy]) => ox === x && oy === y) &&
    attempts < 100
  );

  return [x, y];
}

type IconData = {
  id: string;
  img: string;
  label: string;
  x: number;
  y: number;
};

type WindowData = {
  id: string;
  title: string;
};

type WindowProps = {
  title: string;
  children: ComponentChildren;
  onClose: () => void;
  onFocus?: () => void;
  zIndex?: number;
  /** Extra class on the content area, for windows that bring their own chrome (the Word resume). */
  contentClass?: string;
};

/**
 * Title-bar text per window: the name of the program each window is styled as,
 * except where Rakshaa chose a title (resume.doc, My Vinyl Player, Games).
 */
const WINDOW_TITLES: Record<string, string> = {
  notepad: "resume.doc",
  contact: "Address Book",
  music: "My Vinyl Player",
  about: "SpaceRock's Space",
  games: "Games",
  folder: "Projects",
};

/** Content-area class per window, for windows styled as a whole program (see app.css). */
const WINDOW_CONTENT_CLASS: Record<string, string> = {
  notepad: "is-word",
  contact: "is-card",
  music: "is-player",
  about: "is-profile",
  games: "is-steam",
  folder: "is-explorer",
};

/** Tabs along the top of the Address Book contact card; only Summary is real. */
const CARD_TABS = ["Summary", "Name", "Home", "Business", "Personal", "Other", "Digital IDs"];

const CONTACT_FIELDS: { label: string; value: string; href?: string }[] = [
  { label: "E-Mail", value: "rakshaajeyarajah@gmail.com", href: "mailto:rakshaajeyarajah@gmail.com" },
  { label: "LinkedIn", value: "Rakshaa Jeyarajah", href: "https://www.linkedin.com/in/rakshaa-jeyarajah-880427250/" },
  { label: "GitHub", value: "RakshaaJey", href: "https://github.com/rakshaaJey" },
  { label: "X/Twitter", value: "SpaceRock", href: "https://x.com/sp4cer0ck?s=21&t=tc9N0VsXk2wx8TYMiyL5LQ" },
  { label: "Discord", value: "space_rock" },
];

/** Word 97 menu bar; decorative, with the access-key letter underlined. */
const WORD_MENUS = ["File", "Edit", "View", "Insert", "Format", "Tools", "Table", "Window", "Help"];

interface MyRecord {
  id: number;
  title: string;
  artist: string;
  year: number;
  cover: string;
}

const VIZ_BARS = 14;

/** "m:ss" for the player's elapsed-time readout. */
const playTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * The vinyl collection as a retro digital music player: a now-playing display
 * (cover, scrolling title, timer, visualizer) over transport buttons and a
 * playlist of every record. Nothing actually plays; the buttons move through
 * the collection and start or stop the timer and visualizer.
 */
function VinylPlayer({ records, status }: { records: MyRecord[]; status: "loading" | "error" | "ready" }) {
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const record = records[Math.min(current, records.length - 1)];

  useEffect(() => {
    if (!playing || !record) return;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [playing, record]);

  // Until the shelf loads (or if it can't), the display says so instead of showing a record.
  if (status !== "ready" || !record) {
    return (
      <div class="player">
        <div class="player-bar">
          <span>MY VINYL PLAYER</span>
        </div>
        <div class="player-display is-empty">
          <div class="player-lcd">
            <span class="player-time">{status === "error" ? "NO DISC" : "--:--"}</span>
            <span>{status === "error" ? "Couldn't load the record shelf. Try again later." : "Loading the record shelf…"}</span>
          </div>
        </div>
      </div>
    );
  }

  function select(index: number) {
    setCurrent((index + records.length) % records.length);
    setElapsed(0);
    setPlaying(true);
  }

  function stop() {
    setPlaying(false);
    setElapsed(0);
  }

  const label = `${current + 1}. ${record.artist} - ${record.title}${record.year ? ` (${record.year})` : ""}`;

  return (
    <div class="player">
      <div class="player-bar">
        <span>MY VINYL PLAYER</span>
        <span>{records.length} records on the shelf</span>
      </div>

      <div class="player-display">
        <a
          class="player-cover"
          href={`https://www.discogs.com/release/${record.id}`}
          target="_blank"
          rel="noopener noreferrer"
          title={`${record.title} · ${record.artist}`}
        >
          <img src={record.cover} alt={record.title} />
        </a>
        <div class="player-lcd">
          <div class="player-lcd-top">
            <span class="player-state">{playing ? "▶" : elapsed ? "❚❚" : "■"}</span>
            <span class="player-time">{playTime(elapsed)}</span>
          </div>
          <div class="player-marquee" aria-live="polite">
            {/* Doubled so the scroll loops without a gap. */}
            <span class={playing ? "is-scrolling" : ""} key={record.id}>
              {label}&nbsp;&nbsp;***&nbsp;&nbsp;{label}&nbsp;&nbsp;***&nbsp;&nbsp;
            </span>
          </div>
          <div class="player-meta">
            <span>33⅓ RPM</span>
            <span>STEREO</span>
            <span>
              {current + 1}/{records.length}
            </span>
          </div>
          <div class={`player-viz ${playing ? "is-playing" : ""}`} aria-hidden="true">
            {Array.from({ length: VIZ_BARS }, (_, i) => (
              <span key={i} style={{ animationDelay: `${-((i * 0.37) % 1.1).toFixed(2)}s`, animationDuration: `${0.6 + ((i * 0.23) % 0.7)}s` }} />
            ))}
          </div>
        </div>
      </div>

      <div class="player-controls">
        <button type="button" class="player-btn" aria-label="Previous record" onClick={() => select(current - 1)}>
          ⏮
        </button>
        <button type="button" class={`player-btn ${playing ? "is-on" : ""}`} aria-label="Play" onClick={() => setPlaying(true)}>
          ▶
        </button>
        <button type="button" class={`player-btn ${!playing && elapsed ? "is-on" : ""}`} aria-label="Pause" onClick={() => setPlaying(false)}>
          ❚❚
        </button>
        <button type="button" class="player-btn" aria-label="Stop" onClick={stop}>
          ■
        </button>
        <button type="button" class="player-btn" aria-label="Next record" onClick={() => select(current + 1)}>
          ⏭
        </button>
      </div>

      <ol class="player-playlist" aria-label="Playlist">
        {records.map((r, i) => (
          <li key={r.id}>
            <button type="button" class={`player-track ${i === current ? "is-current" : ""}`} onClick={() => select(i)}>
              <span class="player-track-num">{i + 1}.</span>
              <span class="player-track-name">
                {r.artist} - {r.title}
              </span>
              <span class="player-track-year">{r.year || ""}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Rakshaa's games. Steam ones carry hours and achievements from the Steam library (2026-11-20); the rest (Riot, Nintendo) are added as
 * non-Steam games with the hours Rakshaa gave and no achievement data.
 */
type Game = {
  title: string;
  hours: number;
  /** "unlocked/total", or null when the platform has no achievements. */
  achievements: string | null;
  steam: boolean;
  cover: string;
  /** One or two sentences about the game, condensed from its Wikipedia article (2026-11-20). */
  about: string;
};

const GAMES: Game[] = [
  {
    title: "Valorant", hours: 1283, achievements: null, steam: false, cover: valorant,
    about: "A free-to-play 5v5 tactical hero shooter from Riot Games. It borrows Counter-Strike's buy menu and precise gunplay, and adds agents with unique abilities.",
  },
  {
    title: "Baldur's Gate 3", hours: 656.7, achievements: "50/54", steam: true, cover: bg3,
    about: "Larian Studios' role-playing game set in the world of Dungeons & Dragons. Your party searches for a cure for the mind flayer parasites infecting their brains, solo or in co-op.",
  },
  {
    title: "Pokémon Black 2", hours: 538, achievements: null, steam: false, cover: pokemonBlack2,
    about: "The first direct sequel in the main Pokémon series, released for the Nintendo DS in 2012. It returns to the Unova region two years after Pokémon Black, with Black Kyurem as its legendary.",
  },
  {
    title: "Stardew Valley", hours: 249.5, achievements: "30/49", steam: true, cover: stardewValley,
    about: "A farm life sim where you inherit your grandfather's run-down farm. You grow crops, raise animals, fish and mine, and get to know (and maybe marry) the townspeople.",
  },
  {
    title: "Fire Emblem: Three Houses", hours: 247, achievements: null, steam: false, cover: fireEmblemThreeHouses,
    about: "A tactical RPG for the Nintendo Switch where you teach at a military academy. You lead one of three student houses through turn-based battles that shape the fate of the continent.",
  },
  {
    title: "Counter-Strike 2", hours: 167.3, achievements: "1/1", steam: true, cover: cs2,
    about: "Valve's free-to-play tactical shooter and the successor to CS:GO. Counter-Terrorists and Terrorists face off in objective-based rounds.",
  },
  {
    title: "Elden Ring", hours: 159.7, achievements: "25/42", steam: true, cover: eldenRing,
    about: "FromSoftware's open-world action RPG, with worldbuilding by George R. R. Martin. You cross the Lands Between to restore the shattered Elden Ring and become Elden Lord.",
  },
  {
    title: "Marvel Rivals", hours: 120.4, achievements: "16/49", steam: true, cover: marvelRivals,
    about: "NetEase's free-to-play 6v6 hero shooter with a roster of Marvel heroes and villains. Teams combine abilities and team-ups on destructible maps.",
  },
  {
    title: "Balatro", hours: 109.9, achievements: "27/31", steam: true, cover: balatro,
    about: "A poker-themed roguelike deck-builder from solo developer LocalThunk. You play poker hands to hit score targets, and build wild combos with Jokers along the way.",
  },
  {
    title: "It Takes Two", hours: 92.6, achievements: "10/20", steam: true, cover: itTakesTwo,
    about: "Hazelight's co-op-only action-adventure about Cody and May, a couple on the brink of divorce. Turned into dolls, they have to work together to get back to their bodies.",
  },
  {
    title: "BALL x PIT", hours: 85, achievements: "63/63", steam: true, cover: ballXPit,
    about: "A roguelike that mixes Arkanoid-style ball bouncing with city building. Resources from each run upgrade your town, unlocking new characters and abilities.",
  },
  {
    title: "Pokémon Pokopia", hours: 62, achievements: null, steam: false, cover: pokemonPokopia,
    about: "A cozy Pokémon life sim for the Nintendo Switch 2. A Ditto transformed into a human rebuilds a post-apocalyptic world with the Pokémon it meets.",
  },
  {
    title: "Slime Rancher 2", hours: 56.8, achievements: "27/27", steam: true, cover: slimeRancher2,
    about: "The sequel to Slime Rancher, a first-person farm sim about collecting and raising adorable slimes. Beatrix LeBeau explores the mysterious Rainbow Island.",
  },
  {
    title: "Divinity: Original Sin 2", hours: 35.1, achievements: "9/97", steam: true, cover: divinityOS2,
    about: "Larian Studios' turn-based RPG, and a spiritual predecessor to Baldur's Gate 3. You play a persecuted Source magic user fighting the monstrous Voidwoken in the world of Rivellon.",
  },
  {
    title: "Fire Emblem: Fortune's Weave", hours: 15.2, achievements: null, steam: false, cover: fireEmblemFortunesWeave,
    about: "A 2026 tactical RPG for the Nintendo Switch 2, set in the same world as Three Houses. Four warriors fight in the Dagdan Empire's Heroic Games to win their heart's desire.",
  },
];

type GameSort = "hours" | "name" | "achievements";

/** Unlocked / total, or null with no achievement data. */
function achievementProgress(g: Game): { got: number; total: number; share: number } | null {
  if (!g.achievements) return null;
  const [got, total] = g.achievements.split("/").map(Number);
  return total ? { got, total, share: got / total } : null;
}

/**
 * Rakshaa's own reviews, written in src/data/game-reviews.json and keyed by the
 * game's title exactly as in GAMES. `recommended` is true (thumbs up), false
 * (thumbs down), a score such as "10/10", or null (no verdict). A game with
 * neither a verdict nor review text shows no panel.
 */
type GameReview = { recommended?: boolean | string | null; review?: string };
const REVIEWS = gameReviews as Record<string, GameReview>;

const STEAM_MENUS = ["Steam", "View", "Friends", "Games", "Help"];

/**
 * The games window as an old (circa 2011) Steam client library: a menu bar,
 * a searchable and sortable game list on the left, and the
 * selected game's page on the right. The menus, tabs and Play button are decorative.
 */
function SteamLibrary() {
  const [sort, setSort] = useState<GameSort>("hours");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(GAMES[0].title);

  const q = query.trim().toLowerCase();
  const games = GAMES.filter((g) => !q || g.title.toLowerCase().includes(q)).sort((a, b) => {
    if (sort === "name") return a.title.localeCompare(b.title);
    if (sort === "achievements") return (achievementProgress(b)?.share ?? -1) - (achievementProgress(a)?.share ?? -1) || b.hours - a.hours;
    return b.hours - a.hours;
  });
  const game = GAMES.find((g) => g.title === selected) ?? GAMES[0];
  const progress = achievementProgress(game);
  const review = REVIEWS[game.title];
  const reviewText = review?.review?.trim();
  const verdict = review?.recommended;
  const score = typeof verdict === "string" && verdict.trim() ? verdict.trim() : null;
  const hasVerdict = typeof verdict === "boolean" || score !== null;

  return (
    <div class="stm">
      <div class="stm-chrome" aria-hidden="true">
        <div class="stm-menu">
          {STEAM_MENUS.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      </div>

      <div class="stm-body">
        <aside class="stm-side">
          <input
            class="stm-search"
            type="search"
            placeholder="Search"
            aria-label="Search games"
            value={query}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          />
          <label class="stm-sort">
            <span>ALL GAMES</span>
            <select aria-label="Sort games" value={sort} onChange={(e) => setSort((e.currentTarget as HTMLSelectElement).value as GameSort)}>
              <option value="hours">by hours played</option>
              <option value="name">by name</option>
              <option value="achievements">by achievements</option>
            </select>
          </label>
          <ul class="stm-list">
            {games.map((g) => (
              <li key={g.title}>
                <button type="button" class={`stm-item ${g.title === game.title ? "is-selected" : ""}`} onClick={() => setSelected(g.title)}>
                  <img src={g.cover} alt="" />
                  <span>{g.title}</span>
                </button>
              </li>
            ))}
            {games.length === 0 && <li class="stm-none">No games match "{query}"</li>}
          </ul>
          <div class="stm-add" aria-hidden="true">
            + ADD A GAME...
          </div>
        </aside>

        <section class="stm-main" aria-label={game.title}>
          <div class="stm-hero" style={{ backgroundImage: `url(${game.cover})` }}>
            <img class="stm-hero-cover" src={game.cover} alt="" />
            <h3 class="stm-title">{game.title}</h3>
          </div>

          <div class="stm-playbar">
            <span class="stm-play" title="Not installed on this desktop">
              ▶ PLAY
            </span>
            <div class="stm-stat">
              <span class="stm-stat-label">YOU'VE PLAYED</span>
              <span class="stm-stat-value">{game.hours.toLocaleString()} hours</span>
            </div>
          </div>

          <div class="stm-panel">
            <h4 class="stm-panel-title">ACHIEVEMENTS</h4>
            {progress ? (
              <>
                <p>
                  You have unlocked <b>{progress.got}/{progress.total}</b> ({Math.round(progress.share * 100)}%)
                  {progress.got === progress.total && <span class="stm-perfect">★ Perfect game</span>}
                </p>
                <div class="stm-bar" role="progressbar" aria-valuenow={progress.got} aria-valuemin={0} aria-valuemax={progress.total}>
                  <span style={{ width: `${progress.share * 100}%` }} />
                </div>
              </>
            ) : (
              <p class="stm-muted">{game.steam ? "This game has no achievements." : "Non-Steam game: no achievements available."}</p>
            )}
          </div>

          <div class="stm-panel">
            <h4 class="stm-panel-title">ABOUT THE GAME</h4>
            <p>{game.about}</p>
          </div>

          {(reviewText || hasVerdict) && (
            <div class="stm-panel stm-review">
              <h4 class="stm-panel-title">MY REVIEW</h4>
              {hasVerdict && (
                <p class={`stm-verdict ${score ? "is-score" : verdict ? "is-yes" : "is-no"}`}>
                  <span class="stm-thumb" aria-hidden="true">
                    {score ? "★" : verdict ? "👍" : "👎"}
                  </span>
                  {score ? `Rated ${score}` : verdict ? "Recommended" : "Not Recommended"}
                  <span class="stm-verdict-hours">{game.hours.toLocaleString()} hrs on record</span>
                </p>
              )}
              {reviewText && <p class="stm-review-text">{reviewText}</p>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

type Project = {
  name: string;
  /** Shown as the file type in the tile and Details pane. */
  kind: string;
  icon: string;
  event?: string;
  award?: string;
  link?: { href: string; label: string };
  bullets: string[];
};

const PROJECTS: Project[] = [
  {
    name: "S&P Inclusion Predictor",
    kind: "Data Science",
    icon: ieIcon,
    event: "Laurier Data Minds 2026",
    award: "2nd Place",
    bullets: [
      "Developed an S&P 500 inclusion prediction model using a two-stage pipeline combining hard eligibility filters with multi-factor scoring",
      "Applied financial screening criteria including market capitalization, domicile, GAAP profitability, liquidity, trading volume, and public float to identify eligible candidate firms",
      "Built a scoring model using sector gap analysis, S&P MidCap 400 membership, profitability margin, market capitalization, and FinBERT-based news sentiment analysis",
      "Created a dashboard/demo to visualize candidate filtering, score breakdowns, and top-ranked predicted S&P 500 additions",
      "Backtested the model across 40 historical S&P inclusion events, with selected additions appearing in the model’s top 10 rankings 78% of the time",
      "Identified limitations and future improvements, including enhanced backtesting, automated weight optimization, and expanded NLP sentiment integration",
    ],
  },
  {
    name: "Deepfake Research Presentation",
    kind: "Research",
    icon: videoIcon,
    event: "Map the System 2026",
    award: "Finalist",
    bullets: [
      "Selected as a finalist for Map the System 2026 for a systems-thinking research project analyzing AI-powered deepfake sexual exploitation in North America",
      "Conducted research on non-consensual intimate-image deepfakes, focusing on technological accessibility, legal gaps, platform accountability, and gender-based harm",
      "Developed system maps, stakeholder maps, an Iceberg Model, and PESTEL analysis to identify root causes, reinforcing loops, and intervention points",
      "Proposed a three-pronged intervention strategy addressing legal reform, stakeholder collaboration, and public awareness through the Six Conditions of Systems Change framework",
      "Presented findings on deepfake NCII, including the role of AI accessibility, weak legal protections, and societal stigma in sustaining online exploitation",
    ],
  },
  {
    name: "Cloud Cost Budgeting Platform",
    kind: "Software",
    icon: ieIcon,
    event: "Magnet Forensics",
    bullets: [
      "Created a budgeting platform that integrated with current cloud cost collection practices to allow users to seamlessly budget cloud costs for the next year",
      "Provides users with a variety of automated forecasts based on trend analysis and moving averages based on current costs",
      "Allows users to export data in various formats to easily integrate with budget keeping practices and data analysis",
      "Leveraged AI solutions to streamline the development process and create a more intuitive user experience",
    ],
  },
  {
    name: "VLR API",
    kind: "Software",
    icon: ieIcon,
    bullets: [
      "Created an unofficial Valorant API for e-sports with easy access to a variety of data surrounding the game, including player stats, match history, kda and more",
    ],
  },
  {
    name: "MR Scraper",
    kind: "Web App",
    icon: helpIcon,
    link: { href: "/mr_scraper/", label: "Open MR Scraper" },
    bullets: [
      "Built a Marvel Rivals scouting tool that looks up a full enemy lineup and shows each player's competitive match history, current and peak rank, and most-played heroes overall and per objective mode",
      "Suggests bans by weighing the lineup's hero pools against the current ranked meta, with one-trick detection and a breakdown of how each score came about",
      "Pulls from two community stats APIs behind same-origin proxies with automatic fallback, caching, and rate-limit handling; built with Preact, TypeScript and Cloudflare Pages Functions",
    ],
  },
  {
    name: "Integrated Case Competition",
    kind: "Case Competition",
    icon: journalIcon,
    award: "Semi Finalist",
    bullets: [
      "Researched, analyzed and presented consumer purchasing and foot traffic trends in the Waterloo Region",
      "Strong quantitative analysis skills as showcased through statistical analysis & projection techniques to provide insight into current and future trends",
      "Presented data surrounding the feasibility, viability, and desirability in a clear, concise, and accurate PowerPoint",
    ],
  },
  {
    name: "Housing Market Predictor",
    kind: "Data Analysis",
    icon: journalIcon,
    event: "DataFest Hackathon 2025",
    award: "2nd Place",
    bullets: [
      "Researched, planned and presented insights surrounding the United States commercial real estate market",
      "Strong quantitative analysis skills as showcased through statistical analysis & projection techniques to provide insight into current and future trends",
      "Researched, collected, analyzed, and summarized information and trends surrounding the commercial real estate market in the United States",
    ],
  },
  {
    name: "Scouting App",
    kind: "Software",
    icon: ieIcon,
    bullets: [
      "Developed a scouting app for my robotics team to easily collect and analyze data on our own and our competitors' robots during competitions",
      "Simple UI & UX allowed for quick and efficient data collection during the fast paced environment of competitions, leading to better strategy decisions and improved robot performance",
    ],
  },
];

const EXPLORER_MENUS = ["File", "Edit", "View", "Favorites", "Tools", "Help"];
const PROJECTS_PATH = "C:\\Documents and Settings\\Rakshaa\\My Documents\\Projects";

/**
 * The projects window as a Windows XP Explorer folder: menu bar, a toolbar
 * whose Back / Forward / Up buttons work, an address bar, the blue task pane on
 * the left, and the projects as tiles. Opening a tile shows that project's
 * write-up in place, like opening a file.
 */
function ExplorerProjects({ openWindow }: { openWindow: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [forward, setForward] = useState<string | null>(null);
  const project = PROJECTS.find((p) => p.name === open) ?? null;
  const awards = PROJECTS.filter((p) => p.award).length;

  function openProject(name: string) {
    setOpen(name);
    setForward(null);
  }
  function back() {
    if (!open) return;
    setForward(open);
    setOpen(null);
  }

  const otherPlaces = [
    { label: "About Me", window: "about", icon: ieIcon },
    { label: "resume.doc", window: "notepad", icon: notepadIcon },
    { label: "Address Book", window: "contact", icon: contact },
  ];

  return (
    <div class="exp">
      <div class="exp-menu" aria-hidden="true">
        {EXPLORER_MENUS.map((m) => (
          <span key={m}>
            <u>{m[0]}</u>
            {m.slice(1)}
          </span>
        ))}
      </div>

      <div class="exp-toolbar">
        <button type="button" class="exp-tool" disabled={!open} onClick={back}>
          <span class="exp-arrow is-back" aria-hidden="true" /> Back
        </button>
        <button type="button" class="exp-tool" disabled={!forward || !!open} aria-label="Forward" onClick={() => forward && openProject(forward)}>
          <span class="exp-arrow is-forward" aria-hidden="true" />
        </button>
        <button type="button" class="exp-tool" disabled={!open} aria-label="Up" onClick={back}>
          <span class="exp-up" aria-hidden="true" />
        </button>
        <span class="exp-tool-sep" />
        <span class="exp-tool is-static" aria-hidden="true">
          <span class="exp-search-icon" /> Search
        </span>
        <span class="exp-tool is-static" aria-hidden="true">
          <img src={folderIcon} alt="" /> Folders
        </span>
      </div>

      <div class="exp-address">
        <span class="exp-address-label">
          A<u>d</u>dress
        </span>
        <span class="exp-address-box">
          <img src={open ? (project?.icon ?? folderIcon) : folderIcon} alt="" />
          <span>
            {PROJECTS_PATH}
            {project && `\\${project.name}`}
          </span>
        </span>
        <span class="exp-go" aria-hidden="true">
          <span class="exp-go-icon" /> Go
        </span>
      </div>

      <div class="exp-body">
        <aside class="exp-tasks">
          <section class="exp-task-box">
            <h4>File and Folder Tasks</h4>
            <ul aria-hidden="true">
              <li>Make a new folder</li>
              <li>Publish this folder to the Web</li>
              <li>Share this folder</li>
            </ul>
          </section>
          <section class="exp-task-box">
            <h4>Other Places</h4>
            <ul>
              {otherPlaces.map((o) => (
                <li key={o.label}>
                  <button type="button" onClick={() => openWindow(o.window)}>
                    <img src={o.icon} alt="" />
                    {o.label}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section class="exp-task-box">
            <h4>Details</h4>
            {project ? (
              <div class="exp-details">
                <b>{project.name}</b>
                <span>{project.kind}</span>
                {project.event && <span>{project.event}</span>}
                {project.award && <span class="exp-award">🏆 {project.award}</span>}
              </div>
            ) : (
              <div class="exp-details">
                <b>Projects</b>
                <span>File Folder</span>
                <span>
                  {PROJECTS.length} projects · {awards} awards
                </span>
              </div>
            )}
          </section>
        </aside>

        <section class="exp-main" aria-label={project ? project.name : "Projects"}>
          {project ? (
            <article class="exp-doc">
              <header class="exp-doc-head">
                <img src={project.icon} alt="" />
                <div>
                  <h3>{project.name}</h3>
                  <p>
                    {[project.kind, project.event, project.award].filter(Boolean).join(" · ")}
                  </p>
                </div>
              </header>
              <ul>
                {project.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              {project.link && (
                <a class="xp-button exp-doc-link" href={project.link.href} target="_blank" rel="noopener noreferrer">
                  {project.link.label} ↗
                </a>
              )}
            </article>
          ) : (
            <ul class="exp-tiles">
              {PROJECTS.map((p) => (
                <li key={p.name}>
                  <button type="button" class="exp-tile" onClick={() => openProject(p.name)}>
                    <img src={p.icon} alt="" />
                    <span class="exp-tile-text">
                      <span class="exp-tile-name">{p.name}</span>
                      <span>{p.kind}</span>
                      {(p.event || p.award) && <span>{[p.event, p.award].filter(Boolean).join(" · ")}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div class="exp-status">
        <span>{project ? `${project.bullets.length} items` : `${PROJECTS.length} objects`}</span>
        <span>{project ? "Click Back to return to Projects" : "Click a project to open it"}</span>
      </div>
    </div>
  );
}

function XPWindow({ title, children, onClose, onFocus, zIndex, contentClass }: WindowProps) {
  const isMobile = useIsMobile();
  const [pos, setPos] = useState({ x: 180, y: 100 });
  const [size, setSize] = useState({ w: 600, h: 520 });
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  function startDrag(e: MouseEvent) {
    if (isMobile) return;
    e.preventDefault();
    setDragging(true);
    setOffset({ x: e.clientX - pos.x, y: e.clientY - pos.y });
  }

  function startResize(e: MouseEvent) {
    if (isMobile) return;
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
  }

  useEffect(() => {
    function handleMove(e: MouseEvent) {
      if (dragging) {
        setPos({
          x: clamp(e.clientX - offset.x, 0, window.innerWidth - size.w),
          y: clamp(e.clientY - offset.y, 0, window.innerHeight - TASKBAR_H - 30),
        });
      }

      if (resizing) {
        setSize({
          w: Math.max(260, e.clientX - pos.x),
          h: Math.max(160, e.clientY - pos.y),
        });
      }
    }

    function stop() {
      setDragging(false);
      setResizing(false);
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", stop);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", stop);
    };
  }, [dragging, resizing, offset.x, offset.y, pos.x, pos.y, size.w]);

  return (
    <div
      class="xp-window"
      onMouseDown={onFocus}
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        width: `${size.w}px`,
        height: `${size.h}px`,
        zIndex: zIndex ?? 50,
      }}
    >
      <div class="xp-titlebar" onMouseDown={startDrag}>
        <span>{title}</span>
        <button class="xp-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div class={`xp-content ${contentClass ?? ""}`}>{children}</div>
      <div class="resize-handle" onMouseDown={startResize} />
    </div>
  );
}

export function App() {
  const [time, setTime] = useState(new Date());
  const [openWindows, setOpenWindows] = useState<WindowData[]>([]);
  const [showHelp, setShowHelp] = useState(true);
  const isMobile = useIsMobile();

  const [icons, setIcons] = useState<IconData[]>([
    { id: "folder", img: folderIcon, label: "projects", x: 0, y: 0 },
    { id: "about", img: ieIcon, label: "about me", x: 0, y: 0 },
    { id: "notepad", img: notepadIcon, label: "resume", x: 0, y: 0 },
    { id: "contact", img: contact, label: "contact info", x: 0, y: 0 },
    { id: "games", img: games, label: "games", x: 0, y: 0 }, 
    { id: "music", img: music, label: "music", x: 0, y: 0}
  ]);

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const mobile = window.innerWidth < 768;
    if (mobile) {
      setIcons((prev) =>
        prev.map((icon, i) => ({
          ...icon,
          x: 10 + (i % 2) * GRID_X,
          y: 10 + Math.floor(i / 2) * GRID_Y,
        }))
      );
      return;
    }
    const maxX = window.innerWidth - ICON_W;
    const maxY = window.innerHeight - TASKBAR_H - ICON_H;
    const occupied: Array<[number, number]> = [];

    setIcons((prev) =>
      prev.map((icon) => {
        const [x, y] = getRandomGridPosition(
          0,
          maxX,
          0,
          maxY,
          occupied
        );
        occupied.push([x, y]);
        return { ...icon, x, y };
      })
    );
  }, []);

  function moveIcon(id: string, rawX: number, rawY: number) {
    const maxX = window.innerWidth - ICON_W;
    const maxY = window.innerHeight - TASKBAR_H - ICON_H;

    let nextX = snap(rawX, GRID_X);
    let nextY = snap(rawY, GRID_Y);

    nextX = clamp(nextX, 0, maxX);
    nextY = clamp(nextY, 0, maxY);

    const occupied = icons.some(
      (icon) => icon.id !== id && icon.x === nextX && icon.y === nextY
    );

    if (occupied) return;

    setIcons((prev) =>
      prev.map((icon) =>
        icon.id === id ? { ...icon, x: nextX, y: nextY } : icon
      )
    );
  }

  function bringToFront(id: string) {
    setOpenWindows((prev) => {
      const existing = prev.find((w) => w.id === id);
      if (!existing) return prev;
      return [...prev.filter((w) => w.id !== id), existing];
    });
  }

  function openWindow(id: string) {
    const icon = icons.find((icon) => icon.id === id);
    if (!icon) return;

    setOpenWindows((prev) => {
      const existing = prev.find((w) => w.id === id);
      if (existing) {
        return [...prev.filter((w) => w.id !== id), existing];
      }
      return [...prev, { id, title: WINDOW_TITLES[id] ?? icon.label }];
    });
  }

  function closeWindow(id: string) {
    setOpenWindows((prev) => prev.filter((w) => w.id !== id));
  }

  function getWindowContent(id: string) {
    if (id === "folder") {
      return <ExplorerProjects openWindow={openWindow} />;
    }

    if (id === "about") {
      const nav: { label: string; window: string }[] = [
        { label: "Home", window: "about" },
        { label: "Projects", window: "folder" },
        { label: "Resume", window: "notepad" },
        { label: "Music", window: "music" },
        { label: "Games", window: "games" },
        { label: "Contact", window: "contact" },
      ];
      const contactLinks: { label: string; window: string }[] = [
        { label: "Send Message", window: "contact" },
        { label: "View Resume", window: "notepad" },
        { label: "See Projects", window: "folder" },
        { label: "Hear My Vinyl", window: "music" },
      ];
      const topGames = [
        { title: "Baldur's Gate 3", cover: bg3 },
        { title: "Elden Ring", cover: eldenRing },
        { title: "Counter-Strike 2", cover: cs2 },
        { title: "Stardew Valley", cover: stardewValley },
        { title: "Balatro", cover: balatro },
      ];
      return (
        <>
          {/* A mid-2000s social profile page, under Rakshaa's own handle. */}
          <div class="sp-top">
            <span class="sp-logo">
              SpaceRock<span>'s Space</span>
            </span>
            <nav class="sp-nav">
              {nav.map((n, i) => (
                <span key={n.label}>
                  {i > 0 && " | "}
                  <button type="button" onClick={() => openWindow(n.window)}>
                    {n.label}
                  </button>
                </span>
              ))}
            </nav>
          </div>

          <div class="sp-page">
            <div class="sp-left">
              <h2 class="sp-name">Rakshaa</h2>
              <div class="sp-intro">
                <div class="sp-photo" aria-label="No photo">
                  <svg viewBox="0 0 64 64" aria-hidden="true">
                    <circle cx="32" cy="23" r="12" />
                    <path d="M8 62c0-14 11-22 24-22s24 8 24 22z" />
                  </svg>
                </div>
                <div class="sp-intro-text">
                  <p>"building things :)"</p>
                  <p>
                    Waterloo,
                    <br />
                    Ontario
                    <br />
                    Canada
                  </p>
                  <p class="sp-online">
                    <span class="sp-online-dot" /> Online Now!
                  </p>
                </div>
              </div>
              <p class="sp-mood">
                <b>Mood:</b> creative 🎶
              </p>

              <div class="sp-box">
                <h3 class="sp-box-title">Contacting Rakshaa</h3>
                <div class="sp-contact-grid">
                  {contactLinks.map((c) => (
                    <button key={c.label} type="button" onClick={() => openWindow(c.window)}>
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>

              <div class="sp-box">
                <h3 class="sp-box-title">Rakshaa's Details</h3>
                <table class="sp-table">
                  <tbody>
                    <tr>
                      <th>Status:</th>
                      <td>Student</td>
                    </tr>
                    <tr>
                      <th>Studying:</th>
                      <td>BBA (Laurier) + Computer Science (Waterloo)</td>
                    </tr>
                    <tr>
                      <th>Instruments:</th>
                      <td>Piano, guitar, saxophone (alto, tenor &amp; soprano), trombone</td>
                    </tr>
                    <tr>
                      <th>Ensembles:</th>
                      <td>Jazz Band, Vocal Jazz Band, Senior Wind Ensemble &amp; Choir (high school)</td>
                    </tr>
                    <tr>
                      <th>Clubs:</th>
                      <td>Alpha Dogs Robotics, UW Marvel Rivals, Stats Club</td>
                    </tr>
                    <tr>
                      <th>Side quest:</th>
                      <td>Dungeon Master for friends</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="sp-right">
              <div class="sp-box">
                <h3 class="sp-box-title">About me:</h3>
                <div class="sp-blurb">
                  <p>
                    I’m a BBA + Computer Science student passionate about building useful, creative, and data-driven tools. My experience spans cloud FinOps, audit, and
                    software development, including work on budgeting platforms, AI chatbots, and cost-optimization projects. I like combining business thinking with
                    technical problem-solving to make systems cleaner, smarter, and easier to use.
                  </p>
                  <p>
                    Video games are what inspired me to pursue computer science in the first place! I also love music (consistently over 100,000 minutes on Spotify every
                    year lol), and I'm currently learning how to garden.
                  </p>
                  <p>
                    This portfolio is a playful way to share my projects and experience. Feel free to explore the icons, open the windows, and check out my resume and
                    contact info. I’m always excited to connect with new people, so don’t hesitate to reach out!
                  </p>
                </div>
              </div>

              <div class="sp-box">
                <h3 class="sp-box-title">Rakshaa's Interests</h3>
                <table class="sp-table">
                  <tbody>
                    <tr>
                      <th>General:</th>
                      <td>Video games, music, gardening, D&amp;D</td>
                    </tr>
                    <tr>
                      <th>Music:</th>
                      <td>Jazz, collecting vinyl, a little of everything</td>
                    </tr>
                    <tr>
                      <th>Games:</th>
                      <td>Baldur's Gate 3, Pokémon Pokopia, Counter-Strike, Elden Ring</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="sp-box">
                <h3 class="sp-box-title">Rakshaa's Top {topGames.length}</h3>
                <ul class="sp-top-grid">
                  {topGames.map((g) => (
                    <li key={g.title}>
                      <button type="button" onClick={() => openWindow("games")} title={g.title}>
                        <img src={g.cover} alt="" loading="lazy" />
                        <span>{g.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </>
      );
    }

    if (id === "notepad") {
      return (
        <>
          {/* Word 97 chrome: menu bar, formatting toolbar and ruler. All decorative. */}
          <div class="word-chrome" aria-hidden="true">
            <div class="word-menu">
              {WORD_MENUS.map((m) => (
                <span key={m} class="word-menu-item">
                  <u>{m[0]}</u>
                  {m.slice(1)}
                </span>
              ))}
            </div>
            <div class="word-toolbar">
              <span class="word-grip" />
              <span class="word-select is-style">Normal</span>
              <span class="word-select is-font">Times New Roman</span>
              <span class="word-select is-size">12</span>
              <span class="word-sep" />
              <span class="word-btn is-bold">B</span>
              <span class="word-btn is-italic">I</span>
              <span class="word-btn is-underline">U</span>
              <span class="word-sep" />
              <span class="word-btn word-align is-left is-pressed" />
              <span class="word-btn word-align is-center" />
              <span class="word-btn word-align is-right" />
              <span class="word-btn word-align is-justify" />
              <span class="word-sep" />
              <span class="word-btn word-bullets" />
            </div>
            <div class="word-ruler">
              <span class="word-ruler-track" />
            </div>
          </div>
          <div class="word-workspace">
          <div class="word-page">
          <h2>Resume</h2>

          <section>
            <hr />
            <h3>Education</h3>
              <div class="resume-entry">
                <div>
                  <strong>Wilfrid Laurier University · Bachelors of Business Administration (Co-op)</strong>
                  <div><i>Waterloo, ON</i></div>
                </div>
                <div class="resume-year">Sept 2022 - Present</div>
              </div>

            <div class="resume-entry">
                <div>
                  <strong>University of Waterloo · Bachelors of Computer Science</strong>
                  <div><i>Waterloo, ON</i></div>
                </div>
                <div class="resume-year">Sept 2022 - Present</div>
              </div>
          </section>

          <section>
            <hr />
            <h3>Skills</h3>

            <p>
              <strong>Languages:</strong> English (fluent), French (fluent) <br/>
              <strong>Programming: </strong> Python, Java, JavaScript, CSS, HTML, C++, C, LaTeX, SQL, Visual Basic <br/>
              <strong>Developer Tools: </strong> Git, Google Cloud Platform, Azure DevOps, Visual Studio, Eclipse, Android Studio, Jupyter, Streamlit <br/>
              <strong>Tools: </strong> Excel, Word, PowerPoint, Google Suite, Jira, Confluence, Tableau, Power BI, Canva, QuickBooks, Sage, Xero <br/>
              <strong>Communication Tools: </strong> Microsoft Teams, Jabber, Webex, Slack
            </p>

          </section>

          <section>
            <hr />
            <h3>Experience</h3>
              <div class="resume-entry">
                <div>
                  <strong>Manager for Marvel Rivals E-Sports Operations</strong>
                  <div><i>University of Waterloo Athletics Department</i></div>
                </div>
                <div class="resume-year">Sept 2026 - Present</div>
              </div>
              <div class="resume-bullets">
                <ul>
                  <li>
                    Organized tryouts and team building events, using a structured soft-skills rubric to standardize evaluation across evaluators and building team cohesion beyond scrims
                  </li>
                  <li>
                    Support players in balancing competitive commitments with their academic and work loads, planning practice schedules around their availability to prevent burnout
                  </li>
                  <li>
                    Built scouting tools that analyze opposing lineups' match histories to recommend bans and counter team comps from hero matchup data, informing strategy and comp building
                  </li>
                </ul>
              </div>

              <div class="resume-entry">
                <div>
                  <strong>Business Analyst</strong>
                  <div><i>Royal Bank of Canada</i></div>
                </div>
                <div class="resume-year">May 2026 - Aug 2026</div>
              </div>
              <div class="resume-bullets">
                <ul>
                  <li>
                    Analyzed marketing campaign performance to identify trends, performance drivers, and opportunities, and helped enhance campaign dashboards for ongoing KPI monitoring
                  </li>
                  <li>
                    Conducted A/B tests to evaluate campaign effectiveness and compare performance across customer groups
                  </li>
                  <li>
                    Led a term-long deep dive into an underperforming campaign, using Heterogeneous Treatment Effect (HTE) analysis and uplift modelling to pinpoint internal and external failure points and improve targeting
                  </li>
                  <li>
                    Presented findings and recommendations to campaign managers, senior management, and Vice Presidents to inform campaign strategy, targeting, and execution
                  </li>
                </ul>
              </div>

              <div class="resume-entry">
                <div>
                  <strong>Cloud FinOps (Co-op)</strong>
                  <div><i>Magnet Forensics</i></div>
                </div>
                <div class="resume-year">Sept 2025 - Dec 2025</div>
              </div>
              <div class="resume-bullets">
                <ul>
                  <li>
                    Built a custom cloud budgeting platform that generated cost forecasts, enabled user-driven edits, and supported budget exports to streamline financial planning
                  </li>
                  <li>
                    Saved Magnet Forensics over $300,000 in cloud costs annually by identifying, recommending and implementing cloud cost-optimization opportunities
                  </li>
                  <li>
                    Developed and managed a $14M cloud budget for FY26, including creation of budgeting frameworks and financial projections
                  </li>
                  <li>
                    Collaborated and communicated regularly with major stakeholders to present budget updates, cloud spend insights, and cost-saving recommendations
                  </li>
                  <li>
                    Refined FinOps workflows, such as weekly cost reviews and anomaly alerting processes
                  </li>
                </ul>
              </div>


              <div class="resume-entry">
                <div>
                  <strong>Audit Intern (Co-op)</strong>
                  <div><i>Norton McMullen Corporate Finance</i></div>
                </div>
                <div class="resume-year">Jan 2025 - Apr 2025</div>
              </div>
              <div class="resume-bullets">
                <ul>
                  <li>
                    Completed audits, from initial client engagement to filing taxes, for both not-for-profit and for profit organizations
                  </li>
                  <li>
                    Ensured audit workpapers were accurate and compliant by reconciling documents to the general ledger and investigating variances
                  </li>
                  <li>
                    Superior time management, organizational, prioritization and multitasking skills were enhanced by managing multiple clients in a fast paced and dynamic environment
                  </li>
                  <li>
                    Excellent written and verbal communication skills were strengthened through client communications throughout the audit process
                  </li>
                </ul>
              </div>

              <div class="resume-entry">
                <div>
                  <strong>Vice President of Finance</strong>
                  <div><i>University of Waterloo Statistics Club</i></div>
                </div>
                <div class="resume-year">May 2024 - Apr 2026</div>
              </div>
              <div class="resume-bullets">
                <ul>
                  <li>
                    Developed and managed the club's budget throughout the semester
                  </li>
                  <li>
                    Developed and implemented a comprehensive marketing plan that saw a 1100% boost in club engagement
                  </li>
                  <li>
                    Coordinated with 4 sub-teams to ensure the completion of projects with competing deadlines from initiation to completion within budget, timeline, and scope
                  </li>
                  <li>
                    Completed a yearly financial audit and analysis to provide insight into club activities to help plan future events to maximize potential club revenues
                  </li>
                </ul>
              </div>

              <div class="resume-entry">
                <div>
                  <strong>Software Developer (Co-op)</strong>
                  <div><i>Connex Telecommunications</i></div>
                </div>
                <div class="resume-year">Jan 2024 - Apr 2024</div>
              </div>
              <div class="resume-bullets">
                <ul>
                  <li>
                    Made recommendations to address gaps within current programs and implemented these recommendations
                  </li>
                  <li>
                    Superior time management, strong organizational, prioritization and multitasking skills were enhanced by managing multiple projects throughout the fast-paced and entrepreneurial environment
                  </li>
                  <li>
                    Detail oriented, analytical and logical, showcased through the thorough testing and debugging of both the front end and the back end of multiple AI powered chat bots
                  </li>
                  <li>
                    Self-motivated and quick learner shown through learning multiple different Contact Center Artificial Intelligence technologies quickly and performed in a fast-paced, entrepreneurial environment
                  </li>
                </ul>
              </div>

              <hr/>
            <div class="resume-entry">
                <div>
                  <strong>Programming Lead</strong>
                  <div><i>Alpha Dogs FIRST Robotics Team</i></div>
                </div>
                <div class="resume-year">Sept 2018 - Jun 2022</div>
              </div>
            <div class="resume-bullets">
              <ul>
                <li>
                  Utilized strong oral and written communication skills to develop sponsorship presentations and reports to firms such as Canadian Tire and Husky with a 100% success rate in securing funds
                </li>
                <li>
                  Developed, coordinated and managed an outreach program giving students the opportunity to learn basic STEM skills through delivering a lecture for a robotics convention
                </li>
                <li>
                  Worked cross-functionally across teams to ensure that robot programming matched designs
                </li>
                <li>
                  Led programming team meetings to provide project updates, feedback and planned team workflows to ensure a completed robot at the end of the build season
                </li>
                <li>
                  Planned, developed and implemented a comprehensive Java programming training on object-oriented programming and data structures for high school students on the robotics team
                </li>
                <li>
                  Provided strategy decisions for competitions based on the analysis of data for over 200 matches along with solid judgment and intuition
                </li>
                <li>
                  Result-focused, with a drive to produce high quality work shown through the team's consistent placement within the top 20 FIRST Robotics Teams in Canada and three appearances at the FIRST Robotics World Championship
                </li>
              </ul>
            </div>

            <div class="resume-entry">
                <div>
                  <strong>Vice President</strong>
                  <div><i>Music Activity Council</i></div>
                </div>
                <div class="resume-year">Sept 2018 - Jun 2022</div>
              </div>
            <div class="resume-bullets">
              <ul>
                <li>
                  Planned, organized, and managed a music competition project from initiation to completion within budget, timelines, scope and resources
                </li>
                <li>
                  Participated, contributed, and created events for and initiatives to support the music community
                </li>
                <li>
                  Supported the development of an equitable, diverse and inclusive community
                </li>
              </ul>
            </div>
          </section>
          <span class="word-caret" aria-hidden="true" />
          </div>
          </div>
          <div class="word-status" aria-hidden="true">
            <span>Page 1</span>
            <span>Sec 1</span>
            <span>1/1</span>
            <span class="word-status-grow">At 1"   Ln 1   Col 1</span>
            <span class="is-dim">REC</span>
            <span class="is-dim">TRK</span>
            <span class="is-dim">EXT</span>
            <span class="is-dim">OVR</span>
          </div>
        </>
      );
    }

    if (id === "contact") {
      return (
        <>
          {/* Windows 98 Address Book contact card. The tabs other than Summary are decorative. */}
          <div class="card-tabs" aria-hidden="true">
            {CARD_TABS.map((t, i) => (
              <span key={t} class={`card-tab ${i === 0 ? "is-active" : ""}`}>
                {t}
              </span>
            ))}
          </div>
          <div class="card-panel">
            <div class="card-head">
              <span class="card-photo">
                <img src={contact} alt="" />
              </span>
              <div>
                <h2 class="card-name">Rakshaa Jeyarajah</h2>
                <p class="card-aka">a.k.a. SpaceRock</p>
                <p class="card-role">Computer Science &amp; Business student · Waterloo, ON</p>
              </div>
            </div>

            <div class="card-group">
              <p class="card-group-title">Summary of information about this contact</p>
              <dl class="card-fields">
                {CONTACT_FIELDS.map((f) => (
                  <div class="card-field" key={f.label}>
                    <dt>{f.label}:</dt>
                    <dd class="card-box">
                      {f.href ? (
                        <a href={f.href} target="_blank" rel="noopener noreferrer">
                          {f.value}
                        </a>
                      ) : (
                        f.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            <div class="card-actions">
              <a class="xp-button card-button" href="mailto:rakshaajeyarajah@gmail.com">
                <u>S</u>end Mail
              </a>
              <a class="xp-button card-button" href="https://www.linkedin.com/in/rakshaa-jeyarajah-880427250/" target="_blank" rel="noopener noreferrer">
                <u>C</u>onnect
              </a>
            </div>
          </div>
        </>
      );
    }

    if (id === "music") {
      const [records, setRecords] = useState<MyRecord[]>([]);
      const [loadFailed, setLoadFailed] = useState(false);

      useEffect(() => {
        // Public Discogs collection: no API key needed, and the API allows cross-origin requests
        fetch('https://api.discogs.com/users/SP4CER0CK/collection/folders/0/releases?per_page=100&sort=added&sort_order=desc')
          .then((response) => {
            if (!response.ok) {
              throw new Error('Network response was not ok');
            }
            return response.json();
          })
          .then((data: any) => {
            const extractedRecords: MyRecord[] = data.releases
              .filter((release: any) => release.basic_information.formats.some((format: any) => format.name === 'Vinyl'))
              .map((release: any) => ({
                id: release.id,
                title: release.basic_information.title,
                // Discogs disambiguates artists with the same name as "Name (2)", so strip that
                artist: release.basic_information.artists.map((artist: any) => artist.name.replace(/ \(\d+\)$/, '')).join(', '),
                year: release.basic_information.year,
                cover: release.basic_information.cover_image
              }));

            // Shuffle (Fisher-Yates) so the player starts on a different record each time the window opens.
            for (let i = extractedRecords.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [extractedRecords[i], extractedRecords[j]] = [extractedRecords[j], extractedRecords[i]];
            }
            setRecords(extractedRecords);
          })
          .catch((error) => {
            console.error('Error fetching Discogs collection:', error);
            setLoadFailed(true);
          });
      }, []);

      return <VinylPlayer records={records} status={loadFailed ? "error" : records.length ? "ready" : "loading"} />;
    }

    if (id === "games") {
      return <SteamLibrary />;
    }

    return <p>Empty window</p>;
  }

  return (
    <main class="page">
      <div class="desktop">
        {icons.map((icon) => (
          <DraggableIcon
            key={icon.id}
            id={icon.id}
            img={icon.img}
            label={icon.label}
            x={icon.x}
            y={icon.y}
            onMove={moveIcon}
            onClick={() => openWindow(icon.id)}
          />
        ))}

        {openWindows.map((win, index) => (
          <XPWindow
            key={win.id}
            title={win.title}
            onClose={() => closeWindow(win.id)}
            onFocus={() => bringToFront(win.id)}
            zIndex={100 + index}
            contentClass={WINDOW_CONTENT_CLASS[win.id]}
          >
            {getWindowContent(win.id)}
          </XPWindow>
        ))}
      </div>

      {showHelp ? (
        <div id="help" class="help-overlay" onClick={() => setShowHelp(false)}>
          <div class="help-popup" onClick={(e) => e.stopPropagation()}>
            <div class="help-header">
              <h2>Welcome Rakshaa's Dev Portfolio!</h2>
              <button class="help-close" onClick={() => setShowHelp(false)}>
                ×
              </button>
            </div>

            <div class="help-body">
              <p>Use the icons on the desktop to open windows.</p>
              {isMobile ? (
                <ul>
                  <li>Tap an icon to open its associated window</li>
                  <li>Use the taskbar buttons to switch between windows</li>
                  <li>Every window has an icon in the taskbar at the bottom</li>
                </ul>
              ) : (
                <ul>
                  <li>Drag icons to move them around the desktop</li>
                  <li>Click an icon to open its associated window</li>
                  <li>Use the taskbar buttons to reopen windows</li>
                  <li>Resize and drag windows by using the title bar and corner handle</li>
                </ul>
              )}
              <p>Click the close button or anywhere outside this box to dismiss.</p>
            </div>
          </div>
        </div>
      ) : null}

      <div class="taskbar">
        <button class="start-button">
          <span class="start-icon"></span>
          My Portfolio
        </button>

        <div class="taskbar-tasks">
          {/* On phones every window gets a button, shown icon-only so all of them fit on screen. */}
          {(isMobile ? icons : icons.slice(0, 4)).map((icon) => (
            <button
              class="task-button"
              key={icon.id}
              aria-label={icon.label}
              title={icon.label}
              onClick={() => openWindow(icon.id)}
            >
              <span>
                <img src={icon.img} class="icon" alt="" />
              </span>
              <span class="task-label">{icon.label}</span>
            </button>
          ))}
        </div>

        <div class="taskbar-spacer" />

        <div class="clock">
          {time.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>

      <div class="static" />
      <div class="scanlines" />
    </main>
  );
}