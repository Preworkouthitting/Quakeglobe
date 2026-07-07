import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Dev-only: POST /__snapshot with a data-URL body writes snapshots/<name>.jpg,
// so WebGL frames can be captured for verification from the browser console.
function snapshotPlugin() {
  return {
    name: 'dev-snapshot',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__snapshot', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          const name = (new URL(req.url, 'http://x').searchParams.get('name') || 'snap')
            .replace(/[^a-z0-9_-]/gi, '');
          const b64 = body.replace(/^data:image\/\w+;base64,/, '');
          const dir = path.join(server.config.root, 'snapshots');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, name + '.jpg'), Buffer.from(b64, 'base64'));
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  // relative base so the build works at any GitHub Pages path
  base: './',
  plugins: [snapshotPlugin()],
});
