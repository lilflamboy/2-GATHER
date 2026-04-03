/**
 * WebRTC call-state manager for Lumiere rooms. Calls use a mesh topology where
 * each participant connects to every other participant, while signaling flows
 * through the backend socket server and media itself remains peer-to-peer.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { ICE_CONFIG } from "../config/constants";

/**
 * Creates WebRTC call state plus peer-connection helpers for one room.
 * ICE/STUN settings are applied when each peer connection is created so
 * browsers can discover routable network paths before media flows directly.
 * @param {{ socket: any, roomCode: string, myUid: string, users: any[], addToast: (message: string, type?: string) => void }} deps - Hook dependencies.
 * @returns {{ inCall: boolean, micOn: boolean, camOn: boolean, localStreamRef: import('react').MutableRefObject<MediaStream | null>, remoteStreams: Record<string, MediaStream>, joinCall: (withVideo?: boolean) => Promise<void>, leaveCall: () => void, toggleMic: () => void, toggleCam: () => void }} Call state and actions.
 */
function useWebRTC({socket,roomCode,myUid,users,addToast}){
  const [inCall,setInCall]=useState(false);
  const [micOn,setMicOn]=useState(true);
  const [camOn,setCamOn]=useState(false);
  const localStreamRef=useRef(null);
  const peerConnsRef=useRef({});
  const remoteStreamsRef=useRef({});
  const [remoteStreams,setRemoteStreams]=useState({});
  const refresh=useCallback(()=>setRemoteStreams({...remoteStreamsRef.current}),[]);
  const isMountedRef=useRef(true);

  // Track mount state so late getUserMedia resolutions do not update an unmounted component.
  useEffect(()=>()=>{isMountedRef.current=false;},[]);

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
   * Requests local media, enters call state, and starts peer negotiation.
   * @param {boolean} [withVideo=true] - Whether to request video in addition to audio.
   * @returns {Promise<void>} Resolves after local media is ready and signaling begins.
   */
  const joinCall=useCallback(async(withVideo=true)=>{
    // getUserMedia requires HTTPS (or localhost) — give clear guidance on mobile
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
      addToast("Video calls need HTTPS. On mobile, use https:// or the desktop for now.","error");
      return;
    }
    try{
      // Try video first, fall back to audio-only if camera fails
      let stream;
      try{
        stream=await navigator.mediaDevices.getUserMedia({audio:true,video:withVideo});
      }catch(videoErr){
        if(withVideo){
          addToast("Camera unavailable, joining with audio only","info");
          stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
          withVideo=false;
        }else throw videoErr;
      }
      if(!isMountedRef.current){
        stream?.getTracks().forEach(t=>t.stop());
        return;
      }
      // Once local media exists, proactively create offers only for the uids
      // this client "owns" according to shouldInitiateForUid().
      localStreamRef.current=stream;setCamOn(withVideo);setMicOn(true);setInCall(true);
      socket.emit("call_joined",{roomCode});
      users.forEach(u=>{
        if(u.uid!==myUid&&shouldInitiateForUid(u.uid)){
          createPeer(u.uid,true);
        }
      });
    }catch(err){
      if(err.name==="NotAllowedError"){
        addToast("Permission denied — allow mic/camera in browser settings","error");
      }else if(err.name==="NotFoundError"){
        addToast("No microphone found on this device","error");
      }else{
        addToast("Call error: "+err.message+". Needs HTTPS on mobile.","error");
      }
    }
  },[socket,roomCode,users,myUid,createPeer,addToast,shouldInitiateForUid]);

  /**
   * Leaves the current call by stopping local tracks, closing peer connections,
   * clearing remote streams, and notifying the room over sockets.
   * @returns {void}
   */
  const leaveCall=useCallback(()=>{
    const hadActiveCall=!!localStreamRef.current||Object.keys(peerConnsRef.current).length>0||inCall;
    localStreamRef.current?.getTracks().forEach(t=>t.stop());
    localStreamRef.current=null;
    Object.values(peerConnsRef.current).forEach(pc=>pc.close());
    peerConnsRef.current={};remoteStreamsRef.current={};
    setRemoteStreams({});setInCall(false);
    if(hadActiveCall)socket.emit("call_left",{roomCode});
  },[socket,roomCode,inCall]);

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
      if(!inCall)return;
      const existing=peerConnsRef.current[fromUid];
      const isGlare=existing&&existing.signalingState!=="stable";
      // On simultaneous renegotiation, one side backs off deterministically and
      // lets the higher-priority initiator keep the active offer.
      if(isGlare&&shouldInitiateForUid(fromUid)){
        return;
      }
      const pc=createPeer(fromUid,false,{replace:isGlare});
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const ans=await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit("webrtc_answer",{roomCode,answer:ans,targetUid:fromUid});
    };
    // Incoming answers finalize the remote description on the pending peer connection.
    const onAnswer=async({answer,fromUid})=>{const pc=peerConnsRef.current[fromUid];if(pc)await pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(()=>{});};
    // ICE candidates can arrive many times during setup, so each one is applied as it arrives.
    const onIce=async({candidate,fromUid})=>{const pc=peerConnsRef.current[fromUid];if(pc&&candidate)await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(()=>{});};
    // Peer join/leave signals keep the mesh aligned with the room's active call membership.
    const onPeerJoined=({uid:pUid,name:pName})=>{
      addToast(`${pName||"Friend"} joined the call`,"info");
      if(inCall&&shouldInitiateForUid(pUid)){
        createPeer(pUid,true);
      }
    };
    const onPeerLeft=({uid:pUid})=>{peerConnsRef.current[pUid]?.close();delete peerConnsRef.current[pUid];delete remoteStreamsRef.current[pUid];refresh();};
    socket.on("webrtc_offer",onOffer);socket.on("webrtc_answer",onAnswer);
    socket.on("webrtc_ice_candidate",onIce);socket.on("peer_joined_call",onPeerJoined);socket.on("peer_left_call",onPeerLeft);
    return()=>{socket.off("webrtc_offer",onOffer);socket.off("webrtc_answer",onAnswer);socket.off("webrtc_ice_candidate",onIce);socket.off("peer_joined_call",onPeerJoined);socket.off("peer_left_call",onPeerLeft);};
  },[socket,inCall,createPeer,roomCode,addToast,refresh,shouldInitiateForUid]);

  // Always tear down active media and peer connections when the room view unmounts.
  useEffect(()=>()=>{leaveCall();},[leaveCall]);
  return{inCall,micOn,camOn,localStreamRef,remoteStreams,joinCall,leaveCall,toggleMic,toggleCam};
}

export default useWebRTC
