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

// LOCAL ONLY: proxy `/api/henrik/*` to the HenrikDev Valorant API from the Vite
// dev/preview server, attaching the API key read from `.env`. The key never
// reaches the browser.
//
// PRODUCTION: this proxy is not part of the build. The same `/api/henrik/*`
// route is served by the Cloudflare Pages Function in functions/api/henrik,
// which reads HENRIKDEV_API_KEY from the Cloudflare project's variables.
function henrikProxy(env: Record<string, string>): Record<string, ProxyOptions> {
  const target = env.HENRIKDEV_API_BASE || 'https://api.henrikdev.xyz'
  const key = env.HENRIKDEV_API_KEY
  if (!key) {
    console.warn('[val_scraper] HENRIKDEV_API_KEY is not set in .env; /api/henrik requests will be rejected upstream. See .env.example.')
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
export default defineConfig(({ command, mode }) => {
  // `.env` is only consulted when running a local server (`vite` / `vite preview`).
  // `vite build` never reads it, so production builds carry no key and print no warning.
  const isLocalServer = command === 'serve'
  const proxy = isLocalServer ? henrikProxy(loadEnv(mode, process.cwd(), '')) : undefined
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
