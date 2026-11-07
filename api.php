<?php
declare(strict_types=1);

$root = __DIR__;
$dataDir = $root . '/.petala-data';
$catalogFile = $root . '/produtos.json';
$uploadDir = $root . '/floricultura files';

if (!is_dir($dataDir) && !mkdir($dataDir, 0755, true) && !is_dir($dataDir)) {
    http_response_code(500);
    exit('Não foi possível preparar o painel.');
}
if (!file_exists($dataDir . '/.htaccess')) {
    file_put_contents($dataDir . '/.htaccess', "Require all denied\n");
}

session_name('petala_painel');
session_set_cookie_params([
    'lifetime' => 28800,
    'path' => '/',
    'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_start();

function respond(array $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function requestData(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw ?: '', true);
    return is_array($data) ? $data : [];
}

function readCatalogFile(): array
{
    global $catalogFile;
    $catalog = json_decode((string) file_get_contents($catalogFile), true);
    if (!is_array($catalog)) {
        throw new RuntimeException('O arquivo produtos.json está inválido.');
    }
    return $catalog;
}

function writeCatalogFile(array $catalog): void
{
    global $catalogFile;
    $json = json_encode($catalog, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false || file_put_contents($catalogFile . '.tmp', $json . "\n", LOCK_EX) === false || !rename($catalogFile . '.tmp', $catalogFile)) {
        @unlink($catalogFile . '.tmp');
        throw new RuntimeException('Não foi possível salvar produtos.json.');
    }
}

function categoryValue(array &$catalog, string $path): mixed
{
    $value = &$catalog;
    foreach (explode('.', $path) as $key) {
        if ($key === '' || in_array($key, ['__proto__', 'constructor', 'prototype'], true) || !is_array($value) || !array_key_exists($key, $value)) {
            return null;
        }
        $value = &$value[$key];
    }
    return $value;
}

function imageFilePath(string $image): ?string
{
    global $uploadDir;
    $normalized = str_replace('\\', '/', $image);
    if (str_starts_with($normalized, 'floricultura files/')) {
        $normalized = substr($normalized, strlen('floricultura files/'));
    }
    if ($normalized === '' || basename($normalized) !== $normalized || $normalized === '.' || $normalized === '..') {
        return null;
    }
    return $uploadDir . '/' . $normalized;
}

function removeImages(array $images): void
{
    foreach ($images as $image) {
        if (is_string($image) && ($path = imageFilePath($image)) !== null) {
            @unlink($path);
        }
    }
}

function uploadedImageFiles(): array
{
    $field = $_FILES['images'] ?? null;
    if (!$field) {
        return [];
    }
    $files = [];
    foreach ((array) $field['name'] as $index => $name) {
        $files[] = [
            'name' => $name,
            'tmp_name' => is_array($field['tmp_name']) ? $field['tmp_name'][$index] : $field['tmp_name'],
            'error' => is_array($field['error']) ? $field['error'][$index] : $field['error'],
            'size' => is_array($field['size']) ? $field['size'][$index] : $field['size'],
        ];
    }
    return $files;
}

function requireLogin(): void
{
    if (empty($_SESSION['petala_authenticated'])) {
        respond(['error' => 'Não autenticado.'], 401);
    }
}

function makeSiteZip(): never
{
    global $root, $dataDir;
    if (!class_exists(ZipArchive::class)) {
        respond(['error' => 'A extensão ZipArchive não está ativa nesta hospedagem. Ative-a no painel PHP da Hostinger.'], 501);
    }
    $zipPath = $dataDir . '/site-' . bin2hex(random_bytes(8)) . '.zip';
    $zip = new ZipArchive();
    if ($zip->open($zipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
        respond(['error' => 'Não foi possível criar o ZIP do site.'], 500);
    }

    $excluded = [
        '.git',
        'node_modules',
        '.petala-data',
        'painel-servidor.log',
        'painel.pin',
        'package.json',
        'package-lock.json',
        'server.js',
        'abrir-painel.sh',
        'abrir-painel.bat',
        'limpar-duplicadas.js',
        'relatorio-imagens.md',
        'settings.json',
    ];
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY
    );
    foreach ($iterator as $file) {
        if (!$file->isFile()) {
            continue;
        }
        $relative = str_replace(DIRECTORY_SEPARATOR, '/', substr($file->getPathname(), strlen($root) + 1));
        $firstPart = explode('/', $relative, 2)[0];
        if (in_array($firstPart, $excluded, true) || str_starts_with($relative, '.petala-data/')) {
            continue;
        }
        $zip->addFile($file->getPathname(), $relative);
    }
    $zip->close();

    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="petala-site-atualizado-' . date('Y-m-d') . '.zip"');
    header('Content-Length: ' . filesize($zipPath));
    readfile($zipPath);
    @unlink($zipPath);
    exit;
}

try {
    $action = (string) ($_GET['action'] ?? '');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($action === 'login' && $method === 'POST') {
        $request = requestData();
        $envPin = getenv('PANEL_PIN');
        $pinFile = $dataDir . '/painel.pin';
        $storedPin = is_file($pinFile) ? trim((string) file_get_contents($pinFile)) : '';
        if ($storedPin === '' && ($envPin === false || $envPin === '')) {
            $storedPin = password_hash('1234', PASSWORD_DEFAULT);
            file_put_contents($pinFile, $storedPin, LOCK_EX);
        }
        $pin = (string) ($request['pin'] ?? '');
        $valid = $envPin !== false && $envPin !== ''
            ? hash_equals($envPin, $pin)
            : (password_verify($pin, $storedPin) || (!str_starts_with($storedPin, '$') && hash_equals($storedPin, $pin)));
        if (!$valid) {
            respond(['error' => 'PIN incorreto.'], 401);
        }
        if (!str_starts_with($storedPin, '$') && ($envPin === false || $envPin === '')) {
            file_put_contents($pinFile, password_hash($storedPin, PASSWORD_DEFAULT), LOCK_EX);
        }
        session_regenerate_id(true);
        $_SESSION['petala_authenticated'] = true;
        respond(['ok' => true]);
    }

    requireLogin();

    if ($action === 'catalog' && $method === 'GET') {
        respond(readCatalogFile());
    }
    if ($action === 'catalog' && $method === 'PUT') {
        $catalog = requestData();
        if (!$catalog) {
            respond(['error' => 'Catálogo inválido.'], 400);
        }
        writeCatalogFile($catalog);
        respond($catalog);
    }
    if ($action === 'category' && $method === 'POST') {
        $request = requestData();
        $category = trim((string) ($request['category'] ?? ''));
        if ($category === '' || preg_match('/[.\\\/]/', $category) || in_array($category, ['__proto__', 'constructor', 'prototype'], true)) {
            respond(['error' => 'Nome de lista inválido.'], 400);
        }
        $catalog = readCatalogFile();
        if (array_key_exists($category, $catalog)) {
            respond(['error' => 'Essa lista já existe.'], 409);
        }
        $catalog[$category] = [];
        writeCatalogFile($catalog);
        respond($catalog);
    }
    if ($action === 'product' && $method === 'POST') {
        $catalog = readCatalogFile();
        $operation = (string) ($_POST['action'] ?? '');
        $category = (string) ($_POST['category'] ?? '');
        $oldCategory = (string) ($_POST['oldCategory'] ?? '');
        $oldIndex = filter_var($_POST['oldIndex'] ?? null, FILTER_VALIDATE_INT);
        $target = categoryValue($catalog, $category);
        if (!is_array($target) || array_is_list($target) === false) {
            respond(['error' => 'Categoria inválida.'], 400);
        }

        $oldProduct = null;
        if (in_array($operation, ['delete', 'update'], true)) {
            $source = categoryValue($catalog, $oldCategory);
            if (!is_array($source) || $oldIndex === false || !isset($source[$oldIndex]) || !is_array($source[$oldIndex])) {
                respond(['error' => 'Produto inválido.'], 400);
            }
            $sourcePath = &$catalog;
            foreach (explode('.', $oldCategory) as $key) {
                $sourcePath = &$sourcePath[$key];
            }
            $oldProduct = $sourcePath[$oldIndex];
            array_splice($sourcePath, $oldIndex, 1);
            if ($operation === 'delete') {
                removeImages($oldProduct['imagens'] ?? []);
            }
        }

        if ($operation !== 'delete') {
            if (!in_array($operation, ['create', 'update'], true)) {
                respond(['error' => 'Operação inválida.'], 400);
            }
            $product = json_decode((string) ($_POST['product'] ?? ''), true);
            $existingImages = json_decode((string) ($_POST['existingImages'] ?? '[]'), true);
            if (!is_array($product) || !is_array($existingImages)) {
                respond(['error' => 'Dados do produto inválidos.'], 400);
            }
            if ($oldProduct !== null) {
                removeImages(array_values(array_diff($oldProduct['imagens'] ?? [], $existingImages)));
            }
            if (!is_dir($uploadDir) && !mkdir($uploadDir, 0755, true) && !is_dir($uploadDir)) {
                throw new RuntimeException('Não foi possível preparar a pasta de imagens.');
            }
            $newImages = [];
            $allowed = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'image/gif' => 'gif'];
            $fileInfo = new finfo(FILEINFO_MIME_TYPE);
            $files = uploadedImageFiles();
            if (count($files) > 12) {
                respond(['error' => 'Envie no máximo 12 imagens por vez.'], 400);
            }
            foreach ($files as $file) {
                if ($file['error'] === UPLOAD_ERR_NO_FILE) {
                    continue;
                }
                if ($file['error'] !== UPLOAD_ERR_OK || $file['size'] > 8 * 1024 * 1024 || !is_uploaded_file($file['tmp_name'])) {
                    respond(['error' => 'Cada imagem deve ter até 8 MB.'], 400);
                }
                $mime = $fileInfo->file($file['tmp_name']);
                if (!isset($allowed[$mime])) {
                    respond(['error' => 'Use imagens JPG, PNG, WebP ou GIF.'], 400);
                }
                $filename = bin2hex(random_bytes(12)) . '.' . $allowed[$mime];
                if (!move_uploaded_file($file['tmp_name'], $uploadDir . '/' . $filename)) {
                    throw new RuntimeException('Não foi possível salvar uma imagem enviada.');
                }
                $newImages[] = 'floricultura files/' . $filename;
            }
            $product['imagens'] = array_values(array_merge($existingImages, $newImages));
            $targetPath = &$catalog;
            foreach (explode('.', $category) as $key) {
                $targetPath = &$targetPath[$key];
            }
            $targetPath[] = $product;
        }
        writeCatalogFile($catalog);
        respond($catalog);
    }
    if ($action === 'change-pin' && $method === 'POST') {
        $request = requestData();
        $envPin = getenv('PANEL_PIN');
        if ($envPin !== false && $envPin !== '') {
            respond(['error' => 'O PIN é controlado pela variável PANEL_PIN. Altere essa configuração para trocar o PIN.'], 400);
        }

        $pinFile = $dataDir . '/painel.pin';
        $storedPin = is_file($pinFile) ? trim((string) file_get_contents($pinFile)) : password_hash('1234', PASSWORD_DEFAULT);
        $current = (string) ($request['current'] ?? '');
        $next = (string) ($request['next'] ?? '');
        $valid = password_verify($current, $storedPin)
            || (!str_starts_with($storedPin, '$') && hash_equals($storedPin, $current));
        if (!$valid) {
            respond(['error' => 'PIN atual incorreto.'], 401);
        }
        if (strlen($next) < 4) {
            respond(['error' => 'O novo PIN precisa ter pelo menos 4 caracteres.'], 400);
        }

        $temporaryPinFile = $pinFile . '.tmp';
        $pinHash = password_hash($next, PASSWORD_DEFAULT);
        if (file_put_contents($temporaryPinFile, $pinHash, LOCK_EX) === false || !rename($temporaryPinFile, $pinFile)) {
            @unlink($temporaryPinFile);
            respond(['error' => 'Não foi possível salvar o novo PIN.'], 500);
        }
        respond(['ok' => true]);
    }
    if ($action === 'download-site' && $method === 'GET') {
        makeSiteZip();
    }
    respond(['error' => 'Ação não encontrada.'], 404);
} catch (Throwable $error) {
    error_log('Painel Pétala: ' . $error->getMessage());
    respond(['error' => 'Erro interno ao processar a solicitação.'], 500);
}