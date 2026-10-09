import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GitHub Pages serves the app under /<repo-name>/. CI passes the repo name in
// VITE_BASE so a repo rename can't break asset paths; locally it defaults to
// the current repo.
const base = process.env.VITE_BASE ?? '/mind_map/'

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
})
