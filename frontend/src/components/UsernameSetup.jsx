import { useState } from "react";
import { AtSign } from "lucide-react";

function UsernameSetup({displayName, onDone}){
  const suggested = (displayName||"").toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9_]/g,"").slice(0,18);
  const [value,setValue]=useState(suggested);
  const [error,setError]=useState("");
  const [submitting,setSubmitting]=useState(false);

  const validate = v => {
    if(!v) return "Username is required";
    if(v.length<3) return "At least 3 characters";
    if(v.length>20) return "Max 20 characters";
    if(!/^[a-zA-Z0-9_]+$/.test(v)) return "Only letters, numbers, underscore";
    return "";
  };

  const handleSubmit = async e => {
    e.preventDefault();
    const err=validate(value.trim());
    if(err){setError(err);return;}
    setSubmitting(true);
    try{
      const ok=await onDone(value.trim().toLowerCase());
      if(ok===false){
        setError("Username unavailable. Try another one.");
      }
    }catch(submitError){
      setError(submitError?.message||"Unable to save username");
    }finally{
      setSubmitting(false);
    }
  };

  return(
    <div className="min-h-screen bg-screen flex items-center justify-center p-8 relative overflow-hidden">
      <div className="grain-overlay"/>
      <div className="absolute w-96 h-96 rounded-full bg-amber-600/8 blur-3xl top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"/>
      <div className="relative z-10 w-full max-w-sm flex flex-col gap-6">
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
            <AtSign size={26} className="text-amber-400"/>
          </div>
          <h1 className="font-display text-3xl text-zinc-100">Choose your username</h1>
          <p className="text-zinc-500 text-sm text-center">This is how friends will see you.<br/>You can't change it later.</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-4">
          <div>
            <div className="flex items-center bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 focus-within:border-amber-500/60 transition-colors">
              <span className="text-zinc-500 mr-1 text-sm">@</span>
              <input
                value={value}
                onChange={e=>{setValue(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,"").slice(0,20));setError("");}}
                placeholder="yourname"
                autoFocus
                className="flex-1 bg-transparent text-zinc-100 text-sm font-mono focus:outline-none placeholder-zinc-600"
              />
            </div>
            {error&&<p className="text-red-400 text-xs mt-1.5 ml-1">{error}</p>}
            {!error&&value.length>0&&<p className="text-zinc-600 text-xs mt-1.5 ml-1">{value.length}/20 characters</p>}
          </div>
          <button type="submit" disabled={submitting}
            className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-zinc-950 font-semibold py-3 rounded-xl transition-colors">
            {submitting?"Saving...":"Continue →"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default UsernameSetup
