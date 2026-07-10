import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Dev-only: POST /__snapshot with a data-URL body writes snapshots/<name>.jpg,
// so WebGL frames can be captured for verification from the browser console.
function snapshotPlugin() {
  const EXT_ALLOWED = new Set(['jpg', 'png', 'ktx2']);
  return {
    name: 'dev-snapshot',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__snapshot', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        // Any website can fire-and-forget POSTs at localhost; only accept
        // requests originating from this dev server's own pages.
        const origin = req.headers.origin || '';
        if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          res.statusCode = 403;
          return res.end('cross-origin rejected');
        }
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          const q = new URL(req.url, 'http://x').searchParams;
          const name = (q.get('name') || 'snap').replace(/[^a-z0-9_-]/gi, '');
          const ext = (q.get('ext') || 'jpg').replace(/[^a-z0-9]/gi, '');
          if (!EXT_ALLOWED.has(ext)) { res.statusCode = 400; return res.end('ext not allowed'); }
          // dir=textures writes into public/textures (dev asset pipeline)
          const dir = q.get('dir') === 'textures'
            ? path.join(server.config.root, 'public', 'textures')
            : path.join(server.config.root, 'snapshots');
          const b64 = body.replace(/^data:[\w/+.-]+;base64,/, '');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, name + '.' + ext), Buffer.from(b64, 'base64'));
          res.end('ok');
        });
      });
    },
  };
}

// Production only: GitHub Pages can't send response headers, so the CSP
// ships as a <meta> tag injected at build time (a meta CSP in dev would
// break Vite's HMR websocket). data: images cover the inline SVG favicon;
// 'unsafe-inline' styles cover style attributes (legend dots, tooltip
// positioning). frame-ancestors can't be set via meta — accepted residual,
// Pages can't send headers at all. (KTX2/basis was removed partly because
// its Emscripten glue needed 'unsafe-eval' — this policy stays strict.)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "connect-src 'self' https://earthquake.usgs.gov",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function cspPlugin() {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8">',
        `<meta charset="UTF-8">\n<meta http-equiv="Content-Security-Policy" content="${CSP}">`
      );
    },
  };
}

export default defineConfig({
  // relative base so the build works at any GitHub Pages path
  base: './',
  plugins: [snapshotPlugin(), cspPlugin()],
});
