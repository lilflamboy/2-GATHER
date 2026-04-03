/**
 * Toast notifications are short-lived status messages shown in the corner of
 * the UI. Lumiere uses them for success, error, info, and warning feedback,
 * and the companion toast hook auto-dismisses them after a short delay.
 */
import { AlertCircle } from "lucide-react";

/**
 * Renders the active toast stack.
 * @param {{toasts: Array<{id: string, message: string, type: string}>, removeToast: (id: string) => void}} props - Toast list and dismiss handler.
 * @returns {JSX.Element} The fixed-position toast overlay.
 */
function Toasts({toasts,removeToast}){
  return(
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {/* Each toast is clickable so the user can dismiss it before auto-close runs. */}
      {toasts.map(t=>(
        <div key={t.id} onClick={()=>removeToast(t.id)}
          className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl
            backdrop-blur-md border text-sm font-medium cursor-pointer
            ${t.type==="error"?"bg-red-900/90 border-red-700 text-red-100":
              t.type==="success"?"bg-green-900/90 border-green-700 text-green-100":
              "bg-zinc-800/95 border-zinc-600 text-zinc-100"}`}>
          <AlertCircle size={14} className="shrink-0"/>{t.message}
        </div>
      ))}
    </div>
  );
}

export default Toasts
