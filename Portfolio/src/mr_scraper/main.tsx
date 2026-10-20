import { render } from "preact";
import { MrScraper } from "./app.tsx";
import { closeHoverCardsOnOutsideTap } from "../shared/touch.ts";
import "./mr_scraper.css";

closeHoverCardsOnOutsideTap();
render(<MrScraper />, document.getElementById("app")!);
