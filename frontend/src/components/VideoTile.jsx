/**
 * A video tile is one participant stream inside the floating call window.
 * The same component renders both the local camera preview and remote peer streams.
 */
import { useRef, useEffect } from "react";

/**
 * Renders one local or remote WebRTC video tile.
 * @param {{stream: MediaStream|null, name: string, muted?: boolean}} props - Media stream, display label, and mute flag.
 * @returns {JSX.Element} The participant tile.
 */
function VideoTile({stream,name,muted=false}){
  // Store the video element in a ref so the live MediaStream can be attached directly.
  const ref=useRef(null);
  // Attach the latest stream object to the underlying video element whenever it changes.
  useEffect(()=>{if(ref.current&&stream)ref.current.srcObject=stream;},[stream]);
  return(
    <div className="relative bg-zinc-900 rounded-xl overflow-hidden w-full h-full flex items-center justify-center border border-zinc-700/50">
      {/* Local tiles must stay muted to avoid echo/feedback loops for the current user. */}
      {stream
        ?<video ref={ref} autoPlay playsInline muted={muted} className="w-full h-full object-cover"/>
        :<div className="flex flex-col items-center gap-1">
          <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
            <span className="text-amber-400 font-bold">{name?.[0]?.toUpperCase()}</span>
          </div>
          <span className="text-zinc-500 text-xs">{name}</span>
        </div>
      }
      <span className="absolute bottom-1.5 left-2 text-xs text-white/80 bg-black/50 px-2 py-0.5 rounded-full">{name}{muted?" (you)":""}</span>
    </div>
  );
}

export default VideoTile
