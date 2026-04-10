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
    <div className="fixed right-5 top-5 z-[9999] flex max-w-sm flex-col gap-3 pointer-events-none">
      {/* Each toast is clickable so the user can dismiss it before auto-close runs. */}
      {toasts.map(t=>(
        <div key={t.id} onClick={()=>removeToast(t.id)}
          className={`animate-toast-in pointer-events-auto relative flex cursor-pointer items-center gap-3 overflow-hidden rounded-2xl border px-4 py-3.5 text-sm font-medium shadow-[0_22px_60px_rgba(0,0,0,0.42)] backdrop-blur-xl transition-all duration-200
            ${t.type==="error"?"border-red-500/25 bg-red-500/12 text-red-100":
              t.type==="success"?"border-emerald-500/25 bg-emerald-500/12 text-emerald-100":
              "border-white/10 bg-zinc-900/90 text-zinc-100"}`}>
          <div className={`absolute inset-y-0 left-0 w-1.5
            ${t.type==="error"?"bg-red-400/80":
              t.type==="success"?"bg-emerald-300/80":
              "bg-gradient-to-b from-amber-300 to-violet-400"}`}/>
          <div className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border
            ${t.type==="error"?"border-red-400/20 bg-red-500/14":
              t.type==="success"?"border-emerald-400/20 bg-emerald-500/14":
              "border-white/10 bg-white/[0.05]"}`}>
            <AlertCircle size={14} className="shrink-0"/>
          </div>
          <p className="pr-2 leading-6">{t.message}</p>
        </div>
      ))}
    </div>
  );
}

export default Toasts
