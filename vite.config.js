import { defineConfig } from 'vite'
import diffWatcher from './watcher-plugin.js'

export default defineConfig({
  plugins: [diffWatcher()],
  server: { open: true },
})
