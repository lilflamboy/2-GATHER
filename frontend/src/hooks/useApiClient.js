/**
 * Authenticated API helper hook for Lumiere. This centralizes Firebase token
 * injection and consistent JSON request/response handling so screens can call
 * backend routes without duplicating fetch boilerplate.
 */

import { useCallback } from "react";
import { auth } from "../firebase.js";
import { buildApiUrl } from "../config/constants";

const RETRYABLE_STATUSES = new Set([401, 408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableApiError(error) {
  return (
    RETRYABLE_STATUSES.has(Number(error?.status)) ||
    error?.code === "REQUEST_TIMEOUT" ||
    error?.name === "TypeError"
  );
}

/**
 * Returns a memoized authenticated JSON fetch helper for backend API calls.
 * The helper fetches the latest Firebase ID token, merges request options,
 * serializes JSON bodies when present, and throws on non-OK responses so
 * callers can handle errors with normal `try/catch` flow.
 * `useCallback` keeps the helper stable for hooks/components that depend on it.
 * @returns {{ apiClient: (path: string, options?: { method?: string, body?: any, token?: string, forceTokenRefresh?: boolean, retryDelaysMs?: number[], timeoutMs?: number }) => Promise<any> }} Memoized API client wrapper.
 */
export function useApiClient() {
  const performRequest = useCallback(async(path,{
    method = "GET",
    body,
    token,
    timeoutMs = 0,
    allow401Retry = true,
  })=>{
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timeoutId = timeoutMs > 0 ? window.setTimeout(() => controller?.abort(), timeoutMs) : null;

    try{
      const res=await fetch(buildApiUrl(path),{
        method,
        headers:{
          Authorization:`Bearer ${token}`,
          "Content-Type":"application/json",
        },
        body:body?JSON.stringify(body):undefined,
        signal:controller?.signal,
      });
      const data=await res.json().catch(()=>({}));

      if(res.status===401&&allow401Retry&&auth.currentUser){
        const freshToken=await auth.currentUser.getIdToken(true);
        return performRequest(path,{
          method,
          body,
          token:freshToken,
          timeoutMs,
          allow401Retry:false,
        });
      }

      if(!res.ok){
        const error = new Error(data.error||data.message||`Request failed (${res.status})`);
        error.status = res.status;
        throw error;
      }

      return data;
    }catch(error){
      if(error?.name==="AbortError"){
        const timeoutError = new Error("Request timed out while waking up the server");
        timeoutError.status = 408;
        timeoutError.code = "REQUEST_TIMEOUT";
        throw timeoutError;
      }
      throw error;
    }finally{
      if(timeoutId!==null){
        window.clearTimeout(timeoutId);
      }
    }
  }, []);

  /**
   * Performs one authenticated JSON request against the Lumiere backend.
   * @param {string} path - API path relative to the configured backend base URL.
   * @param {{ method?: string, body?: any, token?: string, forceTokenRefresh?: boolean, retryDelaysMs?: number[], timeoutMs?: number }} [options={}] - Request method, optional JSON body, optional auth-token overrides, and retry/timeout controls for cold-start handling.
   * @returns {Promise<any>} Parsed JSON response payload.
   */
  const apiClient = useCallback(async(path,{
    method="GET",
    body,
    token:tokenOverride,
    forceTokenRefresh=false,
    retryDelaysMs=[],
    timeoutMs=0,
  }={})=>{
    // Centralized authenticated JSON fetch helper used by lobby/dashboard flows.
    const currentUser=auth.currentUser;
    if(!currentUser&&!tokenOverride)throw new Error("Please sign in first");
    let token=tokenOverride||await currentUser.getIdToken(forceTokenRefresh);
    let retryIndex=0;

    for(;;){
      try{
        return await performRequest(path,{method,body,token,timeoutMs});
      }catch(error){
        if(retryIndex>=retryDelaysMs.length||!isRetryableApiError(error)){
          throw error;
        }
        await sleep(retryDelaysMs[retryIndex]);
        retryIndex+=1;
        if(auth.currentUser){
          token=await auth.currentUser.getIdToken(true);
        }
      }
    }
  }, [performRequest]);

  return { apiClient }
}
