/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{html,js,svelte,ts}"],
  theme: {
    extend: {
      colors: {
        ink: "#1f2933",
        panel: "#f7f8fa",
        line: "#d7dde5",
        accent: "#0f766e",
        signal: "#b45309"
      }
    }
  },
  plugins: []
};
