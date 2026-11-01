import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

function fileAt(root: string, rel: string): string | null {
  const path = normalize(join(root, rel));
  if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) return null; // ../ escape
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

/**
 * Serves the built web app (apps/web/dist) in production: the landing page at `/`, the
 * dashboard at `/app/` (any unknown path under it falls back to the dashboard's page).
 * Returns false when nothing matches.
 */
export function serveStatic(root: string, pathname: string, res: ServerResponse): boolean {
  if (pathname === '/app') {
    res.writeHead(301, { location: '/app/', ...SECURITY_HEADERS }).end();
    return true;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  let file = fileAt(root, rel === '/' ? 'index.html' : rel.endsWith('/') ? rel + 'index.html' : rel);
  if (!file && rel.startsWith('/app/') && !extname(rel)) file = fileAt(root, 'app/index.html');
  if (!file) return false;
  const immutable = rel.startsWith('/assets/'); // Vite fingerprints these
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...SECURITY_HEADERS,
  });
  createReadStream(file).pipe(res);
  return true;
}
