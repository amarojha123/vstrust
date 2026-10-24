import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(process.cwd(), 'src') } },
  server: { host: '0.0.0.0', proxy: { '/api': process.env.VITE_API_PROXY ?? 'http://localhost:4000' } },
})
