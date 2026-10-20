import { render } from "preact";
import { ValScraper } from "./app.tsx";
import { closeHoverCardsOnOutsideTap } from "../shared/touch.ts";
import "./val_scraper.css";

closeHoverCardsOnOutsideTap();
render(<ValScraper />, document.getElementById("app")!);
