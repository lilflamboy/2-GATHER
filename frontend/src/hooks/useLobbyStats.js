/**
 * Lobby memory-stat helpers for the signed-in dashboard. These stats summarize
 * recent watch history so the lobby can show shared hours, streak, and longest
 * session without needing a dedicated backend aggregate endpoint.
 */

import { useState, useCallback } from "react";
import { buildApiUrl } from "../config/constants";
import { formatDurationLabel } from "../utils/media";

/**
 * Creates lobby memory-stat state and refresh helpers.
 * @param {{ addToast: (message: string, type?: string) => void }} deps - Hook dependencies.
 * @returns {{ lobbyMemoryStats: object, syncLobbyMemoryStats: (token: string, options?: { silent?: boolean }) => Promise<void>, resetLobbyMemoryStats: () => void }} Lobby stat state and actions.
 */
export function useLobbyStats({ addToast }) {
  const [lobbyMemoryStats,setLobbyMemoryStats]=useState({
    sharedHoursMonth:0,
    longestSessionSeconds:0,
    longestSessionLabel:"0m",
    streakDays:0,
  });

  /**
   * Fetches recent completed watch sessions for client-side stat aggregation.
   * @param {string} token - Firebase ID token for the current user.
   * @param {number} [limit=120] - Max number of watch sessions to request.
   * @returns {Promise<any[]>} Array of recent watch-session rows.
   */
  const fetchWatchSessionsSnapshot=useCallback(async(token,limit=120)=>{
    const res=await fetch(buildApiUrl(`/api/watch-sessions?limit=${Math.max(1,Math.min(400,limit))}`),{
      headers:{Authorization:`Bearer ${token}`},
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.error||data.message||`Request failed (${res.status})`);
    return Array.isArray(data.items)?data.items:[];
  },[]);

  /**
   * Recomputes the lobby summary from recent watch sessions.
   * The derived stats include total shared hours in the last 30 days, longest
   * session length, and a simple consecutive-day streak from session end dates.
   * @param {string} token - Firebase ID token for the current user.
   * @param {{ silent?: boolean }} [options={}] - Whether fetch failures should suppress toasts.
   * @returns {Promise<void>} Resolves after local lobby stat state is refreshed.
   */
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

  /**
   * Clears lobby stats back to their empty-state defaults.
   * @returns {void}
   */
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
