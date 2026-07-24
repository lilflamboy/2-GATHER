const fs = require('fs');
const files = [
  'c:/Users/prati/.gemini/antigravity/scratch/lumiere/frontend/src/views/RoomView.jsx',
  'c:/projects/2-GATHER/frontend/src/views/RoomView.jsx'
];

files.forEach(path => {
  if (!fs.existsSync(path)) return;
  let content = fs.readFileSync(path, 'utf8');
  
  content = content.replace(/border-white\/10 bg-white\/\[0\.03\] text-zinc-800 hover:border-white\/18 hover:text-zinc-100/g, 'border-white/10 bg-white/[0.03] text-zinc-300 hover:border-white/18 hover:text-zinc-100');
  content = content.replace(/border-pink-300 bg-white\/\[0\.06\] text-zinc-900 hover:bg-white\/\[0\.12\]/g, 'border-white/10 bg-white/[0.06] text-zinc-300 hover:bg-white/[0.12]');
  content = content.replace(/<Link2 size=\{14\} className="shrink-0 text-zinc-800"\/>/g, '<Link2 size={14} className="shrink-0 text-zinc-400"/>');

  fs.writeFileSync(path, content, 'utf8');
});
console.log('Fixed final contrast bugs.');
