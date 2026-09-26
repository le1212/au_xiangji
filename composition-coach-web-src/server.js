/*
 * 零依赖静态服务器 —— 仅用于本地开发预览。
 * 相机权限要求安全上下文：localhost 可直接使用；
 * 手机访问需 HTTPS（见 README）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BASE_PORT = 5177;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serve(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    // 非法百分号编码（如 /%C3、/%zz）：decodeURIComponent 会抛错，
    // 不接住会把整个服务器进程击穿（LAN 内任意设备可触发）
    res.writeHead(400);
    return res.end('Bad Request');
  }
  let filePath = path.normalize(path.join(ROOT, urlPath));
  // 必须整段目录匹配：裸前缀匹配会漏掉同前缀兄弟目录（如 xxx-web-src-backup）
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (urlPath === '/' || urlPath === '') {
    filePath = path.join(ROOT, 'index.html');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function listen(port) {
  const server = http.createServer(serve);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < BASE_PORT + 10) {
      listen(port + 1);
    } else {
      console.error('服务器启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    console.log('');
    console.log('  构图教练 · Composition Coach');
    console.log('  ---------------------------');
    console.log(`  本地取景器:  http://localhost:${port}`);
    console.log('  手机使用需 HTTPS，见 README.md');
    console.log('');
  });
}

listen(BASE_PORT);
