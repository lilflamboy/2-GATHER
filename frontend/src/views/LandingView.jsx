/**
 * LandingView is the public authentication entry screen. It supports Google
 * sign-in, email/password sign-in, account creation, and password reset.
 */
import { useState } from "react";
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
  sendPasswordResetEmail,
} from "firebase/auth";
import { Film } from "lucide-react";
import { auth, googleProvider } from "../firebase.js";

/**
 * Renders the login and registration screen.
 * @param {{addToast?: (message: string, type?: string) => void}} props - Toast helper for surfacing auth feedback.
 * @returns {JSX.Element} The public auth view.
 */
function LandingView({addToast}){
  // Local form state drives the login/register mode and the current input values.
  const [mode,setMode]=useState("login");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [confirmPassword,setConfirmPassword]=useState("");
  const [displayName,setDisplayName]=useState("");
  const [submitting,setSubmitting]=useState(false);
  const [googleLoading,setGoogleLoading]=useState(false);
  const [resetLoading,setResetLoading]=useState(false);
  const [error,setError]=useState("");
  const [info,setInfo]=useState("");

  // Google sign-in delegates the full popup-based OAuth flow to Firebase Auth.
  const signInGoogle=async()=>{
    setGoogleLoading(true);
    setError("");
    setInfo("");
    try{
      await signInWithPopup(auth,googleProvider);
    }catch(e){
      setError(e.message||"Google sign-in failed");
      addToast?.(e.message||"Google sign-in failed","error");
    }finally{
      setGoogleLoading(false);
    }
  };

  // Email submit handles both login and sign-up, including inline validation and verification email dispatch.
  const submitEmail=async(e)=>{
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setInfo("");
    try{
      if(mode==="register"){
        if(!displayName.trim()) throw new Error("Display name is required");
        if(password.length<6) throw new Error("Password must be at least 6 characters");
        if(password!==confirmPassword) throw new Error("Passwords do not match");
        const credential=await createUserWithEmailAndPassword(auth,email.trim(),password);
        await updateProfile(credential.user,{displayName:displayName.trim()});
        await sendEmailVerification(credential.user);
        addToast?.("Account created. Verification email sent.","success");
        setInfo("Verification email sent. Please verify before using account login.");
      }else{
        await signInWithEmailAndPassword(auth,email.trim(),password);
      }
    }catch(e){
      setError(e.message||"Authentication failed");
      addToast?.(e.message||"Authentication failed","error");
    }finally{
      setSubmitting(false);
    }
  };

  // Password reset reuses the email input so the user does not need a second form.
  const handleForgotPassword=async()=>{
    if(!email.trim()){
      const msg="Enter your email first, then click reset password.";
      setError(msg);
      addToast?.(msg,"error");
      return;
    }
    setResetLoading(true);
    setError("");
    setInfo("");
    try{
      await sendPasswordResetEmail(auth,email.trim());
      const msg="Password reset email sent. Check your inbox/spam.";
      setInfo(msg);
      addToast?.(msg,"success");
    }catch(e){
      setError(e.message||"Could not send reset email");
      addToast?.(e.message||"Could not send reset email","error");
    }finally{
      setResetLoading(false);
    }
  };

  return(
    <div className="min-h-screen bg-screen relative overflow-hidden px-6 py-10 sm:px-8 sm:py-12">
      <div className="grain-overlay"/>
      <div className="absolute inset-x-0 top-[-24rem] h-[36rem] bg-[radial-gradient(circle_at_top,rgba(251,146,60,0.22),transparent_55%)] pointer-events-none"/>
      <div className="absolute right-[-8rem] top-24 h-[26rem] w-[26rem] rounded-full bg-violet-500/10 blur-3xl pointer-events-none"/>
      <div className="absolute left-[-10rem] bottom-[-8rem] h-[24rem] w-[24rem] rounded-full bg-amber-500/10 blur-3xl pointer-events-none"/>
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-lg items-center justify-center">
        <div className="relative flex w-full flex-col gap-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="feature-pill border-amber-500/20 bg-amber-500/10 px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.28em] text-amber-200/90">
              Watch parties, reimagined
            </div>
            <div className="flex h-20 w-20 items-center justify-center rounded-[1.75rem] border border-amber-400/25 bg-gradient-to-br from-amber-500/20 via-amber-400/10 to-violet-500/15 shadow-[0_24px_80px_rgba(245,158,11,0.16)]">
              <Film size={34} className="text-amber-300"/>
            </div>
            <div className="space-y-3">
              <h1 className="font-display text-[3.75rem] leading-none text-zinc-50 sm:text-[4.4rem]">Lumiere</h1>
              <p className="mx-auto max-w-sm text-sm leading-7 text-zinc-400 sm:text-[0.98rem]">
                Watch together, in perfect sync.<br/>
                Friends, memories, and private watch spaces.
              </p>
            </div>
          </div>

          <div className="glass-panel relative w-full overflow-hidden border border-white/10 bg-white/[0.03] p-6 shadow-[0_32px_120px_rgba(0,0,0,0.58)] sm:p-7">
            <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"/>
            <div className="absolute inset-x-10 top-0 h-28 bg-gradient-to-b from-white/6 to-transparent pointer-events-none"/>
            <div className="mb-5 grid grid-cols-2 gap-2 rounded-2xl border border-white/8 bg-black/30 p-1.5">
          {/* Mode tabs switch the form between login and account creation. */}
              <button onClick={()=>setMode("login")}
                className={`rounded-xl px-4 py-3 text-sm font-semibold transition-all duration-200 ${mode==="login"?"bg-gradient-to-r from-amber-400 to-orange-300 text-zinc-950 shadow-[0_14px_36px_rgba(251,146,60,0.3)]":"bg-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"}`}>
                Login
              </button>
              <button onClick={()=>setMode("register")}
                className={`rounded-xl px-4 py-3 text-sm font-semibold transition-all duration-200 ${mode==="register"?"bg-gradient-to-r from-amber-400 to-orange-300 text-zinc-950 shadow-[0_14px_36px_rgba(251,146,60,0.3)]":"bg-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"}`}>
                Register
              </button>
            </div>

          {/* The email/password form keeps validation and Firebase errors inline. */}
            <form onSubmit={submitEmail} className="space-y-3.5">
              {mode==="register"&&(
                <input
                  value={displayName}
                  onChange={e=>setDisplayName(e.target.value)}
                  placeholder="Display name"
                  className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-400/60 focus:outline-none focus:ring-2 focus:ring-amber-500/10"
                />
              )}
              <input
                type="email"
                value={email}
                onChange={e=>setEmail(e.target.value)}
                placeholder="Email address"
                required
                className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-400/60 focus:outline-none focus:ring-2 focus:ring-amber-500/10"
              />
              <input
                type="password"
                value={password}
                onChange={e=>setPassword(e.target.value)}
                placeholder="Password"
                required
                className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-400/60 focus:outline-none focus:ring-2 focus:ring-amber-500/10"
              />
              {mode==="register"&&(
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={e=>setConfirmPassword(e.target.value)}
                  placeholder="Confirm password"
                  required
                  className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-400/60 focus:outline-none focus:ring-2 focus:ring-amber-500/10"
                />
              )}
              {error&&<p className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs leading-6 text-red-200">{error}</p>}
              {info&&<p className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-xs leading-6 text-emerald-200">{info}</p>}
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-2xl bg-gradient-to-r from-amber-400 via-orange-300 to-amber-300 px-4 py-3.5 text-sm font-semibold text-zinc-950 shadow-[0_18px_40px_rgba(251,146,60,0.3)] transition-all duration-200 hover:-translate-y-0.5 hover:from-amber-300 hover:to-orange-200 disabled:opacity-60"
              >
                {submitting ? "Please wait..." : mode==="register" ? "Create account" : "Login"}
              </button>
              {mode==="login"&&(
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={resetLoading}
                  className="w-full rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3 text-xs font-medium text-zinc-400 transition-all duration-200 hover:border-amber-400/20 hover:bg-amber-500/8 hover:text-amber-200"
                >
                  {resetLoading?"Sending reset email...":"Forgot password? Send reset link"}
                </button>
              )}
            </form>

            <div className="my-5 flex items-center gap-3 text-[0.68rem] uppercase tracking-[0.28em] text-zinc-600">
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/8 to-white/16"/>
              <span>or continue</span>
              <div className="h-px flex-1 bg-gradient-to-r from-white/16 via-white/8 to-transparent"/>
            </div>

          {/* Google auth is the alternate auth path for users who prefer one-tap sign-in. */}
            <button onClick={signInGoogle} disabled={googleLoading}
              className="flex w-full items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3.5 text-sm font-medium text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-200 hover:border-violet-400/25 hover:bg-violet-500/10 hover:text-zinc-50 disabled:opacity-60">
              {googleLoading
                ?<span className="h-4 w-4 rounded-full border-2 border-zinc-500/30 border-t-zinc-100 animate-spin"/>
                :<><svg className="h-4 w-4" viewBox="0 0 24 24">
                  <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>Continue with Google</>
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LandingView
