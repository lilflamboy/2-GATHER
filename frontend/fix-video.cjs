const fs = require('fs');
const files = [
  'c:/Users/prati/.gemini/antigravity/scratch/lumiere/frontend/src/views/RoomView.jsx',
  'c:/projects/2-GATHER/frontend/src/views/RoomView.jsx'
];

files.forEach(path => {
  if (!fs.existsSync(path)) return;
  let lines = fs.readFileSync(path, 'utf8').split('\n');
  
  for(let i = 3480; i < 3590; i++) {
    if(!lines[i]) continue;
    // We are inside the video upload area. It should be dark theme when isReadingMode is false.
    lines[i] = lines[i].replace(/"text-zinc-800"/g, '"text-zinc-300"');
    lines[i] = lines[i].replace(/:"text-zinc-800"/g, ':"text-zinc-300"');
    lines[i] = lines[i].replace(/:"text-zinc-900"/g, ':"text-zinc-100"');
    lines[i] = lines[i].replace(/:"border-pink-300 bg-white\/50/g, ':"border-white/10 bg-white/[0.03]');
    lines[i] = lines[i].replace(/hover:text-zinc-800"/g, 'hover:text-zinc-100"');
    lines[i] = lines[i].replace(/:"text-zinc-800 placeholder-zinc-600"/g, ':"text-zinc-200 placeholder-zinc-400"');
    lines[i] = lines[i].replace(/:"border-pink-300 bg-zinc-900\/70"/g, ':"border-white/10 bg-black/40"');
    lines[i] = lines[i].replace(/:"border-pink-300 bg-zinc-900 shadow-black\/40"/g, ':"border-white/10 bg-white/5 shadow-black/40"');
    
    // Fix the "Choose Video File" button which got replaced to bg-purple earlier
    lines[i] = lines[i].replace(/:"border-purple-300 bg-purple-500\/10 hover:border-purple-300\/40 hover:bg-purple-500\/15"/g, ':"border-amber-400/20 bg-amber-500/10 hover:border-amber-400/40 hover:bg-amber-500/20"');
    lines[i] = lines[i].replace(/from-purple-700\/0 via-purple-700\/10 to-purple-700\/0/g, 'from-amber-400/0 via-amber-400/10 to-amber-400/0');
    lines[i] = lines[i].replace(/:"text-purple-700"/g, ':"text-amber-200"');
  }
  
  fs.writeFileSync(path, lines.join('\n'), 'utf8');
});
console.log('Fixed video area contrast successfully.');
