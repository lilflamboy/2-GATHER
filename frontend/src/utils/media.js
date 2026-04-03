/**
 * Media-formatting helpers used by the room player, dashboard summaries, and
 * other UI surfaces that need compact duration strings.
 */

/**
 * Formats a duration in seconds as `h:mm:ss` or `m:ss`.
 * @param {number} s - Duration in seconds.
 * @returns {string} Clock-style duration string for playback UI.
 */
const fmt = (s) => {
  if (!s || isNaN(s)) return "0:00";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

/**
 * Formats a duration in seconds as a human-readable summary such as `1h 30m`.
 * Unlike `fmt`, this favors readable labels over precise playback clocks.
 * @param {number} seconds - Duration in seconds.
 * @returns {string} Human-readable duration label for cards and summaries.
 */
const formatDurationLabel = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

export { fmt, formatDurationLabel };
