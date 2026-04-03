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
    <div className="min-h-screen bg-screen flex flex-col items-center justify-center p-6 sm:p-8 relative overflow-hidden">
      <div className="grain-overlay"/>
      <div className="absolute w-[540px] h-[540px] rounded-full bg-amber-600/8 blur-3xl top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"/>
      <div className="relative z-10 w-full max-w-md flex flex-col gap-6">
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
            <Film size={30} className="text-amber-400"/>
          </div>
          <h1 className="font-display text-5xl text-zinc-100">Lumiere</h1>
          <p className="text-zinc-500 text-center text-sm leading-relaxed">
            Watch together, in perfect sync.<br/>
            Friends, memories, and private watch spaces.
          </p>
        </div>

        <div className="w-full bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 sm:p-6">
          {/* Mode tabs switch the form between login and account creation. */}
          <div className="grid grid-cols-2 gap-2 mb-4">
            <button onClick={()=>setMode("login")}
              className={`py-2 rounded-lg text-sm font-medium transition-colors ${mode==="login"?"bg-amber-300 text-zinc-950":"bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
              Login
            </button>
            <button onClick={()=>setMode("register")}
              className={`py-2 rounded-lg text-sm font-medium transition-colors ${mode==="register"?"bg-amber-300 text-zinc-950":"bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`}>
              Register
            </button>
          </div>

          {/* The email/password form keeps validation and Firebase errors inline. */}
          <form onSubmit={submitEmail} className="space-y-3">
            {mode==="register"&&(
              <input
                value={displayName}
                onChange={e=>setDisplayName(e.target.value)}
                placeholder="Display name"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
              />
            )}
            <input
              type="email"
              value={email}
              onChange={e=>setEmail(e.target.value)}
              placeholder="Email address"
              required
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
            />
            <input
              type="password"
              value={password}
              onChange={e=>setPassword(e.target.value)}
              placeholder="Password"
              required
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
            />
            {mode==="register"&&(
              <input
                type="password"
                value={confirmPassword}
                onChange={e=>setConfirmPassword(e.target.value)}
                placeholder="Confirm password"
                required
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50"
              />
            )}
            {error&&<p className="text-red-400 text-xs">{error}</p>}
            {info&&<p className="text-emerald-400 text-xs">{info}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-amber-300 hover:bg-amber-200 disabled:opacity-60 text-zinc-950 font-semibold py-2.5 rounded-lg transition-colors"
            >
              {submitting ? "Please wait..." : mode==="register" ? "Create account" : "Login"}
            </button>
            {mode==="login"&&(
              <button
                type="button"
                onClick={handleForgotPassword}
                disabled={resetLoading}
                className="w-full text-xs text-zinc-400 hover:text-amber-300 transition-colors"
              >
                {resetLoading?"Sending reset email...":"Forgot password? Send reset link"}
              </button>
            )}
          </form>

          <div className="my-4 flex items-center gap-2 text-zinc-600 text-xs">
            <div className="h-px flex-1 bg-zinc-800"/>
            <span>or</span>
            <div className="h-px flex-1 bg-zinc-800"/>
          </div>

          {/* Google auth is the alternate auth path for users who prefer one-tap sign-in. */}
          <button onClick={signInGoogle} disabled={googleLoading}
            className="w-full flex items-center justify-center gap-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-medium py-2.5 rounded-lg transition-colors disabled:opacity-60 border border-zinc-700">
            {googleLoading
              ?<span className="w-4 h-4 border-2 border-zinc-400/30 border-t-zinc-200 rounded-full animate-spin"/>
              :<><svg className="w-4 h-4" viewBox="0 0 24 24">
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
  );
}

export default LandingView
