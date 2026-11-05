<?php
declare(strict_types=1);

$root = __DIR__;
$zipTmp = $root . '/.petala-site-export-' . bin2hex(random_bytes(8)) . '.zip';
$excludedNames = [
    '.git',
    '.petala-data',
    'node_modules',
    'painel-servidor.log',
    'painel.pin',
    'package.json',
    'package-lock.json',
    'server.js',
    'painel.html',
    'painel.css',
    'painel.js',
    'api.php',
    'exportar-site.php',
    '.htaccess',
    'abrir-painel.sh',
    'abrir-painel.bat',
    'limpar-duplicadas.js',
    'relatorio-imagens.md',
    'settings.json',
    'db.sqlite',
    'vendor',
];

if (!class_exists('ZipArchive')) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'A extensão ZipArchive não está ativa nesta hospedagem.'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$zip = new ZipArchive();
if ($zip->open($zipTmp, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Não foi possível criar o ZIP do site.'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$iterator = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
    RecursiveIteratorIterator::LEAVES_ONLY
);

foreach ($iterator as $file) {
    if (!$file->isFile()) {
        continue;
    }

    $path = $file->getPathname();
    $relative = str_replace('\\', '/', substr($path, strlen($root) + 1));
    $firstSegment = explode('/', $relative, 2)[0];

    if ($firstSegment === '' || in_array($firstSegment, $excludedNames, true) || in_array(basename($relative), $excludedNames, true)) {
        continue;
    }

    if (str_starts_with($relative, '.petala-data/') || str_starts_with($relative, 'node_modules/')) {
        continue;
    }

    $zip->addFile($path, $relative);
}

$zip->close();

while (ob_get_level() > 0) {
    ob_end_clean();
}

header('Content-Type: application/zip');
header('Content-Disposition: attachment; filename="petala-site-atualizado-' . date('Y-m-d') . '.zip"');
header('Content-Length: ' . filesize($zipTmp));
readfile($zipTmp);
@unlink($zipTmp);
exit;
