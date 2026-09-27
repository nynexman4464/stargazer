<?php
// upload_chunk.php -- load one 1km Bortle chunk into MySQL.
//
//   POST body: raw chunk bytes (application/octet-stream)
//   Query args: secret=<upload_secret> & chunk_id=r00_q0 & region_id=r00
//               & sw_lat=.. & sw_lon=.. & ne_lat=.. & ne_lon=..
//               & npatches=..  (+ optional manifest=1 with manifest JSON body
//               to store the manifest in bortle_manifest)
//
// Auth is a shared secret in config.php (never in git). Use over HTTPS only.
// Example:
//   curl -X POST --data-binary @r00_q0.bin \
//     "https://example.com/api/upload_chunk.php?secret=...&chunk_id=r00_q0&region_id=r00&sw_lat=..&sw_lon=..&ne_lat=..&ne_lon=..&npatches=4950"

$config = @include __DIR__ . '/config.php';
if ($config === false) {
    http_response_code(500);
    echo "server misconfigured\n";
    exit;
}
header('Content-Type: application/json');

$secret = isset($_GET['secret']) ? $_GET['secret'] : '';
if (!hash_equals((string)$config['upload_secret'], (string)$secret)) {
    http_response_code(403);
    echo json_encode(['error' => 'forbidden']);
    exit;
}

try {
    $dsn = "mysql:host={$config['db_host']};dbname={$config['db_name']};charset=utf8mb4";
    $pdo = new PDO($dsn, $config['db_user'], $config['db_pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => 'database error']);
    exit;
}

// Manifest upload mode: body is the manifest JSON.
if (isset($_GET['manifest'])) {
    $manifest = file_get_contents('php://input');
    if (!$manifest || !json_decode($manifest)) {
        http_response_code(400);
        echo json_encode(['error' => 'invalid manifest JSON']);
        exit;
    }
    $pdo->prepare(
        "INSERT INTO bortle_manifest (id, manifest) VALUES (1, ?)
         ON DUPLICATE KEY UPDATE manifest = VALUES(manifest)"
    )->execute([$manifest]);
    echo json_encode(['ok' => true, 'manifest_bytes' => strlen($manifest)]);
    exit;
}

// Chunk upload mode.
$chunkId  = isset($_GET['chunk_id'])  ? $_GET['chunk_id']  : '';
$regionId = isset($_GET['region_id']) ? $_GET['region_id'] : '';
// Allow version suffix for A/B testing (e.g. r01_q15_v2)
if (!preg_match('/^r[0-3][0-7]_q\d+(_v\d+)?$/', $chunkId) ||
    !preg_match('/^r[0-3][0-7]$/', $regionId)) {
    http_response_code(400);
    echo json_encode(['error' => 'bad chunk_id or region_id']);
    exit;
}
foreach (['sw_lat','sw_lon','ne_lat','ne_lon','npatches'] as $k) {
    if (!isset($_GET[$k]) || !is_numeric($_GET[$k])) {
        http_response_code(400);
        echo json_encode(['error' => "missing or bad $k"]);
        exit;
    }
}
$data = file_get_contents('php://input');
// Sanity: chunk magic must be B1K1
if (strlen($data) < 20 || substr($data, 0, 4) !== 'B1K1') {
    http_response_code(400);
    echo json_encode(['error' => 'bad chunk data (magic mismatch)']);
    exit;
}

$stmt = $pdo->prepare(
    "INSERT INTO bortle_chunks
       (chunk_id, region_id, sw_lat, sw_lon, ne_lat, ne_lon, npatches, nbytes, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       region_id = VALUES(region_id), sw_lat = VALUES(sw_lat),
       sw_lon = VALUES(sw_lon), ne_lat = VALUES(ne_lat),
       ne_lon = VALUES(ne_lon), npatches = VALUES(npatches),
       nbytes = VALUES(nbytes), data = VALUES(data)"
);
$stmt->bindParam(1, $chunkId);
$stmt->bindParam(2, $regionId);
$stmt->bindParam(3, $_GET['sw_lat']);
$stmt->bindParam(4, $_GET['sw_lon']);
$stmt->bindParam(5, $_GET['ne_lat']);
$stmt->bindParam(6, $_GET['ne_lon']);
$stmt->bindParam(7, $_GET['npatches'], PDO::PARAM_INT);
$nbytes = strlen($data);
$stmt->bindParam(8, $nbytes, PDO::PARAM_INT);
$stmt->bindParam(9, $data, PDO::PARAM_LOB);
$stmt->execute();

echo json_encode(['ok' => true, 'chunk_id' => $chunkId, 'bytes' => $nbytes]);
