import { Component } from "react";

class RoomErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[room-error-boundary]", error, info);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    const message = this.state.error?.message || "Unknown room error";
    const stack = String(this.state.error?.stack || "").split("\n").slice(0, 8).join("\n");

    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="w-full max-w-3xl rounded-3xl border border-red-500/30 bg-zinc-900/90 p-6 shadow-2xl">
          <p className="text-xs uppercase tracking-[0.2em] text-red-300">Room crashed</p>
          <h2 className="mt-2 font-display text-2xl text-zinc-50">The room UI hit a runtime error.</h2>
          <p className="mt-3 text-sm text-zinc-300">{message}</p>
          {!!stack&&(
            <pre className="mt-4 overflow-x-auto rounded-2xl border border-zinc-800 bg-black/40 p-4 text-xs text-zinc-300 whitespace-pre-wrap">
              {stack}
            </pre>
          )}
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={()=>window.location.reload()}
              className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-amber-300"
            >
              Reload app
            </button>
            <button
              type="button"
              onClick={this.props.onReset}
              className="rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:border-zinc-500 hover:text-zinc-50"
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
