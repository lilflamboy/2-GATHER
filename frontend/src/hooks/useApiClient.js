/**
 * Authenticated API helper hook for Lumiere. This centralizes Firebase token
 * injection and consistent JSON request/response handling so screens can call
 * backend routes without duplicating fetch boilerplate.
 */

import { useCallback } from "react";
import { auth } from "../firebase.js";
import { SERVER_URL } from "../config/constants";

/**
 * Returns a memoized authenticated JSON fetch helper for backend API calls.
 * The helper fetches the latest Firebase ID token, merges request options,
 * serializes JSON bodies when present, and throws on non-OK responses so
 * callers can handle errors with normal `try/catch` flow.
 * `useCallback` keeps the helper stable for hooks/components that depend on it.
 * @returns {{ apiClient: (path: string, options?: { method?: string, body?: any }) => Promise<any> }} Memoized API client wrapper.
 */
export function useApiClient() {
  /**
   * Performs one authenticated JSON request against the Lumiere backend.
   * @param {string} path - API path relative to `SERVER_URL`.
   * @param {{ method?: string, body?: any }} [options={}] - Request method and optional JSON body.
   * @returns {Promise<any>} Parsed JSON response payload.
   */
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
