/**
 * RoomPendingView is a lightweight transition screen shown while the app is
 * creating or joining a room and waiting for the backend to answer.
 */
/**
 * Renders the interim room-connection state.
 * @param {{label?: string, onCancel?: () => void}} props - Progress label and cancel callback.
 * @returns {JSX.Element} The pending room screen.
 */
function RoomPendingView({label="Joining room...",onCancel}){
  return(
    <div className="min-h-screen bg-screen flex flex-col items-center justify-center p-6 relative overflow-hidden">
      <div className="grain-overlay"/>
      <div className="relative z-10 w-full max-w-md bg-zinc-900/70 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full border-2 border-zinc-700 border-t-amber-300 animate-spin"/>
          <div>
            <p className="text-zinc-200 font-semibold text-sm">{label}</p>
            <p className="text-zinc-500 text-xs">Hang tight, connecting to the room.</p>
          </div>
        </div>
        {/* Cancel lets the user bail out of a stuck room transition and return to the lobby. */}
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Cancel and return to lobby
        </button>
      </div>
    </div>
  );
}

export default RoomPendingView
