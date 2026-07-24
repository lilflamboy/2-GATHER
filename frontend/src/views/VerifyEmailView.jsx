/**
 * VerifyEmailView is shown after sign-up when a Firebase account exists but the
 * user has not yet confirmed their email address.
 */
import { Film } from "lucide-react";

/**
 * Renders the email-verification holding screen.
 * @param {{user: {email?: string}|null, onRefresh: () => void, onResend: () => void, onSignOut: () => void, loading: boolean}} props - Auth user plus verification actions.
 * @returns {JSX.Element} The verification prompt.
 */
function VerifyEmailView({user,onRefresh,onResend,onSignOut,loading}){
  return(
    <div className="min-h-screen bg-screen relative flex flex-col items-center justify-center overflow-hidden px-6 py-10">
      <div className="grain-overlay"/>
      <div className="absolute inset-x-0 top-[-20rem] h-[32rem] bg-[radial-gradient(circle_at_top,rgba(251,146,60,0.18),transparent_54%)] pointer-events-none"/>
      <div className="absolute right-[-8rem] top-20 h-[22rem] w-[22rem] rounded-full bg-purple-500/10 blur-3xl pointer-events-none"/>
      <div className="relative z-10 flex w-full max-w-md flex-col gap-6">
        <div className="glass-panel relative overflow-hidden border border-pink-200 bg-white/[0.03] p-6 shadow-[0_32px_120px_rgba(0,0,0,0.52)]">
          <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"/>
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-pink-400/20 bg-gradient-to-br from-purple-400/15 to-purple-500/10">
              <Film size={20} className="text-pink-600" />
            </div>
            <div>
              <p className="text-[0.68rem] uppercase tracking-[0.24em] text-zinc-600">Almost there</p>
              <h2 className="font-display text-[2rem] leading-none text-zinc-800">Verify your email</h2>
            </div>
          </div>
          <p className="text-sm leading-7 text-zinc-600">
            We sent a verification link to <span className="text-zinc-800">{user?.email}</span>.
            Please verify your email before entering 2-GATHER.
          </p>
          {/* Resend sends another verification email, while refresh re-checks Firebase for verification status. */}
          <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              onClick={onResend}
              disabled={loading}
              className="rounded-2xl border border-pink-200 bg-white/[0.04] px-4 py-3 text-sm font-medium text-zinc-800 transition-all duration-200 hover:border-purple-200 hover:bg-white/[0.08] disabled:opacity-60"
            >
              Resend verification
            </button>
            <button
              onClick={onRefresh}
              disabled={loading}
              className="rounded-2xl bg-gradient-to-r from-pink-400 via-fuchsia-400 to-pink-300 px-4 py-3 text-sm font-semibold text-zinc-950 shadow-[0_18px_40px_rgba(251,146,60,0.25)] transition-all duration-200 hover:-translate-y-0.5 hover:from-pink-300 hover:to-orange-200 disabled:opacity-60"
            >
              I have verified
            </button>
          </div>
          <button
            onClick={onSignOut}
            disabled={loading}
            className="mt-4 text-xs text-zinc-600 transition-all duration-200 hover:text-zinc-600"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

export default VerifyEmailView
