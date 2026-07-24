/**
 * Safe browser-storage helpers for session bootstrap data. These wrappers keep
 * the rest of the frontend from having to guard every storage access against
 * privacy mode failures, SSR, or quota/security exceptions.
 */

/**
 * Saves the active room code into session storage for same-tab restore.
 * @param {string} c - Room code to persist.
 * @returns {void}
 */
export const saveSession  = c => { try{sessionStorage.setItem("2-gather_room",c);}catch(_){} };

/**
 * Loads the active room code from session storage.
 * @returns {string | null} Previously saved room code or null.
 */
export const loadSession  = () => { try{return sessionStorage.getItem("2-gather_room");}catch(_){return null;} };

/**
 * Clears the saved room code from session storage.
 * @returns {void}
 */
export const clearSession = () => { try{sessionStorage.removeItem("2-gather_room");}catch(_){} };

/**
 * Saves the claimed username into local storage for cross-session restore.
 * @param {string} u - Username to persist locally.
 * @returns {void}
 */
export const saveUsername  = u => { try{localStorage.setItem("2-gather_username",u);}catch(_){} };

/**
 * Loads the locally cached username.
 * @returns {string} Cached username or an empty string.
 */
export const loadUsername  = () => { try{return localStorage.getItem("2-gather_username")||"";}catch(_){return "";} };

/**
 * Saves the browser push-notification preference into local storage.
 * @param {boolean} enabled - Whether browser push notifications are enabled.
 * @returns {void}
 */
export const savePushPref = enabled => { try{localStorage.setItem("2-gather_push_enabled",enabled?"1":"0");}catch(_){} };

/**
 * Loads the browser push-notification preference from local storage.
 * @returns {boolean} True when push notifications were previously enabled.
 */
export const loadPushPref = () => { try{return localStorage.getItem("2-gather_push_enabled")==="1";}catch(_){return false;} };
