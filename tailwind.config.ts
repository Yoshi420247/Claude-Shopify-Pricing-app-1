import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        profit: '#22c55e',
        loss: '#ef4444',
        ai: '#3b82f6',
        warning: '#eab308',
        neutral: '#6b7280',
      },
    },
  },
  plugins: [],
};
export default config;
