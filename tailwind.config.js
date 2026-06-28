/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './client/index.html',
    './client/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0f5ff',
          100: '#e0ebff',
          200: '#b8d4ff',
          300: '#85b8ff',
          400: '#4d94ff',
          500: '#1a6fff',
          600: '#0052d9',
          700: '#003eb3',
          800: '#002d8a',
          900: '#001f5c',
        },
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  },
};
