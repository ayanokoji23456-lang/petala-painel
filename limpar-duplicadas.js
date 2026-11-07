const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const QUARANTINE = path.join(ROOT, '_duplicadas');
const IMAGE_EXTENSIONS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif']);
const MOVE_FILES = process.argv.includes('--mover');

async function filesIn(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'uploads' || entry.name === '_duplicadas') {
            continue;
        }
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await filesIn(fullPath));
        } else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            files.push(fullPath);
        }
    }
    return files;
}

function normalizeReference(value) {
    return value
        .replace(/^\.\.\//g, '')
        .replace(/^Pétala Floricultura_files\//i, '')
        .replace(/^floricultura files\//i, '')
        .replace(/\\/g, '/')
        .toLowerCase();
}

function relativeVariants(filePath) {
    const relative = path.relative(ROOT, filePath).replace(/\\/g, '/');
    const base = path.basename(relative).toLowerCase();
    return new Set([
        relative.toLowerCase(),
        base,
        `floricultura files/${base}`
    ]);
}

async function referencedImages() {
    const references = new Set();
    const catalog = JSON.parse(await fs.readFile(path.join(ROOT, 'produtos.json'), 'utf8'));
    const visit = (value) => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value.imagens)) {
            value.imagens.forEach((image) => references.add(normalizeReference(image)));
        }
        Object.values(value).forEach(visit);
    };
    visit(catalog);
    const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
    for (const match of html.matchAll(/(?:src|url)\s*=\s*["']([^"']+\.(?:webp|png|jpe?g|gif))["']/gi)) {
        references.add(normalizeReference(match[1]));
    }
    return references;
}

async function hashFile(filePath) {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

async function main() {
    const files = await filesIn(ROOT);
    const references = await referencedImages();
    const groups = new Map();
    for (const file of files) {
        const hash = await hashFile(file);
        if (!groups.has(hash)) groups.set(hash, []);
        groups.get(hash).push(file);
    }
    const duplicates = [...groups.values()].filter((group) => group.length > 1);
    if (!duplicates.length) {
        console.log('Nenhuma duplicata exata encontrada.');
        return;
    }

    console.log(`${duplicates.length} grupo(s) de duplicatas encontrado(s).`);
    let moved = 0;
    for (const group of duplicates) {
        const protectedFiles = group.filter((file) =>
            [...relativeVariants(file)].some((variant) => references.has(variant))
        );
        const keep = protectedFiles[0] || group[0];
        const move = group.filter((file) => file !== keep && !protectedFiles.includes(file));
        console.log(`\nManter: ${path.relative(ROOT, keep)}`);
        move.forEach((file) => {
            console.log(`${MOVE_FILES ? 'Mover' : 'Candidato'}: ${path.relative(ROOT, file)}`);
        });
        if (MOVE_FILES) {
            for (const file of move) {
                const destination = path.join(QUARANTINE, path.relative(ROOT, file));
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.rename(file, destination);
                moved += 1;
            }
        }
    }
    const summary = MOVE_FILES
        ? `\n${moved} arquivo(s) movido(s) para _duplicadas/.`
        : '\nSimulação concluída. Para mover, execute: node limpar-duplicadas.js --mover';
    console.log(summary);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
