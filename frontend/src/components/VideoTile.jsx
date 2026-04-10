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
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[1.35rem] border border-white/10 bg-zinc-950 shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
      {/* Local tiles must stay muted to avoid echo/feedback loops for the current user. */}
      {stream
        ?<video ref={ref} autoPlay playsInline muted={muted} className="h-full w-full object-cover"/>
        :<div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-amber-400/18 bg-gradient-to-br from-amber-500/18 to-violet-500/12">
            <span className="font-bold text-amber-200">{name?.[0]?.toUpperCase()}</span>
          </div>
          <span className="text-xs text-zinc-500">{name}</span>
        </div>
      }
      <span className="absolute bottom-2 left-2 rounded-full border border-white/10 bg-black/55 px-2.5 py-1 text-[11px] text-white/85 backdrop-blur-sm">{name}{muted?" (you)":""}</span>
    </div>
  );
}

export default VideoTile
