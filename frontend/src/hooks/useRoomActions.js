/**
 * High-level room actions exposed to the app shell. This hook turns UI intents
 * like create, join, leave, or invite into socket/API calls while `useRoomState`
 * owns the actual room-related state buckets that these actions update.
 */

import { useCallback } from "react";

import { normalizeCode } from "../utils/url";
import { clearSession } from "../utils/storage";

/**
 * Creates room-action helpers used by the lobby and room screens.
 * @param {object} deps - Hook dependencies including state setters, socket helpers, and API access.
 * @returns {{ handleCreateRoom: (options?: object) => void, handleJoinRoom: (code: string) => void, handleAcceptInvite: (invite: object) => void, handleOpenDashboard: (tab?: string) => void, handleInviteFriend: (friendUid: string) => Promise<void>, handleLeave: () => void }} Room action helpers.
 */
export function useRoomActions({
  addToast,
  apiClient,
  connectSocket,
  cleanupSocket,
  username,
  socketRef,
  view,
  roomCode,
  setView,
  setDashboardInitialTab,
  setRoomCode,
  setRoomUsers,
  setInitialMessages,
  setRoomType,
  setSessionMode,
  setRoomMoodTag,
  setRoomContentUrl,
  setRoomContentType,
  setRoomCreatedBy,
  setRoomMaxParticipants,
  setInitialVideoMetadata,
  setInitialAudioState,
  setInitialDocument,
  setInitialReadingState,
  setInitialReadingPage,
  setRoomPending,
  setRoomPendingLabel,
  setSavedCode,
  setIncomingInvites,
  pendingInviteFriendRef,
  roomPendingRef,
  startPendingTimer,
  clearPendingTimer,
}) {
  /**
   * Creates a room by emitting `create_room` over the active socket connection.
   * The server is expected to answer with an ack plus a later `room_joined`
   * snapshot if creation succeeds.
   * @param {object} [options={}] - Room creation options such as type, mode, mood, and content.
   * @returns {void}
   */
  const handleCreateRoom=useCallback((options={})=>{
    if(!socketRef.current||!socketRef.current.connected){
      addToast("Still connecting to server. Try again in a second.","error");
      return;
    }
    setRoomPendingLabel("Creating room...");
    setRoomPending(true);
    setView("room_pending");
    startPendingTimer("Creating room...");
    const payload={
      roomType:options.roomType||"friends",
      sessionMode:options.sessionMode||"watch",
      moodTag:options.moodTag||"",
      contentUrl:options.contentUrl||"",
      contentType:options.contentType||"unknown",
      maxParticipants:options.maxParticipants,
    };
    const socket=socketRef.current;
    // Use an ack/timeout pair so room creation failure is surfaced even when
    // the server never emits a separate error event.
    const emitWithAck=socket.timeout?socket.timeout(8000):socket;
    emitWithAck.emit("create_room",payload,(err,res)=>{
      if(!roomPendingRef.current)return;
      if(err){
        clearPendingTimer();
        setRoomPending(false);
        setView("lobby");
        addToast("Create room timed out. Please try again.","error");
        return;
      }
      if(res && res.ok===false){
        clearPendingTimer();
        setRoomPending(false);
        setView("lobby");
        addToast(res.error||"Failed to create room","error");
      }
    });
  },[addToast,startPendingTimer,clearPendingTimer]);

  /**
   * Joins an existing room after normalizing the room code to uppercase.
   * The socket ack handles immediate join failures while `room_joined` carries
   * the full room snapshot on success.
   * @param {string} code - User-entered room code.
   * @returns {void}
   */
  const handleJoinRoom=useCallback(code=>{
    if(!socketRef.current||!socketRef.current.connected){
      addToast("Still connecting to server. Try again in a second.","error");
      return;
    }
    setRoomPendingLabel("Joining room...");
    setRoomPending(true);
    setView("room_pending");
    startPendingTimer("Joining room...");
    const socket=socketRef.current;
    // Joining mirrors create-room behavior: the pending screen is driven by the
    // join ack rather than assuming a "room_joined" event will always arrive.
    const emitWithAck=socket.timeout?socket.timeout(8000):socket;
    emitWithAck.emit("join_room",{roomCode:normalizeCode(code)},(err,res)=>{
      if(!roomPendingRef.current)return;
      if(err){
        clearPendingTimer();
        setRoomPending(false);
        setView("lobby");
        addToast("Join room timed out. Please try again.","error");
        return;
      }
      if(res && res.ok===false){
        clearPendingTimer();
        setRoomPending(false);
        setView("lobby");
        addToast(res.error||"Could not join room","error");
      }
    });
  },[addToast,startPendingTimer,clearPendingTimer]);

  /**
   * Accepts a pending invite by removing it locally and joining the invite room.
   * @param {object} invite - Invite object containing at least an `id` and `roomCode`.
   * @returns {void}
   */
  const handleAcceptInvite=useCallback((invite)=>{
    setIncomingInvites(prev=>prev.filter(item=>item.id!==invite.id));
    handleJoinRoom(invite.roomCode);
  },[handleJoinRoom]);

  /**
   * Opens the dashboard/settings view on the requested initial tab.
   * @param {string} [tab="profile"] - Dashboard tab to preselect.
   * @returns {void}
   */
  const handleOpenDashboard=useCallback((tab="profile")=>{
    const nextTab=typeof tab==="string"&&tab?tab:"profile";
    setDashboardInitialTab(nextTab);
    setView("settings");
  },[]);

  /**
   * Sends a room invite to a friend, creating a room first when needed.
   * @param {string} friendUid - User id that should receive the invite.
   * @returns {Promise<void>} Resolves after the invite request or pending room-create flow is started.
   */
  const handleInviteFriend=useCallback(async(friendUid)=>{
    if(!friendUid)throw new Error("Invalid friend");

    if(roomCode&&view==="room"){
      await apiClient("/api/friends/invite-room",{
        method:"POST",
        body:{friendUid,roomCode},
      });
      addToast("Invite sent","success");
      return;
    }

    if(!socketRef.current||!socketRef.current.connected){
      throw new Error("Server is still connecting. Try again.");
    }

    // If the user is not already inside a room, create one first and send the
    // invite after the server confirms the room_joined snapshot.
    pendingInviteFriendRef.current=friendUid;
    socketRef.current.emit("create_room");
    addToast("Creating room and sending invite...","info");
  },[roomCode,view,apiClient,addToast]);

  /**
   * Leaves the current room and resets room-scoped frontend state before reconnecting the socket for lobby use.
   * @returns {void}
   */
  const handleLeave=useCallback(()=>{
    clearSession();setSavedCode(null);cleanupSocket();
    setRoomCode(null);setRoomUsers([]);setInitialMessages([]);setView("lobby");
    setRoomType("friends");setSessionMode("watch");setRoomMoodTag("");
    setRoomContentUrl("");setRoomContentType("unknown");setRoomCreatedBy("");
    setRoomMaxParticipants(6);setInitialVideoMetadata(null);setInitialAudioState(null);setInitialDocument(null);setInitialReadingState(null);setInitialReadingPage(1);
    setRoomPending(false);
    const token = localStorage.getItem("2-gather_token");
    if (token) connectSocket(token, username);
  },[cleanupSocket,connectSocket,username]);

  return {
    handleCreateRoom,
    handleJoinRoom,
    handleAcceptInvite,
    handleOpenDashboard,
    handleInviteFriend,
    handleLeave,
  }
}
