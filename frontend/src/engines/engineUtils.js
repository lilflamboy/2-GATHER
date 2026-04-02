export const normalizeUrl = value => {
  // Normalize "human pasted" links into a URL shape the engines can validate.
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^(?:www\.)?(?:m\.)?(?:youtube\.com|youtu\.be)\b/i.test(raw)) {
    return `https://${raw}`;
  }
  return raw;
};

export const isHttpUrl = value => /^https?:\/\/\S+$/i.test(normalizeUrl(value));

export const isYoutubeUrl = value => /youtu\.?be|youtube\.com/i.test(normalizeUrl(value));

export const isPdfUrl = value => /\.pdf(\?|#|$)/i.test(normalizeUrl(value));

export const isDocumentUrl = value => /\.(pdf|doc|docx|txt)(\?|#|$)/i.test(normalizeUrl(value));

export const isDirectMediaUrl = value => /\.(mp4|webm|ogg|m3u8|mp3|wav|aac|m4a)(\?|#|$)/i.test(normalizeUrl(value));

export const extractYouTubeId = value => {
  // Support plain IDs, youtu.be links, standard watch URLs, embeds, shorts,
  // and live URLs so every engine shares the same YouTube parsing rules.
  const raw = normalizeUrl(value);
  if (!raw) return "";
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();

    if (host === "youtu.be") {
      const id = (url.pathname || "").split("/").filter(Boolean)[0] || "";
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : "";
    }

    if (host.endsWith("youtube.com")) {
      const byQuery = url.searchParams.get("v") || "";
      if (/^[a-zA-Z0-9_-]{11}$/.test(byQuery)) return byQuery;

      const parts = (url.pathname || "").split("/").filter(Boolean);
      if (parts.length >= 2 && ["embed", "shorts", "live", "v"].includes(parts[0])) {
        return /^[a-zA-Z0-9_-]{11}$/.test(parts[1]) ? parts[1] : "";
      }
    }
  } catch {
    return "";
  }

  return "";
};

export const detectYouTubeVideoId = value => extractYouTubeId(value);

export const buildYoutubeEmbedUrl = value => {
  const id = extractYouTubeId(value);
  if (!id) return "";
  return `https://www.youtube.com/watch?v=${id}`;
};

export const clampContentType = (value, fallback = "unknown") => {
  // Engines may infer content types differently, but the rest of the UI only
  // accepts values from this shared allow-list.
  const raw = String(value || "").trim().toLowerCase();
  const allowed = new Set(["local", "youtube", "netflix", "prime", "disney", "ott", "pdf", "document", "unknown"]);
  if (allowed.has(raw)) return raw;
  return allowed.has(fallback) ? fallback : "unknown";
};
