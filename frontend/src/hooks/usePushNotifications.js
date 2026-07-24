/**
 * Browser push-notification preference management for 2-GATHER. This hook keeps
 * the browser permission flow and the locally stored opt-in preference in one
 * place so room, invite, and social toasts can optionally surface as system
 * notifications too.
 */

import { useState, useCallback } from "react";
import { loadPushPref, savePushPref } from "../utils/storage";

/**
 * Creates browser-push state plus helpers to show notifications and change the preference.
 * The preference is restored from local storage on mount and enabling push will
 * request browser permission when needed.
 * @param {{ addToast: (message: string, type?: string) => void, avatarUrl: string }} deps - Hook dependencies.
 * @returns {{ browserPushEnabled: boolean, pushNotify: (title: string, body: string) => void, setPushNotifications: (enabled: boolean) => Promise<boolean> }} Push state and helpers.
 */
export function usePushNotifications({ addToast, avatarUrl }) {
  const [browserPushEnabled,setBrowserPushEnabled]=useState(loadPushPref());

  /**
   * Displays one browser notification when push is enabled and permission is granted.
   * @param {string} title - Notification title.
   * @param {string} body - Notification body text.
   * @returns {void}
   */
  const pushNotify=useCallback((title,body)=>{
    if(!browserPushEnabled)return;
    if(typeof window==="undefined"||!("Notification" in window))return;
    if(Notification.permission!=="granted")return;
    try{
      new Notification(title,{
        body,
        icon:avatarUrl||undefined,
        tag:"2-gather-social",
      });
    }catch(_){}
  },[browserPushEnabled,avatarUrl]);

  /**
   * Enables or disables browser push notifications for the current device.
   * Enabling may trigger the browser permission request flow and persists the
   * final preference in local storage.
   * @param {boolean} enabled - Desired push-notification state.
   * @returns {Promise<boolean>} True when the requested state change succeeded.
   */
  const setPushNotifications=useCallback(async(enabled)=>{
    if(!enabled){
      setBrowserPushEnabled(false);
      savePushPref(false);
      addToast("Browser notifications disabled","info");
      return true;
    }
    if(typeof window==="undefined"||!("Notification" in window)){
      addToast("Browser notifications are not supported on this device","error");
      return false;
    }
    if(!window.isSecureContext&&window.location.hostname!=="localhost"&&window.location.hostname!=="127.0.0.1"){
      addToast("Push notifications require HTTPS (or localhost)","error");
      return false;
    }
    if(Notification.permission==="denied"){
      addToast("Notifications are blocked in browser settings","error");
      return false;
    }
    if(Notification.permission!=="granted"){
      const permission=await Notification.requestPermission();
      if(permission!=="granted"){
        addToast("Notification permission was not granted","error");
        return false;
      }
    }
    setBrowserPushEnabled(true);
    savePushPref(true);
    addToast("Browser notifications enabled","success");
    return true;
  },[addToast]);

  return { browserPushEnabled, pushNotify, setPushNotifications }
}
