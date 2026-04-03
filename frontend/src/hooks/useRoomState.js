import { useState, useEffect, useRef, useCallback } from "react";

export function useRoomState({ addToast }) {
  const [view,setView]=useState("lobby");
  const [dashboardInitialTab,setDashboardInitialTab]=useState("profile");
  const [roomCode,setRoomCode]=useState(null);
  const [roomType,setRoomType]=useState("friends");
  const [sessionMode,setSessionMode]=useState("watch");
  const [roomMoodTag,setRoomMoodTag]=useState("");
  const [roomContentUrl,setRoomContentUrl]=useState("");
  const [roomContentType,setRoomContentType]=useState("unknown");
  const [roomCreatedBy,setRoomCreatedBy]=useState("");
  const [roomMaxParticipants,setRoomMaxParticipants]=useState(6);
  const [roomUsers,setRoomUsers]=useState([]);
  const [initialVideoState,setInitialVideoState]=useState(null);
  const [initialAudioState,setInitialAudioState]=useState(null);
  const [initialMessages,setInitialMessages]=useState([]);
  const [initialVideoMetadata,setInitialVideoMetadata]=useState(null);
  const [initialDocument,setInitialDocument]=useState(null);
  const [initialReadingPage,setInitialReadingPage]=useState(1);
  const [initialReadingState,setInitialReadingState]=useState(null);
  const [roomPending,setRoomPending]=useState(false);
  const [roomPendingLabel,setRoomPendingLabel]=useState("Creating room...");
  const [savedCode,setSavedCode]=useState(null);
  const [incomingInvites,setIncomingInvites]=useState([]);
  const pendingInviteFriendRef=useRef(null);
  const roomPendingRef=useRef(false);
  const pendingTimeoutRef=useRef(null);
  const pendingLabelRef=useRef("");

  const clearPendingTimer=useCallback(()=>{
    if(pendingTimeoutRef.current){
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current=null;
    }
  },[]);

  const startPendingTimer=useCallback((label)=>{
    // Pending screens always need a timeout path so a lost socket ack does not
    // strand the user forever on "creating" or "joining".
    clearPendingTimer();
    pendingLabelRef.current=label;
    pendingTimeoutRef.current=setTimeout(()=>{
      setRoomPending(prev=>{
        if(!prev)return prev;
        setView("lobby");
        addToast(`${pendingLabelRef.current} timed out. Please try again.`,"error");
        return false;
      });
    },12000);
  },[clearPendingTimer,addToast]);

  useEffect(()=>()=>{clearPendingTimer();},[clearPendingTimer]);
  useEffect(()=>{
    if(!roomPending)clearPendingTimer();
  },[roomPending,clearPendingTimer]);
  useEffect(()=>{
    if(roomPendingLabel)pendingLabelRef.current=roomPendingLabel;
  },[roomPendingLabel]);
  useEffect(()=>{
    roomPendingRef.current=roomPending;
  },[roomPending]);

  return {
    view,
    setView,
    dashboardInitialTab,
    setDashboardInitialTab,
    roomCode,
    setRoomCode,
    roomType,
    setRoomType,
    sessionMode,
    setSessionMode,
    roomMoodTag,
    setRoomMoodTag,
    roomContentUrl,
    setRoomContentUrl,
    roomContentType,
    setRoomContentType,
    roomCreatedBy,
    setRoomCreatedBy,
    roomMaxParticipants,
    setRoomMaxParticipants,
    roomUsers,
    setRoomUsers,
    initialVideoState,
    setInitialVideoState,
    initialAudioState,
    setInitialAudioState,
    initialMessages,
    setInitialMessages,
    initialVideoMetadata,
    setInitialVideoMetadata,
    initialDocument,
    setInitialDocument,
    initialReadingPage,
    setInitialReadingPage,
    initialReadingState,
    setInitialReadingState,
    roomPending,
    setRoomPending,
    roomPendingLabel,
    setRoomPendingLabel,
    savedCode,
    setSavedCode,
    incomingInvites,
    setIncomingInvites,
    pendingInviteFriendRef,
    roomPendingRef,
    pendingLabelRef,
    clearPendingTimer,
    startPendingTimer,
  }
}
