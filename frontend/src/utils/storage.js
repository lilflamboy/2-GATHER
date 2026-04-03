export const saveSession  = c => { try{sessionStorage.setItem("lumiere_room",c);}catch(_){} };
export const loadSession  = () => { try{return sessionStorage.getItem("lumiere_room");}catch(_){return null;} };
export const clearSession = () => { try{sessionStorage.removeItem("lumiere_room");}catch(_){} };
export const saveUsername  = u => { try{localStorage.setItem("lumiere_username",u);}catch(_){} };
export const loadUsername  = () => { try{return localStorage.getItem("lumiere_username")||"";}catch(_){return "";} };
export const savePushPref = enabled => { try{localStorage.setItem("lumiere_push_enabled",enabled?"1":"0");}catch(_){} };
export const loadPushPref = () => { try{return localStorage.getItem("lumiere_push_enabled")==="1";}catch(_){return false;} };
