import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { SESSION_PRESET_MESSAGES } from "../config/roomModes";

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

export default PresetPanel
