import { useState, useEffect, useCallback } from "react";
import { loadSession, loadUsername, saveUsername, clearSession } from "../utils/storage";

const BOOTSTRAP_WARMUP_DELAYS_MS = [1200, 1800, 2000];
const normalizeKnownUsername = (value) => String(value || "").trim().toLowerCase();

export function useAuthSession({
  addToast,
  apiClient,
  socketApiRef,
  syncIncomingFriendRequests,
  syncLobbyMemoryStats,
  resetFriendsState,
  resetLobbyMemoryStats,
  setView,
  setRoomCode,
  setRoomType,
  setSessionMode,
  setRoomMoodTag,
  setRoomContentUrl,
  setRoomContentType,
  setRoomCreatedBy,
  setRoomMaxParticipants,
  setInitialVideoMetadata,
  setInitialAudioState,
  setInitialDocument,
  setInitialReadingState,
  setInitialReadingPage,
  setIncomingInvites,
  setSavedCode,
}) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [username, setUsername] = useState(loadUsername());
  const [isAdmin, setIsAdmin] = useState(false);
  const [needUsername, setNeedUsername] = useState(false);
  const [emailVerificationRequired, setEmailVerificationRequired] = useState(false);
  const [verificationActionLoading, setVerificationActionLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);

  const fetchMyProfile = useCallback(async (token) => {
    const data = await apiClient("/api/me", { token, timeoutMs: 5000 });
    return data.profile || null;
  }, [apiClient]);

  const bootstrapAuthenticatedSession = useCallback(async (token, activeUser) => {
    const saved = loadSession();
    setSavedCode(saved);

    let nextProfile = null;
    let profileLoadFailed = false;
    try {
      nextProfile = await fetchMyProfile(token);
    } catch (error) {
      profileLoadFailed = true;
      addToast(error.message || "Could not load profile", "error");
    }

    if (nextProfile) {
      setProfile(nextProfile);
      setIsAdmin(Boolean(nextProfile?.isAdmin));
    }

    const backendUsername = normalizeKnownUsername(nextProfile?.username);
    const localUsername = normalizeKnownUsername(loadUsername());
    const currentUsername = normalizeKnownUsername(username);
    const resolvedUsername = backendUsername || currentUsername || localUsername;

    if (backendUsername) {
      saveUsername(backendUsername);
    }

    await syncIncomingFriendRequests(token, { silent: true });
    await syncLobbyMemoryStats(token, { silent: true });

    if (!resolvedUsername) {
      if (profileLoadFailed) {
        setNeedUsername(false);
        socketApiRef.current.cleanupSocket();
        return;
      }
      setNeedUsername(true);
      socketApiRef.current.cleanupSocket();
      return;
    }

    setUsername(resolvedUsername);
    setNeedUsername(false);
    if (!socketApiRef.current.socketRef.current || !socketApiRef.current.socketRef.current.connected) {
      socketApiRef.current.connectSocket(token, resolvedUsername);
    }
  }, [fetchMyProfile, syncIncomingFriendRequests, syncLobbyMemoryStats, addToast, socketApiRef, username]);

  // Initial load
  useEffect(() => {
    const init = async () => {
      setAuthLoading(true);
      const token = localStorage.getItem("2-gather_token");
      const savedUserStr = localStorage.getItem("2-gather_user");
      
      if (token && savedUserStr) {
        try {
          const savedUser = JSON.parse(savedUserStr);
          setUser(savedUser);
          await bootstrapAuthenticatedSession(token, savedUser);
        } catch (error) {
          console.error("Auth init error:", error);
          handleSignOut();
        }
      } else {
        handleSignOut(false);
      }
      setAuthLoading(false);
    };
    init();
  }, [bootstrapAuthenticatedSession]);

  const handleLoginSuccess = async (token, loggedInUser) => {
    setAuthLoading(true);
    localStorage.setItem("2-gather_token", token);
    localStorage.setItem("2-gather_user", JSON.stringify(loggedInUser));
    setUser(loggedInUser);
    await bootstrapAuthenticatedSession(token, loggedInUser);
    setAuthLoading(false);
  };

  const handleUsernameSet = useCallback(async (uname) => {
    try {
      const token = localStorage.getItem("2-gather_token");
      if (!token) throw new Error("Please sign in first");
      
      const res = await apiClient("/api/username/claim", {
        method: "POST",
        body: { username: uname },
        token,
      });
      const claimed = String(res?.profile?.username || uname).trim().toLowerCase();
      saveUsername(claimed);
      setUsername(claimed);
      setNeedUsername(false);
      socketApiRef.current.connectSocket(token, claimed);
      return { success: true };
    } catch (e) {
      addToast(e.message || "Could not claim username", "error");
      return {
        success: false,
        status: e?.status ?? e?.response?.status ?? null,
        message: e?.message || "Could not claim username",
      };
    }
  }, [apiClient, addToast, socketApiRef]);

  const handleResendVerification = useCallback(async () => {}, []);
  const handleRefreshVerification = useCallback(async () => {}, []);

  const handleSignOut = useCallback((clearStorage = true) => {
    if (clearStorage) {
      localStorage.removeItem("2-gather_token");
      localStorage.removeItem("2-gather_user");
    }
    clearSession();
    setSavedCode(null);
    setIncomingInvites([]);
    resetFriendsState();
    socketApiRef.current.cleanupSocket();
    setUser(null);
    setView("lobby");
    setRoomCode(null);
    setProfile(null);
    setRoomType("friends");
    setSessionMode("watch");
    setRoomMoodTag("");
    setRoomContentUrl("");
    setRoomContentType("unknown");
    setRoomCreatedBy("");
    setRoomMaxParticipants(6);
    setInitialVideoMetadata(null);
    setInitialAudioState(null);
    setInitialDocument(null);
    setInitialReadingState(null);
    setInitialReadingPage(1);
    setEmailVerificationRequired(false);
    resetFriendsState();
    resetLobbyMemoryStats();
    setIsAdmin(false);
  }, [resetFriendsState, setSavedCode, socketApiRef]);

  const avatarUrl = profile?.photoURL || user?.photoURL || "";

  return {
    user, setUser, profile, setProfile, username, setUsername, isAdmin, needUsername,
    emailVerificationRequired, verificationActionLoading, authLoading, avatarUrl,
    handleUsernameSet, handleResendVerification, handleRefreshVerification, handleSignOut,
    handleLoginSuccess
  };
}
