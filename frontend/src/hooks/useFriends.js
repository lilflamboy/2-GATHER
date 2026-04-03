import { useState, useCallback } from "react";
import { SERVER_URL } from "../config/constants";

export function useFriends({ apiClient, addToast }) {
  const [incomingFriendRequests,setIncomingFriendRequests]=useState([]);
  const [friendRequestBusyByUid,setFriendRequestBusyByUid]=useState({});

  const fetchFriendsSnapshot=useCallback(async(token)=>{
    const res=await fetch(`${SERVER_URL}/api/friends`,{
      headers:{Authorization:`Bearer ${token}`},
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.error||data.message||`Request failed (${res.status})`);
    return data;
  },[]);

  const normalizeIncomingFriendRequests=useCallback((incoming)=>{
    return (Array.isArray(incoming)?incoming:[]).map(item=>({
      uid:item?.uid||"",
      username:item?.username||"",
      displayName:item?.displayName||"Friend",
      photoURL:item?.photoURL||"",
    })).filter(item=>item.uid);
  },[]);

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
