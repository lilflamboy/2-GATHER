/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}", "./App.jsx"],
  theme: {
    extend: {
      keyframes: {
        wiggle: {
          "0%, 100%": { transform: "rotate(-6deg)" },
          "50%": { transform: "rotate(6deg)" },
        },
        "toast-in": {
          from: { opacity: "0", transform: "translateX(1rem)" },
          to: { opacity: "1", transform: "translateX(0)" },
        }
      },
      animation: {
        wiggle: "wiggle 0.3s ease-in-out infinite",
        "toast-in": "toast-in 0.25s ease-out forwards",
      },
      fontFamily: {
        display: ["DynaPuff", "Comic Sans MS", "cursive"],
        sans: ["Nunito", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      colors: {
        screen: "#0c0c0e",
      },
    },
  },
  plugins: [],
};
