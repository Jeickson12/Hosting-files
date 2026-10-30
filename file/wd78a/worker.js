/**
 * NagxStoreX — Hosting de imágenes
 * Cloudflare Worker + GitHub como almacenamiento
 *
 * Cada visitante sube imágenes y su galería se guarda únicamente en su
 * dispositivo (localStorage). Las imágenes se alojan en un repositorio de
 * GitHub y se comparten por enlace corto tipo /image/AbC123xY o /git/AbC123xY:
 * quien tiene el enlace ve solo esa imagen; en la página nadie puede ver las
 * imágenes de otros usuarios. Al eliminar una imagen se borra también del
 * repositorio de GitHub.
 *
 * Variables de entorno del Worker:
 *   GITHUB_TOKEN   (secreto) Token con permiso de escritura sobre el repositorio
 *   GITHUB_OWNER          Usuario u organización propietaria del repositorio
 *   GITHUB_REPO           Nombre del repositorio
 *   GITHUB_BRANCH         Rama (opcional; "main" por defecto)
 *
 * Carpetas del repositorio (se crean automáticamente):
 *   image/  ->  png, jpg, webp, bmp, avif, tiff, ico
 *   git/    ->  gif animados
 */

const ALLOWED_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/tiff',
  'image/x-icon',
  'image/vnd.microsoft.icon'
];

const IMAGE_FOLDER = 'image';
const GIF_FOLDER = 'git';

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  tiff: 'image/tiff',
  ico: 'image/x-icon'
};

// Carpetas donde puede estar un archivo ("gif" era la carpeta de una versión anterior)
function searchFoldersFor(folder) {
  if (folder === IMAGE_FOLDER) return [IMAGE_FOLDER];
  if (folder === GIF_FOLDER || folder === 'gif') return [GIF_FOLDER, 'gif'];
  return [IMAGE_FOLDER, GIF_FOLDER, 'gif'];
}

// ---------------------------------------------------------------------------
// IDs cortos (8 caracteres, estilo AbC123xY)
// ---------------------------------------------------------------------------
function generateShortId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let id = '';
  for (const b of bytes) id += alphabet[b % 62];
  return id;
}

function folderFor(contentType) {
  return contentType === 'image/gif' ? GIF_FOLDER : IMAGE_FOLDER;
}

function contentTypeFromName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Detecta el tipo de imagen por su contenido (los archivos se guardan sin extensión)
function sniffContentType(buf) {
  const b = new Uint8Array(buf);
  if (b.length > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length > 11 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length > 1 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length > 3 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
  if (b.length > 3 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))) return 'image/tiff';
  if (b.length > 11 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'image/avif';
  return 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------
function getConfig(env) {
  const owner = (env.GITHUB_OWNER || '').trim();
  const repo = (env.GITHUB_REPO || '').trim();
  const token = (env.GITHUB_TOKEN || '').trim();
  const branch = (env.GITHUB_BRANCH || 'main').trim();

  if (!owner || !repo || !token) {
    throw new Error('Missing configuration');
  }
  return { owner, repo, token, branch };
}

function githubHeaders(token, accept) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'NagxStoreX'
  };
}

function contentsUrl(cfg, path) {
  const encoded = (path || '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const base = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents`;
  return encoded ? `${base}/${encoded}` : base;
}

function encodeBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function githubErrorMessage(res) {
  let msg = '';
  try {
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      if (data && data.message) msg = data.message;
    } catch (e) {
      if (text) msg = text.slice(0, 160);
    }
  } catch (e) { /* sin cuerpo */ }
  return `GitHub ${res.status}${msg ? ' — ' + msg : ''}`;
}

// ---------------------------------------------------------------------------
// Subir imagen a GitHub (la carpeta se crea sola si no existe)
// ---------------------------------------------------------------------------
async function handleUpload(request, env) {
  try {
    const cfg = getConfig(env);
    const formData = await request.formData();
    const image = formData.get('image');

    if (!image) return new Response('No image provided', { status: 400 });
    if (!ALLOWED_TYPES.includes(image.type)) return new Response('Invalid image type', { status: 400 });

    const id = generateShortId();
    const folder = folderFor(image.type);
    const path = `${folder}/${id}`;
    const content = encodeBase64(await image.arrayBuffer());

    // Si la carpeta ya existe se utiliza; si no existe, GitHub la crea
    // automáticamente con esta misma subida (image/ o git/ según el formato).

    const res = await fetch(contentsUrl(cfg, path), {
      method: 'PUT',
      headers: githubHeaders(cfg.token),
      body: JSON.stringify({
        message: `Upload ${path}`,
        content,
        branch: cfg.branch
      })
    });

    if (!res.ok) {
      const detail = await githubErrorMessage(res);
      console.error('Upload error:', detail);
      return new Response('Upload failed — ' + detail, { status: 502 });
    }

    const origin = new URL(request.url).origin;
    return new Response(JSON.stringify({ id, folder, url: `${origin}/${folder}/${id}` }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error(error);
    return new Response('Upload failed', { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Eliminar imagen de GitHub de verdad
// ---------------------------------------------------------------------------
async function handleDelete(request, env) {
  try {
    const cfg = getConfig(env);
    const body = await request.json() || {};
    const folder = body.folder;
    const id = body.id;

    if (!/^[a-zA-Z0-9_-]{1,80}(\.[a-zA-Z0-9]{1,8})?$/.test(id || '')) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid id' }), { status: 400 });
    }

    // La carpeta es opcional: si no llega (imágenes guardadas por versiones
    // anteriores) se busca en todas las carpetas conocidas.
    const candidates = searchFoldersFor(folder).map(f => `${f}/${id}`);

    for (const path of candidates) {
      const metaRes = await fetch(contentsUrl(cfg, path), {
        headers: githubHeaders(cfg.token)
      });
      if (!metaRes.ok) continue;

      // Se necesita el sha actual del archivo para poder borrarlo
      let sha = '';
      try {
        const meta = await metaRes.json();
        sha = (meta && meta.sha) || '';
      } catch (e) { continue; }
      if (!sha) continue;

      const res = await fetch(contentsUrl(cfg, path), {
        method: 'DELETE',
        headers: githubHeaders(cfg.token),
        body: JSON.stringify({
          message: `Delete ${path}`,
          sha,
          branch: cfg.branch
        })
      });

      if (!res.ok) {
        const detail = await githubErrorMessage(res);
        return new Response(JSON.stringify({ ok: false, error: detail }), { status: 502 });
      }
      return new Response(JSON.stringify({ ok: true, deleted: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Ya no existía: se considera eliminada igualmente
    return new Response(JSON.stringify({ ok: true, deleted: false }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ ok: false, error: 'Delete failed' }), { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Servir imagen por carpeta + id corto: /image/AbC123xY  |  /git/AbC123xY
// ---------------------------------------------------------------------------
async function serveByFolder(request, env, folder, id) {
  if (!/^[a-zA-Z0-9_-]{1,80}(\.[a-zA-Z0-9]{1,8})?$/.test(id)) {
    return new Response('Not Found', { status: 404 });
  }

  try {
    const cfg = getConfig(env);

    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    // Busca en la carpeta pedida y en sus alias (gif/ era la carpeta de una
    // versión anterior); la imagen se sirve desde donde esté guardada.
    const candidates = searchFoldersFor(folder).map(f => `${f}/${id}`);

    for (const path of candidates) {
      const res = await fetch(contentsUrl(cfg, path), {
        headers: githubHeaders(cfg.token, 'application/vnd.github.raw+json')
      });
      if (!res.ok) continue;

      const buf = await res.arrayBuffer();
      const sniffed = sniffContentType(buf);
      const headers = new Headers();
      headers.set('Content-Type', sniffed !== 'application/octet-stream' ? sniffed : contentTypeFromName(path));
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      const response = new Response(buf, { status: 200, headers });
      await cache.put(cacheKey, response.clone());
      return response;
    }

    return new Response('Not Found', { status: 404 });
  } catch (error) {
    console.error(error);
    return new Response('Error', { status: 500 });
  }
}

// Compatibilidad con enlaces antiguos tipo /nombre.ext
async function serveLegacyName(request, env, name) {
  if (!/^[a-zA-Z0-9_-]{1,80}\.[a-zA-Z0-9]{1,8}$/.test(name)) {
    return new Response('Not Found', { status: 404 });
  }
  return serveByFolder(request, env, IMAGE_FOLDER, name).then(async (r) => {
    if (r.status !== 404) return r;
    return serveByFolder(request, env, GIF_FOLDER, name);
  });
}

// ---------------------------------------------------------------------------
// Estado de la conexión (solo lectura, sin datos sensibles)
// ---------------------------------------------------------------------------
async function handleCheck(env) {
  const lines = [];
  try {
    const cfg = getConfig(env);
    lines.push('Configuracion: OK');

    const repoRes = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}`, {
      headers: githubHeaders(cfg.token)
    });
    if (repoRes.status === 401) {
      lines.push('GitHub: ERROR — token invalido o expirado');
    } else if (repoRes.status === 404) {
      lines.push('GitHub: ERROR — el token no tiene acceso al repositorio');
    } else if (!repoRes.ok) {
      lines.push('GitHub: ERROR — status ' + repoRes.status);
    } else {
      const repoData = await repoRes.json();
      lines.push('GitHub: OK — repositorio accesible (' + (repoData.private ? 'privado' : 'publico') + ')');
      const brRes = await fetch(
        `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/branches/${encodeURIComponent(cfg.branch)}`,
        { headers: githubHeaders(cfg.token) }
      );
      lines.push(brRes.ok || brRes.status === 404
        ? 'Rama "' + cfg.branch + '": OK'
        : 'Rama "' + cfg.branch + '": ERROR — status ' + brRes.status);
    }
  } catch (error) {
    lines.push('Configuracion: ERROR — ' + error.message);
  }
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NagxStoreX - Free Image Hosting</title>
  <meta name="description" content="Fast and free image hosting. Upload, paste, or drop images to get a shareable link.">

  <!-- Google Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Ubuntu+Mono:wght@400;700&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">

  <!-- Font Awesome -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"/>

  <!-- Tailwind CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            mono: ['Ubuntu Mono', 'monospace'],
            sans: ['Inter', 'system-ui', 'sans-serif'],
          },
        },
      },
    };
  </script>

  <style>
    ::-webkit-scrollbar { display: none !important; }

    body {
      background-color: #070b18;
      background-image:
        radial-gradient(900px 500px at 12% -8%, rgba(124,58,237,0.22), transparent 60%),
        radial-gradient(800px 480px at 92% 12%, rgba(34,211,238,0.14), transparent 55%),
        radial-gradient(700px 420px at 50% 110%, rgba(79,70,229,0.16), transparent 60%);
      background-attachment: fixed;
    }

    .glass {
      background: rgba(13, 18, 36, 0.72);
      border: 1px solid rgba(148, 163, 184, 0.14);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
    }

    .gtext {
      background: linear-gradient(92deg, #c4b5fd 0%, #a5b4fc 38%, #67e8f9 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }

    .gtext-soft {
      background: linear-gradient(92deg, #a78bfa, #818cf8);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }

    .logo-badge {
      background: linear-gradient(135deg, #8b5cf6, #4f46e5 55%, #22d3ee);
      box-shadow: 0 8px 24px rgba(124, 58, 237, 0.35);
    }

    .btn-primary {
      background: linear-gradient(135deg, #7c3aed, #4f46e5);
      box-shadow: 0 10px 28px rgba(109, 40, 217, 0.35);
      transition: all .2s ease;
    }
    .btn-primary:hover { filter: brightness(1.1); transform: translateY(-1px); box-shadow: 0 14px 34px rgba(109, 40, 217, 0.45); }

    .btn-view { background: linear-gradient(135deg, #7c3aed, #4f46e5); transition: all .15s ease; }
    .btn-view:hover { filter: brightness(1.12); }
    .btn-copy { background: rgba(99, 102, 241, 0.16); border: 1px solid rgba(129, 140, 248, 0.45); color: #c7d2fe; transition: all .15s ease; }
    .btn-copy:hover { background: rgba(99, 102, 241, 0.28); color: #e0e7ff; }
    .btn-del { background: linear-gradient(135deg, #f43f5e, #e11d48); transition: all .15s ease; }
    .btn-del:hover { filter: brightness(1.1); }

    .chip {
      background: rgba(148, 163, 184, 0.08);
      border: 1px solid rgba(148, 163, 184, 0.16);
      color: #cbd5e1;
    }

    .upload-zone {
      border: 2px dashed rgba(139, 92, 246, 0.4);
      border-radius: 18px;
      transition: all .2s ease;
    }
    .upload-zone:hover {
      border-color: #8b5cf6;
      box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.12), 0 18px 40px rgba(2, 6, 23, 0.35);
    }

    .field {
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.2);
      color: #e2e8f0;
    }
    .field:focus { outline: none; border-color: #8b5cf6; box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.15); }
    .field::file-selector-button {
      background: linear-gradient(135deg, #7c3aed, #4f46e5);
      color: #fff;
      border: 0;
      padding: 10px 16px;
      margin-right: 14px;
      border-radius: 10px;
      font-weight: 600;
      cursor: pointer;
    }

    .img-card {
      background: rgba(13, 18, 36, 0.72);
      border: 1px solid rgba(148, 163, 184, 0.14);
      border-radius: 18px;
      overflow: hidden;
    }
    .img-card img { border-radius: 16px 16px 0 0; }

    .progress-track { background: rgba(148, 163, 184, 0.18); border-radius: 999px; }
    .progress-fill {
      background: linear-gradient(90deg, #8b5cf6, #6366f1 55%, #22d3ee);
      border-radius: 999px;
      transition: width .3s ease;
    }

    .step-num {
      background: linear-gradient(135deg, #7c3aed, #4f46e5);
      box-shadow: 0 6px 16px rgba(109, 40, 217, 0.3);
    }

    .toast {
      padding: 1rem 1.5rem;
      border-radius: 0.9rem;
      font-weight: 600;
      font-size: 0.875rem;
      max-width: 90%;
      animation: slideDown 0.3s ease forwards;
      opacity: 0;
      pointer-events: auto;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    .toast.success { background: rgba(6, 78, 59, 0.85); border: 1px solid rgba(52, 211, 153, 0.5); color: #a7f3d0; }
    .toast.error   { background: rgba(127, 29, 29, 0.85); border: 1px solid rgba(251, 113, 133, 0.5); color: #fecdd3; }
    @keyframes slideDown { from { opacity:0; transform:translateY(-10px); } to { opacity:1; transform:translateY(0); } }
  </style>
</head>
<body class="text-slate-200 antialiased font-mono min-h-screen">

  <!-- Header -->
  <header class="sticky top-0 z-40 py-4" style="background:rgba(7,11,24,0.72); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); border-bottom:1px solid rgba(148,163,184,0.12);">
    <div class="max-w-2xl mx-auto px-6 flex justify-between items-center">
      <div class="flex items-center space-x-3">
        <div class="logo-badge w-9 h-9 rounded-xl flex items-center justify-center">
          <i class="fas fa-image text-white"></i>
        </div>
        <h1 class="text-xl font-bold text-white">Nagx<span class="gtext">StoreX</span></h1>
      </div>
      <div class="flex items-center space-x-4">
        <a href="https://t.me/NagxStoreX" target="_blank" class="chip w-9 h-9 rounded-xl flex items-center justify-center text-violet-300 hover:text-white transition">
          <i class="fab fa-telegram-plane"></i>
        </a>
      </div>
    </div>
  </header>

  <!-- Main -->
  <main class="max-w-2xl mx-auto px-6 py-10">

    <!-- Intro -->
    <section class="text-center mb-8">
      <p class="text-xs mb-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full chip">
        <span class="w-2 h-2 rounded-full" style="background:linear-gradient(135deg,#8b5cf6,#22d3ee);"></span>
        Fast & Free Image Hosting
      </p>
      <h2 class="text-4xl font-bold text-white leading-tight">Upload. Share. <span class="gtext">Done.</span></h2>
      <p class="mt-3 text-slate-400 text-sm">Drop, paste, or select images — get a shareable link instantly.</p>
    </section>

    <!-- Upload Card -->
    <div id="dropZone" class="glass upload-zone p-6 mb-6">
      <div class="space-y-5">

        <!-- File Input -->
        <div>
          <label for="upFile" class="block text-sm font-bold text-white mb-2">Select or Drop Images</label>
          <input id="upFile" type="file" accept="image/*" multiple
                 class="field w-full p-4 rounded-xl text-sm font-mono">
        </div>

        <!-- Upload Button -->
        <div>
          <button id="upButton" disabled
                  class="btn-primary w-full text-white py-3 rounded-xl flex items-center justify-center gap-2 font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
            <i class="fas fa-upload"></i> Upload
          </button>
        </div>

        <!-- Info Boxes -->
        <div class="flex flex-wrap gap-2 text-xs">
          <div class="flex items-center gap-2 chip rounded-xl px-3 py-2">
            <i class="fas fa-clipboard text-violet-300"></i> Paste images directly
          </div>
          <div class="flex items-center gap-2 chip rounded-xl px-3 py-2">
            <i class="fas fa-image text-sky-300"></i> PNG, JPG, GIF, WEBP
          </div>
          <div class="flex items-center gap-2 chip rounded-xl px-3 py-2">
            <i class="fas fa-mouse-pointer text-emerald-300"></i> Drag & drop to upload
          </div>
        </div>

        <!-- Progress -->
        <div id="progressWrap" class="hidden mt-4">
          <div class="flex justify-between text-xs text-slate-400 mb-1">
            <span id="progressText">Uploading...</span>
            <span id="progressCount">0/0</span>
          </div>
          <div class="w-full progress-track h-2">
            <div id="progressBar" class="progress-fill h-2" style="width:0%"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Uploaded Images -->
    <section>
      <div class="mb-4">
        <h3 class="text-lg font-bold text-white">Your Uploads</h3>
        <p class="text-xs text-slate-400">Saved locally on this device</p>
      </div>

      <div id="emptyState" class="glass p-8 text-center rounded-2xl">
        <div class="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center" style="background:rgba(139,92,246,0.12); border:2px dashed rgba(139,92,246,0.4);">
          <i class="fas fa-image text-violet-300 text-2xl"></i>
        </div>
        <p class="font-medium text-slate-200">No uploads yet</p>
        <p class="text-xs text-slate-400 mt-1">Upload images to see them here</p>
      </div>

      <div id="imageContainer" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-6"></div>
    </section>

    <!-- How to Use -->
    <div class="my-8"></div>
    <div class="glass p-6 rounded-2xl">
      <h3 class="flex items-center gap-2 font-bold text-lg text-white mb-5">
        <span class="logo-badge w-9 h-9 rounded-xl flex items-center justify-center">
          <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
          </svg>
        </span>
        How to Use
      </h3>
      <div class="space-y-4">
        <div class="flex items-start gap-4">
          <div class="step-num text-white w-8 h-8 flex items-center justify-center flex-shrink-0 font-bold text-sm rounded-xl">1</div>
          <div class="flex-1">
            <h4 class="font-bold text-sm text-white mb-1">Select or Drop</h4>
            <p class="text-xs text-slate-400">Choose files or drag images into the box.</p>
          </div>
        </div>
        <div class="flex items-start gap-4">
          <div class="step-num text-white w-8 h-8 flex items-center justify-center flex-shrink-0 font-bold text-sm rounded-xl">2</div>
          <div class="flex-1">
            <h4 class="font-bold text-sm text-white mb-1">Click Upload</h4>
            <p class="text-xs text-slate-400">Wait for upload to complete.</p>
          </div>
        </div>
        <div class="flex items-start gap-4">
          <div class="step-num text-white w-8 h-8 flex items-center justify-center flex-shrink-0 font-bold text-sm rounded-xl">3</div>
          <div class="flex-1">
            <h4 class="font-bold text-sm text-white mb-1">Copy & Share</h4>
            <p class="text-xs text-slate-400">Click "Copy URL" to share your image.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <footer class="mt-12 text-center text-xs text-slate-500">
      <p>Developed by <a href="https://t.me/NagxStoreX" target="_blank" class="underline gtext-soft hover:opacity-80">NagxStoreX</a></p>
      <p class="mt-1">© 2026 NagxStoreX. All rights reserved.</p>
    </footer>
  </main>

  <!-- Toast Container -->
  <div id="notification-container"></div>

  <script>
    // Elements
    const upFile = document.getElementById('upFile');
    const upButton = document.getElementById('upButton');
    const dropZone = document.getElementById('dropZone');
    const imageContainer = document.getElementById('imageContainer');
    const emptyState = document.getElementById('emptyState');
    const progressWrap = document.getElementById('progressWrap');
    const progressText = document.getElementById('progressText');
    const progressCount = document.getElementById('progressCount');
    const progressBar = document.getElementById('progressBar');
    const toastContainer = document.getElementById('notification-container');

    // LocalStorage
    const LS_KEY = 'nagxstorex_images';
    const getImages = () => JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    const setImages = arr => localStorage.setItem(LS_KEY, JSON.stringify(arr));

    // Toast
    const showToast = (msg, type = 'success') => {
      const toast = document.createElement('div');
      toast.className = \`toast \${type} slide-down\`;
      toast.innerHTML = type === 'success'
        ? \`<i class="fas fa-check-circle mr-2"></i>\${msg}\`
        : \`<i class="fas fa-exclamation-triangle mr-2"></i>\${msg}\`;
      toastContainer.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    };

    // UI
    const toggleEmpty = () => emptyState.style.display = imageContainer.children.length ? 'none' : 'block';
    const setUploading = (state, total = 0) => {
      upButton.disabled = state || !upFile.files.length;
      upButton.innerHTML = state
        ? \`<i class="fas fa-spinner fa-spin"></i> Uploading...\`
        : \`<i class="fas fa-upload"></i> Upload\`;
      progressWrap.classList.toggle('hidden', !state);
      if (total) {
        progressCount.textContent = \`0/\${total}\`;
        progressBar.style.width = '0%';
      }
    };

    const itemLink = (item) => item.folder ? '/' + item.folder + '/' + item.id : '/' + item.id;

    // Image Card
    const finalizeCard = (card, item) => {
      const link = itemLink(item);
      card.innerHTML = \`
        <img src="\${link}" alt="Upload" loading="lazy" class="w-full h-40 object-cover">
        <div class="p-3 space-y-2">
          <div class="flex gap-2">
            <a href="\${link}" target="_blank" class="btn-view flex-1 text-white py-2.5 rounded-xl text-xs flex items-center justify-center gap-1">
              <i class="fas fa-eye"></i> View
            </a>
            <button class="copy-btn btn-copy flex-1 py-2.5 rounded-xl text-xs flex items-center justify-center gap-1">
              <i class="fas fa-copy"></i> Copy
            </button>
            <button class="delete-btn btn-del flex-1 text-white py-2.5 rounded-xl text-xs flex items-center justify-center gap-1" data-id="\${item.id}" data-folder="\${item.folder || ''}">
              <i class="fas fa-trash"></i> Delete
            </button>
          </div>
        </div>
      \`;
    };

    const addImageCard = (item) => {
      const card = document.createElement('div');
      card.className = 'img-card group';
      finalizeCard(card, item);
      imageContainer.prepend(card);
      toggleEmpty();
    };

    // Upload
    const uploadFile = async (file) => {
      const form = new FormData();
      form.append('image', file);
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    };

    const processUploads = async (files) => {
      if (!files.length) return;
      setUploading(true, files.length);
      let done = 0, success = 0;

      await Promise.all(files.map(async (file) => {
        try {
          const item = await uploadFile(file);
          addImageCard(item);
          const images = getImages();
          images.push(item);
          setImages(images);
          success++;
        } catch (e) {
          showToast(e.message, 'error');
        }
        done++;
        progressCount.textContent = \`\${done}/\${files.length}\`;
        progressBar.style.width = \`\${(done / files.length) * 100}%\`;
      }));

      setUploading(false);
      upFile.value = '';
      if (success) showToast(\`\${success} image\${success > 1 ? 's' : ''} uploaded!\`);
    };

    // Events
    upFile.onchange = () => upButton.disabled = !upFile.files.length;
    upButton.onclick = () => processUploads(Array.from(upFile.files));

    // Paste
    window.addEventListener('paste', e => {
      const files = Array.from(e.clipboardData.items)
        .filter(i => i.type.startsWith('image/'))
        .map(i => i.getAsFile()).filter(Boolean);
      if (files.length) processUploads(files);
    });

    // Drag & Drop
    ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, e => {
      e.preventDefault(); dropZone.style.borderColor = '#8b5cf6';
    }));
    ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => {
      e.preventDefault(); dropZone.style.borderColor = 'rgba(139,92,246,0.4)';
    }));
    dropZone.addEventListener('drop', e => {
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
      if (files.length) processUploads(files);
    });

    // Copy & Delete
    document.addEventListener('click', async e => {
      const copyBtn = e.target.closest('.copy-btn');
      if (copyBtn) {
        const url = copyBtn.dataset.url;
        try {
          await navigator.clipboard.writeText(url);
        } catch (err) {
          const ta = document.createElement('textarea');
          ta.value = url;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        showToast('URL copied!');
        return;
      }

      const delBtn = e.target.closest('.delete-btn');
      if (delBtn) {
        const id = delBtn.dataset.id;
        const folder = delBtn.dataset.folder;
        delBtn.disabled = true;
        try {
          const res = await fetch('/api/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, folder })
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || 'Delete failed');
          delBtn.closest('.img-card').remove();
          setImages(getImages().filter(i => (typeof i === 'string' ? i : i.id) !== id));
          toggleEmpty();
          showToast('Image deleted');
        } catch (err) {
          delBtn.disabled = false;
          showToast(err.message || 'Error deleting image', 'error');
        }
      }
    });

    // Compatibilidad con registros de versiones anteriores
    const normalizeEntry = (e) => {
      if (typeof e === 'string') {
        return { id: e, folder: e.toLowerCase().endsWith('.gif') ? 'git' : 'image' };
      }
      if (e && e.folder === 'gif') e.folder = 'git';
      return e;
    };

    // Restore
    getImages().reverse().forEach(e => addImageCard(normalizeEntry(e)));
    toggleEmpty();
  </script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // API
    if (path === '/api/upload' && request.method === 'POST') {
      return handleUpload(request, env);
    }

    if (path === '/api/delete' && request.method === 'POST') {
      return handleDelete(request, env);
    }

    if (path === '/api/check' && request.method === 'GET') {
      return handleCheck(env);
    }

    // Página principal
    if (path === '/' || path === '') {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Imagen con carpeta: /image/AbC123xY  |  /git/AbC123xY
    if (path.startsWith('/image/')) {
      return serveByFolder(request, env, IMAGE_FOLDER, decodeURIComponent(path.slice('/image/'.length)));
    }
    if (path.startsWith('/git/')) {
      return serveByFolder(request, env, GIF_FOLDER, decodeURIComponent(path.slice('/git/'.length)));
    }

    // Compatibilidad con enlaces antiguos: /nombre.ext
    if (path.length > 1 && !path.startsWith('/api') && path.includes('.')) {
      return serveLegacyName(request, env, decodeURIComponent(path.slice(1)));
    }

    return new Response('Not Found', { status: 404 });
  }
};
