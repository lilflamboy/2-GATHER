import { useState, useRef, useEffect } from "react";
import EmojiPickerPortal from "./EmojiPickerPortal";

function ChatMessage({msg,myUid,onReact,onBookmarkSeek,closePickerSignal}){
  const [showPicker,setShowPicker]=useState(false);
  const [pickerPos,setPickerPos]=useState({top:0,left:0});
  const [avatarFailed,setAvatarFailed]=useState(false);
  const bubbleRef=useRef(null);
  const isMe=msg.uid===myUid;
  const isBookmark=msg.type==="bookmark";
  const isSystem=msg.type==="system";
  const canReact=!isSystem&&!isBookmark;
  const reactions=Object.entries(msg.reactions||{}).filter(([,uids])=>uids.length>0);
  const senderLabel=msg.senderUsername||msg.senderName||"user";
  const avatarInitial=(msg.senderName||msg.senderUsername||"U").trim()[0]?.toUpperCase()||"U";
  const hasAvatar=!!msg.photoURL&&!avatarFailed;
  const avatarEl=hasAvatar
    ?<img src={msg.photoURL} alt={senderLabel} onError={()=>setAvatarFailed(true)} className="w-7 h-7 rounded-full border border-zinc-700 object-cover"/>
    :<div className="w-7 h-7 rounded-full bg-amber-500/20 border border-zinc-700 flex items-center justify-center text-[11px] text-amber-300 font-semibold">
      {avatarInitial}
    </div>;

  useEffect(()=>{
    if(showPicker)setShowPicker(false);
  },[closePickerSignal]);

  useEffect(()=>{
    setAvatarFailed(false);
  },[msg.photoURL]);

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

export default ChatMessage
