const STORAGE_KEY = 'petala_catalogo';
const PIN_KEY = 'petala_painel_pin';
const CHECK_KEY = 'petala_checklist';
const DEFAULT_PIN = '1234';
const BACKEND_MODE = location.protocol !== 'file:';
const NODE_MODE = BACKEND_MODE && (location.port === '3000' || ['localhost', '127.0.0.1'].includes(location.hostname));
const DEFAULT_SIGNATURE = { kicker: 'A assinatura Pétala', title: 'Delicadeza em cada detalhe.', text: 'Do primeiro laço à última pétala, criamos presentes com intenção, beleza e o cuidado de quem conhece a força de um gesto.', name: 'Pétala', caption: 'flores para dizer o que importa' };
let catalog = {};
let editingImages = [];
let pendingImageFiles = [];

const $ = (selector) => document.querySelector(selector);

function apiUrl(action) { return NODE_MODE ? `/api/${action}` : `api.php?action=${encodeURIComponent(action)}`; }

function ensureCategoryPath(path) {
    const keys = path.split('.').filter(Boolean);
    let value = catalog;
    keys.forEach((key, index) => {
        if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) value[key] = index === keys.length - 1 ? [] : {};
        value = value[key];
    });
    return value;
}

function normalizeCategoryName(value) { return String(value || '').trim().replace(/[.\/]+/g, '-').replace(/\s+/g, ' '); }

function productCollections(value = catalog, path = []) {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) {
        const isProductList = value.length === 0 || value.every((item) => item && typeof item === 'object' && !Array.isArray(item) && 'titulo' in item);
        return isProductList ? [{ path: path.join('.'), products: value }] : [];
    }
    return Object.entries(value).flatMap(([key, child]) => productCollections(child, [...path, key]));
}

const allProducts = () => productCollections().flatMap(({ path, products }) => products.map((product, index) => ({ ...product, category: path, index })));
const categories = () => productCollections().map(({ path }) => path);
const categoryProducts = (path) => path.split('.').reduce((value, key) => value[key], catalog);
const formatPrice = (price) => typeof price === 'number' ? price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : (price || 'Sob consulta');
const signatureData = () => ({ ...DEFAULT_SIGNATURE, ...(catalog.assinaturaFloral || {}) });

function renderSignatureForm() {
    const signature = signatureData();
    $('#signature-kicker').value = signature.kicker;
    $('#signature-title').value = signature.title;
    $('#signature-text').value = signature.text;
    $('#signature-name').value = signature.name;
    $('#signature-caption').value = signature.caption;
}

function showStatus(message) {
    $('#status-message').textContent = message;
    window.clearTimeout(showStatus.timer);
    showStatus.timer = window.setTimeout(() => {
        $('#status-message').textContent = '';
    }, 3500);
}

function publicationMessage(response, successMessage) {
    if (!NODE_MODE) return successMessage;

    const status = response?.headers.get('X-Catalog-Publication');
    if (status === 'failed') {
        return `${successMessage} A publicação remota falhou; confira a configuração dos destinos.`;
    }
    if (status === 'disabled') {
        return `${successMessage} A publicação externa está desativada.`;
    }
    if (status === 'published') {
        return `${successMessage} Enviado aos destinos configurados.`;
    }
    return successMessage;
}

function saveCatalog() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(catalog));
    render();
    showStatus('Alterações salvas neste navegador.');
}

function imageDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function convertFileToWebP(file, quality = 0.82) {
    if (/\.webp$/i.test(file.name)) return file;
    if (!/^image\/(jpeg|png)$/i.test(file.type)) return file;
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.(jpg|jpeg|png)$/i, '.webp'), { type: 'image/webp' });
}

async function loadCatalog() {
    if (BACKEND_MODE) {
        const response = await fetch(apiUrl('catalog'));
        if (!response.ok) throw new Error('Não autenticado.');
        catalog = await response.json();
        return;
    }

    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        catalog = JSON.parse(saved);
        return;
    }

    try {
        const response = await fetch('produtos.json');
        catalog = await response.json();
    } catch (error) {
        catalog = { produtos: [] };
        showStatus('Não foi possível carregar produtos.json.');
    }
}

function render() {
    const products = allProducts().map((product, editorIndex) => ({ ...product, editorIndex }));
    const categoryPaths = categories();
    const query = $('#search-input').value.trim().toLowerCase();
    const filtered = products.filter((product) => `${product.titulo} ${product.descricao} ${product.category}`.toLowerCase().includes(query));
    $('#product-count').textContent = products.length;
    $('#category-count').textContent = categoryPaths.length;
    $('#image-count').textContent = products.reduce((total, product) => total + (product.imagens || []).length, 0);
    $('#product-list').innerHTML = filtered.length ? filtered.map((product) => `
        <article class="product-item">
            ${product.imagens?.[0] ? `<img class="product-thumb" src="${resolverImagemProduto(product.imagens[0])}" data-caminho-alternativo="${product.imagens[0]}" onerror="tentarImagemAlternativa(this)" alt="">` : '<div class="product-thumb"></div>'}
            <div><h3>${escapeHtml(product.titulo || 'Sem nome')}</h3><div class="product-meta">${escapeHtml(product.category)} · ${(product.imagens || []).length} imagem(ns)</div></div>
            <strong class="product-price">${formatPrice(product.preco)}</strong>
            <button class="edit-link" data-edit="${product.editorIndex}" type="button">Editar</button>
        </article>`).join('') : '<p class="muted">Nenhum produto encontrado.</p>';
    $('#product-list').querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => openEditor(Number(button.dataset.edit))));
    $('#product-list').querySelectorAll('img.product-thumb').forEach((image) => image.addEventListener('error', () => marcarImagemIndisponivel(image)));
    const select = $('#product-category'); select.innerHTML = categoryPaths.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
    renderSignatureForm();
    renderSignatureProducts(products);
}

function renderSignatureProducts(products) {
    const signatures = Array.isArray(catalog.assinaturas) ? catalog.assinaturas : [];
    const editorIndexes = new Map();
    products.forEach((product, index) => {
        if (product.category === 'assinaturas') editorIndexes.set(product.index, index);
    });
    $('#signature-product-list').innerHTML = signatures.length ? signatures.map((product, index) => {
        const productIndex = editorIndexes.get(index) ?? -1;
        return `
            <article class="product-item">
                <div class="product-thumb"></div>
                <div>
                    <h3>${escapeHtml(product.titulo || 'Sem nome')}</h3>
                    <div class="product-meta">${(product.imagens || []).length} imagem(ns)</div>
                </div>
                <strong class="product-price">${formatPrice(product.preco)}</strong>
                <button class="edit-link" data-signature-edit="${productIndex}" type="button">Editar</button>
            </article>`;
    }).join('') : '<p class="muted">Nenhuma assinatura cadastrada.</p>';
    $('#signature-product-list').querySelectorAll('[data-signature-edit]').forEach((button) => button.addEventListener('click', () => openEditor(Number(button.dataset.signatureEdit))));
}

function escapeHtml(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' };
    return String(value).replace(/[&<>'"]/g, (character) => entities[character]);
}

function resolverImagemProduto(caminho) {
    if (!caminho) return '';
    const limpo = caminho.replace(/^(\.\.\/)+/, '').replace(/^Pétala Floricultura_files\//, '');
    if (!limpo.includes('/') && !limpo.startsWith('uploads/')) return `floricultura files/${limpo}`;
    return limpo;
}

function marcarImagemIndisponivel(imagem) {
    imagem.onerror = null;
    const aviso = document.createElement('div');
    aviso.className = 'imagem-indisponivel';
    aviso.textContent = 'Imagem não encontrada';
    imagem.replaceWith(aviso);
}

function tentarImagemAlternativa(imagem) {
    const caminho = imagem.dataset.caminhoAlternativo || imagem.src;
    const limpo = caminho.replace(/^(\.\.\/)+/, '').replace(/^Pétala Floricultura_files\//, '');
    const tentativas = [limpo];

    if (!limpo.includes('/')) tentativas.push(`floricultura files/${limpo}`);
    if (/\.webp$/i.test(limpo)) {
        const base = limpo.replace(/\.webp$/i, '');
        tentativas.push(`${base}.png`, `${base}.jpg`, `${base}.jpeg`);
        if (!limpo.includes('/')) {
            tentativas.push(`floricultura files/${base}.png`, `floricultura files/${base}.jpg`, `floricultura files/${base}.jpeg`);
        }
    }

    tentativas.push(`Pétala Floricultura_files/${limpo}`);
    const tentativaAtual = Number(imagem.dataset.tentativa || '0');
    if (tentativaAtual >= tentativas.length) {
        marcarImagemIndisponivel(imagem);
        return;
    }

    imagem.dataset.tentativa = String(tentativaAtual + 1);
    imagem.src = tentativas[tentativaAtual];
    imagem.onerror = () => tentarImagemAlternativa(imagem);
}

function imagemHtml(caminho, index) {
    return `
        <div class="image-preview-item">
            <img src="${resolverImagemProduto(caminho)}" data-caminho-alternativo="${caminho}" alt="Imagem do produto" onerror="tentarImagemAlternativa(this)">
            <button class="image-delete-button" type="button" data-image-index="${index}" aria-label="Excluir imagem">Excluir</button>
        </div>`;
}
function renderImagePreview() {
    $('#image-preview').innerHTML = editingImages.map(imagemHtml).join('');
    $('#image-preview').querySelectorAll('[data-image-index]').forEach((button) => {
        button.addEventListener('click', () => {
            editingImages.splice(Number(button.dataset.imageIndex), 1);
            if (BACKEND_MODE) {
                pendingImageFiles = pendingImageFiles.filter(({ url }) => editingImages.includes(url));
            }
            renderImagePreview();
        });
    });
}

function openEditor(productIndex = null) {
    const product = productIndex === null ? null : allProducts()[productIndex];
    $('#product-index').value = productIndex ?? '';
    $('#editor-title').textContent = product ? 'Editar produto' : 'Novo produto';
    $('#product-title').value = product?.titulo || '';
    $('#product-description').value = product?.descricao || '';
    $('#product-price').value = typeof product?.preco === 'number' ? product.preco : '';
    $('#product-category').value = product?.category || categories()[0] || 'produtos';
    editingImages = [...(product?.imagens || [])];
    pendingImageFiles = [];
    renderImagePreview();
    $('#delete-product-button').classList.toggle('is-hidden', !product);
    $('#editor-dialog').classList.remove('is-hidden');
    $('#product-title').focus();
}
function closeEditor() {
    $('#editor-dialog').classList.add('is-hidden');
}

async function saveProduct(event) {
    event.preventDefault();
    const index = $('#product-index').value;
    const category = $('#product-category').value;
    const price = $('#product-price').value;
    const product = {
        titulo: $('#product-title').value.trim(),
        descricao: $('#product-description').value.trim(),
        preco: price === '' ? null : Number(price),
        imagens: editingImages
    };

    if (BACKEND_MODE) {
        const old = index === '' ? null : allProducts()[Number(index)];
        const existingImages = editingImages.filter((image) => !image.startsWith('blob:'));
        product.imagens = existingImages;
        const formData = new FormData();
        formData.append('action', old ? 'update' : 'create');
        formData.append('category', category);
        formData.append('oldCategory', old?.category || category);
        formData.append('oldIndex', old?.index ?? '');
        formData.append('product', JSON.stringify(product));
        formData.append('existingImages', JSON.stringify(existingImages));
        pendingImageFiles.forEach(({ file }) => formData.append('images', file));
        const response = await fetch(apiUrl('product'), { method: 'POST', body: formData });
        if (!response.ok) {
            showStatus('Não foi possível salvar o produto.');
            return;
        }

        catalog = await response.json();
        closeEditor();
        render();
        showStatus(publicationMessage(response, 'Produto salvo e imagem enviada ao servidor.'));
        return;
    }

    if (index !== '') {
        const old = allProducts()[Number(index)];
        categoryProducts(old.category).splice(old.index, 1);
    }
    ensureCategoryPath(category).push(product);
    closeEditor();
    saveCatalog();
}

async function deleteProduct() {
    const product = allProducts()[Number($('#product-index').value)];
    if (!product || !window.confirm(`Excluir "${product.titulo}"?`)) return;

    if (BACKEND_MODE) {
        const formData = new FormData();
        formData.append('action', 'delete');
        formData.append('category', product.category);
        formData.append('oldCategory', product.category);
        formData.append('oldIndex', product.index);
        const response = await fetch(apiUrl('product'), { method: 'POST', body: formData });
        if (!response.ok) {
            showStatus('Não foi possível excluir o produto.');
            return;
        }

        catalog = await response.json();
        closeEditor();
        render();
        showStatus(publicationMessage(response, 'Produto excluído.'));
        return;
    }

    categoryProducts(product.category).splice(product.index, 1);
    closeEditor();
    saveCatalog();
}

function updateChecklist() {
    const checks = [...document.querySelectorAll('[data-check]')];
    const done = checks.filter((check) => check.checked).length;
    $('#checklist-progress').textContent = `${done}/${checks.length}`;
    localStorage.setItem(CHECK_KEY, JSON.stringify(Object.fromEntries(checks.map((check) => [check.dataset.check, check.checked]))));
}

function loadChecklist() {
    const checks = JSON.parse(localStorage.getItem(CHECK_KEY) || '{}');
    document.querySelectorAll('[data-check]').forEach((check) => {
        check.checked = Boolean(checks[check.dataset.check]);
        check.addEventListener('change', updateChecklist);
    });
    updateChecklist();
}

async function downloadSite() {
    if (!BACKEND_MODE || NODE_MODE) {
        showStatus('O ZIP completo fica disponível no painel hospedado na Hostinger.');
        return;
    }

    const response = await fetch('exportar-site.php');
    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        showStatus(result.error || 'Não foi possível gerar o ZIP do site.');
        return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'petala-site-atualizado.zip';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    document.querySelector('[data-check="publish"]').checked = false;
    showStatus('ZIP completo do site baixado.');
}

function importCatalog(file) {
    const reader = new FileReader();
    reader.onload = () => {
        try {
            catalog = JSON.parse(reader.result);
            saveCatalog();
        } catch {
            showStatus('Arquivo inválido. Escolha um JSON de produtos.');
        }
    };
    reader.readAsText(file);
}

async function addCategory() {
    const category = normalizeCategoryName(window.prompt('Nome da nova lista de produtos:') || '');
    if (!category) return;
    if (categories().includes(category)) {
        showStatus('Essa lista já existe.');
        return;
    }
    let response;
    if (BACKEND_MODE) {
        response = await fetch(apiUrl('category'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category })
        });
        if (!response.ok) {
            showStatus('Não foi possível criar a lista.');
            return;
        }
        catalog = await response.json();
    } else ensureCategoryPath(category);
    render();
    $('#product-category').value = category;
    showStatus(publicationMessage(response, `Lista "${category}" criada.`));
}

async function openNewSignature() {
    if (!Array.isArray(catalog.assinaturas)) {
        if (BACKEND_MODE) {
            const response = await fetch(apiUrl('category'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category: 'assinaturas' })
            });
            if (!response.ok && response.status !== 409) {
                showStatus('Não foi possível criar a lista de assinaturas.');
                return;
            }
            const catalogResponse = await fetch(apiUrl('catalog'));
            catalog = await catalogResponse.json();
        } else ensureCategoryPath('assinaturas');
    }
    render();
    openEditor();
    $('#product-category').value = 'assinaturas';
}

async function saveSignature(event) {
    event.preventDefault();
    catalog.assinaturaFloral = {
        kicker: $('#signature-kicker').value.trim(),
        title: $('#signature-title').value.trim(),
        text: $('#signature-text').value.trim(),
        name: $('#signature-name').value.trim(),
        caption: $('#signature-caption').value.trim()
    };
    let response;
    if (BACKEND_MODE) {
        response = await fetch(apiUrl('catalog'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(catalog)
        });
        if (!response.ok) {
            showStatus('Não foi possível salvar a assinatura.');
            return;
        }
        catalog = await response.json();
    } else localStorage.setItem(STORAGE_KEY, JSON.stringify(catalog));
    showStatus(publicationMessage(response, 'Assinatura floral salva.'));
}

async function changePin() {
    const current = window.prompt('Digite o PIN atual:');
    const next = window.prompt('Digite o novo PIN (mínimo de 4 caracteres):');
    if (!current || !next || next.length < 4) return;

    if (BACKEND_MODE) {
        const response = await fetch(apiUrl('change-pin'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ current, next })
        });
        const result = response.ok ? null : await response.json();
        window.alert(result ? result.error : 'PIN alterado com sucesso.');
        return;
    }

    const expected = localStorage.getItem(PIN_KEY) || DEFAULT_PIN;
    if (current !== expected) {
        window.alert('PIN atual incorreto.');
        return;
    }
    localStorage.setItem(PIN_KEY, next);
    window.alert('PIN alterado com sucesso.');
}

function setup() {
    $('#login-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const pin = $('#login-pin').value;

        if (BACKEND_MODE) {
            const response = await fetch(apiUrl('login'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin })
            });
            if (!response.ok) {
                $('#login-error').textContent = 'PIN incorreto.';
                return;
            }
        } else if (pin !== (localStorage.getItem(PIN_KEY) || DEFAULT_PIN)) {
            $('#login-error').textContent = 'PIN incorreto.';
            return;
        }

        try {
            $('#login-view').classList.add('is-hidden');
            $('#app-view').classList.remove('is-hidden');
            await loadCatalog();
            render();
            loadChecklist();
        } catch {
            $('#login-view').classList.remove('is-hidden');
            $('#app-view').classList.add('is-hidden');
            $('#login-error').textContent = 'Não foi possível carregar o catálogo.';
        }
    });

    $('#new-product-button').addEventListener('click', () => openEditor());
    $('#new-signature-button').addEventListener('click', openNewSignature);
    $('#new-category-button').addEventListener('click', addCategory);
    $('#signature-form').addEventListener('submit', saveSignature);
    $('#close-dialog').addEventListener('click', closeEditor);
    $('#cancel-button').addEventListener('click', closeEditor);
    $('#product-form').addEventListener('submit', saveProduct);
    $('#delete-product-button').addEventListener('click', deleteProduct);
    $('#search-input').addEventListener('input', render);
    $('#preview-button').addEventListener('click', () => window.open('index.html', '_blank'));
    $('#change-pin-button').addEventListener('click', changePin);
    $('#logout-button').addEventListener('click', () => window.location.reload());

    $('#product-images').addEventListener('change', async (event) => {
        let files = [...event.target.files];
        if (BACKEND_MODE) {
            files = await Promise.all(files.map(convertFileToWebP));
            const newImages = files.map((file) => ({ file, url: URL.createObjectURL(file) }));
            pendingImageFiles = pendingImageFiles.concat(newImages);
            editingImages = editingImages.concat(newImages.map(({ url }) => url));
        } else {
            const imageUrls = await Promise.all(files.map(async (file) => {
                const converted = await convertFileToWebP(file);
                return imageDataUrl(converted);
            }));
            editingImages = editingImages.concat(imageUrls);
        }
        renderImagePreview();
        event.target.value = '';
    });

    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeEditor(); });

    const download = document.createElement('button');
    download.className = 'button button-primary';
    download.textContent = 'Baixar site atualizado';
    download.type = 'button';
    download.addEventListener('click', downloadSite);
    $('.intro-row').append(download);

    const importLabel = document.createElement('label');
    importLabel.className = 'button button-quiet';
    importLabel.textContent = 'Importar JSON';
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.json,application/json';
    importInput.hidden = true;
    importInput.addEventListener('change', () => importCatalog(importInput.files[0]));
    importLabel.append(importInput);
    $('.intro-row').append(importLabel);

    if (NODE_MODE) {
        const publish = document.createElement('button');
        publish.className = 'button button-primary';
        publish.textContent = 'Publicar agora';
        publish.type = 'button';
        publish.addEventListener('click', async () => {
            publish.disabled = true;
            try {
                const response = await fetch(apiUrl('publish'), { method: 'POST' });
                const result = await response.json().catch(() => ({}));
                showStatus(String(result?.message || (result?.ok ? 'Publicação concluída.' : 'Falha na publicação.')));
            } catch (error) {
                showStatus(`Falha ao publicar: ${String(error?.message || error || 'erro desconhecido')}`);
            } finally {
                publish.disabled = false;
            }
        });
        $('.intro-row').append(publish);

        const convertExisting = document.createElement('button');
        convertExisting.className = 'button button-quiet';
        convertExisting.textContent = 'Converter imagens existentes';
        convertExisting.type = 'button';
        convertExisting.addEventListener('click', async () => {
            if (!window.confirm('Converter todas as imagens JPEG, PNG e GIF atuais para WebP?')) return;
            convertExisting.disabled = true;
            const response = await fetch(apiUrl('convert-images'), { method: 'POST' });
            const result = await response.json();
            convertExisting.disabled = false;
            await loadCatalog();
            render();
            showStatus(publicationMessage(response, result.message || result.error || 'Conversão concluída.'));
        });
        $('.intro-row').append(convertExisting);
    }
}

setup();
