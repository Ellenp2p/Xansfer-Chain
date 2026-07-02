/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef7ff',
          100: '#d9edff',
          200: '#bce0ff',
          300: '#8ecdff',
          400: '#59b1ff',
          500: '#3390ff',
          600: '#1a6ff5',
          700: '#135ae1',
          800: '#1649b6',
          900: '#18408f',
          950: '#142857',
        },
      },
    },
  },
  plugins: [],
}
