/**
 * The sync indicator summarizes how closely room members are aligned on the
 * shared playback timeline. It compares member-reported playback times and
 * shows a warning when the gap grows beyond the acceptable threshold.
 */
import { Clock } from "lucide-react";
import { fmt } from "../utils/media";

/**
 * Renders the current playback-sync badge for the room.
 * @param {{memberTimes: Record<string, {username: string, time: number}>, myUid: string, videoLoaded: boolean}} props - Member time samples, local user id, and media-loaded state.
 * @returns {JSX.Element|null} The sync badge or nothing when sync data is incomplete.
 */
function SyncIndicator({memberTimes,myUid,videoLoaded}){
  if(!videoLoaded||Object.keys(memberTimes).length<2)return null;

  // memberTimes holds the latest heartbeat time for each active room member.
  const times=Object.values(memberTimes);
  const maxTime=Math.max(...times.map(t=>t.time));
  const minTime=Math.min(...times.map(t=>t.time));
  // The sync gap is the spread between the most advanced and least advanced viewers.
  const gap=maxTime-minTime;
  const inSync=gap<2;

  return(
    <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-[0_12px_30px_rgba(0,0,0,0.18)]
      ${inSync?"border-emerald-400/20 bg-emerald-500/10 text-emerald-600":"border-red-500/20 bg-red-500/10 text-red-600"}`}>
      <Clock size={11}/>
      <span className="font-mono">
        {inSync
          ? "In sync"
          : `${gap.toFixed(0)}s gap`
        }
      </span>
      {!inSync&&(
        <span className="hidden text-[10px] opacity-70 sm:inline">
          {/* Surface raw member time samples so the host can see who is behind. */}
          · {Object.values(memberTimes).map(t=>`@${t.username} ${fmt(t.time)}`).join(" / ")}
        </span>
      )}
    </div>
  );
}

export default SyncIndicator
