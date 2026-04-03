import { useCallback } from "react";
import { auth } from "../firebase.js";
import { SERVER_URL } from "../config/constants";

export function useApiClient() {
  const apiClient = useCallback(async(path,{method="GET",body}={})=>{
    // Centralized authenticated JSON fetch helper used by lobby/dashboard flows.
    const currentUser=auth.currentUser;
    if(!currentUser)throw new Error("Please sign in first");
    const token=await currentUser.getIdToken();
    const res=await fetch(`${SERVER_URL}${path}`,{
      method,
      headers:{
        Authorization:`Bearer ${token}`,
        "Content-Type":"application/json",
      },
      body:body?JSON.stringify(body):undefined,
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(data.error||data.message||`Request failed (${res.status})`);
    return data;
  }, []);

  return { apiClient }
}
