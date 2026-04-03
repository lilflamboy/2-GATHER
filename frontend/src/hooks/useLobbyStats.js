import { useState, useCallback } from "react";
import { SERVER_URL } from "../config/constants";
import { formatDurationLabel } from "../utils/media";

export function useLobbyStats({ addToast }) {
  const [lobbyMemoryStats,setLobbyMemoryStats]=useState({
    sharedHoursMonth:0,
    longestSessionSeconds:0,
    longestSessionLabel:"0m",
    streakDays:0,
  });

  const fetchWatchSessionsSnapshot=useCallback(async(token,limit=120)=>{
    const res=await fetch(`${SERVER_URL}/api/watch-sessions?limit=${Math.max(1,Math.min(400,limit))}`,{
      headers:{Authorization:`Bearer ${token}`},
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.error||data.message||`Request failed (${res.status})`);
    return Array.isArray(data.items)?data.items:[];
  },[]);

  const syncLobbyMemoryStats=useCallback(async(token,{silent=true}={})=>{
    try{
      const sessions=await fetchWatchSessionsSnapshot(token,180);
      const now=Date.now();
      const monthAgo=now-(30*24*60*60*1000);
      const dayKeys=new Set();
      let monthlySeconds=0;
      let longestSessionSeconds=0;

      // The lobby summary is derived client-side from recent sessions so the
      // dashboard can stay lightweight without a dedicated stats endpoint.
      sessions.forEach(item=>{
        const duration=Math.max(0,Number(item?.duration)||0);
        const endedAt=item?.endedAt?new Date(item.endedAt).getTime():0;
        if(endedAt>=monthAgo)monthlySeconds+=duration;
        if(duration>longestSessionSeconds)longestSessionSeconds=duration;
        if(endedAt){
          const d=new Date(endedAt);
          dayKeys.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`);
        }
      });

      const days=[...dayKeys].sort();
      let streakDays=0;
      if(days.length>0){
        streakDays=1;
        for(let idx=days.length-1;idx>0;idx-=1){
          const current=new Date(`${days[idx]}T00:00:00Z`).getTime();
          const previous=new Date(`${days[idx-1]}T00:00:00Z`).getTime();
          const diff=Math.round((current-previous)/86400000);
          if(diff===1)streakDays+=1;
          else break;
        }
      }

      setLobbyMemoryStats({
        sharedHoursMonth:Math.round((monthlySeconds/3600)*10)/10,
        longestSessionSeconds,
        longestSessionLabel:formatDurationLabel(longestSessionSeconds),
        streakDays,
      });
    }catch(error){
      if(!silent){
        addToast(error.message||"Could not load memory stats","error");
      }
    }
  },[fetchWatchSessionsSnapshot,addToast]);

  const resetLobbyMemoryStats=useCallback(()=>{
    setLobbyMemoryStats({
      sharedHoursMonth:0,
      longestSessionSeconds:0,
      longestSessionLabel:"0m",
      streakDays:0,
    });
  },[]);

  return { lobbyMemoryStats, syncLobbyMemoryStats, resetLobbyMemoryStats }
}
