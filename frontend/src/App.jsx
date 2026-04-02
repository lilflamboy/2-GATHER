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
  signInWithPopup,
  signOut,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
  sendPasswordResetEmail,
} from "firebase/auth";
import { io } from "socket.io-client";
import { auth, googleProvider } from "./firebase.js";
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
import {
  Film, MessageSquare, LogOut, Copy, Check,
  Play, Pause, SkipBack, SkipForward, Maximize, Minimize,
  Users, UserPlus, Bell, Wifi, WifiOff, Upload, Send, X, ChevronRight,
  AlertCircle, Menu, Mic, MicOff, Video, VideoOff, Phone, PhoneOff,
  Volume2, VolumeX, Bookmark, GripHorizontal, AtSign, Clock,
  Lock, Headphones, Library, Link2, FileText,
} from "lucide-react";

const YOUTUBE_REMOTE_GUARD_MS = 1400;
const YOUTUBE_LOCAL_CONTROL_DEBOUNCE_MS = 900;
const YOUTUBE_NATIVE_SEEK_DEBOUNCE_MS = 1400;
const YOUTUBE_SCHEDULE_BUFFER_MS = 120;

const normalizeCode = (s) => s.trim().toUpperCase();

const fmt = (s) => {
  if (!s || isNaN(s)) return "0:00";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

const formatDurationLabel = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const isHttpUrl = (value) => /^https?:\/\/\S+$/i.test(String(value || "").trim());
const isYoutubeUrl = (value) => /youtu\.?be|youtube\.com/i.test(String(value || ""));
const isPdfUrl = (value) => /\.pdf(\?|#|$)/i.test(String(value || ""));
const isBlobUrl = (value) => /^blob:/i.test(String(value || "").trim());
const isDirectMediaUrl = (value) => /\.(mp4|webm|ogg|m3u8|mp3|wav|aac|m4a)(\?|#|$)/i.test(String(value || ""));

const guessDocumentFileName = (value) => {
  try {
    const parsed = new URL(String(value || ""));
    const segment = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(segment || "").trim() || "shared-document.pdf";
  } catch {
    return "shared-document.pdf";
  }
};

const buildDocumentSignature = (fileName, fileSize) => `${String(fileName || "shared-document.pdf").trim()}:${Math.max(0, Math.floor(Number(fileSize) || 0))}`;

const isSharedUploadUrl = (value) => {
  try {
    const parsed = new URL(String(value || ""));
    return /\/api\/uploads\/document\/[^/]+$/i.test(parsed.pathname || "");
  } catch {
    return false;
  }
};

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

let youtubeApiPromise = null;

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

// ─── Storage helpers ──────────────────────────────────────────────────────────
const saveSession  = c => { try{sessionStorage.setItem(SESSION_KEY,c);}catch(_){} };
const loadSession  = () => { try{return sessionStorage.getItem(SESSION_KEY);}catch(_){return null;} };
const clearSession = () => { try{sessionStorage.removeItem(SESSION_KEY);}catch(_){} };
const saveUsername  = u => { try{localStorage.setItem(USERNAME_KEY,u);}catch(_){} };
const loadUsername  = () => { try{return localStorage.getItem(USERNAME_KEY)||"";}catch(_){return "";} };
const savePushPref = enabled => { try{localStorage.setItem(PUSH_PREF_KEY,enabled?"1":"0");}catch(_){} };
const loadPushPref = () => { try{return localStorage.getItem(PUSH_PREF_KEY)==="1";}catch(_){return false;} };

// ─── Toast ────────────────────────────────────────────────────────────────────
function useToast(){
  const [toasts,setToasts]=useState([]);
  const add=useCallback((message,type="info")=>{
    const id=Date.now();
    setToasts(p=>[...p,{id,message,type}]);
    setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)),4000);
  },[]);
  const remove=useCallback(id=>setToasts(p=>p.filter(t=>t.id!==id)),[]);
  return {toasts,addToast:add,removeToast:remove};
}

function Toasts({toasts,removeToast}){
  return(
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t=>(
        <div key={t.id} onClick={()=>removeToast(t.id)}
          className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl
            backdrop-blur-md border text-sm font-medium cursor-pointer
            ${t.type==="error"?"bg-red-900/90 border-red-700 text-red-100":
              t.type==="success"?"bg-green-900/90 border-green-700 text-green-100":
              "bg-zinc-800/95 border-zinc-600 text-zinc-100"}`}>
          <AlertCircle size={14} className="shrink-0"/>{t.message}
        </div>
      ))}
    </div>
  );
}

// ─── Username Setup Screen ────────────────────────────────────────────────────
function UsernameSetup({displayName, onDone}){
  const suggested = (displayName||"").toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9_]/g,"").slice(0,18);
  const [value,setValue]=useState(suggested);
  const [error,setError]=useState("");
  const [submitting,setSubmitting]=useState(false);

  const validate = v => {
    if(!v) return "Username is required";
    if(v.length<3) return "At least 3 characters";
    if(v.length>20) return "Max 20 characters";
    if(!/^[a-zA-Z0-9_]+$/.test(v)) return "Only letters, numbers, underscore";
    return "";
  };

  const handleSubmit = async e => {
    e.preventDefault();
    const err=validate(value.trim());
    if(err){setError(err);return;}
    setSubmitting(true);
    try{
      const ok=await onDone(value.trim().toLowerCase());
      if(ok===false){
        setError("Username unavailable. Try another one.");
      }
    }catch(submitError){
      setError(submitError?.message||"Unable to save username");
    }finally{
      setSubmitting(false);
    }
  };

  return(
    <div className="min-h-screen bg-screen flex items-center justify-center p-8 relative overflow-hidden">
      <div className="grain-overlay"/>
      <div className="absolute w-96 h-96 rounded-full bg-amber-600/8 blur-3xl top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"/>
      <div className="relative z-10 w-full max-w-sm flex flex-col gap-6">
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
            <AtSign size={26} className="text-amber-400"/>
          </div>
          <h1 className="font-display text-3xl text-zinc-100">Choose your username</h1>
          <p className="text-zinc-500 text-sm text-center">This is how friends will see you.<br/>You can't change it later.</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-4">
          <div>
            <div className="flex items-center bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 focus-within:border-amber-500/60 transition-colors">
              <span className="text-zinc-500 mr-1 text-sm">@</span>
              <input
                value={value}
                onChange={e=>{setValue(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,"").slice(0,20));setError("");}}
                placeholder="yourname"
                autoFocus
                className="flex-1 bg-transparent text-zinc-100 text-sm font-mono focus:outline-none placeholder-zinc-600"
              />
            </div>
            {error&&<p className="text-red-400 text-xs mt-1.5 ml-1">{error}</p>}
            {!error&&value.length>0&&<p className="text-zinc-600 text-xs mt-1.5 ml-1">{value.length}/20 characters</p>}
          </div>
          <button type="submit" disabled={submitting}
            className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 font-semibold py-3 rounded-xl transition-colors">
            {submitting?"Saving...":"Continue →"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Preset Messages Panel ───────────────────────────────────────────────────
function PresetPanel({onSelect,onClose,sessionMode="watch"}){
  const modeMessages=SESSION_PRESET_MESSAGES[sessionMode]||SESSION_PRESET_MESSAGES.watch;
  const categories=[...new Set(modeMessages.map(item=>item.category).filter(Boolean))];
  const [filter,setFilter]=useState("all");
  const cats=[
    {key:"all",label:"All"},
    ...categories.map(category=>({
      key:category,
      label:category.replace(/_/g," ").replace(/\b\w/g,ch=>ch.toUpperCase()),
    })),
  ];
  const filtered=filter==="all"?modeMessages:modeMessages.filter(m=>m.category===filter);

  useEffect(()=>{
    setFilter("all");
  },[sessionMode]);
  return(
    <div className="border-t border-zinc-800/60 bg-zinc-900/95 p-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-zinc-500 text-xs font-medium">Quick messages</span>
        <button onClick={onClose} className="text-zinc-600 hover:text-zinc-400 transition-colors"><X size={12}/></button>
      </div>
      {/* Category tabs */}
      <div className="flex gap-1 mb-2 overflow-x-auto pb-1">
        {cats.map(c=>(
          <button key={c.key} onClick={()=>setFilter(c.key)}
            className={`text-xs px-2 py-1 rounded-lg whitespace-nowrap transition-colors shrink-0
              ${filter===c.key?"bg-amber-500/20 text-amber-300 border border-amber-500/30":"bg-zinc-800 text-zinc-500 hover:text-zinc-300"}`}>
            {c.label}
          </button>
        ))}
      </div>
      {/* Messages grid */}
      <div className="flex flex-col gap-1 max-h-44 overflow-y-auto">
        {filtered.map((m,i)=>(
          <button key={i} onClick={()=>onSelect(m.text)}
            className="flex items-center gap-2 text-left px-3 py-2 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/80
              text-zinc-300 text-xs transition-colors border border-transparent hover:border-zinc-600/50">
            <span className="text-base shrink-0">{m.emoji}</span>
            <span className="leading-tight">{m.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Landing ──────────────────────────────────────────────────────────────────
function LandingView({addToast}){
  const [mode,setMode]=useState("login");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [confirmPassword,setConfirmPassword]=useState("");
  const [displayName,setDisplayName]=useState("");
  const [submitting,setSubmitting]=useState(false);
  const [googleLoading,setGoogleLoading]=useState(false);
  const [resetLoading,setResetLoading]=useState(false);
  const [error,setError]=useState("");
  const [info,setInfo]=useState("");

  const signInGoogle=async()=>{
    setGoogleLoading(true);
    setError("");
    setInfo("");
    try{
      await signInWithPopup(auth,googleProvider);
    }catch(e){
      setError(e.message||"Google sign-in failed");
      addToast?.(e.message||"Google sign-in failed","error");
    }finally{
      setGoogleLoading(false);
    }
  };

  const submitEmail=async(e)=>{
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setInfo("");
    try{
      if(mode==="register"){
        if(!displayName.trim()) throw new Error("Display name is required");
        if(password.length<6) throw new Error("Password must be at least 6 characters");
        if(password!==confirmPassword) throw new Error("Passwords do not match");
        const credential=await createUserWithEmailAndPassword(auth,email.trim(),password);
        await updateProfile(credential.user,{displayName:displayName.trim()});
        await sendEmailVerification(credential.user);
        addToast?.("Account created. Verification email sent.","success");
        setInfo("Verification email sent. Please verify before using account login.");
      }else{
        await signInWithEmailAndPassword(auth,email.trim(),password);
      }
    }catch(e){
      setError(e.message||"Authentication failed");
      addToast?.(e.message||"Authentication failed","error");
    }finally{
      setSubmitting(false);
    }
  };

  const handleForgotPassword=async()=>{
    if(!email.trim()){
      const msg="Enter your email first, then click reset password.";
      setError(msg);
      addToast?.(msg,"error");
      return;
    }
    setResetLoading(true);
    setError("");
    setInfo("");
    try{
      await sendPasswordResetEmail(auth,email.trim());
      const msg="Password reset email sent. Check your inbox/spam.";
      setInfo(msg);
      addToast?.(msg,"success");
    }catch(e){
      setError(e.message||"Could not send reset email");
      addToast?.(e.message||"Could not send reset email","error");
    }finally{
      setResetLoading(false);
    }
  };

  return(
    <div className="min-h-screen bg-screen flex flex-col items-center justify-center p-6 sm:p-8 relative overflow-hidden">
      <div className="grain-overlay"/>
      <div className="absolute w-[540px] h-[540px] rounded-full bg-amber-600/8 blur-3xl top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"/>
      <div className="relative z-10 w-full max-w-md flex flex-col gap-6">
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
            <Film size={30} className="text-amber-400"/>
          </div>
          <h1 className="font-display text-5xl text-zinc-100">Lumiere</h1>
          <p className="text-zinc-500 text-center text-sm leading-relaxed">
            Watch together, in perfect sync.<br/>
            Friends, memories, and private watch spaces.
          </p>
        </div>

        <div className="w-full bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 sm:p-6">
          <div className="grid grid-cols-2 gap-2 mb-4">
            <button onClick={()=>setMode("login")}
              className={`py-2 rounded-lg text-sm font-medium transition-colors ${mode==="login"?"bg-amber-300 text-zinc-950":"bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
              Login
            </button>
            <button onClick={()=>setMode("register")}
              className={`py-2 rounded-lg text-sm font-medium transition-colors ${mode==="register"?"bg-amber-300 text-zinc-950":"bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
              Register
            </button>
          </div>

          <form onSubmit={submitEmail} className="space-y-3">
            {mode==="register"&&(
              <input
                value={displayName}
                onChange={e=>setDisplayName(e.target.value)}
                placeholder="Display name"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
              />
            )}
            <input
              type="email"
              value={email}
              onChange={e=>setEmail(e.target.value)}
              placeholder="Email address"
              required
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
            />
            <input
              type="password"
              value={password}
              onChange={e=>setPassword(e.target.value)}
              placeholder="Password"
              required
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
            />
            {mode==="register"&&(
              <input
                type="password"
                value={confirmPassword}
                onChange={e=>setConfirmPassword(e.target.value)}
                placeholder="Confirm password"
                required
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
              />
            )}
            {error&&<p className="text-red-400 text-xs">{error}</p>}
            {info&&<p className="text-emerald-400 text-xs">{info}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-amber-300 hover:bg-amber-200 disabled:opacity-60 text-zinc-950 font-semibold py-2.5 rounded-lg transition-colors"
            >
              {submitting ? "Please wait..." : mode==="register" ? "Create account" : "Login"}
            </button>
            {mode==="login"&&(
              <button
                type="button"
                onClick={handleForgotPassword}
                disabled={resetLoading}
                className="w-full text-xs text-zinc-400 hover:text-amber-300 transition-colors"
              >
                {resetLoading?"Sending reset email...":"Forgot password? Send reset link"}
              </button>
            )}
          </form>

          <div className="my-4 flex items-center gap-2 text-zinc-600 text-xs">
            <div className="h-px flex-1 bg-zinc-800"/>
            <span>or</span>
            <div className="h-px flex-1 bg-zinc-800"/>
          </div>

          <button onClick={signInGoogle} disabled={googleLoading}
            className="w-full flex items-center justify-center gap-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-medium py-2.5 rounded-lg transition-colors disabled:opacity-60 border border-zinc-700">
            {googleLoading
              ?<span className="w-4 h-4 border-2 border-zinc-400/30 border-t-zinc-200 rounded-full animate-spin"/>
              :<><svg className="w-4 h-4" viewBox="0 0 24 24">
                <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>Continue with Google</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}

function VerifyEmailView({user,onRefresh,onResend,onSignOut,loading}){
  return(
    <div className="min-h-screen bg-screen flex flex-col items-center justify-center p-6 relative overflow-hidden">
      <div className="grain-overlay"/>
      <div className="relative z-10 w-full max-w-md bg-zinc-900/70 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Film size={20} className="text-amber-400"/>
          <h2 className="font-display text-2xl text-zinc-100">Verify your email</h2>
        </div>
        <p className="text-zinc-400 text-sm">
          We sent a verification link to <span className="text-zinc-200">{user?.email}</span>.
          Please verify your email before entering Lumiere.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            onClick={onResend}
            disabled={loading}
            className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 border border-zinc-700 text-zinc-100 font-medium py-2.5 rounded-lg text-sm transition-colors"
          >
            Resend verification
          </button>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="bg-amber-300 hover:bg-amber-200 disabled:opacity-60 text-zinc-950 font-semibold py-2.5 rounded-lg text-sm transition-colors"
          >
            I have verified
          </button>
        </div>
        <button
          onClick={onSignOut}
          disabled={loading}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

function RoomPendingView({label="Joining room...",onCancel}){
  return(
    <div className="min-h-screen bg-screen flex flex-col items-center justify-center p-6 relative overflow-hidden">
      <div className="grain-overlay"/>
      <div className="relative z-10 w-full max-w-md bg-zinc-900/70 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full border-2 border-zinc-700 border-t-amber-300 animate-spin"/>
          <div>
            <p className="text-zinc-200 font-semibold text-sm">{label}</p>
            <p className="text-zinc-500 text-xs">Hang tight, connecting to the room.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Cancel and return to lobby
        </button>
      </div>
    </div>
  );
}

function HeaderNotifications({
  friendRequests=[],
  invites=[],
  friendRequestBusyByUid={},
  onAcceptFriendRequest,
  onDeclineFriendRequest,
  onAcceptInvite,
  open:openProp,
  onOpenChange,
}){
  const [internalOpen,setInternalOpen]=useState(false);
  const panelRef=useRef(null);
  const isControlled=typeof openProp==="boolean";
  const open=isControlled?openProp:internalOpen;
  const setOpen=useCallback(next=>{
    const value=typeof next==="function"?next(open):next;
    if(!isControlled)setInternalOpen(value);
    onOpenChange?.(value);
  },[open,isControlled,onOpenChange]);
  const unreadCount=friendRequests.length+invites.length;

  useEffect(()=>{
    if(!open)return;
    const onPointer=e=>{
      if(panelRef.current&&!panelRef.current.contains(e.target)){
        setOpen(false);
      }
    };
    const onKey=e=>{if(e.key==="Escape")setOpen(false);};
    document.addEventListener("mousedown",onPointer);
    document.addEventListener("touchstart",onPointer);
    document.addEventListener("keydown",onKey);
    return()=>{
      document.removeEventListener("mousedown",onPointer);
      document.removeEventListener("touchstart",onPointer);
      document.removeEventListener("keydown",onKey);
    };
  },[open]);

  return(
    <div ref={panelRef} className="relative">
      <button
        type="button"
        onClick={()=>setOpen(v=>!v)}
        title="Notifications"
        className="relative inline-flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-800/80 border border-zinc-700 text-zinc-300 hover:text-zinc-100 transition-colors"
      >
        <Bell size={15}/>
        {unreadCount>0&&(
          <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-amber-400 text-zinc-950 text-[10px] font-bold flex items-center justify-center">
            {unreadCount>9?"9+":unreadCount}
          </span>
        )}
      </button>
      {open&&(
        <div className="fixed left-2 right-2 top-[4.4rem] sm:absolute sm:top-auto sm:left-auto sm:right-0 sm:mt-2 sm:w-80 rounded-xl border border-zinc-700 bg-zinc-900/95 backdrop-blur-xl shadow-2xl z-50 p-2">
          <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500">Notifications</div>
          <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
            {friendRequests.map(req=>(
              <div key={`fr-${req.uid}`} className="rounded-lg border border-zinc-700/60 bg-zinc-900/80 p-2">
                <p className="text-xs text-zinc-200">
                  <span className="font-semibold">@{req.username||"user"}</span> sent you a friend request
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={()=>onAcceptFriendRequest?.(req.uid)}
                    disabled={!!friendRequestBusyByUid[req.uid]}
                    className="px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-[11px] text-zinc-950 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={()=>onDeclineFriendRequest?.(req.uid)}
                    disabled={!!friendRequestBusyByUid[req.uid]}
                    className="px-2.5 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 text-[11px] text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
            {invites.map(invite=>(
              <div key={invite.id} className="rounded-lg border border-zinc-700/60 bg-zinc-900/80 p-2">
                <p className="text-xs text-zinc-200">
                  <span className="font-semibold">{invite.fromUsername?`@${invite.fromUsername}`:invite.fromName}</span> invited you
                </p>
                <p className="text-[11px] text-zinc-500 mt-0.5 font-mono">{invite.roomCode}</p>
                <button
                  type="button"
                  onClick={()=>onAcceptInvite?.(invite)}
                  className="mt-2 px-2.5 py-1.5 rounded-lg bg-amber-400 hover:bg-amber-300 text-[11px] text-zinc-950 font-semibold"
                >
                  Join room
                </button>
              </div>
            ))}
            {friendRequests.length===0&&invites.length===0&&(
              <p className="text-xs text-zinc-500 px-2 py-3">No new notifications</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

class RoomErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[room-error-boundary]", error, info);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    const message = this.state.error?.message || "Unknown room error";
    const stack = String(this.state.error?.stack || "").split("\n").slice(0, 8).join("\n");

    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="w-full max-w-3xl rounded-3xl border border-red-500/30 bg-zinc-900/90 p-6 shadow-2xl">
          <p className="text-xs uppercase tracking-[0.2em] text-red-300">Room crashed</p>
          <h2 className="mt-2 font-display text-2xl text-zinc-50">The room UI hit a runtime error.</h2>
          <p className="mt-3 text-sm text-zinc-300">{message}</p>
          {!!stack&&(
            <pre className="mt-4 overflow-x-auto rounded-2xl border border-zinc-800 bg-black/40 p-4 text-xs text-zinc-300 whitespace-pre-wrap">
              {stack}
            </pre>
          )}
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={()=>window.location.reload()}
              className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-amber-300"
            >
              Reload app
            </button>
            <button
              type="button"
              onClick={this.props.onReset}
              className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-500 hover:text-zinc-50"
            >
              Leave room
            </button>
          </div>
        </div>
      </div>
    );
  }
}

// ─── Lobby ────────────────────────────────────────────────────────────────────
function LobbyView({
  avatarUrl,
  username,
  onCreateRoom,
  onJoinRoom,
  onSignOut,
  savedRoomCode,
  onOpenDashboard,
  memoryStats={},
  invites=[],
  friendRequests=[],
  friendRequestBusyByUid={},
  onRespondFriendRequest,
  onAcceptInvite,
  socketConnected,
}){
  const [code,setCode]=useState(savedRoomCode||"");
  const [privateMode,setPrivateMode]=useState("couple");
  const [sessionMode,setSessionMode]=useState("watch");
  const [moodTag,setMoodTag]=useState("");
  const [resourceUrl,setResourceUrl]=useState("");
  const [youtubeVideoId,setYoutubeVideoId]=useState("");
  const [hoveredPrivateMode,setHoveredPrivateMode]=useState("couple");
  const [hoveredSessionMode,setHoveredSessionMode]=useState("watch");
  const selectedPrivateMode=PRIVATE_ROOM_MODES.find(m=>m.key===privateMode)||PRIVATE_ROOM_MODES[0];
  const selectedSessionMode=SESSION_MODES.find(m=>m.key===sessionMode)||SESSION_MODES[0];
  const selectedSessionEngine=getSessionEngine(sessionMode);
  const engineUi=selectedSessionEngine.ui||{};
  const hoveredPrivate=PRIVATE_ROOM_MODES.find(m=>m.key===hoveredPrivateMode)||selectedPrivateMode;
  const hoveredSession=SESSION_MODES.find(m=>m.key===hoveredSessionMode)||selectedSessionMode;

  const resourcePlaceholder = engineUi.resourcePlaceholder || "Optional resource URL";

  useEffect(()=>{
    if(sessionMode!=="watch"){
      setYoutubeVideoId("");
      return;
    }
    setYoutubeVideoId(extractYouTubeId(resourceUrl));
  },[resourceUrl,sessionMode]);

  const createRoom=()=>{
    const rawUrl=resourceUrl.trim();
    const resolved=selectedSessionEngine.resolveResourceFromUrl?.(rawUrl);
    const normalizedUrl=selectedSessionMode.key==="watch"
      ?(youtubeVideoId?`https://www.youtube.com/watch?v=${youtubeVideoId}`:"")
      :(resolved?.valid ? (resolved.normalizedUrl||rawUrl) : "");
    onCreateRoom?.({
      roomType:selectedPrivateMode.roomType,
      maxParticipants:selectedPrivateMode.maxParticipants,
      sessionMode:selectedSessionMode.key,
      moodTag,
      contentUrl:normalizedUrl,
      contentType:selectedSessionEngine.inferContentTypeFromUrl(normalizedUrl||rawUrl),
    });
  };

  return(
    <div className="min-h-screen bg-screen flex flex-col relative overflow-hidden">
      <div className="grain-overlay"/>
      <header className="relative z-10 flex items-center justify-between px-6 py-4 border-b border-zinc-800/60">
        <div className="flex items-center gap-2">
          <Film size={18} className="text-amber-400"/>
          <span className="font-display text-xl text-zinc-100">Lumiere</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={()=>onOpenDashboard?.("memories")}
            title="Memory Vault"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-800/80 border border-zinc-700 text-zinc-200 hover:text-amber-200 hover:border-amber-500/40 transition-colors text-xs"
          >
            <Library size={14}/>
            <span className="hidden sm:inline">Memory Vault</span>
          </button>
          <button onClick={()=>onOpenDashboard?.("profile")}
            title="Open settings"
            className="relative inline-flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-800/80 border border-zinc-700 text-zinc-300 hover:text-zinc-100 transition-colors"
          >
            <Menu size={15}/>
          </button>
          <HeaderNotifications
            friendRequests={friendRequests}
            invites={invites}
            friendRequestBusyByUid={friendRequestBusyByUid}
            onAcceptFriendRequest={uid=>onRespondFriendRequest?.(uid,"accept")}
            onDeclineFriendRequest={uid=>onRespondFriendRequest?.(uid,"reject")}
            onAcceptInvite={onAcceptInvite}
          />
          <span className={`hidden sm:inline text-xs px-2 py-1 rounded-full border ${socketConnected?"bg-green-950/50 text-green-400 border-green-800/50":"bg-red-950/50 text-red-400 border-red-800/50"}`}>
            {socketConnected?"Connected":"Connecting..."}
          </span>
          {avatarUrl&&<img src={avatarUrl} alt="" className="w-7 h-7 rounded-full border border-zinc-700"/>}
          <span className="text-zinc-400 text-sm font-mono">@{username}</span>
          <button onClick={onSignOut} className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-500 hover:text-zinc-300 transition-colors"><LogOut size={15}/></button>
        </div>
      </header>
      <main className="relative z-10 flex-1 flex items-center justify-center p-6 sm:p-8 lg:p-10">
        <div className="w-full max-w-5xl flex flex-col gap-6">
          <section className="flex flex-col gap-4 text-center max-w-3xl mx-auto w-full">
            <div className="text-center">
              <h2 className="font-display text-3xl text-zinc-100 mb-1">Shared Experience</h2>
              <p className="text-amber-300 text-sm font-medium">Where shared screen time becomes shared history.</p>
              <p className="text-zinc-500 text-xs mt-1">Turn moments into memories across watch, podcast, reading, and study sessions.</p>
            </div>
            <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/55 px-4 py-3 text-xs text-zinc-400">
              <p className="text-zinc-200 mb-1.5 font-medium">Lumiere memory pulse</p>
              <div className="space-y-1">
                <p>You've shared <span className="text-amber-300 font-semibold">{Number(memoryStats.sharedHoursMonth||0).toFixed(1)} hours</span> this month.</p>
                <p>Longest session: <span className="text-zinc-200 font-medium">{memoryStats.longestSessionLabel||"0m"}</span>.</p>
                <p>Streak: <span className="text-emerald-300 font-semibold">{memoryStats.streakDays||0} day{Number(memoryStats.streakDays||0)===1?"":"s"}</span>.</p>
              </div>
            </div>
            {savedRoomCode&&(
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex items-center justify-between">
                <div>
                  <p className="text-amber-300 text-sm font-medium">Resume where you left off</p>
                  <p className="text-amber-500/70 text-xs font-mono mt-0.5">{savedRoomCode}</p>
                </div>
                <button onClick={()=>onJoinRoom(savedRoomCode)}
                  className="bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold px-4 py-2 rounded-lg text-sm transition-colors">
                  Rejoin
                </button>
              </div>
            )}
            {invites.length>0&&(
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 flex flex-col gap-2">
                <p className="text-emerald-300 text-sm font-semibold">Live invites</p>
                {invites.map(invite=>(
                  <div key={invite.id} className="flex items-center justify-between gap-3 bg-zinc-900/70 border border-zinc-700 rounded-lg px-3 py-2">
                    <div>
                      <p className="text-zinc-200 text-sm">
                        {invite.fromUsername?`@${invite.fromUsername}`:invite.fromName} invited you
                      </p>
                      <p className="text-zinc-500 text-xs font-mono mt-0.5">{invite.roomCode}</p>
                    </div>
                    <button
                      onClick={()=>onAcceptInvite(invite)}
                      className="bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold px-3 py-1.5 rounded-lg text-xs transition-colors"
                    >
                      Join now
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6">
              <h3 className="text-zinc-300 font-semibold mb-1 flex items-center gap-2"><Lock size={15} className="text-amber-400"/>Create private room</h3>
              <p className="text-zinc-600 text-xs mb-4">Invite-only by code. Pick relationship mode, session type, and mood.</p>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">Relationship mode</p>
                  <div className="grid grid-cols-1 gap-2">
                    {PRIVATE_ROOM_MODES.map(option=>{
                      const Icon=option.icon;
                      const active=privateMode===option.key;
                      return(
                        <button
                          key={option.key}
                          type="button"
                          onMouseEnter={()=>setHoveredPrivateMode(option.key)}
                          onFocus={()=>setHoveredPrivateMode(option.key)}
                          onClick={()=>setPrivateMode(option.key)}
                          className={`rounded-xl border px-3 py-2 text-left transition-all duration-200 ${
                            active
                              ?"bg-amber-500/20 border-amber-500/45 text-amber-200 shadow-[0_0_0_1px_rgba(251,191,36,0.15)]"
                              :"bg-zinc-900/60 border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:-translate-y-0.5 hover:bg-zinc-900"
                          }`}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2 text-sm font-medium">
                              <Icon size={13} className={active?"scale-110 transition-transform duration-200":""}/>
                              {option.label}
                            </span>
                            <span className="text-[10px] px-2 py-0.5 rounded-full border border-zinc-600 text-zinc-400">
                              {option.maxParticipants} cap
                            </span>
                          </span>
                          <span className="block text-[11px] mt-0.5 opacity-80">{option.blurb}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-zinc-600">{hoveredPrivate.hoverHint}</p>
                </div>

                <div className="space-y-2">
                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">Session mode</p>
                  <div className="grid grid-cols-2 gap-2">
                    {SESSION_MODES.map(option=>{
                      const Icon=option.icon;
                      const active=sessionMode===option.key;
                      return(
                        <button
                          key={option.key}
                          type="button"
                          onMouseEnter={()=>setHoveredSessionMode(option.key)}
                          onFocus={()=>setHoveredSessionMode(option.key)}
                          onClick={()=>setSessionMode(option.key)}
                          className={`rounded-xl border px-3 py-2 text-left transition-all duration-200 ${
                            active
                              ?"bg-emerald-500/15 border-emerald-500/45 text-emerald-200 shadow-[0_0_0_1px_rgba(16,185,129,0.2)]"
                              :"bg-zinc-900/60 border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:-translate-y-0.5 hover:bg-zinc-900"
                          }`}
                        >
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            <Icon size={12} className={active?"scale-110 transition-transform duration-200":""}/>
                            {option.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-zinc-600">{hoveredSession.hoverHint||selectedSessionMode.blurb}</p>
                </div>
              </div>

              <div className="space-y-2 mb-4 mt-4">
                <p className="text-[11px] uppercase tracking-wide text-zinc-500">Mood (optional)</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                  {ROOM_MOOD_OPTIONS.map(option=>(
                    <button
                      key={option.key||"none"}
                      type="button"
                      onClick={()=>setMoodTag(option.key)}
                      className={`rounded-lg border px-2 py-1.5 text-[11px] transition-colors ${
                        moodTag===option.key
                          ?"border-amber-500/45 bg-amber-500/15 text-amber-200"
                          :"border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2 mb-4">
                <p className="text-[11px] uppercase tracking-wide text-zinc-500">Resource link (optional)</p>
                <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/60 px-3">
                  {sessionMode==="reading"?<FileText size={13} className="text-zinc-500 shrink-0"/>:<Link2 size={13} className="text-zinc-500 shrink-0"/>}
                  <input
                    value={resourceUrl}
                    onChange={e=>setResourceUrl(e.target.value)}
                    placeholder={resourcePlaceholder}
                    className="flex-1 bg-transparent py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none"
                  />
                </div>
                <p className="text-[11px] text-zinc-600">
                  {engineUi.resourceHelp || "Paste a link and Lumiere will track it for shared memories."}
                </p>
              </div>

              <div className="mb-4 text-[11px] text-zinc-500 bg-zinc-900/70 border border-zinc-700/60 rounded-lg px-3 py-2">
                <span className="text-zinc-300 font-medium">{selectedPrivateMode.label}</span>
                {" · "}
                <span className="text-zinc-300 font-medium">{selectedSessionMode.label}</span>
                {moodTag?(
                  <>
                    {" · "}
                    <span className="text-amber-300">{moodTag}</span>
                  </>
                ):null}
                {" · "}
                <span>{selectedPrivateMode.maxParticipants} participant cap</span>
              </div>

              <button onClick={createRoom}
                className="w-full flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold py-2.5 rounded-xl transition-colors">
                Create Private Room <ChevronRight size={16}/>
              </button>
            </div>
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6">
              <h3 className="text-zinc-300 font-semibold mb-1 flex items-center gap-2"><Users size={15} className="text-amber-400"/>Join a room</h3>
              <p className="text-zinc-600 text-xs mb-4">Enter the 6-letter code from your friend.</p>
              <div className="flex gap-2">
                <input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="ROOM CODE"
                  maxLength={8} onKeyDown={e=>e.key==="Enter"&&code.trim()&&onJoinRoom(normalizeCode(code))}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2.5 text-zinc-100
                    placeholder-zinc-600 font-mono text-sm tracking-widest focus:outline-none focus:border-amber-500/60 transition-colors"/>
                <button onClick={()=>code.trim()&&onJoinRoom(normalizeCode(code))} disabled={!code.trim()}
                  className="px-4 py-2.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 rounded-xl disabled:opacity-40 transition-colors font-medium text-sm">
                  Join
                </button>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

// ─── WebRTC Hook ──────────────────────────────────────────────────────────────
function useWebRTC({socket,roomCode,myUid,users,addToast}){
  const [inCall,setInCall]=useState(false);
  const [micOn,setMicOn]=useState(true);
  const [camOn,setCamOn]=useState(false);
  const localStreamRef=useRef(null);
  const peerConnsRef=useRef({});
  const remoteStreamsRef=useRef({});
  const [remoteStreams,setRemoteStreams]=useState({});
  const refresh=useCallback(()=>setRemoteStreams({...remoteStreamsRef.current}),[]);
  const isMountedRef=useRef(true);

  useEffect(()=>()=>{isMountedRef.current=false;},[]);

  const shouldInitiateForUid=useCallback((targetUid)=>{
    // Deterministic offer ownership avoids "glare", where both peers create
    // offers at the same time after joining the same call.
    return String(myUid||"")>String(targetUid||"");
  },[myUid]);

  const createPeer=useCallback((targetUid,isInitiator,{replace=false}={})=>{
    const existing=peerConnsRef.current[targetUid];
    const existingUsable=existing&&!["closed","failed","disconnected"].includes(existing.connectionState);
    if(existingUsable&&!replace)return existing;
    if(existing)existing.close();

    // Each peer connection is keyed by remote uid so reconnection/replacement
    // can surgically swap one broken link without resetting the whole call.
    const pc=new RTCPeerConnection(ICE_CONFIG);
    localStreamRef.current?.getTracks().forEach(t=>pc.addTrack(t,localStreamRef.current));
    pc.ontrack=e=>{remoteStreamsRef.current[targetUid]=e.streams[0];refresh();};
    pc.onicecandidate=e=>{if(e.candidate)socket.emit("webrtc_ice_candidate",{roomCode,candidate:e.candidate,targetUid});};
    pc.onconnectionstatechange=()=>{
      if(["disconnected","failed","closed"].includes(pc.connectionState)){
        delete remoteStreamsRef.current[targetUid];refresh();
      }
    };
    peerConnsRef.current[targetUid]=pc;
    if(isInitiator){
      pc.createOffer().then(o=>{pc.setLocalDescription(o);socket.emit("webrtc_offer",{roomCode,offer:o,targetUid});}).catch(console.error);
    }
    return pc;
  },[socket,roomCode,refresh]);

  const joinCall=useCallback(async(withVideo=true)=>{
    // getUserMedia requires HTTPS (or localhost) — give clear guidance on mobile
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
      addToast("Video calls need HTTPS. On mobile, use https:// or the desktop for now.","error");
      return;
    }
    try{
      // Try video first, fall back to audio-only if camera fails
      let stream;
      try{
        stream=await navigator.mediaDevices.getUserMedia({audio:true,video:withVideo});
      }catch(videoErr){
        if(withVideo){
          addToast("Camera unavailable, joining with audio only","info");
          stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
          withVideo=false;
        }else throw videoErr;
      }
      if(!isMountedRef.current){
        stream?.getTracks().forEach(t=>t.stop());
        return;
      }
      // Once local media exists, proactively create offers only for the uids
      // this client "owns" according to shouldInitiateForUid().
      localStreamRef.current=stream;setCamOn(withVideo);setMicOn(true);setInCall(true);
      socket.emit("call_joined",{roomCode});
      users.forEach(u=>{
        if(u.uid!==myUid&&shouldInitiateForUid(u.uid)){
          createPeer(u.uid,true);
        }
      });
    }catch(err){
      if(err.name==="NotAllowedError"){
        addToast("Permission denied — allow mic/camera in browser settings","error");
      }else if(err.name==="NotFoundError"){
        addToast("No microphone found on this device","error");
      }else{
        addToast("Call error: "+err.message+". Needs HTTPS on mobile.","error");
      }
    }
  },[socket,roomCode,users,myUid,createPeer,addToast,shouldInitiateForUid]);

  const leaveCall=useCallback(()=>{
    const hadActiveCall=!!localStreamRef.current||Object.keys(peerConnsRef.current).length>0||inCall;
    localStreamRef.current?.getTracks().forEach(t=>t.stop());
    localStreamRef.current=null;
    Object.values(peerConnsRef.current).forEach(pc=>pc.close());
    peerConnsRef.current={};remoteStreamsRef.current={};
    setRemoteStreams({});setInCall(false);
    if(hadActiveCall)socket.emit("call_left",{roomCode});
  },[socket,roomCode,inCall]);

  const toggleMic=useCallback(()=>{const t=localStreamRef.current?.getAudioTracks()[0];if(t){t.enabled=!t.enabled;setMicOn(t.enabled);}},[]);
  const toggleCam=useCallback(()=>{const t=localStreamRef.current?.getVideoTracks()[0];if(t){t.enabled=!t.enabled;setCamOn(t.enabled);}},[]);

  useEffect(()=>{
    if(!socket)return;
    const onOffer=async({offer,fromUid})=>{
      if(!inCall)return;
      const existing=peerConnsRef.current[fromUid];
      const isGlare=existing&&existing.signalingState!=="stable";
      // On simultaneous renegotiation, one side backs off deterministically and
      // lets the higher-priority initiator keep the active offer.
      if(isGlare&&shouldInitiateForUid(fromUid)){
        return;
      }
      const pc=createPeer(fromUid,false,{replace:isGlare});
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const ans=await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit("webrtc_answer",{roomCode,answer:ans,targetUid:fromUid});
    };
    const onAnswer=async({answer,fromUid})=>{const pc=peerConnsRef.current[fromUid];if(pc)await pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(()=>{});};
    const onIce=async({candidate,fromUid})=>{const pc=peerConnsRef.current[fromUid];if(pc&&candidate)await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(()=>{});};
    const onPeerJoined=({uid:pUid,name:pName})=>{
      addToast(`${pName||"Friend"} joined the call`,"info");
      if(inCall&&shouldInitiateForUid(pUid)){
        createPeer(pUid,true);
      }
    };
    const onPeerLeft=({uid:pUid})=>{peerConnsRef.current[pUid]?.close();delete peerConnsRef.current[pUid];delete remoteStreamsRef.current[pUid];refresh();};
    socket.on("webrtc_offer",onOffer);socket.on("webrtc_answer",onAnswer);
    socket.on("webrtc_ice_candidate",onIce);socket.on("peer_joined_call",onPeerJoined);socket.on("peer_left_call",onPeerLeft);
    return()=>{socket.off("webrtc_offer",onOffer);socket.off("webrtc_answer",onAnswer);socket.off("webrtc_ice_candidate",onIce);socket.off("peer_joined_call",onPeerJoined);socket.off("peer_left_call",onPeerLeft);};
  },[socket,inCall,createPeer,roomCode,addToast,refresh,shouldInitiateForUid]);

  useEffect(()=>()=>{leaveCall();},[leaveCall]);
  return{inCall,micOn,camOn,localStreamRef,remoteStreams,joinCall,leaveCall,toggleMic,toggleCam};
}

// ─── Video Tile ───────────────────────────────────────────────────────────────
function VideoTile({stream,name,muted=false}){
  const ref=useRef(null);
  useEffect(()=>{if(ref.current&&stream)ref.current.srcObject=stream;},[stream]);
  return(
    <div className="relative bg-zinc-900 rounded-xl overflow-hidden w-full h-full flex items-center justify-center border border-zinc-700/50">
      {stream
        ?<video ref={ref} autoPlay playsInline muted={muted} className="w-full h-full object-cover"/>
        :<div className="flex flex-col items-center gap-1">
          <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
            <span className="text-amber-400 font-bold">{name?.[0]?.toUpperCase()}</span>
          </div>
          <span className="text-zinc-500 text-xs">{name}</span>
        </div>
      }
      <span className="absolute bottom-1.5 left-2 text-xs text-white/80 bg-black/50 px-2 py-0.5 rounded-full">{name}{muted?" (you)":""}</span>
    </div>
  );
}

// ─── Draggable Call Window ────────────────────────────────────────────────────
function DraggableCallWindow({inCall,micOn,camOn,localStreamRef,remoteStreams,users,myUid,myName,onLeave,onToggleMic,onToggleCam,containerRef}){
  const winRef=useRef(null);
  const dragRef=useRef(null);
  const resizeRef=useRef(null);
  const prevLayoutRef=useRef(null);
  const [pos,setPos]=useState({x:16,y:64});
  const [size,setSize]=useState({w:300,h:220});
  const [minimized,setMinimized]=useState(false);
  const [maximized,setMaximized]=useState(false);

  const onDragStart=e=>{
    if(e.target.closest(".call-btn"))return;
    e.preventDefault();
    const cx=e.touches?e.touches[0].clientX:e.clientX;
    const cy=e.touches?e.touches[0].clientY:e.clientY;
    const rect=containerRef.current?.getBoundingClientRect()||{left:0,top:0};
    dragRef.current={ox:cx-rect.left-pos.x,oy:cy-rect.top-pos.y};
  };
  useEffect(()=>{
    const onMove=e=>{
      if(!dragRef.current)return;
      const cx=e.touches?e.touches[0].clientX:e.clientX;
      const cy=e.touches?e.touches[0].clientY:e.clientY;
      const rect=containerRef.current?.getBoundingClientRect()||{left:0,top:0,width:window.innerWidth,height:window.innerHeight};
      setPos({x:Math.max(0,Math.min(cx-rect.left-dragRef.current.ox,rect.width-size.w)),y:Math.max(0,Math.min(cy-rect.top-dragRef.current.oy,rect.height-60))});
    };
    const onUp=()=>{dragRef.current=null;};
    window.addEventListener("mousemove",onMove);window.addEventListener("mouseup",onUp);
    window.addEventListener("touchmove",onMove,{passive:true});window.addEventListener("touchend",onUp);
    return()=>{window.removeEventListener("mousemove",onMove);window.removeEventListener("mouseup",onUp);window.removeEventListener("touchmove",onMove);window.removeEventListener("touchend",onUp);};
  },[size.w,containerRef]);

  useEffect(()=>{
    const clamp=()=>{
      const rect=containerRef.current?.getBoundingClientRect();
      if(!rect)return;
      setPos(prev=>({
        x:Math.max(0,Math.min(prev.x,rect.width-(minimized?200:size.w))),
        y:Math.max(0,Math.min(prev.y,rect.height-60)),
      }));
    };
    clamp();
    window.addEventListener("resize",clamp);
    return()=>window.removeEventListener("resize",clamp);
  },[size.w,size.h,minimized,containerRef]);

  const onResizeStart=e=>{
    e.preventDefault();e.stopPropagation();
    const cx=e.touches?e.touches[0].clientX:e.clientX;
    const cy=e.touches?e.touches[0].clientY:e.clientY;
    resizeRef.current={sx:cx,sy:cy,sw:size.w,sh:size.h};
  };
  useEffect(()=>{
    const onMove=e=>{
      if(!resizeRef.current)return;
      const cx=e.touches?e.touches[0].clientX:e.clientX;
      const cy=e.touches?e.touches[0].clientY:e.clientY;
      setSize({w:Math.max(220,resizeRef.current.sw+(cx-resizeRef.current.sx)),h:Math.max(160,resizeRef.current.sh+(cy-resizeRef.current.sy))});
    };
    const onUp=()=>{resizeRef.current=null;};
    window.addEventListener("mousemove",onMove);window.addEventListener("mouseup",onUp);
    window.addEventListener("touchmove",onMove,{passive:true});window.addEventListener("touchend",onUp);
    return()=>{window.removeEventListener("mousemove",onMove);window.removeEventListener("mouseup",onUp);window.removeEventListener("touchmove",onMove);window.removeEventListener("touchend",onUp);};
  },[]);

  const remoteEntries=Object.entries(remoteStreams);
  const totalTiles=1+remoteEntries.length;
  const cols=totalTiles<=1?1:totalTiles<=4?2:3;
  const toggleMaximize=()=>{
    const rect=containerRef.current?.getBoundingClientRect();
    if(!rect)return;
    if(!maximized){
      prevLayoutRef.current={pos,size};
      const nextW=Math.max(280,Math.min(rect.width-32,640));
      const nextH=Math.max(200,Math.min(rect.height-120,420));
      setSize({w:nextW,h:nextH});
      setPos({x:Math.max(0,rect.width-nextW-16),y:Math.max(0,rect.height-nextH-16)});
      setMinimized(false);
      setMaximized(true);
      return;
    }
    const prev=prevLayoutRef.current;
    if(prev){
      setPos(prev.pos);
      setSize(prev.size);
    }
    setMaximized(false);
  };

  return(
    <div ref={winRef} style={{left:pos.x,top:pos.y,width:minimized?200:size.w,zIndex:500}}
      className="absolute rounded-2xl overflow-hidden shadow-2xl border border-zinc-700/60 bg-zinc-900 select-none">
      <div onMouseDown={onDragStart} onTouchStart={onDragStart}
        className="flex items-center justify-between px-3 py-2 bg-zinc-800/90 cursor-grab active:cursor-grabbing border-b border-zinc-700/40">
        <div className="flex items-center gap-2">
          <GripHorizontal size={13} className="text-zinc-500"/>
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"/>
          <span className="text-zinc-300 text-xs font-medium">Live Call</span>
          <span className="text-zinc-600 text-xs">{totalTiles}p</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={toggleMaximize}
            className="call-btn w-6 h-6 rounded-full bg-zinc-700 hover:bg-zinc-600 flex items-center justify-center text-zinc-300 text-[10px] transition-colors">
            {maximized?<Minimize size={12}/>:<Maximize size={12}/>}
          </button>
          <button onClick={()=>setMinimized(m=>!m)}
            className="call-btn w-5 h-5 rounded-full bg-zinc-700 hover:bg-zinc-600 flex items-center justify-center text-zinc-400 text-[10px] transition-colors">
            {minimized?"▲":"▼"}
          </button>
        </div>
      </div>
      {!minimized&&(
        <div style={{height:size.h,gridTemplateColumns:`repeat(${cols},1fr)`}} className="grid gap-1 p-1 bg-zinc-950">
          <VideoTile stream={localStreamRef.current} name={myName} muted/>
          {remoteEntries.map(([uid,stream])=>{
            const u=users.find(x=>x.uid===uid);
            return<VideoTile key={uid} stream={stream} name={u?.name?.split(" ")[0]||"Friend"}/>;
          })}
          {remoteEntries.length===0&&(
            <div className="flex items-center justify-center bg-zinc-900 rounded-xl">
              <span className="text-zinc-600 text-xs text-center px-3">Waiting for others<br/>to join…</span>
            </div>
          )}
        </div>
      )}
      <div className="call-btn flex items-center justify-center gap-2 px-3 py-2 bg-zinc-800/90">
        <button onClick={onToggleMic}
          className={`call-btn w-9 h-9 rounded-full flex items-center justify-center transition-colors
            ${micOn?"bg-zinc-700 hover:bg-zinc-600 text-zinc-300":"bg-red-600 hover:bg-red-500 text-white"}`}>
          {micOn?<Mic size={15}/>:<MicOff size={15}/>}
        </button>
        <button onClick={onToggleCam}
          className={`call-btn w-9 h-9 rounded-full flex items-center justify-center transition-colors
            ${camOn?"bg-blue-600 hover:bg-blue-500 text-white":"bg-zinc-700 hover:bg-zinc-600 text-zinc-400"}`}>
          {camOn?<Video size={15}/>:<VideoOff size={15}/>}
        </button>
        <button onClick={onLeave}
          className="call-btn w-9 h-9 rounded-full bg-red-600 hover:bg-red-500 flex items-center justify-center text-white transition-colors">
          <PhoneOff size={15}/>
        </button>
      </div>
      {!minimized&&(
        <div onMouseDown={onResizeStart} onTouchStart={onResizeStart}
          className="absolute bottom-0 right-0 w-6 h-6 cursor-se-resize flex items-end justify-end p-1">
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-zinc-600">
            <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
      )}
    </div>
  );
}

// ─── Sync Indicator (header badge) ───────────────────────────────────────────
function SyncIndicator({memberTimes,myUid,videoLoaded}){
  if(!videoLoaded||Object.keys(memberTimes).length<2)return null;

  const times=Object.values(memberTimes);
  const maxTime=Math.max(...times.map(t=>t.time));
  const minTime=Math.min(...times.map(t=>t.time));
  const gap=maxTime-minTime;
  const inSync=gap<2;

  return(
    <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border
      ${inSync?"bg-green-950/40 text-green-400 border-green-800/40":"bg-red-950/40 text-red-400 border-red-800/50"}`}>
      <Clock size={10}/>
      <span className="font-mono">
        {inSync
          ? "In sync"
          : `${gap.toFixed(0)}s gap`
        }
      </span>
      {!inSync&&(
        <span className="hidden sm:inline text-[10px] opacity-70">
          · {Object.values(memberTimes).map(t=>`@${t.username} ${fmt(t.time)}`).join(" / ")}
        </span>
      )}
    </div>
  );
}

// ─── Emoji Picker Portal ──────────────────────────────────────────────────────
// Renders at fixed viewport position — never clipped by any parent overflow
function EmojiPickerPortal({pos,onReact,onClose,messageId}){
  const ref=useRef(null);
  const [showFull,setShowFull]=useState(false);
  // Close on outside click
  useEffect(()=>{
    const handler=e=>{if(ref.current&&!ref.current.contains(e.target))onClose();};
    // small delay so the open-click doesn't immediately close
    const t=setTimeout(()=>{
      document.addEventListener("mousedown",handler);
      document.addEventListener("touchstart",handler);
    },50);
    return()=>{
      clearTimeout(t);
      document.removeEventListener("mousedown",handler);
      document.removeEventListener("touchstart",handler);
    };
  },[onClose]);

  const handlePick=emoji=>{
    if(!emoji)return;
    const native=emoji?.native||emoji?.emoji||emoji;
    if(!native)return;
    onReact(messageId,native);
    onClose();
  };

  if(typeof document==="undefined")return null;
  return createPortal(
    <div
      ref={ref}
      style={{position:"fixed",top:pos.top,left:pos.left,zIndex:99999,pointerEvents:"all"}}
      className="flex flex-col items-start gap-2"
    >
      <div className="flex items-center gap-1 bg-zinc-900/95 border border-zinc-700/80 rounded-full px-2 py-1 shadow-2xl">
        {QUICK_EMOJIS.map(e=>(
          <button key={e}
            onClick={()=>handlePick(e)}
            className="w-9 h-9 text-xl flex items-center justify-center rounded-full hover:bg-zinc-800 active:scale-90 transition-all">
            {e}
          </button>
        ))}
        <button
          onClick={()=>setShowFull(v=>!v)}
          className="w-9 h-9 text-lg flex items-center justify-center rounded-full hover:bg-zinc-800 text-zinc-200 border border-zinc-700/70"
          title="More reactions"
        >
          +
        </button>
      </div>
      {showFull&&(
        <div className="bg-zinc-900/95 border border-zinc-700/80 rounded-2xl p-2 shadow-2xl">
          <Picker
            data={data}
            theme="dark"
            onEmojiSelect={handlePick}
            previewPosition="none"
            searchPosition="top"
            navPosition="bottom"
            skinTonePosition="none"
            perLine={9}
            maxFrequentRows={1}
            set="native"
          />
        </div>
      )}
    </div>,
    document.body
  );
}

// ─── Chat Message ─────────────────────────────────────────────────────────────
function ChatMessage({msg,myUid,onReact,onBookmarkSeek,closePickerSignal}){
  const [showPicker,setShowPicker]=useState(false);
  const [pickerPos,setPickerPos]=useState({top:0,left:0});
  const bubbleRef=useRef(null);
  const isMe=msg.uid===myUid;
  const isBookmark=msg.type==="bookmark";
  const isSystem=msg.type==="system";
  const canReact=!isSystem&&!isBookmark;
  const reactions=Object.entries(msg.reactions||{}).filter(([,uids])=>uids.length>0);
  const senderLabel=msg.senderUsername||msg.senderName||"user";
  const avatarInitial=(msg.senderName||msg.senderUsername||"U").trim()[0]?.toUpperCase()||"U";
  const avatarEl=msg.photoURL
    ?<img src={msg.photoURL} alt={senderLabel} className="w-7 h-7 rounded-full border border-zinc-700 object-cover"/>
    :<div className="w-7 h-7 rounded-full bg-amber-500/20 border border-zinc-700 flex items-center justify-center text-[11px] text-amber-300 font-semibold">
      {avatarInitial}
    </div>;

  useEffect(()=>{
    if(showPicker)setShowPicker(false);
  },[closePickerSignal]);

  if(isSystem){
    const variant = msg.meta?.variant;
    const variantClass =
      variant === "offline"
        ? "bg-red-950/60 border-red-800/50 text-red-400"
        : variant === "waiting"
          ? "bg-amber-950/60 border-amber-800/50 text-amber-300"
          : "bg-green-950/60 border-green-800/50 text-green-400";
    return(
      <div className="flex items-center gap-2 my-1">
        <div className="flex-1 h-px bg-zinc-800"/>
        <span className={`text-xs px-3 py-1 rounded-full border whitespace-nowrap ${variantClass}`}>
          {msg.text}
        </span>
        <div className="flex-1 h-px bg-zinc-800"/>
      </div>
    );
  }

  const openPicker=e=>{
    e.stopPropagation();
    // Calculate position from the bubble, not the button, for consistent placement
    if(bubbleRef.current){
      const r=bubbleRef.current.getBoundingClientRect();
      const pickerWidth=340;
      const pickerHeight=380;
      const spaceBelow=window.innerHeight-r.bottom;
      const prefersBelow=spaceBelow>pickerHeight;
      const top=prefersBelow
        ?Math.min(window.innerHeight-pickerHeight-8,Math.max(8,r.bottom+8))
        :Math.max(8,r.top-pickerHeight-8);
      const preferredLeft=isMe?r.right-pickerWidth:r.left;
      setPickerPos({
        top,
        left:Math.max(8,Math.min(preferredLeft,window.innerWidth-pickerWidth-8)),
      });
    }
    setShowPicker(s=>!s);
  };

  return(
    <>
      <div
        ref={bubbleRef}
        className={`group flex items-end gap-2 ${isMe?"justify-end":"justify-start"}`}
      >
        {!isMe&&avatarEl}
        <div className={`flex flex-col ${isMe?"items-end":"items-start"}`}>
          {/* Sender username — always show for others */}
          {!isMe&&(
            <span className="text-zinc-500 text-xs mb-0.5 ml-1 font-mono">
              @{senderLabel}
            </span>
          )}

          <div className="flex items-center gap-1.5">
            {/* React button left of others' bubbles */}
            {!isMe&&canReact&&(
              <button onClick={openPicker}
                className="text-lg leading-none p-1.5 rounded-lg hover:bg-zinc-800 shrink-0 transition-colors">
                😊
              </button>
            )}

            {/* Message bubble */}
            <div
              onClick={isBookmark?()=>onBookmarkSeek(msg.meta?.seekTime):undefined}
              className={`px-3 py-2 rounded-xl text-sm max-w-[85%] break-words leading-relaxed
                ${isBookmark
                  ?"bg-amber-500/15 border border-amber-500/30 text-amber-300 cursor-pointer hover:bg-amber-500/25 transition-colors"
                  :isMe
                    ?"bg-amber-500/20 text-amber-100 rounded-br-sm"
                    :"bg-zinc-800 text-zinc-300 rounded-bl-sm"}`}>
              {isBookmark&&<span className="mr-1">📍</span>}
              {msg.text}
              {isBookmark&&<span className="text-amber-500/50 text-[10px] ml-1.5">↩ seek all</span>}
            </div>

            {/* React button right of my bubbles */}
            {isMe&&canReact&&(
              <button onClick={openPicker}
                className="text-lg leading-none p-1.5 rounded-lg hover:bg-zinc-800 shrink-0 transition-colors">
                😊
              </button>
            )}
          </div>

          {/* Reaction pills — shown below bubble */}
          {canReact&&reactions.length>0&&(
            <div className={`flex flex-wrap items-center gap-1 mt-1 ${isMe?"mr-8":"ml-8"}`}>
              {reactions.map(([emoji,uids])=>(
                <button key={emoji} onClick={()=>onReact(msg.id,emoji)}
                  className={`flex items-center gap-0.5 text-xs px-2 py-0.5 rounded-full border transition-all active:scale-95
                    ${uids.includes(myUid)
                      ?"bg-amber-500/20 border-amber-500/40 text-amber-300"
                      :"bg-zinc-800/80 border-zinc-700 text-zinc-400 hover:border-zinc-500"}`}>
                  <span>{emoji}</span>
                  <span className="font-medium">{uids.length}</span>
                </button>
              ))}
            </div>
          )}

          <span className="text-zinc-700 text-[10px] mt-0.5">
            {new Date(msg.timestamp).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
          </span>
        </div>
        {isMe&&avatarEl}
      </div>

      {/* Picker rendered outside scroll container via portal-style positioning */}
      {showPicker&&(
        <EmojiPickerPortal
          pos={pickerPos}
          messageId={msg.id}
          onReact={onReact}
          onClose={()=>setShowPicker(false)}
        />
      )}
    </>
  );
}

// ─── Room View ────────────────────────────────────────────────────────────────
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
  friendRequests=[],
  friendRequestBusyByUid={},
  invites=[],
  onAcceptInvite,
}){
  // RoomView is the realtime playback shell: transport refs, room members,
  // chat state, reading state, and the currently active media engine all meet here.
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
  const [friendBusyByUid,setFriendBusyByUid]=useState({});
  const [friendStatusByUid,setFriendStatusByUid]=useState({});
  const [docUploading,setDocUploading]=useState(false);
  const [closePickerSignal,setClosePickerSignal]=useState(0);
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

  const showBanner=useCallback(text=>{setActionBanner(text);setTimeout(()=>setActionBanner(""),3000);},[]);
  const getActiveHtmlMedia=useCallback(()=>isMusicMode?audioRef.current:videoRef.current,[isMusicMode]);
  const clearScheduledVideoStart=useCallback(()=>{
    if(videoScheduleTimeoutRef.current){
      clearTimeout(videoScheduleTimeoutRef.current);
      videoScheduleTimeoutRef.current=null;
    }
  },[]);
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

  const {inCall,micOn,camOn,localStreamRef,remoteStreams,joinCall,leaveCall,toggleMic,toggleCam}=
    useWebRTC({socket,roomCode,myUid:user.uid,users,addToast});
  const otherUsers=users.filter(u=>u.uid!==user.uid);
  const hostUid=roomCreatedBy||"";
  const hostUser=users.find(u=>u.uid===hostUid);
  const isHost=!hostUid||user.uid===hostUid;
  const canChangeSource=!isReadingMode||isHost;
  const showReadingFrame=isReadingMode&&!!sharedDocument?.fileUrl;
  const showMusicStage=isMusicMode&&!showReadingFrame;
  const showCompanionLink=!isMusicMode&&!videoLoaded&&!!resourceUrl&&!showReadingFrame&&!useYouTubePlayer;
  const showGenericLoadState=!videoLoaded&&!showReadingFrame&&!useYouTubePlayer&&!isMusicMode;
  const showBottomTransport=!isReadingMode&&!hideNativeYouTubeFooter&&!isMusicMode;
  const canOpenExternalResource=isHttpUrl(sharedDocument?.fileUrl||resourceUrl);
  const openSourcePanel=useCallback(()=>{
    if(!canChangeSource){
      addToast("Only the host can change the document in co-reading","error");
      return;
    }
    setResourceInput(resourceUrl||"");
    setShowSourcePanel(true);
  },[canChangeSource,addToast,resourceUrl]);

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

  useEffect(()=>{
    if(otherUsers.length===0){
      setShowFriendMenu(false);
    }
  },[otherUsers.length]);

  useEffect(()=>{
    if(isReadingMode){
      setShowChat(false);
      return;
    }
    setShowChat(true);
  },[isReadingMode]);

  useEffect(()=>{
    sharedDocumentRef.current=sharedDocument;
  },[sharedDocument]);

  useEffect(()=>{
    const nextPage=Math.max(1, Math.floor(Number(initialReadingState?.page ?? initialReadingPage) || 1));
    // Whenever the room snapshot changes, re-seed the local reading controls
    // from the host-provided document and page state.
    setReadingPage(nextPage);
    setReadingPageInput(String(nextPage));
    setReadingTotalPages(Math.max(0, Math.floor(Number(initialReadingState?.totalPages ?? initialDocument?.totalPages) || 0)));
    setSharedDocument(initialDocument||null);
  },[initialDocument,initialReadingPage,initialReadingState]);

  useEffect(()=>{
    audioSyncStateRef.current=initialAudioState||null;
    pendingAudioSyncRef.current=initialAudioState||null;
  },[initialAudioState]);

  useEffect(()=>{
    const nextSignature=String(initialVideoMetadata?.fileFingerprint||"");
    requiredAudioSignatureRef.current=nextSignature;
    if(isMusicMode&&!resourceUrl&&nextSignature){
      setAudioLoadWarning(`Load the matching local audio file to join this room (${nextSignature}).`);
    }else{
      setAudioLoadWarning("");
    }
  },[initialVideoMetadata?.fileFingerprint,isMusicMode,resourceUrl]);

  useEffect(()=>{
    const nextUrl=roomContentUrl||initialVideoMetadata?.contentUrl||"";
    setResourceUrl(nextUrl);
    setResourceInput(nextUrl||"");
    const nextType=roomContentType||initialVideoMetadata?.sourceType||"unknown";
    setResourceType(nextType);
  },[roomContentUrl,roomContentType,initialVideoMetadata]);

  useEffect(()=>{
    setYoutubeVideoId(extractYouTubeId(resourceUrl));
  },[resourceUrl]);

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

  useEffect(()=>{
    if(!useYouTubePlayer){
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
      return;
    }

    let cancelled=false;
    setVideoLoaded(false);
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
            onError:()=>{
              addToast("YouTube player failed to load","error");
            },
          },
        });
      })
      .catch(error=>{
        if(cancelled)return;
        addToast(error.message||"Could not initialize YouTube player","error");
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
  },[useYouTubePlayer,youtubeVideoId,initialAudioState,initialVideoState,addToast,clearScheduledVideoStart,isMusicMode,roomCode,socket]);

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

  useEffect(()=>{chatEndRef.current?.scrollIntoView({behavior:"smooth"});},[messages]);

  useEffect(()=>{
    const h=()=>setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange",h);
    return()=>document.removeEventListener("fullscreenchange",h);
  },[]);

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
  useEffect(()=>{applyAudioSyncRef.current=applyAudioSync;},[applyAudioSync]);

  useEffect(()=>{
    if(!isMusicMode||!videoLoaded||!pendingAudioSyncRef.current)return;
    applyAudioSyncRef.current({audioState:pendingAudioSyncRef.current});
  },[isMusicMode,videoLoaded,useYouTubePlayer]);

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
    const onSync=({videoState,triggeredBy,serverTime})=>{
      if(isMusicMode)return;
      applySyncRef.current(videoState,triggeredBy,serverTime);
    };
    const onAudioSync=payload=>{
      if(!isMusicMode)return;
      applyAudioSyncRef.current(payload);
    };
    const onMsg=msg=>setMessages(p=>{const n=[...p,{...msg,reactions:msg.reactions||{}}];return n.length>MAX_MESSAGES?n.slice(-MAX_MESSAGES):n;});
    const onReaction=({messageId,reactions})=>setMessages(p=>p.map(m=>m.id===messageId?{...m,reactions}:m));
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

    const res=await fetch(documentInfo.fileUrl,{method:"HEAD"});
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

  useEffect(()=>{
    readingReadyRef.current=readingPdfReady;
  },[readingPdfReady]);

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
    setShowSourcePanel(false);
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
    if(!raw){
      addToast("Paste a link first","error");
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
      addToast(resolved.reason||"Invalid link","error");
      return;
    }

    const normalizedUrl=resolved.normalizedUrl||raw;
    const sourceType=resolved.contentType||"unknown";
    const syncKind=resolved.syncKind||"companion";
    // Engines classify links into transport kinds so RoomView can choose the
    // right loading path: YouTube iframe, HTML media, PDF, or companion link.

    setResourceInput(normalizedUrl);
    setShowSourcePanel(false);
    if(isMusicMode){
      requiredAudioSignatureRef.current="";
      localAudioSignatureRef.current="";
      setAudioLoadWarning("");
    }

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
  const openResourceInNewTab=()=>{
    const targetUrl=sharedDocument?.fileUrl||resourceUrl;
    if(!targetUrl||!isHttpUrl(targetUrl)){
      addToast("No external resource link available","info");
      return;
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

  return(
    <div className={`h-dvh min-h-screen flex flex-col overflow-hidden relative ${isReadingMode?"bg-zinc-50":"bg-screen"}`}>
      {!isReadingMode&&<div className="grain-overlay"/>}

      {/* ── Header ── */}
      <header className={`relative z-20 border-b backdrop-blur-sm shrink-0 ${isReadingMode?"px-3 sm:px-4 py-3 bg-white border-zinc-200":"px-3 sm:px-4 py-2 bg-zinc-950/90 border-zinc-800/60"}`}>
        {isReadingMode?(
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.15em] font-semibold text-zinc-500">CO-READING MODE</p>
              <p className="font-display text-lg leading-tight text-zinc-900">Room {roomCode}</p>
              <p className="text-xs mt-0.5 text-zinc-600">
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
                className="p-2 rounded-lg border border-zinc-300 text-zinc-600 hover:text-zinc-900 hover:border-zinc-500 transition-colors"
                title={showChat ? "Close chat" : "Open chat"}
              >
                <MessageSquare size={15}/>
              </button>
              <div ref={moreMenuRef} className="relative">
                <button
                  type="button"
                  onClick={()=>setShowMoreMenu(v=>!v)}
                  className="p-2 rounded-lg border border-zinc-300 text-zinc-600 hover:text-zinc-900 hover:border-zinc-500 transition-colors"
                  title="More actions"
                >
                  <Menu size={15}/>
                </button>
                {showMoreMenu&&(
                  <div className="absolute right-0 mt-2 w-44 rounded-xl border border-zinc-200 bg-white shadow-xl p-1.5 z-40">
                    <button
                      type="button"
                      onClick={()=>{setShowMoreMenu(false);openSourcePanel();}}
                      disabled={!canChangeSource}
                      className="w-full text-left text-xs px-2.5 py-2 rounded-lg text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Change source
                    </button>
                    <button
                      type="button"
                      onClick={()=>{setShowMoreMenu(false);openResourceInNewTab();}}
                      className="w-full text-left text-xs px-2.5 py-2 rounded-lg text-zinc-700 hover:bg-zinc-100"
                    >
                      Open resource
                    </button>
                    {!inCall?(
                      <button
                        type="button"
                        onClick={()=>{setShowMoreMenu(false);joinCall(true);}}
                        className="w-full text-left text-xs px-2.5 py-2 rounded-lg text-zinc-700 hover:bg-zinc-100"
                      >
                        Start call
                      </button>
                    ):(
                      <button
                        type="button"
                        onClick={()=>{setShowMoreMenu(false);leaveCall();}}
                        className="w-full text-left text-xs px-2.5 py-2 rounded-lg text-red-600 hover:bg-red-50"
                      >
                        End call
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={()=>{setShowMoreMenu(false);copyCode();}}
                      className="w-full text-left text-xs px-2.5 py-2 rounded-lg text-zinc-700 hover:bg-zinc-100"
                    >
                      Copy room code
                    </button>
                  </div>
                )}
              </div>
              <button onClick={onLeave}
                className="text-xs px-2.5 py-2 rounded-lg transition-colors text-zinc-700 hover:text-red-600 hover:bg-zinc-100">
                Leave
              </button>
            </div>
          </div>
        ):(
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Film size={16} className="text-amber-400"/>
              <span className="font-display text-lg text-zinc-100 hidden sm:block">Lumiere</span>
              <div className="flex items-center gap-1.5 bg-zinc-800/60 rounded-lg px-3 py-1">
                <span className="font-mono text-xs text-amber-400 tracking-widest">{roomCode}</span>
                <button onClick={copyCode} className="text-zinc-500 hover:text-zinc-300 transition-colors ml-1">
                  {copied?<Check size={11} className="text-green-400"/>:<Copy size={11}/>}
                </button>
              </div>
              <div className="flex items-center gap-2 overflow-x-auto max-w-[45vw] sm:max-w-none pr-1">
                <span className="text-[10px] px-2 py-1 rounded-full border border-amber-500/35 bg-amber-500/10 text-amber-200 whitespace-nowrap">
                  {modeLabel} room
                </span>
                <span className="text-[10px] px-2 py-1 rounded-full border border-emerald-500/35 bg-emerald-500/10 text-emerald-200 whitespace-nowrap">
                  {sessionLabel} mode
                </span>
                {!!roomMoodTag&&(
                  <span className="text-[10px] px-2 py-1 rounded-full border border-violet-500/35 bg-violet-500/10 text-violet-200 whitespace-nowrap">
                    Mood: {roomMoodTag}
                  </span>
                )}
                <div className={`flex items-center gap-1.5 text-[10px] px-2.5 py-1 rounded-full border whitespace-nowrap
                  ${connected?"bg-green-950/60 text-green-400 border-green-800/50":"bg-red-950/60 text-red-400 border-red-800/50"}`}>
                  {connected?<Wifi size={10}/>:<WifiOff size={10}/>}
                  {connected?"Live":"Reconnecting…"}
                </div>
                <span className="hidden sm:inline text-[10px] px-2 py-1 rounded-full border border-zinc-700 bg-zinc-900/80 text-zinc-400 whitespace-nowrap">
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
                  className="hidden lg:inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-zinc-700 bg-zinc-900/80 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 transition-colors"
                  title="Open linked resource"
                >
                  <Link2 size={12}/>
                  Resource
                </button>
              )}
              <span className="flex items-center gap-1 text-zinc-500 text-xs"><Users size={12}/>{users.length}/{maxParticipants}</span>
              {otherUsers.length>0&&(
                <div ref={friendMenuRef} className="relative hidden sm:block">
                  <button
                    type="button"
                    onClick={()=>{
                      setShowHeaderNotifications(false);
                      setShowFriendMenu(v=>!v);
                    }}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-full border border-amber-500/35 text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 transition-colors"
                    title="Send friend request"
                  >
                    <UserPlus size={12}/>
                    <span className="hidden md:inline">Add Friend</span>
                  </button>
                  {showFriendMenu&&(
                    <div className="absolute right-0 mt-2 w-72 max-w-[80vw] rounded-xl border border-zinc-700 bg-zinc-900/95 backdrop-blur-xl shadow-2xl p-2 z-40">
                      <p className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500">People in room</p>
                      <div className="max-h-60 overflow-y-auto flex flex-col gap-1">
                        {otherUsers.map(target=>{
                          const status=friendStatusByUid[target.uid]||"";
                          const isBusy=!!friendBusyByUid[target.uid];
                          const disableAction=isBusy||status==="already_friends"||status==="already_requested"||status==="requested";
                          const label=`@${target.username||target.name||"friend"}`;
                          return(
                            <div key={target.uid} className="flex items-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/70 px-2 py-2">
                              {target.photoURL
                                ?<img src={target.photoURL} alt={target.name||label} className="w-7 h-7 rounded-full border border-zinc-700"/>
                                :<div className="w-7 h-7 rounded-full bg-amber-500/20 border border-zinc-700 flex items-center justify-center text-[11px] text-amber-300 font-semibold">{(target.name||label)[0]}</div>
                              }
                              <div className="min-w-0 flex-1">
                                <p className="text-xs text-zinc-200 truncate">{label}</p>
                                <p className="text-[11px] text-zinc-500 truncate">{target.name||"Viewer"}</p>
                              </div>
                              <button
                                type="button"
                                disabled={disableAction}
                                onClick={()=>handleSendFriendFromRoom(target)}
                                className={`text-[11px] px-2 py-1 rounded-md border transition-colors whitespace-nowrap ${
                                  disableAction
                                    ?"bg-zinc-800 border-zinc-700 text-zinc-500 cursor-not-allowed"
                                    :"bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25"
                                }`}
                                title={status==="needs_accept"?"Accept friend request":"Send friend request"}
                              >
                                {isBusy?"Sending...":getFriendStatusLabel(status)}
                              </button>
                            </div>
                          );
                        })}
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
                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-800/80 border border-zinc-700 text-zinc-300 hover:text-zinc-100 transition-colors"
                  title="More actions"
                >
                  <Menu size={15}/>
                </button>
                {showMoreMenu&&(
                  <div className="absolute right-0 mt-2 w-48 rounded-xl border border-zinc-700 bg-zinc-900/95 backdrop-blur-xl shadow-2xl p-1.5 z-40">
                    <button
                      type="button"
                      onClick={()=>{setShowMoreMenu(false);openSourcePanel();}}
                      className="w-full text-left text-xs px-2.5 py-2 rounded-lg text-zinc-200 hover:bg-zinc-800"
                    >
                      Change source
                    </button>
                    <button
                      type="button"
                      onClick={()=>{setShowMoreMenu(false);openResourceInNewTab();}}
                      disabled={!resourceUrl}
                      className="w-full text-left text-xs px-2.5 py-2 rounded-lg text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Open resource
                    </button>
                    {!inCall?(
                      <button
                        type="button"
                        onClick={()=>{setShowMoreMenu(false);joinCall(true);}}
                        className="w-full text-left text-xs px-2.5 py-2 rounded-lg text-zinc-200 hover:bg-zinc-800"
                      >
                        Start call
                      </button>
                    ):(
                      <button
                        type="button"
                        onClick={()=>{setShowMoreMenu(false);leaveCall();}}
                        className="w-full text-left text-xs px-2.5 py-2 rounded-lg text-red-300 hover:bg-red-500/10"
                      >
                        End call
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={()=>{setShowMoreMenu(false);copyCode();}}
                      className="w-full text-left text-xs px-2.5 py-2 rounded-lg text-zinc-200 hover:bg-zinc-800"
                    >
                      Copy room code
                    </button>
                  </div>
                )}
              </div>
              {!inCall
                ?<button onClick={()=>joinCall(true)}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-green-600 hover:bg-green-500 text-white font-medium transition-all shadow-lg shadow-green-900/30 sm:px-3 sm:py-1.5">
                    <Phone size={12}/> Start Call
                  </button>
                :<div className="flex items-center gap-2">
                    <span className="hidden sm:flex text-green-400 text-xs items-center gap-1">
                      <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"/> In Call
                    </span>
                    <button onClick={leaveCall}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-red-600 hover:bg-red-500 text-white font-medium transition-all sm:px-3 sm:py-1.5">
                      <PhoneOff size={12}/> End Call
                    </button>
                  </div>
              }
              <button onClick={()=>setShowChat(s=>!s)}
                className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
                title={showChat ? "Close chat" : "Open chat"}>
                <MessageSquare size={15}/>
              </button>
              <button onClick={onLeave}
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-400 transition-colors px-2 py-1.5 rounded-lg hover:bg-zinc-800">
                <LogOut size={13}/><span className="hidden sm:inline">Leave</span>
              </button>
            </div>
          </div>
        )}
      </header>

      {/* ── Body ── */}
      <div className="relative z-10 flex-1 flex flex-col lg:flex-row overflow-hidden min-h-0">

        {/* Video column */}
        <div ref={containerRef} className={`flex-1 flex flex-col overflow-hidden relative min-w-0 min-h-[45dvh] lg:min-h-0 ${isReadingMode?"bg-zinc-100":"bg-zinc-950/70"}`}>
          <div className={`flex-1 relative flex items-center justify-center overflow-hidden ${isReadingMode?"bg-zinc-100":"bg-black"}`}>
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
                className={`max-h-full max-w-full ${videoLoaded?"cursor-pointer":""}`}
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
            {showMusicStage&&(
              <div className="absolute inset-0 z-[4] flex items-center justify-center p-6">
                <div className="w-full max-w-4xl rounded-[32px] border border-zinc-800 bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.18),_transparent_44%),linear-gradient(180deg,_rgba(24,24,27,0.96),_rgba(9,9,11,0.98))] px-5 py-5 shadow-[0_32px_100px_rgba(0,0,0,0.5)] sm:px-7 sm:py-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-4">
                        <div className="hidden h-16 w-16 shrink-0 items-center justify-center rounded-[24px] border border-amber-400/20 bg-amber-300/10 text-amber-300 sm:flex">
                          <Headphones size={26}/>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] uppercase tracking-[0.3em] text-amber-300/80">Music Mode</p>
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
                            <span className="rounded-full border border-zinc-700 bg-zinc-900/70 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-zinc-300">
                              {isPlaying?"Playing":"Paused"}
                            </span>
                            <span className="rounded-full border border-zinc-700 bg-zinc-900/70 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-zinc-300">
                              {useYouTubePlayer?"YouTube":resourceUrl?"Shared audio":"Local audio"}
                            </span>
                            <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-emerald-300">
                              Equal control
                            </span>
                          </div>
                          {audioLoadWarning&&(
                            <p className="mt-4 inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-200">
                              {audioLoadWarning}
                            </p>
                          )}
                          {useYouTubePlayer&&!videoLoaded&&(
                            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-black/35 px-3 py-1.5 text-xs text-zinc-300">
                              <span className="h-3 w-3 rounded-full border-2 border-zinc-600 border-t-amber-300 animate-spin"/>
                              Preparing YouTube audio...
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:min-w-[13rem]">
                      <div className="rounded-[24px] border border-zinc-700/80 bg-black/35 px-4 py-3 text-right">
                        <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Clock</p>
                        <p className="mt-2 text-3xl font-mono text-zinc-100">{fmt(currentTime)}</p>
                        <p className="mt-1 text-[11px] text-zinc-500">{audioDebugStatus||"Waiting for sync"}</p>
                      </div>
                      <div className="rounded-[24px] border border-zinc-800 bg-zinc-950/70 px-4 py-3">
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
                      <div className="rounded-[28px] border border-zinc-800 bg-zinc-950/65 p-4 sm:p-5">
                        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Load Source</p>
                        <div className="mt-4 flex flex-col gap-3">
                          <div className="flex flex-col gap-3 sm:flex-row">
                            <button
                              type="button"
                              onClick={()=>fileInputRef.current?.click()}
                              disabled={!canChangeSource}
                              className={`inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition-colors ${
                                canChangeSource
                                  ?"bg-amber-300 text-zinc-950 hover:bg-amber-200 shadow-lg shadow-amber-900/20"
                                  :"bg-zinc-800/70 text-zinc-500 cursor-not-allowed"
                              }`}
                            >
                              <Upload size={16}/>
                              {uploadButtonLabel}
                            </button>
                            <button
                              type="button"
                              onClick={openSourcePanel}
                              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-zinc-700 px-4 py-3 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
                            >
                              <Link2 size={15}/>
                              Open source panel
                            </button>
                          </div>
                          <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-black/25 px-3">
                            <Link2 size={15} className="shrink-0 text-zinc-500"/>
                            <input
                              value={resourceInput}
                              onChange={e=>setResourceInput(e.target.value)}
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
                                  ?"border-zinc-600 bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
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
                      <div className="rounded-[28px] border border-zinc-800 bg-zinc-950/65 p-4 sm:p-5">
                        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Room Sync</p>
                        <p className="mt-4 text-sm leading-6 text-zinc-300">
                          Everyone can play, pause, or jump the track. The server only shares timeline state, so each device stays in sync without streaming audio.
                        </p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <span className="rounded-full border border-zinc-800 bg-black/25 px-3 py-1 text-[11px] text-zinc-400">
                            Scheduled starts
                          </span>
                          <span className="rounded-full border border-zinc-800 bg-black/25 px-3 py-1 text-[11px] text-zinc-400">
                            Drift correction
                          </span>
                          <span className="rounded-full border border-zinc-800 bg-black/25 px-3 py-1 text-[11px] text-zinc-400">
                            Late join sync
                          </span>
                        </div>
                      </div>
                    </div>
                  ):(
                    <div className="mt-6 rounded-[28px] border border-zinc-800 bg-zinc-950/70 p-4 sm:p-5">
                      <div className="flex items-center gap-3">
                        <span className="text-zinc-500 text-xs font-mono w-12 text-right shrink-0">{fmt(currentTime)}</span>
                        <input
                          type="range"
                          min={0}
                          max={duration||100}
                          step={0.1}
                          value={currentTime}
                          disabled={!videoLoaded}
                          className="flex-1 accent-amber-400 cursor-pointer"
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
                            disabled={!videoLoaded}
                            title="Back 10s"
                            className="p-2 rounded-xl hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors"
                          >
                            <SkipBack size={16}/>
                          </button>
                          <button
                            type="button"
                            onClick={handlePlayPause}
                            disabled={!videoLoaded}
                            className="h-12 w-12 rounded-full bg-amber-300 hover:bg-amber-200 flex items-center justify-center text-zinc-950 transition-colors disabled:opacity-30 shadow-lg shadow-amber-500/20"
                          >
                            {isPlaying?<Pause size={18}/>:<Play size={18} className="ml-0.5"/>}
                          </button>
                          <button
                            type="button"
                            onClick={()=>handleSkip(10)}
                            disabled={!videoLoaded}
                            title="Forward 10s"
                            className="p-2 rounded-xl hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors"
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
            {useYouTubePlayer&&!videoLoaded&&!isMusicMode&&(
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950/70 z-10 pointer-events-none">
                <div className="w-12 h-12 rounded-full border-2 border-zinc-700 border-t-amber-300 animate-spin"/>
                <p className="text-zinc-300 text-sm">Loading YouTube player...</p>
              </div>
            )}
            {showGenericLoadState&&(
              <div className={`absolute inset-0 flex flex-col items-center justify-center gap-4 z-10 ${isReadingMode?"bg-zinc-100":"bg-zinc-950/96"}`}>
                <div className={`w-16 h-16 rounded-2xl border flex items-center justify-center shadow-xl ${isReadingMode?"bg-white border-zinc-300 shadow-zinc-300/30":"bg-zinc-900 border-zinc-700 shadow-black/40"}`}>
                  <Upload size={26} className={isReadingMode?"text-zinc-500":"text-zinc-500"}/>
                </div>
                <div className="text-center">
                  <p className={`font-semibold mb-1 ${isReadingMode?"text-zinc-800":"text-zinc-200"}`}>{uploadPrimary}</p>
                  <p className={`text-xs ${isReadingMode?"text-zinc-600":"text-zinc-500"}`}>{uploadHint}</p>
                  {docUploading&&(
                    <p className="text-amber-300 text-xs mt-1">Uploading PDF for room sharing...</p>
                  )}
                </div>
                <div className="w-full max-w-xl px-4 space-y-2">
                  <div className="flex gap-2">
                    <button onClick={()=>fileInputRef.current?.click()} disabled={!canChangeSource}
                      className={`font-semibold px-4 py-2.5 rounded-xl text-sm transition-colors flex items-center gap-2 ${
                        canChangeSource
                          ?isReadingMode
                            ?"bg-zinc-900 hover:bg-zinc-700 text-white"
                            :"bg-amber-300 hover:bg-amber-200 text-zinc-950 shadow-lg shadow-amber-900/30"
                          :"bg-zinc-800/70 text-zinc-500 cursor-not-allowed"
                      }`}>
                      <Upload size={15}/> {uploadButtonLabel}
                    </button>
                    <button
                      type="button"
                      onClick={openResourceInNewTab}
                      disabled={!showCompanionLink&&!showReadingFrame}
                      className={`px-4 py-2.5 rounded-xl border disabled:opacity-45 disabled:cursor-not-allowed text-sm ${isReadingMode?"border-zinc-300 text-zinc-700 hover:text-zinc-900 hover:border-zinc-500":"border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500"}`}
                    >
                      Open linked resource
                    </button>
                  </div>
                  <div className={`flex items-center gap-2 rounded-xl border px-3 ${isReadingMode?"border-zinc-300 bg-white":"border-zinc-700 bg-zinc-900/70"}`}>
                    {sessionMode==="reading"?<FileText size={14} className="text-zinc-500 shrink-0"/>:<Link2 size={14} className="text-zinc-500 shrink-0"/>}
                    <input
                      value={resourceInput}
                      onChange={e=>setResourceInput(e.target.value)}
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
                            :"bg-zinc-800 hover:bg-zinc-700 border-zinc-600 text-zinc-200"
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
              </div>
            )}
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
                <div className="absolute top-4 right-4 z-10 flex items-center gap-2 text-[11px] text-zinc-600 bg-white/88 border border-zinc-200 rounded-full px-3 py-1 backdrop-blur-sm shadow-sm">
                  <span className={`h-2 w-2 rounded-full ${readingPdfReady?"bg-emerald-400":"bg-amber-400 animate-pulse"}`}/>
                  <span>{readingPdfReady?"Synced":"Loading PDF"}</span>
                  <span className="text-zinc-400">•</span>
                  <span>Host: @{hostUser?.username||hostUser?.name||"host"}</span>
                </div>
                {readingPdfWarning&&(
                  <div className="absolute top-4 left-4 z-10 max-w-xs rounded-full border border-amber-200 bg-amber-50/95 px-3 py-1 text-[11px] text-amber-700 shadow-sm backdrop-blur-sm">
                    {readingPdfWarning}
                  </div>
                )}
                <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 rounded-full border border-zinc-200 bg-white/95 backdrop-blur-sm px-3 py-2 flex items-center gap-2 shadow-lg">
                  <button
                    onClick={()=>handleReadingPageStep(-1)}
                    disabled={!isHost||readingPage<=1||!sharedDocument?.fileUrl}
                    className="px-2 py-1 text-sm rounded-md text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
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
                    className={`w-16 border border-zinc-300 rounded-md px-2 py-1 text-xs text-zinc-800 focus:outline-none focus:border-zinc-500 ${!isHost?"cursor-not-allowed bg-zinc-100 text-zinc-500":"bg-white"}`}
                  />
                  <span className="text-xs text-zinc-500 min-w-[3rem]">{readingTotalPages>0?`/ ${readingTotalPages}`:"pages"}</span>
                  <button
                    onClick={()=>handleReadingPageStep(1)}
                    disabled={!isHost||!sharedDocument?.fileUrl||(readingTotalPages>0&&readingPage>=readingTotalPages)}
                    className="px-2 py-1 text-sm rounded-md text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ▶
                  </button>
                  <span className="text-xs text-zinc-500 px-1">{readingZoom}%</span>
                  <button onClick={()=>handleReadingZoom(-10)} className="px-2 py-1 text-xs rounded-md text-zinc-600 hover:bg-zinc-100">-</button>
                  <button onClick={()=>handleReadingZoom(10)} className="px-2 py-1 text-xs rounded-md text-zinc-600 hover:bg-zinc-100">+</button>
                  <span className="hidden sm:inline text-[11px] text-zinc-500 pl-1">
                    {isHost?"You control the room":"Following the host"}
                  </span>
                </div>
              </>
            )}
            {showCompanionLink&&(
              <div className="absolute bottom-3 left-3 right-3 z-10 rounded-lg border border-zinc-700/70 bg-black/55 backdrop-blur-sm px-3 py-2 text-xs text-zinc-300 flex items-center justify-between gap-2">
                <span className="truncate">Companion {resourceType!=="unknown"?`${resourceType} `:""}resource: {resourceUrl.replace(/^https?:\/\//i,"")}</span>
                <button onClick={openResourceInNewTab} className="px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-100">
                  Open
                </button>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept={fileAccept} className="hidden" onChange={handleFileSelect}/>
            {actionBanner&&(
              <div className="absolute top-3 left-3 bg-black/60 text-zinc-300 text-xs px-3 py-1.5 rounded-full backdrop-blur-sm z-10 pointer-events-none">
                {actionBanner}
              </div>
            )}
            {waitingForUser&&(
              <div className="absolute top-12 left-3 bg-amber-500/20 border border-amber-500/35 text-amber-300 text-xs px-3 py-1.5 rounded-full backdrop-blur-sm z-10 pointer-events-none">
                Waiting for @{waitingForUser}...
              </div>
            )}
            {showSourcePanel&&(
              <div className={`absolute top-4 right-4 z-20 w-[22rem] max-w-[90vw] rounded-2xl border shadow-2xl p-3 ${
                isReadingMode?"border-zinc-200 bg-white":"border-zinc-700/70 bg-zinc-950/90"
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
                    onClick={()=>setShowSourcePanel(false)}
                    className={`p-1.5 rounded-lg border ${isReadingMode?"border-zinc-200 text-zinc-500 hover:text-zinc-800":"border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
                  >
                    <X size={12}/>
                  </button>
                </div>
                <button
                  type="button"
                  onClick={()=>fileInputRef.current?.click()}
                  disabled={!canChangeSource}
                  className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-colors ${
                    canChangeSource
                      ?isReadingMode
                        ?"bg-zinc-900 text-white hover:bg-zinc-700"
                        :"bg-amber-400 text-zinc-950 hover:bg-amber-300"
                      :"bg-zinc-800/60 text-zinc-500 cursor-not-allowed"
                  }`}
                >
                  <Upload size={13}/> Choose file
                </button>
                <div className={`mt-2 flex items-center gap-2 rounded-xl border px-2 ${
                  isReadingMode?"border-zinc-200 bg-white":"border-zinc-700 bg-zinc-900/60"
                }`}>
                  {sessionMode==="reading"?<FileText size={13} className="text-zinc-500 shrink-0"/>:<Link2 size={13} className="text-zinc-500 shrink-0"/>}
                  <input
                    value={resourceInput}
                    onChange={e=>setResourceInput(e.target.value)}
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
                          :"bg-zinc-800 border-zinc-700 text-zinc-200 hover:bg-zinc-700"
                        :"bg-zinc-800/60 border-zinc-800 text-zinc-500 cursor-not-allowed"
                    }`}
                  >
                    {sessionMode==="watch"?"YouTube":"Load"}
                  </button>
                </div>
                {!canChangeSource&&(
                  <p className="mt-2 text-[11px] text-amber-300">Only the host can change the document in co-reading.</p>
                )}
              </div>
            )}
          </div>

      {/* Controls bar */}
          {showBottomTransport&&(
            <div className="px-4 py-3 bg-zinc-900/95 border-t border-zinc-800 flex flex-col gap-2.5 shrink-0 relative z-10">
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 text-xs font-mono w-12 text-right shrink-0">{fmt(currentTime)}</span>
              <input type="range" min={0} max={duration||100} step={0.1} value={currentTime}
                disabled={!videoLoaded} className="flex-1 accent-amber-400 cursor-pointer" style={{height:"4px"}}
                onMouseDown={()=>{isScrubbing.current=true;}}
                onTouchStart={()=>{isScrubbing.current=true;}}
                onChange={handleScrubChange} onMouseUp={handleScrubEnd} onTouchEnd={handleScrubEnd}/>
              <span className="text-zinc-500 text-xs font-mono w-12 shrink-0">{fmt(duration)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={()=>handleSkip(-10)} disabled={!videoLoaded} title="Back 10s"
                className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors">
                <SkipBack size={16}/>
              </button>
              <button onClick={handlePlayPause} disabled={!videoLoaded}
                className="w-10 h-10 rounded-full bg-amber-300 hover:bg-amber-200 flex items-center justify-center text-zinc-950 transition-colors disabled:opacity-30 shrink-0 shadow-lg shadow-amber-500/20">
                {isPlaying?<Pause size={17}/>:<Play size={17} className="ml-0.5"/>}
              </button>
              <button onClick={()=>handleSkip(10)} disabled={!videoLoaded} title="Forward 10s"
                className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors">
                <SkipForward size={16}/>
              </button>
              <button onClick={toggleMute} className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors ml-1">
                {muted||volume===0?<VolumeX size={15}/>:<Volume2 size={15}/>}
              </button>
              <input type="range" min={0} max={1} step={0.05} value={muted?0:volume}
                onChange={handleVolumeChange} className="w-20 accent-amber-400 cursor-pointer" style={{height:"4px"}}/>
              <button onClick={sendBookmark} disabled={!videoLoaded} title="Bookmark current time"
                className="p-2 rounded-lg hover:bg-amber-500/20 text-zinc-500 hover:text-amber-400 disabled:opacity-30 transition-colors ml-1">
                <Bookmark size={15}/>
              </button>
              {videoName&&<span className="text-zinc-600 text-xs font-mono truncate max-w-[180px] hidden lg:block ml-1">{videoName}</span>}
              <div className="flex-1"/>
              <span className="text-zinc-700 text-xs hidden sm:block">{isMusicMode?"Equal control • master clock sync":"Everyone controls"}</span>
              {!isMusicMode&&(
                <button onClick={handleFullscreen} title={isFullscreen?"Exit fullscreen":"Fullscreen"}
                  className="p-2 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors">
                  {isFullscreen?<Minimize size={15}/>:<Maximize size={15}/>}
                </button>
              )}
            </div>
            </div>
          )}

          {/* Draggable call window inside container = visible in fullscreen */}
          {inCall&&(
            <DraggableCallWindow
              inCall={inCall} micOn={micOn} camOn={camOn}
              localStreamRef={localStreamRef} remoteStreams={remoteStreams}
              users={users} myUid={user.uid} myName={username}
              onLeave={leaveCall} onToggleMic={toggleMic} onToggleCam={toggleCam}
              containerRef={containerRef}
            />
          )}
        </div>

        {/* Chat panel */}
        {showChat&&(
          <div className={`w-full h-[40dvh] max-h-[32rem] lg:h-auto lg:max-h-none lg:w-[30rem] flex flex-col border backdrop-blur-xl shadow-2xl lg:shadow-none shrink-0 lg:border-r-0 lg:border-t-0 lg:border-b-0 ${isReadingMode?"border-zinc-300/80 bg-white/80 lg:border-l-zinc-300 lg:bg-white/75":"border-zinc-700/60 bg-zinc-950/70 lg:border-l-zinc-700/60 lg:bg-zinc-950/65"}`}>
            <div className={`px-4 py-3 border-b flex items-center justify-between ${isReadingMode?"border-zinc-300/70":"border-zinc-700/50"}`}>
              <span className={`text-sm font-medium flex items-center gap-2 ${isReadingMode?"text-zinc-800":"text-zinc-300"}`}>
                <MessageSquare size={13} className="text-amber-400"/> Chat
                <span className={`text-xs ${isReadingMode?"text-zinc-500":"text-zinc-600"}`}>{users.length} people</span>
              </span>
              <button onClick={()=>setShowChat(false)} className={`flex items-center gap-1 transition-colors text-xs ${isReadingMode?"text-zinc-500 hover:text-zinc-800":"text-zinc-400 hover:text-zinc-200"}`}>
                <X size={13}/> Close
              </button>
            </div>
            <div className={`px-4 py-2 border-b flex items-center gap-1.5 flex-wrap ${isReadingMode?"border-zinc-300/60":"border-zinc-700/40"}`}>
              {users.map(u=>(
                <div key={u.uid} title={`@${u.username||u.name}`}>
                  {u.photoURL
                    ?<img src={u.photoURL} alt={u.name} className="w-6 h-6 rounded-full border border-zinc-700"/>
                    :<div className="w-6 h-6 rounded-full bg-amber-500/20 border border-zinc-700 flex items-center justify-center text-[10px] text-amber-400 font-semibold">{u.name?.[0]}</div>
                  }
                </div>
              ))}
            </div>
            <div
              className="flex-1 overflow-y-auto p-3 flex flex-col gap-3"
              onScroll={()=>setClosePickerSignal(v=>v+1)}
            >
              {messages.length===0&&<p className={`text-xs text-center mt-8 ${isReadingMode?"text-zinc-500":"text-zinc-700"}`}>No messages yet!</p>}
              {messages.map((m,i)=>(
                <ChatMessage
                  key={m.id||i}
                  msg={m}
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
            <form onSubmit={sendMessage} className={`p-3 border-t flex gap-2 items-center safe-bottom ${isReadingMode?"border-zinc-300/70":"border-zinc-700/50"}`}>
              {/* Sparkle button — opens preset messages */}
              <button type="button" onClick={()=>setShowPresets(s=>!s)}
                title="Quick messages"
                className={`p-2 rounded-lg border transition-colors shrink-0
                  ${showPresets
                    ?"bg-amber-500/20 border-amber-500/40 text-amber-400"
                    :"bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-amber-400 hover:border-amber-500/30"}`}>
                ✨
              </button>
              <input value={chatInput} onChange={e=>setChatInput(e.target.value)}
                placeholder={chatPlaceholder} maxLength={500}
                onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage(e);}}}
                className={`flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500/50 transition-colors min-w-0 ${
                  isReadingMode
                    ?"bg-white border-zinc-300 text-zinc-900 placeholder-zinc-500"
                    :"bg-zinc-800 border-zinc-700 text-zinc-100 placeholder-zinc-600"
                }`}
              />
              <button
                type="button"
                onClick={sendBookmark}
                disabled={!videoLoaded||isReadingMode}
                title="Bookmark current time"
                className={`p-2 border rounded-lg disabled:opacity-30 transition-colors shrink-0 ${
                  isReadingMode
                    ?"bg-zinc-100 border-zinc-300 text-zinc-500 hover:bg-zinc-200"
                    :"bg-zinc-800 hover:bg-amber-500/20 border-zinc-700 text-zinc-500 hover:text-amber-400"
                }`}
              >
                <Bookmark size={14}/>
              </button>
              <button type="submit" disabled={!chatInput.trim()}
                className="p-2 bg-amber-500 hover:bg-amber-400 text-zinc-950 rounded-lg disabled:opacity-40 transition-colors shrink-0">
                <Send size={14}/>
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

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
