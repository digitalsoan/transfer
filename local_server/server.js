/**
 * LocalShare - Zero-dependency Node.js HTTP Server
 * Supports:
 * - Real-time active devices heartbeat (PC <-> iOS radar)
 * - Chunked uploads (10GB+ video files)
 * - HTTP Range streaming (for smooth iOS Safari video playback/seeking)
 * - Automatic IP discovery
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = 8080;
const ROOT_DIR = path.join(__dirname, '..');
const SHARED_DIR = fs.existsSync(path.join(ROOT_DIR, 'index.html')) ? path.join(ROOT_DIR, 'shared_files') : path.join(__dirname, 'shared_files');
const TEMP_DIR = path.join(SHARED_DIR, '.temp');
const NOTES_FILE = path.join(SHARED_DIR, '.notes.txt');
const DEVICES_FILE = path.join(TEMP_DIR, 'devices.json');

if (!fs.existsSync(SHARED_DIR)) fs.mkdirSync(SHARED_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Get local IPv4 addresses
function getLocalIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  ips.sort((a, b) => {
    const aP = a.startsWith('192.168.') || a.startsWith('10.');
    const bP = b.startsWith('192.168.') || b.startsWith('10.');
    if (aP && !bP) return -1;
    if (!aP && bP) return 1;
    return 0;
  });
  return ips;
}

const MIME_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json'
};

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Upload-Id, X-File-Name, X-Chunk-Index, X-Total-Chunks, X-File-Size');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // 1. UI
  if (pathname === '/' || pathname === '/index.html' || pathname === '/local_share.html') {
    const candidateFiles = [
      path.join(ROOT_DIR, 'index.html'),
      path.join(__dirname, 'index.html'),
      path.join(ROOT_DIR, 'local_share.html'),
      path.join(__dirname, 'local_share.html')
    ];
    const htmlFile = candidateFiles.find(f => fs.existsSync(f));
    if (htmlFile) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlFile).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('index.html not found');
    return;
  }

  // 2. Info
  if (pathname === '/api/info') {
    const ips = getLocalIps();
    const files = fs.readdirSync(SHARED_DIR).filter(f => !f.startsWith('.'));
    let totalBytes = 0;
    files.forEach(f => {
      try { totalBytes += fs.statSync(path.join(SHARED_DIR, f)).size; } catch (e) {}
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      ips,
      primaryIp: ips[0] || '127.0.0.1',
      port: PORT,
      wifiSsid: 'Airtel_DGson',
      fileCount: files.length,
      totalBytes,
      sharedDir: SHARED_DIR
    }));
    return;
  }

  // 3. Heartbeat (Connected Devices Radar)
  if (pathname === '/api/heartbeat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const deviceId = data.deviceId;
        if (!deviceId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false }));
          return;
        }

        let clientIp = req.socket.remoteAddress || '127.0.0.1';
        if (clientIp.startsWith('::ffff:')) clientIp = clientIp.substring(7);
        if (clientIp === '::1') clientIp = '127.0.0.1';

        let devices = {};
        if (fs.existsSync(DEVICES_FILE)) {
          try { devices = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8') || '{}'); } catch (e) {}
        }

        const now = Math.floor(Date.now() / 1000);
        devices[deviceId] = {
          id: deviceId,
          name: (data.name || 'Device').slice(0, 40),
          type: data.type || 'desktop',
          os: data.os || 'Unknown',
          browser: data.browser || 'Browser',
          ip: clientIp,
          lastSeen: now
        };

        const active = {};
        for (const [id, d] of Object.entries(devices)) {
          if (now - (d.lastSeen || 0) <= 6) {
            active[id] = d;
          }
        }

        fs.writeFileSync(DEVICES_FILE, JSON.stringify(active));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, devices: Object.values(active) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 4. Leave
  if (pathname === '/api/leave' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (data.deviceId && fs.existsSync(DEVICES_FILE)) {
          const devices = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8') || '{}');
          delete devices[data.deviceId];
          fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices));
        }
      } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  // 5. Files list
  if (pathname === '/api/files') {
    try {
      const entries = fs.readdirSync(SHARED_DIR).filter(f => !f.startsWith('.'));
      const items = entries.map(name => {
        const full = path.join(SHARED_DIR, name);
        const stat = fs.statSync(full);
        const ext = path.extname(name).toLowerCase().replace('.', '');
        return {
          name,
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs / 1000),
          mime: getMime(full),
          ext,
          isImage: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'].includes(ext),
          isVideo: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(ext),
          isAudio: ['mp3', 'm4a', 'wav', 'aac', 'flac'].includes(ext),
          isDoc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'zip', 'rar', '7z'].includes(ext)
        };
      });
      items.sort((a, b) => b.mtime - a.mtime);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, files: items }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // 6. Chunked Upload
  if (pathname === '/api/upload_chunk' && req.method === 'POST') {
    const uploadId = req.headers['x-upload-id'] || '';
    const rawFileName = req.headers['x-file-name'] || '';
    const chunkIndex = parseInt(req.headers['x-chunk-index'] || '-1', 10);
    const totalChunks = parseInt(req.headers['x-total-chunks'] || '-1', 10);

    if (!uploadId || !rawFileName || chunkIndex < 0 || totalChunks <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid headers' }));
      return;
    }

    let fileName = path.basename(decodeURIComponent(rawFileName)).replace(/[\/\\:*?"<>|]/g, '_');
    if (!fileName) fileName = `upload_${Date.now()}`;

    const partPath = path.join(TEMP_DIR, `${uploadId.replace(/[^a-zA-Z0-9_-]/g, '')}.part`);
    const stream = fs.createWriteStream(partPath, { flags: chunkIndex === 0 ? 'w' : 'a' });

    req.pipe(stream);
    stream.on('finish', () => {
      if (chunkIndex === totalChunks - 1) {
        let dest = path.join(SHARED_DIR, fileName);
        if (fs.existsSync(dest)) {
          const ext = path.extname(fileName);
          const base = path.basename(fileName, ext);
          let count = 1;
          while (fs.existsSync(path.join(SHARED_DIR, `${base} (${count})${ext}`))) {
            count++;
          }
          fileName = `${base} (${count})${ext}`;
          dest = path.join(SHARED_DIR, fileName);
        }
        fs.renameSync(partPath, dest);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, completed: true, fileName }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, chunk: chunkIndex }));
      }
    });
    return;
  }

  // 7. Download & Preview (With HTTP Range for iOS Safari)
  if (pathname === '/api/download' || pathname === '/api/preview') {
    const fileName = path.basename(parsedUrl.searchParams.get('file') || '');
    const filePath = path.join(SHARED_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const isInline = pathname === '/api/preview';
    const range = req.headers.range;

    const mime = getMime(filePath);
    const disposition = isInline ? 'inline' : 'attachment';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mime,
        'Content-Disposition': `${disposition}; filename="${encodeURIComponent(fileName)}"`
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': mime,
        'Content-Disposition': `${disposition}; filename="${encodeURIComponent(fileName)}"`
      });
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }

  // 8. Delete
  if (pathname === '/api/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { file } = JSON.parse(body || '{}');
        const target = path.join(SHARED_DIR, path.basename(file || ''));
        if (fs.existsSync(target)) {
          fs.unlinkSync(target);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          return;
        }
      } catch (e) {}
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false }));
    });
    return;
  }

  // 9. Notes
  if (pathname === '/api/notes') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { note } = JSON.parse(body || '{}');
          fs.writeFileSync(NOTES_FILE, note || '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, note }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false }));
        }
      });
      return;
    }
    const note = fs.existsSync(NOTES_FILE) ? fs.readFileSync(NOTES_FILE, 'utf8') : '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, note }));
    return;
  }

  // 10. Open PC folder
  if (pathname === '/api/open_folder' && req.method === 'POST') {
    exec(`explorer "${SHARED_DIR}"`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIps();
  console.log('================================================================');
  console.log('              LOCALSHARE - PC & iOS FILE TRANSFER               ');
  console.log('================================================================');
  console.log(`  Wi-Fi SSID       : Airtel_DGson`);
  console.log(`  PC Local IP      : ${ips[0] || '127.0.0.1'}`);
  console.log(`  Server Port      : ${PORT}`);
  console.log(`\n  Open in Safari on iPhone (connected to Airtel_DGson Wi-Fi):`);
  console.log(`  --> http://${ips[0] || '127.0.0.1'}:${PORT}\n`);
  console.log('  Press Ctrl+C to stop.');
  console.log('================================================================');
});
