/**
 * App is the thin frontend entrypoint after the refactor. It delegates auth,
 * socket, room, friends, lobby stats, and toast state to hooks, then chooses
 * which top-level view to render based on the current session state.
 */
// React hooks used here only coordinate top-level lifecycle and cross-view wiring.
import { useEffect, useRef } from "react";
import "./App.css";
import lumiereLogo from "/lumiere-sync-logo.png";
// Firebase auth is read here so App can gate top-level views on the active session.
import { auth } from "./firebase.js";
// Views render the major application surfaces selected by the top-level state machine.
import DashboardView from "./views/DashboardView.jsx";
import LandingView from "./views/LandingView";
import VerifyEmailView from "./views/VerifyEmailView";
import RoomPendingView from "./views/RoomPendingView";
import LobbyView from "./views/LobbyView";
import RoomView from "./views/RoomView";
// Hooks encapsulate API auth, sockets, auth session state, lobby stats, and room orchestration.
import useToast from "./hooks/useToast";
import { useApiClient } from "./hooks/useApiClient";
import { useSocket } from "./hooks/useSocket";
import { usePushNotifications } from "./hooks/usePushNotifications";
import { useFriends } from "./hooks/useFriends";
import { useLobbyStats } from "./hooks/useLobbyStats";
import { useRoomState } from "./hooks/useRoomState";
import { useRoomActions } from "./hooks/useRoomActions";
import { useAuthSession } from "./hooks/useAuthSession";
// These small components stay in App because they frame every other view.
import Toasts from "./components/Toasts";
import UsernameSetup from "./components/UsernameSetup";
import RoomErrorBoundary from "./components/RoomErrorBoundary";

/**
 * Wires together the global hooks and selects the active top-level screen.
 * @returns {JSX.Element} The current app view plus the global toast layer.
 */
export default function App(){
  // Toast state is global so every view and hook can surface feedback consistently.
  const { toasts, addToast, removeToast } = useToast();
  // apiClient injects the Firebase token into authenticated REST calls.
  const { apiClient } = useApiClient();
  // Room state owns the current view, room snapshot, and pending-room transition data.
  const room = useRoomState({ addToast });
  // Refs let auth/session hooks call the latest push/socket functions without re-registering listeners.
  const pushNotifyRef = useRef(() => {});
  const socketApiRef = useRef({
    connectSocket: () => {},
    cleanupSocket: () => {},
    socketRef: { current: null },
  });
  // Friend and lobby-stat hooks feed lobby/dashboard surfaces and side panels.
  const friends = useFriends({ apiClient, addToast });
  const lobbyStats = useLobbyStats({ addToast });
  // Auth session decides whether the user sees login, email verification, username setup, lobby, or room screens.
  const authSession = useAuthSession({
    addToast,
    apiClient,
    socketApiRef,
    syncIncomingFriendRequests: friends.syncIncomingFriendRequests,
    syncLobbyMemoryStats: lobbyStats.syncLobbyMemoryStats,
    resetFriendsState: friends.resetFriendsState,
    resetLobbyMemoryStats: lobbyStats.resetLobbyMemoryStats,
    setView: room.setView,
    setRoomCode: room.setRoomCode,
    setRoomType: room.setRoomType,
    setSessionMode: room.setSessionMode,
    setRoomMoodTag: room.setRoomMoodTag,
    setRoomContentUrl: room.setRoomContentUrl,
    setRoomContentType: room.setRoomContentType,
    setRoomCreatedBy: room.setRoomCreatedBy,
    setRoomMaxParticipants: room.setRoomMaxParticipants,
    setInitialVideoMetadata: room.setInitialVideoMetadata,
    setInitialAudioState: room.setInitialAudioState,
    setInitialDocument: room.setInitialDocument,
    setInitialReadingState: room.setInitialReadingState,
    setInitialReadingPage: room.setInitialReadingPage,
    setIncomingInvites: room.setIncomingInvites,
    setSavedCode: room.setSavedCode,
  });
  // Browser push preference is kept separately because it depends on browser permission APIs.
  const { browserPushEnabled, pushNotify, setPushNotifications } = usePushNotifications({
    addToast,
    avatarUrl: authSession.avatarUrl,
  });
  pushNotifyRef.current = pushNotify;

  // The socket hook owns the single live Socket.IO connection shared across room flows.
  const socket = useSocket({
    addToast,
    apiClient,
    pushNotifyRef,
    clearPendingTimer: room.clearPendingTimer,
    roomPendingRef: room.roomPendingRef,
    pendingLabelRef: room.pendingLabelRef,
    pendingInviteFriendRef: room.pendingInviteFriendRef,
    setRoomPending: room.setRoomPending,
    setView: room.setView,
    setRoomCode: room.setRoomCode,
    setRoomUsers: room.setRoomUsers,
    setRoomType: room.setRoomType,
    setSessionMode: room.setSessionMode,
    setRoomMoodTag: room.setRoomMoodTag,
    setRoomContentUrl: room.setRoomContentUrl,
    setRoomContentType: room.setRoomContentType,
    setRoomCreatedBy: room.setRoomCreatedBy,
    setRoomMaxParticipants: room.setRoomMaxParticipants,
    setInitialVideoState: room.setInitialVideoState,
    setInitialAudioState: room.setInitialAudioState,
    setInitialMessages: room.setInitialMessages,
    setInitialVideoMetadata: room.setInitialVideoMetadata,
    setInitialDocument: room.setInitialDocument,
    setInitialReadingPage: room.setInitialReadingPage,
    setInitialReadingState: room.setInitialReadingState,
    setSavedCode: room.setSavedCode,
    setIncomingInvites: room.setIncomingInvites,
    setIncomingFriendRequests: friends.setIncomingFriendRequests,
  });
  // Expose the latest socket helpers to auth/session logic that may need to reconnect or clean up outside render.
  socketApiRef.current = {
    connectSocket: socket.connectSocket,
    cleanupSocket: socket.cleanupSocket,
    socketRef: socket.socketRef,
  };

  // Room actions translate lobby/dashboard button clicks into room joins, leaves, invites, and socket emits.
  const roomActions = useRoomActions({
    addToast,
    apiClient,
    connectSocket: socket.connectSocket,
    cleanupSocket: socket.cleanupSocket,
    username: authSession.username,
    socketRef: socket.socketRef,
    view: room.view,
    roomCode: room.roomCode,
    setView: room.setView,
    setDashboardInitialTab: room.setDashboardInitialTab,
    setRoomCode: room.setRoomCode,
    setRoomUsers: room.setRoomUsers,
    setInitialMessages: room.setInitialMessages,
    setRoomType: room.setRoomType,
    setSessionMode: room.setSessionMode,
    setRoomMoodTag: room.setRoomMoodTag,
    setRoomContentUrl: room.setRoomContentUrl,
    setRoomContentType: room.setRoomContentType,
    setRoomCreatedBy: room.setRoomCreatedBy,
    setRoomMaxParticipants: room.setRoomMaxParticipants,
    setInitialVideoMetadata: room.setInitialVideoMetadata,
    setInitialAudioState: room.setInitialAudioState,
    setInitialDocument: room.setInitialDocument,
    setInitialReadingState: room.setInitialReadingState,
    setInitialReadingPage: room.setInitialReadingPage,
    setRoomPending: room.setRoomPending,
    setRoomPendingLabel: room.setRoomPendingLabel,
    setSavedCode: room.setSavedCode,
    setIncomingInvites: room.setIncomingInvites,
    pendingInviteFriendRef: room.pendingInviteFriendRef,
    roomPendingRef: room.roomPendingRef,
    startPendingTimer: room.startPendingTimer,
    clearPendingTimer: room.clearPendingTimer,
  });

  // Refresh friend requests and lobby stats when an authenticated user lands back in the lobby.
  useEffect(()=>{
    if(!authSession.user||room.view!=="lobby")return;
    auth.currentUser?.getIdToken()
      .then(token=>{
        if(!token)return;
        friends.syncIncomingFriendRequests(token,{silent:true});
        lobbyStats.syncLobbyMemoryStats(token,{silent:true});
      })
      .catch(()=>{});
  },[authSession.user,room.view,friends.syncIncomingFriendRequests,lobbyStats.syncLobbyMemoryStats]);

  // The loading gate stays first so no intermediate auth view flashes before Firebase finishes restoring the session.
  if(authSession.authLoading)return(
    <div className="min-h-screen bg-screen flex items-center justify-center">
      <div className="grain-overlay"/>
      <div className="relative z-10 lumiere-loader">
        <img src={lumiereLogo} alt="Lumiere logo" className="lumiere-loader-logo"/>
        <p className="lumiere-loader-label">Connecting to the Light...</p>
      </div>
    </div>
  );

  // Email verification must take precedence over lobby/room rendering for unverified accounts.
  if(authSession.user&&authSession.emailVerificationRequired){
    return(
      <>
        <Toasts toasts={toasts} removeToast={removeToast}/>
        <VerifyEmailView
          user={authSession.user}
          onRefresh={authSession.handleRefreshVerification}
          onResend={authSession.handleResendVerification}
          onSignOut={authSession.handleSignOut}
          loading={authSession.verificationActionLoading}
        />
      </>
    );
  }

  // Username setup comes next because the app requires a permanent public username before entering the social flows.
  if(authSession.user&&authSession.needUsername){
    return<UsernameSetup displayName={authSession.user.displayName} onDone={authSession.handleUsernameSet}/>;
  }

  return(
      <>
      <Toasts toasts={toasts} removeToast={removeToast}/>
      {/* Signed-out users stay on the public landing/auth screen. */}
      {!authSession.user&&<LandingView addToast={addToast} brandLogo={lumiereLogo}/>}
      {/* The lobby is the authenticated home screen and the only place rooms are created or joined. */}
      {authSession.user&&room.view==="lobby"&&(
        <LobbyView avatarUrl={authSession.avatarUrl} username={authSession.username} onCreateRoom={roomActions.handleCreateRoom}
          onJoinRoom={roomActions.handleJoinRoom} onSignOut={authSession.handleSignOut} savedRoomCode={room.savedCode}
          socketConnected={socket.socketConnected} onOpenDashboard={roomActions.handleOpenDashboard}
          memoryStats={lobbyStats.lobbyMemoryStats}
          friendRequests={friends.incomingFriendRequests}
          friendRequestBusyByUid={friends.friendRequestBusyByUid}
          onRespondFriendRequest={friends.handleRespondFriendRequest}
          invites={room.incomingInvites} onAcceptInvite={roomActions.handleAcceptInvite}/>
      )}
      {/* Settings/dashboard is the account-management surface layered off the lobby. */}
      {authSession.user&&room.view==="settings"&&(
        <DashboardView
          username={authSession.username}
          apiClient={apiClient}
          onBack={()=>room.setView("lobby")}
          onSignOut={authSession.handleSignOut}
          onInviteFriend={roomActions.handleInviteFriend}
          invites={room.incomingInvites}
          onAcceptInvite={roomActions.handleAcceptInvite}
          addToast={addToast}
          onProfileUpdated={authSession.setProfile}
          activeRoomCode={room.roomCode}
          initialTab={room.dashboardInitialTab}
          pushEnabled={browserPushEnabled}
          onTogglePushNotifications={setPushNotifications}
          showMetadata={authSession.isAdmin}
        />
      )}
      {/* room_pending is the explicit transition state while create/join requests are in flight. */}
      {authSession.user&&room.view==="room_pending"&&(
        <RoomPendingView
          label={room.roomPendingLabel}
          onCancel={()=>{
            room.setRoomPending(false);
            room.setView("lobby");
          }}
        />
      )}
      {/* If the view says "room" but no room code exists yet, show a neutral connecting state instead of a broken room shell. */}
      {authSession.user&&room.view==="room"&&!room.roomCode&&(
        <RoomPendingView
          label="Connecting to room..."
          onCancel={()=>{
            room.setRoomPending(false);
            room.setView("lobby");
          }}
        />
      )}
      {/* Only RoomView is wrapped in an error boundary because it is the only high-complexity realtime surface with many async subsystems. */}
      {authSession.user&&room.view==="room"&&room.roomCode&&(
        <RoomErrorBoundary onReset={roomActions.handleLeave}>
          <RoomView user={authSession.user} username={authSession.username} avatarUrl={authSession.avatarUrl} socket={socket.socketRef.current}
            roomCode={room.roomCode} roomType={room.roomType} sessionMode={room.sessionMode} roomMoodTag={room.roomMoodTag}
            roomContentUrl={room.roomContentUrl} roomContentType={room.roomContentType} roomCreatedBy={room.roomCreatedBy}
            maxParticipants={room.roomMaxParticipants} initialUsers={room.roomUsers}
            initialVideoState={room.initialVideoState} initialAudioState={room.initialAudioState} initialMessages={room.initialMessages}
            initialVideoMetadata={room.initialVideoMetadata}
            initialDocument={room.initialDocument}
            initialReadingPage={room.initialReadingPage}
            initialReadingState={room.initialReadingState}
            onLeave={roomActions.handleLeave} addToast={addToast}
            onSendFriendRequest={friends.handleSendFriendRequest}
            onRespondFriendRequest={friends.handleRespondFriendRequest}
            onInviteFriend={roomActions.handleInviteFriend}
            friendRequests={friends.incomingFriendRequests}
            friendRequestBusyByUid={friends.friendRequestBusyByUid}
            invites={room.incomingInvites}
            onAcceptInvite={roomActions.handleAcceptInvite}
          />
        </RoomErrorBoundary>
      )}
    </>
  );
}
