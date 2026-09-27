<?php
// bortle.php -- serve 1km Bortle grid chunks and the manifest.
//
//   GET ?manifest=1        -> manifest JSON {version, cellM, per, regions: {...}}
//   GET ?region=<chunkId>  -> raw chunk bytes (application/octet-stream)
//
// chunkId looks like "r00_q0" (region r00, chunk 0). Chunk IDs are stable
// across data rebuilds; responses use short cache lifetimes so updates
// propagate within minutes.
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

// ---- manifest ----
if (isset($_GET['manifest'])) {
    // Prefer the DB copy when present; fall back to manifest.json on disk.
    $manifest = null;
    try {
        $row = db($config)->query(
            "SELECT manifest FROM bortle_manifest WHERE id = 1")->fetch();
        if ($row) $manifest = $row['manifest'];
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
    }
    header('Content-Type: application/json');
    header('Cache-Control: public, max-age=60'); // short: model updates must propagate
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

try {
    $stmt = db($config)->prepare(
        "SELECT data, nbytes FROM bortle_chunks WHERE chunk_id = ?");
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

header('Content-Type: application/octet-stream');
header('Content-Length: ' . $row['nbytes']);
// Chunk IDs are stable across rebuilds, so do NOT cache immutably.
// Short max-age so model updates propagate within minutes.
header('Cache-Control: public, max-age=300, must-revalidate');
header('Accept-Ranges: bytes');
echo $row['data'];
