/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: '#0d1117',
        surface: '#161b22',
        border: '#30363d',
        primary: '#58a6ff',
      },
      borderRadius: {
        control: 'var(--control-radius, 8px)',
        card: 'var(--card-radius, 12px)',
        dialog: 'var(--dialog-radius, 14px)',
        xs: 'var(--vl-radius-xs, 4px)',
        sm: 'var(--vl-radius-sm, 6px)',
        md: 'var(--control-radius, 8px)',
        lg: 'var(--card-radius, 12px)',
        xl: 'var(--dialog-radius, 14px)',
        pill: '9999px',
      },
    },
  },
  plugins: [],
};
