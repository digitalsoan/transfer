<?php
/**
 * LocalShare - Fast Local Network File Transfer Server
 * High performance, zero external dependencies.
 * Supports:
 * - Real-time active devices discovery & listing (PC <-> iOS mobile radar)
 * - Chunked uploads (handles 10GB+ 4K videos without memory limits)
 * - HTTP Range streaming for iOS Safari video playback
 * - Automatic LAN IP & Wi-Fi discovery
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');
date_default_timezone_set('UTC');

$sharedDir = __DIR__ . DIRECTORY_SEPARATOR . 'shared_files';
$tempDir = $sharedDir . DIRECTORY_SEPARATOR . '.temp';
$notesFile = $sharedDir . DIRECTORY_SEPARATOR . '.notes.txt';
$devicesFile = $tempDir . DIRECTORY_SEPARATOR . 'devices.json';

if (!is_dir($sharedDir)) {
    @mkdir($sharedDir, 0777, true);
}
if (!is_dir($tempDir)) {
    @mkdir($tempDir, 0777, true);
}

// Clean up stale temporary chunks older than 2 hours
if (is_dir($tempDir)) {
    $now = time();
    foreach (glob($tempDir . '/*.part') as $part) {
        if ($now - filemtime($part) > 7200) {
            @unlink($part);
        }
    }
}

// Helper: Get MIME type
function getFileMime($path) {
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    $mimes = [
        'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png',
        'gif' => 'image/gif', 'webp' => 'image/webp', 'heic' => 'image/heic',
        'heif' => 'image/heif', 'svg' => 'image/svg+xml', 'bmp' => 'image/bmp',
        'mp4' => 'video/mp4', 'mov' => 'video/quicktime', 'm4v' => 'video/x-m4v',
        'webm' => 'video/webm', 'mkv' => 'video/x-matroska', 'avi' => 'video/x-msvideo',
        'mp3' => 'audio/mpeg', 'm4a' => 'audio/mp4', 'wav' => 'audio/wav',
        'aac' => 'audio/aac', 'flac' => 'audio/flac', 'ogg' => 'audio/ogg',
        'pdf' => 'application/pdf', 'zip' => 'application/zip', 'rar' => 'application/x-rar-compressed',
        '7z' => 'application/x-7z-compressed', 'tar' => 'application/x-tar', 'gz' => 'application/gzip',
        'txt' => 'text/plain; charset=utf-8', 'md' => 'text/markdown; charset=utf-8',
        'json' => 'application/json', 'html' => 'text/html; charset=utf-8',
        'csv' => 'text/csv; charset=utf-8', 'doc' => 'application/msword',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls' => 'application/vnd.ms-excel',
        'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    return $mimes[$ext] ?? 'application/octet-stream';
}

// Helper: Detect Wi-Fi SSID
function getWifiSsid() {
    $out = @shell_exec('netsh wlan show interfaces');
    if ($out && preg_match('/^\s*SSID\s*:\s*(.+)$/m', $out, $m)) {
        return trim($m[1]);
    }
    $out = @shell_exec('netsh wlan show networks');
    if ($out && preg_match('/SSID\s+\d+\s*:\s*(.+)/i', $out, $m)) {
        return trim($m[1]);
    }
    return '';
}

// Helper: Get Local IPv4 addresses
function getLocalIps() {
    $ips = [];
    $output = @shell_exec('ipconfig');
    if ($output) {
        preg_match_all('/IPv4 Address[.\s]+:\s*([0-9.]+)/i', $output, $matches);
        if (!empty($matches[1])) {
            foreach ($matches[1] as $ip) {
                if ($ip !== '127.0.0.1' && strpos($ip, '169.254.') !== 0) {
                    $ips[] = $ip;
                }
            }
        }
    }
    usort($ips, function($a, $b) {
        $aPriv = (strpos($a, '192.168.') === 0 || strpos($a, '10.') === 0 || preg_match('/^172\.(1[6-9]|2[0-9]|3[0-1])\./', $a));
        $bPriv = (strpos($b, '192.168.') === 0 || strpos($b, '10.') === 0 || preg_match('/^172\.(1[6-9]|2[0-9]|3[0-1])\./', $b));
        if ($aPriv && !$bPriv) return -1;
        if (!$aPriv && $bPriv) return 1;
        return 0;
    });
    return array_values(array_unique($ips));
}

// Helper: Stream file supporting HTTP Range (Crucial for iOS Safari video playback and seeking)
function streamFileWithRange($filePath, $downloadName = null, $isInline = false) {
    if (!file_exists($filePath) || !is_file($filePath)) {
        http_response_code(404);
        header('Content-Type: text/plain');
        echo "404 File Not Found";
        exit;
    }

    $size = filesize($filePath);
    $mime = getFileMime($filePath);
    $filename = $downloadName ?: basename($filePath);
    $disposition = $isInline ? 'inline' : 'attachment';

    while (ob_get_level()) {
        ob_end_clean();
    }

    header('Accept-Ranges: bytes');
    header('Content-Type: ' . $mime);
    header('Content-Disposition: ' . $disposition . '; filename="' . rawurlencode($filename) . '"; filename*=UTF-8\'\'' . rawurlencode($filename));
    header('Cache-Control: public, max-age=3600');

    $start = 0;
    $end = $size - 1;
    $length = $size;

    if (isset($_SERVER['HTTP_RANGE'])) {
        $c_start = $start;
        $c_end = $end;
        list(, $range) = explode('=', $_SERVER['HTTP_RANGE'], 2);
        if (strpos($range, ',') !== false) {
            http_response_code(416);
            header("Content-Range: bytes */$size");
            exit;
        }
        if ($range === '-') {
            $c_start = $size - substr($range, 1);
        } else {
            $range = explode('-', $range);
            $c_start = intval($range[0]);
            $c_end = (isset($range[1]) && is_numeric($range[1])) ? intval($range[1]) : $size - 1;
        }
        $c_end = ($c_end > $end) ? $end : $c_end;
        if ($c_start > $c_end || $c_start > $size - 1 || $c_end >= $size) {
            http_response_code(416);
            header("Content-Range: bytes */$size");
            exit;
        }
        $start = $c_start;
        $end = $c_end;
        $length = $end - $start + 1;
        http_response_code(206);
        header("Content-Range: bytes $start-$end/$size");
    } else {
        http_response_code(200);
    }

    header('Content-Length: ' . $length);

    $fp = fopen($filePath, 'rb');
    if ($fp === false) {
        http_response_code(500);
        exit;
    }

    fseek($fp, $start);
    $bufferSize = 1024 * 64;
    while (!feof($fp) && ($pos = ftell($fp)) <= $end) {
        if ($pos + $bufferSize > $end) {
            $bufferSize = $end - $pos + 1;
        }
        echo fread($fp, $bufferSize);
        flush();
        if (connection_status() != 0) break;
    }
    fclose($fp);
    exit;
}

// Request URI routing
$uri = $_SERVER['REQUEST_URI'] ?? '/';
$path = parse_url($uri, PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE');
header('Access-Control-Allow-Headers: Content-Type, X-Upload-Id, X-File-Name, X-Chunk-Index, X-Total-Chunks, X-File-Size');
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// 1. Serve UI
if ($path === '/' || $path === '/index.html' || $path === '/local_share.html') {
    $htmlPath = __DIR__ . DIRECTORY_SEPARATOR . 'local_share.html';
    if (file_exists($htmlPath)) {
        header('Content-Type: text/html; charset=utf-8');
        readfile($htmlPath);
        exit;
    }
    header('Content-Type: text/plain');
    echo "local_share.html not found in " . __DIR__;
    exit;
}

// 2. API: Server Info (IPs, Port, Wi-Fi SSID, stats)
if ($path === '/api/info') {
    header('Content-Type: application/json; charset=utf-8');
    $ips = getLocalIps();
    $port = $_SERVER['SERVER_PORT'] ?? '8080';
    $wifi = getWifiSsid();
    $files = array_diff(scandir($sharedDir), ['.', '..', '.temp', '.notes.txt']);
    $totalBytes = 0;
    foreach ($files as $f) {
        $fp = $sharedDir . DIRECTORY_SEPARATOR . $f;
        if (is_file($fp)) $totalBytes += filesize($fp);
    }
    echo json_encode([
        'success' => true,
        'ips' => $ips,
        'primaryIp' => $ips[0] ?? '127.0.0.1',
        'port' => $port,
        'wifiSsid' => $wifi,
        'fileCount' => count($files),
        'totalBytes' => $totalBytes,
        'sharedDir' => realpath($sharedDir)
    ]);
    exit;
}

// 3. API: Device Presence Heartbeat (Lists active PC & mobile devices)
if ($path === '/api/heartbeat' && $method === 'POST') {
    header('Content-Type: application/json; charset=utf-8');
    $data = json_decode(file_get_contents('php://input'), true) ?: [];
    $deviceId = $data['deviceId'] ?? '';
    if (!$deviceId) {
        echo json_encode(['success' => false, 'devices' => []]);
        exit;
    }

    $clientIp = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
    if ($clientIp === '::1') $clientIp = '127.0.0.1';

    $devices = [];
    if (file_exists($devicesFile)) {
        $content = @file_get_contents($devicesFile);
        if ($content) {
            $devices = json_decode($content, true) ?: [];
        }
    }

    $now = time();
    $devices[$deviceId] = [
        'id' => $deviceId,
        'name' => htmlspecialchars(substr($data['name'] ?? 'Device', 0, 40)),
        'type' => $data['type'] ?? 'desktop', // 'desktop', 'mobile', 'tablet'
        'os' => htmlspecialchars($data['os'] ?? 'Unknown'),
        'browser' => htmlspecialchars($data['browser'] ?? 'Browser'),
        'ip' => $clientIp,
        'lastSeen' => $now
    ];

    // Clean up inactive devices (no heartbeat within 6 seconds)
    $active = [];
    foreach ($devices as $id => $info) {
        if ($now - ($info['lastSeen'] ?? 0) <= 6) {
            $active[$id] = $info;
        }
    }

    @file_put_contents($devicesFile, json_encode($active), LOCK_EX);
    echo json_encode(['success' => true, 'devices' => array_values($active)]);
    exit;
}

// 4. API: Device Leave (when tab or page is closed)
if ($path === '/api/leave' && $method === 'POST') {
    header('Content-Type: application/json; charset=utf-8');
    $data = json_decode(file_get_contents('php://input'), true) ?: [];
    $deviceId = $data['deviceId'] ?? '';
    if ($deviceId && file_exists($devicesFile)) {
        $devices = json_decode(@file_get_contents($devicesFile), true) ?: [];
        if (isset($devices[$deviceId])) {
            unset($devices[$deviceId]);
            @file_put_contents($devicesFile, json_encode($devices), LOCK_EX);
        }
    }
    echo json_encode(['success' => true]);
    exit;
}

// 5. API: List Files
if ($path === '/api/files') {
    header('Content-Type: application/json; charset=utf-8');
    $items = [];
    if (is_dir($sharedDir)) {
        $entries = scandir($sharedDir);
        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..' || $entry === '.temp' || $entry === '.notes.txt') continue;
            $fullPath = $sharedDir . DIRECTORY_SEPARATOR . $entry;
            if (!is_file($fullPath)) continue;

            $ext = strtolower(pathinfo($entry, PATHINFO_EXTENSION));
            $size = filesize($fullPath);
            $mtime = filemtime($fullPath);
            $mime = getFileMime($fullPath);

            $isImg = in_array($ext, ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'svg']);
            $isVid = in_array($ext, ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi']);
            $isAud = in_array($ext, ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg']);
            $isDoc = in_array($ext, ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'zip', 'rar', '7z', 'csv']);

            $items[] = [
                'name' => $entry,
                'size' => $size,
                'mtime' => $mtime,
                'mime' => $mime,
                'ext' => $ext,
                'isImage' => $isImg,
                'isVideo' => $isVid,
                'isAudio' => $isAud,
                'isDoc' => $isDoc
            ];
        }
        usort($items, function($a, $b) {
            return $b['mtime'] - $a['mtime'];
        });
    }
    echo json_encode(['success' => true, 'files' => $items]);
    exit;
}

// 6. API: Chunked File Upload
if ($path === '/api/upload_chunk' && $method === 'POST') {
    header('Content-Type: application/json; charset=utf-8');

    $uploadId = $_SERVER['HTTP_X_UPLOAD_ID'] ?? '';
    $rawFileName = $_SERVER['HTTP_X_FILE_NAME'] ?? '';
    $chunkIndex = isset($_SERVER['HTTP_X_CHUNK_INDEX']) ? intval($_SERVER['HTTP_X_CHUNK_INDEX']) : -1;
    $totalChunks = isset($_SERVER['HTTP_X_TOTAL_CHUNKS']) ? intval($_SERVER['HTTP_X_TOTAL_CHUNKS']) : -1;
    $fileSize = isset($_SERVER['HTTP_X_FILE_SIZE']) ? intval($_SERVER['HTTP_X_FILE_SIZE']) : 0;

    if (!$uploadId || !$rawFileName || $chunkIndex < 0 || $totalChunks <= 0) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Missing upload chunk headers']);
        exit;
    }

    $fileName = basename(rawurldecode($rawFileName));
    $fileName = preg_replace('/[\\/\\\\:\*\?"<>\|]/', '_', $fileName);
    if ($fileName === '' || $fileName === '.') $fileName = 'upload_' . time();

    $partFile = $tempDir . DIRECTORY_SEPARATOR . preg_replace('/[^a-zA-Z0-9_\-]/', '', $uploadId) . '.part';

    $input = fopen('php://input', 'rb');
    $partFp = fopen($partFile, $chunkIndex === 0 ? 'wb' : 'ab');
    if (!$input || !$partFp) {
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Failed to write chunk']);
        exit;
    }
    stream_copy_to_stream($input, $partFp);
    fclose($input);
    fclose($partFp);

    if ($chunkIndex === $totalChunks - 1) {
        $targetPath = $sharedDir . DIRECTORY_SEPARATOR . $fileName;
        if (file_exists($targetPath)) {
            $info = pathinfo($fileName);
            $base = $info['filename'] ?? 'file';
            $ext = isset($info['extension']) && $info['extension'] !== '' ? '.' . $info['extension'] : '';
            $counter = 1;
            while (file_exists($sharedDir . DIRECTORY_SEPARATOR . "{$base} ({$counter}){$ext}")) {
                $counter++;
            }
            $fileName = "{$base} ({$counter}){$ext}";
            $targetPath = $sharedDir . DIRECTORY_SEPARATOR . $fileName;
        }

        if (@rename($partFile, $targetPath)) {
            @touch($targetPath);
            echo json_encode([
                'success' => true,
                'completed' => true,
                'fileName' => $fileName,
                'size' => filesize($targetPath)
            ]);
            exit;
        } else {
            http_response_code(500);
            echo json_encode(['success' => false, 'error' => 'Failed to finalize file']);
            exit;
        }
    }

    echo json_encode(['success' => true, 'chunk' => $chunkIndex]);
    exit;
}

// 7. API: Download File
if ($path === '/api/download') {
    $file = isset($_GET['file']) ? basename($_GET['file']) : '';
    $filePath = $sharedDir . DIRECTORY_SEPARATOR . $file;
    streamFileWithRange($filePath, $file, false);
    exit;
}

// 8. API: Preview File
if ($path === '/api/preview') {
    $file = isset($_GET['file']) ? basename($_GET['file']) : '';
    $filePath = $sharedDir . DIRECTORY_SEPARATOR . $file;
    streamFileWithRange($filePath, $file, true);
    exit;
}

// 9. API: Delete File
if ($path === '/api/delete' && $method === 'POST') {
    header('Content-Type: application/json; charset=utf-8');
    $data = json_decode(file_get_contents('php://input'), true);
    $file = isset($data['file']) ? basename($data['file']) : '';
    $filePath = $sharedDir . DIRECTORY_SEPARATOR . $file;

    if ($file && file_exists($filePath) && is_file($filePath)) {
        @unlink($filePath);
        echo json_encode(['success' => true]);
        exit;
    }
    http_response_code(404);
    echo json_encode(['success' => false, 'error' => 'File not found']);
    exit;
}

// 10. API: Text Notes
if ($path === '/api/notes') {
    header('Content-Type: application/json; charset=utf-8');
    if ($method === 'POST') {
        $data = json_decode(file_get_contents('php://input'), true);
        $note = $data['note'] ?? '';
        file_put_contents($notesFile, $note, LOCK_EX);
        echo json_encode(['success' => true, 'note' => $note]);
        exit;
    }
    $note = file_exists($notesFile) ? file_get_contents($notesFile) : '';
    echo json_encode(['success' => true, 'note' => $note]);
    exit;
}

// 11. API: Open shared folder on PC
if ($path === '/api/open_folder' && $method === 'POST') {
    header('Content-Type: application/json; charset=utf-8');
    $real = realpath($sharedDir);
    if ($real) {
        @pclose(@popen("explorer " . escapeshellarg($real), "r"));
        echo json_encode(['success' => true]);
        exit;
    }
    echo json_encode(['success' => false]);
    exit;
}

http_response_code(404);
header('Content-Type: text/plain');
echo "404 Not Found";
