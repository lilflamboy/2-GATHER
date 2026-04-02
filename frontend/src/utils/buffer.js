const getBufferedAheadSeconds = (media) => {
  if (!media || !media.buffered || media.buffered.length === 0) return 0;
  const now = Math.max(0, Number(media.currentTime) || 0);
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
