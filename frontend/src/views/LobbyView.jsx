import { useState, useEffect } from "react";
import {
  Film, LogOut, Users, ChevronRight,
  Menu, Lock, Library, Link2, FileText,
} from "lucide-react";
import { getSessionEngine } from "../engines/index.js";
import { extractYouTubeId } from "../engines/engineUtils.js";
import { normalizeCode } from "../utils/url";
import {
  PRIVATE_ROOM_MODES, SESSION_MODES, ROOM_MOOD_OPTIONS,
} from "../config/roomModes";
import HeaderNotifications from "../components/HeaderNotifications";

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

export default LobbyView
