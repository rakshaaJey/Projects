import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite'
import preact from '@preact/preset-vite'
import { fileURLToPath } from 'node:url'

// Extra HTML entry points besides the root desktop page. Each lives in
// `<name>/index.html` and is served at `/<name>/`.
const pages = ['val_scraper', 'mr_scraper']

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

// LOCAL ONLY: proxy the `/api/*` routes to their upstream APIs from the Vite
// dev/preview server, attaching the API keys read from `.env`. The keys never
// reach the browser.
//
// PRODUCTION: these proxies are not part of the build. The same routes are
// served by the Cloudflare Pages Functions in functions/api/*, which read the
// keys from the Cloudflare project's variables.
type UpstreamProxy = {
  route: string // local path prefix, e.g. /api/henrik
  keyVar: string // env var holding the API key
  baseVar: string // env var that can override the upstream base URL
  defaultBase: string
  header: string // request header that carries the key
  page: string // which page uses it (for the warning message)
}

const upstreams: UpstreamProxy[] = [
  {
    route: '/api/henrik',
    keyVar: 'HENRIKDEV_API_KEY',
    baseVar: 'HENRIKDEV_API_BASE',
    defaultBase: 'https://api.henrikdev.xyz',
    header: 'Authorization',
    page: 'val_scraper',
  },
  {
    route: '/api/mr',
    keyVar: 'MARVELRIVALS_API_KEY',
    baseVar: 'MARVELRIVALS_API_BASE',
    defaultBase: 'https://marvelrivalsapi.com/api',
    header: 'x-api-key',
    page: 'mr_scraper',
  },
]

function apiProxies(env: Record<string, string>): Record<string, ProxyOptions> {
  const proxy: Record<string, ProxyOptions> = {}
  for (const u of upstreams) {
    const target = (env[u.baseVar] || u.defaultBase).replace(/\/+$/, '')
    const key = env[u.keyVar]
    if (!key) {
      console.warn(`[${u.page}] ${u.keyVar} is not set in .env; ${u.route} requests will be rejected upstream. See .env.example.`)
    }
    // The upstream base may carry a path prefix (e.g. ".../api"), so proxy to
    // its origin and prepend that prefix to the path after the local route.
    const targetUrl = new URL(target)
    const basePath = targetUrl.pathname.replace(/\/+$/, '')
    proxy[u.route] = {
      target: targetUrl.origin,
      changeOrigin: true,
      rewrite: (path) => basePath + path.replace(new RegExp(`^${u.route}`), ''),
      headers: key ? { [u.header]: key } : {},
    }
  }
  return proxy
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // `.env` is only consulted when running a local server (`vite` / `vite preview`).
  // `vite build` never reads it, so production builds carry no key and print no warning.
  const isLocalServer = command === 'serve'
  const proxy = isLocalServer ? apiProxies(loadEnv(mode, process.cwd(), '')) : undefined
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
