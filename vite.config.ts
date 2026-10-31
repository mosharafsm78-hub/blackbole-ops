import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    // Cloudflare Workers Builds set WORKERS_CI=1; Vercel builds keep the Vercel preset
    nitro({ ...(process.env.WORKERS_CI ? { preset: 'cloudflare_module', cloudflare: { deployConfig: false, nodeCompat: true } } : {}), vercel: { functions: { regions: ['sin1'] } } } as any),
    viteReact(),
  ],
})
