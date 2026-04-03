import { Film } from "lucide-react";

function VerifyEmailView({user,onRefresh,onResend,onSignOut,loading}){
  return(
    <div className="min-h-screen bg-screen flex flex-col items-center justify-center p-6 relative overflow-hidden">
      <div className="grain-overlay"/>
      <div className="relative z-10 w-full max-w-md bg-zinc-900/70 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Film size={20} className="text-amber-400"/>
          <h2 className="font-display text-2xl text-zinc-100">Verify your email</h2>
        </div>
        <p className="text-zinc-400 text-sm">
          We sent a verification link to <span className="text-zinc-200">{user?.email}</span>.
          Please verify your email before entering Lumiere.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            onClick={onResend}
            disabled={loading}
            className="bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 border border-zinc-700 text-zinc-100 font-medium py-2.5 rounded-lg text-sm transition-colors"
          >
            Resend verification
          </button>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="bg-amber-300 hover:bg-amber-200 disabled:opacity-60 text-zinc-950 font-semibold py-2.5 rounded-lg text-sm transition-colors"
          >
            I have verified
          </button>
        </div>
        <button
          onClick={onSignOut}
          disabled={loading}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

export default VerifyEmailView
