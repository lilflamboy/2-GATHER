/**
 * Preset messages are short canned chat lines grouped by session mode so the
 * room UI can offer one-tap reactions that fit watch, reading, study, or music sessions.
 */
import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { SESSION_PRESET_MESSAGES } from "../config/roomModes";

/**
 * Renders the preset message picker for the current session mode.
 * @param {{onSelect: (text: string) => void, onClose: () => void, sessionMode?: string}} props - Session mode plus selection/close callbacks.
 * @returns {JSX.Element} The preset picker panel.
 */
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

  // Reset the category filter whenever the room switches to a different session mode.
  useEffect(()=>{
    setFilter("all");
  },[sessionMode]);
  return(
    <div className="border-t border-pink-200 bg-white/95 p-3 backdrop-blur-xl">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-600">Quick messages</span>
        <button onClick={onClose} className="rounded-full border border-pink-200 bg-white/[0.03] p-1.5 text-zinc-600 transition-all duration-200 hover:border-pink-300 hover:text-zinc-600"><X size={12}/></button>
      </div>
      {/* Category tabs */}
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        {cats.map(c=>(
          <button key={c.key} onClick={()=>setFilter(c.key)}
            className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs transition-all duration-200
              ${filter===c.key?"border-pink-400/20 bg-purple-400/10 text-purple-700":"border-pink-200 bg-white/[0.03] text-zinc-600 hover:border-pink-300 hover:text-zinc-600"}`}>
            {c.label}
          </button>
        ))}
      </div>
      {/* Messages grid */}
      <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto pr-1">
        {filtered.map((m,i)=>(
          <button key={i} onClick={()=>onSelect(m.text)}
            className="flex items-center gap-3 rounded-2xl border border-pink-200 bg-white/[0.03] px-3.5 py-3 text-left text-xs text-zinc-600 transition-all duration-200 hover:border-pink-400/15 hover:bg-purple-400/[0.08]">
            <span className="shrink-0 text-lg">{m.emoji}</span>
            <span className="leading-6">{m.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default PresetPanel
