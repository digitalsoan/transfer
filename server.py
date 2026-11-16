"""
LocalShare - Zero-dependency Python 3 HTTP Server
Supports:
- Real-time active devices heartbeat (PC <-> iOS radar)
- Chunked uploads (handles 10GB+ video files)
- HTTP Range streaming (for smooth iOS Safari video playback/seeking)
- Automatic dynamic IP and Wi-Fi discovery
Requires: Python 3.6+ (Standard library only, 0 pip install needed)
"""

import http.server
import socketserver
import os
import json
import urllib.parse
import mimetypes
import socket
import subprocess
import time

PORT = 8080
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SHARED_DIR = os.path.join(BASE_DIR, 'shared_files')
TEMP_DIR = os.path.join(SHARED_DIR, '.temp')
NOTES_FILE = os.path.join(SHARED_DIR, '.notes.txt')
DEVICES_FILE = os.path.join(TEMP_DIR, 'devices.json')

os.makedirs(SHARED_DIR, exist_ok=True)
os.makedirs(TEMP_DIR, exist_ok=True)

def get_local_ips():
    ips = []
    try:
        output = subprocess.check_output('ipconfig', shell=True).decode('latin1', errors='ignore')
        for line in output.splitlines():
            if 'IPv4 Address' in line or 'IPv4-Adresse' in line:
                parts = line.split(':')
                if len(parts) >= 2:
                    ip = parts[1].strip()
                    if ip != '127.0.0.1' and not ip.startswith('169.254.'):
                        ips.append(ip)
    except Exception:
        pass

    if not ips:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ips.append(s.getsockname()[0])
            s.close()
        except Exception:
            ips.append("127.0.0.1")

    # Prioritize private LAN subnets
    def ip_sort_key(ip):
        if ip.startswith('192.168.') or ip.startswith('10.'):
            return 0
        return 1

    ips.sort(key=ip_sort_key)
    return list(dict.fromkeys(ips))

def get_wifi_ssid():
    try:
        output = subprocess.check_output('netsh wlan show interfaces', shell=True).decode('latin1', errors='ignore')
        for line in output.splitlines():
            if line.strip().startswith('SSID') and ':' in line:
                return line.split(':', 1)[1].strip()
    except Exception:
        pass
    return 'Wi-Fi / LAN'

class LocalShareHandler(http.server.BaseHTTPRequestHandler):
    def end_headers_cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Upload-Id, X-File-Name, X-Chunk-Index, X-Total-Chunks, X-File-Size')
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers_cors()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        # 1. UI
        if path in ['/', '/index.html', '/local_share.html']:
            html_file = os.path.join(BASE_DIR, 'local_share.html')
            if os.path.exists(html_file):
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.end_headers_cors()
                with open(html_file, 'rb') as f:
                    self.wfile.write(f.read())
                return
            self.send_error(404, "local_share.html not found")
            return

        # 2. Info
        if path == '/api/info':
            ips = get_local_ips()
            files = [f for f in os.listdir(SHARED_DIR) if not f.startswith('.')]
            total_bytes = sum(os.path.getsize(os.path.join(SHARED_DIR, f)) for f in files if os.path.isfile(os.path.join(SHARED_DIR, f)))
            data = {
                'success': True,
                'ips': ips,
                'primaryIp': ips[0] if ips else '127.0.0.1',
                'port': PORT,
                'wifiSsid': get_wifi_ssid(),
                'fileCount': len(files),
                'totalBytes': total_bytes,
                'sharedDir': SHARED_DIR
            }
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers_cors()
            self.wfile.write(json.dumps(data).encode('utf-8'))
            return

        # 3. Files List
        if path == '/api/files':
            files = []
            if os.path.exists(SHARED_DIR):
                for name in os.listdir(SHARED_DIR):
                    if name.startswith('.'):
                        continue
                    full_path = os.path.join(SHARED_DIR, name)
                    if not os.path.isfile(full_path):
                        continue
                    ext = os.path.splitext(name)[1].lower().replace('.', '')
                    stat = os.stat(full_path)
                    mime, _ = mimetypes.guess_type(full_path)
                    files.append({
                        'name': name,
                        'size': stat.st_size,
                        'mtime': int(stat.st_mtime),
                        'mime': mime or 'application/octet-stream',
                        'ext': ext,
                        'isImage': ext in ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'],
                        'isVideo': ext in ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'],
                        'isAudio': ext in ['mp3', 'm4a', 'wav', 'aac', 'flac'],
                        'isDoc': ext in ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'zip', 'rar', '7z']
                    })
            files.sort(key=lambda x: x['mtime'], reverse=True)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers_cors()
            self.wfile.write(json.dumps({'success': True, 'files': files}).encode('utf-8'))
            return

        # 4. Preview / Download (With HTTP Range for iOS video seeking)
        if path in ['/api/download', '/api/preview']:
            file_name = os.path.basename(params.get('file', [''])[0])
            full_path = os.path.join(SHARED_DIR, file_name)
            if not file_name or not os.path.isfile(full_path):
                self.send_error(404, "File not found")
                return

            file_size = os.path.getsize(full_path)
            mime, _ = mimetypes.guess_type(full_path)
            mime = mime or 'application/octet-stream'
            disposition = 'inline' if path == '/api/preview' else 'attachment'

            range_header = self.headers.get('Range')
            if range_header:
                try:
                    bytes_part = range_header.replace('bytes=', '')
                    start_str, end_str = bytes_part.split('-')
                    start = int(start_str) if start_str else 0
                    end = int(end_str) if end_str else file_size - 1
                    end = min(end, file_size - 1)
                    length = end - start + 1

                    self.send_response(206)
                    self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
                    self.send_header('Accept-Ranges', 'bytes')
                    self.send_header('Content-Length', str(length))
                    self.send_header('Content-Type', mime)
                    self.send_header('Content-Disposition', f'{disposition}; filename="{urllib.parse.quote(file_name)}"')
                    self.end_headers_cors()

                    with open(full_path, 'rb') as f:
                        f.seek(start)
                        remaining = length
                        while remaining > 0:
                            chunk = f.read(min(remaining, 64 * 1024))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
                    return
                except Exception:
                    pass

            self.send_response(200)
            self.send_header('Content-Length', str(file_size))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Type', mime)
            self.send_header('Content-Disposition', f'{disposition}; filename="{urllib.parse.quote(file_name)}"')
            self.end_headers_cors()
            with open(full_path, 'rb') as f:
                while True:
                    chunk = f.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            return

        # 5. Notes
        if path == '/api/notes':
            note = ''
            if os.path.exists(NOTES_FILE):
                try:
                    with open(NOTES_FILE, 'r', encoding='utf-8') as f:
                        note = f.read()
                except Exception:
                    pass
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers_cors()
            self.wfile.write(json.dumps({'success': True, 'note': note}).encode('utf-8'))
            return

        self.send_error(404, "Not Found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 1. Heartbeat
        if path == '/api/heartbeat':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8', errors='ignore')
            data = json.loads(body or '{}')
            device_id = data.get('deviceId')
            if not device_id:
                self.send_response(400)
                self.end_headers_cors()
                return

            client_ip = self.client_address[0]
            if client_ip in ['127.0.0.1', '::1']:
                ips = get_local_ips()
                client_ip = ips[0] if ips else '127.0.0.1'

            devices = {}
            if os.path.exists(DEVICES_FILE):
                try:
                    with open(DEVICES_FILE, 'r', encoding='utf-8') as f:
                        devices = json.load(f)
                except Exception:
                    pass

            now = int(time.time())
            devices[device_id] = {
                'id': device_id,
                'name': (data.get('name') or 'Device')[:40],
                'type': data.get('type', 'desktop'),
                'os': data.get('os', 'Unknown'),
                'browser': data.get('browser', 'Browser'),
                'ip': client_ip,
                'lastSeen': now
            }

            active = {id_: d for id_, d in devices.items() if now - d.get('lastSeen', 0) <= 6}
            try:
                with open(DEVICES_FILE, 'w', encoding='utf-8') as f:
                    json.dump(active, f)
            except Exception:
                pass

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers_cors()
            self.wfile.write(json.dumps({'success': True, 'devices': list(active.values())}).encode('utf-8'))
            return

        # 2. Leave
        if path == '/api/leave':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8', errors='ignore')
            data = json.loads(body or '{}')
            device_id = data.get('deviceId')
            if device_id and os.path.exists(DEVICES_FILE):
                try:
                    with open(DEVICES_FILE, 'r', encoding='utf-8') as f:
                        devices = json.load(f)
                    if device_id in devices:
                        del devices[device_id]
                        with open(DEVICES_FILE, 'w', encoding='utf-8') as f:
                            json.dump(devices, f)
                except Exception:
                    pass
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers_cors()
            self.wfile.write(b'{"success":true}')
            return

        # 3. Chunked Upload
        if path == '/api/upload_chunk':
            upload_id = self.headers.get('X-Upload-Id', '')
            raw_name = self.headers.get('X-File-Name', '')
            chunk_idx = int(self.headers.get('X-Chunk-Index', -1))
            total_chunks = int(self.headers.get('X-Total-Chunks', -1))
            content_length = int(self.headers.get('Content-Length', 0))

            if not upload_id or not raw_name or chunk_idx < 0 or total_chunks <= 0:
                self.send_error(400, "Invalid chunk headers")
                return

            file_name = urllib.parse.unquote(raw_name)
            file_name = os.path.basename(file_name)
            clean_id = ''.join(c for c in upload_id if c.isalnum() or c in ['_', '-'])
            part_path = os.path.join(TEMP_DIR, f"{clean_id}.part")

            mode = 'wb' if chunk_idx == 0 else 'ab'
            with open(part_path, mode) as f:
                remaining = content_length
                while remaining > 0:
                    buf = self.rfile.read(min(remaining, 64 * 1024))
                    if not buf:
                        break
                    f.write(buf)
                    remaining -= len(buf)

            if chunk_idx == total_chunks - 1:
                target_path = os.path.join(SHARED_DIR, file_name)
                if os.path.exists(target_path):
                    base, ext = os.path.splitext(file_name)
                    c = 1
                    while os.path.exists(os.path.join(SHARED_DIR, f"{base} ({c}){ext}")):
                        c += 1
                    file_name = f"{base} ({c}){ext}"
                    target_path = os.path.join(SHARED_DIR, file_name)

                os.rename(part_path, target_path)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers_cors()
                self.wfile.write(json.dumps({'success': True, 'completed': True, 'fileName': file_name}).encode('utf-8'))
                return

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers_cors()
            self.wfile.write(json.dumps({'success': True, 'chunk': chunk_idx}).encode('utf-8'))
            return

        # 4. Delete
        if path == '/api/delete':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8', errors='ignore')
            data = json.loads(body or '{}')
            target = os.path.join(SHARED_DIR, os.path.basename(data.get('file', '')))
            if os.path.isfile(target):
                os.remove(target)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers_cors()
                self.wfile.write(b'{"success":true}')
                return
            self.send_error(404, "File not found")
            return

        # 5. Notes Save
        if path == '/api/notes':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8', errors='ignore')
            data = json.loads(body or '{}')
            with open(NOTES_FILE, 'w', encoding='utf-8') as f:
                f.write(data.get('note', ''))
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers_cors()
            self.wfile.write(b'{"success":true}')
            return

        # 6. Open PC Folder
        if path == '/api/open_folder':
            os.system(f'explorer "{SHARED_DIR}"')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers_cors()
            self.wfile.write(b'{"success":true}')
            return

        self.send_error(404, "Not Found")

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

if __name__ == '__main__':
    ips = get_local_ips()
    server = ThreadingHTTPServer(('0.0.0.0', PORT), LocalShareHandler)
    print("================================================================")
    print("              LOCALSHARE - PC & iOS FILE TRANSFER               ")
    print("================================================================")
    print(f"  Local Wi-Fi IP   : {ips[0] if ips else '127.0.0.1'}")
    print(f"  Port             : {PORT}")
    print(f"\n  Open in Mobile Safari: http://{ips[0] if ips else '127.0.0.1'}:{PORT}")
    print("================================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
