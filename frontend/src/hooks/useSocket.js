/**
 * Shared Socket.IO connection manager for the frontend. Lumiere keeps one live
 * socket client across screens, so this hook owns the singleton socket ref,
 * connection state, and the first layer of room/social event listeners.
 */

import { useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";
import { SERVER_URL } from "../config/constants";
import { loadSession, saveSession, clearSession } from "../utils/storage";

/**
 * Creates the singleton frontend socket connection and its core listeners.
 * `socketRef` is a ref instead of state so the mutable socket instance can be
 * replaced without rerendering on every internal Socket.IO change.
 * @param {object} deps - Hook dependencies including setters and side-effect helpers.
 * @returns {{ socketRef: import('react').MutableRefObject<any>, socketConnected: boolean, connectSocket: (token: string, uname: string) => void, cleanupSocket: () => void }} Socket state and lifecycle helpers.
 */
export function useSocket({
  addToast,
  apiClient,
  pushNotifyRef,
  clearPendingTimer,
  roomPendingRef,
  pendingLabelRef,
  pendingInviteFriendRef,
  setRoomPending,
  setView,
  setRoomCode,
  setRoomUsers,
  setRoomType,
  setSessionMode,
  setRoomMoodTag,
  setRoomContentUrl,
  setRoomContentType,
  setRoomCreatedBy,
  setRoomMaxParticipants,
  setInitialVideoState,
  setInitialAudioState,
  setInitialMessages,
  setInitialVideoMetadata,
  setInitialDocument,
  setInitialReadingPage,
  setInitialReadingState,
  setSavedCode,
  setIncomingInvites,
  setIncomingFriendRequests,
}) {
  const socketRef = useRef(null);
  const [socketConnected, setSocketConnected] = useState(false);

  /**
   * Explicitly tears down the current socket and removes all attached listeners.
   * @returns {void}
   */
  const cleanupSocket = useCallback(()=>{
    // App keeps a single Socket.IO client alive across screens. Reconnect paths
    // always start by removing listeners from the previous instance.
    if(socketRef.current){socketRef.current.removeAllListeners();socketRef.current.disconnect();socketRef.current=null;}
    setSocketConnected(false);
  },[]);

  /**
   * Opens a new authenticated socket connection and wires its event listeners.
   * The `io()` options attach the Firebase token and username, cap reconnect
   * attempts, and force websocket transport for stable realtime behavior.
   * @param {string} token - Firebase ID token used by backend socket auth.
   * @param {string} uname - Username sent alongside the auth payload.
   * @returns {void}
   */
  const connectSocket = useCallback((token,uname)=>{
    cleanupSocket();
    const socket=io(SERVER_URL,{auth:{token,username:uname},reconnectionAttempts:10,reconnectionDelay:1000,transports:["websocket"]});
    // `connect` marks the socket healthy and tries to restore the saved room in this tab.
    socket.on("connect",()=>{
      setSocketConnected(true);
      const saved=loadSession();
      // Auto-rejoin only when the UI is not already in a pending create/join flow.
      if(saved && !roomPendingRef.current)socket.emit("join_room",{roomCode:saved});
    });
    // `disconnect` only updates connectivity; room teardown is handled elsewhere.
    socket.on("disconnect",()=>setSocketConnected(false));
    // `connect_error` handles auth failures or transport failures before the room UI is entered.
    socket.on("connect_error",(err)=>{
      setSocketConnected(false);
      clearPendingTimer();
      if(roomPendingRef.current){
        setRoomPending(false);
        setView("lobby");
      }
      addToast(err?.message || "Connection error","error");
    });
    // `room_joined` is the authoritative room snapshot emitted by the backend after create/join/rejoin.
    socket.on("room_joined",({
      roomCode:rc,
      users:u,
      videoState,
      serverTime,
      audioState,
      mediaType,
      mediaMeta,
      messages:msgs,
      isRejoin,
      roomType:joinedRoomType,
      sessionMode:joinedSessionMode,
      moodTag:joinedMoodTag,
      contentUrl:joinedContentUrl,
      contentType:joinedContentType,
      createdBy:joinedCreatedBy,
      videoMetadata,
      document,
      readingState,
      maxParticipants,
      readingPage,
    })=>{
      // This event is the server's authoritative room snapshot. Hydrate all
      // room-scoped state from it so late joins and reconnects behave the same.
      const normalizedRoomCode=String(rc||"").trim();
      if(!normalizedRoomCode){
        clearPendingTimer();
        setRoomPending(false);
        setView("lobby");
        addToast("Room join failed. Please try again.","error");
        return;
      }
      setRoomCode(normalizedRoomCode);setRoomUsers(u||[]);
      setRoomType(joinedRoomType||"friends");
      setSessionMode(joinedSessionMode||"watch");
      setRoomMoodTag(joinedMoodTag||"");
      setRoomContentUrl(joinedContentUrl||mediaMeta?.url||videoMetadata?.contentUrl||"");
      setRoomContentType(joinedContentType||mediaType||videoMetadata?.sourceType||"unknown");
      setRoomCreatedBy(joinedCreatedBy||"");
      setRoomMaxParticipants(Math.max(2,Number(maxParticipants)||6));
      // Merge the server timestamp into the joined video state so RoomView can resync correctly after reconnects.
      setInitialVideoState(videoState?{...videoState,serverTime:Number(serverTime)||Date.now()/1000}:null);
      setInitialAudioState(audioState||null);
      setInitialMessages((msgs||[]).map(m=>({...m,reactions:m.reactions||{}})));
      setInitialVideoMetadata(videoMetadata?{...videoMetadata,fileFingerprint:videoMetadata.fileFingerprint||mediaMeta?.fileSignature||""}:null);
      setInitialDocument(document||null);
      setInitialReadingPage(Math.max(1,Math.floor(Number(readingPage)||1)));
      setInitialReadingState(readingState||null);
      setRoomPending(false);
      clearPendingTimer();
      saveSession(normalizedRoomCode);setView("room");
      setSavedCode(normalizedRoomCode);
      if(isRejoin)addToast("Rejoined — resuming from saved position","success");

      if(pendingInviteFriendRef.current){
        const friendUid=pendingInviteFriendRef.current;
        pendingInviteFriendRef.current=null;
        apiClient("/api/friends/invite-room",{
          method:"POST",
          body:{friendUid,roomCode:rc},
        })
          .then(()=>addToast("Invite sent to friend","success"))
          .catch(e=>addToast(e.message||"Failed to send invite","error"));
      }
    });
    // `host_transferred` updates host-only controls when ownership changes.
    socket.on("host_transferred",({hostId})=>{
      if(hostId){
        setRoomCreatedBy(hostId);
      }
    });
    // `friend_invite` inserts a new incoming invite and optionally triggers a browser notification.
    socket.on("friend_invite",(invite)=>{
      const id=`${invite.fromUid}-${invite.roomCode}-${invite.timestamp||Date.now()}`;
      setIncomingInvites(prev=>{
        if(prev.some(item=>item.id===id))return prev;
        return [{id,...invite},...prev].slice(0,8);
      });
      addToast(`Invite from ${invite.fromUsername?`@${invite.fromUsername}`:invite.fromName}`,"info");
      pushNotifyRef.current("Lumiere invite",`${invite.fromUsername?`@${invite.fromUsername}`:invite.fromName} invited you to room ${invite.roomCode}`);
    });
    // `friend_request_received` inserts a newly received friend request into local state.
    socket.on("friend_request_received",({from})=>{
      const label=from?.username?`@${from.username}`:from?.displayName||"A friend";
      if(from?.uid){
        setIncomingFriendRequests(prev=>{
          if(prev.some(item=>item.uid===from.uid))return prev;
          return [{
            uid:from.uid,
            username:from.username||"",
            displayName:from.displayName||"Friend",
            photoURL:from.photoURL||"",
          },...prev].slice(0,20);
        });
      }
      addToast(`${label} sent you a friend request`,"info");
      pushNotifyRef.current("Friend request",`${label} sent you a friend request`);
    });
    // `friend_added` removes any pending request and celebrates the accepted friendship.
    socket.on("friend_added",({friend})=>{
      const label=friend?.username?`@${friend.username}`:friend?.displayName||"Friend";
      if(friend?.uid){
        setIncomingFriendRequests(prev=>prev.filter(item=>item.uid!==friend.uid));
      }
      addToast(`${label} is now your friend`,"success");
      pushNotifyRef.current("New friend",`${label} is now your friend on Lumiere`);
    });
    // `couple_space_updated` announces shared watchlist changes made by the partner.
    socket.on("couple_space_updated",({partnerUsername,partnerName,itemTitle,action})=>{
      const label=partnerUsername?`@${partnerUsername}`:partnerName||"Your partner";
      if(action==="remove"){
        addToast(`${label} removed "${itemTitle}" from your couple watchlist`,"info");
      }else{
        addToast(`${label} updated your couple watchlist`,"info");
      }
      pushNotifyRef.current("Couple Space updated",`${label} updated your private watchlist`);
    });
    // `shared_memory_added` surfaces new shared memories in both toast and browser-notification form.
    socket.on("shared_memory_added",({fromUsername,fromName,roomCode:rc})=>{
      const label=fromUsername?`@${fromUsername}`:fromName||"Your friend";
      const suffix=rc?` in room ${rc}`:"";
      addToast(`${label} saved a shared memory${suffix}`,"success");
      pushNotifyRef.current("Shared memory saved",`${label} saved a shared memory${suffix}`);
    });
    // Generic socket `error` events handle backend failures that arrive outside the ack path.
    socket.on("error",({message})=>{
      const msg=message||"Error";
      const isRoomMissing=/room not found|expired/i.test(msg);
      const pendingJoin=roomPendingRef.current&&pendingLabelRef.current==="Joining room...";
      const pendingCreate=roomPendingRef.current&&pendingLabelRef.current==="Creating room...";
      if(isRoomMissing){
        clearSession();
        setSavedCode(null);
      }
      if(roomPendingRef.current){
        if(isRoomMissing&&pendingCreate){
          return;
        }
        clearPendingTimer();
        setRoomPending(false);
        setView("lobby");
      }
      if(isRoomMissing&&!pendingJoin)return;
      addToast(msg,"error");
    });
    socketRef.current=socket;
  },[cleanupSocket,addToast,apiClient,clearPendingTimer]);

  return { socketRef, socketConnected, connectSocket, cleanupSocket }
}
