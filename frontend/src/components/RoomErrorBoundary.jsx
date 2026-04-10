/**
 * RoomErrorBoundary catches render/runtime failures inside RoomView and swaps in
 * a recovery screen. React error boundaries must be class components, which is
 * why this file intentionally uses the legacy class API instead of hooks.
 */
import { Component } from "react";

/**
 * Error boundary for the realtime room experience.
 * @extends Component<{children: React.ReactNode, onReset?: () => void}, {error: Error|null}>
 */
class RoomErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  /**
   * Captures the thrown error for logging and diagnostics.
   * @param {Error} error - The runtime error thrown by a descendant.
   * @param {{componentStack?: string}} info - React component stack information.
   * @returns {void}
   */
  componentDidCatch(error, info) {
    console.error("[room-error-boundary]", error, info);
  }

  /**
   * Renders either the child room UI or the fallback recovery screen.
   * @returns {JSX.Element|React.ReactNode} The active child tree or fallback shell.
   */
  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    const message = this.state.error?.message || "Unknown room error";
    const stack = String(this.state.error?.stack || "").split("\n").slice(0, 8).join("\n");

    return (
      <div className="bg-screen flex min-h-screen items-center justify-center px-6 py-10 text-zinc-100">
        <div className="w-full max-w-3xl rounded-[2rem] border border-red-500/20 bg-zinc-950/90 p-7 shadow-[0_36px_120px_rgba(0,0,0,0.55)] backdrop-blur-xl">
          <p className="text-xs uppercase tracking-[0.26em] text-red-200">Room crashed</p>
          <h2 className="mt-3 font-display text-[2.15rem] leading-none text-zinc-50">The room UI hit a runtime error.</h2>
          <p className="mt-4 text-sm leading-7 text-zinc-300">{message}</p>
          {!!stack&&(
            <pre className="mt-5 overflow-x-auto whitespace-pre-wrap rounded-[1.5rem] border border-white/8 bg-black/35 p-4 text-xs leading-6 text-zinc-300">
              {stack}
            </pre>
          )}
          <div className="mt-5 flex flex-wrap gap-3">
            {/* Reload offers a full app reset, while onReset returns the user to the lobby. */}
            <button
              type="button"
              onClick={()=>window.location.reload()}
              className="rounded-full bg-gradient-to-r from-amber-400 to-orange-300 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-all duration-200 hover:-translate-y-0.5 hover:from-amber-300 hover:to-orange-200"
            >
              Reload app
            </button>
            <button
              type="button"
              onClick={this.props.onReset}
              className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-zinc-200 transition-all duration-200 hover:border-white/20 hover:text-zinc-50"
            >
              Leave room
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default RoomErrorBoundary
