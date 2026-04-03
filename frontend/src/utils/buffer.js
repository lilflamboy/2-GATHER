/**
 * Browser media-buffer helpers used by the room sync heuristics. "Buffered
 * ahead" means how many seconds of playable media are already available beyond
 * the current playback position, which helps the server detect buffering peers.
 */

/**
 * Returns how many seconds of media are buffered ahead of the current time.
 * It walks the HTMLMediaElement `TimeRanges` collection to find the buffered
 * range that covers the current playback point, or a range that starts just
 * ahead of it, then returns the gap between `end` and the current time.
 * @param {HTMLMediaElement | null | undefined} media - Media element whose buffered ranges should be inspected.
 * @returns {number} Buffered-ahead seconds used for sync wait comparisons.
 */
const getBufferedAheadSeconds = (media) => {
  if (!media || !media.buffered || media.buffered.length === 0) return 0;
  const now = Math.max(0, Number(media.currentTime) || 0);
  // Find the buffered segment that currently covers playback, or one that starts almost immediately after it.
  for (let i = 0; i < media.buffered.length; i += 1) {
    const start = Number(media.buffered.start(i)) || 0;
    const end = Number(media.buffered.end(i)) || 0;
    if (now >= start && now <= end) {
      return Math.max(0, end - now);
    }
    if (start > now && start - now <= 0.35) {
      return Math.max(0, end - now);
    }
  }
  return 0;
};

export { getBufferedAheadSeconds };
