'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = __dirname;
const REQUIRED_REMOTES = [
    ['origin', 'https://github.com/ayanokoji23456-lang/petala-painel.git'],
    ['githubio', 'https://github.com/ayanokoji23456-lang/ayanokoji23456-lang.github.io.git']
];

function runGit(args) {
    return execFileSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}

try {
    runGit(['rev-parse', '--show-toplevel']);

    for (const [name, url] of REQUIRED_REMOTES) {
        try {
            runGit(['remote', 'get-url', name]);
        } catch {
            runGit(['remote', 'add', name, url]);
            console.log(`Remoto Git ${name} configurado automaticamente.`);
        }
    }
} catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    console.error(`Não foi possível preparar os remotos Git automaticamente: ${detail}`);
}

require(path.join(ROOT, 'server.js'));
