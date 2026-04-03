import { useState, useCallback } from "react";
import { loadPushPref, savePushPref } from "../utils/storage";

export function usePushNotifications({ addToast, avatarUrl }) {
  const [browserPushEnabled,setBrowserPushEnabled]=useState(loadPushPref());

  const pushNotify=useCallback((title,body)=>{
    if(!browserPushEnabled)return;
    if(typeof window==="undefined"||!("Notification" in window))return;
    if(Notification.permission!=="granted")return;
    try{
      new Notification(title,{
        body,
        icon:avatarUrl||undefined,
        tag:"lumiere-social",
      });
    }catch(_){}
  },[browserPushEnabled,avatarUrl]);

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
