import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite'
import preact from '@preact/preset-vite'
import { fileURLToPath } from 'node:url'

// Extra HTML entry points besides the root desktop page. Each lives in
// `<name>/index.html` and is served at `/<name>/`.
const pages = ['val_scraper']

// Static hosts redirect `/val_scraper` to `/val_scraper/` on their own, but
// Vite's dev and preview servers fall back to the root page instead. Mirror
// the host behaviour locally so the slash-less URL works too.
function trailingSlashRedirect(): Plugin {
  const redirect = (server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      const [pathname, query = ''] = (req.url ?? '').split('?')
      if (pages.includes(pathname.replace(/^\//, ''))) {
        res.statusCode = 301
        res.setHeader('Location', `${pathname}/${query ? `?${query}` : ''}`)
        res.end()
        return
      }
      next()
    })
  }
  return {
    name: 'trailing-slash-redirect',
    configureServer: redirect,
    configurePreviewServer: redirect,
  }
}

// Proxy `/api/henrik/*` to the HenrikDev Valorant API and attach the API key
// from `.env` on the server side, so the key never reaches the browser.
// In production the same route is served by functions/api/henrik (Cloudflare Pages).
function henrikProxy(env: Record<string, string>): Record<string, ProxyOptions> {
  const target = env.HENRIKDEV_API_BASE || 'https://api.henrikdev.xyz'
  const key = env.HENRIKDEV_API_KEY
  if (!key) {
    console.warn('[val_scraper] HENRIKDEV_API_KEY is not set; /api/henrik requests will be rejected upstream. See .env.example.')
  }
  return {
    '/api/henrik': {
      target,
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api\/henrik/, ''),
      headers: key ? { Authorization: key } : {},
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxy = henrikProxy(env)
  return {
    plugins: [preact(), trailingSlashRedirect()],
    server: { proxy },
    preview: { proxy },
    build: {
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          ...Object.fromEntries(
            pages.map((page) => [page, fileURLToPath(new URL(`./${page}/index.html`, import.meta.url))]),
          ),
        },
      },
    },
  }
})
