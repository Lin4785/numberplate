/**
 * 极简 HTTP 工具：路由匹配、JSON 响应、请求体解析、Cookie、静态文件。
 */
import fs from 'node:fs';
import path from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 读取请求体并解析为 JSON（超过 1MB 直接拒绝） */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('请求体不是合法的 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendError(res, statusCode, message, extra = {}) {
  sendJson(res, statusCode, { ok: false, error: message, ...extra });
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const jar = {};
  if (!header) return jar;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    jar[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return jar;
}

export function setCookie(res, name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`);
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

export function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

/**
 * 一个非常小的路由器：支持 /api/xxx/:param 形式的路径参数。
 */
export function createRouter() {
  const routes = [];

  const add = (method) => (pattern, handler) => {
    const keys = [];
    const regexSource = pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          keys.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    routes.push({ method, regex: new RegExp(`^${regexSource}/?$`), keys, handler });
  };

  return {
    get: add('GET'),
    post: add('POST'),
    patch: add('PATCH'),
    put: add('PUT'),
    delete: add('DELETE'),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const result = route.regex.exec(pathname);
        if (!result) continue;
        const params = {};
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(result[index + 1]);
        });
        return { handler: route.handler, params };
      }
      return null;
    },
  };
}

/** 静态文件服务（带路径穿越防护与简单缓存控制） */
export function serveStatic(rootDir, urlPath, res) {
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const target = path.resolve(rootDir, relative);
  const rootResolved = path.resolve(rootDir);

  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    sendError(res, 403, 'Forbidden');
    return true;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;

  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

export function clientIp(req) {
  return req.socket?.remoteAddress || '-';
}
