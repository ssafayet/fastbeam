<?php
// fastbeam "advanced bdix discovery": tells the browser which public IP this server sees it from.
// Upload anywhere on a BDIX-hosted PHP account (e.g. https://example.com/fastbeam/ip.php).
// Stores nothing, logs nothing, sets no cookies. Only called when the user turned the option on.

$allowed = ['https://fastbeam.app', 'http://localhost:5179'];
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';

if (in_array($origin, $allowed, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Cache-Control: no-store');
header('Content-Type: application/json');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// REMOTE_ADDR is the TCP peer, which a client cannot forge. Forwarding headers are NOT trusted:
// anyone could send them. If the host sits behind a proxy/CDN this will be the proxy's address;
// open the page with ?debug=1 to check.
$ip = $_SERVER['REMOTE_ADDR'] ?? '';

$out = ['ip' => $ip];
if (isset($_GET['debug'])) {
    $out['forwarded'] = [
        'x-forwarded-for' => $_SERVER['HTTP_X_FORWARDED_FOR'] ?? null,
        'cf-connecting-ip' => $_SERVER['HTTP_CF_CONNECTING_IP'] ?? null,
    ];
}
echo json_encode($out);
