import { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";
import { QUICK_EMOJIS } from "../config/constants";

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

export default EmojiPickerPortal
