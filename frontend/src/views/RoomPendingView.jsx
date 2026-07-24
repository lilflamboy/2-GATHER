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
    <div className="min-h-screen bg-screen relative flex flex-col items-center justify-center overflow-hidden px-6 py-10">
      <div className="grain-overlay"/>
      <div className="absolute inset-x-0 top-[-18rem] h-[30rem] bg-[radial-gradient(circle_at_top,rgba(251,146,60,0.16),transparent_55%)] pointer-events-none"/>
      <div className="absolute right-[-8rem] top-16 h-[20rem] w-[20rem] rounded-full bg-purple-500/10 blur-3xl pointer-events-none"/>
      <div className="relative z-10 flex w-full max-w-md flex-col gap-6">
        <div className="glass-panel relative overflow-hidden border border-pink-200 bg-white/[0.03] p-6 shadow-[0_32px_120px_rgba(0,0,0,0.52)]">
          <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"/>
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-pink-200 bg-white/[0.04]">
              <div className="h-10 w-10 rounded-full border-2 border-zinc-700 border-t-pink-300 animate-spin"/>
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-800">{label}</p>
              <p className="text-xs leading-6 text-zinc-600">Hang tight, connecting to the room.</p>
            </div>
          </div>
          {/* Cancel lets the user bail out of a stuck room transition and return to the lobby. */}
          <button
            type="button"
            onClick={onCancel}
            className="mt-4 text-xs text-zinc-600 transition-all duration-200 hover:text-zinc-700"
          >
            Cancel and return to lobby
          </button>
        </div>
      </div>
    </div>
  );
}

export default RoomPendingView
