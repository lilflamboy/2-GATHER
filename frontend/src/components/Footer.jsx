import { Instagram, Mail, Heart } from "lucide-react";

export default function Footer() {
  return (
    <footer className="relative z-10 w-full py-8 mt-auto flex flex-col items-center justify-center gap-2 text-sm text-zinc-600 bg-white/40 backdrop-blur-md border-t border-pink-200/50">
      <p className="flex items-center gap-1.5 font-medium">
        built and designed with <Heart size={14} className="text-pink-500 fill-pink-500" /> by{" "}
        <a
          href="https://instagram.com/lilflamboy"
          target="_blank"
          rel="noopener noreferrer"
          className="font-bold text-purple-600 hover:text-pink-500 hover:underline transition-colors"
        >
          PRATIK
        </a>
      </p>
      <div className="flex items-center gap-4 text-xs font-medium">
        <a
          href="https://instagram.com/lilflamboy"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 hover:text-purple-600 transition-colors"
        >
          <Instagram size={14} /> @lilflamboy
        </a>
        <a
          href="mailto:pratikpatil7612@gmail.com"
          className="flex items-center gap-1.5 hover:text-purple-600 transition-colors"
        >
          <Mail size={14} /> pratikpatil7612@gmail.com
        </a>
      </div>
    </footer>
  );
}
