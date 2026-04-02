/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}", "./App.jsx"],
  theme: {
    extend: {
      fontFamily: {
        display: ["Playfair Display", "serif"],
        sans: ["DM Sans", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      colors: {
        screen: "#0c0c0e",
      },
      animation: {
        "toast-in": "toast-in 0.25s ease-out forwards",
      },
      keyframes: {
        "toast-in": {
          from: { opacity: "0", transform: "translateX(1rem)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
      },
    },
  },
  plugins: [],
};