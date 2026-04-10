/**
 * The draggable call window renders the floating WebRTC call overlay so camera
 * feeds do not permanently cover the shared media. Users can drag, resize,
 * minimize, and maximize it while staying in the room.
 */
import { useRef, useState, useEffect } from "react";
import {
  GripHorizontal, Minimize, Maximize,
  LoaderCircle, Mic, MicOff, Video, VideoOff, PhoneOff,
} from "lucide-react";
import VideoTile from "./VideoTile";

/**
 * Renders the movable in-room call surface.
 * @param {{inCall: boolean, isConnecting?: boolean, micOn: boolean, camOn: boolean, localStreamRef: {current: MediaStream|null}, remoteStreams: Record<string, MediaStream>, users: Array, myUid: string, myName: string, onLeave: () => void, onToggleMic: () => void, onToggleCam: () => void, containerRef: {current: HTMLElement|null}}} props - Call state, stream refs, callbacks, and the viewport container.
 * @returns {JSX.Element} The floating call window.
 */
function DraggableCallWindow({inCall,isConnecting=false,micOn,camOn,localStreamRef,remoteStreams,users,myUid,myName,onLeave,onToggleMic,onToggleCam,containerRef}){
  // Refs store transient drag/resize geometry without forcing rerenders on every pointer move.
  const winRef=useRef(null);
  const dragRef=useRef(null);
  const resizeRef=useRef(null);
  const prevLayoutRef=useRef(null);
  const autoPlacedRef=useRef(false);
  // Position and size state drive the actual floating window layout.
  const [pos,setPos]=useState({x:16,y:16});
  const [size,setSize]=useState({w:340,h:240});
  const [minimized,setMinimized]=useState(false);
  const [maximized,setMaximized]=useState(false);

  // Drag start captures the offset between the pointer and the current window origin.
  const onDragStart=e=>{
    if(e.target.closest(".call-btn"))return;
    e.preventDefault();
    const cx=e.touches?e.touches[0].clientX:e.clientX;
    const cy=e.touches?e.touches[0].clientY:e.clientY;
    const rect=containerRef.current?.getBoundingClientRect()||{left:0,top:0};
    dragRef.current={ox:cx-rect.left-pos.x,oy:cy-rect.top-pos.y};
  };
  // Global move/up listeners keep dragging responsive even if the pointer leaves the header.
  useEffect(()=>{
    const onMove=e=>{
      if(!dragRef.current)return;
      const cx=e.touches?e.touches[0].clientX:e.clientX;
      const cy=e.touches?e.touches[0].clientY:e.clientY;
      const rect=containerRef.current?.getBoundingClientRect()||{left:0,top:0,width:window.innerWidth,height:window.innerHeight};
      setPos({x:Math.max(0,Math.min(cx-rect.left-dragRef.current.ox,rect.width-size.w)),y:Math.max(0,Math.min(cy-rect.top-dragRef.current.oy,rect.height-60))});
    };
    const onUp=()=>{dragRef.current=null;};
    window.addEventListener("mousemove",onMove);window.addEventListener("mouseup",onUp);
    window.addEventListener("touchmove",onMove,{passive:true});window.addEventListener("touchend",onUp);
    return()=>{window.removeEventListener("mousemove",onMove);window.removeEventListener("mouseup",onUp);window.removeEventListener("touchmove",onMove);window.removeEventListener("touchend",onUp);};
  },[size.w,containerRef]);

  // Re-clamp the window when the viewport changes or when the minimized width changes.
  useEffect(()=>{
    if(autoPlacedRef.current)return;
    const rect=containerRef.current?.getBoundingClientRect();
    if(!rect)return;
    autoPlacedRef.current=true;
    setPos({
      x:Math.max(0,rect.width-size.w-16),
      y:16,
    });
  },[containerRef,size.w]);

  useEffect(()=>{
    const clamp=()=>{
      const rect=containerRef.current?.getBoundingClientRect();
      if(!rect)return;
      setPos(prev=>({
        x:Math.max(0,Math.min(prev.x,rect.width-(minimized?200:size.w))),
        y:Math.max(0,Math.min(prev.y,rect.height-60)),
      }));
    };
    clamp();
    window.addEventListener("resize",clamp);
    return()=>window.removeEventListener("resize",clamp);
  },[size.w,size.h,minimized,containerRef]);

  // Resize start captures the pointer and current window dimensions.
  const onResizeStart=e=>{
    e.preventDefault();e.stopPropagation();
    const cx=e.touches?e.touches[0].clientX:e.clientX;
    const cy=e.touches?e.touches[0].clientY:e.clientY;
    resizeRef.current={sx:cx,sy:cy,sw:size.w,sh:size.h};
  };
  // Resize listeners track pointer movement outside the resize handle until release.
  useEffect(()=>{
    const onMove=e=>{
      if(!resizeRef.current)return;
      const cx=e.touches?e.touches[0].clientX:e.clientX;
      const cy=e.touches?e.touches[0].clientY:e.clientY;
      setSize({w:Math.max(220,resizeRef.current.sw+(cx-resizeRef.current.sx)),h:Math.max(160,resizeRef.current.sh+(cy-resizeRef.current.sy))});
    };
    const onUp=()=>{resizeRef.current=null;};
    window.addEventListener("mousemove",onMove);window.addEventListener("mouseup",onUp);
    window.addEventListener("touchmove",onMove,{passive:true});window.addEventListener("touchend",onUp);
    return()=>{window.removeEventListener("mousemove",onMove);window.removeEventListener("mouseup",onUp);window.removeEventListener("touchmove",onMove);window.removeEventListener("touchend",onUp);};
  },[]);

  // Derive the grid layout from the number of local + remote tiles currently active.
  const remoteEntries=Object.entries(remoteStreams);
  const totalTiles=1+remoteEntries.length;
  const cols=totalTiles<=1?1:totalTiles<=4?2:3;
  // Maximize remembers the old layout so restoring returns to the prior drag position.
  const toggleMaximize=()=>{
    const rect=containerRef.current?.getBoundingClientRect();
    if(!rect)return;
    if(!maximized){
      prevLayoutRef.current={pos,size};
      const nextW=Math.max(280,Math.min(rect.width-32,640));
      const nextH=Math.max(200,Math.min(rect.height-120,420));
      setSize({w:nextW,h:nextH});
      setPos({x:Math.max(0,rect.width-nextW-16),y:Math.max(0,rect.height-nextH-16)});
      setMinimized(false);
      setMaximized(true);
      return;
    }
    const prev=prevLayoutRef.current;
    if(prev){
      setPos(prev.pos);
      setSize(prev.size);
    }
    setMaximized(false);
  };

  return(
    <div ref={winRef} style={{left:pos.x,top:pos.y,width:minimized?200:size.w,zIndex:500}}
      className={`absolute select-none overflow-hidden rounded-[1.6rem] border shadow-[0_30px_90px_rgba(0,0,0,0.5)] transition-[transform,opacity,box-shadow] duration-200 ${
        isConnecting
          ?"border-amber-400/24 bg-zinc-950/95 shadow-[0_28px_80px_rgba(251,146,60,0.16)] ring-1 ring-amber-400/14"
          :"border-white/10 bg-zinc-950/95 shadow-[0_28px_80px_rgba(0,0,0,0.48)] ring-1 ring-black/20"
      }`}>
      <div onMouseDown={onDragStart} onTouchStart={onDragStart}
        className={`flex cursor-grab items-center justify-between border-b px-3.5 py-2.5 active:cursor-grabbing ${
          isConnecting
            ?"border-amber-400/14 bg-zinc-950/95"
            :"border-white/8 bg-zinc-900/92"
        }`}>
        <div className="flex items-center gap-2">
          <GripHorizontal size={13} className="text-zinc-500"/>
          {isConnecting
            ?<LoaderCircle size={13} className="text-amber-300 animate-spin"/>
            :<span className="h-2 w-2 rounded-full bg-emerald-300 animate-pulse"/>
          }
          <span className={`text-xs font-medium ${isConnecting?"text-amber-100":"text-zinc-200"}`}>
            {isConnecting?"Starting Call":"Live Call"}
          </span>
          <span className="text-xs text-zinc-500">{totalTiles}p</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={toggleMaximize}
            className="call-btn flex h-7 w-7 items-center justify-center rounded-full border border-white/8 bg-white/[0.04] text-[10px] text-zinc-300 transition-all duration-200 hover:border-white/16 hover:bg-white/[0.08]">
            {maximized?<Minimize size={12}/>:<Maximize size={12}/>}
          </button>
          <button onClick={()=>setMinimized(m=>!m)}
            className="call-btn flex h-6 w-6 items-center justify-center rounded-full border border-white/8 bg-white/[0.04] text-[10px] text-zinc-400 transition-all duration-200 hover:border-white/16 hover:bg-white/[0.08]">
            {minimized?"▲":"▼"}
          </button>
        </div>
      </div>
      {!minimized&&isConnecting&&(
        <div style={{height:size.h}} className="flex items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(251,146,60,0.16),_transparent_42%),linear-gradient(180deg,_rgba(12,10,9,0.98),_rgba(9,9,11,0.96))] px-5">
          <div className="max-w-xs text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-amber-400/20 bg-amber-300/10 shadow-[0_18px_40px_rgba(251,146,60,0.14)]">
              <LoaderCircle size={22} className="animate-spin text-amber-300"/>
            </div>
            <p className="text-sm font-semibold text-amber-100">Allow mic and camera to continue</p>
            <p className="mt-2 text-xs leading-6 text-zinc-400">
              Your floating call window opens here first, then your preview appears as soon as the browser grants access.
            </p>
          </div>
        </div>
      )}
      {!minimized&&!isConnecting&&(
        <div style={{height:size.h,gridTemplateColumns:`repeat(${cols},1fr)`}} className="grid gap-1.5 bg-zinc-950 p-1.5">
          {/* Always render the local stream first so mic/cam toggles feel anchored to "you". */}
          <VideoTile stream={localStreamRef.current} name={myName} muted/>
          {remoteEntries.map(([uid,stream])=>{
            const u=users.find(x=>x.uid===uid);
            return<VideoTile key={uid} stream={stream} name={u?.name?.split(" ")[0]||"Friend"}/>;
          })}
          {/* An empty remote state keeps the call window useful before anyone else joins. */}
          {remoteEntries.length===0&&(
            <div className="flex items-center justify-center rounded-[1.35rem] border border-white/8 bg-white/[0.03]">
              <span className="px-3 text-center text-xs leading-6 text-zinc-500">Waiting for others<br/>to join…</span>
            </div>
          )}
        </div>
      )}
      <div className={`call-btn flex items-center justify-center gap-2 border-t px-3.5 py-2.5 ${isConnecting?"border-amber-400/10 bg-zinc-950/95":"border-white/8 bg-zinc-900/92"}`}>
        {isConnecting?(
          <>
            <span className="mr-auto text-[11px] text-zinc-400">Waiting for browser permission</span>
            <button onClick={onLeave}
              className="call-btn flex h-10 w-10 items-center justify-center rounded-full bg-red-600 text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-red-500">
              <PhoneOff size={15}/>
            </button>
          </>
        ):(
          <>
            <button onClick={onToggleMic}
              className={`call-btn flex h-10 w-10 items-center justify-center rounded-full transition-all duration-200
                ${micOn?"border border-white/10 bg-white/[0.05] text-zinc-200 hover:border-white/18 hover:bg-white/[0.08]":"bg-red-600 text-white hover:bg-red-500"}`}>
              {micOn?<Mic size={15}/>:<MicOff size={15}/>}
            </button>
            <button onClick={onToggleCam}
              className={`call-btn flex h-10 w-10 items-center justify-center rounded-full transition-all duration-200
                ${camOn?"bg-violet-500 text-white hover:bg-violet-400":"border border-white/10 bg-white/[0.05] text-zinc-400 hover:border-white/18 hover:bg-white/[0.08]"}`}>
              {camOn?<Video size={15}/>:<VideoOff size={15}/>}
            </button>
            <button onClick={onLeave}
              className="call-btn flex h-10 w-10 items-center justify-center rounded-full bg-red-600 text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-red-500">
              <PhoneOff size={15}/>
            </button>
          </>
        )}
      </div>
      {!minimized&&!isConnecting&&(
        <div onMouseDown={onResizeStart} onTouchStart={onResizeStart}
          className="absolute bottom-0 right-0 flex h-7 w-7 cursor-se-resize items-end justify-end p-1.5">
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-zinc-600">
            <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
      )}
    </div>
  );
}

export default DraggableCallWindow
