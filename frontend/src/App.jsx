/**
 * Lumiere v4
 * - Unique @usernames (authoritative on backend profile)
 * - Sync indicator in header beside Live (shows all members' times + gap warning)
 * - Emoji picker fixed (position:fixed, no overflow clipping)
 * - Offline detection: auto-pause + system message with username
 * - Proper sync: server is single source of truth, hard-seek if >2s gap
 */

import { Component, useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";
import {
  onIdTokenChanged,
  signOut,
  sendEmailVerification,
} from "firebase/auth";
import { io } from "socket.io-client";
import { auth } from "./firebase.js";
import DashboardView from "./DashboardView.jsx";
import CoReadingPdfViewer, { getPdfPageCountFromArrayBuffer } from "./CoReadingPdfViewer.jsx";
import { getSessionEngine } from "./engines/index.js";
import { extractYouTubeId } from "./engines/engineUtils.js";
import {
  SERVER_URL, MAX_MESSAGES, MAX_VIDEO_TIME,
  SESSION_KEY, USERNAME_KEY, PUSH_PREF_KEY,
  QUICK_EMOJIS, ICE_CONFIG,
} from "./config/constants";
import {
  PRIVATE_ROOM_MODES, SESSION_MODES,
  ROOM_MOOD_OPTIONS, SESSION_PRESET_MESSAGES,
  ROOM_TYPE_LABELS, SESSION_MODE_LABELS,
} from "./config/roomModes";
import { fmt, formatDurationLabel } from "./utils/media";
import {
  normalizeCode, isHttpUrl, isYoutubeUrl,
  isPdfUrl, isBlobUrl,
  isDirectMediaUrl,
} from "./utils/url";
import {
  guessDocumentFileName, buildDocumentSignature,
  isSharedUploadUrl,
} from "./utils/document";
import { getBufferedAheadSeconds } from "./utils/buffer";
import {
  Film, MessageSquare, LogOut, Copy, Check,
  Play, Pause, SkipBack, SkipForward, Maximize, Minimize,
  Users, UserPlus, Bell, Wifi, WifiOff, Upload, Send, X, ChevronRight,
  Menu, Mic, MicOff, Video, VideoOff, Phone, PhoneOff,
  Volume2, VolumeX, Bookmark, GripHorizontal, Clock,
  Lock, Headphones, Library, Link2, FileText,
} from "lucide-react";
import Toasts from "./components/Toasts";
import UsernameSetup from "./components/UsernameSetup";
import PresetPanel from "./components/PresetPanel";
import HeaderNotifications from "./components/HeaderNotifications";
import LandingView from "./views/LandingView";
import VerifyEmailView from "./views/VerifyEmailView";
import RoomPendingView from "./views/RoomPendingView";
import LobbyView from "./views/LobbyView";
import VideoTile from "./components/VideoTile";
import DraggableCallWindow from "./components/DraggableCallWindow";
import SyncIndicator from "./components/SyncIndicator";
import EmojiPickerPortal from "./components/EmojiPickerPortal";
import ChatMessage from "./components/ChatMessage";
import RoomErrorBoundary from "./components/RoomErrorBoundary";
import useToast from "./hooks/useToast";
import RoomView from "./views/RoomView";

// ─── Storage helpers ──────────────────────────────────────────────────────────
const saveSession  = c => { try{sessionStorage.setItem(SESSION_KEY,c);}catch(_){} };
const loadSession  = () => { try{return sessionStorage.getItem(SESSION_KEY);}catch(_){return null;} };
const clearSession = () => { try{sessionStorage.removeItem(SESSION_KEY);}catch(_){} };
const saveUsername  = u => { try{localStorage.setItem(USERNAME_KEY,u);}catch(_){} };
const loadUsername  = () => { try{return localStorage.getItem(USERNAME_KEY)||"";}catch(_){return "";} };
const savePushPref = enabled => { try{localStorage.setItem(PUSH_PREF_KEY,enabled?"1":"0");}catch(_){} };
const loadPushPref = () => { try{return localStorage.getItem(PUSH_PREF_KEY)==="1";}catch(_){return false;} };

// ─── Toast ────────────────────────────────────────────────────────────────────
// ─── Lobby ────────────────────────────────────────────────────────────────────
// ─── WebRTC Hook ──────────────────────────────────────────────────────────────
// ─── Room View ────────────────────────────────────────────────────────────────
// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App(){
  // App owns cross-screen orchestration: auth, socket lifecycle, lobby state,
  // and which top-level view to render. Media sync stays inside RoomView.
  const{toasts,addToast,removeToast}=useToast();
  const[user,setUser]=useState(null);
  const[profile,setProfile]=useState(null);
  const[username,setUsername]=useState(loadUsername());
  const[isAdmin,setIsAdmin]=useState(false);
  const[needUsername,setNeedUsername]=useState(false);
  const[emailVerificationRequired,setEmailVerificationRequired]=useState(false);
  const[verificationActionLoading,setVerificationActionLoading]=useState(false);
  const[authLoading,setAuthLoading]=useState(true);
  const socketRef=useRef(null);
  const[view,setView]=useState("lobby");
  const[dashboardInitialTab,setDashboardInitialTab]=useState("profile");
  const[roomCode,setRoomCode]=useState(null);
  const[roomType,setRoomType]=useState("friends");
  const[sessionMode,setSessionMode]=useState("watch");
  const[roomMoodTag,setRoomMoodTag]=useState("");
  const[roomContentUrl,setRoomContentUrl]=useState("");
  const[roomContentType,setRoomContentType]=useState("unknown");
  const[roomCreatedBy,setRoomCreatedBy]=useState("");
  const[roomMaxParticipants,setRoomMaxParticipants]=useState(6);
  const[roomUsers,setRoomUsers]=useState([]);
  const[initialVideoState,setInitialVideoState]=useState(null);
  const[initialAudioState,setInitialAudioState]=useState(null);
  const[initialMessages,setInitialMessages]=useState([]);
  const[initialVideoMetadata,setInitialVideoMetadata]=useState(null);
  const[initialDocument,setInitialDocument]=useState(null);
  const[initialReadingPage,setInitialReadingPage]=useState(1);
  const[initialReadingState,setInitialReadingState]=useState(null);
  const[roomPending,setRoomPending]=useState(false);
  const[roomPendingLabel,setRoomPendingLabel]=useState("Creating room...");
  const[savedCode,setSavedCode]=useState(null);
  const[socketConnected,setSocketConnected]=useState(false);
  const[incomingInvites,setIncomingInvites]=useState([]);
  const[incomingFriendRequests,setIncomingFriendRequests]=useState([]);
  const[friendRequestBusyByUid,setFriendRequestBusyByUid]=useState({});
  const[lobbyMemoryStats,setLobbyMemoryStats]=useState({
    sharedHoursMonth:0,
    longestSessionSeconds:0,
    longestSessionLabel:"0m",
    streakDays:0,
  });
  const[browserPushEnabled,setBrowserPushEnabled]=useState(loadPushPref());
  const pendingInviteFriendRef=useRef(null);
  const roomPendingRef=useRef(false);
  const pendingTimeoutRef=useRef(null);
  const pendingLabelRef=useRef("");

  const clearPendingTimer=useCallback(()=>{
    if(pendingTimeoutRef.current){
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current=null;
    }
  },[]);

  const startPendingTimer=useCallback((label)=>{
    // Pending screens always need a timeout path so a lost socket ack does not
    // strand the user forever on "creating" or "joining".
    clearPendingTimer();
    pendingLabelRef.current=label;
    pendingTimeoutRef.current=setTimeout(()=>{
      setRoomPending(prev=>{
        if(!prev)return prev;
        setView("lobby");
        addToast(`${pendingLabelRef.current} timed out. Please try again.`,"error");
        return false;
      });
    },12000);
  },[clearPendingTimer,addToast]);

  useEffect(()=>()=>{clearPendingTimer();},[clearPendingTimer]);
  useEffect(()=>{
    if(!roomPending)clearPendingTimer();
  },[roomPending,clearPendingTimer]);
  useEffect(()=>{
    if(roomPendingLabel)pendingLabelRef.current=roomPendingLabel;
  },[roomPendingLabel]);
  useEffect(()=>{
    roomPendingRef.current=roomPending;
  },[roomPending]);

  const apiClient=useCallback(async(path,{method="GET",body}={})=>{
    // Centralized authenticated JSON fetch helper used by lobby/dashboard flows.
    const currentUser=auth.currentUser;
    if(!currentUser)throw new Error("Please sign in first");
    const token=await currentUser.getIdToken();
    const res=await fetch(`${SERVER_URL}${path}`,{
      method,
      headers:{
        Authorization:`Bearer ${token}`,
        "Content-Type":"application/json",
      },
      body:body?JSON.stringify(body):undefined,
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.error||data.message||`Request failed (${res.status})`);
    return data;
  },[]);

  const fetchMyProfile=useCallback(async(token)=>{
    const res=await fetch(`${SERVER_URL}/api/me`,{
      headers:{Authorization:`Bearer ${token}`},
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.error||data.message||`Request failed (${res.status})`);
    return data.profile||null;
  },[]);

  const fetchFriendsSnapshot=useCallback(async(token)=>{
    const res=await fetch(`${SERVER_URL}/api/friends`,{
      headers:{Authorization:`Bearer ${token}`},
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.error||data.message||`Request failed (${res.status})`);
    return data;
  },[]);

  const fetchWatchSessionsSnapshot=useCallback(async(token,limit=120)=>{
    const res=await fetch(`${SERVER_URL}/api/watch-sessions?limit=${Math.max(1,Math.min(400,limit))}`,{
      headers:{Authorization:`Bearer ${token}`},
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.error||data.message||`Request failed (${res.status})`);
    return Array.isArray(data.items)?data.items:[];
  },[]);

  const normalizeIncomingFriendRequests=useCallback((incoming)=>{
    return (Array.isArray(incoming)?incoming:[]).map(item=>({
      uid:item?.uid||"",
      username:item?.username||"",
      displayName:item?.displayName||"Friend",
      photoURL:item?.photoURL||"",
    })).filter(item=>item.uid);
  },[]);

  const syncIncomingFriendRequests=useCallback(async(token,{silent=true}={})=>{
    try{
      const snapshot=await fetchFriendsSnapshot(token);
      setIncomingFriendRequests(normalizeIncomingFriendRequests(snapshot?.incomingRequests||[]));
    }catch(error){
      if(!silent){
        addToast(error.message||"Could not load friend requests","error");
      }
    }
  },[fetchFriendsSnapshot,normalizeIncomingFriendRequests,addToast]);

  const syncLobbyMemoryStats=useCallback(async(token,{silent=true}={})=>{
    try{
      const sessions=await fetchWatchSessionsSnapshot(token,180);
      const now=Date.now();
      const monthAgo=now-(30*24*60*60*1000);
      const dayKeys=new Set();
      let monthlySeconds=0;
      let longestSessionSeconds=0;

      // The lobby summary is derived client-side from recent sessions so the
      // dashboard can stay lightweight without a dedicated stats endpoint.
      sessions.forEach(item=>{
        const duration=Math.max(0,Number(item?.duration)||0);
        const endedAt=item?.endedAt?new Date(item.endedAt).getTime():0;
        if(endedAt>=monthAgo)monthlySeconds+=duration;
        if(duration>longestSessionSeconds)longestSessionSeconds=duration;
        if(endedAt){
          const d=new Date(endedAt);
          dayKeys.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`);
        }
      });

      const days=[...dayKeys].sort();
      let streakDays=0;
      if(days.length>0){
        streakDays=1;
        for(let idx=days.length-1;idx>0;idx-=1){
          const current=new Date(`${days[idx]}T00:00:00Z`).getTime();
          const previous=new Date(`${days[idx-1]}T00:00:00Z`).getTime();
          const diff=Math.round((current-previous)/86400000);
          if(diff===1)streakDays+=1;
          else break;
        }
      }

      setLobbyMemoryStats({
        sharedHoursMonth:Math.round((monthlySeconds/3600)*10)/10,
        longestSessionSeconds,
        longestSessionLabel:formatDurationLabel(longestSessionSeconds),
        streakDays,
      });
    }catch(error){
      if(!silent){
        addToast(error.message||"Could not load memory stats","error");
      }
    }
  },[fetchWatchSessionsSnapshot,addToast]);

  const avatarUrl=profile?.photoURL||user?.photoURL||"";

  const pushNotify=useCallback((title,body)=>{
    if(!browserPushEnabled)return;
    if(typeof window==="undefined"||!("Notification" in window))return;
    if(Notification.permission!=="granted")return;
    try{
      new Notification(title,{
        body,
        icon:avatarUrl||undefined,
        tag:"lumiere-social",
      });
    }catch(_){}
  },[browserPushEnabled,avatarUrl]);

  const setPushNotifications=useCallback(async(enabled)=>{
    if(!enabled){
      setBrowserPushEnabled(false);
      savePushPref(false);
      addToast("Browser notifications disabled","info");
      return true;
    }
    if(typeof window==="undefined"||!("Notification" in window)){
      addToast("Browser notifications are not supported on this device","error");
      return false;
    }
    if(!window.isSecureContext&&window.location.hostname!=="localhost"&&window.location.hostname!=="127.0.0.1"){
      addToast("Push notifications require HTTPS (or localhost)","error");
      return false;
    }
    if(Notification.permission==="denied"){
      addToast("Notifications are blocked in browser settings","error");
      return false;
    }
    if(Notification.permission!=="granted"){
      const permission=await Notification.requestPermission();
      if(permission!=="granted"){
        addToast("Notification permission was not granted","error");
        return false;
      }
    }
    setBrowserPushEnabled(true);
    savePushPref(true);
    addToast("Browser notifications enabled","success");
    return true;
  },[addToast]);

  const cleanupSocket=useCallback(()=>{
    // App keeps a single Socket.IO client alive across screens. Reconnect paths
    // always start by removing listeners from the previous instance.
    if(socketRef.current){socketRef.current.removeAllListeners();socketRef.current.disconnect();socketRef.current=null;}
    setSocketConnected(false);
  },[]);

  const connectSocket=useCallback((token,uname)=>{
    cleanupSocket();
    const socket=io(SERVER_URL,{auth:{token,username:uname},reconnectionAttempts:10,reconnectionDelay:1000,transports:["websocket"]});
    socket.on("connect",()=>{
      setSocketConnected(true);
      const saved=loadSession();
      // Auto-rejoin only when the UI is not already in a pending create/join flow.
      if(saved && !roomPendingRef.current)socket.emit("join_room",{roomCode:saved});
    });
    socket.on("disconnect",()=>setSocketConnected(false));
    socket.on("connect_error",(err)=>{
      setSocketConnected(false);
      clearPendingTimer();
      if(roomPendingRef.current){
        setRoomPending(false);
        setView("lobby");
      }
      addToast(err?.message || "Connection error","error");
    });
    socket.on("room_joined",({
      roomCode:rc,
      users:u,
      videoState,
      audioState,
      mediaType,
      mediaMeta,
      messages:msgs,
      isRejoin,
      roomType:joinedRoomType,
      sessionMode:joinedSessionMode,
      moodTag:joinedMoodTag,
      contentUrl:joinedContentUrl,
      contentType:joinedContentType,
      createdBy:joinedCreatedBy,
      videoMetadata,
      document,
      readingState,
      maxParticipants,
      readingPage,
    })=>{
      // This event is the server's authoritative room snapshot. Hydrate all
      // room-scoped state from it so late joins and reconnects behave the same.
      const normalizedRoomCode=String(rc||"").trim();
      if(!normalizedRoomCode){
        clearPendingTimer();
        setRoomPending(false);
        setView("lobby");
        addToast("Room join failed. Please try again.","error");
        return;
      }
      setRoomCode(normalizedRoomCode);setRoomUsers(u||[]);
      setRoomType(joinedRoomType||"friends");
      setSessionMode(joinedSessionMode||"watch");
      setRoomMoodTag(joinedMoodTag||"");
      setRoomContentUrl(joinedContentUrl||mediaMeta?.url||videoMetadata?.contentUrl||"");
      setRoomContentType(joinedContentType||mediaType||videoMetadata?.sourceType||"unknown");
      setRoomCreatedBy(joinedCreatedBy||"");
      setRoomMaxParticipants(Math.max(2,Number(maxParticipants)||6));
      setInitialVideoState(videoState||null);
      setInitialAudioState(audioState||null);
      setInitialMessages((msgs||[]).map(m=>({...m,reactions:m.reactions||{}})));
      setInitialVideoMetadata(videoMetadata?{...videoMetadata,fileFingerprint:videoMetadata.fileFingerprint||mediaMeta?.fileSignature||""}:null);
      setInitialDocument(document||null);
      setInitialReadingPage(Math.max(1,Math.floor(Number(readingPage)||1)));
      setInitialReadingState(readingState||null);
      setRoomPending(false);
      clearPendingTimer();
      saveSession(normalizedRoomCode);setView("room");
      setSavedCode(normalizedRoomCode);
      if(isRejoin)addToast("Rejoined — resuming from saved position","success");

      if(pendingInviteFriendRef.current){
        const friendUid=pendingInviteFriendRef.current;
        pendingInviteFriendRef.current=null;
        apiClient("/api/friends/invite-room",{
          method:"POST",
          body:{friendUid,roomCode:rc},
        })
          .then(()=>addToast("Invite sent to friend","success"))
          .catch(e=>addToast(e.message||"Failed to send invite","error"));
      }
    });
    socket.on("host_transferred",({hostId})=>{
      if(hostId){
        setRoomCreatedBy(hostId);
      }
    });
    socket.on("friend_invite",(invite)=>{
      const id=`${invite.fromUid}-${invite.roomCode}-${invite.timestamp||Date.now()}`;
      setIncomingInvites(prev=>{
        if(prev.some(item=>item.id===id))return prev;
        return [{id,...invite},...prev].slice(0,8);
      });
      addToast(`Invite from ${invite.fromUsername?`@${invite.fromUsername}`:invite.fromName}`,"info");
      pushNotify("Lumiere invite",`${invite.fromUsername?`@${invite.fromUsername}`:invite.fromName} invited you to room ${invite.roomCode}`);
    });
    socket.on("friend_request_received",({from})=>{
      const label=from?.username?`@${from.username}`:from?.displayName||"A friend";
      if(from?.uid){
        setIncomingFriendRequests(prev=>{
          if(prev.some(item=>item.uid===from.uid))return prev;
          return [{
            uid:from.uid,
            username:from.username||"",
            displayName:from.displayName||"Friend",
            photoURL:from.photoURL||"",
          },...prev].slice(0,20);
        });
      }
      addToast(`${label} sent you a friend request`,"info");
      pushNotify("Friend request",`${label} sent you a friend request`);
    });
    socket.on("friend_added",({friend})=>{
      const label=friend?.username?`@${friend.username}`:friend?.displayName||"Friend";
      if(friend?.uid){
        setIncomingFriendRequests(prev=>prev.filter(item=>item.uid!==friend.uid));
      }
      addToast(`${label} is now your friend`,"success");
      pushNotify("New friend",`${label} is now your friend on Lumiere`);
    });
    socket.on("couple_space_updated",({partnerUsername,partnerName,itemTitle,action})=>{
      const label=partnerUsername?`@${partnerUsername}`:partnerName||"Your partner";
      if(action==="remove"){
        addToast(`${label} removed "${itemTitle}" from your couple watchlist`,"info");
      }else{
        addToast(`${label} updated your couple watchlist`,"info");
      }
      pushNotify("Couple Space updated",`${label} updated your private watchlist`);
    });
    socket.on("shared_memory_added",({fromUsername,fromName,roomCode:rc})=>{
      const label=fromUsername?`@${fromUsername}`:fromName||"Your friend";
      const suffix=rc?` in room ${rc}`:"";
      addToast(`${label} saved a shared memory${suffix}`,"success");
      pushNotify("Shared memory saved",`${label} saved a shared memory${suffix}`);
    });
    socket.on("error",({message})=>{
      const msg=message||"Error";
      const isRoomMissing=/room not found|expired/i.test(msg);
      const pendingJoin=roomPendingRef.current&&pendingLabelRef.current==="Joining room...";
      const pendingCreate=roomPendingRef.current&&pendingLabelRef.current==="Creating room...";
      if(isRoomMissing){
        clearSession();
        setSavedCode(null);
      }
      if(roomPendingRef.current){
        if(isRoomMissing&&pendingCreate){
          return;
        }
        clearPendingTimer();
        setRoomPending(false);
        setView("lobby");
      }
      if(isRoomMissing&&!pendingJoin)return;
      addToast(msg,"error");
    });
    socketRef.current=socket;
  },[cleanupSocket,addToast,apiClient,pushNotify,clearPendingTimer]);

  const bootstrapAuthenticatedSession=useCallback(async(fbUser,{forceTokenRefresh=false,silentProfileErrors=false}={})=>{
    // Auth bootstrap keeps backend profile state authoritative: username/admin
    // flags/friend requests all come from the API before we open realtime state.
    const token=await fbUser.getIdToken(forceTokenRefresh);
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
      cleanupSocket();
      return;
    }

    setUsername(resolvedUsername);
    setNeedUsername(false);
    if(!socketRef.current||!socketRef.current.connected){
      connectSocket(token,resolvedUsername);
    }
  },[connectSocket,cleanupSocket,fetchMyProfile,syncIncomingFriendRequests,syncLobbyMemoryStats,addToast]);

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
            cleanupSocket();
            setAuthLoading(false);
            return;
          }

          setEmailVerificationRequired(false);
          setUser(fbUser);
          await bootstrapAuthenticatedSession(fbUser);
        }else{
          // Signing out must clear every room-scoped state bucket so a later
          // login never inherits stale playback/chat/session data.
          setUser(null);cleanupSocket();clearSession();setView("lobby");setRoomCode(null);
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
          setIncomingFriendRequests([]);
          setFriendRequestBusyByUid({});
          setLobbyMemoryStats({
            sharedHoursMonth:0,
            longestSessionSeconds:0,
            longestSessionLabel:"0m",
            streakDays:0,
          });
          setIsAdmin(false);
        }
      }catch(error){
        cleanupSocket();
        addToast(error.message||"Authentication setup failed","error");
      }
      setAuthLoading(false);
    });
    return()=>{unsub();cleanupSocket();};
  },[cleanupSocket,bootstrapAuthenticatedSession,addToast]);

  const handleUsernameSet=useCallback(async(uname)=>{
    try{
      const res=await apiClient("/api/username/claim",{method:"POST",body:{username:uname}});
      const claimed=String(res?.profile?.username||uname).trim().toLowerCase();
      saveUsername(claimed);
      setUsername(claimed);
      setNeedUsername(false);
      const token=await auth.currentUser?.getIdToken();
      if(token)connectSocket(token,claimed);
      return true;
    }catch(e){
      addToast(e.message||"Could not claim username","error");
      return false;
    }
  },[connectSocket,apiClient,addToast]);

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

  const handleCreateRoom=useCallback((options={})=>{
    if(!socketRef.current||!socketRef.current.connected){
      addToast("Still connecting to server. Try again in a second.","error");
      return;
    }
    setRoomPendingLabel("Creating room...");
    setRoomPending(true);
    setView("room_pending");
    startPendingTimer("Creating room...");
    const payload={
      roomType:options.roomType||"friends",
      sessionMode:options.sessionMode||"watch",
      moodTag:options.moodTag||"",
      contentUrl:options.contentUrl||"",
      contentType:options.contentType||"unknown",
      maxParticipants:options.maxParticipants,
    };
    const socket=socketRef.current;
    // Use an ack/timeout pair so room creation failure is surfaced even when
    // the server never emits a separate error event.
    const emitWithAck=socket.timeout?socket.timeout(8000):socket;
    emitWithAck.emit("create_room",payload,(err,res)=>{
      if(!roomPendingRef.current)return;
      if(err){
        clearPendingTimer();
        setRoomPending(false);
        setView("lobby");
        addToast("Create room timed out. Please try again.","error");
        return;
      }
      if(res && res.ok===false){
        clearPendingTimer();
        setRoomPending(false);
        setView("lobby");
        addToast(res.error||"Failed to create room","error");
      }
    });
  },[addToast,startPendingTimer,clearPendingTimer]);
  const handleJoinRoom=useCallback(code=>{
    if(!socketRef.current||!socketRef.current.connected){
      addToast("Still connecting to server. Try again in a second.","error");
      return;
    }
    setRoomPendingLabel("Joining room...");
    setRoomPending(true);
    setView("room_pending");
    startPendingTimer("Joining room...");
    const socket=socketRef.current;
    // Joining mirrors create-room behavior: the pending screen is driven by the
    // join ack rather than assuming a "room_joined" event will always arrive.
    const emitWithAck=socket.timeout?socket.timeout(8000):socket;
    emitWithAck.emit("join_room",{roomCode:normalizeCode(code)},(err,res)=>{
      if(!roomPendingRef.current)return;
      if(err){
        clearPendingTimer();
        setRoomPending(false);
        setView("lobby");
        addToast("Join room timed out. Please try again.","error");
        return;
      }
      if(res && res.ok===false){
        clearPendingTimer();
        setRoomPending(false);
        setView("lobby");
        addToast(res.error||"Could not join room","error");
      }
    });
  },[addToast,startPendingTimer,clearPendingTimer]);
  const handleAcceptInvite=useCallback((invite)=>{
    setIncomingInvites(prev=>prev.filter(item=>item.id!==invite.id));
    handleJoinRoom(invite.roomCode);
  },[handleJoinRoom]);
  const handleRespondFriendRequest=useCallback(async(requesterUid,action)=>{
    if(!requesterUid||!["accept","reject"].includes(action))return;
    const req=incomingFriendRequests.find(item=>item.uid===requesterUid);
    const label=req?.username?`@${req.username}`:req?.displayName||"friend";
    setFriendRequestBusyByUid(prev=>({...prev,[requesterUid]:true}));
    try{
      await apiClient("/api/friends/respond",{
        method:"POST",
        body:{requesterUid,action},
      });
      setIncomingFriendRequests(prev=>prev.filter(item=>item.uid!==requesterUid));
      if(action==="accept"){
        addToast(`You are now friends with ${label}`,"success");
      }else{
        addToast(`Friend request declined from ${label}`,"info");
      }
    }catch(error){
      addToast(error.message||"Could not update friend request","error");
    }finally{
      setFriendRequestBusyByUid(prev=>({...prev,[requesterUid]:false}));
    }
  },[incomingFriendRequests,apiClient,addToast]);
  const handleSendFriendRequest=useCallback(async(targetUid,targetUsername,targetName)=>{
    if(!targetUid)throw new Error("Invalid user");
    const res=await apiClient("/api/friends/request",{method:"POST",body:{targetUid}});
    const status=String(res?.status||"requested");
    const label=targetUsername?`@${targetUsername}`:targetName||"friend";
    if(status==="requested"){
      addToast(`Friend request sent to ${label}`,"success");
    }else if(status==="already_friends"){
      addToast(`${label} is already your friend`,"info");
    }else if(status==="already_requested"){
      addToast(`Friend request already sent to ${label}`,"info");
    }else if(status==="needs_accept"){
      addToast(`${label} already sent you a request. Accept it in Settings > Friends.`,"info");
    }else{
      addToast(`Friend request status: ${status}`,"info");
    }
    return status;
  },[apiClient,addToast]);
  const handleOpenDashboard=useCallback((tab="profile")=>{
    const nextTab=typeof tab==="string"&&tab?tab:"profile";
    setDashboardInitialTab(nextTab);
    setView("settings");
  },[]);
  const handleInviteFriend=useCallback(async(friendUid)=>{
    if(!friendUid)throw new Error("Invalid friend");

    if(roomCode&&view==="room"){
      await apiClient("/api/friends/invite-room",{
        method:"POST",
        body:{friendUid,roomCode},
      });
      addToast("Invite sent","success");
      return;
    }

    if(!socketRef.current||!socketRef.current.connected){
      throw new Error("Server is still connecting. Try again.");
    }

    // If the user is not already inside a room, create one first and send the
    // invite after the server confirms the room_joined snapshot.
    pendingInviteFriendRef.current=friendUid;
    socketRef.current.emit("create_room");
    addToast("Creating room and sending invite...","info");
  },[roomCode,view,apiClient,addToast]);
  const handleLeave=useCallback(()=>{
    clearSession();setSavedCode(null);cleanupSocket();
    setRoomCode(null);setRoomUsers([]);setInitialMessages([]);setView("lobby");
    setRoomType("friends");setSessionMode("watch");setRoomMoodTag("");
    setRoomContentUrl("");setRoomContentType("unknown");setRoomCreatedBy("");
    setRoomMaxParticipants(6);setInitialVideoMetadata(null);setInitialAudioState(null);setInitialDocument(null);setInitialReadingState(null);setInitialReadingPage(1);
    setRoomPending(false);
    auth.currentUser?.getIdToken().then(token=>connectSocket(token,username));
  },[cleanupSocket,connectSocket,username]);
  const handleSignOut=useCallback(()=>{
    clearSession();
    setIncomingInvites([]);
    setIncomingFriendRequests([]);
    setFriendRequestBusyByUid({});
    cleanupSocket();
    signOut(auth);
  },[cleanupSocket]);

  useEffect(()=>{
    if(!user||view!=="lobby")return;
    auth.currentUser?.getIdToken()
      .then(token=>{
        if(!token)return;
        syncIncomingFriendRequests(token,{silent:true});
        syncLobbyMemoryStats(token,{silent:true});
      })
      .catch(()=>{});
  },[user,view,syncIncomingFriendRequests,syncLobbyMemoryStats]);

  if(authLoading)return(
    <div className="min-h-screen bg-screen flex items-center justify-center">
      <div className="grain-overlay"/><Film size={28} className="relative z-10 text-amber-400 animate-pulse"/>
    </div>
  );

  if(user&&emailVerificationRequired){
    return(
      <>
        <Toasts toasts={toasts} removeToast={removeToast}/>
        <VerifyEmailView
          user={user}
          onRefresh={handleRefreshVerification}
          onResend={handleResendVerification}
          onSignOut={handleSignOut}
          loading={verificationActionLoading}
        />
      </>
    );
  }

  if(user&&needUsername)return<UsernameSetup displayName={user.displayName} onDone={handleUsernameSet}/>;

  // The root render is effectively a small state machine: unauthenticated
  // landing, verified lobby/settings, pending room transition, or active room.
  return(
    <>
      <Toasts toasts={toasts} removeToast={removeToast}/>
      {!user&&<LandingView addToast={addToast}/>}
      {user&&view==="lobby"&&(
        <LobbyView avatarUrl={avatarUrl} username={username} onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom} onSignOut={handleSignOut} savedRoomCode={savedCode}
          socketConnected={socketConnected} onOpenDashboard={handleOpenDashboard}
          memoryStats={lobbyMemoryStats}
          friendRequests={incomingFriendRequests}
          friendRequestBusyByUid={friendRequestBusyByUid}
          onRespondFriendRequest={handleRespondFriendRequest}
          invites={incomingInvites} onAcceptInvite={handleAcceptInvite}/>
      )}
      {user&&view==="settings"&&(
        <DashboardView
          username={username}
          apiClient={apiClient}
          onBack={()=>setView("lobby")}
          onSignOut={handleSignOut}
          onInviteFriend={handleInviteFriend}
          invites={incomingInvites}
          onAcceptInvite={handleAcceptInvite}
          addToast={addToast}
          onProfileUpdated={setProfile}
          activeRoomCode={roomCode}
          initialTab={dashboardInitialTab}
          pushEnabled={browserPushEnabled}
          onTogglePushNotifications={setPushNotifications}
          showMetadata={isAdmin}
        />
      )}
      {user&&view==="room_pending"&&(
        <RoomPendingView
          label={roomPendingLabel}
          onCancel={()=>{
            setRoomPending(false);
            setView("lobby");
          }}
        />
      )}
      {user&&view==="room"&&!roomCode&&(
        <RoomPendingView
          label="Connecting to room..."
          onCancel={()=>{
            setRoomPending(false);
            setView("lobby");
          }}
        />
      )}
      {user&&view==="room"&&roomCode&&(
        <RoomErrorBoundary onReset={handleLeave}>
          <RoomView user={user} username={username} socket={socketRef.current}
            roomCode={roomCode} roomType={roomType} sessionMode={sessionMode} roomMoodTag={roomMoodTag}
            roomContentUrl={roomContentUrl} roomContentType={roomContentType} roomCreatedBy={roomCreatedBy}
            maxParticipants={roomMaxParticipants} initialUsers={roomUsers}
            initialVideoState={initialVideoState} initialAudioState={initialAudioState} initialMessages={initialMessages}
            initialVideoMetadata={initialVideoMetadata}
            initialDocument={initialDocument}
            initialReadingPage={initialReadingPage}
            initialReadingState={initialReadingState}
            onLeave={handleLeave} addToast={addToast}
            onSendFriendRequest={handleSendFriendRequest}
            onRespondFriendRequest={handleRespondFriendRequest}
            friendRequests={incomingFriendRequests}
            friendRequestBusyByUid={friendRequestBusyByUid}
            invites={incomingInvites}
            onAcceptInvite={handleAcceptInvite}
          />
        </RoomErrorBoundary>
      )}
    </>
  );
}
