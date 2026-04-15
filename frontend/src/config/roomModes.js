/**
 * Static room and session mode metadata for the frontend. These display models
 * live here so the lobby and room views can render the same labels, icons,
 * hints, and preset content without duplicating the definitions inline.
 */

import {
  Heart, Users, Headphones,
  BookOpen, GraduationCap,
} from "lucide-react";
import LumiereLogoMark from "../components/LumiereLogoMark.jsx";

// Private room modes describe the social shape of a room. `roomType` maps to
// the backend room model, while `maxParticipants` controls how many members the
// UI asks the server to allow when creating that room.
const PRIVATE_ROOM_MODES = [
  // Couple mode maps to the backend `duo` room type for two-person private sessions.
  {
    key: "couple",
    label: "Couple mode",
    roomType: "duo",
    maxParticipants: 2,
    icon: Heart,
    blurb: "Designed for two. Deep sync + private analytics.",
    hoverHint: "Best for late-night movies, anniversaries, and memory timelines.",
  },
  // Best-friend mode still uses the backend `friends` type, but caps the room at two people.
  {
    key: "best_friend",
    label: "Best-friend mode",
    roomType: "friends",
    maxParticipants: 2,
    icon: Users,
    blurb: "Invite-only room for you and one friend.",
    hoverHint: "Fast reactions, inside jokes, and replayed highlights.",
  },
  // Family mode maps to the backend `family` type and expands capacity for household-size rooms.
  {
    key: "family",
    label: "Family room mode",
    roomType: "family",
    maxParticipants: 8,
    icon: Users,
    blurb: "Invite your close family circle.",
    hoverHint: "Shared room for watch nights, classes, and reading circles.",
  },
];

// Session modes choose the engine and interaction model for the room: watch
// for video sync, music/podcast for shared audio, reading for PDFs, and study
// for host-led focus sessions.
const SESSION_MODES = [
  { key: "watch", label: "Watch", icon: LumiereLogoMark, blurb: "Movies, shows, and videos in sync.", hoverHint: "Classic watch-party mode with reactions and timestamps." },
  { key: "music", label: "Music mode", icon: Headphones, blurb: "Turn devices into synchronized speakers.", hoverHint: "Schedule playback across local audio, YouTube, and podcast links." },
  { key: "podcast", label: "Podcast sync", icon: Headphones, blurb: "Listen together with synced playback.", hoverHint: "Paste YouTube or audio links and discuss in real time." },
  { key: "reading", label: "Co-reading", icon: BookOpen, blurb: "Read and discuss page-by-page moments.", hoverHint: "Paste a PDF/doc link and annotate key moments together." },
  { key: "study", label: "Study session", icon: GraduationCap, blurb: "Live class-style focus rooms.", hoverHint: "Host-led sessions: teacher explains, students ask and track progress." },
];

// Mood tags are optional labels users attach to a room so the lobby and later
// session history can reflect the intended vibe of that shared time.
const ROOM_MOOD_OPTIONS = [
  { key: "", label: "No mood" },
  { key: "chill", label: "Chill" },
  { key: "romantic", label: "Romantic" },
  { key: "focused", label: "Focused" },
  { key: "energetic", label: "Energetic" },
];

// Preset messages are session-mode-specific quick inserts used by the room chat
// to make reactions, bookmarks, and common prompts easy to send with one tap.
const SESSION_PRESET_MESSAGES = {
  watch: [
    { emoji: "🍿", text: "Best scene so far!", category: "reaction" },
    { emoji: "😮", text: "Wait what just happened?!", category: "reaction" },
    { emoji: "😂", text: "I can't stop laughing", category: "reaction" },
    { emoji: "📍", text: "Save this moment", category: "bookmark" },
    { emoji: "❤️", text: "This hits so hard with you here", category: "couple" },
    { emoji: "🔥", text: "This scene goes crazy", category: "friends" },
  ],
  music: [
    { emoji: "🎵", text: "This drop is perfectly synced", category: "sync" },
    { emoji: "🔁", text: "Replay that section", category: "bookmark" },
    { emoji: "🔥", text: "This track sounds huge together", category: "reaction" },
    { emoji: "🎚️", text: "Tiny drift corrected", category: "debug" },
    { emoji: "💿", text: "Load the matching local file", category: "source" },
  ],
  podcast: [
    { emoji: "🎧", text: "Audio sync feels perfect", category: "sync" },
    { emoji: "🧠", text: "That point was brilliant", category: "insight" },
    { emoji: "📍", text: "Bookmark this timestamp", category: "bookmark" },
    { emoji: "❓", text: "Can we replay that section?", category: "study" },
    { emoji: "💬", text: "This topic reminds me of us", category: "couple" },
  ],
  reading: [
    { emoji: "📄", text: "Let's discuss this page", category: "page" },
    { emoji: "🖍️", text: "Highlight this line", category: "highlight" },
    { emoji: "❓", text: "I have a question here", category: "study" },
    { emoji: "🧩", text: "This paragraph connects everything", category: "insight" },
    { emoji: "📍", text: "Remember this passage", category: "bookmark" },
  ],
  study: [
    { emoji: "🧑‍🏫", text: "Teacher note: focus on this concept", category: "teacher" },
    { emoji: "✋", text: "I have a doubt, can we pause?", category: "student" },
    { emoji: "✅", text: "Checkpoint done", category: "progress" },
    { emoji: "📍", text: "Bookmark this explanation", category: "bookmark" },
    { emoji: "⏱️", text: "Let's do a 25-minute focus sprint", category: "focus" },
  ],
};

// Display-only map from backend room types to the labels shown in the UI.
const ROOM_TYPE_LABELS = {
  duo: "Couple",
  friends: "Friends",
  family: "Family",
};

// Display-only map from backend session-mode keys to friendly UI labels.
const SESSION_MODE_LABELS = {
  watch: "Watch",
  music: "Music",
  podcast: "Podcast",
  reading: "Co-reading",
  study: "Study",
};

export {
  PRIVATE_ROOM_MODES,
  SESSION_MODES,
  ROOM_MOOD_OPTIONS,
  SESSION_PRESET_MESSAGES,
  ROOM_TYPE_LABELS,
  SESSION_MODE_LABELS,
};
