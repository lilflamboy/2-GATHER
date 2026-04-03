/**
 * Central room-related UI state for the app shell. This hook owns the current
 * view, active room identity, initial room snapshot payloads, pending create/
 * join state, and invite-related state that other hooks read or mutate.
 */

import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Creates the app-shell room state buckets and pending-room helpers.
 * @param {{ addToast: (message: string, type?: string) => void }} deps - Hook dependencies.
 * @returns {object} Room-related state values, setters, refs, and pending helpers.
 */
export function useRoomState({ addToast }) {
  // Top-level app view and dashboard tab selection.
  const [view,setView]=useState("lobby"); // Current top-level app screen such as lobby, room, settings, or room_pending.
  const [dashboardInitialTab,setDashboardInitialTab]=useState("profile"); // Dashboard/settings tab to open when the dashboard view is shown.
  // Active room identity and mode metadata populated from room creation or join.
  const [roomCode,setRoomCode]=useState(null); // Active room code for the room currently open in the UI.
  const [roomType,setRoomType]=useState("friends"); // Backend room type label such as friends, family, or duo.
  const [sessionMode,setSessionMode]=useState("watch"); // Active session engine mode such as watch, music, reading, or study.
  const [roomMoodTag,setRoomMoodTag]=useState(""); // Optional room mood label selected at create time.
  const [roomContentUrl,setRoomContentUrl]=useState(""); // Current canonical content URL for the room.
  const [roomContentType,setRoomContentType]=useState("unknown"); // Current canonical content type for the room source.
  const [roomCreatedBy,setRoomCreatedBy]=useState(""); // Uid of the current room host/creator.
  const [roomMaxParticipants,setRoomMaxParticipants]=useState(6); // Max member count allowed for the active room.
  const [roomUsers,setRoomUsers]=useState([]); // Public member list currently shown in the room UI.
  // Initial room snapshot slices copied from the latest `room_joined` event.
  const [initialVideoState,setInitialVideoState]=useState(null); // Latest server-authored video sync state used to seed RoomView.
  const [initialAudioState,setInitialAudioState]=useState(null); // Latest server-authored music/audio state used to seed RoomView.
  const [initialMessages,setInitialMessages]=useState([]); // Recent room chat messages included in the join snapshot.
  const [initialVideoMetadata,setInitialVideoMetadata]=useState(null); // Current media/document metadata included in the join snapshot.
  const [initialDocument,setInitialDocument]=useState(null); // Current shared document payload for co-reading rooms.
  const [initialReadingPage,setInitialReadingPage]=useState(1); // Initial shared reading page to open on room load.
  const [initialReadingState,setInitialReadingState]=useState(null); // Full reading-state snapshot included in the join payload.
  // Pending create/join state used by the room-pending screen and timeout recovery.
  const [roomPending,setRoomPending]=useState(false); // Whether the UI is waiting on a create/join room response.
  const [roomPendingLabel,setRoomPendingLabel]=useState("Creating room..."); // Pending-screen label for the current create/join action.
  const [savedCode,setSavedCode]=useState(null); // Saved room code restored from session storage for reconnect flows.
  const [incomingInvites,setIncomingInvites]=useState([]); // Recent room invites shown in the lobby/settings UI.
  // Mutable refs coordinate delayed invite/create flows without triggering rerenders.
  const pendingInviteFriendRef=useRef(null); // Friend uid waiting for room creation before invite dispatch.
  const roomPendingRef=useRef(false); // Mutable mirror of `roomPending` for async socket callbacks.
  const pendingTimeoutRef=useRef(null); // Active timeout handle for create/join pending flows.
  const pendingLabelRef=useRef(""); // Mutable mirror of the latest pending-screen label.

  /**
   * Clears the active pending-room timeout if one exists.
   * @returns {void}
   */
  const clearPendingTimer=useCallback(()=>{
    if(pendingTimeoutRef.current){
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current=null;
    }
  },[]);

  /**
   * Starts the pending-room timeout shown during create/join flows.
   * @param {string} label - Pending action label such as "Creating room...".
   * @returns {void}
   */
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

  // Always cancel the timer on unmount so delayed callbacks do not fire after the app shell changes.
  useEffect(()=>()=>{clearPendingTimer();},[clearPendingTimer]);
  // If pending mode exits normally, cancel the timeout immediately.
  useEffect(()=>{
    if(!roomPending)clearPendingTimer();
  },[roomPending,clearPendingTimer]);
  // Mirror the latest pending label into a ref for timeout toasts.
  useEffect(()=>{
    if(roomPendingLabel)pendingLabelRef.current=roomPendingLabel;
  },[roomPendingLabel]);
  // Mirror pending boolean into a ref so async socket callbacks can read the latest value.
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
