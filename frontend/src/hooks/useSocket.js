import { useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";
import { SERVER_URL } from "../config/constants";
import { loadSession, saveSession, clearSession } from "../utils/storage";

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

  const cleanupSocket = useCallback(()=>{
    // App keeps a single Socket.IO client alive across screens. Reconnect paths
    // always start by removing listeners from the previous instance.
    if(socketRef.current){socketRef.current.removeAllListeners();socketRef.current.disconnect();socketRef.current=null;}
    setSocketConnected(false);
  },[]);

  const connectSocket = useCallback((token,uname)=>{
    cleanupSocket();
    const socket=io(SERVER_URL,{auth:{token,username:uname},reconnectionAttempts:10,reconnectionDelay:1000,transports:["websocket"]});
    socket.on("connect",()=>{
      setSocketConnected(true);
      const saved=loadSession();
      // Auto-rejoin only when the UI is not already in a pending create/join flow.
      if(saved && !roomPendingRef.current)socket.emit("join_room",{roomCode:saved});
    });
    socket.on("disconnect",()=>setSocketConnected(false));
    socket.on("connect_error",(err)=>{
      setSocketConnected(false);
      clearPendingTimer();
      if(roomPendingRef.current){
        setRoomPending(false);
        setView("lobby");
      }
      addToast(err?.message || "Connection error","error");
    });
    socket.on("room_joined",({
      roomCode:rc,
      users:u,
      videoState,
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
      setInitialVideoState(videoState||null);
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
    socket.on("host_transferred",({hostId})=>{
      if(hostId){
        setRoomCreatedBy(hostId);
      }
    });
    socket.on("friend_invite",(invite)=>{
      const id=`${invite.fromUid}-${invite.roomCode}-${invite.timestamp||Date.now()}`;
      setIncomingInvites(prev=>{
        if(prev.some(item=>item.id===id))return prev;
        return [{id,...invite},...prev].slice(0,8);
      });
      addToast(`Invite from ${invite.fromUsername?`@${invite.fromUsername}`:invite.fromName}`,"info");
      pushNotifyRef.current("Lumiere invite",`${invite.fromUsername?`@${invite.fromUsername}`:invite.fromName} invited you to room ${invite.roomCode}`);
    });
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
    socket.on("friend_added",({friend})=>{
      const label=friend?.username?`@${friend.username}`:friend?.displayName||"Friend";
      if(friend?.uid){
        setIncomingFriendRequests(prev=>prev.filter(item=>item.uid!==friend.uid));
      }
      addToast(`${label} is now your friend`,"success");
      pushNotifyRef.current("New friend",`${label} is now your friend on Lumiere`);
    });
    socket.on("couple_space_updated",({partnerUsername,partnerName,itemTitle,action})=>{
      const label=partnerUsername?`@${partnerUsername}`:partnerName||"Your partner";
      if(action==="remove"){
        addToast(`${label} removed "${itemTitle}" from your couple watchlist`,"info");
      }else{
        addToast(`${label} updated your couple watchlist`,"info");
      }
      pushNotifyRef.current("Couple Space updated",`${label} updated your private watchlist`);
    });
    socket.on("shared_memory_added",({fromUsername,fromName,roomCode:rc})=>{
      const label=fromUsername?`@${fromUsername}`:fromName||"Your friend";
      const suffix=rc?` in room ${rc}`:"";
      addToast(`${label} saved a shared memory${suffix}`,"success");
      pushNotifyRef.current("Shared memory saved",`${label} saved a shared memory${suffix}`);
    });
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
