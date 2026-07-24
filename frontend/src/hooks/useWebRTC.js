/**
 * WebRTC call-state manager for 2-GATHER rooms. Calls use a mesh topology where
 * each participant connects to every other participant, while signaling flows
 * through the backend socket server and media itself remains peer-to-peer.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { ICE_CONFIG } from "../config/constants";

const MEDIA_PERMISSION_TIMEOUT_MS = 10000;

/**
 * Creates WebRTC call state plus peer-connection helpers for one room.
 * ICE/STUN settings are applied when each peer connection is created so
 * browsers can discover routable network paths before media flows directly.
 * @param {{ socket: any, roomCode: string, myUid: string, users: any[], addToast: (message: string, type?: string) => void }} deps - Hook dependencies.
 * @returns {{ inCall: boolean, micOn: boolean, camOn: boolean, localStreamRef: import('react').MutableRefObject<MediaStream | null>, remoteStreams: Record<string, MediaStream>, joinCall: (withVideo?: boolean) => Promise<void>, leaveCall: () => void, toggleMic: () => void, toggleCam: () => void }} Call state and actions.
 */
function useWebRTC({socket,roomCode,myUid,users,addToast}){
  const [inCall,setInCall]=useState(false);
  const [isJoiningCall,setIsJoiningCall]=useState(false);
  const [micOn,setMicOn]=useState(true);
  const [camOn,setCamOn]=useState(false);
  const localStreamRef=useRef(null);
  const inCallRef=useRef(false);
  const isJoiningCallRef=useRef(false);
  const joinAttemptRef=useRef(0);
  const peerConnsRef=useRef({});
  const pendingIceRef=useRef({});
  const remoteStreamsRef=useRef({});
  const [remoteStreams,setRemoteStreams]=useState({});
  const refresh=useCallback(()=>setRemoteStreams({...remoteStreamsRef.current}),[]);
  const isMountedRef=useRef(true);

  /**
   * Reads the browser-reported permission state for one media capability.
   * Some browsers do not support this Permissions API entry, so "unknown" is
   * returned in that case instead of failing the call flow.
   * @param {"camera"|"microphone"} name - Media permission to inspect.
   * @returns {Promise<"granted"|"denied"|"prompt"|"unknown">} Browser permission state.
   */
  const getPermissionState=useCallback(async(name)=>{
    try{
      if(!navigator.permissions?.query)return "unknown";
      const status=await navigator.permissions.query({name});
      return status?.state||"unknown";
    }catch{
      return "unknown";
    }
  },[]);

  /**
   * Requests local media but fails fast if the browser/OS never resolves the
   * permission request, which otherwise leaves the UI spinning forever.
   * @param {{ audio: boolean, video: boolean }} constraints - Media constraints to request.
   * @returns {Promise<MediaStream>} Acquired local media stream.
   */
  const requestMediaWithTimeout=useCallback(async(constraints)=>{
    let timeoutId;
    try{
      return await Promise.race([
        navigator.mediaDevices.getUserMedia(constraints),
        new Promise((_,reject)=>{
          timeoutId=window.setTimeout(()=>{
            const error=new Error("Timed out waiting for camera/microphone access");
            error.name="PermissionTimeoutError";
            reject(error);
          },MEDIA_PERMISSION_TIMEOUT_MS);
        }),
      ]);
    }finally{
      if(timeoutId)window.clearTimeout(timeoutId);
    }
  },[]);

  // Track mount state so late getUserMedia resolutions do not update an unmounted component.
  useEffect(()=>()=>{isMountedRef.current=false;},[]);
  // Keep a ref mirror so socket handlers can read the latest call state without
  // waiting for React to finish a re-render after join/leave.
  useEffect(()=>{inCallRef.current=inCall;},[inCall]);
  useEffect(()=>{isJoiningCallRef.current=isJoiningCall;},[isJoiningCall]);

  /**
   * Determines whether this client should own offer creation for a peer.
   * @param {string} targetUid - Remote peer uid being evaluated.
   * @returns {boolean} True when this client should initiate the offer.
   */
  const shouldInitiateForUid=useCallback((targetUid)=>{
    // Deterministic offer ownership avoids "glare", where both peers create
    // offers at the same time after joining the same call.
    return String(myUid||"")>String(targetUid||"");
  },[myUid]);

  /**
   * Creates or replaces one RTCPeerConnection for a remote user.
   * The initiator awaits `setLocalDescription()` before emitting its offer so
   * negotiation state is stable when the remote peer receives it.
   * @param {string} targetUid - Remote peer uid.
   * @param {boolean} isInitiator - Whether this side should create the SDP offer.
   * @param {{ replace?: boolean }} [options={}] - Whether to replace an existing connection.
   * @returns {RTCPeerConnection} Created or reused peer connection.
   */
  const createPeer=useCallback((targetUid,isInitiator,{replace=false}={})=>{
    const existing=peerConnsRef.current[targetUid];
    const existingUsable=existing&&!["closed","failed","disconnected"].includes(existing.connectionState);
    if(existingUsable&&!replace)return existing;
    if(existing)existing.close();

    // Each peer connection is keyed by remote uid so reconnection/replacement
    // can surgically swap one broken link without resetting the whole call.
    const pc=new RTCPeerConnection(ICE_CONFIG);
    localStreamRef.current?.getTracks().forEach(t=>pc.addTrack(t,localStreamRef.current));
    pc.ontrack=e=>{remoteStreamsRef.current[targetUid]=e.streams[0];refresh();};
    // ICE candidates arrive incrementally during negotiation, so each one is forwarded as it appears.
    pc.onicecandidate=e=>{if(e.candidate)socket.emit("webrtc_ice_candidate",{roomCode,candidate:e.candidate,targetUid});};
    pc.onconnectionstatechange=()=>{
      if(["disconnected","failed","closed"].includes(pc.connectionState)){
        delete remoteStreamsRef.current[targetUid];refresh();
      }
    };
    peerConnsRef.current[targetUid]=pc;
    if(isInitiator){
      pc.createOffer()
        .then(async o=>{
          await pc.setLocalDescription(o);
          socket.emit("webrtc_offer",{roomCode,offer:o,targetUid});
        })
        .catch(console.error);
    }
    return pc;
  },[socket,roomCode,refresh]);

  /**
   * Applies any ICE candidates that arrived before the peer connection was
   * fully ready to consume them.
   * @param {string} targetUid - Remote peer uid whose queued candidates should be flushed.
   * @param {RTCPeerConnection} pc - Peer connection that can now accept candidates.
   * @returns {Promise<void>} Resolves after all queued candidates are attempted.
   */
  const flushPendingIce=useCallback(async(targetUid,pc)=>{
    const pending=pendingIceRef.current[targetUid];
    if(!pc||!pc.remoteDescription||!pending?.length)return;
    delete pendingIceRef.current[targetUid];
    for(const candidate of pending){
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(()=>{});
    }
  },[]);

  /**
   * Requests local media, enters call state, and starts peer negotiation.
   * @param {boolean} [withVideo=true] - Whether to request video in addition to audio.
   * @returns {Promise<void>} Resolves after local media is ready and signaling begins.
   */
  const joinCall=useCallback(async(withVideo=true)=>{
    if(inCallRef.current||isJoiningCallRef.current)return;
    // getUserMedia requires HTTPS (or localhost) — give clear guidance on mobile
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
      addToast("Video calls need HTTPS. On mobile, use https:// or the desktop for now.","error");
      return;
    }
    const joinAttempt=joinAttemptRef.current+1;
    joinAttemptRef.current=joinAttempt;
    isJoiningCallRef.current=true;
    setIsJoiningCall(true);
    try{
      // Try video first, fall back to audio-only if camera fails
      let stream;
      try{
        stream=await requestMediaWithTimeout({audio:true,video:withVideo});
      }catch(videoErr){
        if(withVideo){
          addToast("Camera unavailable, joining with audio only","info");
          stream=await requestMediaWithTimeout({audio:true,video:false});
          withVideo=false;
        }else throw videoErr;
      }
      if(!isMountedRef.current){
        stream?.getTracks().forEach(t=>t.stop());
        return;
      }
      if(joinAttemptRef.current!==joinAttempt){
        stream?.getTracks().forEach(t=>t.stop());
        return;
      }
      // Once local media exists, proactively create offers only for the uids
      // this client "owns" according to shouldInitiateForUid().
      isJoiningCallRef.current=false;
      setIsJoiningCall(false);
      localStreamRef.current=stream;inCallRef.current=true;setCamOn(withVideo);setMicOn(true);setInCall(true);
      socket.emit("call_joined",{roomCode});
      users.forEach(u=>{
        if(u.uid!==myUid&&shouldInitiateForUid(u.uid)){
          createPeer(u.uid,true);
        }
      });
    }catch(err){
      if(joinAttemptRef.current===joinAttempt){
        isJoiningCallRef.current=false;
        setIsJoiningCall(false);
      }
      if(err.name==="PermissionTimeoutError"){
        const [cameraState,microphoneState]=await Promise.all([
          getPermissionState("camera"),
          getPermissionState("microphone"),
        ]);
        const browserGranted=(cameraState==="granted"||cameraState==="unknown")&&(microphoneState==="granted"||microphoneState==="unknown");
        if(browserGranted){
          addToast("Chrome allowed the site, but camera/mic access is still hanging. Check macOS Privacy & Security for Chrome, or close apps already using the camera/mic.","error");
        }else{
          addToast("Browser permission request did not finish. Check the camera/mic prompt and allow access, then try again.","error");
        }
      }else if(err.name==="NotAllowedError"){
        addToast("Permission denied — allow mic/camera in browser settings","error");
      }else if(err.name==="NotFoundError"){
        addToast("No microphone found on this device","error");
      }else if(err.name==="NotReadableError"||err.name==="TrackStartError"){
        addToast("Camera or microphone is busy in another app. Close Zoom/Meet/Photo Booth and try again.","error");
      }else{
        addToast("Call error: "+err.message+". Needs HTTPS on mobile.","error");
      }
    }
  },[socket,roomCode,users,myUid,createPeer,addToast,getPermissionState,requestMediaWithTimeout,shouldInitiateForUid]);

  /**
   * Leaves the current call by stopping local tracks, closing peer connections,
   * clearing remote streams, and notifying the room over sockets.
   * @returns {void}
   */
  const leaveCall=useCallback(()=>{
    joinAttemptRef.current+=1;
    const hadActiveCall=!!localStreamRef.current||Object.keys(peerConnsRef.current).length>0||inCallRef.current;
    localStreamRef.current?.getTracks().forEach(t=>t.stop());
    localStreamRef.current=null;
    Object.values(peerConnsRef.current).forEach(pc=>pc.close());
    isJoiningCallRef.current=false;
    inCallRef.current=false;
    peerConnsRef.current={};pendingIceRef.current={};remoteStreamsRef.current={};
    setRemoteStreams({});setIsJoiningCall(false);setInCall(false);
    if(hadActiveCall)socket.emit("call_left",{roomCode});
  },[socket,roomCode]);

  /**
   * Toggles the enabled state on the local microphone track.
   * @returns {void}
   */
  const toggleMic=useCallback(()=>{const t=localStreamRef.current?.getAudioTracks()[0];if(t){t.enabled=!t.enabled;setMicOn(t.enabled);}},[]);
  /**
   * Toggles the enabled state on the local camera track.
   * @returns {void}
   */
  const toggleCam=useCallback(()=>{const t=localStreamRef.current?.getVideoTracks()[0];if(t){t.enabled=!t.enabled;setCamOn(t.enabled);}},[]);

  useEffect(()=>{
    if(!socket)return;
    // Incoming offers create or replace a peer connection, then answer back through the signaling socket.
    const onOffer=async({offer,fromUid})=>{
      if(!inCallRef.current)return;
      const existing=peerConnsRef.current[fromUid];
      const isGlare=existing&&existing.signalingState!=="stable";
      // On simultaneous renegotiation, one side backs off deterministically and
      // lets the higher-priority initiator keep the active offer.
      if(isGlare&&shouldInitiateForUid(fromUid)){
        return;
      }
      const pc=createPeer(fromUid,false,{replace:isGlare});
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushPendingIce(fromUid,pc);
      const ans=await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit("webrtc_answer",{roomCode,answer:ans,targetUid:fromUid});
    };
    // Incoming answers finalize the remote description on the pending peer connection.
    const onAnswer=async({answer,fromUid})=>{
      const pc=peerConnsRef.current[fromUid];
      if(pc){
        await pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(()=>{});
        await flushPendingIce(fromUid,pc);
      }
    };
    // ICE candidates can arrive many times during setup, so each one is applied as it arrives.
    const onIce=async({candidate,fromUid})=>{
      const pc=peerConnsRef.current[fromUid];
      if(!candidate)return;
      if(!pc||!pc.remoteDescription){
        pendingIceRef.current[fromUid]=[...(pendingIceRef.current[fromUid]||[]),candidate];
        return;
      }
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(()=>{});
    };
    // Peer join/leave signals keep the mesh aligned with the room's active call membership.
    const onPeerJoined=({uid:pUid,name:pName})=>{
      addToast(`${pName||"Friend"} joined the call`,"info");
      if(inCallRef.current&&shouldInitiateForUid(pUid)){
        createPeer(pUid,true);
      }
    };
    const onPeerLeft=({uid:pUid})=>{
      peerConnsRef.current[pUid]?.close();
      delete peerConnsRef.current[pUid];
      delete pendingIceRef.current[pUid];
      delete remoteStreamsRef.current[pUid];
      refresh();
    };
    socket.on("webrtc_offer",onOffer);socket.on("webrtc_answer",onAnswer);
    socket.on("webrtc_ice_candidate",onIce);socket.on("peer_joined_call",onPeerJoined);socket.on("peer_left_call",onPeerLeft);
    return()=>{socket.off("webrtc_offer",onOffer);socket.off("webrtc_answer",onAnswer);socket.off("webrtc_ice_candidate",onIce);socket.off("peer_joined_call",onPeerJoined);socket.off("peer_left_call",onPeerLeft);};
  },[socket,createPeer,flushPendingIce,roomCode,addToast,refresh,shouldInitiateForUid]);

  // Always tear down active media and peer connections when the room view unmounts.
  useEffect(()=>()=>{leaveCall();},[leaveCall]);
  return{inCall,isJoiningCall,micOn,camOn,localStreamRef,remoteStreams,joinCall,leaveCall,toggleMic,toggleCam};
}

export default useWebRTC
