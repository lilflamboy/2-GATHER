/**
 * Authenticated API helper hook for Lumiere. This centralizes Firebase token
 * injection and consistent JSON request/response handling so screens can call
 * backend routes without duplicating fetch boilerplate.
 */

import { useCallback } from "react";
import { auth } from "../firebase.js";
import { buildApiUrl } from "../config/constants";

/**
 * Returns a memoized authenticated JSON fetch helper for backend API calls.
 * The helper fetches the latest Firebase ID token, merges request options,
 * serializes JSON bodies when present, and throws on non-OK responses so
 * callers can handle errors with normal `try/catch` flow.
 * `useCallback` keeps the helper stable for hooks/components that depend on it.
 * @returns {{ apiClient: (path: string, options?: { method?: string, body?: any, token?: string, forceTokenRefresh?: boolean }) => Promise<any> }} Memoized API client wrapper.
 */
export function useApiClient() {
  /**
   * Performs one authenticated JSON request against the Lumiere backend.
   * @param {string} path - API path relative to the configured backend base URL.
   * @param {{ method?: string, body?: any, token?: string, forceTokenRefresh?: boolean }} [options={}] - Request method, optional JSON body, and optional auth-token overrides.
   * @returns {Promise<any>} Parsed JSON response payload.
   */
  const apiClient = useCallback(async(path,{method="GET",body,token:tokenOverride,forceTokenRefresh=false}={})=>{
    // Centralized authenticated JSON fetch helper used by lobby/dashboard flows.
    const currentUser=auth.currentUser;
    if(!currentUser&&!tokenOverride)throw new Error("Please sign in first");
    const token=tokenOverride||await currentUser.getIdToken(forceTokenRefresh);
    const res=await fetch(buildApiUrl(path),{
      method,
      headers:{
        Authorization:`Bearer ${token}`,
        "Content-Type":"application/json",
      },
      body:body?JSON.stringify(body):undefined,
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok){
      const error = new Error(data.error||data.message||`Request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return data;
  }, []);

  return { apiClient }
}
