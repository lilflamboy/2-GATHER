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
        className="relative inline-flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-800/80 border border-zinc-700 text-zinc-300 hover:text-zinc-100 transition-colors"
      >
        <Bell size={15}/>
        {/* The unread badge aggregates invite and friend-request items into one count. */}
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
            {/* Friend requests stay actionable inside the dropdown so users can accept without leaving the current room/lobby. */}
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
            {/* Room invites include the shared room code and jump straight into the room join flow. */}
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

export default HeaderNotifications
