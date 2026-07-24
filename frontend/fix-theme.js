const fs = require('fs');
const path = require('path');

function processDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            processDir(fullPath);
        } else if (fullPath.endsWith('.jsx') || fullPath.endsWith('.js')) {
            let content = fs.readFileSync(fullPath, 'utf8');
            let original = content;
            
            // Fix broken emojis
            content = content.replace(/2-GATHER \?\?/g, '2-GATHER 🐱');
            
            // Light theme color fixes
            content = content.replace(/text-purple-300/g, 'text-purple-600');
            content = content.replace(/text-amber-100/g, 'text-purple-700');
            content = content.replace(/text-emerald-200/g, 'text-emerald-600');
            content = content.replace(/text-emerald-300/g, 'text-emerald-600');
            content = content.replace(/text-pink-300/g, 'text-pink-600');
            content = content.replace(/text-violet-100/g, 'text-purple-700');
            content = content.replace(/text-red-200/g, 'text-red-600');
            content = content.replace(/text-zinc-500/g, 'text-zinc-600');
            content = content.replace(/text-zinc-400/g, 'text-zinc-600');
            content = content.replace(/border-white\/8/g, 'border-pink-200');
            content = content.replace(/border-white\/16/g, 'border-pink-300');
            content = content.replace(/bg-black\/25/g, 'bg-white/70');
            content = content.replace(/bg-black\/30/g, 'bg-white/70');
            
            if (content !== original) {
                fs.writeFileSync(fullPath, content, 'utf8');
            }
        }
    }
}

processDir('c:\\Users\\prati\\.gemini\\antigravity\\scratch\\lumiere\\frontend\\src');
