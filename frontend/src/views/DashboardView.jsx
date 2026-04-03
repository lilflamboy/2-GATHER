import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Film,
  Users,
  UserRound,
  ImagePlus,
  Clock3,
  Bell,
  Settings,
  Ghost,
  HeartHandshake,
  ArrowLeft,
  Search,
  UserPlus,
  Check,
  Heart,
  Sparkles,
  LogOut,
  Radio,
  Plus,
  Menu,
  Square,
  CheckSquare,
  Trash2,
  Link2,
  Database,
} from "lucide-react";

const TABS = [
  { key: "profile", label: "My Profile", icon: UserRound },
  { key: "friends", label: "Friends", icon: Users },
  { key: "couple", label: "Couple Space", icon: HeartHandshake },
  { key: "memories", label: "Memories", icon: Clock3 },
  { key: "intelligence", label: "Relationship IQ", icon: Sparkles },
  { key: "notifications", label: "Notifications", icon: Bell },
  { key: "activity", label: "Activity", icon: Bell },
  { key: "metadata", label: "Metadata", icon: Database },
  { key: "settings", label: "Settings", icon: Settings },
];
// Genre hints give the dashboard a lightweight fallback classifier when the
// backend did not store an explicit genre for a shared memory.
const SESSION_MODE_LABELS = {
  watch: "Watch",
  podcast: "Podcast",
  reading: "Co-reading",
  study: "Study",
};
const RELATIONSHIP_TAG_OPTIONS = [
  { key: "friends", label: "Friend" },
  { key: "couple", label: "Couple" },
  { key: "family", label: "Family" },
];
const GENRE_HINTS = [
  { genre: "Romance", terms: ["romance", "romantic", "love", "date"] },
  { genre: "Thriller", terms: ["thriller", "mystery", "suspense", "crime"] },
  { genre: "Comedy", terms: ["comedy", "funny", "laugh", "lol"] },
  { genre: "Sci-Fi", terms: ["sci-fi", "science fiction", "space", "future"] },
  { genre: "Horror", terms: ["horror", "scary", "fear", "ghost"] },
  { genre: "Drama", terms: ["drama", "emotional", "heartbreak", "family"] },
];

function fmtDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const mins = Math.floor((value % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function fmtRelativeTime(value) {
  const at = value ? new Date(value).getTime() : 0;
  if (!at) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(value).toLocaleDateString();
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function normalizeDayKey(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function computeStreakDays(items = []) {
  // Streaks are based on unique UTC day keys so multiple memories on one day
  // still count as a single streak step.
  const dayKeys = [...new Set(items.map((item) => normalizeDayKey(item?.date || item?.createdAt)).filter(Boolean))].sort();
  if (dayKeys.length === 0) return 0;
  let streak = 1;
  for (let idx = dayKeys.length - 1; idx > 0; idx -= 1) {
    const current = new Date(`${dayKeys[idx]}T00:00:00Z`).getTime();
    const previous = new Date(`${dayKeys[idx - 1]}T00:00:00Z`).getTime();
    const diff = Math.round((current - previous) / 86400000);
    if (diff === 1) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

function guessGenre(memory) {
  const explicit = String(memory?.genre || "").trim();
  if (explicit) return explicit;
  const note = String(memory?.memoryNote || "").toLowerCase();
  const hit = GENRE_HINTS.find((candidate) => candidate.terms.some((term) => note.includes(term)));
  return hit?.genre || "Unknown";
}

function buildYearStory({ year, topPartnerLabel, totalHours, topGenre, streakDays, modeLabel }) {
  // This produces the "story" sentence shown in the intelligence view from
  // already-derived dashboard stats instead of fetching separate copy from the API.
  if (!topPartnerLabel && totalHours <= 0) {
    return `Your ${year} story starts when your first shared session is saved.`;
  }
  return [
    `In ${year}, you spent ${Math.round(totalHours)}h together${topPartnerLabel ? ` with ${topPartnerLabel}` : ""}.`,
    `Your strongest vibe was ${topGenre || "mixed genres"} and your current streak is ${streakDays} day${streakDays === 1 ? "" : "s"}.`,
    `Most used session type: ${modeLabel}.`,
  ].join(" ");
}

function activityLabel(item) {
  const targetName = item?.target?.username ? `@${item.target.username}` : (item?.target?.displayName || "friend");
  switch (item?.type) {
    case "username_claimed":
      return "You completed username setup";
    case "profile_updated":
      return "You updated your profile";
    case "friend_request_sent":
      return `You sent a friend request to ${targetName}`;
    case "friend_request_accepted":
      return `You accepted ${targetName}'s friend request`;
    case "friend_request_rejected":
      return `You declined ${targetName}'s friend request`;
    case "room_invite_sent":
      return `You invited ${targetName} to watch`;
    case "shared_memory_created":
      return `You saved a shared memory with ${targetName}`;
    case "room_created":
      return "You created a room";
    case "room_joined":
      return "You joined a room";
    case "room_left":
      return "You left a room";
    default:
      return String(item?.type || "activity").replace(/_/g, " ");
  }
}

function notificationLabel(item) {
  const sender = item?.sender?.username ? `@${item.sender.username}` : (item?.sender?.displayName || "Someone");
  switch (String(item?.type || "")) {
    case "friend_request":
      return `${sender} sent you a friend request`;
    case "friend_request_accepted":
      return `${sender} accepted your friend request`;
    case "friend_request_rejected":
      return `${sender} declined your friend request`;
    case "room_invite":
      return `${sender} invited you to room ${item?.roomCode || ""}`.trim();
    case "shared_memory_added":
      return `${sender} saved a shared memory`;
    default:
      return String(item?.type || "notification").replace(/_/g, " ");
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read image file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not process image"));
    image.src = src;
  });
}

async function toProfilePhotoDataUrl(file) {
  // Profile photos are resized/compressed client-side so the profile PATCH
  // request stays small enough to persist as a data URL.
  if (!file || !String(file.type || "").startsWith("image/")) {
    throw new Error("Please choose an image file");
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error("Image is too large (max 8MB)");
  }

  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(sourceDataUrl);
  const maxSide = 320;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Image editing is not supported in this browser");
  }
  ctx.drawImage(image, 0, 0, width, height);

  let output = canvas.toDataURL("image/webp", 0.82);
  if (output.length > 110000) {
    output = canvas.toDataURL("image/jpeg", 0.8);
  }
  if (output.length > 110000) {
    throw new Error("Image is still too large. Try a smaller photo.");
  }
  return output;
}

function Toggle({ checked, onChange, label, help }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className="w-full flex items-start justify-between gap-3 rounded-xl border border-zinc-700/70 bg-zinc-900/60 p-3 text-left hover:border-zinc-600 transition-colors"
    >
      <div>
        <p className="text-sm text-zinc-100 font-medium">{label}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{help}</p>
      </div>
      <span
        className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${checked ? "bg-emerald-500" : "bg-zinc-700"}`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`}
        />
      </span>
    </button>
  );
}

function DashboardSidebar({ tabs, tab, onSelectTab, onlineFriends, activeRoomCode, className = "" }) {
  return (
    <aside className={`glass-panel p-3 h-fit ${className}`.trim()}>
      <div className="mb-3 text-xs text-zinc-500 uppercase tracking-wide px-2">Account</div>
      <div className="space-y-1">
        {tabs.map((item) => {
          const Icon = item.icon;
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onSelectTab(item.key)}
              className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm transition-colors ${active
                ? "bg-amber-400/20 border border-amber-300/30 text-amber-200"
                : "text-zinc-300 hover:bg-zinc-800/70"
              }`}
            >
              <Icon size={14} />
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4 pt-4 border-t border-zinc-700/50 text-xs text-zinc-500">
        <p className="mb-1">Live friends online</p>
        <p className="text-zinc-200 font-semibold">{onlineFriends.length}</p>
        <p className="mt-3 mb-1">Active room</p>
        <p className="text-zinc-300 font-mono">{activeRoomCode || "None"}</p>
      </div>
    </aside>
  );
}

export default function DashboardView({
  username,
  apiClient,
  onBack,
  onSignOut,
  onInviteFriend,
  invites=[],
  onAcceptInvite,
  addToast,
  onProfileUpdated,
  activeRoomCode,
  initialTab="profile",
  pushEnabled,
  onTogglePushNotifications,
  showMetadata,
}) {
  // DashboardView is the authenticated control center for profile, friends,
  // memories, intelligence, notifications, and lightweight project metadata.
  const [tab, setTab] = useState(initialTab || "profile");
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const headerNotifRef = useRef(null);
  const mobileMenuRef = useRef(null);
  const [showHeaderNotifications, setShowHeaderNotifications] = useState(false);
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const photoInputRef = useRef(null);

  const [profile, setProfile] = useState(null);
  const [profileForm, setProfileForm] = useState({ displayName: "", bio: "", photoURL: "" });
  const [savingProfile, setSavingProfile] = useState(false);
  const [photoProcessing, setPhotoProcessing] = useState(false);

  const [friends, setFriends] = useState([]);
  const [relationshipByPartnerUid, setRelationshipByPartnerUid] = useState({});
  const [tagUpdatingUid, setTagUpdatingUid] = useState("");
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [outgoingRequests, setOutgoingRequests] = useState([]);

  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);

  const [memories, setMemories] = useState({
    summary: { weekSeconds: 0, monthSeconds: 0, yearSeconds: 0, allSeconds: 0 },
    byFriend: [],
  });
  const [sharedMemories, setSharedMemories] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [notificationsUnread, setNotificationsUnread] = useState(0);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [memoryPartnerUid, setMemoryPartnerUid] = useState("");
  const [memoryRoomCode, setMemoryRoomCode] = useState("");
  const [memoryNote, setMemoryNote] = useState("");
  const [memorySessionMode, setMemorySessionMode] = useState("watch");
  const [memoryGenre, setMemoryGenre] = useState("");
  const [memoryMoodTag, setMemoryMoodTag] = useState("");
  const [memoryHighlightTimestamp, setMemoryHighlightTimestamp] = useState("");
  const [memorySessionMinutes, setMemorySessionMinutes] = useState("");
  const [memoryReactionCount, setMemoryReactionCount] = useState("");
  const [savingMemory, setSavingMemory] = useState(false);
  const [activityFeed, setActivityFeed] = useState([]);
  const [projectOverview, setProjectOverview] = useState({
    counts: {
      users: 0,
      rooms: 0,
      activeRooms: 0,
      relationships: 0,
      invitesSent: 0,
      activities: 0,
      activitiesThisWeek: 0,
      sharedMemories: 0,
      notifications: 0,
    },
    recentActivity: [],
    recentRooms: [],
    syncStatePolicy: "ephemeral_in_memory",
  });
  const [couplePartnerUid, setCouplePartnerUid] = useState("");
  const [couplePartnerProfile, setCouplePartnerProfile] = useState(null);
  const [coupleSpace, setCoupleSpace] = useState({ watchlist: [] });
  const [coupleLoading, setCoupleLoading] = useState(false);
  const [coupleBusy, setCoupleBusy] = useState(false);
  const [watchTitle, setWatchTitle] = useState("");
  const [watchUrl, setWatchUrl] = useState("");
  const [watchNotes, setWatchNotes] = useState("");
  // Metadata is only surfaced for admin users, so the tab list is filtered here
  // instead of branching throughout the render tree.
  const tabs = useMemo(
    () => (showMetadata ? TABS : TABS.filter((item) => item.key !== "metadata")),
    [showMetadata]
  );
  const unreadHeaderNotifications = Math.max(
    incomingRequests.length + (invites?.length || 0),
    notificationsUnread
  );

  useEffect(() => {
    if (!showHeaderNotifications) return;
    // Header popovers are dismissed with outside-click and Escape to keep the
    // desktop and mobile experiences consistent.
    const onPointer = (event) => {
      if (headerNotifRef.current && !headerNotifRef.current.contains(event.target)) {
        setShowHeaderNotifications(false);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") setShowHeaderNotifications(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [showHeaderNotifications]);

  useEffect(() => {
    if (!showMobileSidebar) return;
    const onPointer = (event) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(event.target)) {
        setShowMobileSidebar(false);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") setShowMobileSidebar(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [showMobileSidebar]);

  useEffect(() => {
    if (!showMetadata && tab === "metadata") {
      setTab("profile");
    }
  }, [showMetadata, tab]);

  useEffect(() => {
    if (!initialTab) return;
    setTab(initialTab);
  }, [initialTab]);

  const loadNotifications = useCallback(async ({ silent = false } = {}) => {
    try {
      const res = await apiClient("/api/notifications?limit=80");
      setNotifications(res.items || []);
      setNotificationsUnread(Number(res.unreadCount) || 0);
    } catch (error) {
      if (!silent) {
        addToast(error.message || "Could not load notifications", "error");
      }
    }
  }, [apiClient, addToast]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // Hydrate the dashboard from a small set of source endpoints, then derive
      // the richer visual summaries locally from that normalized data.
      const meRes = await apiClient("/api/me");
      const [friendsRes, memoriesRes, sharedMemoriesRes, notificationsRes, relationshipsRes] = await Promise.all([
        apiClient("/api/friends"),
        apiClient("/api/memories"),
        apiClient("/api/shared-memories"),
        apiClient("/api/notifications?limit=80").catch(() => ({ items: [], unreadCount: 0 })),
        apiClient("/api/relationships").catch(() => ({ relationships: [] })),
      ]);

      let activityItems = [];
      try {
        const activityRes = await apiClient("/api/activity?limit=50");
        activityItems = activityRes.items || [];
      } catch (error) {
        const msg = String(error?.message || "");
        if (!msg.includes("404")) {
          addToast("Activity feed is temporarily unavailable", "info");
        }
      }

      let overviewRes = null;
      if (showMetadata) {
        try {
          overviewRes = await apiClient("/api/project-overview");
        } catch (error) {
          addToast(error.message || "Could not load metadata", "error");
        }
      }

      setProfile(meRes.profile);
      onProfileUpdated?.(meRes.profile || null);
      setProfileForm({
        displayName: meRes.profile?.displayName || "",
        bio: meRes.profile?.bio || "",
        photoURL: meRes.profile?.photoURL || "",
      });
      setFriends(friendsRes.friends || []);
      const relationshipMap = {};
      (relationshipsRes.relationships || []).forEach((item) => {
        const partnerUid = item?.partner?.uid;
        if (!partnerUid) return;
        relationshipMap[partnerUid] = {
          relationshipType: item.relationshipType || "friends",
          pairKey: item.pairKey || "",
          status: item.status || "accepted",
        };
      });
      setRelationshipByPartnerUid(relationshipMap);
      setIncomingRequests(friendsRes.incomingRequests || []);
      setOutgoingRequests(friendsRes.outgoingRequests || []);
      setMemories(memoriesRes || {
        summary: { weekSeconds: 0, monthSeconds: 0, yearSeconds: 0, allSeconds: 0 },
        byFriend: [],
      });
      setSharedMemories(sharedMemoriesRes.items || []);
      setNotifications(notificationsRes.items || []);
      setNotificationsUnread(Number(notificationsRes.unreadCount) || 0);
      setActivityFeed(activityItems);
      if (overviewRes) {
        setProjectOverview(overviewRes);
      }
    } catch (error) {
      addToast(error.message || "Failed to load settings", "error");
    } finally {
      setLoading(false);
    }
  }, [apiClient, addToast, showMetadata, onProfileUpdated]);

  useEffect(() => {
    loadData();
  }, [loadData, refreshTick]);

  useEffect(() => {
    // Keep the dashboard reasonably fresh while it stays open without forcing
    // a full hard reload every time the user switches tabs.
    const timer = setInterval(() => {
      Promise.all([
        apiClient("/api/friends"),
        loadNotifications({ silent: true }),
      ])
        .then(([friendsRes]) => {
          setFriends(friendsRes.friends || []);
          setIncomingRequests(friendsRes.incomingRequests || []);
          setOutgoingRequests(friendsRes.outgoingRequests || []);
        })
        .catch(() => {});
    }, 12000);
    return () => clearInterval(timer);
  }, [apiClient, loadNotifications]);

  const onlineFriends = useMemo(() => friends.filter((friend) => friend.online), [friends]);

  const runSearch = useCallback(async () => {
    const q = search.trim();
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const res = await apiClient(`/api/users/search?q=${encodeURIComponent(q)}`);
      setSearchResults(res.users || []);
    } catch (error) {
      addToast(error.message || "Search failed", "error");
    } finally {
      setSearching(false);
    }
  }, [search, apiClient, addToast]);

  useEffect(() => {
    // Debounce user search so typing does not hammer the backend on every keypress.
    const timer = setTimeout(() => {
      runSearch();
    }, 260);
    return () => clearTimeout(timer);
  }, [runSearch]);

  const loadCoupleSpace = useCallback(async (partnerUid) => {
    if (!partnerUid) return;
    setCoupleLoading(true);
    try {
      // Couple Space is partner-specific, so it is loaded on demand instead of
      // bundling every partner's watchlist into the dashboard bootstrap payload.
      const res = await apiClient(`/api/couple-space?partnerUid=${encodeURIComponent(partnerUid)}`);
      setCouplePartnerProfile(res.partner || null);
      setCoupleSpace(res.space || { watchlist: [] });
    } catch (error) {
      addToast(error.message || "Could not load couple space", "error");
      setCouplePartnerProfile(null);
      setCoupleSpace({ watchlist: [] });
    } finally {
      setCoupleLoading(false);
    }
  }, [apiClient, addToast]);

  useEffect(() => {
    if (!couplePartnerUid && friends.length > 0) {
      setCouplePartnerUid(friends[0].uid);
    }
  }, [friends, couplePartnerUid]);

  useEffect(() => {
    if (!memoryPartnerUid && friends.length > 0) {
      setMemoryPartnerUid(friends[0].uid);
    }
  }, [friends, memoryPartnerUid]);

  useEffect(() => {
    if (tab !== "couple") return;
    if (!couplePartnerUid) return;
    loadCoupleSpace(couplePartnerUid);
  }, [tab, couplePartnerUid, loadCoupleSpace, refreshTick]);

  const onSendRequest = async (targetUid) => {
    try {
      await apiClient("/api/friends/request", {
        method: "POST",
        body: { targetUid },
      });
      addToast("Friend request sent", "success");
      setRefreshTick((v) => v + 1);
    } catch (error) {
      addToast(error.message || "Could not send request", "error");
    }
  };

  const onRespondRequest = async (requesterUid, action) => {
    try {
      await apiClient("/api/friends/respond", {
        method: "POST",
        body: { requesterUid, action },
      });
      addToast(action === "accept" ? "Friend added" : "Request declined", "success");
      setRefreshTick((v) => v + 1);
    } catch (error) {
      addToast(error.message || "Could not update request", "error");
    }
  };

  const onMarkNotificationRead = async (notificationId) => {
    if (!notificationId || notificationBusy) return;
    setNotificationBusy(true);
    try {
      await apiClient("/api/notifications/read", {
        method: "POST",
        body: { notificationId },
      });
      setNotifications((prev) => prev.map((item) => (
        item.id === notificationId ? { ...item, isRead: true, readAt: new Date().toISOString() } : item
      )));
      setNotificationsUnread((prev) => Math.max(0, prev - 1));
    } catch (error) {
      addToast(error.message || "Could not mark notification read", "error");
    } finally {
      setNotificationBusy(false);
    }
  };

  const onMarkAllNotificationsRead = async () => {
    if (notificationBusy || notificationsUnread === 0) return;
    setNotificationBusy(true);
    try {
      await apiClient("/api/notifications/read-all", { method: "POST" });
      setNotifications((prev) => prev.map((item) => ({ ...item, isRead: true, readAt: item.readAt || new Date().toISOString() })));
      setNotificationsUnread(0);
    } catch (error) {
      addToast(error.message || "Could not mark all notifications read", "error");
    } finally {
      setNotificationBusy(false);
    }
  };

  const onJoinRoomFromNotification = async (item) => {
    if (!item?.roomCode) return;
    onAcceptInvite?.({
      id: `notif-${item.id}`,
      roomCode: item.roomCode,
      fromUid: item.sender?.uid || "",
      fromUsername: item.sender?.username || "",
      fromName: item.sender?.displayName || "Friend",
      fromPhotoURL: item.sender?.photoURL || "",
      timestamp: Date.now(),
    });
    if (!item.isRead) {
      await onMarkNotificationRead(item.id);
    }
  };

  const onPickProfilePhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setPhotoProcessing(true);
    try {
      const dataUrl = await toProfilePhotoDataUrl(file);
      setProfileForm((prev) => ({ ...prev, photoURL: dataUrl }));
      addToast("Photo ready. Click Save profile to apply.", "success");
    } catch (error) {
      addToast(error.message || "Could not process photo", "error");
    } finally {
      setPhotoProcessing(false);
    }
  };

  const onRemoveProfilePhoto = () => {
    setProfileForm((prev) => ({ ...prev, photoURL: "" }));
    addToast("Photo removed. Click Save profile to apply.", "info");
  };

  const onSaveProfile = async (event) => {
    event.preventDefault();
    setSavingProfile(true);
    try {
      const res = await apiClient("/api/me", {
        method: "PATCH",
        body: {
          displayName: profileForm.displayName,
          bio: profileForm.bio,
          photoURL: profileForm.photoURL,
        },
      });
      setProfile(res.profile);
      onProfileUpdated?.(res.profile || null);
      addToast("Profile updated", "success");
    } catch (error) {
      addToast(error.message || "Could not save profile", "error");
    } finally {
      setSavingProfile(false);
    }
  };

  const onToggleSetting = async (key) => {
    const nextSettings = {
      ...(profile?.settings || {}),
      [key]: !(profile?.settings?.[key]),
    };

    try {
      const res = await apiClient("/api/me", {
        method: "PATCH",
        body: { settings: nextSettings },
      });
      setProfile(res.profile);
    } catch (error) {
      addToast(error.message || "Could not update settings", "error");
    }
  };

  const onInvite = async (friendUid) => {
    try {
      await onInviteFriend(friendUid);
      setRefreshTick((v) => v + 1);
    } catch (error) {
      addToast(error.message || "Could not send invite", "error");
    }
  };

  const onUpdateRelationshipTag = async (partnerUid, relationshipType) => {
    if (!partnerUid) return;
    setTagUpdatingUid(partnerUid);
    try {
      const res = await apiClient("/api/relationships/tag", {
        method: "PATCH",
        body: { partnerUid, relationshipType },
      });
      const nextType = res?.relationship?.relationshipType || relationshipType || "friends";
      setRelationshipByPartnerUid((prev) => ({
        ...prev,
        [partnerUid]: {
          ...(prev[partnerUid] || {}),
          relationshipType: nextType,
          pairKey: res?.relationship?.pairKey || prev[partnerUid]?.pairKey || "",
          status: res?.relationship?.status || prev[partnerUid]?.status || "accepted",
        },
      }));
      addToast("Relationship tag updated", "success");
    } catch (error) {
      addToast(error.message || "Could not update relationship tag", "error");
    } finally {
      setTagUpdatingUid("");
    }
  };

  const onAddWatchlistItem = async (event) => {
    event.preventDefault();
    if (!couplePartnerUid) {
      addToast("Choose your partner first", "error");
      return;
    }
    if (!watchTitle.trim()) {
      addToast("Watchlist title is required", "error");
      return;
    }
    setCoupleBusy(true);
    try {
      const res = await apiClient("/api/couple-space/item", {
        method: "POST",
        body: {
          partnerUid: couplePartnerUid,
          title: watchTitle,
          url: watchUrl,
          notes: watchNotes,
        },
      });
      setCouplePartnerProfile(res.partner || null);
      setCoupleSpace(res.space || { watchlist: [] });
      setWatchTitle("");
      setWatchUrl("");
      setWatchNotes("");
      addToast("Added to couple watchlist", "success");
    } catch (error) {
      addToast(error.message || "Could not add watchlist item", "error");
    } finally {
      setCoupleBusy(false);
    }
  };

  const onUpdateWatchlistItem = async (itemId, action, done) => {
    if (!couplePartnerUid) return;
    setCoupleBusy(true);
    try {
      const res = await apiClient("/api/couple-space/item", {
        method: "PATCH",
        body: {
          partnerUid: couplePartnerUid,
          itemId,
          action,
          done,
        },
      });
      setCouplePartnerProfile(res.partner || null);
      setCoupleSpace(res.space || { watchlist: [] });
    } catch (error) {
      addToast(error.message || "Could not update watchlist item", "error");
    } finally {
      setCoupleBusy(false);
    }
  };

  const onAddSharedMemory = async (event) => {
    event.preventDefault();
    if (!memoryPartnerUid) {
      addToast("Pick a friend first", "error");
      return;
    }
    if (!memoryNote.trim()) {
      addToast("Write a memory note first", "error");
      return;
    }

    setSavingMemory(true);
    try {
      const res = await apiClient("/api/shared-memories", {
        method: "POST",
        body: {
          partnerUid: memoryPartnerUid,
          roomCode: memoryRoomCode.trim().toUpperCase(),
          memoryNote: memoryNote.trim(),
          sessionMode: memorySessionMode,
          genre: memoryGenre.trim(),
          moodTag: memoryMoodTag.trim(),
          highlightTimestamp: memoryHighlightTimestamp.trim(),
          sessionMinutes: memorySessionMinutes ? Number(memorySessionMinutes) : 0,
          reactionCount: memoryReactionCount ? Number(memoryReactionCount) : 0,
        },
      });
      if (res.item) {
        setSharedMemories((prev) => [res.item, ...prev].slice(0, 200));
      }
      setMemoryNote("");
      setMemoryRoomCode("");
      setMemoryGenre("");
      setMemoryMoodTag("");
      setMemoryHighlightTimestamp("");
      setMemorySessionMinutes("");
      setMemoryReactionCount("");
      setMemorySessionMode("watch");
      setRefreshTick((v) => v + 1);
      addToast("Shared memory saved", "success");
    } catch (error) {
      addToast(error.message || "Could not save shared memory", "error");
    } finally {
      setSavingMemory(false);
    }
  };

  const passiveNotifications = useMemo(
    () => notifications.filter((item) => !["friend_request", "room_invite"].includes(String(item.type || ""))),
    [notifications]
  );
  const relationshipIntel = useMemo(() => {
    // This memo is the "analytics layer" of the dashboard: it turns saved
    // memories + session summaries into compatibility cards and yearly stories.
    const memoryItems = (Array.isArray(sharedMemories) ? sharedMemories : [])
      .map((item) => ({
        ...item,
        dateObj: item?.date ? new Date(item.date) : new Date(),
        partnerUid: item?.partner?.uid || "",
        partnerLabel: item?.partner?.username ? `@${item.partner.username}` : (item?.partner?.displayName || "friend"),
      }))
      .sort((a, b) => new Date(b.dateObj).getTime() - new Date(a.dateObj).getTime());

    const modeCounts = new Map();
    const genreCounts = new Map();
    const moodCounts = new Map();
    const timeOfDayCounts = new Map();
    let reactionTotal = 0;

    memoryItems.forEach((item) => {
      const mode = String(item.sessionMode || "watch").toLowerCase();
      modeCounts.set(mode, (modeCounts.get(mode) || 0) + 1);
      const genre = guessGenre(item);
      genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      const mood = String(item.moodTag || "").trim();
      if (mood) moodCounts.set(mood, (moodCounts.get(mood) || 0) + 1);
      reactionTotal += Math.max(0, Number(item.reactionCount) || 0);

      const hour = new Date(item.dateObj).getHours();
      const bucket = hour >= 22 || hour < 5
        ? "Late night"
        : hour >= 18
          ? "Evening"
          : hour >= 12
            ? "Afternoon"
            : "Morning";
      timeOfDayCounts.set(bucket, (timeOfDayCounts.get(bucket) || 0) + 1);
    });

    const pickTopLabel = (map, fallback = "Unknown") => {
      const list = [...map.entries()].sort((a, b) => b[1] - a[1]);
      return list[0]?.[0] || fallback;
    };
    const topMode = pickTopLabel(modeCounts, "watch");
    const topGenre = pickTopLabel(genreCounts, "Unknown");
    const topMood = pickTopLabel(moodCounts, "Mixed");
    const topWatchWindow = pickTopLabel(timeOfDayCounts, "Anytime");
    const streakDays = computeStreakDays(memoryItems);
    const longestSessionMinutes = memoryItems.reduce((max, item) => (
      Math.max(max, Math.max(0, Number(item.sessionMinutes) || 0))
    ), 0);

    const totalSharedHours = (Number(memories?.summary?.allSeconds) || 0) / 3600;
    const topFriend = (memories?.byFriend || [])[0] || null;
    const topPartnerLabel = topFriend
      ? (topFriend.username ? `@${topFriend.username}` : (topFriend.displayName || "friend"))
      : (memoryItems[0]?.partnerLabel || "");

    const compatibilityCards = (memories?.byFriend || []).map((friend) => {
      const label = friend.username ? `@${friend.username}` : (friend.displayName || "friend");
      const friendMemories = memoryItems.filter((item) => item.partnerUid === friend.uid);
      const friendStreak = computeStreakDays(friendMemories);
      const friendGenres = new Map();
      const friendMoods = new Map();
      friendMemories.forEach((item) => {
        const genre = guessGenre(item);
        friendGenres.set(genre, (friendGenres.get(genre) || 0) + 1);
        const mood = String(item.moodTag || "").trim();
        if (mood) friendMoods.set(mood, (friendMoods.get(mood) || 0) + 1);
      });
      const favoriteGenre = pickTopLabel(friendGenres, "Unknown");
      const favoriteMood = pickTopLabel(friendMoods, "Balanced");
      const sharedEntries = friendMemories.length;
      const compatibilityIndex = clampPercent(
        30 + (Number(friend.allSeconds || 0) / 1800) + (sharedEntries * 7) + (friendStreak * 4) + (favoriteGenre !== "Unknown" ? 8 : 0)
      );
      return {
        uid: friend.uid,
        label,
        hours: (Number(friend.allSeconds) || 0) / 3600,
        streakDays: friendStreak,
        favoriteGenre,
        favoriteMood,
        sharedEntries,
        compatibilityIndex,
      };
    }).sort((a, b) => b.compatibilityIndex - a.compatibilityIndex);

    const firstMemory = memoryItems[memoryItems.length - 1] || null;
    const firstMemoryDate = firstMemory?.dateObj || null;
    let anniversaryText = "Save your first shared memory to unlock anniversary reminders.";
    if (firstMemoryDate) {
      const now = new Date();
      const anniversary = new Date(now.getFullYear(), firstMemoryDate.getMonth(), firstMemoryDate.getDate());
      if (anniversary.getTime() < now.getTime()) {
        anniversary.setFullYear(anniversary.getFullYear() + 1);
      }
      const msLeft = anniversary.getTime() - now.getTime();
      const daysLeft = Math.max(0, Math.ceil(msLeft / 86400000));
      anniversaryText = daysLeft === 0
        ? "Anniversary reminder: today is your shared watch anniversary."
        : `Anniversary reminder: ${daysLeft} day${daysLeft === 1 ? "" : "s"} until your shared watch anniversary.`;
    }

    const milestones = [
      { key: "first_memory", label: "First Memory", achieved: memoryItems.length >= 1 },
      { key: "ten_memories", label: "10 Shared Memories", achieved: memoryItems.length >= 10 },
      { key: "twenty_five_hours", label: "25 Hours Together", achieved: (Number(memories?.summary?.allSeconds) || 0) >= 25 * 3600 },
      { key: "hundred_hours", label: "100 Hours Together", achieved: (Number(memories?.summary?.allSeconds) || 0) >= 100 * 3600 },
      { key: "reaction_spark", label: "200 Reactions Logged", achieved: reactionTotal >= 200 },
    ];

    const timeline = memoryItems.slice(0, 10).map((item) => ({
      id: item.id,
      date: item.dateObj,
      label: item.partnerLabel,
      note: item.memoryNote,
      sessionMode: SESSION_MODE_LABELS[item.sessionMode] || SESSION_MODE_LABELS.watch,
      genre: guessGenre(item),
      moodTag: item.moodTag || "Unlabeled mood",
      highlightTimestamp: item.highlightTimestamp || "",
      reactionCount: Math.max(0, Number(item.reactionCount) || 0),
      sessionMinutes: Math.max(0, Number(item.sessionMinutes) || 0),
      roomCode: item.roomCode || "",
    }));

    const year = new Date().getFullYear();
    const yearStory = buildYearStory({
      year,
      topPartnerLabel,
      totalHours: totalSharedHours,
      topGenre,
      streakDays,
      modeLabel: SESSION_MODE_LABELS[topMode] || SESSION_MODE_LABELS.watch,
    });
    const relationshipInsights = [
      `You watch most often during ${topWatchWindow.toLowerCase()} and your dominant mood is ${topMood.toLowerCase()}.`,
      `${topGenre === "Unknown" ? "Genre profile is still forming" : `${topGenre} is your strongest genre signal`} based on saved memories and notes.`,
      `Current shared streak: ${streakDays} day${streakDays === 1 ? "" : "s"} with ${memoryItems.length} logged moments.`,
    ];
    const modeUsage = ["watch", "podcast", "reading", "study"].map((mode) => ({
      mode,
      label: SESSION_MODE_LABELS[mode] || mode,
      count: modeCounts.get(mode) || 0,
    }));

    return {
      totalSharedHours,
      longestSessionMinutes,
      streakDays,
      topGenre,
      topMood,
      topWatchWindow,
      topMode,
      reactionTotal,
      compatibilityCards,
      milestones,
      timeline,
      yearStory,
      anniversaryText,
      relationshipInsights,
      modeUsage,
    };
  }, [sharedMemories, memories]);

  const profilePhotoPreview = profileForm.photoURL || profile?.photoURL || "";
  const selectTab = (nextTab) => {
    setTab(nextTab);
    setShowMobileSidebar(false);
  };

  return (
    <div className="min-h-screen bg-screen relative overflow-hidden">
      <div className="grain-overlay" />

      <header className="relative z-40 px-4 sm:px-6 py-4 border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="p-2 rounded-lg bg-zinc-900/70 border border-zinc-700/60 text-zinc-300 hover:text-zinc-100 transition-colors"
              title="Back"
            >
              <ArrowLeft size={15} />
            </button>
            <div className="flex items-center gap-2">
              <Film size={18} className="text-amber-400" />
              <p className="font-display text-xl text-zinc-100">Lumiere Settings</p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="hidden sm:inline text-zinc-500 font-mono">@{username}</span>
            <button
              type="button"
              onClick={() => {
                setShowMobileSidebar((v) => {
                  const next = !v;
                  if (next) setShowHeaderNotifications(false);
                  return next;
                });
              }}
              className="lg:hidden relative flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-900/75 border border-zinc-700/70 text-zinc-300 hover:text-zinc-100 transition-colors"
              title="Menu"
            >
              <Menu size={14} />
            </button>
            <div ref={headerNotifRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  setShowHeaderNotifications((v) => {
                    const next = !v;
                    if (next) setShowMobileSidebar(false);
                    return next;
                  });
                }}
                className="relative flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-900/75 border border-zinc-700/70 text-zinc-300 hover:text-zinc-100 transition-colors"
                title="Notifications"
              >
                <Bell size={14} />
                {unreadHeaderNotifications > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-amber-400 text-zinc-950 text-[10px] font-bold flex items-center justify-center">
                    {unreadHeaderNotifications > 9 ? "9+" : unreadHeaderNotifications}
                  </span>
                )}
              </button>
              {showHeaderNotifications && (
                <div className="fixed left-2 right-2 top-[4.4rem] sm:left-auto sm:right-6 sm:w-80 rounded-xl border border-zinc-700 bg-zinc-900/95 backdrop-blur-xl shadow-2xl z-[90] p-2">
                  <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500 flex items-center justify-between">
                    <span>Notifications</span>
                    <button
                      type="button"
                      disabled={notificationBusy || notificationsUnread === 0}
                      onClick={onMarkAllNotificationsRead}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Mark all read
                    </button>
                  </div>
                  <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
                    {incomingRequests.map((item) => (
                      <div key={`incoming-${item.uid}`} className="rounded-lg border border-zinc-700/60 bg-zinc-900/80 p-2">
                        <p className="text-xs text-zinc-200">
                          <span className="font-semibold">@{item.username || "user"}</span> sent you a friend request
                        </p>
                        <div className="mt-2 flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onRespondRequest(item.uid, "accept")}
                            className="px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[11px] text-zinc-950 font-semibold"
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            onClick={() => onRespondRequest(item.uid, "reject")}
                            className="px-2.5 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 text-[11px] text-zinc-100"
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ))}
                    {(invites || []).map((invite) => (
                      <div key={`invite-${invite.id}`} className="rounded-lg border border-zinc-700/60 bg-zinc-900/80 p-2">
                        <p className="text-xs text-zinc-200">
                          <span className="font-semibold">{invite.fromUsername ? `@${invite.fromUsername}` : invite.fromName}</span> invited you
                        </p>
                        <p className="text-[11px] text-zinc-500 mt-0.5 font-mono">{invite.roomCode}</p>
                        <button
                          type="button"
                          onClick={() => onAcceptInvite?.(invite)}
                          className="mt-2 px-2.5 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-[11px] text-zinc-950 font-semibold"
                        >
                          Join room
                        </button>
                      </div>
                    ))}
                    {passiveNotifications.slice(0, 6).map((item) => (
                      <div key={`persisted-${item.id}`} className={`rounded-lg border p-2 ${item.isRead ? "border-zinc-800/70 bg-zinc-900/60" : "border-zinc-700/60 bg-zinc-900/80"}`}>
                        <p className={`text-xs ${item.isRead ? "text-zinc-400" : "text-zinc-200"}`}>
                          {notificationLabel(item)}
                        </p>
                        <div className="mt-1.5 flex items-center justify-between">
                          <p className="text-[11px] text-zinc-500">{fmtRelativeTime(item.createdAt)}</p>
                          {!item.isRead && (
                            <button
                              type="button"
                              onClick={() => onMarkNotificationRead(item.id)}
                              disabled={notificationBusy}
                              className="text-[11px] px-2 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Mark read
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    {incomingRequests.length === 0 && (invites?.length || 0) === 0 && passiveNotifications.length === 0 && (
                      <p className="text-xs text-zinc-500 px-2 py-3">No new notifications</p>
                    )}
                  </div>
                </div>
              )}
            </div>
            <button
              onClick={onSignOut}
              className="flex items-center gap-1.5 px-2 sm:px-3 py-2 rounded-lg bg-zinc-900/75 border border-zinc-700/70 text-zinc-300 hover:text-red-300 transition-colors"
            >
              <LogOut size={13} />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-0 max-w-6xl mx-auto p-4 sm:p-6 grid lg:grid-cols-[220px,1fr] gap-4 sm:gap-6">
        <DashboardSidebar
          tabs={tabs}
          tab={tab}
          onSelectTab={selectTab}
          onlineFriends={onlineFriends}
          activeRoomCode={activeRoomCode}
          className="hidden lg:block"
        />

        <section className="glass-panel p-4 sm:p-5 min-h-[30rem]">
          {loading ? (
            <div className="h-56 flex items-center justify-center text-zinc-500 text-sm">Loading settings...</div>
          ) : (
            <>
              {tab === "profile" && (
                <div>
                  <div className="flex items-center gap-3 mb-4">
                    {profilePhotoPreview ? (
                      <img src={profilePhotoPreview} alt="" className="w-14 h-14 rounded-2xl border border-zinc-700 object-cover" />
                    ) : (
                      <div className="w-14 h-14 rounded-2xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center text-amber-300">
                        <UserRound size={20} />
                      </div>
                    )}
                    <div>
                      <p className="text-zinc-100 font-semibold text-lg">{profile?.displayName || "Profile"}</p>
                      <p className="text-zinc-500 text-sm font-mono">@{profile?.username || username}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => photoInputRef.current?.click()}
                          disabled={photoProcessing}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-200 text-xs disabled:opacity-60"
                        >
                          <ImagePlus size={12} />
                          {photoProcessing ? "Processing..." : "Change photo"}
                        </button>
                        {profilePhotoPreview && (
                          <button
                            type="button"
                            onClick={onRemoveProfilePhoto}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <input
                        ref={photoInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={onPickProfilePhoto}
                      />
                    </div>
                  </div>

                  <form onSubmit={onSaveProfile} className="space-y-3">
                    <div>
                      <label className="text-xs text-zinc-500">Display name</label>
                      <input
                        value={profileForm.displayName}
                        onChange={(e) => setProfileForm((prev) => ({ ...prev, displayName: e.target.value }))}
                        className="mt-1 w-full bg-zinc-900/70 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500/50"
                        maxLength={60}
                        required
                      />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500">Bio</label>
                      <textarea
                        value={profileForm.bio}
                        onChange={(e) => setProfileForm((prev) => ({ ...prev, bio: e.target.value }))}
                        className="mt-1 w-full min-h-24 bg-zinc-900/70 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500/50"
                        maxLength={240}
                        placeholder="Write something about your movie taste..."
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={savingProfile}
                      className="inline-flex items-center gap-2 bg-amber-300 hover:bg-amber-200 disabled:opacity-60 text-zinc-950 font-semibold px-5 py-2.5 rounded-xl transition-colors shadow-lg shadow-amber-900/25"
                    >
                      <Check size={14} />
                      {savingProfile ? "Saving..." : "Save profile"}
                    </button>
                  </form>
                </div>
              )}

              {tab === "friends" && (
                <div className="space-y-5">
                  <div>
                    <p className="text-zinc-100 font-semibold">Find friends</p>
                    <div className="mt-2 flex gap-2">
                      <div className="flex-1 flex items-center gap-2 bg-zinc-900/70 border border-zinc-700 rounded-lg px-3">
                        <Search size={14} className="text-zinc-500" />
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          className="flex-1 bg-transparent py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none"
                          placeholder="Search username or name"
                        />
                      </div>
                    </div>
                    {searching && <p className="mt-2 text-xs text-zinc-500">Searching...</p>}
                    {searchResults.length > 0 && (
                      <div className="mt-2 space-y-2">
                        {searchResults.map((item) => (
                          <div key={item.uid} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-700/60 bg-zinc-900/55 px-3 py-2">
                            <div>
                              <p className="text-sm text-zinc-100">{item.displayName}</p>
                              <p className="text-xs text-zinc-500 font-mono">@{item.username || "user"}</p>
                            </div>
                            {item.relationship === "none" && (
                              <button
                                onClick={() => onSendRequest(item.uid)}
                                className="text-xs px-2.5 py-1.5 rounded-lg bg-amber-300 hover:bg-amber-200 text-zinc-950 font-semibold"
                              >
                                <span className="inline-flex items-center gap-1"><UserPlus size={12} /> Add</span>
                              </button>
                            )}
                            {item.relationship !== "none" && (
                              <span className="text-xs px-2 py-1 rounded-lg border border-zinc-700 text-zinc-400 capitalize">{item.relationship}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-zinc-100 font-semibold mb-2">Incoming requests</p>
                    {incomingRequests.length === 0 && <p className="text-xs text-zinc-600">No pending requests</p>}
                    <div className="space-y-2">
                      {incomingRequests.map((item) => (
                        <div key={item.uid} className="flex items-center justify-between rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-3 py-2">
                          <div>
                            <p className="text-sm text-zinc-100">{item.displayName}</p>
                            <p className="text-xs text-zinc-500 font-mono">@{item.username || "user"}</p>
                          </div>
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => onRespondRequest(item.uid, "accept")}
                              className="px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-xs text-white"
                            >
                              Accept
                            </button>
                            <button
                              onClick={() => onRespondRequest(item.uid, "reject")}
                              className="px-2.5 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-100"
                            >
                              Decline
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="text-zinc-100 font-semibold mb-2">Your friends</p>
                    {friends.length === 0 && <p className="text-xs text-zinc-600">No friends yet</p>}
                    <div className="space-y-2">
                      {friends.map((item) => (
                        <div key={item.uid} className="flex items-center justify-between rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${item.online ? "bg-emerald-400" : "bg-zinc-600"}`} />
                            <div>
                              <p className="text-sm text-zinc-100">{item.displayName}</p>
                              <p className="text-xs text-zinc-500 font-mono">@{item.username || "user"}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <select
                              value={relationshipByPartnerUid[item.uid]?.relationshipType || "friends"}
                              onChange={(e) => onUpdateRelationshipTag(item.uid, e.target.value)}
                              disabled={tagUpdatingUid === item.uid}
                              className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-amber-400/50 disabled:opacity-60"
                              title="Tag relationship"
                            >
                              {RELATIONSHIP_TAG_OPTIONS.map((option) => (
                                <option key={option.key} value={option.key}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => onInvite(item.uid)}
                              disabled={!item.online}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-amber-300 hover:bg-amber-200 disabled:opacity-45 disabled:cursor-not-allowed text-zinc-950"
                              title={item.online ? "Invite to watch" : "Friend is offline"}
                            >
                              <span className="inline-flex items-center gap-1"><Radio size={12} /> Invite</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    {friends.length > 0 && (
                      <p className="mt-2 text-xs text-zinc-600">
                        Invite works instantly for online friends.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {tab === "couple" && (
                <div className="space-y-4">
                  {friends.length === 0 && (
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4 text-sm text-zinc-500">
                      Add at least one friend to unlock private Couple Space.
                    </div>
                  )}

                  {friends.length > 0 && (
                    <>
                      <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                        <p className="text-zinc-100 font-semibold mb-3">Private Couple Space</p>
                        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                          <select
                            value={couplePartnerUid}
                            onChange={(e) => setCouplePartnerUid(e.target.value)}
                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-400/50"
                          >
                            {friends.map((friend) => (
                              <option key={friend.uid} value={friend.uid}>
                                @{friend.username || friend.displayName}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => onInvite(couplePartnerUid)}
                            disabled={!couplePartnerProfile?.online}
                            className="px-3 py-2 rounded-lg text-xs font-medium bg-amber-300 hover:bg-amber-200 disabled:opacity-45 disabled:cursor-not-allowed text-zinc-950"
                          >
                            <span className="inline-flex items-center gap-1"><Radio size={12} /> Invite Partner</span>
                          </button>
                          {couplePartnerProfile && (
                            <span className={`text-xs px-2 py-1 rounded-full border ${couplePartnerProfile.online ? "bg-emerald-950/40 text-emerald-400 border-emerald-800/40" : "bg-zinc-900/40 text-zinc-500 border-zinc-700"}`}>
                              {couplePartnerProfile.online ? "Partner online" : "Partner offline"}
                            </span>
                          )}
                        </div>
                      </div>

                      <form onSubmit={onAddWatchlistItem} className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4 space-y-2">
                        <p className="text-zinc-100 font-semibold">Shared Watchlist</p>
                        <input
                          value={watchTitle}
                          onChange={(e) => setWatchTitle(e.target.value)}
                          placeholder="Movie title (required)"
                          maxLength={120}
                          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500/50"
                          required
                        />
                        <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded-lg px-3">
                          <Link2 size={13} className="text-zinc-500" />
                          <input
                            value={watchUrl}
                            onChange={(e) => setWatchUrl(e.target.value)}
                            placeholder="Trailer / OTT link (optional)"
                            maxLength={500}
                            className="flex-1 bg-transparent py-2 text-sm text-zinc-100 focus:outline-none"
                          />
                        </div>
                        <textarea
                          value={watchNotes}
                          onChange={(e) => setWatchNotes(e.target.value)}
                          placeholder="Memory note (optional)"
                          maxLength={260}
                          className="w-full min-h-20 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500/50"
                        />
                        <button
                          type="submit"
                          disabled={coupleBusy}
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-300 hover:bg-amber-200 disabled:opacity-60 text-zinc-950 text-sm font-semibold"
                        >
                          <Plus size={14} />
                          Add to watchlist
                        </button>
                      </form>

                      <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                        <p className="text-zinc-100 font-semibold mb-2">Watchlist items</p>
                        {coupleLoading && <p className="text-xs text-zinc-500">Loading couple space...</p>}
                        {!coupleLoading && (coupleSpace.watchlist?.length || 0) === 0 && (
                          <p className="text-xs text-zinc-600">No items yet. Add your next movie date idea.</p>
                        )}
                        <div className="space-y-2">
                          {(coupleSpace.watchlist || []).map((item) => (
                            <div key={item.id} className="rounded-lg border border-zinc-700/50 bg-zinc-900/40 px-3 py-2">
                              <div className="flex items-start justify-between gap-2">
                                <button
                                  type="button"
                                  onClick={() => onUpdateWatchlistItem(item.id, "toggle_done", !item.done)}
                                  className="inline-flex items-center gap-2 text-left"
                                >
                                  {item.done ? <CheckSquare size={15} className="text-emerald-400" /> : <Square size={15} className="text-zinc-500" />}
                                  <span className={`text-sm ${item.done ? "text-zinc-500 line-through" : "text-zinc-100"}`}>{item.title}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onUpdateWatchlistItem(item.id, "remove")}
                                  className="p-1.5 rounded-lg text-zinc-500 hover:text-red-300 hover:bg-zinc-800 transition-colors"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                              {!!item.notes && <p className="text-xs text-zinc-500 mt-1 ml-7">{item.notes}</p>}
                              {!!item.url && (
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-xs text-amber-300 hover:text-amber-200 mt-1 ml-7 inline-flex"
                                >
                                  Open link
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {tab === "memories" && (
                <div className="space-y-4">
                  <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">This week</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">{fmtDuration(memories.summary?.weekSeconds)}</p>
                    </div>
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">This month</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">{fmtDuration(memories.summary?.monthSeconds)}</p>
                    </div>
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">This year</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">{fmtDuration(memories.summary?.yearSeconds)}</p>
                    </div>
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">All time</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">{fmtDuration(memories.summary?.allSeconds)}</p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                    <p className="text-zinc-100 font-semibold flex items-center gap-2"><Heart size={14} className="text-amber-300" /> Emotional moments</p>
                    {memories.byFriend?.length === 0 && (
                      <p className="text-zinc-600 text-sm mt-2">Watch sessions with friends will appear here automatically.</p>
                    )}

                    <div className="mt-3 space-y-2">
                      {memories.byFriend?.map((item) => (
                        <div key={item.uid} className="rounded-lg border border-zinc-700/50 bg-zinc-900/40 px-3 py-2">
                          <p className="text-sm text-zinc-100">
                            You watched <span className="text-amber-300 font-semibold">{fmtDuration(item.allSeconds)}</span> with @{item.username || item.displayName}
                          </p>
                          <p className="text-xs text-zinc-500 mt-1">
                            Week: {fmtDuration(item.weekSeconds)} · Month: {fmtDuration(item.monthSeconds)} · Year: {fmtDuration(item.yearSeconds)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <form onSubmit={onAddSharedMemory} className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4 space-y-2">
                    <p className="text-zinc-100 font-semibold">Shared memory note</p>
                    {friends.length === 0 ? (
                      <p className="text-xs text-zinc-600">Add friends to create shared memories.</p>
                    ) : (
                      <>
                        <div className="grid sm:grid-cols-2 gap-2">
                          <select
                            value={memoryPartnerUid}
                            onChange={(e) => setMemoryPartnerUid(e.target.value)}
                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-400/50"
                          >
                            {friends.map((friend) => (
                              <option key={friend.uid} value={friend.uid}>
                                @{friend.username || friend.displayName}
                              </option>
                            ))}
                          </select>
                          <input
                            value={memoryRoomCode}
                            onChange={(e) => setMemoryRoomCode(e.target.value.toUpperCase())}
                            placeholder="Room code (optional)"
                            maxLength={8}
                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-400/50 font-mono"
                          />
                        </div>
                        <textarea
                          value={memoryNote}
                          onChange={(e) => setMemoryNote(e.target.value)}
                          placeholder="Write something meaningful, like: We watched this after 3 months apart."
                          maxLength={600}
                          className="w-full min-h-24 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500/50"
                          required
                        />
                        <div className="grid sm:grid-cols-2 gap-2">
                          <select
                            value={memorySessionMode}
                            onChange={(e) => setMemorySessionMode(e.target.value)}
                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-400/50"
                          >
                            <option value="watch">Watch session</option>
                            <option value="podcast">Podcast sync</option>
                            <option value="reading">Co-reading</option>
                            <option value="study">Study session</option>
                          </select>
                          <input
                            value={memoryGenre}
                            onChange={(e) => setMemoryGenre(e.target.value)}
                            placeholder="Genre (optional)"
                            maxLength={48}
                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-400/50"
                          />
                        </div>
                        <div className="grid sm:grid-cols-3 gap-2">
                          <input
                            value={memoryMoodTag}
                            onChange={(e) => setMemoryMoodTag(e.target.value)}
                            placeholder="Mood tag (optional)"
                            maxLength={48}
                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-400/50"
                          />
                          <input
                            value={memoryHighlightTimestamp}
                            onChange={(e) => setMemoryHighlightTimestamp(e.target.value)}
                            placeholder="Highlight HH:MM:SS"
                            maxLength={12}
                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-400/50 font-mono"
                          />
                          <input
                            value={memorySessionMinutes}
                            onChange={(e) => setMemorySessionMinutes(e.target.value.replace(/[^0-9]/g, ""))}
                            placeholder="Session mins"
                            maxLength={4}
                            className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-400/50"
                          />
                        </div>
                        <input
                          value={memoryReactionCount}
                          onChange={(e) => setMemoryReactionCount(e.target.value.replace(/[^0-9]/g, ""))}
                          placeholder="Reaction count (optional)"
                          maxLength={4}
                          className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-400/50"
                        />
                        <button
                          type="submit"
                          disabled={savingMemory}
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-300 hover:bg-amber-200 disabled:opacity-60 text-zinc-950 text-sm font-semibold"
                        >
                          <Plus size={14} />
                          {savingMemory ? "Saving..." : "Save memory note"}
                        </button>
                      </>
                    )}
                  </form>

                  <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                    <p className="text-zinc-100 font-semibold">Shared memory archive</p>
                    {sharedMemories.length === 0 && (
                      <p className="text-xs text-zinc-600 mt-2">No shared memory notes yet.</p>
                    )}
                    <div className="mt-2 space-y-2">
                      {sharedMemories.map((item) => (
                        <div key={item.id} className="rounded-lg border border-zinc-700/50 bg-zinc-900/40 px-3 py-2">
                          <p className="text-sm text-zinc-100">{item.memoryNote}</p>
                          <p className="text-xs text-zinc-500 mt-1">
                            With @{item.partner?.username || item.partner?.displayName || "friend"}
                            {item.roomCode ? ` · Room ${item.roomCode}` : ""}
                            {item.date ? ` · ${new Date(item.date).toLocaleDateString()}` : ""}
                            {item.sessionMode ? ` · ${SESSION_MODE_LABELS[item.sessionMode] || item.sessionMode}` : ""}
                            {item.genre ? ` · ${item.genre}` : ""}
                            {item.moodTag ? ` · Mood: ${item.moodTag}` : ""}
                            {item.highlightTimestamp ? ` · Highlight ${item.highlightTimestamp}` : ""}
                            {item.sessionMinutes ? ` · ${item.sessionMinutes}m` : ""}
                            {item.reactionCount ? ` · ${item.reactionCount} reactions` : ""}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {tab === "intelligence" && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                    <p className="text-zinc-100 font-semibold flex items-center gap-2">
                      <Sparkles size={14} className="text-amber-300" />
                      Relationship Intelligence
                    </p>
                    <p className="text-zinc-500 text-xs mt-1">
                      Experience-layer analytics from your shared sessions and memory notes.
                    </p>
                  </div>

                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">Hours together</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">{relationshipIntel.totalSharedHours.toFixed(1)}h</p>
                    </div>
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">Shared streak</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">{relationshipIntel.streakDays} day{relationshipIntel.streakDays === 1 ? "" : "s"}</p>
                    </div>
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">Longest session</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">
                        {relationshipIntel.longestSessionMinutes > 0 ? `${relationshipIntel.longestSessionMinutes}m` : "Not set"}
                      </p>
                    </div>
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">Dominant genre</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">{relationshipIntel.topGenre}</p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                    <p className="text-zinc-100 font-semibold mb-2">AI-generated story</p>
                    <p className="text-sm text-zinc-300 leading-relaxed">{relationshipIntel.yearStory}</p>
                    <div className="mt-3 space-y-1.5">
                      {relationshipIntel.relationshipInsights.map((line, idx) => (
                        <p key={`insight-${idx}`} className="text-xs text-zinc-500">
                          {line}
                        </p>
                      ))}
                    </div>
                    <p className="mt-3 text-xs text-amber-300">{relationshipIntel.anniversaryText}</p>
                  </div>

                  <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                    <p className="text-zinc-100 font-semibold mb-2">Compatibility index</p>
                    {relationshipIntel.compatibilityCards.length === 0 && (
                      <p className="text-xs text-zinc-600">Add friends and save shared memories to unlock compatibility scoring.</p>
                    )}
                    <div className="space-y-2">
                      {relationshipIntel.compatibilityCards.slice(0, 6).map((item) => (
                        <div key={item.uid} className="rounded-lg border border-zinc-700/50 bg-zinc-900/45 px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm text-zinc-100">{item.label}</p>
                            <span className="text-xs px-2 py-0.5 rounded-full border border-emerald-500/35 bg-emerald-500/10 text-emerald-200">
                              {item.compatibilityIndex}%
                            </span>
                          </div>
                          <p className="text-xs text-zinc-500 mt-1">
                            {item.hours.toFixed(1)}h together · {item.streakDays}d streak · Genre: {item.favoriteGenre} · Mood: {item.favoriteMood}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                    <p className="text-zinc-100 font-semibold mb-2">Emotional timeline</p>
                    {relationshipIntel.timeline.length === 0 && (
                      <p className="text-xs text-zinc-600">No timeline yet. Save a shared memory with mood, timestamp, and reactions.</p>
                    )}
                    <div className="space-y-2">
                      {relationshipIntel.timeline.map((item) => (
                        <div key={item.id} className="rounded-lg border border-zinc-700/50 bg-zinc-900/45 px-3 py-2">
                          <p className="text-sm text-zinc-100">{item.note}</p>
                          <p className="text-xs text-zinc-500 mt-1">
                            {item.label} · {new Date(item.date).toLocaleDateString()} · {item.sessionMode}
                            {item.genre ? ` · ${item.genre}` : ""}
                            {item.highlightTimestamp ? ` · Highlight ${item.highlightTimestamp}` : ""}
                            {item.sessionMinutes ? ` · ${item.sessionMinutes}m` : ""}
                            {item.reactionCount ? ` · ${item.reactionCount} reactions` : ""}
                            {item.roomCode ? ` · Room ${item.roomCode}` : ""}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid lg:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                      <p className="text-zinc-100 font-semibold mb-2">Milestone badges</p>
                      <div className="flex flex-wrap gap-2">
                        {relationshipIntel.milestones.map((badge) => (
                          <span
                            key={badge.key}
                            className={`text-xs px-2.5 py-1 rounded-full border ${badge.achieved
                              ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
                              : "border-zinc-700 bg-zinc-900/70 text-zinc-500"
                            }`}
                          >
                            {badge.achieved ? "Unlocked" : "Locked"} · {badge.label}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                      <p className="text-zinc-100 font-semibold mb-2">Mode expansion tracker</p>
                      <p className="text-xs text-zinc-500">Podcast sync, co-reading, and study sessions are now tracked alongside watch sessions.</p>
                      <div className="mt-3 space-y-2">
                        {relationshipIntel.modeUsage.map((mode) => (
                          <div key={mode.mode} className="flex items-center justify-between rounded-lg border border-zinc-700/50 bg-zinc-900/45 px-3 py-2">
                            <span className="text-sm text-zinc-200">{mode.label}</span>
                            <span className="text-xs text-zinc-400">{mode.count} memories</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {tab === "notifications" && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-zinc-100 font-semibold flex items-center gap-2">
                        <Bell size={14} className="text-amber-300" />
                        Notifications
                      </p>
                      <button
                        type="button"
                        onClick={onMarkAllNotificationsRead}
                        disabled={notificationBusy || notificationsUnread === 0}
                        className="text-xs px-2.5 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Mark all read
                      </button>
                    </div>
                    <p className="text-zinc-500 text-xs mt-1">
                      Friend requests, room invites, and social updates.
                    </p>
                  </div>

                  {(incomingRequests.length > 0 || (invites?.length || 0) > 0) && (
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4 space-y-3">
                      <p className="text-zinc-100 text-sm font-medium">Action required</p>
                      {incomingRequests.map((item) => (
                        <div key={`notif-incoming-${item.uid}`} className="rounded-lg border border-zinc-700/60 bg-zinc-900/60 p-3">
                          <p className="text-sm text-zinc-100">
                            @{item.username || "user"} sent you a friend request
                          </p>
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => onRespondRequest(item.uid, "accept")}
                              className="px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-xs text-zinc-950 font-semibold"
                            >
                              Accept
                            </button>
                            <button
                              type="button"
                              onClick={() => onRespondRequest(item.uid, "reject")}
                              className="px-2.5 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-100"
                            >
                              Decline
                            </button>
                          </div>
                        </div>
                      ))}
                      {(invites || []).map((invite) => (
                        <div key={`notif-invite-${invite.id}`} className="rounded-lg border border-zinc-700/60 bg-zinc-900/60 p-3">
                          <p className="text-sm text-zinc-100">
                            {invite.fromUsername ? `@${invite.fromUsername}` : invite.fromName} invited you
                          </p>
                          <p className="text-xs text-zinc-500 mt-1 font-mono">{invite.roomCode}</p>
                          <button
                            type="button"
                            onClick={() => onAcceptInvite?.(invite)}
                            className="mt-2 px-2.5 py-1.5 rounded-lg bg-amber-300 hover:bg-amber-200 text-xs text-zinc-950 font-semibold"
                          >
                            Join room
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="space-y-2">
                    {notifications.length === 0 && (
                      <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4 text-sm text-zinc-500">
                        No notifications yet.
                      </div>
                    )}
                    {notifications.map((item) => (
                      <div key={`notif-${item.id}`} className={`rounded-xl border p-3 ${item.isRead ? "border-zinc-800/60 bg-zinc-900/45" : "border-zinc-700/60 bg-zinc-900/60"}`}>
                        <p className={`text-sm ${item.isRead ? "text-zinc-400" : "text-zinc-100"}`}>
                          {notificationLabel(item)}
                        </p>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <p className="text-xs text-zinc-500">{fmtRelativeTime(item.createdAt)}</p>
                          <div className="flex items-center gap-2">
                            {item.type === "room_invite" && item.roomCode && (
                              <button
                                type="button"
                                onClick={() => onJoinRoomFromNotification(item)}
                                className="px-2.5 py-1.5 rounded-lg bg-amber-300 hover:bg-amber-200 text-xs text-zinc-950 font-semibold"
                              >
                                Join
                              </button>
                            )}
                            {!item.isRead && (
                              <button
                                type="button"
                                onClick={() => onMarkNotificationRead(item.id)}
                                disabled={notificationBusy}
                                className="px-2.5 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                Mark read
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {tab === "activity" && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                    <p className="text-zinc-100 font-semibold flex items-center gap-2">
                      <Bell size={14} className="text-amber-300" />
                      Your activity
                    </p>
                    <p className="text-zinc-500 text-xs mt-1">
                      Recent account actions, invites, and room activity.
                    </p>
                  </div>

                  <div className="space-y-2">
                    {activityFeed.length === 0 && (
                      <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4 text-sm text-zinc-500">
                        No activity yet.
                      </div>
                    )}
                    {activityFeed.map((item, idx) => (
                      <div key={`${item.type}-${item.occurredAt}-${idx}`} className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-3">
                        <p className="text-sm text-zinc-100 capitalize">{activityLabel(item)}</p>
                        <p className="text-xs text-zinc-500 mt-1">
                          {item.roomCode ? `Room ${item.roomCode} · ` : ""}
                          {fmtRelativeTime(item.occurredAt)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {tab === "metadata" && (
                <div className="space-y-4">
                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">Users</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">{projectOverview.counts?.users ?? 0}</p>
                    </div>
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">Rooms / Active</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">
                        {(projectOverview.counts?.rooms ?? 0)} / {(projectOverview.counts?.activeRooms ?? 0)}
                      </p>
                    </div>
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">Relationships</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">{projectOverview.counts?.relationships ?? 0}</p>
                    </div>
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">Shared Memories</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">{projectOverview.counts?.sharedMemories ?? 0}</p>
                    </div>
                    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 p-3">
                      <p className="text-xs text-zinc-500">Unread notifications</p>
                      <p className="text-zinc-100 text-lg font-semibold mt-1">{projectOverview.counts?.notifications ?? 0}</p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                    <p className="text-zinc-100 font-semibold mb-2">Recent activity (you)</p>
                    {(projectOverview.recentActivity || []).length === 0 && (
                      <p className="text-zinc-600 text-sm">No activity yet.</p>
                    )}
                    <div className="space-y-2">
                      {(projectOverview.recentActivity || []).map((item, idx) => (
                        <div key={`${item.type}-${item.occurredAt}-${idx}`} className="rounded-lg border border-zinc-700/50 bg-zinc-900/40 px-3 py-2">
                          <p className="text-sm text-zinc-100">{item.type}</p>
                          <p className="text-xs text-zinc-500 mt-1">
                            {item.roomCode ? `Room ${item.roomCode} · ` : ""}
                            {item.occurredAt ? new Date(item.occurredAt).toLocaleString() : ""}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4">
                    <p className="text-zinc-100 font-semibold">Architecture note</p>
                    <p className="text-zinc-400 text-sm mt-2">
                      Sync state remains in live server memory for low-latency control. Long-term entities are stored in MongoDB:
                      users, rooms, participants, relationships, invites, activity, video metadata, and shared memories.
                    </p>
                  </div>
                </div>
              )}

              {tab === "settings" && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-3 text-sm text-zinc-400">
                    <p className="text-zinc-200 font-medium flex items-center gap-2">
                      <Ghost size={14} className="text-amber-300" />
                      Privacy and alerts
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">Tune notifications and visibility the way you like.</p>
                  </div>
                  <Toggle
                    checked={!!profile?.settings?.inviteNotifications}
                    onChange={() => onToggleSetting("inviteNotifications")}
                    label="Invite notifications"
                    help="Get real-time alerts when friends invite you to rooms"
                  />
                  <Toggle
                    checked={!!profile?.settings?.memoryNudges}
                    onChange={() => onToggleSetting("memoryNudges")}
                    label="Memory nudges"
                    help="Enable emotional watch-time highlights in your activity"
                  />
                  <Toggle
                    checked={!profile?.settings?.showOnlineStatus}
                    onChange={() => onToggleSetting("showOnlineStatus")}
                    label="Ghost mode (Snap style)"
                    help="Hide your online status from friends"
                  />
                  <Toggle
                    checked={!!pushEnabled}
                    onChange={() => onTogglePushNotifications(!pushEnabled)}
                    label="Browser push notifications"
                    help="Get browser alerts for invites and friend requests"
                  />

                  <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-3 text-sm text-zinc-400">
                    <p className="text-zinc-200 font-medium flex items-center gap-2"><Sparkles size={14} className="text-amber-300" /> Suggested next upgrades</p>
                    <p className="mt-2">1. Add mobile app with FCM push for true background notifications.</p>
                    <p>2. Add couple anniversaries + relationship timeline highlights.</p>
                    <p>3. Add AI picks based on your shared watchlist taste.</p>
                  </div>

                  <button
                    onClick={onSignOut}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm shadow-lg shadow-red-900/20"
                  >
                    <LogOut size={14} />
                    Sign out
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </main>

      {showMobileSidebar && (
        <div className="lg:hidden fixed inset-x-0 top-[4.2rem] bottom-0 z-40">
          <div className="absolute inset-0 bg-black/45 backdrop-blur-[1px]" />
          <div ref={mobileMenuRef} className="absolute left-3 right-3 top-3">
            <DashboardSidebar
              tabs={tabs}
              tab={tab}
              onSelectTab={selectTab}
              onlineFriends={onlineFriends}
              activeRoomCode={activeRoomCode}
              className="max-h-[calc(100dvh-6rem)] overflow-y-auto"
            />
          </div>
        </div>
      )}
    </div>
  );
}
