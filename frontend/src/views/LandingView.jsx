import { useState, useEffect } from "react";
import { Film, Volume2, VolumeX } from "lucide-react";
import Footer from "../components/Footer";

// Assuming VITE_API_URL points to the backend
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:10000';

function LandingView({ addToast, onLoginSuccess }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const [introFinished, setIntroFinished] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [introAudio, setIntroAudio] = useState(null);

  useEffect(() => {
    const a = new Audio('/real_meow.mp3');
    a.volume = isMuted ? 0 : 0.8;
    a.loop = true;
    setIntroAudio(a);
    a.play().catch(()=>{});
    
    const t = setTimeout(() => {
      setIntroFinished(true);
      a.pause();
    }, 5000);
    
    return () => {
      clearTimeout(t);
      a.pause();
    };
  }, []);

  useEffect(() => {
    if (introAudio) {
      introAudio.volume = isMuted ? 0 : 0.8;
      if (isMuted) {
          introAudio.pause();
      }
    }
  }, [isMuted, introAudio]);
  
  if (!introFinished) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black transition-opacity duration-1000">
        <button onClick={() => setIsMuted(!isMuted)} className="absolute top-6 right-6 z-[200] rounded-full bg-white/10 p-3 text-white/50 hover:bg-white/20 hover:text-white transition-all">
          {isMuted ? <VolumeX size={24} /> : <Volume2 size={24} />}
        </button>
        <div className="flex flex-col items-center animate-pulse scale-150 transition-transform duration-1000">
          <img src="/cat.gif" alt="Cat" className="h-32 w-32 object-cover rounded-[2rem] shadow-[0_0_80px_rgba(236,72,153,0.6)]" onError={(e) => e.target.style.display='none'} />
          <h1 className="mt-4 font-display text-4xl text-pink-500 tracking-widest uppercase" style={{textShadow: '0 0 20px rgba(236,72,153,0.8)'}}>
            2-GATHER
          </h1>
        </div>
      </div>
    );
  }

  const submitEmail = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setInfo("");
    try {
      if (mode === "register") {
        if (!displayName.trim()) throw new Error("Display name is required");
        if (password.length < 6) throw new Error("Password must be at least 6 characters");
        if (password !== confirmPassword) throw new Error("Passwords do not match");
        
        const res = await fetch(`${API_URL}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password, displayName: displayName.trim() })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Registration failed");
        }
        
        const data = await res.json();
        addToast?.("Account created successfully", "success");
        if (onLoginSuccess) {
          onLoginSuccess(data.token, data.user);
        }
      } else {
        const res = await fetch(`${API_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password })
        });
        
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Login failed");
        }
        
        const data = await res.json();
        if (onLoginSuccess) {
          onLoginSuccess(data.token, data.user);
        }
      }
    } catch (e) {
      setError(e.message || "Authentication failed");
      addToast?.(e.message || "Authentication failed", "error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen relative overflow-hidden px-6 py-10 sm:px-8 sm:py-12 bg-rose-50/40">
      <div className="absolute inset-x-0 top-[-24rem] h-[36rem] bg-[radial-gradient(circle_at_top,rgba(255,192,203,0.4),transparent_55%)] pointer-events-none" />
      <div className="absolute right-[-8rem] top-24 h-[26rem] w-[26rem] rounded-full bg-pink-200/40 blur-3xl pointer-events-none" />
      <div className="absolute left-[-10rem] bottom-[-8rem] h-[24rem] w-[24rem] rounded-full bg-fuchsia-200/40 blur-3xl pointer-events-none" />
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-lg items-center justify-center">
        <div className="relative flex w-full flex-col gap-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="rounded-full border border-pink-300 bg-pink-100/80 px-5 py-2 text-[0.75rem] font-bold uppercase tracking-[0.2em] text-pink-600 shadow-sm">
              Watch parties, purrfected 🐾
            </div>
            <div className="flex h-24 w-24 items-center justify-center rounded-[2rem] border border-pink-100 bg-gradient-to-br from-white to-pink-50 shadow-[0_20px_60px_rgba(244,114,182,0.2)] overflow-hidden relative animate-bounce mx-auto">
                <img src="/cat.gif" alt="Cat" className="absolute inset-0 h-full w-full object-cover" onError={(e) => { e.target.style.display='none'; e.target.nextSibling.style.display='block'; }} />
                <Film size={40} className="text-pink-500 hidden" />
              </div>
              <div className="space-y-3">
                <h1 className="font-display text-[3.5rem] font-bold leading-none text-zinc-800 sm:text-[4.2rem]">2-GATHER 🐱</h1>
              <p className="mx-auto max-w-sm text-base leading-7 text-zinc-800 font-medium">
                Watch together, in purrfect sync.<br />
                Friends, memories, and cozy cat-naps.
              </p>
            </div>
          </div>

          <div className="relative w-full overflow-hidden rounded-[2.5rem] border border-white/60 bg-white/60 backdrop-blur-xl p-8 shadow-[0_32px_80px_rgba(0,0,0,0.04)]">
            <div className="mb-6 grid grid-cols-2 gap-3 rounded-2xl bg-zinc-100/80 p-1.5 shadow-inner">
              <button onClick={() => setMode("login")}
                className={`rounded-xl px-4 py-3 text-sm font-bold transition-all duration-300 ${mode === "login" ? "bg-white text-pink-600 shadow-md transform scale-[1.02]" : "bg-transparent text-zinc-800 hover:text-zinc-900 hover:bg-white/50"}`}>
                Login
              </button>
              <button onClick={() => setMode("register")}
                className={`rounded-xl px-4 py-3 text-sm font-bold transition-all duration-300 ${mode === "register" ? "bg-white text-pink-600 shadow-md transform scale-[1.02]" : "bg-transparent text-zinc-800 hover:text-zinc-900 hover:bg-white/50"}`}>
                Register
              </button>
            </div>

            <form onSubmit={submitEmail} className="space-y-4">
              {mode === "register" && (
                <input
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="Display name"
                  className="w-full rounded-2xl border border-pink-100 bg-white px-5 py-4 text-sm font-medium text-zinc-800 placeholder:text-zinc-800 shadow-sm focus:border-pink-300 focus:outline-none focus:ring-4 focus:ring-pink-100 transition-all duration-300"
                />
              )}
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="Email address"
                required
                className="w-full rounded-2xl border border-pink-100 bg-white px-5 py-4 text-sm font-medium text-zinc-800 placeholder:text-zinc-800 shadow-sm focus:border-pink-300 focus:outline-none focus:ring-4 focus:ring-pink-100 transition-all duration-300"
              />
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Password"
                required
                className="w-full rounded-2xl border border-pink-100 bg-white px-5 py-4 text-sm font-medium text-zinc-800 placeholder:text-zinc-800 shadow-sm focus:border-pink-300 focus:outline-none focus:ring-4 focus:ring-pink-100 transition-all duration-300"
              />
              {mode === "register" && (
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="Confirm password"
                  required
                  className="w-full rounded-2xl border border-pink-100 bg-white px-5 py-4 text-sm font-medium text-zinc-800 placeholder:text-zinc-800 shadow-sm focus:border-pink-300 focus:outline-none focus:ring-4 focus:ring-pink-100 transition-all duration-300"
                />
              )}
              {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold leading-6 text-red-500">{error}</p>}
              {info && <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-semibold leading-6 text-emerald-500">{info}</p>}
              <button
                type="submit"
                disabled={submitting}
                className="mt-2 w-full rounded-2xl bg-gradient-to-r from-pink-400 to-rose-400 px-5 py-4 text-sm font-bold text-white shadow-[0_12px_24px_rgba(244,114,182,0.3)] transition-all duration-300 hover:-translate-y-1 hover:scale-[1.02] active:scale-95 hover:shadow-[0_16px_32px_rgba(244,114,182,0.4)] disabled:opacity-60"
              >
                {submitting ? "Please wait..." : mode === "register" ? "Create Account" : "Sign In"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LandingView;
