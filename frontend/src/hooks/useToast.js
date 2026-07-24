/**
 * Toast state management for 2-GATHER's lightweight in-app notifications.
 * Toasts auto-dismiss after a short timeout so transient success/error/info
 * messages can appear without requiring manual cleanup every time.
 */

import { useState, useCallback } from "react";

/**
 * Creates toast state plus helpers to add and remove toast items.
 * Toast objects use the shape `{ id, message, type }`, and new toasts receive
 * a timestamp id plus an auto-dismiss timer so the UI stays self-cleaning.
 * @returns {{ toasts: Array<{ id: number, message: string, type: string }>, addToast: (message: string, type?: string) => void, removeToast: (id: number) => void }} Toast state and helpers.
 */
function useToast(){
  const [toasts,setToasts]=useState([]);
  /**
   * Adds one toast and schedules it for automatic removal.
   * @param {string} message - User-facing toast text.
   * @param {string} [type="info"] - Toast variant such as `info`, `success`, or `error`.
   * @returns {void}
   */
  const add=useCallback((message,type="info")=>{
    const id=Date.now();
    setToasts(p=>[...p,{id,message,type}]);
    setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)),4000);
  },[]);
  /**
   * Removes one toast by id.
   * @param {number} id - Toast id to remove.
   * @returns {void}
   */
  const remove=useCallback(id=>setToasts(p=>p.filter(t=>t.id!==id)),[]);
  return {toasts,addToast:add,removeToast:remove};
}

export default useToast
