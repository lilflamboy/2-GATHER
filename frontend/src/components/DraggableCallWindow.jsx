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
      className={`absolute rounded-2xl overflow-hidden shadow-2xl border select-none transition-[transform,opacity,box-shadow] duration-200 ${
        isConnecting
          ?"border-amber-400/40 bg-zinc-950/95 shadow-[0_26px_70px_rgba(251,191,36,0.16)] ring-1 ring-amber-400/20"
          :"border-zinc-700/60 bg-zinc-900/95 shadow-[0_26px_70px_rgba(0,0,0,0.45)] ring-1 ring-black/20"
      }`}>
      <div onMouseDown={onDragStart} onTouchStart={onDragStart}
        className={`flex items-center justify-between px-3 py-2 cursor-grab active:cursor-grabbing border-b ${
          isConnecting
            ?"bg-zinc-900/95 border-amber-400/20"
            :"bg-zinc-800/90 border-zinc-700/40"
        }`}>
        <div className="flex items-center gap-2">
          <GripHorizontal size={13} className="text-zinc-500"/>
          {isConnecting
            ?<LoaderCircle size={13} className="text-amber-300 animate-spin"/>
            :<span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"/>
          }
          <span className={`text-xs font-medium ${isConnecting?"text-amber-100":"text-zinc-300"}`}>
            {isConnecting?"Starting Call":"Live Call"}
          </span>
          <span className="text-zinc-500 text-xs">{totalTiles}p</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={toggleMaximize}
            className="call-btn w-6 h-6 rounded-full bg-zinc-700 hover:bg-zinc-600 flex items-center justify-center text-zinc-300 text-[10px] transition-colors">
            {maximized?<Minimize size={12}/>:<Maximize size={12}/>}
          </button>
          <button onClick={()=>setMinimized(m=>!m)}
            className="call-btn w-5 h-5 rounded-full bg-zinc-700 hover:bg-zinc-600 flex items-center justify-center text-zinc-400 text-[10px] transition-colors">
            {minimized?"▲":"▼"}
          </button>
        </div>
      </div>
      {!minimized&&isConnecting&&(
        <div style={{height:size.h}} className="flex items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.16),_transparent_42%),linear-gradient(180deg,_rgba(12,10,9,0.98),_rgba(9,9,11,0.96))] px-5">
          <div className="max-w-xs text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-amber-400/30 bg-amber-300/10">
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
        <div style={{height:size.h,gridTemplateColumns:`repeat(${cols},1fr)`}} className="grid gap-1 p-1 bg-zinc-950">
          {/* Always render the local stream first so mic/cam toggles feel anchored to "you". */}
          <VideoTile stream={localStreamRef.current} name={myName} muted/>
          {remoteEntries.map(([uid,stream])=>{
            const u=users.find(x=>x.uid===uid);
            return<VideoTile key={uid} stream={stream} name={u?.name?.split(" ")[0]||"Friend"}/>;
          })}
          {/* An empty remote state keeps the call window useful before anyone else joins. */}
          {remoteEntries.length===0&&(
            <div className="flex items-center justify-center bg-zinc-900 rounded-xl">
              <span className="text-zinc-600 text-xs text-center px-3">Waiting for others<br/>to join…</span>
            </div>
          )}
        </div>
      )}
      <div className={`call-btn flex items-center justify-center gap-2 px-3 py-2 ${isConnecting?"bg-zinc-950/95":"bg-zinc-800/90"}`}>
        {isConnecting?(
          <>
            <span className="mr-auto text-[11px] text-zinc-400">Waiting for browser permission</span>
            <button onClick={onLeave}
              className="call-btn w-9 h-9 rounded-full bg-red-600 hover:bg-red-500 flex items-center justify-center text-white transition-colors">
              <PhoneOff size={15}/>
            </button>
          </>
        ):(
          <>
            <button onClick={onToggleMic}
              className={`call-btn w-9 h-9 rounded-full flex items-center justify-center transition-colors
                ${micOn?"bg-zinc-700 hover:bg-zinc-600 text-zinc-300":"bg-red-600 hover:bg-red-500 text-white"}`}>
              {micOn?<Mic size={15}/>:<MicOff size={15}/>}
            </button>
            <button onClick={onToggleCam}
              className={`call-btn w-9 h-9 rounded-full flex items-center justify-center transition-colors
                ${camOn?"bg-blue-600 hover:bg-blue-500 text-white":"bg-zinc-700 hover:bg-zinc-600 text-zinc-400"}`}>
              {camOn?<Video size={15}/>:<VideoOff size={15}/>}
            </button>
            <button onClick={onLeave}
              className="call-btn w-9 h-9 rounded-full bg-red-600 hover:bg-red-500 flex items-center justify-center text-white transition-colors">
              <PhoneOff size={15}/>
            </button>
          </>
        )}
      </div>
      {!minimized&&!isConnecting&&(
        <div onMouseDown={onResizeStart} onTouchStart={onResizeStart}
          className="absolute bottom-0 right-0 w-6 h-6 cursor-se-resize flex items-end justify-end p-1">
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-zinc-600">
            <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
      )}
    </div>
  );
}

export default DraggableCallWindow
