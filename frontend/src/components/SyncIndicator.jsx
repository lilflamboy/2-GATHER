import { Clock } from "lucide-react";
import { fmt } from "../utils/media";

function SyncIndicator({memberTimes,myUid,videoLoaded}){
  if(!videoLoaded||Object.keys(memberTimes).length<2)return null;

  const times=Object.values(memberTimes);
  const maxTime=Math.max(...times.map(t=>t.time));
  const minTime=Math.min(...times.map(t=>t.time));
  const gap=maxTime-minTime;
  const inSync=gap<2;

  return(
    <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border
      ${inSync?"bg-green-950/40 text-green-400 border-green-800/40":"bg-red-950/40 text-red-400 border-red-800/50"}`}>
      <Clock size={10}/>
      <span className="font-mono">
        {inSync
          ? "In sync"
          : `${gap.toFixed(0)}s gap`
        }
      </span>
      {!inSync&&(
        <span className="hidden sm:inline text-[10px] opacity-70">
          · {Object.values(memberTimes).map(t=>`@${t.username} ${fmt(t.time)}`).join(" / ")}
        </span>
      )}
    </div>
  );
}

export default SyncIndicator
