/**
 * Friend-request state and actions for the frontend. This hook tracks the
 * incoming friend-request list plus helper actions for the friend-request state
 * machine: send, accept, reject, and silent refresh.
 */

import { useState, useCallback } from "react";
import { buildApiUrl } from "../config/constants";

/**
 * Creates friend-request state and actions used by the lobby, settings, and room UI.
 * @param {{ apiClient: (path: string, options?: object) => Promise<any>, addToast: (message: string, type?: string) => void }} deps - Hook dependencies.
 * @returns {object} Friend-request state plus request/response helpers.
 */
export function useFriends({ apiClient, addToast }) {
  const [incomingFriendRequests,setIncomingFriendRequests]=useState([]);
  const [friendRequestBusyByUid,setFriendRequestBusyByUid]=useState({});

  /**
   * Fetches the latest friend graph snapshot from the backend.
   * @param {string} token - Firebase ID token for the current user.
   * @returns {Promise<any>} Raw `/api/friends` payload.
   */
  const fetchFriendsSnapshot=useCallback(async(token)=>{
    const res=await fetch(buildApiUrl("/api/friends"),{
      headers:{Authorization:`Bearer ${token}`},
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.error||data.message||`Request failed (${res.status})`);
    return data;
  },[]);

  /**
   * Normalizes incoming friend-request rows into the UI shape used by the app.
   * @param {any[]} incoming - Raw incoming request rows from the API.
   * @returns {Array<{ uid: string, username: string, displayName: string, photoURL: string }>} Normalized incoming request list.
   */
  const normalizeIncomingFriendRequests=useCallback((incoming)=>{
    return (Array.isArray(incoming)?incoming:[]).map(item=>({
      uid:item?.uid||"",
      username:item?.username||"",
      displayName:item?.displayName||"Friend",
      photoURL:item?.photoURL||"",
    })).filter(item=>item.uid);
  },[]);

  /**
   * Refreshes the incoming friend-request list from the server.
   * @param {string} token - Firebase ID token for the current user.
   * @param {{ silent?: boolean }} [options={}] - Whether fetch failures should suppress toasts.
   * @returns {Promise<void>} Resolves after the local incoming-request state is refreshed.
   */
  const syncIncomingFriendRequests=useCallback(async(token,{silent=true}={})=>{
    try{
      const snapshot=await fetchFriendsSnapshot(token);
      setIncomingFriendRequests(normalizeIncomingFriendRequests(snapshot?.incomingRequests||[]));
    }catch(error){
      if(!silent){
        addToast(error.message||"Could not load friend requests","error");
      }
    }
  },[fetchFriendsSnapshot,normalizeIncomingFriendRequests,addToast]);

  /**
   * Accepts or rejects one incoming friend request and updates local state.
   * @param {string} requesterUid - User id of the original requester.
   * @param {"accept"|"reject"} action - Requested transition for the friend request.
   * @returns {Promise<void>} Resolves after the backend response and local state update.
   */
  const handleRespondFriendRequest=useCallback(async(requesterUid,action)=>{
    if(!requesterUid||!["accept","reject"].includes(action))return;
    const req=incomingFriendRequests.find(item=>item.uid===requesterUid);
    const label=req?.username?`@${req.username}`:req?.displayName||"friend";
    setFriendRequestBusyByUid(prev=>({...prev,[requesterUid]:true}));
    try{
      await apiClient("/api/friends/respond",{
        method:"POST",
        body:{requesterUid,action},
      });
      setIncomingFriendRequests(prev=>prev.filter(item=>item.uid!==requesterUid));
      if(action==="accept"){
        addToast(`You are now friends with ${label}`,"success");
      }else{
        addToast(`Friend request declined from ${label}`,"info");
      }
    }catch(error){
      addToast(error.message||"Could not update friend request","error");
    }finally{
      setFriendRequestBusyByUid(prev=>({...prev,[requesterUid]:false}));
    }
  },[incomingFriendRequests,apiClient,addToast]);

  /**
   * Sends a friend request and returns the backend status outcome.
   * Possible statuses include `requested`, `already_friends`,
   * `already_requested`, and `needs_accept`.
   * @param {string} targetUid - User id being requested.
   * @param {string} targetUsername - Username used for toast labels when present.
   * @param {string} targetName - Display name fallback used for toast labels.
   * @returns {Promise<string>} Backend friend-request status string.
   */
  const handleSendFriendRequest=useCallback(async(targetUid,targetUsername,targetName)=>{
    if(!targetUid)throw new Error("Invalid user");
    const res=await apiClient("/api/friends/request",{method:"POST",body:{targetUid}});
    const status=String(res?.status||"requested");
    const label=targetUsername?`@${targetUsername}`:targetName||"friend";
    if(status==="requested"){
      addToast(`Friend request sent to ${label}`,"success");
    }else if(status==="already_friends"){
      addToast(`${label} is already your friend`,"info");
    }else if(status==="already_requested"){
      addToast(`Friend request already sent to ${label}`,"info");
    }else if(status==="needs_accept"){
      addToast(`${label} already sent you a request. Accept it in Settings > Friends.`,"info");
    }else{
      addToast(`Friend request status: ${status}`,"info");
    }
    return status;
  },[apiClient,addToast]);

  /**
   * Clears all local friend-request state, typically during sign-out.
   * @returns {void}
   */
  const resetFriendsState=useCallback(()=>{
    setIncomingFriendRequests([]);
    setFriendRequestBusyByUid({});
  },[]);

  return {
    incomingFriendRequests,
    setIncomingFriendRequests,
    friendRequestBusyByUid,
    syncIncomingFriendRequests,
    handleRespondFriendRequest,
    handleSendFriendRequest,
    resetFriendsState,
  }
}
