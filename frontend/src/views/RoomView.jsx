/**
 * RoomView is the realtime session surface. It supports watch, music, podcast,
 * reading, and study modes while orchestrating video sync, audio sync,
 * co-reading, WebRTC calls, chat, reactions, and room-level social actions.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { auth } from "../firebase.js";
import CoReadingPdfViewer, { getPdfPageCountFromArrayBuffer } from "../CoReadingPdfViewer.jsx";
import { getSessionEngine } from "../engines/index.js";
import { extractYouTubeId } from "../engines/engineUtils.js";
import { fmt } from "../utils/media";
import { isHttpUrl, isDirectMediaUrl } from "../utils/url";
import { guessDocumentFileName, buildDocumentSignature, isSharedUploadUrl } from "../utils/document";
import { getBufferedAheadSeconds } from "../utils/buffer";
import { SERVER_URL, MAX_VIDEO_TIME, MAX_MESSAGES } from "../config/constants";
import { SESSION_MODE_LABELS, ROOM_TYPE_LABELS } from "../config/roomModes";
import HeaderNotifications from "../components/HeaderNotifications";
import SyncIndicator from "../components/SyncIndicator";
import ChatMessage from "../components/ChatMessage";
import DraggableCallWindow from "../components/DraggableCallWindow";
import PresetPanel from "../components/PresetPanel";
import useWebRTC from "../hooks/useWebRTC";
import {
  Film, MessageSquare, LogOut, Copy, Check,
  Play, Pause, SkipBack, SkipForward, Maximize, Minimize,
  Users, UserPlus, Wifi, WifiOff, Upload, Send, X,
  Menu, Phone, PhoneOff, Volume2, VolumeX, Bookmark,
  Headphones, Link2, FileText, Lock, GraduationCap,
} from "lucide-react";

const YOUTUBE_REMOTE_GUARD_MS = 1400;
const YOUTUBE_LOCAL_CONTROL_DEBOUNCE_MS = 900;
const YOUTUBE_NATIVE_SEEK_DEBOUNCE_MS = 1400;
const YOUTUBE_SCHEDULE_BUFFER_MS = 120;
const ROOM_INVITE_RESEND_COOLDOWN_MS = 25000;

let youtubeApiPromise = null;

const describeYouTubePlayerError = (code, videoId = "") => {
  switch (Number(code) || 0) {
    case 2:
      return "The shared YouTube link looks invalid for this player.";
    case 5:
      return "This browser could not play the embedded YouTube video.";
    case 100:
      return "This YouTube video is unavailable.";
    case 101:
    case 150:
      return "This YouTube video does not allow embedded playback.";
    default:
      return videoId
        ? `This device could not load the embedded YouTube video (${videoId}).`
        : "This device could not load the embedded YouTube video.";
  }
};

/**
 * Loads the YouTube iframe API exactly once for all room instances.
 * @returns {Promise<any>} The initialized global YT namespace.
 */
const loadYouTubeIframeApi = () => {
  // The YouTube iframe API is a global script with async ready callbacks, so
  // cache one shared promise and let every player await the same bootstrap.
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YouTube API unavailable"));
  }
  if (window.YT && typeof window.YT.Player === "function") {
    return Promise.resolve(window.YT);
  }
  if (youtubeApiPromise) return youtubeApiPromise;

  youtubeApiPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    const script = existing || document.createElement("script");

    if (!existing) {
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => reject(new Error("Failed to load YouTube API"));
      document.head.appendChild(script);
    }

    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevReady === "function") prevReady();
      if (window.YT && typeof window.YT.Player === "function") {
        resolve(window.YT);
      } else {
        reject(new Error("YouTube API did not initialize"));
      }
    };

    const timeout = setTimeout(() => {
      if (window.YT && typeof window.YT.Player === "function") {
        resolve(window.YT);
      } else {
        reject(new Error("YouTube API load timed out"));
      }
    }, 10000);
    timeout.unref?.();
  }).catch((error) => {
    youtubeApiPromise = null;
    throw error;
  });

  return youtubeApiPromise;
};

/**
 * Verifies that a YouTube video can initialize inside an embedded player before
 * the host syncs it to the whole room.
 * @param {string} videoId - Parsed YouTube video id.
 * @returns {Promise<void>} Resolves when the embed is ready, rejects with a host-facing message otherwise.
 */
const preflightYouTubeEmbed = async (videoId) => {
  if (typeof window === "undefined" || typeof document === "undefined" || !videoId) {
    throw new Error("This YouTube link looks invalid for Lumiere.");
  }

  let YT = null;
  try {
    YT = await loadYouTubeIframeApi();
  } catch (error) {
    const message = error?.message === "Failed to load YouTube API" || error?.message === "YouTube API load timed out"
      ? "Lumiere could not verify this YouTube link right now. Try again, disable blockers, or upload a file instead."
      : (error?.message || "Lumiere could not verify this YouTube link right now.");
    throw new Error(message);
  }

  await new Promise((resolve, reject) => {
    const probeHost = document.createElement("div");
    probeHost.setAttribute("aria-hidden", "true");
    probeHost.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(probeHost);

    let settled = false;
    let player = null;
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      try {
        player?.destroy?.();
      } catch (_) {
        // Ignore teardown failures from the hidden probe player.
      }
      probeHost.remove();
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    timeoutId = setTimeout(() => {
      finish(reject, new Error("This YouTube link took too long to verify inside Lumiere. Try another link or upload a file."));
    }, 8000);
    timeoutId.unref?.();

    player = new YT.Player(probeHost, {
      width: "1",
      height: "1",
      videoId,
      playerVars: {
        autoplay: 0,
        controls: 0,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: () => finish(resolve),
        onError: (event) => {
          const code = Number(event?.data) || 0;
          const baseMessage = describeYouTubePlayerError(code, videoId);
          const message = code === 101 || code === 150
            ? "This YouTube video won't work inside Lumiere because YouTube blocks embedded playback. Choose another link or upload a file."
            : baseMessage;
          finish(reject, new Error(message));
        },
      },
    });
  });
};

/**
 * Renders the live room experience for all supported session modes.
 * @param {{user: object, username: string, socket: any, roomCode: string, roomType?: string, sessionMode?: string, roomMoodTag?: string, roomContentUrl?: string, roomContentType?: string, roomCreatedBy?: string, maxParticipants?: number, initialUsers: Array, initialVideoState: object, initialAudioState?: object|null, initialMessages: Array, initialVideoMetadata?: object|null, initialDocument?: object|null, initialReadingPage?: number, initialReadingState?: object|null, onLeave: () => void, addToast: (message: string, type?: string) => void, onSendFriendRequest?: Function, onRespondFriendRequest?: Function, onInviteFriend?: Function, friendRequests?: Array, friendRequestBusyByUid?: Record<string, boolean>, invites?: Array, onAcceptInvite?: Function}} props - Room snapshot, transport handles, and room-level action callbacks.
 * @returns {JSX.Element} The realtime room shell.
 */
function RoomView({
  user,
  username,
  socket,
  roomCode,
  roomType="friends",
  sessionMode="watch",
  roomMoodTag="",
  roomContentUrl="",
  roomContentType="unknown",
  roomCreatedBy="",
  maxParticipants=6,
  initialUsers,
  initialVideoState,
  initialAudioState=null,
  initialMessages,
  initialVideoMetadata=null,
  initialDocument=null,
  initialReadingPage=1,
  initialReadingState=null,
  onLeave,
  addToast,
  onSendFriendRequest,
  onRespondFriendRequest,
  onInviteFriend,
  friendRequests=[],
  friendRequestBusyByUid={},
  invites=[],
  onAcceptInvite,
}){
  // RoomView is the realtime playback shell: transport refs, room members,
  // chat state, reading state, and the currently active media engine all meet here.
  // Refs hold transport and media objects whose updates should not trigger rerenders.
  const videoRef=useRef(null);
  const audioRef=useRef(null);
  const youtubeHostRef=useRef(null);
  const youtubePlayerRef=useRef(null);
  const youtubeStateRef=useRef(-1);
  const youtubeProgressRef=useRef(null);
  const youtubeRemoteApplyUntilRef=useRef(0);
  const youtubeControlRef=useRef({playAt:0,pauseAt:0,seekAt:0});
  const lastYouTubeSampleRef=useRef({time:0,at:0});
  const lastYouTubeSeekEmitAtRef=useRef(0);
  const videoScheduleTimeoutRef=useRef(null);
  const audioScheduleTimeoutRef=useRef(null);
  const audioRateResetTimeoutRef=useRef(null);
  const audioDriftIntervalRef=useRef(null);
  const audioSyncStateRef=useRef(initialAudioState||null);
  const localAudioSignatureRef=useRef(String(initialVideoMetadata?.fileFingerprint||""));
  const requiredAudioSignatureRef=useRef(String(initialVideoMetadata?.fileFingerprint||""));
  const pendingAudioSyncRef=useRef(null);
  const localMediaReadyRef=useRef(false);
  const lastDriftLogAtRef=useRef(0);
  const fileInputRef=useRef(null);
  const chatEndRef=useRef(null);
  const containerRef=useRef(null);
  const syncIntervalRef=useRef(null);
  const heartbeatRef=useRef(null);
  const isScrubbing=useRef(false);
  const lastSyncAt=useRef(0);
  const pendingSeek=useRef(null);
  const videoObjectUrl=useRef(null);
  // Heartbeats always read from refs so the interval can publish the freshest
  // playback position without re-registering timers on every render.
  const myTimeRef=useRef(0); // always latest currentTime for heartbeat
  const syncWaitRef=useRef({ active:false, waitForUid:null, waitForUsername:null });
  const lastSyncWaitNoticeAt=useRef(0);
  const suppressSeekEchoRef=useRef(false);
  const friendMenuRef=useRef(null);
  const moreMenuRef=useRef(null);
  const pendingReadingSyncRef=useRef(null);
  const lastReadingPageRequestAtRef=useRef(0);
  const readingReadyRef=useRef(false);
  const sharedDocumentRef=useRef(initialDocument||null);
  const inviteCooldownTimeoutsRef=useRef({});

  // Core room UI state covers chat, playback, resource metadata, and side-panel visibility.
  const [messages,setMessages]=useState(initialMessages||[]);
  const [chatInput,setChatInput]=useState("");
  const [isPlaying,setIsPlaying]=useState(false);
  const [currentTime,setCurrentTime]=useState(0);
  const [duration,setDuration]=useState(0);
  const [videoLoaded,setVideoLoaded]=useState(false);
  const [videoName,setVideoName]=useState("");
  const [resourceUrl,setResourceUrl]=useState(roomContentUrl||initialVideoMetadata?.contentUrl||"");
  const [resourceInput,setResourceInput]=useState(roomContentUrl||initialVideoMetadata?.contentUrl||"");
  const [resourceType,setResourceType]=useState(roomContentType||initialVideoMetadata?.sourceType||"unknown");
  const [youtubeVideoId,setYoutubeVideoId]=useState(extractYouTubeId(roomContentUrl||initialVideoMetadata?.contentUrl||""));
  const [youtubeLoadError,setYoutubeLoadError]=useState("");
  const [youtubeRetryNonce,setYoutubeRetryNonce]=useState(0);
  const [audioLoadWarning,setAudioLoadWarning]=useState("");
  const [audioDebugStatus,setAudioDebugStatus]=useState("");
  const [sharedDocument,setSharedDocument]=useState(initialDocument||null);
  const [readingPage,setReadingPage]=useState(Math.max(1, Math.floor(Number(initialReadingState?.page ?? initialReadingPage) || 1)));
  const [readingPageInput,setReadingPageInput]=useState(String(Math.max(1, Math.floor(Number(initialReadingState?.page ?? initialReadingPage) || 1))));
  const [readingTotalPages,setReadingTotalPages]=useState(Math.max(0, Math.floor(Number(initialReadingState?.totalPages ?? initialDocument?.totalPages) || 0)));
  const [readingPdfReady,setReadingPdfReady]=useState(false);
  const [readingPdfLoading,setReadingPdfLoading]=useState(false);
  const [readingPdfError,setReadingPdfError]=useState("");
  const [readingPdfWarning,setReadingPdfWarning]=useState("");
  const [showChat,setShowChat]=useState(sessionMode!=="reading");
  const [showMoreMenu,setShowMoreMenu]=useState(false);
  const [showSourcePanel,setShowSourcePanel]=useState(false);
  const [sourcePanelError,setSourcePanelError]=useState("");
  const [readingZoom,setReadingZoom]=useState(100);
  const [showPresets,setShowPresets]=useState(false);
  const [copied,setCopied]=useState(false);
  const [isFullscreen,setIsFullscreen]=useState(false);
  const [connected,setConnected]=useState(true);
  const [users,setUsers]=useState(initialUsers||[]);
  const [muted,setMuted]=useState(false);
  const [volume,setVolume]=useState(1);
  const [actionBanner,setActionBanner]=useState("");
  const [waitingForUser,setWaitingForUser]=useState(null);
  // memberTimes: uid -> { username, time }
  const [memberTimes,setMemberTimes]=useState({});
  const [showFriendMenu,setShowFriendMenu]=useState(false);
  const [showHeaderNotifications,setShowHeaderNotifications]=useState(false);
  // Social/action state tracks friend actions, document uploads, and avatar fallback status.
  const [friendBusyByUid,setFriendBusyByUid]=useState({});
  const [friendStatusByUid,setFriendStatusByUid]=useState({});
  const [availableFriends,setAvailableFriends]=useState([]);
  const [inviteBusyByUid,setInviteBusyByUid]=useState({});
  const [inviteCooldownByUid,setInviteCooldownByUid]=useState({});
  const [inviteHistoryByUid,setInviteHistoryByUid]=useState({});
  const [docUploading,setDocUploading]=useState(false);
  const [closePickerSignal,setClosePickerSignal]=useState(0);
  const [brokenAvatarUids,setBrokenAvatarUids]=useState({});
  const modeLabel=ROOM_TYPE_LABELS[roomType]||"Friends";
  const sessionLabel=SESSION_MODE_LABELS[sessionMode]||"Watch";
  // Session engines let one screen support watch/music/podcast/reading/study
  // while still swapping labels, accepted file types, and behavior by mode.
  const sessionEngine=getSessionEngine(sessionMode);
  const engineUi=sessionEngine.ui||{};
  const fileAccept=engineUi.fileAccept||"video/*";
  const uploadPrimary=engineUi.uploadPrimary||"Load your media";
  const uploadHint=engineUi.uploadHint||"Load a source to begin synchronized sessions.";
  const uploadButtonLabel=engineUi.uploadButtonLabel||"Choose File";
  const chatPlaceholder=engineUi.chatPlaceholder||"Message...";
  const isMusicMode=sessionMode==="music";
  const isReadingMode=sessionMode==="reading";
  const useYouTubePlayer=!!youtubeVideoId&&sessionMode!=="reading";
  const hideNativeYouTubeFooter=useYouTubePlayer&&!isMusicMode;

  // Memoized helpers are shared across event listeners, timers, and player callbacks.
  const showBanner=useCallback(text=>{setActionBanner(text);setTimeout(()=>setActionBanner(""),3000);},[]);
  const getActiveHtmlMedia=useCallback(()=>isMusicMode?audioRef.current:videoRef.current,[isMusicMode]);
  const clearScheduledVideoStart=useCallback(()=>{
    if(videoScheduleTimeoutRef.current){
      clearTimeout(videoScheduleTimeoutRef.current);
      videoScheduleTimeoutRef.current=null;
    }
  },[]);
  const markAvatarBroken=useCallback((uid)=>{
    if(!uid)return;
    setBrokenAvatarUids(prev=>prev[uid]?prev:{...prev,[uid]:true});
  },[]);
  // Avatar rendering prefers the saved photo URL and falls back to initials if the image fails.
  const renderUserAvatar=useCallback((participant,sizeClass,textClass,altLabel="")=>{
    const safeUid=String(participant?.uid||"");
    const label=altLabel||participant?.name||participant?.username||"User";
    const initial=(participant?.name||participant?.username||label||"U").trim()[0]?.toUpperCase()||"U";
    const showPhoto=!!participant?.photoURL&&!brokenAvatarUids[safeUid];
    return showPhoto
      ?<img
        src={participant.photoURL}
        alt={label}
        onError={()=>markAvatarBroken(safeUid)}
        className={`${sizeClass} rounded-full border border-zinc-700 object-cover`}
      />
      :<div className={`${sizeClass} rounded-full bg-amber-500/20 border border-zinc-700 flex items-center justify-center ${textClass} text-amber-400 font-semibold`}>
        {initial}
      </div>;
  },[brokenAvatarUids,markAvatarBroken]);
  // Old chat rows are rehydrated from the live room roster so reconnects refresh names and photos.
  const resolveMessageAuthor=useCallback((message)=>{
    if(!message||message.uid==="system"){
      return message;
    }
    const liveUser=users.find(entry=>entry.uid===message.uid);
    if(!liveUser){
      return message;
    }
    return {
      ...message,
      senderName: message.senderName||liveUser.name||"",
      senderUsername: message.senderUsername||liveUser.username||"",
      photoURL: message.photoURL||liveUser.photoURL||"",
    };
  },[users]);
  const clearScheduledAudioStart=useCallback(()=>{
    if(audioScheduleTimeoutRef.current){
      clearTimeout(audioScheduleTimeoutRef.current);
      audioScheduleTimeoutRef.current=null;
    }
  },[]);
  const resolveVideoTargetTime=useCallback((videoState, nowSec=Date.now()/1000)=>{
    if(!videoState)return 0;
    const base=Math.max(0,Number(videoState.currentTime)||0);
    const rate=(typeof videoState.playbackRate==="number"&&videoState.playbackRate>0&&videoState.playbackRate<=4)
      ?videoState.playbackRate
      :1;
    if(!videoState.isPlaying)return base;
    const scheduledStartAt=Math.max(0,Number(videoState.scheduledStartAt)||0);
    const lastUpdate=Math.max(0,Number(videoState.lastUpdate)||0);
    const effectiveStartAt=scheduledStartAt>0?Math.max(lastUpdate,scheduledStartAt):lastUpdate;
    return Math.max(0,base+Math.max(0,nowSec-effectiveStartAt)*rate);
  },[]);
  const resolveVideoStartDelayMs=useCallback((videoState, nowSec=Date.now()/1000)=>{
    if(!videoState?.isPlaying)return 0;
    const scheduledStartAt=Math.max(0,Number(videoState.scheduledStartAt)||0);
    if(!(scheduledStartAt>nowSec))return 0;
    return Math.max(0,Math.round((scheduledStartAt-nowSec)*1000));
  },[]);
  const clearAudioRateReset=useCallback(()=>{
    if(audioRateResetTimeoutRef.current){
      clearTimeout(audioRateResetTimeoutRef.current);
      audioRateResetTimeoutRef.current=null;
    }
    const media=getActiveHtmlMedia();
    if(media&&Math.abs(Number(media.playbackRate||1)-1)>0.001){
      media.playbackRate=1;
    }
  },[getActiveHtmlMedia]);
  const resolveAudioTargetTime=useCallback((syncState, nowMs=Date.now())=>{
    // Shared audio sync is server-time based, so playback time is reconstructed
    // from the synced startTime + serverTime instead of the local media clock.
    if(!syncState)return 0;
    const base=Math.max(0,Number(syncState.startTime)||0);
    if(syncState.status!=="playing")return base;
    const serverTimeMs=Math.max(0,Number(syncState.serverTime)||nowMs);
    return Math.max(0,base+Math.max(0,(nowMs-serverTimeMs)/1000));
  },[]);
  const getMusicFileSignature=useCallback(file=>`${String(file?.name||"").trim()}:${Math.max(0,Number(file?.size)||0)}`,[ ]);
  const autoplayBlockedNoticeAt=useRef(0);
  const expectedPlayRef=useRef(Boolean(initialVideoState?.isPlaying));
  const lastBufferNoticeAt=useRef(0);
  const tryPlayWithFeedback=useCallback((video)=>{
    if(!video)return;
    video.play().catch(err=>{
      if(err?.name==="NotAllowedError"){
        const now=Date.now();
        if(now-autoplayBlockedNoticeAt.current>2500){
          autoplayBlockedNoticeAt.current=now;
          addToast("Browser blocked playback. Click anywhere on the video to start sync.","error");
          showBanner("Playback blocked. Click video to sync.");
        }
      }
    });
  },[addToast,showBanner]);
  const applySyncRef=useRef(()=>{});
  const applyAudioSyncRef=useRef(()=>{});
  const tryPlayWithFeedbackRef=useRef(tryPlayWithFeedback);
  const handleLocalBufferingRef=useRef(()=>{});
  const videoLoadedRef=useRef(videoLoaded);
  const emitSeekRef=useRef(()=>{});
  const getPlaybackHealth=useCallback(()=>{
    // Heartbeat payloads report both current time and playback health so the
    // server can tell "user is behind because buffering" from normal drift.
    if(useYouTubePlayer){
      return { bufferAhead:null, readyState:null, isBuffering:youtubeStateRef.current===3 };
    }
    const media=getActiveHtmlMedia();
    if(!media||!videoLoaded){
      return { bufferAhead:null, readyState:null, isBuffering:false };
    }
    const bufferAhead=Math.max(0,Math.min(120,getBufferedAheadSeconds(media)));
    const readyState=Math.max(0,Math.min(4,Number(media.readyState)||0));
    const isBuffering=!media.paused&&(media.seeking||readyState<3||bufferAhead<0.2);
    return { bufferAhead:Number(bufferAhead.toFixed(2)), readyState, isBuffering };
  },[getActiveHtmlMedia,useYouTubePlayer,videoLoaded]);
  const handleLocalBuffering=useCallback(()=>{
    if(useYouTubePlayer){
      if(syncWaitRef.current.active)return;
      const now=Date.now();
      if(now-lastBufferNoticeAt.current>2800){
        lastBufferNoticeAt.current=now;
        showBanner("Buffering... holding sync");
      }
      return;
    }
    const media=getActiveHtmlMedia();
    if(!videoLoaded||!media||media.paused||(!isMusicMode&&syncWaitRef.current.active))return;
    const now=Date.now();
    if(now-lastBufferNoticeAt.current>2800){
      lastBufferNoticeAt.current=now;
      showBanner("Buffering... holding sync");
    }
  },[getActiveHtmlMedia,isMusicMode,useYouTubePlayer,videoLoaded,showBanner]);
  const tryRecoverFromBuffer=useCallback(()=>{
    if(useYouTubePlayer){
      if(syncWaitRef.current.active)return;
      const player=youtubePlayerRef.current;
      if(!videoLoaded||!player)return;
      if(expectedPlayRef.current&&youtubeStateRef.current!==1){
        youtubeRemoteApplyUntilRef.current=Date.now()+800;
        player.playVideo?.();
      }
      return;
    }
    const media=getActiveHtmlMedia();
    if(!videoLoaded||!media)return;
    if(!isMusicMode&&syncWaitRef.current.active)return;
    if(expectedPlayRef.current&&media.paused){
      tryPlayWithFeedback(media);
    }
  },[getActiveHtmlMedia,isMusicMode,useYouTubePlayer,videoLoaded,tryPlayWithFeedback]);

  useEffect(()=>{tryPlayWithFeedbackRef.current=tryPlayWithFeedback;},[tryPlayWithFeedback]);
  useEffect(()=>{handleLocalBufferingRef.current=handleLocalBuffering;},[handleLocalBuffering]);
  useEffect(()=>{videoLoadedRef.current=videoLoaded;},[videoLoaded]);

  const pushSystemMessage=useCallback((text,variant="online")=>{
    // System messages reuse the same chat timeline so join/leave/offline events
    // stay contextual with the conversation that was happening around them.
    const sysMsg={
      id:`sys-${variant}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      uid:"system",
      senderName:"System",
      text,
      type:"system",
      meta:{variant},
      reactions:{},
      timestamp:Date.now(),
    };
    setMessages(p=>{
      const n=[...p,sysMsg];
      return n.length>MAX_MESSAGES?n.slice(-MAX_MESSAGES):n;
    });
  },[]);

  // useWebRTC encapsulates peer connections, local stream setup, and call controls.
  const {inCall,isJoiningCall,micOn,camOn,localStreamRef,remoteStreams,joinCall,leaveCall,toggleMic,toggleCam}=
    useWebRTC({socket,roomCode,myUid:user.uid,users,addToast});
  const callVisible=inCall||isJoiningCall;
  const otherUsers=users.filter(u=>u.uid!==user.uid);
  const otherUserIdsKey=otherUsers.map(target=>target.uid).sort().join("|");
  const hostUid=roomCreatedBy||"";
  // True when this user is the teacher in a study
  // session — they have full playback control.
  const isStudyHost=
    sessionMode==="study"&&
    user?.uid===roomCreatedBy;
  // True when this user is a student in a study
  // session — playback controls are locked for them.
  const isStudyStudent=
    sessionMode==="study"&&
    user?.uid!==roomCreatedBy;
  const hostUser=users.find(u=>u.uid===hostUid);
  const isHost=!hostUid||user.uid===hostUid;
  const canChangeSource=!isReadingMode||isHost;
  const showReadingFrame=isReadingMode&&!!sharedDocument?.fileUrl;
  const showMusicStage=isMusicMode&&!showReadingFrame;
  const showCompanionLink=!isMusicMode&&!videoLoaded&&!!resourceUrl&&!showReadingFrame&&!useYouTubePlayer;
  const showGenericLoadState=!videoLoaded&&!showReadingFrame&&!useYouTubePlayer&&!isMusicMode;
  const showBottomTransport=!isReadingMode&&!hideNativeYouTubeFooter&&!isMusicMode;
  const canOpenExternalResource=isHttpUrl(sharedDocument?.fileUrl||resourceUrl);
  const closeSourcePanel=useCallback(()=>{
    setSourcePanelError("");
    setShowSourcePanel(false);
  },[]);
  const clearInviteCooldownForUid=useCallback((uid)=>{
    if(!uid)return;
    const activeTimeout=inviteCooldownTimeoutsRef.current[uid];
    if(activeTimeout){
      clearTimeout(activeTimeout);
      delete inviteCooldownTimeoutsRef.current[uid];
    }
    setInviteCooldownByUid(prev=>{
      if(!(uid in prev))return prev;
      const next={...prev};
      delete next[uid];
      return next;
    });
  },[]);
  const openSourcePanel=useCallback(()=>{
    if(!canChangeSource){
      addToast("Only the host can change the document in co-reading","error");
      return;
    }
    setResourceInput(resourceUrl||"");
    setSourcePanelError("");
    setShowSourcePanel(true);
  },[canChangeSource,addToast,resourceUrl]);
  const handleResourceInputChange=useCallback((e)=>{
    setResourceInput(e.target.value);
    if(sourcePanelError){
      setSourcePanelError("");
    }
  },[sourcePanelError]);

  // Dismiss the friend menu when the user clicks anywhere outside the popover.
  useEffect(()=>{
    if(!showFriendMenu)return;
    const onDocPointerDown=e=>{
      if(friendMenuRef.current&&!friendMenuRef.current.contains(e.target)){
        setShowFriendMenu(false);
      }
    };
    document.addEventListener("mousedown",onDocPointerDown);
    document.addEventListener("touchstart",onDocPointerDown);
    return()=>{
      document.removeEventListener("mousedown",onDocPointerDown);
      document.removeEventListener("touchstart",onDocPointerDown);
    };
  },[showFriendMenu]);

  // Apply the same outside-click behavior to the header "more" menu.
  useEffect(()=>{
    if(!showMoreMenu)return;
    const onDocPointerDown=e=>{
      if(moreMenuRef.current&&!moreMenuRef.current.contains(e.target)){
        setShowMoreMenu(false);
      }
    };
    document.addEventListener("mousedown",onDocPointerDown);
    document.addEventListener("touchstart",onDocPointerDown);
    return()=>{
      document.removeEventListener("mousedown",onDocPointerDown);
      document.removeEventListener("touchstart",onDocPointerDown);
    };
  },[showMoreMenu]);

  // Reset invite cooldown timers whenever the user enters a new room and clean
  // them up on unmount so stale timers never leak across sessions.
  useEffect(()=>{
    Object.values(inviteCooldownTimeoutsRef.current).forEach(clearTimeout);
    inviteCooldownTimeoutsRef.current={};
    setInviteBusyByUid({});
    setInviteCooldownByUid({});
    setInviteHistoryByUid({});
    return()=>{
      Object.values(inviteCooldownTimeoutsRef.current).forEach(clearTimeout);
      inviteCooldownTimeoutsRef.current={};
    };
  },[roomCode]);

  // If everyone else leaves and no friend roster is available, close the menu.
  useEffect(()=>{
    if(otherUsers.length===0&&availableFriends.length===0){
      setShowFriendMenu(false);
    }
  },[otherUsers.length,availableFriends.length]);

  // Reading rooms default to document-first layout, so hide chat until the user opens it.
  useEffect(()=>{
    if(isReadingMode){
      setShowChat(false);
      return;
    }
    setShowChat(true);
  },[isReadingMode]);

  // Keep a ref mirror of the latest shared document for async callbacks.
  useEffect(()=>{
    sharedDocumentRef.current=sharedDocument;
  },[sharedDocument]);

  // Re-seed the live room user list after join/rejoin snapshots.
  useEffect(()=>{
    setUsers(initialUsers||[]);
  },[initialUsers]);

  // Reset broken-avatar markers when a fresh room user payload arrives.
  useEffect(()=>{
    setBrokenAvatarUids({});
  },[users]);

  // Re-apply the reading snapshot whenever the host document or page payload changes.
  useEffect(()=>{
    const nextPage=Math.max(1, Math.floor(Number(initialReadingState?.page ?? initialReadingPage) || 1));
    // Whenever the room snapshot changes, re-seed the local reading controls
    // from the host-provided document and page state.
    setReadingPage(nextPage);
    setReadingPageInput(String(nextPage));
    setReadingTotalPages(Math.max(0, Math.floor(Number(initialReadingState?.totalPages ?? initialDocument?.totalPages) || 0)));
    setSharedDocument(initialDocument||null);
  },[initialDocument,initialReadingPage,initialReadingState]);

  // Store the latest initial audio sync snapshot in refs used by the music transport.
  useEffect(()=>{
    audioSyncStateRef.current=initialAudioState||null;
    pendingAudioSyncRef.current=initialAudioState||null;
  },[initialAudioState]);

  // Re-apply the latest server video snapshot after the player finishes mounting on join/rejoin.
  useEffect(()=>{
    if(isMusicMode||!initialVideoState){
      return;
    }
    pendingSeek.current=initialVideoState;
    if(!videoLoaded){
      return;
    }
    applySyncRef.current(
      initialVideoState,
      "",
      Number(initialVideoState.serverTime)||Date.now()/1000
    );
    pendingSeek.current=null;
  },[initialVideoState,isMusicMode,videoLoaded]);

  // Music mode uses the same pattern with audio-specific sync state and start scheduling.
  useEffect(()=>{
    if(!isMusicMode||!initialAudioState){
      return;
    }
    pendingAudioSyncRef.current=initialAudioState;
    audioSyncStateRef.current=initialAudioState;
    if(!videoLoaded){
      return;
    }
    applyAudioSyncRef.current({ audioState: initialAudioState });
  },[initialAudioState,isMusicMode,videoLoaded]);

  // Warn users when a music room expects a matching local file signature they have not loaded yet.
  useEffect(()=>{
    const nextSignature=String(initialVideoMetadata?.fileFingerprint||"");
    requiredAudioSignatureRef.current=nextSignature;
    if(isMusicMode&&!resourceUrl&&nextSignature){
      setAudioLoadWarning(`Load the matching local audio file to join this room (${nextSignature}).`);
    }else{
      setAudioLoadWarning("");
    }
  },[initialVideoMetadata?.fileFingerprint,isMusicMode,resourceUrl]);

  // Keep room resource URL/type aligned with the latest room metadata snapshot.
  useEffect(()=>{
    const nextUrl=roomContentUrl||initialVideoMetadata?.contentUrl||"";
    setResourceUrl(nextUrl);
    setResourceInput(nextUrl||"");
    const nextType=roomContentType||initialVideoMetadata?.sourceType||"unknown";
    setResourceType(nextType);
  },[roomContentUrl,roomContentType,initialVideoMetadata]);

  // Derive the active YouTube id from the current room resource URL.
  useEffect(()=>{
    setYoutubeVideoId(extractYouTubeId(resourceUrl));
    setYoutubeLoadError("");
  },[resourceUrl]);

  // Native HTML media sources can be loaded directly and then synced against the pending room state.
  useEffect(()=>{
    if(!resourceUrl||videoLoaded)return;
    if(!isDirectMediaUrl(resourceUrl))return;
    const media=getActiveHtmlMedia();
    if(!media)return;
    // Direct media URLs can be loaded into the native HTML media element
    // immediately without the YouTube bootstrap path.
    media.src=resourceUrl;
    media.load();
    media.onloadedmetadata=()=>{
      setVideoLoaded(true);
      localMediaReadyRef.current=true;
      setDuration(media.duration||0);
      if(!videoName){
        setVideoName(resourceUrl.replace(/^https?:\/\//i,"").slice(0,80));
      }
      const target=isMusicMode?(pendingAudioSyncRef.current||initialAudioState):(pendingSeek.current||initialVideoState);
      if(target){
        if(isMusicMode){
          audioSyncStateRef.current=target;
        }else{
          const now=Date.now()/1000;
          const elapsed=target.isPlaying?(now-target.lastUpdate):0;
          const t=Math.min(target.currentTime+elapsed,media.duration||MAX_VIDEO_TIME);
          suppressSeekEchoRef.current=true;
          media.currentTime=t;
          if(target.isPlaying)tryPlayWithFeedback(media);
          pendingSeek.current=null;
        }
      }
    };
  },[getActiveHtmlMedia,initialAudioState,initialVideoState,isMusicMode,resourceUrl,tryPlayWithFeedback,videoLoaded,videoName]);

  // The YouTube transport bootstraps the iframe, mirrors native player state, and converts local controls back into socket events.
  useEffect(()=>{
    if(!useYouTubePlayer){
      clearScheduledVideoStart();
      setYoutubeLoadError("");
      if(youtubeProgressRef.current){
        clearInterval(youtubeProgressRef.current);
        youtubeProgressRef.current=null;
      }
      if(youtubePlayerRef.current&&typeof youtubePlayerRef.current.destroy==="function"){
        youtubePlayerRef.current.destroy();
      }
      youtubePlayerRef.current=null;
      youtubeStateRef.current=-1;
      youtubeControlRef.current={playAt:0,pauseAt:0,seekAt:0};
      lastYouTubeSampleRef.current={time:0,at:0};
      lastYouTubeSeekEmitAtRef.current=0;
      return;
    }

    let cancelled=false;
    setVideoLoaded(false);
    setYoutubeLoadError("");
    setDuration(0);

    // The YouTube path is effectively its own transport layer: we mirror player
    // state into refs and translate native player events back into socket events.
    const blockRemoteEcho=(ms=700)=>{
      youtubeRemoteApplyUntilRef.current=Date.now()+ms;
    };

    loadYouTubeIframeApi()
      .then(YT=>{
        if(cancelled||!youtubeHostRef.current)return;
        if(youtubePlayerRef.current&&typeof youtubePlayerRef.current.destroy==="function"){
          youtubePlayerRef.current.destroy();
        }

        youtubePlayerRef.current=new YT.Player(youtubeHostRef.current,{
          width:"100%",
          height:"100%",
          videoId:youtubeVideoId,
          playerVars:{
            autoplay:0,
            controls:isMusicMode?0:1,
            rel:0,
            modestbranding:1,
            playsinline:1,
            origin:window.location.origin,
          },
          events:{
            onReady:()=>{
              if(cancelled)return;
              const player=youtubePlayerRef.current;
              setVideoLoaded(true);
              setYoutubeLoadError("");
              setVideoName(`YouTube · ${youtubeVideoId}`);
              const total=Number(player?.getDuration?.()||0);
              if(total>0)setDuration(total);
              lastYouTubeSampleRef.current={
                time:Math.max(0,Number(player?.getCurrentTime?.()||0)),
                at:Date.now(),
              };
              youtubeControlRef.current={playAt:0,pauseAt:0,seekAt:0};
              lastYouTubeSeekEmitAtRef.current=0;

              if(youtubeProgressRef.current){
                clearInterval(youtubeProgressRef.current);
              }
              youtubeProgressRef.current=setInterval(()=>{
                const p=youtubePlayerRef.current;
                if(!p||typeof p.getCurrentTime!=="function")return;
                const t=Math.max(0,Number(p.getCurrentTime())||0);
                const d=Math.max(0,Number(p.getDuration?.()||0));
                const nowMs=Date.now();
                const previous=lastYouTubeSampleRef.current;
                const isPlayingNow=youtubeStateRef.current===1;
              if(previous.at>0&&nowMs>=youtubeRemoteApplyUntilRef.current){
                const expected=isPlayingNow
                  ?previous.time+Math.max(0,(nowMs-previous.at)/1000)
                  :previous.time;
                const nativeSeekDelta=Math.abs(t-expected);
                // If the iframe drifts far enough from the locally predicted
                // timeline, treat it as a real user seek and emit it upstream.
                if(nativeSeekDelta>1.1&&(nowMs-lastYouTubeSeekEmitAtRef.current)>YOUTUBE_NATIVE_SEEK_DEBOUNCE_MS&&(nowMs-youtubeControlRef.current.seekAt)>YOUTUBE_NATIVE_SEEK_DEBOUNCE_MS){
                    youtubeControlRef.current.seekAt=nowMs;
                    emitSeekRef.current(t,isPlayingNow,1);
                    lastYouTubeSeekEmitAtRef.current=nowMs;
                  }
                }
                lastYouTubeSampleRef.current={time:t,at:nowMs};
                setCurrentTime(t);
                myTimeRef.current=t;
                if(d>0)setDuration(d);
              },400);

              const target=isMusicMode?(pendingAudioSyncRef.current||initialAudioState):(pendingSeek.current||initialVideoState);
              if(target){
                if(isMusicMode){
                  applyAudioSyncRef.current({audioState:target});
                }else{
                  applySyncRef.current(target);
                  pendingSeek.current=null;
                }
              }
            },
            onStateChange:event=>{
              const state=Number(event?.data);
              youtubeStateRef.current=state;
              if(state===1){
                setIsPlaying(true);
              }else if(state===2||state===0){
                setIsPlaying(false);
              }else if(state===3){
                handleLocalBufferingRef.current();
              }

              if(Date.now()<youtubeRemoteApplyUntilRef.current)return;
              const player=youtubePlayerRef.current;
              const nowMs=Date.now();
              const current=Math.max(0,Number(player?.getCurrentTime?.()||0));
              lastYouTubeSampleRef.current={time:current,at:nowMs};

              if(state===1){
                // Local play/pause gestures on the iframe are converted back
                // into socket requests so the server remains playback authority.
                if(!isMusicMode&&(!expectedPlayRef.current||(nowMs-youtubeControlRef.current.playAt)>YOUTUBE_LOCAL_CONTROL_DEBOUNCE_MS)){
                  youtubeControlRef.current.playAt=nowMs;
                  expectedPlayRef.current=true;
                  youtubeRemoteApplyUntilRef.current=nowMs+YOUTUBE_REMOTE_GUARD_MS;
                  player?.pauseVideo?.();
                  setIsPlaying(false);
                  socket?.emit("request_play",{roomCode,currentTime:current});
                  return;
                }
                expectedPlayRef.current=true;
                if(isMusicMode){
                  socket?.emit("request_play",{roomCode,currentTime:current});
                }
                return;
              }
              if(state===2||state===0){
                if(!expectedPlayRef.current&&state!==0)return;
                if((nowMs-youtubeControlRef.current.pauseAt)<=YOUTUBE_LOCAL_CONTROL_DEBOUNCE_MS&&state!==0){
                  expectedPlayRef.current=false;
                  return;
                }
                youtubeControlRef.current.pauseAt=nowMs;
                expectedPlayRef.current=false;
                socket?.emit("request_pause",{roomCode,currentTime:current});
              }
            },
            onError:event=>{
              const message=describeYouTubePlayerError(event?.data,youtubeVideoId);
              setVideoLoaded(false);
              setYoutubeLoadError(message);
              addToast(message,"error");
            },
          },
        });
      })
      .catch(error=>{
        if(cancelled)return;
        const message=error.message==="Failed to load YouTube API"||error.message==="YouTube API load timed out"
          ?"This device could not reach the YouTube player. Check the network or disable ad blockers/privacy shields."
          :(error.message||"Could not initialize YouTube player");
        setYoutubeLoadError(message);
        addToast(message,"error");
      });

    return()=>{
      cancelled=true;
      clearScheduledVideoStart();
      if(youtubeProgressRef.current){
        clearInterval(youtubeProgressRef.current);
        youtubeProgressRef.current=null;
      }
      if(youtubePlayerRef.current&&typeof youtubePlayerRef.current.destroy==="function"){
        youtubePlayerRef.current.destroy();
      }
      youtubePlayerRef.current=null;
      youtubeStateRef.current=-1;
      youtubeControlRef.current={playAt:0,pauseAt:0,seekAt:0};
      lastYouTubeSampleRef.current={time:0,at:0};
      lastYouTubeSeekEmitAtRef.current=0;
      blockRemoteEcho(0);
    };
  },[useYouTubePlayer,youtubeVideoId,youtubeRetryNonce,initialAudioState,initialVideoState,addToast,clearScheduledVideoStart,isMusicMode,roomCode,socket]);

  const handleSendFriendFromRoom=useCallback(async(target)=>{
    if(!target?.uid||!onSendFriendRequest)return;
    const currentStatus=friendStatusByUid[target.uid]||"";
    setFriendBusyByUid(prev=>({...prev,[target.uid]:true}));
    try{
      if(currentStatus==="needs_accept"&&onRespondFriendRequest){
        await onRespondFriendRequest(target.uid,"accept");
        setFriendStatusByUid(prev=>({...prev,[target.uid]:"already_friends"}));
        return;
      }
      const status=await onSendFriendRequest(target.uid,target.username,target.name);
      if(status){
        setFriendStatusByUid(prev=>({...prev,[target.uid]:status}));
      }
    }finally{
      setFriendBusyByUid(prev=>({...prev,[target.uid]:false}));
    }
  },[onSendFriendRequest,onRespondFriendRequest,friendStatusByUid]);

  const handleInviteFriendFromRoom=useCallback(async(target)=>{
    if(!target?.uid||!target.online||!onInviteFriend)return;
    setInviteBusyByUid(prev=>({...prev,[target.uid]:true}));
    try{
      await onInviteFriend(target.uid);
      const expiresAt=Date.now()+ROOM_INVITE_RESEND_COOLDOWN_MS;
      clearInviteCooldownForUid(target.uid);
      setInviteHistoryByUid(prev=>({...prev,[target.uid]:true}));
      setInviteCooldownByUid(prev=>({...prev,[target.uid]:expiresAt}));
      inviteCooldownTimeoutsRef.current[target.uid]=setTimeout(()=>{
        clearInviteCooldownForUid(target.uid);
      },ROOM_INVITE_RESEND_COOLDOWN_MS);
    }catch(error){
      addToast(error.message||"Could not send invite","error");
    }finally{
      setInviteBusyByUid(prev=>({...prev,[target.uid]:false}));
    }
  },[onInviteFriend,addToast,clearInviteCooldownForUid]);

  // Preload friendship state for the current room roster so the header/menu labels are accurate immediately.
  useEffect(()=>{
    let cancelled=false;
    let refreshTimer=null;

    const syncRoomFriendStatuses=async()=>{
      if(!auth.currentUser){
        setFriendStatusByUid({});
        setAvailableFriends([]);
        return;
      }

      try{
        const token=await auth.currentUser.getIdToken();
        const res=await fetch(`${SERVER_URL}/api/friends`,{
          headers:{Authorization:`Bearer ${token}`},
        });
        if(!res.ok)return;
        const data=await res.json().catch(()=>({}));
        if(cancelled)return;

        const friendsSet=new Set((Array.isArray(data?.friends)?data.friends:[]).map(item=>item?.uid).filter(Boolean));
        const incomingSet=new Set((Array.isArray(data?.incomingRequests)?data.incomingRequests:[]).map(item=>item?.uid).filter(Boolean));
        const outgoingSet=new Set((Array.isArray(data?.outgoingRequests)?data.outgoingRequests:[]).map(item=>item?.uid).filter(Boolean));
        const friendRows=Array.isArray(data?.friends)?data.friends:[];

        const nextStatuses={};
        // Preload room-member friendship state so the header/menu renders "Friends"
        // immediately instead of waiting for the user to click "Add Friend" first.
        otherUsers.forEach(target=>{
          if(friendsSet.has(target.uid)){
            nextStatuses[target.uid]="already_friends";
          }else if(incomingSet.has(target.uid)){
            nextStatuses[target.uid]="needs_accept";
          }else if(outgoingSet.has(target.uid)){
            nextStatuses[target.uid]="already_requested";
          }
        });

        setFriendStatusByUid(nextStatuses);
        setAvailableFriends(friendRows);
      }catch{
        // Keep whatever room-level status we already have if the sync request fails.
      }
    };

    syncRoomFriendStatuses();
    if(showFriendMenu){
      refreshTimer=setInterval(syncRoomFriendStatuses,15000);
    }
    return()=>{
      cancelled=true;
      if(refreshTimer)clearInterval(refreshTimer);
    };
  },[otherUserIdsKey,user.uid,showFriendMenu]);

  // Keep the newest chat message in view as the conversation grows.
  useEffect(()=>{chatEndRef.current?.scrollIntoView({behavior:"smooth"});},[messages]);

  // Track browser fullscreen changes so the footer button stays in sync with actual fullscreen state.
  useEffect(()=>{
    const h=()=>setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange",h);
    return()=>document.removeEventListener("fullscreenchange",h);
  },[]);

  // Finish scrubbing on pointer release even if the pointer leaves the range input.
  useEffect(()=>{
    const handleGlobalPointerUp=()=>{
      if(isScrubbing.current){
        isScrubbing.current=false;
        const currentTimeValue=useYouTubePlayer
          ? Math.max(0,Number(youtubePlayerRef.current?.getCurrentTime?.()||0))
          : Math.max(0,Number(getActiveHtmlMedia()?.currentTime||0));
        emitSeekRef.current(currentTimeValue);
      }
    };
    window.addEventListener("pointerup",handleGlobalPointerUp);
    window.addEventListener("pointercancel",handleGlobalPointerUp);
    return()=>{
      window.removeEventListener("pointerup",handleGlobalPointerUp);
      window.removeEventListener("pointercancel",handleGlobalPointerUp);
    };
  },[getActiveHtmlMedia,useYouTubePlayer]);

  // ── Apply sync from server ────────────────────────────────────────────────
  const applySync=useCallback((videoState,triggeredBy,serverTime)=>{
    if(!videoState)return;
    if(isScrubbing.current)return;

    const now=Date.now()/1000;
    if(now-lastSyncAt.current<0.2)return;
    lastSyncAt.current=now;

    const{isPlaying:shouldPlay,playbackRate:rate}=videoState;
    expectedPlayRef.current=!!shouldPlay;
    const syncNow=Number.isFinite(Number(serverTime))?Number(serverTime):now;
    const startDelayMs=resolveVideoStartDelayMs(videoState,now);

    if(useYouTubePlayer){
      const player=youtubePlayerRef.current;
      if(!player||!videoLoaded){
        pendingSeek.current=videoState;
        return;
      }

      const durationSafe=Math.max(1,Number(player.getDuration?.()||duration||MAX_VIDEO_TIME));
      const expected=Math.min(resolveVideoTargetTime(videoState,syncNow),durationSafe);
      const scheduledTarget=Math.min(resolveVideoTargetTime(videoState,Math.max(now,Number(videoState.scheduledStartAt)||syncNow)),durationSafe);
      const current=Math.max(0,Number(player.getCurrentTime?.()||0));
      const diff=Math.abs(current-expected);

      clearScheduledVideoStart();
      // Hard seek only when the player is materially out of place; smaller
      // differences are allowed to avoid visible jitter from constant nudges.
      if(diff>0.45){
        youtubeControlRef.current.seekAt=Date.now();
        lastYouTubeSeekEmitAtRef.current=Date.now();
        youtubeRemoteApplyUntilRef.current=Date.now()+YOUTUBE_REMOTE_GUARD_MS;
        player.seekTo(expected,true);
      }

      const shouldPlayLocally = shouldPlay && !syncWaitRef.current.active;
      const isPlayingState=youtubeStateRef.current===1;
      if(shouldPlayLocally){
        // Scheduled future starts are handled by pausing first, seeking near the
        // target, then resuming at the exact delayed start instant.
        if(startDelayMs>YOUTUBE_SCHEDULE_BUFFER_MS){
          youtubeControlRef.current.seekAt=Date.now();
          lastYouTubeSeekEmitAtRef.current=Date.now();
          youtubeRemoteApplyUntilRef.current=Date.now()+startDelayMs+YOUTUBE_REMOTE_GUARD_MS;
          if(Math.abs(current-scheduledTarget)>0.2){
            player.seekTo?.(scheduledTarget,true);
          }
          if(isPlayingState){
            player.pauseVideo?.();
          }
          videoScheduleTimeoutRef.current=setTimeout(()=>{
            const playerRef=youtubePlayerRef.current;
            if(!playerRef)return;
            const targetAtStart=Math.min(resolveVideoTargetTime(videoState,Date.now()/1000),durationSafe);
            youtubeControlRef.current.playAt=Date.now();
            youtubeControlRef.current.seekAt=Date.now();
            lastYouTubeSeekEmitAtRef.current=Date.now();
            youtubeRemoteApplyUntilRef.current=Date.now()+YOUTUBE_REMOTE_GUARD_MS;
            playerRef.seekTo?.(targetAtStart,true);
            playerRef.playVideo?.();
            setCurrentTime(targetAtStart);
            setIsPlaying(true);
          },startDelayMs);
        }else if(!isPlayingState){
          youtubeControlRef.current.playAt=Date.now();
          youtubeRemoteApplyUntilRef.current=Date.now()+YOUTUBE_REMOTE_GUARD_MS;
          player.playVideo?.();
        }
      }else{
        if(isPlayingState){
          youtubeControlRef.current.pauseAt=Date.now();
          youtubeRemoteApplyUntilRef.current=Date.now()+YOUTUBE_REMOTE_GUARD_MS;
          player.pauseVideo?.();
        }
      }

      setCurrentTime(Math.max(0,Number(player.getCurrentTime?.()||expected)));
      setDuration(Math.max(0,Number(player.getDuration?.()||duration)));
      setIsPlaying(youtubeStateRef.current===1);
      if(triggeredBy)showBanner(triggeredBy);
      return;
    }

    const video=videoRef.current;
    if(!video){pendingSeek.current=videoState;return;}
    if(!videoLoaded){pendingSeek.current=videoState;return;}

    const expected=Math.min(resolveVideoTargetTime(videoState,syncNow),video.duration||MAX_VIDEO_TIME);
    const scheduledTarget=Math.min(resolveVideoTargetTime(videoState,Math.max(now,Number(videoState.scheduledStartAt)||syncNow)),video.duration||MAX_VIDEO_TIME);
    const diff=Math.abs(video.currentTime-expected);
    const targetRate=(typeof rate==="number"&&rate>0&&rate<=4)?rate:1;

    // The HTML5 path mirrors the YouTube path: seek only when necessary, then
    // either pause or start according to the authoritative synced state.
    if(Math.abs(video.playbackRate-targetRate)>0.01)video.playbackRate=targetRate;

    clearScheduledVideoStart();
    if(diff>0.35){
      suppressSeekEchoRef.current=true;
      video.currentTime=expected;
    }

    const shouldPlayLocally = shouldPlay && !syncWaitRef.current.active;
    if(shouldPlayLocally){
      if(startDelayMs>YOUTUBE_SCHEDULE_BUFFER_MS){
        if(Math.abs(video.currentTime-scheduledTarget)>0.2){
          suppressSeekEchoRef.current=true;
          video.currentTime=scheduledTarget;
        }
        if(!video.paused)video.pause();
        videoScheduleTimeoutRef.current=setTimeout(()=>{
          const playerRef=videoRef.current;
          if(!playerRef)return;
          const targetAtStart=Math.min(resolveVideoTargetTime(videoState,Date.now()/1000),playerRef.duration||MAX_VIDEO_TIME);
          suppressSeekEchoRef.current=true;
          playerRef.currentTime=targetAtStart;
          tryPlayWithFeedback(playerRef);
        },startDelayMs);
      }else if(video.paused){
        tryPlayWithFeedback(video);
      }
    }else if(!video.paused){
      video.pause();
    }

    setIsPlaying(!video.paused);
    if(triggeredBy)showBanner(triggeredBy);
  },[
    clearScheduledVideoStart,
    duration,
    resolveVideoStartDelayMs,
    resolveVideoTargetTime,
    showBanner,
    tryPlayWithFeedback,
    useYouTubePlayer,
    videoLoaded,
  ]);
  // Keep applySync in a ref so socket listeners can always call the newest sync algorithm.
  useEffect(()=>{applySyncRef.current=applySync;},[applySync]);

  const applyAudioSync=useCallback((payload={})=>{
    if(!isMusicMode)return;
    const nextState=payload?.audioState||payload;
    if(!nextState||typeof nextState!=="object")return;
    audioSyncStateRef.current=nextState;
    pendingAudioSyncRef.current=nextState;
    expectedPlayRef.current=nextState.status==="playing";
    clearScheduledAudioStart();
    clearAudioRateReset();

    const scheduleDelayMs=Math.max(0,Math.round(Number(nextState.serverTime||Date.now())-Date.now()));
    // Music sync is driven by a server clock timestamp instead of immediate
    // play/pause calls, which makes cross-device starts much tighter.
    console.debug("[music-sync] audio_sync",{
      action:payload?.action||"",
      status:nextState.status,
      startTime:Number(nextState.startTime||0),
      serverTime:Number(nextState.serverTime||0),
      scheduleDelayMs,
      mediaType:payload?.mediaType||resourceType,
    });

    if(useYouTubePlayer){
      const player=youtubePlayerRef.current;
      if(!player||!videoLoaded)return;
      if(nextState.status!=="playing"){
        const pausedAt=Math.max(0,Number(nextState.startTime)||0);
        youtubeRemoteApplyUntilRef.current=Date.now()+500;
        player.seekTo?.(pausedAt,true);
        player.pauseVideo?.();
        setCurrentTime(pausedAt);
        setIsPlaying(false);
        pendingAudioSyncRef.current=null;
        return;
      }

      const startPlayback=()=>{
        const target=resolveAudioTargetTime(nextState,Date.now());
        const playerRef=youtubePlayerRef.current;
        if(!playerRef)return;
        youtubeRemoteApplyUntilRef.current=Date.now()+900;
        playerRef.seekTo?.(target,true);
        playerRef.playVideo?.();
        setCurrentTime(target);
        setIsPlaying(true);
        pendingAudioSyncRef.current=null;
        if(payload?.triggeredBy)showBanner(payload.triggeredBy);
      };

      if(scheduleDelayMs>30){
        audioScheduleTimeoutRef.current=setTimeout(startPlayback,scheduleDelayMs);
      }else{
        startPlayback();
      }
      return;
    }

    const media=getActiveHtmlMedia();
    if(!media||!videoLoaded)return;
    if(nextState.status!=="playing"){
      const pausedAt=Math.max(0,Number(nextState.startTime)||0);
      media.pause();
      clearAudioRateReset();
      media.currentTime=pausedAt;
      setCurrentTime(pausedAt);
      setIsPlaying(false);
      pendingAudioSyncRef.current=null;
      return;
    }

      const startPlayback=()=>{
        const target=resolveAudioTargetTime(nextState,Date.now());
        // For local audio we prefer one clean seek at start time, then let the
        // drift-correction loop handle smaller corrections later.
        media.currentTime=target;
      media.playbackRate=1;
      tryPlayWithFeedback(media);
      setCurrentTime(target);
      setIsPlaying(true);
      pendingAudioSyncRef.current=null;
      if(payload?.triggeredBy)showBanner(payload.triggeredBy);
    };

    if(scheduleDelayMs>30){
      audioScheduleTimeoutRef.current=setTimeout(startPlayback,scheduleDelayMs);
    }else{
      startPlayback();
    }
  },[
    clearAudioRateReset,
    clearScheduledAudioStart,
    getActiveHtmlMedia,
    isMusicMode,
    resourceType,
    resolveAudioTargetTime,
    showBanner,
    tryPlayWithFeedback,
    useYouTubePlayer,
    videoLoaded,
  ]);
  // Mirror the latest audio sync applicator for socket listeners and deferred music sync.
  useEffect(()=>{applyAudioSyncRef.current=applyAudioSync;},[applyAudioSync]);

  // If a music sync payload arrives before the player is ready, replay it once media loading finishes.
  useEffect(()=>{
    if(!isMusicMode||!videoLoaded||!pendingAudioSyncRef.current)return;
    applyAudioSyncRef.current({audioState:pendingAudioSyncRef.current});
  },[isMusicMode,videoLoaded,useYouTubePlayer]);

  // Periodically measure music drift and correct large gaps with seeks or small gaps with temporary rate nudges.
  useEffect(()=>{
    if(audioDriftIntervalRef.current){
      clearInterval(audioDriftIntervalRef.current);
      audioDriftIntervalRef.current=null;
    }
    if(!isMusicMode||!videoLoaded)return undefined;

    audioDriftIntervalRef.current=setInterval(()=>{
      const syncState=audioSyncStateRef.current;
      if(!syncState||syncState.status!=="playing")return;
      const targetTime=resolveAudioTargetTime(syncState,Date.now());
      const currentTimeValue=useYouTubePlayer
        ?Math.max(0,Number(youtubePlayerRef.current?.getCurrentTime?.()||0))
        :Math.max(0,Number(getActiveHtmlMedia()?.currentTime||0));
      const drift=currentTimeValue-targetTime;
      // The drift loop uses two correction tiers: hard seek for large errors,
      // temporary playback-rate nudges for smaller but noticeable skew.
      console.debug("[music-sync] drift",{
        drift:Number(drift.toFixed(3)),
        targetTime:Number(targetTime.toFixed(3)),
        currentTime:Number(currentTimeValue.toFixed(3)),
      });

      if(useYouTubePlayer){
        const player=youtubePlayerRef.current;
        if(!player)return;
        if(Math.abs(drift)>1.5){
          console.debug("[music-sync] hard_resync_youtube",{targetTime:Number(targetTime.toFixed(3)),drift:Number(drift.toFixed(3))});
          youtubeRemoteApplyUntilRef.current=Date.now()+900;
          player.seekTo?.(targetTime,true);
          return;
        }
        if(Math.abs(drift)>0.35){
          console.debug("[music-sync] nudge_seek_youtube",{targetTime:Number(targetTime.toFixed(3)),drift:Number(drift.toFixed(3))});
          youtubeRemoteApplyUntilRef.current=Date.now()+700;
          player.seekTo?.(targetTime,true);
        }
        return;
      }

      const media=getActiveHtmlMedia();
      if(!media)return;
      if(Math.abs(drift)>1.5){
        console.debug("[music-sync] hard_resync_audio",{targetTime:Number(targetTime.toFixed(3)),drift:Number(drift.toFixed(3))});
        clearAudioRateReset();
        media.currentTime=targetTime;
        setAudioDebugStatus(`Hard resync ${drift.toFixed(2)}s`);
        return;
      }
      if(Math.abs(drift)>0.2){
        const correctionRate=drift>0?0.97:1.03;
        console.debug("[music-sync] rate_correction_audio",{drift:Number(drift.toFixed(3)),correctionRate});
        clearAudioRateReset();
        media.playbackRate=correctionRate;
        setAudioDebugStatus(`Drift ${drift.toFixed(2)}s -> rate ${correctionRate.toFixed(2)}`);
        audioRateResetTimeoutRef.current=setTimeout(()=>{
          const latest=getActiveHtmlMedia();
          if(latest)latest.playbackRate=1;
          setAudioDebugStatus("Locked to master clock");
        },900);
      }else{
        setAudioDebugStatus("Locked to master clock");
      }
    },3000);

    return()=>{
      if(audioDriftIntervalRef.current){
        clearInterval(audioDriftIntervalRef.current);
        audioDriftIntervalRef.current=null;
      }
    };
  },[clearAudioRateReset,getActiveHtmlMedia,isMusicMode,resolveAudioTargetTime,useYouTubePlayer,videoLoaded]);

  const applyReadingState=useCallback((page,totalPages=0)=>{
    // Reading state is always clamped against the known total pages so typing
    // into the page jump input cannot push the UI outside document bounds.
    const nextTotalPages=Math.max(0,Math.floor(Number(totalPages)||0));
    const maxPage=nextTotalPages||readingTotalPages||sharedDocumentRef.current?.totalPages||5000;
    const nextPage=Math.max(1,Math.min(maxPage,Math.floor(Number(page)||1)));
    if(nextTotalPages>0){
      setReadingTotalPages(nextTotalPages);
    }
    setReadingPage(nextPage);
    setReadingPageInput(String(nextPage));
    return nextPage;
  },[readingTotalPages]);

  // ── Socket events ─────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!socket)return;
    // sync_state is the authoritative playback snapshot for watch/podcast/study rooms.
    const onSync=({videoState,triggeredBy,serverTime})=>{
      if(isMusicMode)return;
      applySyncRef.current(videoState,triggeredBy,serverTime);
    };
    // audio_sync carries the server-clock-based payload used by music rooms.
    const onAudioSync=payload=>{
      if(!isMusicMode)return;
      applyAudioSyncRef.current(payload);
    };
    // Chat events keep the room timeline and emoji reaction counts aligned.
    const onMsg=msg=>setMessages(p=>{const n=[...p,{...msg,reactions:msg.reactions||{}}];return n.length>MAX_MESSAGES?n.slice(-MAX_MESSAGES):n;});
    const onReaction=({messageId,reactions})=>setMessages(p=>p.map(m=>m.id===messageId?{...m,reactions}:m));
    // Reading/document events normalize different payload shapes into one shared document state.
    const applyIncomingReadingDocument=({document,fileUrl,signature,page,totalPages}={})=>{
      if(!isReadingMode)return;
      // Some socket events send a full document object while others send a
      // lighter payload, so normalize both shapes into one document record here.
      const nextDocument=document?.fileUrl
        ?document
        :(fileUrl
          ?{
            fileUrl,
            fileName:guessDocumentFileName(fileUrl),
            fileSize:0,
            mimeType:"application/pdf",
            signature:signature||buildDocumentSignature(guessDocumentFileName(fileUrl),0),
            totalPages:Math.max(0,Math.floor(Number(totalPages)||0)),
          }
          :null);
      if(!nextDocument)return;
      setSharedDocument(nextDocument);
      setResourceUrl(nextDocument.fileUrl||"");
      setResourceInput(nextDocument.fileUrl||"");
      setResourceType("pdf");
      setVideoName(nextDocument.fileName||guessDocumentFileName(nextDocument.fileUrl));
      setReadingPdfError("");
      applyReadingState(page||1,totalPages??nextDocument.totalPages??0);
    };
    const applyIncomingReadingPage=({page,totalPages,updatedBy,username:pageUsername}={})=>{
      if(!isReadingMode)return;
      const next=applyReadingState(page,totalPages);
      if(updatedBy&&updatedBy!==user.uid){
        showBanner(`Page ${next}`);
        if(pageUsername)addToast(`@${pageUsername} moved to page ${next}`,"info");
      }
    };
    const onReadingPage=payload=>applyIncomingReadingPage(payload);
    const onSyncPage=payload=>applyIncomingReadingPage(payload);
    const onDocumentReady=payload=>{
      applyIncomingReadingDocument(payload);
      if(payload?.updatedBy&&payload.updatedBy!==user.uid){
        showBanner("Shared PDF updated");
        if(payload?.username)addToast(`@${payload.username} shared a new PDF`,"info");
      }
    };
    const onInitialState=payload=>{
      if(!isReadingMode)return;
      applyIncomingReadingDocument(payload);
      const resolvedPage=payload?.readingState?.page??payload?.page??1;
      const resolvedTotalPages=payload?.readingState?.totalPages??payload?.totalPages??payload?.document?.totalPages??0;
      applyReadingState(resolvedPage,resolvedTotalPages);
    };
    // Room lifecycle handlers keep connectivity, participant counts, and expiry feedback aligned.
    const onUserCount=({users:u})=>{if(u)setUsers(u);};
    const onExpired=()=>{addToast("Room expired","error");onLeave();};
    const onError=({message})=>addToast(message||"Error","error");
    const onDisconnect=()=>{setConnected(false);};
    const onConnect=()=>{setConnected(true);addToast("Reconnected!","success");};
    const onUserLeft=({name:n})=>addToast(`${n} left`,"info");

    const onUserOffline=({uid:pUid,name:n,username:un})=>{
      // Offline events are treated more seriously than a normal leave because
      // the room may be mid-playback and should pause to preserve fairness.
      if(isMusicMode){
        pushSystemMessage(`@${un||n} went offline`,"offline");
        addToast(`@${un||n} went offline`,"info");
        return;
      }
      pushSystemMessage(`@${un||n} went offline — video paused`,"offline");
      if(syncWaitRef.current.active&&syncWaitRef.current.waitForUid===pUid){
        syncWaitRef.current={active:false,waitForUid:null,waitForUsername:null};
        setWaitingForUser(null);
      }
      if(useYouTubePlayer){
        clearScheduledVideoStart();
        const player=youtubePlayerRef.current;
        if(player&&youtubeStateRef.current===1){
          youtubeRemoteApplyUntilRef.current=Date.now()+900;
          player.pauseVideo?.();
        }
      }else if(videoRef.current&&!videoRef.current.paused){
        videoRef.current.pause();
      }
      setIsPlaying(false);
      addToast(`@${un||n} went offline — video paused`,"error");
    };

    const onUserJoined=({name:n,username:un})=>{
      pushSystemMessage(`@${un||n} is back online`,"online");
      addToast(`@${un||n} is back — press play when ready`,"success");
    };

    // Sync-wait events pause/resume the local client when someone falls too far behind.
    const onSyncWaiting=({waitForUid,waitForUsername,gap})=>{
      const now=Date.now();
      if(now-lastSyncWaitNoticeAt.current>2500){
        pushSystemMessage(`Waiting for @${waitForUsername||"friend"} (${Math.max(0,Number(gap)||0).toFixed(1)}s gap)`,"waiting");
        lastSyncWaitNoticeAt.current=now;
      }
      showBanner(`Waiting for @${waitForUsername||"friend"}...`);
      // "sync_waiting" is informational; only "force_sync_wait" actually pauses
      // this client. That distinction avoids duplicate pause behavior.
      if(syncWaitRef.current.active&&syncWaitRef.current.waitForUid===waitForUid){
        setWaitingForUser(waitForUsername||"friend");
      }
    };

    const onForceSyncWait=({waitForUid,waitForUsername})=>{
      syncWaitRef.current={active:true,waitForUid,waitForUsername:waitForUsername||"friend"};
      setWaitingForUser(waitForUsername||"friend");
      clearScheduledVideoStart();
      if(useYouTubePlayer){
        const player=youtubePlayerRef.current;
        if(player&&youtubeStateRef.current===1){
          youtubeRemoteApplyUntilRef.current=Date.now()+900;
          player.pauseVideo?.();
        }
      }else{
        const video=videoRef.current;
        if(video&&!video.paused)video.pause();
      }
      setIsPlaying(false);
      showBanner(`Waiting for @${waitForUsername||"friend"}...`);
      addToast(`You are ahead. Waiting for @${waitForUsername||"friend"}.`,"info");
    };

    const onResumeSyncWait=({waitForUid,waitForUsername})=>{
      if(!syncWaitRef.current.active)return;
      if(syncWaitRef.current.waitForUid&&waitForUid&&syncWaitRef.current.waitForUid!==waitForUid)return;
      syncWaitRef.current={active:false,waitForUid:null,waitForUsername:null};
      setWaitingForUser(null);
      showBanner(`Back in sync with @${waitForUsername||"friend"}`);
      addToast(`Back in sync with @${waitForUsername||"friend"}`,"success");
      setTimeout(()=>{
        if(useYouTubePlayer){
          const player=youtubePlayerRef.current;
          if(expectedPlayRef.current&&videoLoadedRef.current&&player&&youtubeStateRef.current!==1){
            youtubeRemoteApplyUntilRef.current=Date.now()+900;
            player.playVideo?.();
          }
          return;
        }
        const video=videoRef.current;
        if(expectedPlayRef.current&&videoLoadedRef.current&&video&&video.paused){
          tryPlayWithFeedbackRef.current(video);
        }
      },150);
    };

    const onSyncWaitingResolved=({waitForUsername}={})=>{
      if(syncWaitRef.current.active){
        syncWaitRef.current={active:false,waitForUid:null,waitForUsername:null};
        setWaitingForUser(null);
      }
      if(waitForUsername){
        pushSystemMessage(`Back in sync with @${waitForUsername}`,"online");
      }
    };

    // Metadata/social side-channel events update source info, host changes, and friend notices.
    const onVideoMetadataUpdated=({metadata,updatedBy})=>{
      if(!metadata)return;
      if(updatedBy&&updatedBy===user.uid)return;
      if(isReadingMode&&metadata.sourceType==="pdf"){
        return;
      }
      if(isMusicMode){
        // Music metadata updates can describe either a shared URL source or a
        // host-selected local file that everyone must load manually.
        setVideoName(metadata.videoName||"Shared audio");
        setDuration(Number(metadata.duration)||0);
        const nextSignature=String(metadata.fileFingerprint||"");
        const media=getActiveHtmlMedia();
        requiredAudioSignatureRef.current=nextSignature;
        if(metadata.contentUrl){
          localAudioSignatureRef.current="";
          localMediaReadyRef.current=false;
          setResourceUrl(metadata.contentUrl);
          setResourceInput(metadata.contentUrl);
          setResourceType(metadata.sourceType||"local");
          setAudioLoadWarning("");
          setVideoLoaded(false);
        }else{
          const hasMatchingLocalFile=Boolean(
            nextSignature
            && localAudioSignatureRef.current===nextSignature
            && (media?.currentSrc||media?.src)
          );
          setResourceUrl("");
          setResourceInput("");
          setResourceType(metadata.sourceType||"local");
          if(hasMatchingLocalFile){
            setAudioLoadWarning("");
            localMediaReadyRef.current=true;
            setVideoLoaded(true);
          }else{
            localAudioSignatureRef.current="";
            localMediaReadyRef.current=false;
            setVideoLoaded(false);
            setAudioLoadWarning(
              nextSignature
                ?`A local audio file was selected. Load the matching file (${nextSignature}) to sync.`
                :"A local audio file was selected. Load the matching file to sync."
            );
            if(media){
              media.pause();
              media.removeAttribute("src");
              media.load?.();
            }
          }
        }
        showBanner("Shared audio source updated");
        addToast(`Room audio changed to ${metadata.videoName||metadata.sourceType||"a new source"}`,"info");
        return;
      }
      const srcLabel=metadata.sourceType==="local"?"local file":metadata.sourceType||"video";
      if(metadata.contentUrl){
        setResourceUrl(metadata.contentUrl);
        setResourceInput(metadata.contentUrl);
      }
      if(metadata.sourceType){
        setResourceType(metadata.sourceType);
      }
      showBanner(`Partner loaded ${srcLabel}`);
      addToast(`Partner updated video metadata (${srcLabel})`,"info");
    };
    const onFriendRequestReceived=({from})=>{
      const label=from?.username?`@${from.username}`:from?.displayName||"Friend";
      pushSystemMessage(`${label} sent you a friend request`,"online");
    };
    const onHostTransferred=({hostId,hostUser})=>{
      if(!hostId)return;
      if(hostId===user.uid){
        addToast("Host controls transferred to you","success");
        showBanner("You are now the host");
        return;
      }
      const label=hostUser?.username?`@${hostUser.username}`:hostUser?.name||"the new host";
      addToast(`Host changed to ${label}`,"info");
      showBanner(`Host changed to ${label}`);
    };

    // Receive time heartbeats from others
    const onTimeUpdate=({uid:pUid,username:pUsername,time})=>{
      setMemberTimes(prev=>({...prev,[pUid]:{username:pUsername,time}}));
    };

    // Register all listeners together so teardown can be a one-to-one mirror.
    socket.on("sync_state",onSync);socket.on("new_message",onMsg);
    socket.on("audio_sync",onAudioSync);
    socket.on("message_reaction_update",onReaction);socket.on("user_count_update",onUserCount);
    socket.on("room_expired",onExpired);socket.on("error",onError);
    socket.on("disconnect",onDisconnect);socket.on("connect",onConnect);
    socket.on("user_left",onUserLeft);socket.on("user_offline",onUserOffline);
    socket.on("user_joined",onUserJoined);socket.on("member_time_update",onTimeUpdate);
    socket.on("sync_waiting",onSyncWaiting);
    socket.on("force_sync_wait",onForceSyncWait);
    socket.on("resume_sync_wait",onResumeSyncWait);
    socket.on("sync_waiting_resolved",onSyncWaitingResolved);
    socket.on("video_metadata_updated",onVideoMetadataUpdated);
    socket.on("friend_request_received",onFriendRequestReceived);
    socket.on("document_ready",onDocumentReady);
    socket.on("initial_state",onInitialState);
    socket.on("sync_page",onSyncPage);
    socket.on("host_transferred",onHostTransferred);
    socket.on("reading_page_update",onReadingPage);

    // Remove every listener on unmount/reconnect to prevent duplicate handlers.
    return()=>{
      socket.off("sync_state",onSync);socket.off("new_message",onMsg);
      socket.off("audio_sync",onAudioSync);
      socket.off("message_reaction_update",onReaction);socket.off("user_count_update",onUserCount);
      socket.off("room_expired",onExpired);socket.off("error",onError);
      socket.off("disconnect",onDisconnect);socket.off("connect",onConnect);
      socket.off("user_left",onUserLeft);socket.off("user_offline",onUserOffline);
      socket.off("user_joined",onUserJoined);socket.off("member_time_update",onTimeUpdate);
      socket.off("sync_waiting",onSyncWaiting);
      socket.off("force_sync_wait",onForceSyncWait);
      socket.off("resume_sync_wait",onResumeSyncWait);
      socket.off("sync_waiting_resolved",onSyncWaitingResolved);
      socket.off("video_metadata_updated",onVideoMetadataUpdated);
      socket.off("friend_request_received",onFriendRequestReceived);
      socket.off("document_ready",onDocumentReady);
      socket.off("initial_state",onInitialState);
      socket.off("sync_page",onSyncPage);
      socket.off("host_transferred",onHostTransferred);
      socket.off("reading_page_update",onReadingPage);
    };
  },[socket,addToast,applyReadingState,clearScheduledVideoStart,getActiveHtmlMedia,isMusicMode,onLeave,pushSystemMessage,showBanner,user.uid,useYouTubePlayer,isReadingMode]);

  // My own time in memberTimes
  useEffect(()=>{
    if(!videoLoaded)return;
    setMemberTimes(prev=>({...prev,[user.uid]:{username,time:currentTime}}));
  },[currentTime,videoLoaded,user.uid,username]);

  // Broadcast my time to others every 2s
  useEffect(()=>{
    if(!socket||!videoLoaded||isMusicMode)return;
    // Heartbeats are disabled for music rooms because music uses server-time
    // scheduling rather than per-member drift voting.
    heartbeatRef.current=setInterval(()=>{
      const health=getPlaybackHealth();
      socket.emit("time_update",{
        roomCode,
        username,
        time:myTimeRef.current,
        bufferAhead:health.bufferAhead,
        readyState:health.readyState,
        isBuffering:health.isBuffering,
      });
    },2000);
    return()=>clearInterval(heartbeatRef.current);
  },[socket,videoLoaded,isMusicMode,roomCode,username,getPlaybackHealth]);

  // Tear down timers, player instances, and object URLs when the room unmounts.
  useEffect(()=>()=>{
    clearScheduledVideoStart();
    clearInterval(syncIntervalRef.current);clearInterval(heartbeatRef.current);
    clearInterval(youtubeProgressRef.current);
    clearScheduledAudioStart();
    clearAudioRateReset();
    clearInterval(audioDriftIntervalRef.current);
    syncWaitRef.current={active:false,waitForUid:null,waitForUsername:null};
    if(youtubePlayerRef.current&&typeof youtubePlayerRef.current.destroy==="function"){
      youtubePlayerRef.current.destroy();
    }
    if(videoObjectUrl.current){URL.revokeObjectURL(videoObjectUrl.current);videoObjectUrl.current=null;}
  },[clearAudioRateReset,clearScheduledAudioStart,clearScheduledVideoStart]);

  const toBase64=useCallback((buffer)=>{
    const bytes=new Uint8Array(buffer);
    const chunkSize=0x8000;
    let binary="";
    for(let i=0;i<bytes.length;i+=chunkSize){
      const chunk=bytes.subarray(i,i+chunkSize);
      binary+=String.fromCharCode(...chunk);
    }
    return btoa(binary);
  },[]);

  const emitSocketAck=useCallback((eventName,payload)=>new Promise((resolve,reject)=>{
    if(!socket){
      reject(new Error("Live connection unavailable"));
      return;
    }
    const onResponse=response=>{
      if(response?.ok===false){
        reject(new Error(response.error||"Request failed"));
        return;
      }
      resolve(response||{ok:true});
    };
    if(typeof socket.timeout==="function"){
      socket.timeout(8000).emit(eventName,payload,(err,response)=>{
        if(err){
          reject(new Error("Request timed out"));
          return;
        }
        onResponse(response);
      });
      return;
    }
    socket.emit(eventName,payload,onResponse);
  }),[socket]);

  const uploadReadingDocument=useCallback(async(file,arrayBufferOverride=null)=>{
    const currentUser=auth.currentUser;
    if(!currentUser){
      throw new Error("Authentication required");
    }
    const arrayBuffer=arrayBufferOverride||await file.arrayBuffer();
    // Local PDFs are uploaded through the backend first so every participant
    // receives one stable shared URL rather than a local blob URL.
    const token=await currentUser.getIdToken();
    const res=await fetch(`${SERVER_URL}/api/uploads/document`,{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        Authorization:`Bearer ${token}`,
      },
      body:JSON.stringify({
        roomCode,
        fileName:file.name,
        mimeType:file.type||"application/pdf",
        base64Data:toBase64(arrayBuffer),
      }),
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok){
      throw new Error(data?.error||"Failed to upload document");
    }
    if(!data?.url){
      throw new Error("Document upload did not return a URL");
    }
    return {
      id:data.id||"",
      url:data.url,
      fileName:data.fileName||file.name||"shared-document.pdf",
      fileSize:Math.max(0,Number(data.bytes??file.size)||0),
      mimeType:data.mimeType||file.type||"application/pdf",
      signature:data.signature||buildDocumentSignature(data.fileName||file.name||"shared-document.pdf",data.bytes??file.size),
    };
  },[toBase64]);

  const verifyReadingDocument=useCallback(async(documentInfo)=>{
    if(!documentInfo?.fileUrl){
      throw new Error("Missing shared PDF URL");
    }
    if(!isSharedUploadUrl(documentInfo.fileUrl)){
      // External PDFs can still be used, but we cannot verify them as strongly
      // as backend-hosted uploads, so surface a lighter warning instead.
      return {
        ok:true,
        warning:"Using the host's PDF link directly",
        fileName:documentInfo.fileName||guessDocumentFileName(documentInfo.fileUrl),
        fileSize:Math.max(0,Number(documentInfo.fileSize)||0),
        signature:documentInfo.signature||buildDocumentSignature(documentInfo.fileName||guessDocumentFileName(documentInfo.fileUrl),documentInfo.fileSize),
      };
    }

    const token=await auth.currentUser?.getIdToken();
    const res=await fetch(documentInfo.fileUrl,{
      method:"HEAD",
      headers:token?{Authorization:`Bearer ${token}`}:{},
    });
    if(!res.ok){
      throw new Error("Could not verify the shared PDF");
    }

    const headerSignature=res.headers.get("x-document-signature")||"";
    const headerName=res.headers.get("x-document-name")||documentInfo.fileName||guessDocumentFileName(documentInfo.fileUrl);
    const headerSize=Math.max(0,Number(res.headers.get("x-document-size")||res.headers.get("content-length")||documentInfo.fileSize||0)||0);
    const contentType=String(res.headers.get("content-type")||documentInfo.mimeType||"").toLowerCase();
    if(contentType && !contentType.includes("pdf")){
      throw new Error("The shared file is not a PDF");
    }
    if(documentInfo.signature&&headerSignature&&documentInfo.signature!==headerSignature){
      throw new Error("Shared PDF signature mismatch");
    }

    return {
      ok:true,
      warning:"",
      fileName:headerName,
      fileSize:headerSize,
      signature:headerSignature||documentInfo.signature||buildDocumentSignature(headerName,headerSize),
    };
  },[]);

  const shareReadingDocument=useCallback(async({
    fileUrl,
    fileName,
    fileSize=0,
    mimeType="application/pdf",
    totalPages=0,
  })=>{
    const normalizedFileName=String(fileName||guessDocumentFileName(fileUrl)||"shared-document.pdf").trim()||"shared-document.pdf";
    const normalizedFileSize=Math.max(0,Math.floor(Number(fileSize)||0));
    // The host updates the room document through one ack-based socket call so
    // page state and document metadata advance together atomically.
    const response=await emitSocketAck("upload_document",{
      roomCode,
      fileUrl,
      fileName:normalizedFileName,
      fileSize:normalizedFileSize,
      mimeType,
      totalPages,
    });
    const nextDocument=response?.document||{
      fileUrl,
      fileName:normalizedFileName,
      fileSize:normalizedFileSize,
      mimeType,
      signature:buildDocumentSignature(normalizedFileName,normalizedFileSize),
      totalPages:Math.max(0,Math.floor(Number(totalPages)||0)),
    };
    setSharedDocument(nextDocument);
    setResourceUrl(nextDocument.fileUrl||"");
    setResourceInput(nextDocument.fileUrl||"");
    setResourceType("pdf");
    setVideoName(nextDocument.fileName||normalizedFileName);
    applyReadingState(1,response?.readingState?.totalPages??nextDocument.totalPages??0);
    setReadingPdfError("");
    setReadingPdfWarning("");
    return nextDocument;
  },[applyReadingState,emitSocketAck,roomCode]);

  // Mirror PDF readiness in a ref for callbacks that need the latest value synchronously.
  useEffect(()=>{
    readingReadyRef.current=readingPdfReady;
  },[readingPdfReady]);

  // Verify backend-hosted shared PDFs before rendering so auth errors and mismatches fail cleanly.
  useEffect(()=>{
    if(!isReadingMode||!sharedDocument?.fileUrl){
      readingReadyRef.current=false;
      pendingReadingSyncRef.current=null;
      setReadingPdfReady(false);
      setReadingPdfLoading(false);
      setReadingPdfError("");
      setReadingPdfWarning("");
      return;
    }

    let cancelled=false;
    readingReadyRef.current=false;
    setReadingPdfReady(false);
    setReadingPdfLoading(true);
    setReadingPdfError("");
    setReadingPdfWarning("");

    verifyReadingDocument(sharedDocument)
      .then(result=>{
        if(cancelled)return;
        setReadingPdfWarning(result.warning||"");
        setSharedDocument(prev=>{
          if(!prev)return prev;
          let changed=false;
          const next={...prev};
          if(result.fileName&&prev.fileName!==result.fileName){
            next.fileName=result.fileName;
            changed=true;
          }
          if(Number.isFinite(Number(result.fileSize))&&Number(result.fileSize)!==Number(prev.fileSize||0)){
            next.fileSize=Math.max(0,Number(result.fileSize)||0);
            changed=true;
          }
          if(result.signature&&prev.signature!==result.signature){
            next.signature=result.signature;
            changed=true;
          }
          return changed?next:prev;
        });
      })
      .catch(error=>{
        if(cancelled)return;
        setReadingPdfLoading(false);
        setReadingPdfError(error.message||"Could not load the shared PDF");
      });

    return()=>{cancelled=true;};
  },[
    isReadingMode,
    sharedDocument?.fileName,
    sharedDocument?.fileSize,
    sharedDocument?.fileUrl,
    sharedDocument?.signature,
    verifyReadingDocument,
  ]);

  const syncReadingStateToServer=useCallback((page,totalPages)=>{
    if(!socket||!isReadingMode||!isHost||!sharedDocumentRef.current?.fileUrl)return;
    // After the host learns a PDF's real page count, push that back upstream so
    // late joiners receive a fully populated reading snapshot.
    socket.emit("sync_state",{
      roomCode,
      document:{
        signature:sharedDocumentRef.current.signature||"",
        totalPages:Math.max(0,Math.floor(Number(totalPages)||0)),
      },
      readingState:{
        page:Math.max(1,Math.floor(Number(page)||1)),
        totalPages:Math.max(0,Math.floor(Number(totalPages)||0)),
        signature:sharedDocumentRef.current.signature||"",
      },
    });
  },[socket,isReadingMode,isHost,roomCode]);

  const getCurrentPlaybackTime=useCallback(()=>{
    if(useYouTubePlayer){
      return Math.max(0,Number(youtubePlayerRef.current?.getCurrentTime?.()||0));
    }
    return Math.max(0,Number(getActiveHtmlMedia()?.currentTime||0));
  },[getActiveHtmlMedia,useYouTubePlayer]);

  const isCurrentlyPlaying=useCallback(()=>{
    if(useYouTubePlayer){
      return youtubeStateRef.current===1;
    }
    const media=getActiveHtmlMedia();
    return !!(media&&!media.paused);
  },[getActiveHtmlMedia,useYouTubePlayer]);

  // ── File select ───────────────────────────────────────────────────────────
  const handleFileSelect=async e=>{
    const file=e.target.files?.[0];if(!file)return;
    if(!canChangeSource){
      addToast("Only the host can change the document in co-reading","error");
      e.target.value="";
      return;
    }
    closeSourcePanel();
    const validation=sessionEngine.validateFile?.(file)||{valid:true};
    if(!validation.valid){
      addToast(validation.reason||"Unsupported file for this mode","error");
      return;
    }
    if(videoObjectUrl.current){
      URL.revokeObjectURL(videoObjectUrl.current);
      videoObjectUrl.current=null;
    }
    const url=URL.createObjectURL(file);
    videoObjectUrl.current=url;

    const mimeLower=String(file.type||"").toLowerCase();
    const isPdfFile=mimeLower.includes("pdf")||/\.pdf$/i.test(file.name);
    const isReadingDocument=sessionMode==="reading"&&isPdfFile;
    if(isReadingDocument){
      // Local reading documents are never shared as blob URLs; they are uploaded,
      // inspected for page count, then rebroadcast as one room-level document URL.
      setResourceType("pdf");
      applyReadingState(1,0);
      setVideoName(file.name);
      setVideoLoaded(false);
      setDuration(0);
      if(sessionMode==="reading"){
        try{
          setDocUploading(true);
          addToast("Uploading PDF so everyone can read the same file...","info");
          const arrayBuffer=await file.arrayBuffer();
          const totalPages=await getPdfPageCountFromArrayBuffer(arrayBuffer);
          const uploaded=await uploadReadingDocument(file,arrayBuffer);
          await shareReadingDocument({
            fileUrl:uploaded.url,
            fileName:uploaded.fileName||file.name,
            fileSize:uploaded.fileSize||file.size,
            mimeType:uploaded.mimeType||"application/pdf",
            totalPages,
          });
          addToast("PDF uploaded and shared", "success");
        }catch(error){
          setReadingPdfError(error.message||"Could not share the selected PDF");
          addToast(error.message||"Could not share local PDF. Try again in a moment.", "error");
        }finally{
          setDocUploading(false);
          if(videoObjectUrl.current){
            URL.revokeObjectURL(videoObjectUrl.current);
            videoObjectUrl.current=null;
          }
        }
      }
      return;
    }

    if(isMusicMode){
      const audioEl=audioRef.current;
      const fileSignature=getMusicFileSignature(file);
      const roomSignature=String(requiredAudioSignatureRef.current||"");
      const isJoiningExistingLocalSource=Boolean(!resourceUrl&&roomSignature&&roomSignature===fileSignature);
      // Music rooms distinguish "host changed the source" from "I loaded the
      // matching local file for an existing source" using the file signature.
      localAudioSignatureRef.current=fileSignature;
      setAudioLoadWarning("");
      setVideoLoaded(false);
      setDuration(0);
      setVideoName(file.name);
      setResourceUrl(url);
      setResourceInput(file.name);
      setResourceType("local");
      if(!audioEl){
        localAudioSignatureRef.current="";
        addToast("Audio player unavailable on this device","error");
        return;
      }
      audioEl.src=url;
      audioEl.load();
      audioEl.onloadedmetadata=()=>{
        if(audioEl.duration>MAX_VIDEO_TIME){
          localAudioSignatureRef.current="";
          addToast("Audio exceeds 24h limit","error");
          audioEl.removeAttribute("src");
          audioEl.load();
          URL.revokeObjectURL(url);
          videoObjectUrl.current=null;
          return;
        }
        localMediaReadyRef.current=true;
        requiredAudioSignatureRef.current=fileSignature;
        setDuration(audioEl.duration||0);
        setVideoLoaded(true);
        if(!isJoiningExistingLocalSource){
          socket?.emit("video_metadata",{
            roomCode,
            videoName:file.name,
            duration:audioEl.duration||0,
            sourceType:"local",
            contentUrl:"",
            fileFingerprint:fileSignature,
          });
        }
        if(pendingAudioSyncRef.current){
          applyAudioSyncRef.current({audioState:pendingAudioSyncRef.current});
        }
        addToast(isJoiningExistingLocalSource?"Matching audio loaded — synced to room":"Audio file loaded — room source updated","success");
      };
      return;
    }

    const video=videoRef.current;
    if(!video){
      setResourceUrl(url);
      setResourceInput(url);
      setResourceType("local");
      setVideoName(file.name);
      setVideoLoaded(false);
      setDuration(0);
      socket?.emit("video_metadata",{
        roomCode,
        videoName:file.name,
        duration:0,
        sourceType:"local",
        contentUrl:url,
        fileFingerprint:`${file.name}:${file.size}:${Math.floor((file.lastModified||0)/1000)}`,
      });
      addToast("Media selected. Preparing player...", "info");
      return;
    }
    video.src=url;video.load();
    video.onloadedmetadata=()=>{
      if(video.duration>MAX_VIDEO_TIME){addToast("Media exceeds 24h limit","error");video.src="";URL.revokeObjectURL(url);videoObjectUrl.current=null;return;}
      setDuration(video.duration);setVideoName(file.name);setVideoLoaded(true);
      setResourceUrl(url);
      setResourceInput(url);
      setResourceType("local");
      socket?.emit("video_metadata",{
        roomCode,
        videoName:file.name,
        duration:video.duration,
        sourceType:"local",
        contentUrl:url,
        fileFingerprint:`${file.name}:${file.size}:${Math.floor((file.lastModified||0)/1000)}`,
      });
      const target=pendingSeek.current||initialVideoState;
      if(target){
        const now=Date.now()/1000;
        const elapsed=target.isPlaying?(now-target.lastUpdate):0;
        const t=Math.min(target.currentTime+elapsed,video.duration);
        suppressSeekEchoRef.current=true;
        video.currentTime=t;
        if(target.isPlaying)tryPlayWithFeedback(video);
        pendingSeek.current=null;
      }
      addToast(`${sessionLabel} file loaded — synced to room position`,"success");
    };
  };

  const handleLoadResourceLink=async()=>{
    if(!canChangeSource){
      addToast("Only the host can change the document in co-reading","error");
      return;
    }
    const raw=resourceInput.trim();
    const reportLinkError=(message)=>{
      setSourcePanelError(message);
      addToast(message,"error");
    };
    if(!raw){
      reportLinkError("Paste a link first");
      return;
    }
    const resolved=sessionEngine.resolveResourceFromUrl?.(raw)||{
      valid:isHttpUrl(raw),
      reason:"Please enter a valid http(s) link",
      normalizedUrl:raw,
      contentType:"unknown",
      syncKind:"companion",
    };
    if(!resolved.valid){
      reportLinkError(resolved.reason||"Invalid link");
      return;
    }

    const normalizedUrl=resolved.normalizedUrl||raw;
    const sourceType=resolved.contentType||"unknown";
    const syncKind=resolved.syncKind||"companion";
    // Engines classify links into transport kinds so RoomView can choose the
    // right loading path: YouTube iframe, HTML media, PDF, or companion link.

    setResourceInput(normalizedUrl);
    if(isMusicMode){
      requiredAudioSignatureRef.current="";
      localAudioSignatureRef.current="";
      setAudioLoadWarning("");
    }

    if(syncKind==="youtube"){
      const nextVideoId=extractYouTubeId(normalizedUrl);
      if(!nextVideoId){
        reportLinkError("This YouTube link looks invalid for Lumiere.");
        return;
      }
      try{
        await preflightYouTubeEmbed(nextVideoId);
      }catch(error){
        reportLinkError(error.message||"This YouTube video won't work inside Lumiere. Choose another link or upload a file.");
        return;
      }
    }

    closeSourcePanel();

    if(isReadingMode&&sourceType==="pdf"){
      try{
        setDocUploading(true);
        await shareReadingDocument({
          fileUrl:normalizedUrl,
          fileName:guessDocumentFileName(normalizedUrl),
          fileSize:0,
          mimeType:"application/pdf",
          totalPages:0,
        });
        addToast("Shared PDF linked for co-reading", "success");
      }catch(error){
        setReadingPdfError(error.message||"Could not share the PDF link");
        addToast(error.message||"Could not share the PDF link", "error");
      }finally{
        setDocUploading(false);
      }
      return;
    }

    setResourceUrl(normalizedUrl);
    setResourceType(sourceType);
    socket?.emit("video_metadata",{
      roomCode,
      videoName:normalizedUrl.replace(/^https?:\/\//i,"").slice(0,80),
      duration:0,
      sourceType,
      contentUrl:normalizedUrl,
      fileFingerprint:"",
    });

    if(syncKind==="youtube"){
      setVideoLoaded(false);
      setVideoName(normalizedUrl.replace(/^https?:\/\//i,"").slice(0,80));
      addToast("YouTube synced with room", "success");
      return;
    }

    if(syncKind==="html5"){
      if(isMusicMode){
        localMediaReadyRef.current=false;
        setVideoLoaded(false);
        setDuration(0);
        setVideoName(normalizedUrl.replace(/^https?:\/\//i,"").slice(0,80));
        addToast("Audio link shared with room", "success");
        return;
      }
      if(videoRef.current){
        const video=videoRef.current;
        video.src=normalizedUrl;
        video.load();
        video.onloadedmetadata=()=>{
          setVideoLoaded(true);
          setDuration(video.duration||0);
          setVideoName(normalizedUrl.replace(/^https?:\/\//i,"").slice(0,80));
          const target=pendingSeek.current||initialVideoState;
          if(target){
            const now=Date.now()/1000;
            const elapsed=target.isPlaying?(now-target.lastUpdate):0;
            const t=Math.min(target.currentTime+elapsed,video.duration||MAX_VIDEO_TIME);
            suppressSeekEchoRef.current=true;
            video.currentTime=t;
            if(target.isPlaying)tryPlayWithFeedback(video);
            pendingSeek.current=null;
          }
          addToast("Resource loaded and synced", "success");
        };
      }else{
        setVideoLoaded(false);
        setVideoName(normalizedUrl.replace(/^https?:\/\//i,"").slice(0,80));
        addToast("Resource linked. Preparing player...", "info");
      }
      return;
    }

    if(sourceType==="pdf"||sourceType==="document"){
      setVideoLoaded(false);
      setVideoName(normalizedUrl.replace(/^https?:\/\//i,"").slice(0,80));
      addToast("Document linked for co-reading", "success");
      return;
    }

    setVideoLoaded(false);
    addToast("Resource linked in companion mode", "info");
  };
  const openResourceInNewTab=async()=>{
    const targetUrl=sharedDocument?.fileUrl||resourceUrl;
    if(!targetUrl||!isHttpUrl(targetUrl)){
      addToast("No external resource link available","info");
      return;
    }
    if(isSharedUploadUrl(targetUrl)){
      try{
        const token=await auth.currentUser?.getIdToken();
        const res=await fetch(targetUrl,{
          headers:token?{Authorization:`Bearer ${token}`}:{},
        });
        if(!res.ok){
          throw new Error("Could not open the shared PDF");
        }
        const blob=await res.blob();
        const objectUrl=URL.createObjectURL(blob);
        window.open(objectUrl,"_blank","noopener,noreferrer");
        setTimeout(()=>URL.revokeObjectURL(objectUrl),60000);
        return;
      }catch(error){
        addToast(error.message||"Could not open the shared PDF","error");
        return;
      }
    }
    window.open(targetUrl,"_blank","noopener,noreferrer");
  };
  const requestReadingPageChange=useCallback(async(page)=>{
    if(!isHost){
      addToast("Only the host can change pages in co-reading","error");
      return;
    }
    const now=Date.now();
    if(now-lastReadingPageRequestAtRef.current<200){
      return;
    }
    lastReadingPageRequestAtRef.current=now;
    const maxPage=readingTotalPages||sharedDocumentRef.current?.totalPages||5000;
    const nextPage=Math.max(1,Math.min(maxPage,Math.floor(Number(page)||1)));
    // Optimistically update the local page first so host page turns feel instant,
    // then rely on the ack to reconcile any server-side clamp or validation.
    applyReadingState(nextPage,readingTotalPages||sharedDocumentRef.current?.totalPages||0);
    showBanner(`Page ${nextPage}`);
    try{
      const response=await emitSocketAck("request_page_change",{roomCode,page:nextPage});
      if(Number(response?.totalPages)>0){
        setReadingTotalPages(Math.max(1,Math.floor(Number(response.totalPages)||1)));
      }
    }catch(error){
      addToast(error.message||"Could not sync page change","error");
    }
  },[addToast,applyReadingState,emitSocketAck,isHost,readingTotalPages,roomCode,showBanner]);
  const handleReadingPageJump=()=>{
    if(!Number.isFinite(Number(readingPageInput))||Number(readingPageInput)<1){
      setReadingPageInput(String(readingPage));
      addToast("Enter a valid page number","error");
      return;
    }
    const page=Math.max(1,Math.floor(Number(readingPageInput)));
    requestReadingPageChange(page);
  };
  const handleReadingPageStep=delta=>{
    const current=Math.max(1,Math.floor(Number(readingPage)||1));
    const maxPage=readingTotalPages||sharedDocumentRef.current?.totalPages||5000;
    const next=Math.max(1,Math.min(maxPage,current+delta));
    requestReadingPageChange(next);
  };
  const handleReadingZoom=delta=>{
    setReadingZoom(prev=>{
      const next=Math.max(60,Math.min(150,prev+delta));
      return next;
    });
  };

  // ── Controls ──────────────────────────────────────────────────────────────
  const emitPlay=useCallback((time)=>socket?.emit("request_play",{
    roomCode,
    currentTime:time??getCurrentPlaybackTime(),
    fileSignature:isMusicMode?localAudioSignatureRef.current:"",
  }),[socket,roomCode,getCurrentPlaybackTime,isMusicMode]);
  const emitPause=useCallback((time)=>socket?.emit("request_pause",{
    roomCode,
    currentTime:time??getCurrentPlaybackTime(),
    fileSignature:isMusicMode?localAudioSignatureRef.current:"",
  }),[socket,roomCode,getCurrentPlaybackTime,isMusicMode]);
  const emitSeek=useCallback((time,playing,rate)=>{
    // A seek carries the full transport state because it may also represent a
    // play/pause transition or playback-rate change from the local player.
    socket?.emit("request_seek",{
      roomCode,
      currentTime:time??getCurrentPlaybackTime(),
      isPlaying:playing??isCurrentlyPlaying(),
      playbackRate:rate??1,
      fileSignature:isMusicMode?localAudioSignatureRef.current:"",
    });
  },[socket,roomCode,getCurrentPlaybackTime,isCurrentlyPlaying,isMusicMode]);
  // Keep the latest emitSeek function in a ref for timer-driven and player-driven seek emissions.
  useEffect(()=>{emitSeekRef.current=emitSeek;},[emitSeek]);

  const handlePlayPause=()=>{
    if(!videoLoaded)return;
    if(isMusicMode){
      const current=getCurrentPlaybackTime();
      const player=youtubePlayerRef.current;
      const media=getActiveHtmlMedia();
      const isPendingOrPlaying=expectedPlayRef.current||isCurrentlyPlaying();
      if(isPendingOrPlaying){
        expectedPlayRef.current=false;
        if(useYouTubePlayer&&player&&youtubeStateRef.current===1){
          youtubeRemoteApplyUntilRef.current=Date.now()+700;
          player.pauseVideo?.();
        }else if(media&&!media.paused){
          media.pause();
        }
        emitPause(current);
        return;
      }
      expectedPlayRef.current=true;
      setAudioDebugStatus("Scheduling playback...");
      emitPlay(current);
      return;
    }
    if(useYouTubePlayer){
      const player=youtubePlayerRef.current;
      if(!player)return;
      if(youtubeStateRef.current===1){
        expectedPlayRef.current=false;
        player.pauseVideo?.();
      }else{
        expectedPlayRef.current=true;
        player.playVideo?.();
      }
      return;
    }

    const media=getActiveHtmlMedia();if(!media)return;
    if(media.paused){
      expectedPlayRef.current=true;
      media.play().catch(()=>{});
      emitPlay(media.currentTime||0);
    }else{
      expectedPlayRef.current=false;
      media.pause();
      emitPause(media.currentTime||0);
    }
  };
  const handleSkip=secs=>{
    if(!videoLoaded)return;
    if(useYouTubePlayer){
      const player=youtubePlayerRef.current;
      if(!player)return;
      const current=Math.max(0,Number(player.getCurrentTime?.()||0));
      const total=Math.max(1,Number(player.getDuration?.()||duration||MAX_VIDEO_TIME));
      const t=Math.max(0,Math.min(current+secs,total));
      youtubeControlRef.current.seekAt=Date.now();
      lastYouTubeSeekEmitAtRef.current=Date.now();
      youtubeRemoteApplyUntilRef.current=Date.now()+700;
      player.seekTo?.(t,true);
      emitSeek(t,youtubeStateRef.current===1,1);
      return;
    }
    const media=getActiveHtmlMedia();if(!media)return;
    const t=Math.max(0,Math.min(media.currentTime+secs,media.duration||MAX_VIDEO_TIME));
    suppressSeekEchoRef.current=true;
    media.currentTime=t;emitSeek(t);
  };
  const handleScrubChange=e=>{
    const t=Number(e.target.value);
    if(useYouTubePlayer){
      const player=youtubePlayerRef.current;
      if(player){
        youtubeControlRef.current.seekAt=Date.now();
        youtubeRemoteApplyUntilRef.current=Date.now()+400;
        player.seekTo?.(t,true);
      }
    }else if(getActiveHtmlMedia()){
      getActiveHtmlMedia().currentTime=t;
    }
    setCurrentTime(t);myTimeRef.current=t;
  };
  const handleScrubEnd=e=>{
    const t=Number(e.target.value);
    if(useYouTubePlayer){
      const player=youtubePlayerRef.current;
      if(player){
        youtubeControlRef.current.seekAt=Date.now();
        lastYouTubeSeekEmitAtRef.current=Date.now();
        youtubeRemoteApplyUntilRef.current=Date.now()+700;
        player.seekTo?.(t,true);
      }
    }else if(getActiveHtmlMedia()){
      suppressSeekEchoRef.current=true;
      getActiveHtmlMedia().currentTime=t;
    }
    isScrubbing.current=false;
    emitSeek(t);
  };
  const handleFullscreen=()=>{
    const videoEl=videoRef.current;
    const containerEl=containerRef.current;
    const isNativeFullscreen=!!(document.fullscreenElement||document.webkitFullscreenElement);
    if(isNativeFullscreen){
      if(typeof document.exitFullscreen==="function"){
        Promise.resolve(document.exitFullscreen()).catch(()=>addToast("Fullscreen unavailable","info"));
        return;
      }
      if(videoEl&&typeof videoEl.webkitExitFullscreen==="function"){
        try{videoEl.webkitExitFullscreen();}catch(_){addToast("Fullscreen unavailable","info");}
        return;
      }
      addToast("Fullscreen unavailable","info");
      return;
    }

    const requestNativeFullscreen=(el)=>{
      if(!el)return false;
      if(typeof el.requestFullscreen==="function"){
        try{
          Promise.resolve(el.requestFullscreen()).catch(()=>addToast("Fullscreen unavailable","info"));
        }catch(_){
          addToast("Fullscreen unavailable","info");
        }
        return true;
      }
      if(typeof el.webkitRequestFullscreen==="function"){
        try{
          el.webkitRequestFullscreen();
        }catch(_){
          addToast("Fullscreen unavailable","info");
        }
        return true;
      }
      return false;
    };

    if(requestNativeFullscreen(containerEl))return;
    if(videoEl&&typeof videoEl.webkitEnterFullscreen==="function"){
      try{
        videoEl.webkitEnterFullscreen();
      }catch(_){
        addToast("Fullscreen unavailable","info");
      }
      return;
    }
    addToast("Fullscreen unavailable","info");
  };
  const handleVolumeChange=e=>{
    const v=Number(e.target.value);setVolume(v);
    if(useYouTubePlayer){
      const player=youtubePlayerRef.current;
      if(player&&typeof player.setVolume==="function"){
        player.setVolume(Math.max(0,Math.min(100,Math.round(v*100))));
        if(v===0)player.mute?.();
        else player.unMute?.();
      }
    }else if(getActiveHtmlMedia()){
      getActiveHtmlMedia().volume=v;
      getActiveHtmlMedia().muted=v===0;
    }
    setMuted(v===0);
  };
  const toggleMute=()=>{
    if(useYouTubePlayer){
      const player=youtubePlayerRef.current;
      if(!player)return;
      const nextMuted=!(player.isMuted?.()||false);
      if(nextMuted)player.mute?.();
      else player.unMute?.();
      setMuted(nextMuted);
      return;
    }
    const media=getActiveHtmlMedia();if(!media)return;media.muted=!media.muted;setMuted(media.muted);
  };

  const sendMessage=e=>{
    e.preventDefault();
    const text=chatInput.trim();if(!text||!socket)return;
    socket.emit("send_message",{roomCode,text,senderUsername:username});
    setChatInput("");
  };
  const handleRaiseHand=useCallback(()=>{
    if(!socket||!roomCode)return;
    socket.emit("send_message",{
      roomCode,
      text:"✋ Raised hand — I have a question",
      type:"text",
      meta:null,
    });
  },[socket,roomCode]);
  const sendBookmark=()=>{
    const time=getCurrentPlaybackTime();
    if(!videoLoaded){addToast(isMusicMode?"Load audio first":"Load a video first","info");return;}
    socket?.emit("send_message",{roomCode,text:`Bookmarked ${fmt(time)}`,type:"bookmark",meta:{seekTime:time},senderUsername:username});
  };
  const handleReact=(messageId,emoji)=>{
    if(!messageId||!emoji)return;
    setMessages(prev=>prev.map(m=>{
      if(m.id!==messageId)return m;
      const reactions={...(m.reactions||{})};
      let hadSame=false;
      Object.keys(reactions).forEach(key=>{
        const list=[...(reactions[key]||[])];
        const idx=list.indexOf(user.uid);
        if(idx!==-1){
          if(key===emoji)hadSame=true;
          list.splice(idx,1);
        }
        if(list.length>0)reactions[key]=list;
        else delete reactions[key];
      });
      if(!hadSame){
        const nextList=[...(reactions[emoji]||[])];
        nextList.push(user.uid);
        reactions[emoji]=nextList;
      }
      return {...m,reactions};
    }));
    socket?.emit("react_message",{roomCode,messageId,emoji});
  };
  const handleBookmarkSeek=seekTime=>{socket?.emit("bookmark_seek",{roomCode,seekTime});addToast(`Seeking everyone to ${fmt(seekTime)}`,"info");};
  const copyCode=()=>{
    if(!navigator.clipboard?.writeText){
      addToast("Clipboard unavailable on this device","error");
      return;
    }
    navigator.clipboard.writeText(roomCode)
      .then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);})
      .catch(()=>addToast("Couldn't copy room code","error"));
  };

  const getFriendStatusLabel=status=>{
    if(status==="already_friends")return "Friends";
    if(status==="already_requested"||status==="requested")return "Requested";
    if(status==="needs_accept")return "Accept";
    return "Add friend";
  };

  const roomUserUidSet=new Set(users.map(item=>item?.uid).filter(Boolean));
  const inviteableFriends=availableFriends
    .filter(friend=>friend?.uid&&friend.uid!==user.uid&&!roomUserUidSet.has(friend.uid))
    .sort((a,b)=>{
      const onlineDiff=Number(!!b?.online)-Number(!!a?.online);
      if(onlineDiff!==0)return onlineDiff;
      const aLabel=String(a?.displayName||a?.name||a?.username||"").toLowerCase();
      const bLabel=String(b?.displayName||b?.name||b?.username||"").toLowerCase();
      return aLabel.localeCompare(bLabel);
    });
  const onlineInviteableFriends=inviteableFriends.filter(friend=>friend.online);
  const offlineInviteableFriends=inviteableFriends.filter(friend=>!friend.online);
  const hasFriendRoster=availableFriends.length>0;
  const singleOtherUser=otherUsers.length===1?otherUsers[0]:null;
  const singleOtherUserStatus=singleOtherUser?(friendStatusByUid[singleOtherUser.uid]||""):"";
  const allOtherUsersAreFriends=otherUsers.length>0&&otherUsers.every(target=>friendStatusByUid[target.uid]==="already_friends");
  // For 1:1 rooms we can mirror the exact relationship label in the header button.
  // In larger rooms, showing "Friends" only makes sense when everyone in the room already is.
  const roomFriendButtonLabel=hasFriendRoster
    ?"Friends"
    :singleOtherUser
      ?getFriendStatusLabel(singleOtherUserStatus)
      :(allOtherUsersAreFriends?"Friends":"Add Friend");
  const roomFriendButtonSettled=hasFriendRoster||singleOtherUserStatus==="already_friends"||allOtherUsersAreFriends;

  return(
    <div className={`h-dvh min-h-screen flex flex-col overflow-hidden relative ${isReadingMode?"bg-zinc-50":"bg-screen"}`}>
      {!isReadingMode&&<div className="grain-overlay"/>}

      {/* ── Header ── */}
      <header className={`relative z-20 shrink-0 border-b backdrop-blur-xl ${isReadingMode?"border-zinc-200/80 bg-white/92 px-4 py-3.5 sm:px-5":"border-white/8 bg-black/30 px-4 py-3 sm:px-5"}`}>
        {isReadingMode?(
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500">CO-READING MODE</p>
              <p className="font-display text-xl leading-tight text-zinc-900">Room {roomCode}</p>
              <p className="mt-1 text-xs text-zinc-600">
                {modeLabel==="Couple"?"💛 Couple Mode":modeLabel==="Family"?"👨‍👩‍👧 Family Mode":"👥 Best Friend Mode"}
                {" · "}
                {users.length}/{maxParticipants}
                {connected?"":" · reconnecting"}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={()=>setShowChat(s=>!s)}
                className="rounded-full border border-zinc-300 bg-white/70 p-2.5 text-zinc-600 transition-all duration-200 hover:border-zinc-500 hover:text-zinc-900"
                title={showChat ? "Close chat" : "Open chat"}
              >
                <MessageSquare size={15}/>
              </button>
              <div ref={moreMenuRef} className="relative">
                <button
                  type="button"
                  onClick={()=>setShowMoreMenu(v=>!v)}
                  className="rounded-full border border-zinc-300 bg-white/70 p-2.5 text-zinc-600 transition-all duration-200 hover:border-zinc-500 hover:text-zinc-900"
                  title="More actions"
                >
                  <Menu size={15}/>
                </button>
                {showMoreMenu&&(
                  <div className="absolute right-0 z-40 mt-3 w-48 rounded-[1.35rem] border border-zinc-200 bg-white/95 p-2 shadow-[0_24px_60px_rgba(15,23,42,0.12)] backdrop-blur-xl">
                    <button
                      type="button"
                      onClick={()=>{setShowMoreMenu(false);openSourcePanel();}}
                      disabled={!canChangeSource}
                      className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-zinc-700 transition-all duration-200 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Change source
                    </button>
                    <button
                      type="button"
                      onClick={()=>{setShowMoreMenu(false);openResourceInNewTab();}}
                      className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-zinc-700 transition-all duration-200 hover:bg-zinc-100"
                    >
                      Open resource
                    </button>
                    {!callVisible?(
                      <button
                        type="button"
                        onClick={()=>{setShowMoreMenu(false);joinCall(true);}}
                        className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-zinc-700 transition-all duration-200 hover:bg-zinc-100"
                      >
                        Start call
                      </button>
                    ):(
                      <button
                        type="button"
                        onClick={()=>{setShowMoreMenu(false);leaveCall();}}
                        className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-red-600 transition-all duration-200 hover:bg-red-50"
                      >
                        {isJoiningCall?"Cancel call":"End call"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={()=>{setShowMoreMenu(false);copyCode();}}
                      className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-zinc-700 transition-all duration-200 hover:bg-zinc-100"
                    >
                      Copy room code
                    </button>
                  </div>
                )}
              </div>
              <button onClick={onLeave}
                className="rounded-full px-3 py-2 text-xs text-zinc-700 transition-all duration-200 hover:bg-zinc-100 hover:text-red-600">
                Leave
              </button>
            </div>
          </div>
        ):(
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-amber-400/18 bg-gradient-to-br from-amber-500/16 to-violet-500/10 shadow-[0_16px_40px_rgba(245,158,11,0.14)]">
                <Film size={16} className="text-amber-300"/>
              </div>
              <span className="font-display text-lg text-zinc-100 hidden sm:block">Lumiere</span>
              <div className="flex items-center gap-1.5 rounded-full border border-amber-400/18 bg-amber-500/10 px-3 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                <span className="font-mono text-xs tracking-[0.28em] text-amber-200">{roomCode}</span>
                <button onClick={copyCode} className="ml-1 text-zinc-500 transition-all duration-200 hover:text-zinc-200">
                  {copied?<Check size={11} className="text-green-400"/>:<Copy size={11}/>}
                </button>
              </div>
              <div className="flex items-center gap-2 overflow-x-auto max-w-[45vw] sm:max-w-none pr-1">
                <span className="whitespace-nowrap rounded-full border border-amber-400/18 bg-amber-500/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-amber-100">
                  {modeLabel} room
                </span>
                <span className="whitespace-nowrap rounded-full border border-violet-400/18 bg-violet-500/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-violet-100">
                  {sessionLabel} mode
                </span>
                {!!roomMoodTag&&(
                  <span className="whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-200">
                    Mood: {roomMoodTag}
                  </span>
                )}
                <div className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-[10px] uppercase tracking-[0.18em]
                  ${connected?"border-emerald-500/18 bg-emerald-500/10 text-emerald-200":"border-red-500/18 bg-red-500/10 text-red-200"}`}>
                  {connected?<Wifi size={10}/>:<WifiOff size={10}/>}
                  {connected?"Live":"Reconnecting…"}
                </div>
                <span className="hidden whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-400 sm:inline">
                  Invite-only
                </span>
                <div className="hidden sm:flex">
                  <SyncIndicator memberTimes={memberTimes} myUid={user.uid} videoLoaded={videoLoaded}/>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-zinc-600 text-xs font-mono hidden md:block">@{username}</span>
              {!!resourceUrl&&(
                <button
                  type="button"
                  onClick={openResourceInNewTab}
                  className="hidden lg:inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-zinc-300 transition-all duration-200 hover:border-white/18 hover:text-zinc-100"
                  title="Open linked resource"
                >
                  <Link2 size={12}/>
                  Resource
                </button>
              )}
              <span className="flex items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-400"><Users size={12}/>{users.length}/{maxParticipants}</span>
              {(otherUsers.length>0||hasFriendRoster)&&(
                <div ref={friendMenuRef} className="relative hidden sm:block">
                  <button
                    type="button"
                    onClick={()=>{
                      setShowHeaderNotifications(false);
                      setShowFriendMenu(v=>!v);
                    }}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs transition-all duration-200 ${
                      roomFriendButtonSettled
                        ?"border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/18 hover:bg-white/[0.08]"
                        :"border-amber-400/18 bg-amber-500/10 text-amber-200 hover:border-amber-300/24 hover:bg-amber-500/16"
                    }`}
                    title={singleOtherUserStatus==="needs_accept"?"Accept friend request":"View room people and invite friends"}
                  >
                    <UserPlus size={12}/>
                    <span className="hidden md:inline">{roomFriendButtonLabel}</span>
                  </button>
                  {showFriendMenu&&(
                    <div className="absolute right-0 z-40 mt-3 w-80 max-w-[84vw] rounded-[1.4rem] border border-white/10 bg-zinc-950/95 p-2.5 shadow-[0_32px_100px_rgba(0,0,0,0.52)] backdrop-blur-2xl">
                      <div className="max-h-72 overflow-y-auto space-y-3">
                        <div>
                          <div className="flex items-center justify-between px-2 py-1.5">
                            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">People in room</p>
                            {otherUsers.length>0&&<span className="text-[10px] text-zinc-500">{otherUsers.length}</span>}
                          </div>
                          {otherUsers.length>0?(
                            <div className="flex flex-col gap-1">
                              {otherUsers.map(target=>{
                                const status=friendStatusByUid[target.uid]||"";
                                const isBusy=!!friendBusyByUid[target.uid];
                                const disableAction=isBusy||status==="already_friends"||status==="already_requested"||status==="requested";
                                const label=`@${target.username||target.name||"friend"}`;
                                return(
                                  <div key={target.uid} className="flex items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-2.5 py-2.5">
                                    {renderUserAvatar(target,"w-7 h-7","text-[11px]",target.name||label)}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5 min-w-0">
                                        <p className="text-xs text-zinc-200 truncate">{label}</p>
                                        <span className="rounded-full border border-emerald-400/18 bg-emerald-500/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.18em] text-emerald-200">Here</span>
                                      </div>
                                      <p className="text-[11px] text-zinc-500 truncate">{target.name||"Viewer"}</p>
                                    </div>
                                    <button
                                      type="button"
                                      disabled={disableAction}
                                      onClick={()=>handleSendFriendFromRoom(target)}
                                      className={`text-[11px] rounded-md border px-2 py-1 transition-all duration-200 whitespace-nowrap ${
                                        disableAction
                                          ?"cursor-not-allowed border-white/8 bg-zinc-900 text-zinc-500"
                                          :"border-emerald-400/18 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/18"
                                      }`}
                                      title={status==="needs_accept"?"Accept friend request":"Send friend request"}
                                    >
                                      {isBusy?"Sending...":getFriendStatusLabel(status)}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          ):(
                            <p className="px-2 pb-1 text-[11px] text-zinc-500">No one else is in the room yet.</p>
                          )}
                        </div>

                        <div>
                          <div className="flex items-center justify-between px-2 py-1.5">
                            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Online friends</p>
                            {onlineInviteableFriends.length>0&&<span className="text-[10px] text-zinc-500">{onlineInviteableFriends.length}</span>}
                          </div>
                          {onlineInviteableFriends.length>0?(
                            <div className="flex flex-col gap-1">
                              {onlineInviteableFriends.map(target=>{
                                const displayName=target.displayName||target.name||"Friend";
                                const label=`@${target.username||"friend"}`;
                                const isInviting=!!inviteBusyByUid[target.uid];
                                const isCoolingDown=Number(inviteCooldownByUid[target.uid]||0)>Date.now();
                                const hasBeenInvited=!!inviteHistoryByUid[target.uid];
                                const inviteLabel=isInviting
                                  ?"Inviting..."
                                  :isCoolingDown
                                    ?"Invited"
                                    :hasBeenInvited
                                      ?"Invite Again"
                                      :"Invite";
                                return(
                                  <div key={target.uid} className="flex items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-2.5 py-2.5">
                                    {renderUserAvatar(target,"w-7 h-7","text-[11px]",displayName)}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5 min-w-0">
                                        <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0"/>
                                        <p className="text-xs text-zinc-200 truncate">{label}</p>
                                      </div>
                                      <p className="text-[11px] text-zinc-500 truncate">{displayName}</p>
                                    </div>
                                    <button
                                      type="button"
                                      disabled={isInviting||isCoolingDown}
                                      onClick={()=>handleInviteFriendFromRoom(target)}
                                      className={`text-[11px] rounded-md border px-2 py-1 transition-all duration-200 whitespace-nowrap ${
                                        isInviting||isCoolingDown
                                          ?"cursor-not-allowed border-white/8 bg-zinc-900 text-zinc-500"
                                          :"border-amber-400/18 bg-amber-500/10 text-amber-200 hover:bg-amber-500/18"
                                      }`}
                                      title={hasBeenInvited&&!isCoolingDown?"Send another room invite":"Invite this friend to the room"}
                                    >
                                      {inviteLabel}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          ):(
                            <p className="px-2 pb-1 text-[11px] text-zinc-500">No online friends are ready to invite right now.</p>
                          )}
                        </div>

                        <div>
                          <div className="flex items-center justify-between px-2 py-1.5">
                            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Offline friends</p>
                            {offlineInviteableFriends.length>0&&<span className="text-[10px] text-zinc-500">{offlineInviteableFriends.length}</span>}
                          </div>
                          {offlineInviteableFriends.length>0?(
                            <div className="flex flex-col gap-1">
                              {offlineInviteableFriends.map(target=>{
                                const displayName=target.displayName||target.name||"Friend";
                                const label=`@${target.username||"friend"}`;
                                return(
                                  <div key={target.uid} className="flex items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.02] px-2.5 py-2.5 opacity-60">
                                    {renderUserAvatar(target,"w-7 h-7","text-[11px]",displayName)}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5 min-w-0">
                                        <span className="w-2 h-2 rounded-full bg-zinc-600 shrink-0"/>
                                        <p className="text-xs text-zinc-300 truncate">{label}</p>
                                      </div>
                                      <p className="text-[11px] text-zinc-500 truncate">{displayName}</p>
                                    </div>
                                    <button
                                      type="button"
                                      disabled
                                      className="text-[11px] rounded-md border border-white/8 bg-zinc-900 px-2 py-1 text-zinc-500 cursor-not-allowed whitespace-nowrap"
                                      title="Offline friends cannot be invited right now"
                                    >
                                      Offline
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          ):(
                            <p className="px-2 pb-1 text-[11px] text-zinc-500">All available friends are already online above.</p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <HeaderNotifications
                friendRequests={friendRequests}
                invites={invites}
                friendRequestBusyByUid={friendRequestBusyByUid}
                onAcceptFriendRequest={uid=>onRespondFriendRequest?.(uid,"accept")}
                onDeclineFriendRequest={uid=>onRespondFriendRequest?.(uid,"reject")}
                onAcceptInvite={onAcceptInvite}
                open={showHeaderNotifications}
                onOpenChange={next=>{
                  setShowHeaderNotifications(next);
                  if(next)setShowFriendMenu(false);
                }}
              />
              <div ref={moreMenuRef} className="relative">
                <button
                  type="button"
                  onClick={()=>{setShowMoreMenu(v=>!v);setShowHeaderNotifications(false);setShowFriendMenu(false);}}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300 transition-all duration-200 hover:border-white/18 hover:text-zinc-100"
                  title="More actions"
                >
                  <Menu size={15}/>
                </button>
                {showMoreMenu&&(
                  <div className="absolute right-0 z-40 mt-3 w-48 rounded-[1.35rem] border border-white/10 bg-zinc-950/95 p-2 shadow-[0_28px_80px_rgba(0,0,0,0.52)] backdrop-blur-2xl">
                    <button
                      type="button"
                      onClick={()=>{setShowMoreMenu(false);openSourcePanel();}}
                      className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-zinc-200 transition-all duration-200 hover:bg-white/[0.05]"
                    >
                      Change source
                    </button>
                    <button
                      type="button"
                      onClick={()=>{setShowMoreMenu(false);openResourceInNewTab();}}
                      disabled={!resourceUrl}
                      className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-zinc-200 transition-all duration-200 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Open resource
                    </button>
                    {!callVisible?(
                      <button
                        type="button"
                        onClick={()=>{setShowMoreMenu(false);joinCall(true);}}
                        className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-zinc-200 transition-all duration-200 hover:bg-white/[0.05]"
                      >
                        Start call
                      </button>
                    ):(
                      <button
                        type="button"
                        onClick={()=>{setShowMoreMenu(false);leaveCall();}}
                        className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-red-300 transition-all duration-200 hover:bg-red-500/10"
                      >
                        {isJoiningCall?"Cancel call":"End call"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={()=>{setShowMoreMenu(false);copyCode();}}
                      className="w-full rounded-xl px-3 py-2.5 text-left text-xs text-zinc-200 transition-all duration-200 hover:bg-white/[0.05]"
                    >
                      Copy room code
                    </button>
                  </div>
                )}
              </div>
              {!callVisible
                ?<button onClick={()=>joinCall(true)}
                    className="flex items-center gap-1.5 rounded-full bg-emerald-400 px-3 py-1.5 text-xs font-medium text-zinc-950 transition-all duration-200 shadow-[0_14px_34px_rgba(16,185,129,0.25)] hover:-translate-y-0.5 hover:bg-emerald-300 sm:px-3.5">
                    <Phone size={12}/> Start Call
                  </button>
                :<div className="flex items-center gap-2">
                    <span className={`hidden sm:flex text-xs items-center gap-1 ${isJoiningCall?"text-amber-300":"text-green-400"}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${isJoiningCall?"bg-amber-300 animate-pulse":"bg-green-400 animate-pulse"}`}/>
                      {isJoiningCall?"Starting...":"In Call"}
                    </span>
                    <button onClick={leaveCall}
                      className="flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-red-500 sm:px-3.5">
                      <PhoneOff size={12}/>{isJoiningCall?"Cancel":"End Call"}
                    </button>
                  </div>
              }
              <button onClick={()=>setShowChat(s=>!s)}
                className="rounded-full border border-white/8 bg-white/[0.03] p-2 text-zinc-500 transition-all duration-200 hover:border-white/16 hover:text-zinc-300"
                title={showChat ? "Close chat" : "Open chat"}>
                <MessageSquare size={15}/>
              </button>
              <button onClick={onLeave}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-zinc-500 transition-all duration-200 hover:bg-white/[0.05] hover:text-red-300">
                <LogOut size={13}/><span className="hidden sm:inline">Leave</span>
              </button>
            </div>
          </div>
        )}
      </header>

      {/* ── Body ── */}
      <div className="relative z-10 flex-1 flex flex-col lg:flex-row overflow-hidden min-h-0">

        {/* Main stage contains the player/document canvas, overlays, source controls, and floating call window. */}
        <div ref={containerRef} className={`relative flex min-h-[45dvh] min-w-0 flex-1 flex-col overflow-hidden lg:min-h-0 ${isReadingMode?"bg-zinc-100":"bg-[radial-gradient(circle_at_top,rgba(251,146,60,0.08),transparent_34%),linear-gradient(180deg,rgba(9,9,11,0.95),rgba(3,4,7,1))]"}`}>
          <div className={`relative flex flex-1 items-center justify-center overflow-hidden ${isReadingMode?"bg-zinc-100":"bg-[radial-gradient(circle_at_top,rgba(139,92,246,0.08),transparent_30%),linear-gradient(180deg,rgba(3,4,7,1),rgba(2,6,23,0.96))]"}`}>
            {isStudyHost&&(
              <div className="absolute left-4 right-4 top-4 z-10 flex items-center gap-2 rounded-full border border-amber-400/18 bg-amber-500/12 px-4 py-2 text-xs text-amber-200 shadow-[0_18px_40px_rgba(251,146,60,0.12)] backdrop-blur-xl">
                <GraduationCap size={14}/>
                <span>
                  You are the teacher - you control playback for all students in this session.
                </span>
              </div>
            )}
            {isStudyStudent&&(
              <div className="absolute left-4 right-4 top-4 z-10 flex items-center gap-2 rounded-full border border-white/10 bg-zinc-900/88 px-4 py-2 text-xs text-zinc-300 shadow-[0_18px_40px_rgba(0,0,0,0.28)] backdrop-blur-xl">
                <Lock size={14}/>
                <span>
                  Your teacher controls playback. Use the chat to ask questions.
                </span>
              </div>
            )}
            {isMusicMode&&!useYouTubePlayer&&(
              <audio
                ref={audioRef}
                preload="auto"
                playsInline
                className="hidden"
                onPlay={()=>{
                  expectedPlayRef.current=true;
                  setIsPlaying(true);
                }}
                onPause={()=>{
                  setIsPlaying(false);
                }}
                onTimeUpdate={()=>{
                  const t=audioRef.current?.currentTime||0;
                  if(!isScrubbing.current)setCurrentTime(t);
                  myTimeRef.current=t;
                }}
                onLoadedMetadata={()=>{
                  setDuration(audioRef.current?.duration||0);
                  setVideoLoaded(true);
                  localMediaReadyRef.current=true;
                }}
                onWaiting={handleLocalBuffering}
                onStalled={handleLocalBuffering}
                onCanPlay={tryRecoverFromBuffer}
                onCanPlayThrough={tryRecoverFromBuffer}
                onSeeking={()=>{if(!suppressSeekEchoRef.current){isScrubbing.current=true;}}}
                onSeeked={()=>{
                  if(suppressSeekEchoRef.current){
                    suppressSeekEchoRef.current=false;
                    isScrubbing.current=false;
                    return;
                  }
                  if(!isScrubbing.current)return;
                  isScrubbing.current=false;
                  emitSeek(audioRef.current?.currentTime);
                }}
                onEnded={()=>emitPause()}
              />
            )}
            {!useYouTubePlayer&&!isMusicMode&&(
              <video
                ref={videoRef}
                preload="auto"
                playsInline
                className={`max-h-full max-w-full rounded-[1.5rem] border border-white/8 shadow-[0_24px_80px_rgba(0,0,0,0.38)] ${videoLoaded?"cursor-pointer":""}`}
                onClick={()=>{if(videoLoaded)handlePlayPause();}}
                onPlay={()=>{
                  expectedPlayRef.current=true;
                  setIsPlaying(true);
                }}
                onPause={()=>{
                  if(!syncWaitRef.current.active){
                    expectedPlayRef.current=false;
                  }
                  setIsPlaying(false);
                }}
                onTimeUpdate={()=>{
                  const t=videoRef.current?.currentTime||0;
                  if(!isScrubbing.current)setCurrentTime(t);
                  myTimeRef.current=t;
                }}
                onLoadedMetadata={()=>setDuration(videoRef.current?.duration||0)}
                onWaiting={handleLocalBuffering}
                onStalled={handleLocalBuffering}
                onCanPlay={tryRecoverFromBuffer}
                onCanPlayThrough={tryRecoverFromBuffer}
                onSeeking={()=>{if(!suppressSeekEchoRef.current){isScrubbing.current=true;}}}
                onSeeked={()=>{
                  if(suppressSeekEchoRef.current){
                    suppressSeekEchoRef.current=false;
                    isScrubbing.current=false;
                    return;
                  }
                  if(!isScrubbing.current)return;
                  isScrubbing.current=false;
                  emitSeek(videoRef.current?.currentTime);
                }}
                onEnded={()=>emitPause()}
              />
            )}
            {useYouTubePlayer&&(
              <div className={`w-full h-full ${isMusicMode?"pointer-events-none opacity-0 absolute inset-0":"pointer-events-auto"}`}>
                <div ref={youtubeHostRef} className="w-full h-full"/>
              </div>
            )}
            {/* Music mode swaps the video stage for a transport-focused hero layout. */}
            {showMusicStage&&(
              <div className="absolute inset-0 z-[4] flex items-center justify-center p-6">
                <div className="w-full max-w-4xl rounded-[34px] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(251,146,60,0.18),_transparent_44%),radial-gradient(circle_at_90%_0%,_rgba(139,92,246,0.14),_transparent_35%),linear-gradient(180deg,_rgba(24,24,31,0.96),_rgba(9,9,11,0.98))] px-5 py-5 shadow-[0_40px_120px_rgba(0,0,0,0.56)] sm:px-7 sm:py-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-4">
                        <div className="hidden h-16 w-16 shrink-0 items-center justify-center rounded-[24px] border border-amber-400/18 bg-amber-300/10 text-amber-200 shadow-[0_22px_60px_rgba(251,146,60,0.12)] sm:flex">
                          <Headphones size={26}/>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] uppercase tracking-[0.3em] text-amber-200/80">Music Mode</p>
                          <p className="mt-3 truncate font-display text-3xl text-zinc-100 sm:text-[2.5rem]">
                            {videoName||"Waiting for a track"}
                          </p>
                          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
                            {useYouTubePlayer
                              ?videoLoaded
                                ?"YouTube audio is synced through the room clock. Use the room controls below to keep everyone locked together."
                                :"Preparing the YouTube player for synchronized audio."
                              :resourceUrl
                                ?videoLoaded
                                  ?"Audio is loaded and following the shared master timeline."
                                  :"Preparing the shared audio source for everyone in the room."
                                :"Load a local file or paste a shareable audio link to turn every device into a synchronized speaker."}
                          </p>
                          <div className="mt-4 flex flex-wrap gap-2">
                            <span className="rounded-full border border-white/8 bg-white/[0.04] px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-zinc-200">
                              {isPlaying?"Playing":"Paused"}
                            </span>
                            <span className="rounded-full border border-white/8 bg-white/[0.04] px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-zinc-200">
                              {useYouTubePlayer?"YouTube":resourceUrl?"Shared audio":"Local audio"}
                            </span>
                            <span className="rounded-full border border-violet-400/18 bg-violet-500/10 px-3 py-1.5 text-[11px] uppercase tracking-[0.2em] text-violet-100">
                              Equal control
                            </span>
                          </div>
                          {audioLoadWarning&&(
                            <p className="mt-4 inline-flex rounded-full border border-amber-400/20 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
                              {audioLoadWarning}
                            </p>
                          )}
                          {useYouTubePlayer&&!videoLoaded&&(
                            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/8 bg-black/35 px-3 py-1.5 text-xs text-zinc-300">
                              <span className="h-3 w-3 rounded-full border-2 border-zinc-600 border-t-amber-300 animate-spin"/>
                              Preparing YouTube audio...
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:min-w-[13rem]">
                      <div className="rounded-[24px] border border-white/8 bg-black/35 px-4 py-3 text-right">
                        <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Clock</p>
                        <p className="mt-2 text-3xl font-mono text-zinc-100">{fmt(currentTime)}</p>
                        <p className="mt-1 text-[11px] text-zinc-500">{audioDebugStatus||"Waiting for sync"}</p>
                      </div>
                      <div className="rounded-[24px] border border-white/8 bg-zinc-950/70 px-4 py-3">
                        <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Timeline</p>
                        <div className="mt-2 flex items-center justify-between text-sm text-zinc-100">
                          <span>{fmt(currentTime)}</span>
                          <span className="text-zinc-500">/</span>
                          <span>{fmt(duration)}</span>
                        </div>
                        <p className="mt-1 text-[11px] text-zinc-500">Shared master clock sync</p>
                      </div>
                    </div>
                  </div>
                  {!videoLoaded?(
                    <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.85fr)]">
                      <div className="rounded-[28px] border border-white/8 bg-zinc-950/65 p-4 sm:p-5">
                        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Load Source</p>
                        <div className="mt-4 flex flex-col gap-3">
                          <div className="flex flex-col gap-3 sm:flex-row">
                            <button
                              type="button"
                              onClick={()=>fileInputRef.current?.click()}
                              disabled={!canChangeSource}
                              className={`inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition-colors ${
                                canChangeSource
                                  ?"bg-gradient-to-r from-amber-400 to-orange-300 text-zinc-950 hover:from-amber-300 hover:to-orange-200 shadow-[0_18px_40px_rgba(251,146,60,0.25)]"
                                  :"bg-zinc-800/70 text-zinc-500 cursor-not-allowed"
                              }`}
                            >
                              <Upload size={16}/>
                              {uploadButtonLabel}
                            </button>
                            <button
                              type="button"
                              onClick={openSourcePanel}
                              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300 transition-all duration-200 hover:border-white/18 hover:text-zinc-100"
                            >
                              <Link2 size={15}/>
                              Open source panel
                            </button>
                          </div>
                          <div className="flex items-center gap-2 rounded-2xl border border-white/8 bg-black/25 px-3.5">
                            <Link2 size={15} className="shrink-0 text-zinc-500"/>
                            <input
                              value={resourceInput}
                              onChange={handleResourceInputChange}
                              disabled={!canChangeSource}
                              onKeyDown={e=>{if(e.key==="Enter")handleLoadResourceLink();}}
                              placeholder={engineUi.resourcePlaceholder||"Paste audio link"}
                              className={`flex-1 bg-transparent py-3 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none ${
                                !canChangeSource?"cursor-not-allowed opacity-60":""}
                              `}
                            />
                            <button
                              type="button"
                              onClick={handleLoadResourceLink}
                              disabled={!canChangeSource}
                              className={`rounded-xl border px-3 py-2 text-xs font-medium transition-colors ${
                                canChangeSource
                                  ?"border-white/10 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.12]"
                                  :"border-zinc-800 bg-zinc-800/60 text-zinc-500 cursor-not-allowed"
                              }`}
                            >
                              Load audio
                            </button>
                          </div>
                        </div>
                        <p className="mt-3 text-xs leading-6 text-zinc-500">
                          MP3, WAV, and AAC are best for local sync. YouTube and direct audio links are shareable across devices.
                        </p>
                      </div>
                      <div className="rounded-[28px] border border-white/8 bg-zinc-950/65 p-4 sm:p-5">
                        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Room Sync</p>
                        <p className="mt-4 text-sm leading-6 text-zinc-300">
                          Everyone can play, pause, or jump the track. The server only shares timeline state, so each device stays in sync without streaming audio.
                        </p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <span className="rounded-full border border-white/8 bg-black/25 px-3 py-1.5 text-[11px] text-zinc-400">
                            Scheduled starts
                          </span>
                          <span className="rounded-full border border-white/8 bg-black/25 px-3 py-1.5 text-[11px] text-zinc-400">
                            Drift correction
                          </span>
                          <span className="rounded-full border border-white/8 bg-black/25 px-3 py-1.5 text-[11px] text-zinc-400">
                            Late join sync
                          </span>
                        </div>
                      </div>
                    </div>
                  ):(
                    <div className="mt-6 rounded-[28px] border border-white/8 bg-zinc-950/70 p-4 sm:p-5">
                      <div className="flex items-center gap-3">
                        <span className="text-zinc-500 text-xs font-mono w-12 text-right shrink-0">{fmt(currentTime)}</span>
                        <input
                          type="range"
                          min={0}
                          max={duration||100}
                          step={0.1}
                          value={currentTime}
                          disabled={!videoLoaded||isStudyStudent}
                          className={`flex-1 accent-amber-400 ${
                            isStudyStudent?"cursor-not-allowed opacity-40":"cursor-pointer"
                          }`}
                          style={{height:"4px"}}
                          onMouseDown={()=>{isScrubbing.current=true;}}
                          onTouchStart={()=>{isScrubbing.current=true;}}
                          onChange={handleScrubChange}
                          onMouseUp={handleScrubEnd}
                          onTouchEnd={handleScrubEnd}
                        />
                        <span className="text-zinc-500 text-xs font-mono w-12 shrink-0">{fmt(duration)}</span>
                      </div>
                      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={()=>handleSkip(-10)}
                            disabled={!videoLoaded||isStudyStudent}
                            title="Back 10s"
                            className={`p-2 rounded-xl text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors ${
                              isStudyStudent?"opacity-40 cursor-not-allowed":"hover:bg-zinc-800"
                            }`}
                          >
                            <SkipBack size={16}/>
                          </button>
                          <button
                            type="button"
                            onClick={isStudyStudent?undefined:handlePlayPause}
                            disabled={!videoLoaded||isStudyStudent}
                            title={isStudyStudent?"Your teacher controls playback":isPlaying?"Pause":"Play"}
                            className={`h-12 w-12 rounded-full bg-amber-300 flex items-center justify-center text-zinc-950 transition-colors disabled:opacity-30 shadow-lg shadow-amber-500/20 ${
                              isStudyStudent?"opacity-40 cursor-not-allowed":"hover:bg-amber-200 cursor-pointer"
                            }`}
                          >
                            {isStudyStudent?<Lock size={16}/>:isPlaying?<Pause size={18}/>:<Play size={18} className="ml-0.5"/>}
                          </button>
                          <button
                            type="button"
                            onClick={()=>handleSkip(10)}
                            disabled={!videoLoaded||isStudyStudent}
                            title="Forward 10s"
                            className={`p-2 rounded-xl text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors ${
                              isStudyStudent?"opacity-40 cursor-not-allowed":"hover:bg-zinc-800"
                            }`}
                          >
                            <SkipForward size={16}/>
                          </button>
                          <button
                            type="button"
                            onClick={toggleMute}
                            className="p-2 rounded-xl hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors ml-1"
                          >
                            {muted||volume===0?<VolumeX size={16}/>:<Volume2 size={16}/>}
                          </button>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={muted?0:volume}
                            onChange={handleVolumeChange}
                            className="w-24 accent-amber-400 cursor-pointer"
                            style={{height:"4px"}}
                          />
                          <button
                            type="button"
                            onClick={sendBookmark}
                            disabled={!videoLoaded}
                            title="Bookmark current time"
                            className="p-2 rounded-xl hover:bg-amber-500/20 text-zinc-500 hover:text-amber-400 disabled:opacity-30 transition-colors"
                          >
                            <Bookmark size={15}/>
                          </button>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={openSourcePanel}
                            className="rounded-xl border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
                          >
                            Change source
                          </button>
                          <button
                            type="button"
                            onClick={openResourceInNewTab}
                            disabled={!canOpenExternalResource}
                            className="rounded-xl border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Open link
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            {useYouTubePlayer&&!!youtubeLoadError&&!isMusicMode&&(
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-zinc-950/88 px-6 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full border border-red-400/20 bg-red-500/10 shadow-[0_18px_40px_rgba(239,68,68,0.12)]">
                  <span className="text-red-300 text-xl">!</span>
                </div>
                <div className="max-w-md">
                  <p className="text-zinc-100 text-lg font-semibold">Could not load YouTube on this device</p>
                  <p className="text-zinc-300 text-sm mt-2 leading-6">{youtubeLoadError}</p>
                  <p className="text-zinc-500 text-xs mt-3 leading-5">
                    This is usually caused by ad blockers, privacy shields, restricted networks, or browser-specific YouTube embed issues.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={()=>setYoutubeRetryNonce(v=>v+1)}
                    className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-xs text-zinc-100 transition-all duration-200 hover:border-white/18 hover:bg-white/[0.08]"
                  >
                    Retry player
                  </button>
                  <button
                    type="button"
                    onClick={openResourceInNewTab}
                    disabled={!canOpenExternalResource}
                    className="rounded-xl bg-gradient-to-r from-amber-400 to-orange-300 px-4 py-2 text-xs font-medium text-zinc-950 transition-all duration-200 hover:from-amber-300 hover:to-orange-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Open on YouTube
                  </button>
                </div>
              </div>
            )}
            {useYouTubePlayer&&!videoLoaded&&!youtubeLoadError&&!isMusicMode&&(
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-zinc-950/70 pointer-events-none">
                <div className="h-12 w-12 rounded-full border-2 border-zinc-700 border-t-amber-300 animate-spin"/>
                <p className="text-zinc-300 text-sm">Loading YouTube player...</p>
              </div>
            )}
            {/* Generic load state covers empty watch/study rooms before any media or document is active. */}
            {showGenericLoadState&&(
              <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 ${isReadingMode?"bg-zinc-100":"bg-zinc-950/96"}`}>
                <div className={`flex h-16 w-16 items-center justify-center rounded-2xl border shadow-xl ${isReadingMode?"border-zinc-300 bg-white shadow-zinc-300/30":"border-white/10 bg-zinc-900 shadow-black/40"}`}>
                  <Upload size={26} className={isReadingMode?"text-zinc-500":"text-zinc-500"}/>
                </div>
                <div className="text-center">
                  <p className={`font-semibold mb-1 ${isReadingMode?"text-zinc-800":"text-zinc-200"}`}>{uploadPrimary}</p>
                  <p className={`text-xs ${isReadingMode?"text-zinc-600":"text-zinc-500"}`}>{uploadHint}</p>
                  {docUploading&&(
                    <p className="text-amber-300 text-xs mt-1">Uploading PDF for room sharing...</p>
                  )}
                </div>
                {!isStudyStudent&&(
                  <div className="w-full max-w-xl px-4 space-y-2">
                    <div className="flex gap-2">
                      <button onClick={()=>fileInputRef.current?.click()} disabled={!canChangeSource}
                        className={`font-semibold px-4 py-2.5 rounded-xl text-sm transition-colors flex items-center gap-2 ${
                          canChangeSource
                            ?isReadingMode
                              ?"bg-zinc-900 hover:bg-zinc-700 text-white"
                              :"bg-gradient-to-r from-amber-400 to-orange-300 hover:from-amber-300 hover:to-orange-200 text-zinc-950 shadow-[0_18px_40px_rgba(251,146,60,0.25)]"
                            :"bg-zinc-800/70 text-zinc-500 cursor-not-allowed"
                        }`}>
                        <Upload size={15}/> {uploadButtonLabel}
                      </button>
                      <button
                        type="button"
                        onClick={openResourceInNewTab}
                        disabled={!showCompanionLink&&!showReadingFrame}
                      className={`px-4 py-2.5 rounded-xl border disabled:opacity-45 disabled:cursor-not-allowed text-sm ${isReadingMode?"border-zinc-300 text-zinc-700 hover:text-zinc-900 hover:border-zinc-500":"border-white/10 bg-white/[0.03] text-zinc-300 hover:text-zinc-100 hover:border-white/18"}`}
                      >
                        Open linked resource
                      </button>
                    </div>
                    <div className={`flex items-center gap-2 rounded-xl border px-3 ${isReadingMode?"border-zinc-300 bg-white":"border-white/8 bg-zinc-900/70"}`}>
                      {sessionMode==="reading"?<FileText size={14} className="text-zinc-500 shrink-0"/>:<Link2 size={14} className="text-zinc-500 shrink-0"/>}
                      <input
                        value={resourceInput}
                        onChange={handleResourceInputChange}
                        disabled={!canChangeSource}
                        onKeyDown={e=>{if(e.key==="Enter")handleLoadResourceLink();}}
                        placeholder={engineUi.resourcePlaceholder||"Paste resource link"}
                        className={`flex-1 bg-transparent py-2 text-sm focus:outline-none ${
                          isReadingMode?"text-zinc-900 placeholder-zinc-500":"text-zinc-100 placeholder-zinc-600"
                        } ${!canChangeSource?"cursor-not-allowed opacity-60":""}`}
                      />
                      <button
                        type="button"
                        onClick={handleLoadResourceLink}
                        disabled={!canChangeSource}
                        className={`text-[11px] px-2.5 py-1.5 rounded-lg border ${
                          canChangeSource
                            ?isReadingMode
                              ?"bg-zinc-100 hover:bg-zinc-200 border-zinc-300 text-zinc-700"
                              :"bg-white/[0.06] hover:bg-white/[0.12] border-white/10 text-zinc-200"
                            :"bg-zinc-800/60 border-zinc-700 text-zinc-500 cursor-not-allowed"
                        }`}
                      >
                        {sessionMode==="watch"?"Load YouTube":"Load Link"}
                      </button>
                    </div>
                    {!canChangeSource&&isReadingMode&&(
                      <p className="text-[11px] text-amber-300">Only the host can change the document in co-reading.</p>
                    )}
                    {audioLoadWarning&&!isReadingMode&&(
                      <p className="text-[11px] text-amber-300">{audioLoadWarning}</p>
                    )}
                  </div>
                )}
              </div>
            )}
            {/* The co-reading panel renders the shared PDF plus host-driven page/zoom controls. */}
            {showReadingFrame&&(
              <div className="absolute inset-0 z-[5] overflow-hidden">
                {readingPdfError?(
                  <div className="flex h-full items-center justify-center p-6">
                    <div className="max-w-md rounded-[28px] border border-red-200 bg-white px-6 py-5 text-center shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
                      <p className="text-sm font-semibold text-zinc-900">Could not open this shared PDF</p>
                      <p className="mt-2 text-xs leading-6 text-zinc-600">{readingPdfError}</p>
                      <button
                        type="button"
                        onClick={openResourceInNewTab}
                        className="mt-4 rounded-full border border-zinc-300 px-4 py-2 text-xs font-medium text-zinc-700 transition-colors hover:border-zinc-500 hover:text-zinc-900"
                      >
                        Open PDF in a new tab
                      </button>
                    </div>
                  </div>
                ):(
                  <div
                    className="h-full w-full"
                    style={{transform:`scale(${readingZoom/100})`,transformOrigin:"center center"}}
                  >
                    <CoReadingPdfViewer
                      fileUrl={sharedDocument?.fileUrl}
                      requiresAuth={isSharedUploadUrl(sharedDocument?.fileUrl)}
                      page={readingPage}
                      onDocumentLoadSuccess={numPages=>{
                        const safePage=applyReadingState(readingPage,numPages);
                        setReadingPdfLoading(false);
                        setReadingPdfReady(true);
                        setReadingPdfError("");
                        setSharedDocument(prev=>prev?{...prev,totalPages:numPages}:prev);
                        if(isHost){
                          syncReadingStateToServer(safePage,numPages);
                        }
                      }}
                      onDocumentLoadError={error=>{
                        setReadingPdfLoading(false);
                        setReadingPdfReady(false);
                        setReadingPdfError(error?.message||"Could not render this PDF");
                      }}
                    />
                  </div>
                )}
              </div>
            )}
            {showReadingFrame&&(
              <>
                <div className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-full border border-zinc-200 bg-white/88 px-3 py-1.5 text-[11px] text-zinc-600 shadow-sm backdrop-blur-sm">
                  <span className={`h-2 w-2 rounded-full ${readingPdfReady?"bg-emerald-400":"bg-amber-400 animate-pulse"}`}/>
                  <span>{readingPdfReady?"Synced":"Loading PDF"}</span>
                  <span className="text-zinc-400">•</span>
                  <span>Host: @{hostUser?.username||hostUser?.name||"host"}</span>
                </div>
                {readingPdfWarning&&(
                  <div className="absolute left-4 top-4 z-10 max-w-xs rounded-full border border-amber-200 bg-amber-50/95 px-3 py-1.5 text-[11px] text-amber-700 shadow-sm backdrop-blur-sm">
                    {readingPdfWarning}
                  </div>
                )}
                <div className="absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-zinc-200 bg-white/95 px-3 py-2.5 shadow-lg backdrop-blur-sm">
                  <button
                    onClick={()=>handleReadingPageStep(-1)}
                    disabled={!isHost||readingPage<=1||!sharedDocument?.fileUrl}
                    className="rounded-md px-2 py-1 text-sm text-zinc-700 transition-all duration-200 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ◀
                  </button>
                  <input
                    type="number"
                    min={1}
                    max={readingTotalPages||undefined}
                    value={readingPageInput}
                    onChange={e=>setReadingPageInput(e.target.value)}
                    onBlur={handleReadingPageJump}
                    onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();handleReadingPageJump();}}}
                    readOnly={!isHost}
                    className={`w-16 rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-800 focus:outline-none focus:border-zinc-500 ${!isHost?"cursor-not-allowed bg-zinc-100 text-zinc-500":"bg-white"}`}
                  />
                  <span className="text-xs text-zinc-500 min-w-[3rem]">{readingTotalPages>0?`/ ${readingTotalPages}`:"pages"}</span>
                  <button
                    onClick={()=>handleReadingPageStep(1)}
                    disabled={!isHost||!sharedDocument?.fileUrl||(readingTotalPages>0&&readingPage>=readingTotalPages)}
                    className="rounded-md px-2 py-1 text-sm text-zinc-700 transition-all duration-200 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ▶
                  </button>
                  <span className="text-xs text-zinc-500 px-1">{readingZoom}%</span>
                  <button onClick={()=>handleReadingZoom(-10)} className="rounded-md px-2 py-1 text-xs text-zinc-600 transition-all duration-200 hover:bg-zinc-100">-</button>
                  <button onClick={()=>handleReadingZoom(10)} className="rounded-md px-2 py-1 text-xs text-zinc-600 transition-all duration-200 hover:bg-zinc-100">+</button>
                  <span className="hidden sm:inline text-[11px] text-zinc-500 pl-1">
                    {isHost?"You control the room":"Following the host"}
                  </span>
                </div>
              </>
            )}
            {showCompanionLink&&(
              <div className="absolute bottom-3 left-3 right-3 z-10 flex items-center justify-between gap-2 rounded-xl border border-white/8 bg-black/55 px-3 py-2.5 text-xs text-zinc-300 backdrop-blur-sm">
                <span className="truncate">Companion {resourceType!=="unknown"?`${resourceType} `:""}resource: {resourceUrl.replace(/^https?:\/\//i,"")}</span>
                <button onClick={openResourceInNewTab} className="rounded-md border border-white/10 bg-white/[0.06] px-2.5 py-1 text-zinc-100 transition-all duration-200 hover:bg-white/[0.12]">
                  Open
                </button>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept={fileAccept} className="hidden" onChange={handleFileSelect}/>
            {actionBanner&&(
              <div className="absolute left-3 top-3 z-10 rounded-full bg-black/60 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur-sm pointer-events-none">
                {actionBanner}
              </div>
            )}
            {waitingForUser&&(
              <div className="absolute left-3 top-12 z-10 rounded-full border border-amber-400/20 bg-amber-500/12 px-3 py-1.5 text-xs text-amber-200 backdrop-blur-sm pointer-events-none">
                Waiting for @{waitingForUser}...
              </div>
            )}
            {showSourcePanel&&(
              <div className={`absolute top-4 right-4 z-20 w-[22rem] max-w-[90vw] rounded-[1.6rem] border p-3 shadow-[0_32px_100px_rgba(0,0,0,0.45)] ${
                isReadingMode?"border-zinc-200 bg-white":"border-white/10 bg-zinc-950/90"
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className={`text-sm font-semibold ${isReadingMode?"text-zinc-800":"text-zinc-100"}`}>Change source</p>
                    <p className={`text-[11px] ${isReadingMode?"text-zinc-500":"text-zinc-400"}`}>
                      {isReadingMode
                        ?"Host controls the shared document"
                        :sessionMode==="watch"
                          ?"Pick a file or paste a YouTube link"
                          :"Pick a file or paste a link"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={closeSourcePanel}
                    className={`rounded-lg border p-1.5 transition-all duration-200 ${isReadingMode?"border-zinc-200 text-zinc-500 hover:text-zinc-800":"border-white/10 text-zinc-400 hover:text-zinc-200"}`}
                  >
                    <X size={12}/>
                  </button>
                </div>
                {!isStudyStudent&&(
                  <>
                    <button
                      type="button"
                      onClick={()=>fileInputRef.current?.click()}
                      disabled={!canChangeSource}
                      className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-colors ${
                        canChangeSource
                          ?isReadingMode
                            ?"bg-zinc-900 text-white hover:bg-zinc-700"
                            :"bg-gradient-to-r from-amber-400 to-orange-300 text-zinc-950 hover:from-amber-300 hover:to-orange-200"
                          :"bg-zinc-800/60 text-zinc-500 cursor-not-allowed"
                      }`}
                    >
                      <Upload size={13}/> Choose file
                    </button>
                    <div className={`mt-2 flex items-center gap-2 rounded-xl border px-2 ${
                      isReadingMode?"border-zinc-200 bg-white":"border-white/8 bg-zinc-900/60"
                    }`}>
                      {sessionMode==="reading"?<FileText size={13} className="text-zinc-500 shrink-0"/>:<Link2 size={13} className="text-zinc-500 shrink-0"/>}
                      <input
                        value={resourceInput}
                        onChange={handleResourceInputChange}
                        placeholder={engineUi.resourcePlaceholder||"Paste link"}
                        className={`flex-1 bg-transparent py-2 text-xs focus:outline-none ${isReadingMode?"text-zinc-900 placeholder-zinc-500":"text-zinc-100 placeholder-zinc-600"}`}
                      />
                      <button
                        type="button"
                        onClick={handleLoadResourceLink}
                        disabled={!canChangeSource}
                        className={`text-[11px] px-2.5 py-1.5 rounded-lg border transition-colors ${
                          canChangeSource
                            ?isReadingMode
                              ?"bg-zinc-100 border-zinc-200 text-zinc-700 hover:bg-zinc-200"
                              :"bg-white/[0.06] border-white/10 text-zinc-200 hover:bg-white/[0.12]"
                            :"bg-zinc-800/60 border-zinc-800 text-zinc-500 cursor-not-allowed"
                        }`}
                      >
                        {sessionMode==="watch"?"YouTube":"Load"}
                      </button>
                    </div>
                  </>
                )}
                {sourcePanelError&&(
                  <p className={`mt-2 text-[11px] leading-5 ${isReadingMode?"text-red-600":"text-red-300"}`}>
                    {sourcePanelError}
                  </p>
                )}
                {!canChangeSource&&(
                  <p className="mt-2 text-[11px] text-amber-300">Only the host can change the document in co-reading.</p>
                )}
              </div>
            )}
          </div>

      {/* Transport controls stay below the stage for non-reading video sessions. */}
          {showBottomTransport&&(
            <div className="relative z-10 flex shrink-0 flex-col gap-3 border-t border-white/8 bg-zinc-950/94 px-4 py-3 backdrop-blur-xl">
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 text-xs font-mono w-12 text-right shrink-0">{fmt(currentTime)}</span>
              <input type="range" min={0} max={duration||100} step={0.1} value={currentTime}
                disabled={!videoLoaded||isStudyStudent}
                className={`flex-1 accent-amber-400 ${
                  isStudyStudent?"cursor-not-allowed opacity-40":"cursor-pointer"
                }`} style={{height:"4px"}}
                onMouseDown={()=>{isScrubbing.current=true;}}
                onTouchStart={()=>{isScrubbing.current=true;}}
                onChange={handleScrubChange} onMouseUp={handleScrubEnd} onTouchEnd={handleScrubEnd}/>
              <span className="text-zinc-500 text-xs font-mono w-12 shrink-0">{fmt(duration)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={()=>handleSkip(-10)} disabled={!videoLoaded||isStudyStudent} title="Back 10s"
                className={`rounded-xl p-2 text-zinc-400 transition-all duration-200 disabled:opacity-30 ${
                  isStudyStudent?"opacity-40 cursor-not-allowed":"hover:bg-white/[0.05] hover:text-zinc-200"
                }`}>
                <SkipBack size={16}/>
              </button>
              <button onClick={isStudyStudent?undefined:handlePlayPause} disabled={!videoLoaded||isStudyStudent}
                title={isStudyStudent?"Your teacher controls playback":isPlaying?"Pause":"Play"}
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-amber-400 to-orange-300 text-zinc-950 shadow-[0_18px_40px_rgba(251,146,60,0.24)] transition-all duration-200 disabled:opacity-30 ${
                  isStudyStudent?"opacity-40 cursor-not-allowed":"cursor-pointer hover:-translate-y-0.5 hover:from-amber-300 hover:to-orange-200"
                }`}>
                {isStudyStudent?<Lock size={16}/>:isPlaying?<Pause size={17}/>:<Play size={17} className="ml-0.5"/>}
              </button>
              <button onClick={()=>handleSkip(10)} disabled={!videoLoaded||isStudyStudent} title="Forward 10s"
                className={`rounded-xl p-2 text-zinc-400 transition-all duration-200 disabled:opacity-30 ${
                  isStudyStudent?"opacity-40 cursor-not-allowed":"hover:bg-white/[0.05] hover:text-zinc-200"
                }`}>
                <SkipForward size={16}/>
              </button>
              <button onClick={toggleMute} className="ml-1 rounded-xl p-2 text-zinc-400 transition-all duration-200 hover:bg-white/[0.05] hover:text-zinc-200">
                {muted||volume===0?<VolumeX size={15}/>:<Volume2 size={15}/>}
              </button>
              <input type="range" min={0} max={1} step={0.05} value={muted?0:volume}
                onChange={handleVolumeChange} className="w-20 accent-amber-400 cursor-pointer" style={{height:"4px"}}/>
              <button onClick={sendBookmark} disabled={!videoLoaded} title="Bookmark current time"
                className="ml-1 rounded-xl p-2 text-zinc-500 transition-all duration-200 hover:bg-amber-500/12 hover:text-amber-300 disabled:opacity-30">
                <Bookmark size={15}/>
              </button>
              {videoName&&<span className="text-zinc-600 text-xs font-mono truncate max-w-[180px] hidden lg:block ml-1">{videoName}</span>}
              <div className="flex-1"/>
              <span className="text-zinc-700 text-xs hidden sm:block">
                {isMusicMode
                  ?"Equal control • master clock sync"
                  :sessionMode==="study"
                    ?isStudyHost
                      ?"You are the teacher"
                      :"Teacher controls"
                    :"Everyone controls"}
              </span>
              {!isMusicMode&&(
                <button onClick={handleFullscreen} title={isFullscreen?"Exit fullscreen":"Fullscreen"}
                  className="rounded-xl p-2 text-zinc-400 transition-all duration-200 hover:bg-white/[0.05] hover:text-zinc-200">
                  {isFullscreen?<Minimize size={15}/>:<Maximize size={15}/>}
                </button>
              )}
            </div>
            </div>
          )}

          {/* Call window stays inside the stage container so fullscreen mode still shows the call overlay. */}
          {callVisible&&(
            <DraggableCallWindow
              inCall={inCall} isConnecting={isJoiningCall}
              micOn={micOn} camOn={camOn}
              localStreamRef={localStreamRef} remoteStreams={remoteStreams}
              users={users} myUid={user.uid} myName={username}
              onLeave={leaveCall} onToggleMic={toggleMic} onToggleCam={toggleCam}
              containerRef={containerRef}
            />
          )}
        </div>

        {/* Chat panel contains participant chips, the message timeline, presets, and composer controls. */}
        {showChat&&(
          <div className={`flex h-[40dvh] max-h-[32rem] w-full shrink-0 flex-col border shadow-2xl backdrop-blur-xl lg:h-auto lg:max-h-none lg:w-[30rem] lg:border-b-0 lg:border-r-0 lg:border-t-0 lg:shadow-none ${isReadingMode?"border-zinc-300/80 bg-white/80 lg:border-l-zinc-300 lg:bg-white/75":"border-white/8 bg-zinc-950/78 lg:border-l-white/8 lg:bg-zinc-950/68"}`}>
            <div className={`flex items-center justify-between border-b px-4 py-3 ${isReadingMode?"border-zinc-300/70":"border-white/8"}`}>
              <span className={`flex items-center gap-2 text-sm font-medium ${isReadingMode?"text-zinc-800":"text-zinc-200"}`}>
                <MessageSquare size={13} className="text-amber-400"/> Chat
                <span className={`text-xs ${isReadingMode?"text-zinc-500":"text-zinc-600"}`}>{users.length} people</span>
              </span>
              <button onClick={()=>setShowChat(false)} className={`flex items-center gap-1 text-xs transition-all duration-200 ${isReadingMode?"text-zinc-500 hover:text-zinc-800":"text-zinc-400 hover:text-zinc-200"}`}>
                <X size={13}/> Close
              </button>
            </div>
            <div className={`flex items-center gap-1.5 border-b px-4 py-2.5 flex-wrap ${isReadingMode?"border-zinc-300/60":"border-white/8"}`}>
              {users.map(u=>(
                <div key={u.uid} title={`@${u.username||u.name}`}>
                  {renderUserAvatar(u,"w-6 h-6","text-[10px]",u.name)}
                </div>
              ))}
            </div>
            <div
              className="flex flex-1 flex-col gap-3 overflow-y-auto p-3.5"
              onScroll={()=>setClosePickerSignal(v=>v+1)}
            >
              {messages.length===0&&<p className={`text-xs text-center mt-8 ${isReadingMode?"text-zinc-500":"text-zinc-700"}`}>No messages yet!</p>}
              {messages.map((m,i)=>(
                <ChatMessage
                  key={m.id||i}
                  msg={resolveMessageAuthor(m)}
                  myUid={user.uid}
                  onReact={handleReact}
                  onBookmarkSeek={handleBookmarkSeek}
                  closePickerSignal={closePickerSignal}
                />
              ))}
              <div ref={chatEndRef}/>
            </div>
            {/* Preset messages panel — slides in above input */}
            {showPresets&&(
              <PresetPanel
                onSelect={text=>{setChatInput(text);setShowPresets(false);}}
                onClose={()=>setShowPresets(false)}
                sessionMode={sessionMode}
              />
            )}
            <form onSubmit={sendMessage} className={`safe-bottom flex items-center gap-2 border-t p-3 ${isReadingMode?"border-zinc-300/70":"border-white/8"}`}>
              {/* Sparkle button — opens preset messages */}
              <button type="button" onClick={()=>setShowPresets(s=>!s)}
                title="Quick messages"
                className={`shrink-0 rounded-xl border p-2 transition-all duration-200
                  ${showPresets
                    ?"bg-amber-500/12 border-amber-400/18 text-amber-300"
                    :"bg-white/[0.03] border-white/8 text-zinc-500 hover:text-amber-300 hover:border-amber-400/18"}`}>
                ✨
              </button>
              <input value={chatInput} onChange={e=>setChatInput(e.target.value)}
                placeholder={sessionMode==="study"?"Ask a question, raise hand, share notes...":chatPlaceholder} maxLength={500}
                onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage(e);}}}
                className={`min-w-0 flex-1 rounded-xl border px-3 py-2.5 text-sm transition-all duration-200 focus:border-amber-500/50 focus:outline-none ${
                  isReadingMode
                    ?"bg-white border-zinc-300 text-zinc-900 placeholder-zinc-500"
                    :"bg-white/[0.04] border-white/10 text-zinc-100 placeholder-zinc-500"
                }`}
              />
              <button
                type="button"
                onClick={sendBookmark}
                disabled={!videoLoaded||isReadingMode}
                title="Bookmark current time"
                className={`shrink-0 rounded-xl border p-2 disabled:opacity-30 transition-all duration-200 ${
                  isReadingMode
                    ?"bg-zinc-100 border-zinc-300 text-zinc-500 hover:bg-zinc-200"
                    :"bg-white/[0.03] border-white/8 text-zinc-500 hover:bg-amber-500/12 hover:text-amber-300"
                }`}
              >
                <Bookmark size={14}/>
              </button>
              {isStudyStudent&&(
                <button
                  type="button"
                  onClick={handleRaiseHand}
                  className="shrink-0 flex items-center gap-1.5 rounded-xl border border-amber-400/18 bg-amber-500/12 px-3 py-2 text-xs text-amber-200 transition-all duration-200 hover:bg-amber-500/18"
                  title="Raise your hand"
                >
                  ✋ Raise hand
                </button>
              )}
              <button type="submit" disabled={!chatInput.trim()}
                className="shrink-0 rounded-xl bg-gradient-to-r from-amber-400 to-orange-300 p-2 text-zinc-950 transition-all duration-200 hover:from-amber-300 hover:to-orange-200 disabled:opacity-40">
                <Send size={14}/>
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

export default RoomView
