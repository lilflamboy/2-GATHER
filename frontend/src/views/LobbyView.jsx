/**
 * LobbyView is the signed-in home screen. It lets the user create private
 * rooms, join by code, open the dashboard, and review incoming invites or
 * friend requests before entering a session.
 */
import { useState, useEffect } from "react";
import {
  LogOut, Users, ChevronRight,
  Menu, Lock, Library, Link2, FileText,
} from "lucide-react";
import LumiereLogoMark from "../components/LumiereLogoMark.jsx";
import { getSessionEngine } from "../engines/index.js";
import { extractYouTubeId } from "../engines/engineUtils.js";
import { normalizeCode } from "../utils/url";
import {
  PRIVATE_ROOM_MODES, SESSION_MODES, ROOM_MOOD_OPTIONS,
} from "../config/roomModes";
import HeaderNotifications from "../components/HeaderNotifications";

/**
 * Renders the authenticated lobby/home screen.
 * @param {{avatarUrl?: string, username: string, onCreateRoom?: (payload: object) => void, onJoinRoom?: (code: string) => void, onSignOut?: () => void, savedRoomCode?: string, onOpenDashboard?: (tab?: string) => void, memoryStats?: object, invites?: Array, friendRequests?: Array, friendRequestBusyByUid?: Record<string, boolean>, onRespondFriendRequest?: (uid: string, action: string) => void, onAcceptInvite?: (invite: object) => void, socketConnected?: boolean}} props - Lobby state, room actions, and notification data.
 * @returns {JSX.Element} The post-auth lobby view.
 */
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
  // Local lobby state tracks the room creation form and the join-code input.
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

  // Keep the YouTube preview id aligned with the current watch-mode resource input.
  useEffect(()=>{
    if(sessionMode!=="watch"){
      setYoutubeVideoId("");
      return;
    }
    setYoutubeVideoId(extractYouTubeId(resourceUrl));
  },[resourceUrl,sessionMode]);

  // Build the normalized room-create payload the backend/socket layer expects.
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
    <div className="min-h-screen bg-screen relative flex flex-col overflow-hidden text-zinc-100">
      <div className="grain-overlay"/>
      <div className="absolute left-[-12rem] top-[-10rem] h-[28rem] w-[28rem] rounded-full bg-amber-500/10 blur-3xl pointer-events-none"/>
      <div className="absolute right-[-10rem] top-20 h-[24rem] w-[24rem] rounded-full bg-violet-500/10 blur-3xl pointer-events-none"/>
      <div className="absolute bottom-[-14rem] left-1/2 h-[28rem] w-[36rem] -translate-x-1/2 rounded-full bg-orange-500/8 blur-3xl pointer-events-none"/>
      <header className="relative z-10 border-b border-white/8 bg-black/25 px-6 py-4 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-500/15 to-violet-500/10 shadow-[0_16px_40px_rgba(245,158,11,0.15)]">
            <LumiereLogoMark size={18} alt="Lumiere logo" />
          </div>
          <div className="flex flex-col">
            <span className="font-display text-[1.55rem] leading-none text-zinc-50">Lumiere</span>
            <span className="text-[0.66rem] uppercase tracking-[0.28em] text-zinc-500">Private rooms and shared moments</span>
          </div>
        </div>
        <div className="flex items-center gap-2.5 sm:gap-3">
          {/* Dashboard shortcuts and notifications stay in the header for quick access from the home screen. */}
          <button
            type="button"
            onClick={()=>onOpenDashboard?.("memories")}
            title="Memory Vault"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-xs font-medium text-zinc-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-200 hover:border-amber-400/25 hover:bg-amber-500/10 hover:text-amber-100"
          >
            <Library size={14}/>
            <span className="hidden sm:inline">Memory Vault</span>
          </button>
          <button onClick={()=>onOpenDashboard?.("profile")}
            title="Open settings"
            className="relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300 transition-all duration-200 hover:border-violet-400/25 hover:bg-violet-500/10 hover:text-zinc-50"
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
          <span className={`hidden rounded-full border px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.22em] sm:inline ${socketConnected?"border-emerald-500/20 bg-emerald-500/10 text-emerald-200":"border-red-500/20 bg-red-500/10 text-red-200"}`}>
            {socketConnected?"Connected":"Connecting..."}
          </span>
          {avatarUrl&&<img src={avatarUrl} alt="" className="h-8 w-8 rounded-full border border-white/15 shadow-[0_8px_20px_rgba(0,0,0,0.35)]"/>}
          <span className="text-sm font-mono text-zinc-400">@{username}</span>
          <button onClick={onSignOut} className="rounded-full p-2.5 text-zinc-500 transition-all duration-200 hover:bg-white/[0.05] hover:text-zinc-200"><LogOut size={15}/></button>
        </div>
        </div>
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-6 py-8 sm:px-8 lg:px-10 lg:py-10">
        <div className="w-full max-w-6xl space-y-7">
          {/* Hero + memory pulse summarize the account before the user creates or joins a room. */}
          <section className="mx-auto flex w-full max-w-4xl flex-col gap-4 text-center">
            <div className="space-y-3 text-center">
              <div className="feature-pill mx-auto border-amber-400/20 bg-amber-500/10 px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.28em] text-amber-200/90">Welcome back</div>
              <h2 className="font-display text-4xl leading-none text-zinc-50 sm:text-[3.6rem]">Shared Experience</h2>
              <p className="text-sm font-medium text-amber-200 sm:text-base">Where shared screen time becomes shared history.</p>
              <p className="mx-auto max-w-2xl text-sm leading-7 text-zinc-400">Turn moments into memories across watch, podcast, reading, and study sessions.</p>
            </div>
            <div className="glass-panel relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-white/[0.03] px-5 py-4 text-left text-xs text-zinc-400 shadow-[0_28px_100px_rgba(0,0,0,0.42)]">
              <div className="absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-amber-500/10 to-transparent pointer-events-none"/>
              <p className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.24em] text-zinc-500">Lumiere memory pulse</p>
              <div className="space-y-1">
                <p>You've shared <span className="font-semibold text-amber-200">{Number(memoryStats.sharedHoursMonth||0).toFixed(1)} hours</span> this month.</p>
                <p>Longest session: <span className="font-medium text-zinc-100">{memoryStats.longestSessionLabel||"0m"}</span>.</p>
                <p>Streak: <span className="font-semibold text-emerald-200">{memoryStats.streakDays||0} day{Number(memoryStats.streakDays||0)===1?"":"s"}</span>.</p>
              </div>
            </div>
            {savedRoomCode&&(
              <div className="flex items-center justify-between rounded-[1.6rem] border border-amber-400/20 bg-gradient-to-r from-amber-500/14 to-orange-400/8 p-4 shadow-[0_20px_60px_rgba(245,158,11,0.12)]">
                <div>
                  <p className="text-sm font-medium text-amber-100">Resume where you left off</p>
                  <p className="mt-1 text-xs font-mono text-amber-200/70">{savedRoomCode}</p>
                </div>
                <button onClick={()=>onJoinRoom(savedRoomCode)}
                  className="rounded-full bg-gradient-to-r from-amber-400 to-orange-300 px-4 py-2.5 text-sm font-semibold text-zinc-950 shadow-[0_14px_32px_rgba(245,158,11,0.22)] transition-all duration-200 hover:-translate-y-0.5 hover:from-amber-300 hover:to-orange-200">
                  Rejoin
                </button>
              </div>
            )}
            {invites.length>0&&(
              <>
                {/* Live invites are actionable from the lobby without opening the dashboard first. */}
                <div className="flex flex-col gap-2 rounded-[1.6rem] border border-emerald-400/18 bg-emerald-500/8 p-4 shadow-[0_20px_60px_rgba(16,185,129,0.08)]">
                <p className="text-sm font-semibold text-emerald-200">Live invites</p>
                {invites.map(invite=>(
                  <div key={invite.id} className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-black/25 px-3.5 py-3">
                    <div>
                      <p className="text-sm text-zinc-100">
                        {invite.fromUsername?`@${invite.fromUsername}`:invite.fromName} invited you
                      </p>
                      <p className="mt-1 text-xs font-mono text-zinc-500">{invite.roomCode}</p>
                    </div>
                    <button
                      onClick={()=>onAcceptInvite(invite)}
                      className="rounded-full bg-emerald-300 px-3.5 py-2 text-xs font-semibold text-zinc-950 transition-all duration-200 hover:-translate-y-0.5 hover:bg-emerald-200"
                    >
                      Join now
                    </button>
                  </div>
                ))}
                </div>
              </>
            )}
          </section>

          {/* The create-room card owns room type, session mode, mood, and optional resource selection. */}
          <section className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.8fr)]">
            <div className="glass-panel border border-white/10 bg-white/[0.03] p-6 shadow-[0_30px_110px_rgba(0,0,0,0.5)]">
              <h3 className="mb-1 flex items-center gap-2 text-base font-semibold text-zinc-100"><Lock size={15} className="text-amber-300"/>Create private room</h3>
              <p className="mb-5 text-xs leading-6 text-zinc-500">Invite-only by code. Pick relationship mode, session type, and mood.</p>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  {/* Relationship mode maps directly to the backend roomType and participant cap. */}
                  <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Relationship mode</p>
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
                          className={`rounded-2xl border px-3.5 py-3 text-left transition-all duration-200 ${
                            active
                              ?"border-amber-400/28 bg-gradient-to-br from-amber-500/18 to-orange-400/8 text-amber-100 shadow-[0_20px_40px_rgba(245,158,11,0.12)]"
                              :"border-white/8 bg-black/20 text-zinc-300 hover:-translate-y-0.5 hover:border-white/16 hover:bg-white/[0.03]"
                          }`}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2 text-sm font-medium">
                              <Icon size={13} className={active?"scale-110 transition-transform duration-200":""}/>
                              {option.label}
                            </span>
                            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-zinc-400">
                              {option.maxParticipants} cap
                            </span>
                          </span>
                          <span className="mt-1 block text-[11px] leading-5 opacity-80">{option.blurb}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] leading-5 text-zinc-500">{hoveredPrivate.hoverHint}</p>
                </div>

                <div className="space-y-2">
                  {/* Session mode changes which engine, labels, and placeholder text the room will use. */}
                  <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Session mode</p>
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
                          className={`rounded-2xl border px-3.5 py-3 text-left transition-all duration-200 ${
                            active
                              ?"border-violet-400/25 bg-gradient-to-br from-violet-500/18 to-violet-400/8 text-violet-100 shadow-[0_20px_40px_rgba(139,92,246,0.12)]"
                              :"border-white/8 bg-black/20 text-zinc-300 hover:-translate-y-0.5 hover:border-white/16 hover:bg-white/[0.03]"
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
                  <p className="text-[11px] leading-5 text-zinc-500">{hoveredSession.hoverHint||selectedSessionMode.blurb}</p>
                </div>
              </div>

              {/* Mood tags are optional metadata used for room flavor and later memory analytics. */}
              <div className="space-y-2 mb-4 mt-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Mood (optional)</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                  {ROOM_MOOD_OPTIONS.map(option=>(
                    <button
                      key={option.key||"none"}
                      type="button"
                      onClick={()=>setMoodTag(option.key)}
                      className={`rounded-full border px-3 py-2 text-[11px] transition-all duration-200 ${
                        moodTag===option.key
                          ?"border-amber-400/25 bg-amber-500/12 text-amber-100"
                          :"border-white/8 bg-black/20 text-zinc-400 hover:border-white/16 hover:text-zinc-200"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Resource links are normalized before room creation so the right session engine can pick them up. */}
              <div className="space-y-2 mb-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Resource link (optional)</p>
                <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4">
                  {sessionMode==="reading"?<FileText size={13} className="shrink-0 text-zinc-500"/>:<Link2 size={13} className="shrink-0 text-zinc-500"/>}
                  <input
                    value={resourceUrl}
                    onChange={e=>setResourceUrl(e.target.value)}
                    placeholder={resourcePlaceholder}
                    className="flex-1 bg-transparent py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
                  />
                </div>
                <p className="text-[11px] leading-5 text-zinc-500">
                  {engineUi.resourceHelp || "Paste a link and Lumiere will track it for shared memories."}
                </p>
              </div>

              <div className="mb-5 rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-[11px] text-zinc-500">
                <span className="font-medium text-zinc-100">{selectedPrivateMode.label}</span>
                {" · "}
                <span className="font-medium text-zinc-100">{selectedSessionMode.label}</span>
                {moodTag?(
                  <>
                    {" · "}
                    <span className="text-amber-200">{moodTag}</span>
                  </>
                ):null}
                {" · "}
                <span>{selectedPrivateMode.maxParticipants} participant cap</span>
              </div>

              <button onClick={createRoom}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-amber-400 via-orange-300 to-amber-300 px-4 py-3.5 text-sm font-semibold text-zinc-950 shadow-[0_18px_40px_rgba(251,146,60,0.28)] transition-all duration-200 hover:-translate-y-0.5 hover:from-amber-300 hover:to-orange-200">
                Create Private Room <ChevronRight size={16}/>
              </button>
            </div>
            <div className="glass-panel border border-white/10 bg-white/[0.03] p-6 shadow-[0_30px_110px_rgba(0,0,0,0.45)]">
              {/* Joining uses the same normalized room-code format the backend expects. */}
              <h3 className="mb-1 flex items-center gap-2 text-base font-semibold text-zinc-100"><Users size={15} className="text-amber-300"/>Join a room</h3>
              <p className="mb-5 text-xs leading-6 text-zinc-500">Enter the 6-letter code from your friend.</p>
              <div className="flex gap-2">
                <input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="ROOM CODE"
                  maxLength={8} onKeyDown={e=>e.key==="Enter"&&code.trim()&&onJoinRoom(normalizeCode(code))}
                  className="flex-1 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-mono tracking-[0.35em] text-zinc-100 placeholder-zinc-500 transition-all duration-200 focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-500/10"/>
                <button onClick={()=>code.trim()&&onJoinRoom(normalizeCode(code))} disabled={!code.trim()}
                  className="rounded-2xl border border-white/10 bg-white/[0.05] px-5 py-3 text-sm font-medium text-zinc-100 transition-all duration-200 hover:border-violet-400/25 hover:bg-violet-500/10 disabled:opacity-40">
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

export default LobbyView
