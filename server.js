const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execGit = promisify(execFile);

const ROOT = __dirname;
const CATALOG_FILE = path.join(ROOT, 'produtos.json');
const UPLOAD_DIR = path.join(ROOT, 'floricultura files');
const PIN_FILE = path.join(ROOT, 'painel.pin');
const PUBLIC_SITE_EXCLUDED = new Set([
    '.git',
    '.petala-data',
    'node_modules',
    'vendor',
    'db.sqlite',
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
    'settings.json'
]);
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
let panelPin = process.env.PANEL_PIN || '1234';
const sessions = new Map();
let publicationQueue = Promise.resolve();
const app = express();
const upload = multer({
    dest: UPLOAD_DIR,
    limits: { files: 12, fileSize: 8 * 1024 * 1024 },
    fileFilter: (request, file, callback) => callback(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))
});

app.use(express.json({ limit: '2mb' }));
app.use((request, response, next) => {
    if (['/server.js', '/painel.pin', '/package.json', '/package-lock.json'].includes(request.path)) return response.sendStatus(404);
    next();
});
app.get('/', (request, response) => response.redirect('/painel.html'));
app.use(express.static(ROOT));

function readCookies(request) {
    const cookieHeader = request.headers.cookie || '';
    return Object.fromEntries(cookieHeader.split(';').filter(Boolean).map((part) => {
        const separator = part.indexOf('=');
        const name = part.slice(0, separator).trim();
        const value = decodeURIComponent(part.slice(separator + 1).trim());
        return [name, value];
    }));
}

function requireSession(request, response, next) {
    const token = readCookies(request).petala_session;
    if (!token || !sessions.has(token)) return response.status(401).json({ error: 'Não autenticado.' });
    next();
}

async function readCatalog() { return JSON.parse(await fs.readFile(CATALOG_FILE, 'utf8')); }

function runGit(args) {
    return execGit('git', args, { cwd: ROOT });
}

function runGitAt(directory, args) {
    return execGit('git', args, { cwd: directory });
}

function commandOutput(result) {
    const output = result?.stdout;
    if (Buffer.isBuffer(output)) return output.toString('utf8');
    return typeof output === 'string' ? output : '';
}

function errorOutput(error) {
    const output = error?.stderr || error?.stdout || error?.message;
    if (Buffer.isBuffer(output)) return output.toString('utf8');
    return String(output || 'erro desconhecido');
}

function isPublicSitePath(relativePath) {
    const segments = relativePath.split(path.sep).filter(Boolean);
    return segments.every((segment) =>
        !PUBLIC_SITE_EXCLUDED.has(segment) && !segment.startsWith('.petala-site-export-')
    );
}

async function syncPublicSite(destination) {
    for (const entry of await fs.readdir(destination, { withFileTypes: true })) {
        if (['.git', 'CNAME', '.nojekyll'].includes(entry.name)) continue;
        await fs.rm(path.join(destination, entry.name), { recursive: true, force: true });
    }

    for (const entry of await fs.readdir(ROOT, { withFileTypes: true })) {
        if (!isPublicSitePath(entry.name)) continue;
        await fs.cp(path.join(ROOT, entry.name), path.join(destination, entry.name), {
            recursive: true,
            filter: (sourcePath) => isPublicSitePath(path.relative(ROOT, sourcePath))
        });
    }
}

async function publishStaticSite(remoteUrl) {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'petala-pages-'));
    const siteDirectory = path.join(temporaryDirectory, 'site');

    try {
        await runGit(['clone', '--branch', 'main', '--single-branch', remoteUrl, siteDirectory]);
        await syncPublicSite(siteDirectory);

        const changes = await runGitAt(siteDirectory, ['status', '--porcelain']);
        if (!commandOutput(changes).trim()) {
            return { ok: true, message: 'O site já estava atualizado.' };
        }

        await runGitAt(siteDirectory, ['config', 'user.name', 'Pétala Painel']);
        await runGitAt(siteDirectory, ['config', 'user.email', 'painel@petala.local']);
        await runGitAt(siteDirectory, ['add', '--all']);
        await runGitAt(siteDirectory, ['commit', '-m', 'Atualiza site pelo painel']);
        await runGitAt(siteDirectory, ['push', 'origin', 'main']);
        return { ok: true, message: 'Site estático publicado no repositório do site.' };
    } catch (error) {
        return { ok: false, message: `Não foi possível publicar o site estático: ${errorOutput(error)}` };
    } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
}

async function publishChanges() {
    if (process.env.AUTO_PUBLISH === '0') return { ok: false, skipped: true, message: 'Publicação automática desativada.' };
    try {
        const configuredRemotes = new Set(commandOutput(await runGit(['remote'])).split(/\r?\n/).filter(Boolean));
        const requiredRemotes = ['origin', 'githubio'];
        const missingRemotes = requiredRemotes.filter((remote) => !configuredRemotes.has(remote));
        if (missingRemotes.length) {
            return {
                ok: false,
                message: `Publicação não iniciada. Configure o(s) remoto(s): ${missingRemotes.join(', ')}.`
            };
        }

        await runGit(['add', '--', 'produtos.json', 'floricultura files']);
        const staged = await runGit(['diff', '--cached', '--name-only', '--', 'produtos.json', 'floricultura files']);
        const stagedFiles = commandOutput(staged).trim();

        if (stagedFiles) {
            await runGit([
                '-c', 'user.name=Pétala Painel',
                '-c', 'user.email=painel@petala.local',
                'commit', '--only', '-m', 'Atualiza catálogo pelo painel',
                '--', 'produtos.json', 'floricultura files'
            ]);
            await runGit(['push', 'origin', 'main']);
        }

        const siteRemote = commandOutput(await runGit(['remote', 'get-url', 'githubio'])).trim();
        const sitePublication = await publishStaticSite(siteRemote);
        if (!sitePublication.ok) return sitePublication;
        return { ok: true, message: sitePublication.message };
    } catch (error) {
        return { ok: false, message: `Catálogo salvo, mas não pôde ser publicado: ${errorOutput(error)}` };
    }
}

function queuePublication() {
    const publication = publicationQueue.then(publishChanges, publishChanges);
    publicationQueue = publication.then(() => undefined, () => undefined);
    return publication;
}

function setPublicationStatus(response, publication) {
    const status = publication.skipped ? 'disabled' : publication.ok ? 'published' : 'failed';
    response.setHeader('X-Catalog-Publication', status);
    if (status === 'failed') console.error(publication.message);
}

async function writeCatalog(catalog) {
    await fs.writeFile(CATALOG_FILE, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    return queuePublication();
}
function getCategory(catalog, category) { return category.split('.').reduce((value, key) => value && value[key], catalog); }
function safeFileName(originalName) {
    const extension = path.extname(originalName).toLowerCase();
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    return `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${allowed.includes(extension) ? extension : '.bin'}`;
}
function storedImagePath(image) {
    if (typeof image !== 'string') return null;
    const normalized = image.replace(/\\/g, '/');
    const filename = normalized.startsWith('floricultura files/') ? normalized.slice('floricultura files/'.length) : normalized.includes('/') ? null : normalized;
    if (!filename || filename.includes('/') || filename === '.' || filename === '..') return null;
    return path.join(UPLOAD_DIR, filename);
}
async function removeStoredImages(images) {
    await Promise.all(images.map((image) => {
        const filePath = storedImagePath(image);
        return filePath ? fs.rm(filePath, { force: true }) : Promise.resolve();
    }));
}

app.post('/api/login', async (request, response) => {
    if (request.body.pin !== panelPin) return response.status(401).json({ error: 'PIN incorreto.' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now());
    response.setHeader('Set-Cookie', `petala_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    response.json({ ok: true });
});
app.get('/api/status', (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({ backend: 'node' });
});

app.post('/api/logout', requireSession, (request, response) => {
    sessions.delete(readCookies(request).petala_session);
    response.setHeader('Set-Cookie', 'petala_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    response.json({ ok: true });
});

app.get('/api/catalog', requireSession, async (request, response) => response.json(await readCatalog()));
app.put('/api/catalog', requireSession, async (request, response) => {
    const publication = await writeCatalog(request.body);
    setPublicationStatus(response, publication);
    response.json(request.body);
});
app.post('/api/category', requireSession, async (request, response) => {
    const category = String(request.body.category || '').trim();
    if (!category || /[.\\/]/.test(category) || ['__proto__', 'constructor', 'prototype'].includes(category)) return response.status(400).json({ error: 'Nome de lista inválido.' });
    const catalog = await readCatalog();
    if (Object.prototype.hasOwnProperty.call(catalog, category)) return response.status(409).json({ error: 'Essa lista já existe.' });
    catalog[category] = [];
    const publication = await writeCatalog(catalog);
    setPublicationStatus(response, publication);
    response.json(catalog);
});

app.post('/api/product', requireSession, upload.array('images'), async (request, response) => {
    const catalog = await readCatalog();
    const action = request.body.action;
    const category = request.body.category;
    const oldCategory = request.body.oldCategory;
    const oldIndex = Number(request.body.oldIndex);
    const target = getCategory(catalog, category);
    if (!Array.isArray(target)) return response.status(400).json({ error: 'Categoria inválida.' });

    if (action === 'delete' || action === 'update') {
        const source = getCategory(catalog, oldCategory);
        if (!Array.isArray(source) || !Number.isInteger(oldIndex) || !source[oldIndex]) return response.status(400).json({ error: 'Produto inválido.' });
        const oldProduct = source[oldIndex];
        source.splice(oldIndex, 1);
        if (action === 'delete') await removeStoredImages(oldProduct.imagens || []);
        request.oldProduct = oldProduct;
    }
    if (action !== 'delete') {
        const product = JSON.parse(request.body.product);
        const existingImages = JSON.parse(request.body.existingImages || '[]');
        const oldProduct = request.oldProduct;
        if (oldProduct) await removeStoredImages((oldProduct.imagens || []).filter((image) => !existingImages.includes(image)));
        const newImages = [];
        for (const file of request.files || []) {
            const filename = safeFileName(file.originalname);
            await fs.rename(file.path, path.join(UPLOAD_DIR, filename));
            newImages.push(`floricultura files/${filename}`);
        }
        product.imagens = existingImages.concat(newImages);
        target.push(product);
    }
    const publication = await writeCatalog(catalog);
    setPublicationStatus(response, publication);
    response.json(catalog);
});

app.post('/api/publish', requireSession, async (request, response) => response.json(await queuePublication()));
app.post('/api/convert-images', requireSession, async (request, response) => {
    try {
        const catalog = await readCatalog();
        let converted = 0;
        const files = await fs.readdir(UPLOAD_DIR);
        for (const filename of files) {
            if (!/^.*\.(jpg|jpeg|png|gif)$/i.test(filename)) continue;
            const source = path.join(UPLOAD_DIR, filename);
            const target = path.join(UPLOAD_DIR, filename.replace(/\.(jpg|jpeg|png|gif)$/i, '.webp'));
            await sharp(source).rotate().webp({ quality: 82 }).toFile(target);
            await fs.rm(source, { force: true });
            converted++;
        }
        const replaceReferences = (value) => {
            if (Array.isArray(value)) return value.map(replaceReferences);
            if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceReferences(child)]));
            return typeof value === 'string' ? value.replace(/\.(jpg|jpeg|png|gif)$/i, '.webp') : value;
        };
        const publication = await writeCatalog(replaceReferences(catalog));
        setPublicationStatus(response, publication);
        response.json({ ok: true, converted, message: `${converted} imagem(ns) convertida(s) para WebP.` });
    } catch (error) {
        response.status(500).json({ ok: false, error: error.message });
    }
});
app.post('/api/change-pin', requireSession, async (request, response) => {
    if (process.env.PANEL_PIN) {
        return response.status(400).json({ error: 'O PIN é controlado pela variável PANEL_PIN. Altere essa configuração para trocar o PIN.' });
    }
    if (request.body.current !== panelPin) {
        return response.status(401).json({ error: 'PIN atual incorreto.' });
    }

    const nextPin = String(request.body.next || '');
    if (nextPin.length < 4) {
        return response.status(400).json({ error: 'O novo PIN precisa ter pelo menos 4 caracteres.' });
    }

    try {
        await fs.writeFile(PIN_FILE, nextPin, { encoding: 'utf8', mode: 0o600 });
    } catch {
        return response.status(500).json({ error: 'Não foi possível salvar o novo PIN.' });
    }

    panelPin = nextPin;
    response.json({ ok: true });
});

app.use((error, request, response, next) => {
    if (error instanceof multer.MulterError || error) return response.status(400).json({ error: 'Não foi possível receber a imagem. Use JPG, PNG, WebP ou GIF de até 8 MB.' });
    next();
});

fs.mkdir(UPLOAD_DIR, { recursive: true }).then(async () => {
    if (!process.env.PANEL_PIN) {
        try { panelPin = (await fs.readFile(PIN_FILE, 'utf8')).trim() || panelPin; } catch {}
    }
    app.listen(PORT, HOST, () => {
        const addresses = Object.values(os.networkInterfaces()).flat().filter((address) => address && address.family === 'IPv4' && !address.internal).map((address) => `http://${address.address}:${PORT}`);
        console.log(`Pétala disponível em http://localhost:${PORT}`);
        addresses.forEach((address) => console.log(`Acesso pelo celular: ${address}/painel.html`));
    });
});