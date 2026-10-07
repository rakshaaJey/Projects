import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite'
import preact from '@preact/preset-vite'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

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
  baseVar: string // env var that can override the upstream base URL
  defaultBase: string
  page: string // which page uses it (for the warning message)
  /** Set when the upstream needs an API key: the env var holding it and the header it goes in. */
  key?: { envVar: string; header: string }
}

const upstreams: UpstreamProxy[] = [
  {
    route: '/api/henrik',
    baseVar: 'HENRIKDEV_API_BASE',
    defaultBase: 'https://api.henrikdev.xyz',
    page: 'val_scraper',
    key: { envVar: 'HENRIKDEV_API_KEY', header: 'Authorization' },
  },
  // rivalsdata.com (/api/rd), mr_scraper's primary source, is not in this list: see curlProxy below.
  {
    // rivalsmeta.com's own JSON API; no key needed. mr_scraper's last resort for players, history and
    // hero meta. https://api.rivalstracker.com/api serves the same data.
    route: '/api/mr',
    baseVar: 'RIVALSMETA_API_BASE',
    defaultBase: 'https://rivalsmeta.com/api',
    page: 'mr_scraper',
  },
]

function apiProxies(env: Record<string, string>): Record<string, ProxyOptions> {
  const proxy: Record<string, ProxyOptions> = {}
  for (const u of upstreams) {
    const target = (env[u.baseVar] || u.defaultBase).replace(/\/+$/, '')
    const key = u.key ? env[u.key.envVar] : undefined
    if (u.key && !key) {
      console.warn(`[${u.page}] ${u.key.envVar} is not set in .env; ${u.route} requests will be rejected upstream (the page falls back where it can). See .env.example.`)
    }
    // The upstream base may carry a path prefix (e.g. ".../api"), so proxy to
    // its origin and prepend that prefix to the path after the local route.
    const targetUrl = new URL(target)
    const basePath = targetUrl.pathname.replace(/\/+$/, '')
    proxy[u.route] = {
      target: targetUrl.origin,
      changeOrigin: true,
      rewrite: (path) => basePath + path.replace(new RegExp(`^${u.route}`), ''),
      headers: u.key && key ? { [u.key.header]: key } : {},
    }
  }
  return proxy
}

// LOCAL ONLY: rivalsdata.com's own JSON API (no key), mr_scraper's primary source for players, match
// history and the hero meta. Its Cloudflare bot check keys on the TLS handshake: Node's HTTPS stack
// (so http-proxy and fetch) gets a challenge page back, while the system curl gets through (Windows
// curl 8.x with Schannel, observed 2026-10-07). So this route is served by shelling out to curl.
// In production the Pages Function in functions/api/rd fetches it from Cloudflare's own network.
const RIVALSDATA_ROUTE = '/api/rd'
const RIVALSDATA_DEFAULT_BASE = 'https://api.rivalsdata.com'
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const CURL_META = '\n__CURL_META__ '

function curlProxy(env: Record<string, string>): Plugin {
  const base = (env.RIVALSDATA_API_BASE || RIVALSDATA_DEFAULT_BASE).replace(/\/+$/, '')
  const fail = (res: any, message: string) => {
    res.statusCode = 502
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ message }))
  }
  const attach = (server: { middlewares: { use: (path: string, fn: (req: any, res: any) => void) => void } }) => {
    server.middlewares.use(RIVALSDATA_ROUTE, (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        // Under a mounted middleware, req.url is already relative to the route.
        const args = ['-sS', '--max-time', '30', '-X', req.method ?? 'GET', '-w', `${CURL_META}%{http_code} %{content_type}`]
        args.push('-H', 'Accept: application/json', '-H', `User-Agent: ${BROWSER_USER_AGENT}`)
        if (chunks.length > 0) args.push('-H', `Content-Type: ${req.headers['content-type'] ?? 'application/json'}`, '--data-binary', '@-')
        args.push(base + (req.url ?? ''))
        const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] })
        const out: Buffer[] = []
        let err = ''
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
        child.stderr.on('data', (chunk: Buffer) => (err += chunk))
        child.on('error', (e) => fail(res, `curl could not be started (${e.message}); the rivalsdata.com proxy needs curl on PATH.`))
        child.on('close', (code) => {
          const text = Buffer.concat(out).toString('utf8')
          const at = text.lastIndexOf(CURL_META)
          if (code !== 0 || at < 0) return fail(res, `rivalsdata.com request failed (curl exit ${code}): ${err.trim() || 'no response'}`)
          const [status, ...type] = text.slice(at + CURL_META.length).trim().split(' ')
          res.statusCode = Number(status) || 502
          res.setHeader('Content-Type', type.join(' ') || 'application/json')
          res.end(text.slice(0, at))
        })
        child.stdin.end(chunks.length > 0 ? Buffer.concat(chunks) : undefined)
      })
    })
  }
  return { name: 'rivalsdata-curl-proxy', configureServer: attach, configurePreviewServer: attach }
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // `.env` is only consulted when running a local server (`vite` / `vite preview`).
  // `vite build` never reads it, so production builds carry no key and print no warning.
  const isLocalServer = command === 'serve'
  const env = isLocalServer ? loadEnv(mode, process.cwd(), '') : {}
  const proxy = isLocalServer ? apiProxies(env) : undefined
  return {
    plugins: [preact(), trailingSlashRedirect(), ...(isLocalServer ? [curlProxy(env)] : [])],
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
