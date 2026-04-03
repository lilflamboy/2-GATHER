import { useEffect, useRef } from "react";
import { auth } from "./firebase.js";
import DashboardView from "./views/DashboardView.jsx";
import Toasts from "./components/Toasts";
import UsernameSetup from "./components/UsernameSetup";
import RoomErrorBoundary from "./components/RoomErrorBoundary";
import LandingView from "./views/LandingView";
import VerifyEmailView from "./views/VerifyEmailView";
import RoomPendingView from "./views/RoomPendingView";
import LobbyView from "./views/LobbyView";
import RoomView from "./views/RoomView";
import useToast from "./hooks/useToast";
import { useApiClient } from "./hooks/useApiClient";
import { useSocket } from "./hooks/useSocket";
import { usePushNotifications } from "./hooks/usePushNotifications";
import { useFriends } from "./hooks/useFriends";
import { useLobbyStats } from "./hooks/useLobbyStats";
import { useRoomState } from "./hooks/useRoomState";
import { useRoomActions } from "./hooks/useRoomActions";
import { useAuthSession } from "./hooks/useAuthSession";

export default function App(){
  const { toasts, addToast, removeToast } = useToast();
  const { apiClient } = useApiClient();
  const room = useRoomState({ addToast });
  const pushNotifyRef = useRef(() => {});
  const socketApiRef = useRef({
    connectSocket: () => {},
    cleanupSocket: () => {},
    socketRef: { current: null },
  });
  const friends = useFriends({ apiClient, addToast });
  const lobbyStats = useLobbyStats({ addToast });
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
  const { browserPushEnabled, pushNotify, setPushNotifications } = usePushNotifications({
    addToast,
    avatarUrl: authSession.avatarUrl,
  });
  pushNotifyRef.current = pushNotify;

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
  socketApiRef.current = {
    connectSocket: socket.connectSocket,
    cleanupSocket: socket.cleanupSocket,
    socketRef: socket.socketRef,
  };

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

  if(authSession.authLoading)return(
    <div className="min-h-screen bg-screen flex items-center justify-center">
      <div className="grain-overlay"/><div className="relative z-10 text-amber-400 animate-pulse text-3xl">L</div>
    </div>
  );

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

  if(authSession.user&&authSession.needUsername){
    return<UsernameSetup displayName={authSession.user.displayName} onDone={authSession.handleUsernameSet}/>;
  }

  return(
    <>
      <Toasts toasts={toasts} removeToast={removeToast}/>
      {!authSession.user&&<LandingView addToast={addToast}/>}
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
      {authSession.user&&room.view==="room_pending"&&(
        <RoomPendingView
          label={room.roomPendingLabel}
          onCancel={()=>{
            room.setRoomPending(false);
            room.setView("lobby");
          }}
        />
      )}
      {authSession.user&&room.view==="room"&&!room.roomCode&&(
        <RoomPendingView
          label="Connecting to room..."
          onCancel={()=>{
            room.setRoomPending(false);
            room.setView("lobby");
          }}
        />
      )}
      {authSession.user&&room.view==="room"&&room.roomCode&&(
        <RoomErrorBoundary onReset={roomActions.handleLeave}>
          <RoomView user={authSession.user} username={authSession.username} socket={socket.socketRef.current}
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
