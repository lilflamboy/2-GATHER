import WatchEngine from "./WatchEngine.js";
import PodcastEngine from "./PodcastEngine.js";
import MusicEngine from "./MusicEngine.js";
import ReadingEngine from "./ReadingEngine.js";
import LiveEngine from "./LiveEngine.js";

// The rest of the app asks for an engine by session mode and never needs to
// know which concrete module implements that mode's validation/UI contract.
const engineByMode = Object.freeze({
  watch: WatchEngine,
  podcast: PodcastEngine,
  music: MusicEngine,
  reading: ReadingEngine,
  study: LiveEngine,
});

export const getSessionEngine = mode => engineByMode[String(mode || "").trim().toLowerCase()] || WatchEngine;

// Export the raw engine registry too for any screens that want to render all
// supported modes or inspect engine metadata directly.
export const SESSION_ENGINES = Object.freeze({
  WatchEngine,
  PodcastEngine,
  MusicEngine,
  ReadingEngine,
  LiveEngine,
});
