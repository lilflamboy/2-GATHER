/**
 * The header notifications control renders the bell icon, unread badge, and
 * the compact dropdown for invites and friend requests.
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { Bell } from "lucide-react";

/**
 * Renders the header bell and notification dropdown.
 * @param {{friendRequests?: Array, invites?: Array, friendRequestBusyByUid?: Record<string, boolean>, onAcceptFriendRequest?: (uid: string) => void, onDeclineFriendRequest?: (uid: string) => void, onAcceptInvite?: (invite: object) => void, open?: boolean, onOpenChange?: (open: boolean) => void}} props - Notification data plus open-state and action handlers.
 * @returns {JSX.Element} The notification trigger and dropdown.
 */
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
  // Allow the dropdown to be either self-managed or controlled by a parent header.
  const [internalOpen,setInternalOpen]=useState(false);
  const panelRef=useRef(null);
  const isControlled=typeof openProp==="boolean";
  const open=isControlled?openProp:internalOpen;
  // Memoize the open-state bridge so click handlers and effects reuse one setter.
  const setOpen=useCallback(next=>{
    const value=typeof next==="function"?next(open):next;
    if(!isControlled)setInternalOpen(value);
    onOpenChange?.(value);
  },[open,isControlled,onOpenChange]);
  const unreadCount=friendRequests.length+invites.length;

  // Close the dropdown when the user clicks outside or presses Escape.
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
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-pink-200 bg-pink-100 text-zinc-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-200 hover:border-pink-400/20 hover:bg-purple-400/10 hover:text-zinc-800"
      >
        <Bell size={15}/>
        {/* The unread badge aggregates invite and friend-request items into one count. */}
        {unreadCount>0&&(
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-amber-100/40 bg-gradient-to-r from-pink-300 to-fuchsia-400 px-1 text-[10px] font-bold text-zinc-950 shadow-[0_10px_22px_rgba(251,146,60,0.24)]">
            {unreadCount>9?"9+":unreadCount}
          </span>
        )}
      </button>
      {open&&(
        <div className="fixed left-2 right-2 top-[4.6rem] z-50 rounded-[1.35rem] border border-pink-200 bg-white/95 p-2.5 shadow-[0_32px_100px_rgba(0,0,0,0.52)] backdrop-blur-2xl sm:absolute sm:left-auto sm:right-0 sm:top-auto sm:mt-3 sm:w-[21rem]">
          <div className="px-2.5 py-2 text-[11px] uppercase tracking-[0.24em] text-zinc-600">Notifications</div>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {/* Friend requests stay actionable inside the dropdown so users can accept without leaving the current room/lobby. */}
            {friendRequests.map(req=>(
              <div key={`fr-${req.uid}`} className="rounded-2xl border border-pink-200 bg-white/[0.03] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                <p className="text-xs leading-6 text-zinc-700">
                  <span className="font-semibold text-zinc-800">@{req.username||"user"}</span> sent you a friend request
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={()=>onAcceptFriendRequest?.(req.uid)}
                    disabled={!!friendRequestBusyByUid[req.uid]}
                    className="rounded-full bg-emerald-300 px-3 py-2 text-[11px] font-semibold text-zinc-950 transition-all duration-200 hover:-translate-y-0.5 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={()=>onDeclineFriendRequest?.(req.uid)}
                    disabled={!!friendRequestBusyByUid[req.uid]}
                    className="rounded-full border border-pink-200 bg-white/[0.04] px-3 py-2 text-[11px] text-zinc-800 transition-all duration-200 hover:border-purple-200 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
            {/* Room invites include the shared room code and jump straight into the room join flow. */}
            {invites.map(invite=>(
              <div key={invite.id} className="rounded-2xl border border-pink-400/12 bg-purple-400/[0.06] p-3">
                <p className="text-xs leading-6 text-zinc-700">
                  <span className="font-semibold text-zinc-800">{invite.fromUsername?`@${invite.fromUsername}`:invite.fromName}</span> invited you
                </p>
                <p className="mt-1 text-[11px] font-mono text-zinc-600">{invite.roomCode}</p>
                <button
                  type="button"
                  onClick={()=>onAcceptInvite?.(invite)}
                  className="mt-3 rounded-full bg-gradient-to-r from-pink-300 to-fuchsia-400 px-3 py-2 text-[11px] font-semibold text-zinc-950 transition-all duration-200 hover:-translate-y-0.5 hover:from-purple-300 hover:to-orange-200"
                >
                  Join room
                </button>
              </div>
            ))}
            {friendRequests.length===0&&invites.length===0&&(
              <p className="px-2.5 py-4 text-xs text-zinc-600">No new notifications</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default HeaderNotifications
