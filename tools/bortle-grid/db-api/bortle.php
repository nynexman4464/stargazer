<?php
// bortle.php -- serve 1km Bortle grid chunks and the manifest.
//
//   GET ?manifest=1        -> manifest JSON {version, cellM, per, regions: {...}}
//   GET ?region=<chunkId>  -> raw chunk bytes (application/octet-stream)
//
// chunkId looks like "r00_q0" (region r00, chunk 0). Chunk IDs are stable
// across data rebuilds; responses carry Last-Modified from the DB
// updated_at timestamp and honor If-Modified-Since, so clients cache
// efficiently but always get fresh data after an upload.
//
// Deploy: copy this file, config.php, and manifest.json to the DreamHost
// web directory serving /api/ (e.g. public_html/api/).

header('Access-Control-Allow-Origin: *'); // public tile data; tighten if desired

$config = @include __DIR__ . '/config.php';
if ($config === false) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'server misconfigured']);
    exit;
}

function db($config) {
    static $pdo = null;
    if ($pdo === null) {
        $dsn = "mysql:host={$config['db_host']};dbname={$config['db_name']};charset=utf8mb4";
        $pdo = new PDO($dsn, $config['db_user'], $config['db_pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    }
    return $pdo;
}

// Return 304 if the client already has this version.
function not_modified_since($updatedAt) {
    if (empty($updatedAt)) return false;
    $mtime = strtotime($updatedAt . ' UTC');
    if ($mtime === false) return false;
    $ims = isset($_SERVER['HTTP_IF_MODIFIED_SINCE'])
        ? strtotime($_SERVER['HTTP_IF_MODIFIED_SINCE']) : false;
    if ($ims !== false && $ims >= $mtime) {
        http_response_code(304);
        exit;
    }
    return $mtime;
}

// ---- manifest ----
if (isset($_GET['manifest'])) {
    // Prefer the DB copy when present; fall back to manifest.json on disk.
    $manifest = null;
    $updatedAt = null;
    try {
        $row = db($config)->query(
            "SELECT manifest, updated_at FROM bortle_manifest WHERE id = 1")->fetch();
        if ($row) { $manifest = $row['manifest']; $updatedAt = $row['updated_at']; }
    } catch (Exception $e) { /* table may not exist yet */ }
    if ($manifest === null) {
        $path = __DIR__ . '/manifest.json';
        if (!is_readable($path)) {
            http_response_code(404);
            header('Content-Type: application/json');
            echo json_encode(['error' => 'manifest not found']);
            exit;
        }
        $manifest = file_get_contents($path);
        $mtime = filemtime($path);
    } else {
        $mtime = not_modified_since($updatedAt);
        if ($mtime === false) $mtime = time();
    }
    header('Content-Type: application/json');
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
    header('Cache-Control: public, max-age=60, must-revalidate');
    echo $manifest;
    exit;
}

// ---- chunk bytes ----
$chunkId = isset($_GET['region']) ? $_GET['region'] : '';
// Strict id format: r<latIdx><lonIdx>_q<n>  (e.g. r00_q0)
if (!preg_match('/^r[0-3][0-7]_q\d+$/', $chunkId)) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'bad chunk id']);
    exit;
}
// Version suffix: ?region=r01_q15&v=2 serves chunk_id 'r01_q15_v2'.
// Used for A/B testing new models without overwriting the live data.
$version = isset($_GET['v']) ? intval($_GET['v']) : 1;
if ($version > 1) {
    $chunkId .= '_v' . $version;
}

try {
    $stmt = db($config)->prepare(
        "SELECT data, nbytes, updated_at FROM bortle_chunks WHERE chunk_id = ?");
    $stmt->execute([$chunkId]);
    $row = $stmt->fetch();
} catch (Exception $e) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'database error']);
    exit;
}

if (!$row) {
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'chunk not found']);
    exit;
}

$mtime = not_modified_since($row['updated_at']);
if ($mtime === false) $mtime = time();

header('Content-Type: application/octet-stream');
header('Content-Length: ' . $row['nbytes']);
header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
header('Cache-Control: public, max-age=3600, must-revalidate');
header('Accept-Ranges: bytes');
echo $row['data'];
