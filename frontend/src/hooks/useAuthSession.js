/**
 * Authentication/session bootstrap for the frontend. This hook manages the
 * Firebase identity listener, backend profile hydration, email-verification
 * gating, username setup flow, and the bridge into socket/session startup.
 */

import { useState, useEffect, useCallback } from "react";
import { onIdTokenChanged, signOut, sendEmailVerification } from "firebase/auth";
import { auth } from "../firebase.js";
import { buildApiUrl } from "../config/constants";
import { loadSession, loadUsername, saveUsername, clearSession } from "../utils/storage";

/**
 * Creates authenticated session state plus username and verification actions.
 * `onIdTokenChanged` is used instead of `onAuthStateChanged` so token refreshes
 * also run through the same bootstrap logic when backend auth needs a fresh ID token.
 * @param {object} deps - Hook dependencies including API helpers, socket helpers, and state setters.
 * @returns {object} Auth state, derived profile info, and auth-related action helpers.
 */
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
  const [user,setUser]=useState(null);
  const [profile,setProfile]=useState(null);
  const [username,setUsername]=useState(loadUsername());
  const [isAdmin,setIsAdmin]=useState(false);
  const [needUsername,setNeedUsername]=useState(false);
  const [emailVerificationRequired,setEmailVerificationRequired]=useState(false);
  const [verificationActionLoading,setVerificationActionLoading]=useState(false);
  const [authLoading,setAuthLoading]=useState(true);

  /**
   * Fetches the authenticated user's backend profile from `/api/me`.
   * @param {string} token - Firebase ID token for the current user.
   * @returns {Promise<any | null>} Backend profile object or null.
   */
  const fetchMyProfile=useCallback(async(token)=>{
    const res=await fetch(buildApiUrl("/api/me"),{
      headers:{Authorization:`Bearer ${token}`},
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.error||data.message||`Request failed (${res.status})`);
    return data.profile||null;
  },[]);

  /**
   * Bootstraps the full authenticated frontend session from a Firebase user.
   * This restores the saved room code, loads the backend profile, refreshes
   * friend/lobby data, and opens the socket connection once a username exists.
   * @param {import('firebase/auth').User} fbUser - Authenticated Firebase user.
   * @param {{ forceTokenRefresh?: boolean, silentProfileErrors?: boolean }} [options={}] - Bootstrap behavior flags.
   * @returns {Promise<void>} Resolves after session state has been hydrated.
   */
  const bootstrapAuthenticatedSession=useCallback(async(fbUser,{forceTokenRefresh=false,silentProfileErrors=false}={})=>{
    // Auth bootstrap keeps backend profile state authoritative: username/admin
    // flags/friend requests all come from the API before we open realtime state.
    const token=await fbUser.getIdToken(forceTokenRefresh);
    // Restore the same-tab room code so reconnect/rejoin logic knows which room to resume.
    const saved=loadSession();
    setSavedCode(saved);

    let profile=null;
    try{
      profile=await fetchMyProfile(token);
    }catch(error){
      if(!silentProfileErrors){
        addToast(error.message||"Could not load profile","error");
      }
    }
    setProfile(profile);

    const backendUsername=String(profile?.username||"").trim().toLowerCase();
    const localUsername=loadUsername().trim().toLowerCase();
    const resolvedUsername=backendUsername||localUsername;

    if(backendUsername){
      saveUsername(backendUsername);
    }

    setIsAdmin(Boolean(profile?.isAdmin));
    await syncIncomingFriendRequests(token,{silent:true});
    await syncLobbyMemoryStats(token,{silent:true});

    if(!resolvedUsername){
      setNeedUsername(true);
      socketApiRef.current.cleanupSocket();
      return;
    }

    setUsername(resolvedUsername);
    setNeedUsername(false);
    if(!socketApiRef.current.socketRef.current||!socketApiRef.current.socketRef.current.connected){
      socketApiRef.current.connectSocket(token,resolvedUsername);
    }
  },[fetchMyProfile,syncIncomingFriendRequests,syncLobbyMemoryStats,addToast,socketApiRef]);

  // The ID-token listener is the root auth decision tree: signed out, unverified email, missing username, or fully bootstrapped session.
  useEffect(()=>{
    const unsub=onIdTokenChanged(auth,async fbUser=>{
      try{
        if(fbUser){
          // Email/password users are gated on verification before room access;
          // social providers skip this branch and go straight to bootstrap.
          const isPasswordProvider=fbUser.providerData?.some(p=>p.providerId==="password");
          if(isPasswordProvider&&!fbUser.emailVerified){
            setUser(fbUser);
            setEmailVerificationRequired(true);
            setNeedUsername(false);
            setIsAdmin(false);
            setProfile(null);
            socketApiRef.current.cleanupSocket();
            setAuthLoading(false);
            return;
          }

          setEmailVerificationRequired(false);
          setUser(fbUser);
          await bootstrapAuthenticatedSession(fbUser);
        }else{
          // Signing out must clear every room-scoped state bucket so a later
          // login never inherits stale playback/chat/session data.
          setUser(null);socketApiRef.current.cleanupSocket();clearSession();setView("lobby");setRoomCode(null);
          setSavedCode(null);
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
          setIncomingInvites([]);
          resetFriendsState();
          resetLobbyMemoryStats();
          setIsAdmin(false);
        }
      }catch(error){
        socketApiRef.current.cleanupSocket();
        addToast(error.message||"Authentication setup failed","error");
      }
      setAuthLoading(false);
    });
    return()=>{unsub();socketApiRef.current.cleanupSocket();};
  },[bootstrapAuthenticatedSession,addToast,socketApiRef]);

  /**
   * Claims a username through the backend and reconnects sockets with that username.
   * @param {string} uname - Desired username entered by the user.
   * @returns {Promise<{ success: true } | { success: false, status: number | null, message: string }>} Claim outcome for UI-specific error handling.
   */
  const handleUsernameSet=useCallback(async(uname)=>{
    try{
      const res=await apiClient("/api/username/claim",{method:"POST",body:{username:uname}});
      const claimed=String(res?.profile?.username||uname).trim().toLowerCase();
      saveUsername(claimed);
      setUsername(claimed);
      setNeedUsername(false);
      const token=await auth.currentUser?.getIdToken();
      if(token)socketApiRef.current.connectSocket(token,claimed);
      return { success:true };
    }catch(e){
      addToast(e.message||"Could not claim username","error");
      return {
        success:false,
        status:e?.status ?? e?.response?.status ?? null,
        message:e?.message||"Could not claim username",
      };
    }
  },[apiClient,addToast,socketApiRef]);

  /**
   * Sends another email verification message for the current Firebase user.
   * @returns {Promise<void>} Resolves after the resend attempt completes.
   */
  const handleResendVerification=useCallback(async()=>{
    const current=auth.currentUser;
    if(!current){
      addToast("No authenticated user","error");
      return;
    }
    setVerificationActionLoading(true);
    try{
      await sendEmailVerification(current);
      addToast("Verification email sent again","success");
    }catch(e){
      addToast(e.message||"Could not resend verification email","error");
    }finally{
      setVerificationActionLoading(false);
    }
  },[addToast]);

  /**
   * Reloads the current Firebase user and continues bootstrap once verification succeeds.
   * @returns {Promise<void>} Resolves after verification refresh handling completes.
   */
  const handleRefreshVerification=useCallback(async()=>{
    const current=auth.currentUser;
    if(!current){
      addToast("No authenticated user","error");
      return;
    }
    setVerificationActionLoading(true);
    try{
      await current.reload();
      const refreshed=auth.currentUser;
      if(!refreshed?.emailVerified){
        addToast("Email is still not verified","info");
        return;
      }
      setEmailVerificationRequired(false);
      setUser(refreshed);
      await bootstrapAuthenticatedSession(refreshed,{forceTokenRefresh:true});
      setView("lobby");
      addToast("Email verified successfully","success");
    }catch(e){
      addToast(e.message||"Could not refresh verification status","error");
    }finally{
      setVerificationActionLoading(false);
    }
  },[bootstrapAuthenticatedSession,addToast]);

  /**
   * Signs the user out and clears saved room/invite/friend state first.
   * The saved-room clear prevents a future login from inheriting stale `savedCode`.
   * @returns {void}
   */
  const handleSignOut=useCallback(()=>{
    clearSession();
    setSavedCode(null);
    setIncomingInvites([]);
    resetFriendsState();
    socketApiRef.current.cleanupSocket();
    signOut(auth);
  },[resetFriendsState,setSavedCode,socketApiRef]);

  const avatarUrl=profile?.photoURL||user?.photoURL||"";

  return {
    user,
    setUser,
    profile,
    setProfile,
    username,
    setUsername,
    isAdmin,
    needUsername,
    emailVerificationRequired,
    verificationActionLoading,
    authLoading,
    avatarUrl,
    handleUsernameSet,
    handleResendVerification,
    handleRefreshVerification,
    handleSignOut,
  }
}
