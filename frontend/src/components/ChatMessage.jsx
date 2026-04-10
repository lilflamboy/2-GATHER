/**
 * ChatMessage renders one room timeline entry. Messages may be plain text,
 * bookmark jumps, system notices, or reactions attached to a normal message.
 */
import { useState, useRef, useEffect } from "react";
import EmojiPickerPortal from "./EmojiPickerPortal";

/**
 * Renders one chat row with avatar, message bubble, reactions, and optional bookmark behavior.
 * @param {{msg: object, myUid: string, onReact: (messageId: string, emoji: string) => void, onBookmarkSeek: (seekTime: number) => void, closePickerSignal: number}} props - Message data plus reaction/bookmark callbacks.
 * @returns {JSX.Element} The message row.
 */
function ChatMessage({msg,myUid,onReact,onBookmarkSeek,closePickerSignal}){
  // Local UI state tracks whether the picker is open and where the portal should anchor.
  const [showPicker,setShowPicker]=useState(false);
  const [pickerPos,setPickerPos]=useState({top:0,left:0});
  // avatarFailed flips on <img> error so the message falls back to initials instead of a broken icon.
  const [avatarFailed,setAvatarFailed]=useState(false);
  const bubbleRef=useRef(null);
  // Message type flags drive the specialized render branches below.
  const isMe=msg.uid===myUid;
  const isBookmark=msg.type==="bookmark";
  const isSystem=msg.type==="system";
  const canReact=!isSystem&&!isBookmark;
  const reactions=Object.entries(msg.reactions||{}).filter(([,uids])=>uids.length>0);
  const senderLabel=msg.senderUsername||msg.senderName||"user";
  const avatarInitial=(msg.senderName||msg.senderUsername||"U").trim()[0]?.toUpperCase()||"U";
  const hasAvatar=!!msg.photoURL&&!avatarFailed;
  const avatarEl=hasAvatar
    ?<img src={msg.photoURL} alt={senderLabel} onError={()=>setAvatarFailed(true)} className="h-8 w-8 rounded-full border border-white/10 object-cover shadow-[0_8px_20px_rgba(0,0,0,0.3)]"/>
    :<div className="flex h-8 w-8 items-center justify-center rounded-full border border-amber-400/18 bg-gradient-to-br from-amber-500/18 to-violet-500/12 text-[11px] font-semibold text-amber-200 shadow-[0_8px_20px_rgba(0,0,0,0.24)]">
      {avatarInitial}
    </div>;

  // Closing another picker anywhere in the chat increments closePickerSignal and collapses this one.
  useEffect(()=>{
    if(showPicker)setShowPicker(false);
  },[closePickerSignal]);

  // Reset the broken-avatar fallback if a fresher photo URL arrives for this message author.
  useEffect(()=>{
    setAvatarFailed(false);
  },[msg.photoURL]);

  // System messages render as timeline separators rather than regular speech bubbles.
  if(isSystem){
    const variant = msg.meta?.variant;
    const variantClass =
      variant === "offline"
        ? "border-red-500/20 bg-red-500/10 text-red-200"
        : variant === "waiting"
          ? "border-amber-400/20 bg-amber-500/10 text-amber-200"
          : "border-emerald-500/20 bg-emerald-500/10 text-emerald-200";
    return(
      <div className="flex items-center gap-2 my-1">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/10 to-white/16"/>
        <span className={`whitespace-nowrap rounded-full border px-3 py-1 text-[11px] font-medium tracking-[0.08em] ${variantClass}`}>
          {msg.text}
        </span>
        <div className="h-px flex-1 bg-gradient-to-r from-white/16 via-white/10 to-transparent"/>
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
        className={`group flex items-end gap-2.5 ${isMe?"justify-end":"justify-start"}`}
      >
        {!isMe&&avatarEl}
        <div className={`flex flex-col ${isMe?"items-end":"items-start"}`}>
          {/* Sender username — always show for others */}
          {!isMe&&(
            <span className="mb-1 ml-1 text-[11px] font-mono text-zinc-500">
              @{senderLabel}
            </span>
          )}

          <div className="flex items-center gap-2">
            {/* React button left of others' bubbles */}
            {!isMe&&canReact&&(
              <button onClick={openPicker}
                className="shrink-0 rounded-full border border-white/8 bg-white/[0.03] p-2 text-lg leading-none text-zinc-400 transition-all duration-200 hover:border-amber-400/18 hover:bg-amber-500/10 hover:text-amber-200">
                😊
              </button>
            )}

            {/* Message bubble */}
            <div
              onClick={isBookmark?()=>onBookmarkSeek(msg.meta?.seekTime):undefined}
              className={`max-w-[85%] break-words rounded-2xl border px-3.5 py-2.5 text-sm leading-7 shadow-[0_16px_42px_rgba(0,0,0,0.2)]
                ${isBookmark
                  ?"cursor-pointer border-amber-400/20 bg-amber-500/10 text-amber-100 transition-all duration-200 hover:border-amber-300/28 hover:bg-amber-500/16"
                  :isMe
                    ?"rounded-br-md border-amber-400/18 bg-gradient-to-br from-amber-500/18 to-orange-400/10 text-amber-50"
                    :"rounded-bl-md border-white/8 bg-white/[0.04] text-zinc-200"}`}>
              {isBookmark&&<span className="mr-1">📍</span>}
              {msg.text}
              {isBookmark&&<span className="ml-1.5 text-[10px] text-amber-200/55">↩ seek all</span>}
            </div>

            {/* React button right of my bubbles */}
            {isMe&&canReact&&(
              <button onClick={openPicker}
                className="shrink-0 rounded-full border border-white/8 bg-white/[0.03] p-2 text-lg leading-none text-zinc-400 transition-all duration-200 hover:border-amber-400/18 hover:bg-amber-500/10 hover:text-amber-200">
                😊
              </button>
            )}
          </div>

          {/* Reaction pills — shown below bubble */}
          {canReact&&reactions.length>0&&(
            <div className={`mt-2 flex flex-wrap items-center gap-1.5 ${isMe?"mr-10":"ml-10"}`}>
              {/* Reaction counts reflect the server-owned emoji map for this message. */}
              {reactions.map(([emoji,uids])=>(
                <button key={emoji} onClick={()=>onReact(msg.id,emoji)}
                  className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-all active:scale-95
                    ${uids.includes(myUid)
                      ?"border-amber-400/22 bg-amber-500/10 text-amber-100"
                      :"border-white/8 bg-white/[0.03] text-zinc-400 hover:border-white/16"}`}>
                  <span>{emoji}</span>
                  <span className="font-medium">{uids.length}</span>
                </button>
              ))}
            </div>
          )}

          <span className="mt-1 text-[10px] text-zinc-600">
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

export default ChatMessage
