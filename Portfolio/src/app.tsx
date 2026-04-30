import { useState, useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";

import ieIcon from "./assets/desktop/System Information.png";
import folderIcon from "./assets/desktop/My Documents.png";
import notepadIcon from "./assets/desktop/Generic Text Document.png";
import contact from "./assets/desktop/Search for people.png";
import music from "./assets/desktop/My Music.png";
import games from "./assets/desktop/Game Controller.png";

import bg3 from "./assets/games/bg3.jpg";
import stardewValley from "./assets/games/stardewValley.png";
import cs2 from "./assets/games/Cs2.jpg";
import eldenRing from "./assets/games/eldenRing.jpg";
import balatro from "./assets/games/balatro.jpg";

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
};

function XPWindow({ title, children, onClose, onFocus, zIndex }: WindowProps) {
  const [pos, setPos] = useState({ x: 180, y: 100 });
  const [size, setSize] = useState({ w: 520, h: 520 });
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  function startDrag(e: MouseEvent) {
    e.preventDefault();
    setDragging(true);
    setOffset({ x: e.clientX - pos.x, y: e.clientY - pos.y });
  }

  function startResize(e: MouseEvent) {
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

      <div class="xp-content">{children}</div>
      <div class="resize-handle" onMouseDown={startResize} />
    </div>
  );
}

export function App() {
  const [time, setTime] = useState(new Date());
  const [openWindows, setOpenWindows] = useState<WindowData[]>([]);
  const [showHelp, setShowHelp] = useState(true);

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
      return [...prev, { id, title: icon.label }];
    });
  }

  function closeWindow(id: string) {
    setOpenWindows((prev) => prev.filter((w) => w.id !== id));
  }

  function getWindowContent(id: string) {
    if (id === "folder") {
      return (
        <>
          <h2>Projects</h2>
          <hr/>
            <div class="resume-entry">
            <div>
              <h3>S&P Inclusion Predictor (Laurier Data Minds 2026) - 2nd Place</h3>
            </div>
            </div>
            <div class="resume-bullets">
              <ul>
                <li>
                  Developed an S&P 500 inclusion prediction model using a two-stage pipeline combining hard eligibility filters with multi-factor scoring
                </li>
                <li>
                  Applied financial screening criteria including market capitalization, domicile, GAAP profitability, liquidity, trading volume, and public float to identify eligible candidate firms
                </li>
                <li>
                  Built a scoring model using sector gap analysis, S&P MidCap 400 membership, profitability margin, market capitalization, and FinBERT-based news sentiment analysis
                </li>
                <li>
                  Created a dashboard/demo to visualize candidate filtering, score breakdowns, and top-ranked predicted S&P 500 additions
                </li>
                <li>
                  Backtested the model across 40 historical S&P inclusion events, with selected additions appearing in the model’s top 10 rankings 78% of the time
                </li>
                <li>
                  Identified limitations and future improvements, including enhanced backtesting, automated weight optimization, and expanded NLP sentiment integration
                </li>
              </ul>
            </div>

          <hr/>
            <div class="resume-entry">
            <div>
              <h3>Deepfake Research Presentation (Map the System 2026) - Finalist</h3>
            </div>
            </div>
            <div class="resume-bullets">
              <ul>
                <li>
                  Selected as a finalist for Map the System 2026 for a systems-thinking research project analyzing AI-powered deepfake sexual exploitation in North America
                </li>
                <li>
                  Conducted research on non-consensual intimate-image deepfakes, focusing on technological accessibility, legal gaps, platform accountability, and gender-based harm
                </li>
                <li>
                  Developed system maps, stakeholder maps, an Iceberg Model, and PESTEL analysis to identify root causes, reinforcing loops, and intervention points
                </li>
                <li>
                  Proposed a three-pronged intervention strategy addressing legal reform, stakeholder collaboration, and public awareness through the Six Conditions of Systems Change framework
                </li>
                <li>
                  Presented findings on deepfake NCII, including the role of AI accessibility, weak legal protections, and societal stigma in sustaining online exploitation
                </li>
              </ul>
            </div>

          <hr/>
            <div class="resume-entry">
            <div>
              <h3>Cloud Cost Budgeting Platform for Magnet Forensics</h3>
            </div>
            </div>
            <div class="resume-bullets">
              <ul>
                <li>
                  Created a budgeting platform that integrated with current cloud cost collection practices to allows users to seamlessly budget cloud costs for the next year
                </li>
                <li>
                  Provides users with a variety of automated forecasts based on trend analysis and moving averages based on current costs
                </li>
                <li>
                  Allows users to export data to in various formats to easily integrate with budget keeping practices and data analysis
                </li>
                <li>
                  Leveraged AI solutions to streameline the development process and create a more intuitive user experience
                </li>
              </ul>
            </div>

            <hr/>
            <div class="resume-entry">
            <div>
              <h3>Integrated Case Competition - Semi Finalist</h3>
            </div>
            </div>
            <div class="resume-bullets">
              <ul>
                <li>
                  Researched, analyzed and presented consumer purchasing and foot traffic trends in the Waterloo Region
                </li>
                <li>
                  Strong quantitative analysis skills as showcased through statistical analysis & projection techniques to provide insight into current and future trends
                </li>
                <li>
                  Presented data surrounding the feasibility, viability, and desirability in a clear, concise, and accurate PowerPoint
                </li>
              </ul>
            </div>
            
            <hr/>
            <div class="resume-entry">
            <div>
              <h3>Housing Market Predictor (DataFest Hackathon 2025) - 2nd Place</h3>
            </div>
            </div>
            <div class="resume-bullets">
              <ul>
                <li>
                  Researched, planned and presented insights surrounding the United States commercial real estate market
                </li>
                <li>
                  Strong quantitative analysis skills as showcased through statistical analysis & projection techniques to provide insight into current and future trend
                </li>
                <li>
                  Researched, collected, analyzed, and summarized information and trends surrounding the commercial real estate market in the United States
                </li>
              </ul>
            </div>
            <br/>
        </>
      );
    }

    if (id === "about") {
      return (
        <>
          <h2>Hi, I'm Rakshaa!</h2>
          <h3>Welcome to my desktop!</h3>
          <p>
            I’m a BBA + Computer Science student passionate about building useful, creative, and data-driven tools. My experience spans cloud FinOps, audit, and software development, including work on budgeting platforms, AI chatbots, and cost-optimization projects. I like combining business thinking with technical problem-solving to make systems cleaner, smarter, and easier to use.
          </p>
          <p>
            Outside of school & work I have a variety of hobbies and interests. 
            One of my big ones is playing video games, which is what inspired me to pursue computer science in the first place! 
            Some of my favourite games include Baulders Gate 3, Pokemon Pokopia, Counter Strike and Elden Ring. 
            Additionally, I love music (consistently get over 100,000 hours on spotify every year lol) and play the piano, guitar, saxophone(alto, tenor & soprano) and trombone. 
            Due to my love for music, I was part of a Jazz Band, Vocal Jazz Band, Senior Wind Ensemble & Choir throughout high school. 
            I'm also currently learning how to garden & started as a Dungeon Master for my friends which has been a fun yet tough learning experience so far! 
          </p>
          <p>
            This portfolio is a playful way to share my projects and experience. Feel free to explore the icons, open the windows, and check out my resume and contact info. I’m always excited to connect with new people, so don’t hesitate to reach out!
          </p>
          <button class="xp-button" onClick={() => openWindow("contact")}> 
            Contact Me
          </button>
        </>
      );
    }

    if (id === "notepad") {
      return (
        <>
          <h2>Resume</h2>

          <section>
            <hr />
            <h3>Skills</h3>
            
            <p>
              <strong>Languages:</strong> English (fluent), French (fluent) <br/>
              <strong>Programming: </strong> Python, Java, JavaScript, R, C++, C, LaTeX, CSS, TypeScript <br/>
              <strong>Tools: </strong> Excel, Word, PowerPoint, Jira, Confluence, Azure DevOps, Tableau, PowerBI, Git
            </p>
            
          </section>

          <section>
            <hr />
            <h3>Experience</h3>
              <div class="resume-entry">
                <div>
                  <strong>Cloud Fin-Ops (Co-op)</strong>
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
              <br/>
          </section>
        </>
      );
    }

    if (id === "contact") {
      return (
        <>
          <h2>Contact Me!</h2>
          <p>Email: 
            <a href={"mailto:rakshaajey@gmail.com"} target="_blank" rel="noopener noreferrer">
              rakshaajey@gmail.com
            </a>
          </p>
          <p>LinkedIn: 
            <a href={"https://www.linkedin.com/in/rakshaa-jeyarajah-880427250/"} target="_blank" rel="noopener noreferrer">
              Rakshaa Jeyarajah
            </a>
          </p>
          <p>X/Twitter: 
            <a href={"https://x.com/sp4cer0ck?s=21&t=tc9N0VsXk2wx8TYMiyL5LQ"} target="_blank" rel="noopener noreferrer">
              SpaceRock
            </a>
          </p>
          <p>GitHub: 
            <a href={"https://github.com/rakshaaJey"} target="_blank" rel="noopener noreferrer">
              RakshaaJey
            </a>
          </p>
        </>
      );
    }

    if (id === "music") {
      interface MySong {
        title: string;
        artist: string;
        album: string;
        cover: string;
      }
      
      const [songs, setSongs] = useState<MySong[]>([]);
      
      useEffect(() => {
        fetch('topTracks.json')
          .then((response) => {
            if (!response.ok) {
              throw new Error('Network response was not ok');
            }
            return response.json();
          })
          .then((data: any[]) => {
            // Extract the desired fields from the Spotify API response
            const extractedSongs: MySong[] = data.map(track => ({
              title: track.name,
              artist: track.artists.map((artist: any) => artist.name).join(', '),
              album: track.album.name,
              cover: track.album.images[0]?.url || ''
            }));
            
            // Randomly select 5 songs from the 20
            const shuffled = extractedSongs.sort(() => 0.5 - Math.random());
            const selectedSongs = shuffled.slice(0, 5);
            
            setSongs(selectedSongs);
          })
          .catch((error) => {
            console.error('Error reading JSON file:', error);
          });
      }, []);
      
      return (
        <>
          <h2>What I'm Listening To</h2>
          <hr/>
          <p>I listen to a wide variety of music so here are some songs that I have on repeat!</p>
          <div class="music-list">
            {songs.map((song, index) => (
              <div class="music-row" key={index}>
                <img src={song.cover} class="music-cover" />

                <div class="music-info">
                  <div class="music-title">{song.title}</div>
                  <div class="music-subtitle">
                    {song.artist} · {song.album}
                  </div>
                </div>

                <button class="music-more">...</button>
              </div>
            ))}
          </div>
          
        </>
      );
    }

    if (id === "games") {
      const games = [
        {
          title: "Baulder's Gate 3",
          hoursPlayed: "650+",
          achievements: "50/54",
          cover: bg3,
        },
        {
          title: "Stardew Valley",
          hoursPlayed: "250+",
          achievements: "30/49",
          cover: stardewValley,
        },
        {
          title: "Counter-Strike 2",
          hoursPlayed: "160+",
          achievements: "1/1",
          cover: cs2,
        },
        {
          title: "Elden Ring",
          hoursPlayed: "160+",
          achievements: "25/42",
          cover: eldenRing,
        },
        {
          title: "Balatro",
          hoursPlayed: "100+",
          achievements: "27/31",
          cover: balatro,
        },
        
      ];
      return (
        <>
          <h2>What I'm Playing</h2>
          <hr/>
          <p>I play a wide variety of games (but my favourites are RPGs, strategy games, and cozy games!)</p>
          <div class="music-list">
            {games.map((games) => (
              <div class="music-row" key={games.title}>
                <img src={games.cover} class="music-cover" />

                <div class="music-info">
                  <div class="music-title">{games.title}</div>
                  <div class="music-subtitle">
                    Hours Played: {games.hoursPlayed} · {games.achievements} achievements unlocked
                  </div>
                </div>

                <button class="music-more">...</button>
              </div>
            ))}
          </div>
          
        </>
      );
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
              <ul>
                <li>Drag icons to move them around the desktop</li>
                <li>Click an icon to open its associated window</li>
                <li>Use the taskbar buttons to reopen windows</li>
                <li>Resize and drag windows by using the title bar and corner handle</li>
              </ul>
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

        {icons.slice(0, 4).map((icon) => (
          <button
            class="task-button"
            key={icon.id}
            onClick={() => openWindow(icon.id)}
          >
            <span>
              <img src={icon.img} class="icon" />
            </span>
            {icon.label}
          </button>
        ))}

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