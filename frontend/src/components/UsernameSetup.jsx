/**
 * Username setup is shown on first login when the authenticated profile still
 * needs a permanent public username. Usernames are limited to 3-20 characters
 * and may only contain letters, numbers, and underscores.
 */
import { useState } from "react";
import { AtSign } from "lucide-react";

/**
 * Prompts a newly signed-in user to choose their permanent username.
 * @param {{displayName: string, onDone: (username: string) => Promise<{ success: true } | { success: false, status: number | null, message: string } | void>}} props - Suggested display name and claim callback.
 * @returns {JSX.Element} The username setup form.
 */
function UsernameSetup({displayName, onDone}){
  // Seed the input with a cleaned version of the display name so first-time
  // users usually only need a tiny edit before claiming a username.
  const suggested = (displayName||"").toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9_]/g,"").slice(0,18);
  const [value,setValue]=useState(suggested);
  const [error,setError]=useState("");
  const [submitting,setSubmitting]=useState(false);

  // Validate client-side first so obviously invalid usernames never hit the API.
  const validate = v => {
    if(!v) return "Username is required";
    if(v.length<3) return "At least 3 characters";
    if(v.length>20) return "Max 20 characters";
    if(!/^[a-zA-Z0-9_]+$/.test(v)) return "Only letters, numbers, underscore";
    return "";
  };

  const handleSubmit = async e => {
    e.preventDefault();
    // The claim flow keeps the user on this screen until the server confirms
    // the username is both valid and still available.
    const err=validate(value.trim());
    if(err){setError(err);return;}
    setSubmitting(true);
    try{
      const result=await onDone(value.trim().toLowerCase());
      if(result?.success===false){
        if(result.status===409){
          setError("That username is already taken.");
        }else if(result.status===401){
          setError("Session expired. Refreshing...");
          window.setTimeout(()=>window.location.reload(),150);
          return;
        }else{
          setError("Server connection failed. Try again.");
        }
      }
    }catch(submitError){
      setError(submitError?.message||"Unable to save username");
    }finally{
      setSubmitting(false);
    }
  };

  return(
    <div className="min-h-screen bg-screen relative flex items-center justify-center overflow-hidden px-6 py-10 sm:px-8">
      <div className="grain-overlay"/>
      <div className="absolute inset-x-0 top-[-20rem] h-[32rem] bg-[radial-gradient(circle_at_top,rgba(251,146,60,0.2),transparent_52%)] pointer-events-none"/>
      <div className="absolute right-[-7rem] top-20 h-[22rem] w-[22rem] rounded-full bg-purple-500/10 blur-3xl pointer-events-none"/>
      <div className="absolute left-[-8rem] bottom-[-8rem] h-[20rem] w-[20rem] rounded-full bg-purple-400/10 blur-3xl pointer-events-none"/>
      <div className="relative z-10 flex w-full max-w-md flex-col gap-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="feature-pill border-purple-400/20 bg-purple-400/10 px-4 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.28em] text-purple-600/90">
            Claim your identity
          </div>
          <div className="flex h-16 w-16 items-center justify-center rounded-[1.6rem] border border-pink-400/25 bg-gradient-to-br from-purple-400/18 to-purple-500/12 shadow-[0_22px_60px_rgba(245,158,11,0.14)]">
            <AtSign size={28} className="text-pink-600"/>
          </div>
          <div className="space-y-3">
            <h1 className="font-display text-4xl leading-none text-zinc-800">Choose your username</h1>
            <p className="mx-auto max-w-sm text-sm leading-7 text-zinc-600">This is how friends will see you.<br/>You can't change it later.</p>
          </div>
        </div>
        {/* The form keeps feedback inline so the user understands why a claim failed. */}
        <form onSubmit={handleSubmit} className="glass-panel relative flex flex-col gap-4 overflow-hidden border border-pink-200 bg-white/[0.03] p-6 shadow-[0_32px_120px_rgba(0,0,0,0.52)]">
          <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"/>
          <div>
            <div className="flex items-center rounded-2xl border border-pink-200 bg-white/[0.04] px-4 py-3.5 transition-all duration-200 focus-within:border-pink-400/60 focus-within:ring-2 focus-within:ring-purple-400/10">
              <span className="mr-2 text-sm font-semibold text-purple-600">@</span>
              <input
                value={value}
                onChange={e=>{setValue(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,"").slice(0,20));setError("");}}
                placeholder="yourname"
                autoFocus
                className="flex-1 bg-transparent text-sm font-mono text-zinc-800 placeholder:text-zinc-600 focus:outline-none"
              />
            </div>
            {error&&<p className="mt-2 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs leading-6 text-red-600">{error}</p>}
            {!error&&value.length>0&&<p className="mt-2 rounded-full border border-pink-200 bg-pink-50/50 px-3 py-2 text-xs text-zinc-600">{value.length}/20 characters</p>}
          </div>
          <button type="submit" disabled={submitting}
            className="w-full rounded-2xl bg-gradient-to-r from-pink-400 via-fuchsia-400 to-pink-300 px-4 py-3.5 text-sm font-semibold text-zinc-950 shadow-[0_18px_40px_rgba(251,146,60,0.28)] transition-all duration-200 hover:-translate-y-0.5 hover:from-pink-300 hover:to-orange-200 disabled:opacity-60">
            {submitting?"Saving...":"Continue →"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default UsernameSetup
