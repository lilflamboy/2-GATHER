/**
 * The emoji picker is rendered in a portal instead of inline so it can float
 * above chat scroll containers without being clipped by overflow or stacking contexts.
 * The portal target is document.body.
 */
import { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";
import { QUICK_EMOJIS } from "../config/constants";

/**
 * Renders the quick-reaction tray plus the full emoji picker in a portal.
 * @param {{pos: {top: number, left: number}, onReact: (messageId: string, emoji: string) => void, onClose: () => void, messageId: string}} props - Portal position and reaction callbacks.
 * @returns {JSX.Element|null} The portal tree or null during SSR.
 */
function EmojiPickerPortal({pos,onReact,onClose,messageId}){
  // Store the portal root so outside-click detection can ignore internal taps.
  const ref=useRef(null);
  const [showFull,setShowFull]=useState(false);
  // Close the picker when the user clicks or taps anywhere outside the portal.
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

  // Normalize emoji-mart's object payload down to the native emoji string used in chat reactions.
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
      className="flex flex-col items-start gap-2.5"
    >
      <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-zinc-950/95 px-2 py-1.5 shadow-[0_28px_80px_rgba(0,0,0,0.5)] backdrop-blur-xl">
        {/* Quick emojis keep the most common reactions one tap away. */}
        {QUICK_EMOJIS.map(e=>(
          <button key={e}
            onClick={()=>handlePick(e)}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-transparent text-xl transition-all duration-200 hover:border-amber-400/15 hover:bg-amber-500/10 active:scale-90">
            {e}
          </button>
        ))}
        <button
          onClick={()=>setShowFull(v=>!v)}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-lg text-zinc-200 transition-all duration-200 hover:border-violet-400/20 hover:bg-violet-500/10"
          title="More reactions"
        >
          +
        </button>
      </div>
      {/* The full picker is only mounted when requested to keep the chat UI light. */}
      {showFull&&(
        <div className="rounded-[1.4rem] border border-white/10 bg-zinc-950/95 p-2 shadow-[0_32px_100px_rgba(0,0,0,0.55)] backdrop-blur-xl">
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

export default EmojiPickerPortal
