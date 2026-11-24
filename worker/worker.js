/**
 * Multiprintt — Cloudflare Worker
 * Backblaze B2 private storage + public CDN proxy + authenticated admin API.
 *
 * IMPORTANT:
 *   NEVER place B2_KEY_ID / B2_APPLICATION_KEY in admin.html or GitHub.
 *   Store them as Cloudflare Worker Secrets.
 *
 * Required plain variables:
 *   B2_ENDPOINT=s3.us-east-005.backblazeb2.com
 *   BUCKET_NAME=multiprintt-media
 *   FIREBASE_PROJECT_ID=multiprintt-cc0f1
 *   PUBLIC_BASE_URL=https://b2.multiprintt.workers.dev
 *   ALLOWED_ORIGINS=https://multiprintt.web.app,https://multiprintt.firebaseapp.com
 *
 * Required secrets:
 *   B2_KEY_ID
 *   B2_APPLICATION_KEY
 */

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_SCAN = 5000;
const MAX_BULK_DELETE = 100;
const ALLOWED_CATEGORIES = new Set(['textil', 'jarros', 'imp-general', 'packs']);
const TESTIMONIAL_VIDEO_PREFIX = 'testimonio_videos/';
const TESTIMONIAL_VIDEO_MAX_BYTES = 40 * 1024 * 1024;
const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const B2_COUNT_CACHE_TTL_MS = 15000;
let b2CountCache = new Map();
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};

let firebaseJwksCache = null;
let firebaseJwksExpiresAt = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(origin, env, true)
        });
      }

      if (url.pathname === '/' || url.pathname === '') {
        return new Response('Multiprintt B2 CDN/API activo', {
          status: 200,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store'
          }
        });
      }

      if (url.pathname === '/health') {
        return json(
          { ok: true, service: 'multiprintt-b2' },
          200,
          corsHeaders(origin, env, true)
        );
      }

      if (url.pathname.startsWith('/api/')) {
        if (!isOriginAllowed(origin, env)) {
          return json(
            { ok: false, error: 'Origin no autorizado.' },
            403,
            corsHeaders(origin, env, true)
          );
        }

        await requireAdmin(request, env);
        return await handleApi(request, env, ctx, url, origin);
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: 'GET, HEAD' }
        });
      }

      return await proxyPublicObject(request, env, ctx, url);
    } catch (error) {
      console.error('Multiprintt Worker:', error);

      const isHttpError = error instanceof HttpError;
      const status = isHttpError ? Number(error.status) || 500 : 500;
      const message = isHttpError ? error.publicMessage : 'Error interno del Worker.';
      const code = isHttpError ? error.code : '';

      if (url.pathname.startsWith('/api/')) {
        return json(
          { ok: false, error: message, code },
          status,
          corsHeaders(origin, env, true)
        );
      }

      return new Response(message, {
        status,
        headers: { 'cache-control': 'no-store' }
      });
    }
  }
};

async function handleApi(request, env, ctx, url, origin) {
  const path = url.pathname;

  if (path === '/api/testimonial-videos' && request.method === 'GET') {
    return apiListTestimonialVideos(env, url, origin);
  }

  if (path === '/api/testimonial-video' && request.method === 'POST') {
    return apiCreateTestimonialVideo(request, env, origin);
  }

  if (path === '/api/testimonial-video' && request.method === 'DELETE') {
    return apiDeleteTestimonialVideo(request, env, ctx, origin);
  }

  if (path === '/api/list' && request.method === 'GET') {
    return apiList(env, url, origin);
  }

  if (path === '/api/count' && request.method === 'GET') {
    return apiCount(env, url, origin);
  }

  if (path === '/api/file' && request.method === 'POST') {
    return apiCreateFile(request, env, origin);
  }

  if (path === '/api/file' && request.method === 'PUT') {
    return apiReplaceFile(request, env, ctx, origin);
  }

  if (path === '/api/file' && request.method === 'PATCH') {
    return apiPatchFile(request, env, ctx, origin);
  }

  if (path === '/api/file' && request.method === 'DELETE') {
    return apiDeleteFile(request, env, ctx, origin);
  }

  if (path === '/api/delete-many' && request.method === 'POST') {
    return apiDeleteMany(request, env, ctx, origin);
  }

  if (path === '/api/migrate' && request.method === 'POST') {
    return apiMigrate(request, env, origin);
  }

  if (path === '/api/migrate-external' && request.method === 'POST') {
    return apiMigrateExternal(request, env, origin);
  }

  return json(
    { ok: false, error: 'Ruta API no encontrada.' },
    404,
    corsHeaders(origin, env, true)
  );
}

async function apiList(env, url, origin) {
  const rawCategory = String(
    url.searchParams.get('category') || ''
  ).trim().toLowerCase();

  const category =
    rawCategory && rawCategory !== 'all'
      ? normalizeCategory(rawCategory)
      : '';

  if (
    rawCategory &&
    rawCategory !== 'all' &&
    !category
  ) {
    throw httpError(
      400,
      'Categoría no permitida.',
      'invalid_category'
    );
  }

  const search = String(
    url.searchParams.get('search') || ''
  ).trim().toLowerCase();

  const pageSize = clampInt(
    url.searchParams.get('pageSize') ||
      url.searchParams.get('limit') ||
      DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE
  );

  const continuationToken = String(
    url.searchParams.get('continuationToken') || ''
  );

  if (search) {
    const items = await searchObjects(
      env,
      search,
      category,
      MAX_SEARCH_SCAN
    );

    return json(
      {
        ok: true,
        items,
        isTruncated: false,
        nextContinuationToken: null,
        count: items.length,
        search
      },
      200,
      corsHeaders(origin, env, true)
    );
  }

  if (!category) {
    // "Todas": solo fotos del catálogo (categorías + media/migrated/productos/).
    // El bucket también guarda media/ (miniaturas, recursos migrados) y videos.
    const pageAll = await listCatalogPage(env, pageSize, continuationToken);
    return json(
      {
        ok: true,
        items: pageAll.items.map(objectToApiItem(env)),
        isTruncated: pageAll.isTruncated,
        nextContinuationToken: pageAll.nextContinuationToken,
        count: pageAll.items.length,
        pageSize
      },
      200,
      corsHeaders(origin, env, true)
    );
  }

  const page = await listObjectsV2(env, {
    prefix: category ? `${category}/` : '',
    maxKeys: pageSize,
    continuationToken
  });

  return json(
    {
      ok: true,
      items: page.items.map(objectToApiItem(env)),
      isTruncated: page.isTruncated,
      nextContinuationToken: page.nextContinuationToken,
      count: page.items.length,
      pageSize
    },
    200,
    corsHeaders(origin, env, true)
  );
}

function isCatalogKey(key) {
  // Fotos de productos: categorías actuales + fotos antiguas migradas desde GitHub.
  return ALLOWED_CATEGORIES.has(categoryFromKey(key)) || String(key).startsWith('media/migrated/productos/');
}

// Paginación de "Todas" con cursor propio ("sa:<última clave>"), porque al filtrar
// las claves que no son del catálogo una página de B2 no coincide con una de la API.
async function listCatalogPage(env, pageSize, cursor) {
  let startAfter = String(cursor || '').startsWith('sa:') ? String(cursor).slice(3) : '';
  const items = [];
  let more = true;
  let guard = 0;
  while (items.length < pageSize && more && guard++ < 20) {
    const page = await listObjectsV2(env, { maxKeys: 1000, startAfter });
    for (const item of page.items) {
      startAfter = item.key;
      if (!isCatalogKey(item.key)) continue;
      items.push(item);
      if (items.length >= pageSize) break;
    }
    const consumedAll = !page.items.length || startAfter === page.items[page.items.length - 1].key;
    more = Boolean(page.isTruncated) || !consumedAll;
    if (!page.items.length) more = false;
  }
  return {
    items,
    isTruncated: more,
    nextContinuationToken: more ? `sa:${startAfter}` : null
  };
}

async function apiCount(env, url, origin) {
  const rawCategory = String(
    url.searchParams.get('category') || ''
  ).trim().toLowerCase();

  const category =
    rawCategory && rawCategory !== 'all'
      ? normalizeCategory(rawCategory)
      : '';

  if (
    rawCategory &&
    rawCategory !== 'all' &&
    !category
  ) {
    throw httpError(
      400,
      'Categoría no permitida.',
      'invalid_category'
    );
  }

  const cacheKey = category || 'all';
  const cached = b2CountCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.time < B2_COUNT_CACHE_TTL_MS
  ) {
    return json(
      {
        ok: true,
        count: cached.count,
        category: cacheKey
      },
      200,
      corsHeaders(origin, env, true)
    );
  }

  let token = '';
  let count = 0;

  do {
    const page = await listObjectsV2(env, {
      prefix: category ? `${category}/` : '',
      maxKeys: 1000,
      continuationToken: token
    });

    count += category ? page.items.length : page.items.filter(item => isCatalogKey(item.key)).length;

    if (
      !page.isTruncated ||
      !page.nextContinuationToken
    ) {
      break;
    }

    token = page.nextContinuationToken;
  } while (count < 1000000);

  b2CountCache.set(cacheKey, {
    count,
    time: Date.now()
  });

  return json(
    {
      ok: true,
      count,
      category: category || 'all'
    },
    200,
    corsHeaders(origin, env, true)
  );
}

async function apiListTestimonialVideos(env, url, origin) {
  const pageSize = clampInt(url.searchParams.get('pageSize') || 200, 1, 200);
  const continuationToken = String(url.searchParams.get('continuationToken') || '');
  const search = String(url.searchParams.get('search') || '').trim().toLowerCase();
  const page = await listObjectsV2(env,{prefix:TESTIMONIAL_VIDEO_PREFIX,maxKeys:Math.min(pageSize,1000),continuationToken});
  let items = page.items.filter(item => /^testimonio_videos\/[^/]+\.(?:webm|mp4)$/i.test(item.key));
  if(search)items=items.filter(item=>`${item.key} ${item.name}`.toLowerCase().includes(search));
  items.sort((a,b)=>String(b.lastModified||'').localeCompare(String(a.lastModified||'')));
  return json({ok:true,items:items.map(item=>{const out=objectToApiItem(env)(item);out.category='testimonio_videos';return out;}),isTruncated:!!page.isTruncated,nextContinuationToken:page.nextContinuationToken||null,count:items.length,pageSize},200,corsHeaders(origin,env,true));
}

async function apiCreateTestimonialVideo(request, env, origin) {
  const form = await request.formData();
  const file = form.get('file');
  const requestedName = String(form.get('name') || '').trim();
  if(!(file instanceof File))throw httpError(400,'Falta el archivo.','file_required');
  // WEBM o MP4 (los celulares graban en MP4). Se valida la firma real del archivo.
  if(Number(file.size||0)>TESTIMONIAL_VIDEO_MAX_BYTES)throw httpError(413,`El video supera el máximo de ${Math.round(TESTIMONIAL_VIDEO_MAX_BYTES/1048576)} MB.`,'too_large');
  const bytes=new Uint8Array(await file.arrayBuffer());
  const isWebm=bytes.length>4 && bytes[0]===0x1A && bytes[1]===0x45 && bytes[2]===0xDF && bytes[3]===0xA3;
  const isMp4=bytes.length>12 && bytes[4]===0x66 && bytes[5]===0x74 && bytes[6]===0x79 && bytes[7]===0x70;
  if(!isWebm && !isMp4)throw httpError(415,'Solo se permiten videos WEBM o MP4.','video_required');
  const ext=isWebm?'webm':'mp4';
  const contentType=isWebm?'video/webm':'video/mp4';
  const base=slug(stripExtension(requestedName||file.name)||'testimonio');
  const key=`${TESTIMONIAL_VIDEO_PREFIX}${base}_${Date.now().toString(36)}.${ext}`;
  await putObject(env,key,bytes,{'Content-Type':contentType,'Cache-Control':'public, max-age=31536000, immutable','x-amz-meta-name':stripExtension(lastSegment(key)),'x-amz-meta-category':'testimonio_videos','x-amz-meta-source':'multiprintt-admin'});
  const version=String(Date.now());
  return json({ok:true,key,name:stripExtension(lastSegment(key)),category:'testimonio_videos',url:publicUrl(env,key,version),version,size:bytes.byteLength,contentType},201,corsHeaders(origin,env,true));
}

async function apiDeleteTestimonialVideo(request, env, ctx, origin) {
  const raw=String(new URL(request.url).searchParams.get('key')||'');
  const key=normalizeObjectKey(raw);
  if(!/^testimonio_videos\/[^/]+\.(?:webm|mp4)$/i.test(key))throw httpError(400,'Solo se pueden eliminar videos de testimonio_videos/.','invalid_key');
  await deleteObject(env,key);
  await purgePublicCache(env,key,ctx);
  return json({ok:true,key},200,corsHeaders(origin,env,true));
}

async function apiCreateFile(request, env, origin) {
  const form = await request.formData();
  const file = form.get('file');
  const name = String(form.get('name') || '').trim();
  const category =
    normalizeCategory(form.get('category') || 'textil') ||
    'textil';

  if (!(file instanceof File)) {
    throw httpError(
      400,
      'Falta el archivo.',
      'file_required'
    );
  }

  if (!ALLOWED_CATEGORIES.has(category)) {
    throw httpError(
      400,
      'Categoría no permitida.',
      'invalid_category'
    );
  }

  validateImageFile(file, true);

  const key = makeKey(
    category,
    name || file.name,
    file.type ||
      mimeFromPath(file.name) ||
      'image/webp'
  );

  const existing = await headObject(env, key);

  if (existing.status === 200) {
    throw httpError(
      409,
      `Ya existe ${key}. Usa reemplazar/PUT si deseas sustituirlo.`,
      'already_exists'
    );
  }

  const bytes = new Uint8Array(
    await file.arrayBuffer()
  );

  const contentType =
    mimeFromPath(key) || 'image/webp';

  await putObject(env, key, bytes, {
    'Content-Type': contentType,
    'Cache-Control':
      'public, max-age=31536000, immutable',
    'x-amz-meta-name':
      stripExtension(lastSegment(key)),
    'x-amz-meta-category': category,
    'x-amz-meta-source': 'multiprintt-admin'
  });

  b2CountCache.clear();

  const version = String(Date.now());

  return json(
    {
      ok: true,
      key,
      name: stripExtension(lastSegment(key)),
      category,
      url: publicUrl(env, key, version),
      version,
      size: bytes.byteLength,
      contentType
    },
    201,
    corsHeaders(origin, env, true)
  );
}

async function apiReplaceFile(request, env, ctx, origin) {
  const form = await request.formData();
  const key = ensureKeyAllowed(
    String(form.get('key') || '')
  );
  const file = form.get('file');

  if (!(file instanceof File)) {
    throw httpError(
      400,
      'Falta el archivo.',
      'file_required'
    );
  }

  validateImageFile(file, true);

  const bytes = new Uint8Array(
    await file.arrayBuffer()
  );

  const contentType =
    mimeFromPath(key) ||
    file.type ||
    'image/webp';

  await putObject(env, key, bytes, {
    'Content-Type': contentType,
    'Cache-Control':
      'public, max-age=31536000, immutable',
    'x-amz-meta-name':
      stripExtension(lastSegment(key)),
    'x-amz-meta-category':
      categoryFromKey(key),
    'x-amz-meta-source': 'multiprintt-admin'
  });

  await purgePublicCache(env, key, ctx);
  b2CountCache.clear();

  const version = String(Date.now());

  return json(
    {
      ok: true,
      key,
      name: stripExtension(lastSegment(key)),
      category: categoryFromKey(key),
      url: publicUrl(env, key, version),
      version,
      size: bytes.byteLength,
      contentType
    },
    200,
    corsHeaders(origin, env, true)
  );
}

async function apiPatchFile(request, env, ctx, origin) {
  const body = await request.json();
  const action = String(
    body?.action || 'rename'
  ).trim().toLowerCase();

  if (
    !['rename', 'category', 'move'].includes(action)
  ) {
    throw httpError(
      400,
      'Acción PATCH no soportada.',
      'invalid_action'
    );
  }

  const currentKey = ensureKeyAllowed(
    String(body?.key || '')
  );

  const category =
    normalizeCategory(
      body?.category ||
        categoryFromKey(currentKey)
    ) ||
    categoryFromKey(currentKey);

  if (!ALLOWED_CATEGORIES.has(category)) {
    throw httpError(
      400,
      'Categoría no permitida.',
      'invalid_category'
    );
  }

  const oldName = stripExtension(
    lastSegment(currentKey)
  );

  const requestedName = String(
    body?.newName || ''
  ).trim();

  const newName = requestedName || oldName;
  const ext =
    extensionFromKey(currentKey) || '.webp';

  const targetKey = makeKey(
    category,
    newName,
    mimeFromPath(ext) || 'image/webp',
    ext
  );

  if (targetKey === currentKey) {
    const version = String(Date.now());

    return json(
      {
        ok: true,
        key: currentKey,
        oldKey: currentKey,
        name: oldName,
        category,
        url: publicUrl(
          env,
          currentKey,
          version
        ),
        version
      },
      200,
      corsHeaders(origin, env, true)
    );
  }

  const sourceHead = await headObject(
    env,
    currentKey
  );

  if (sourceHead.status !== 200) {
    throw httpError(
      404,
      'El archivo original no existe.',
      'not_found'
    );
  }

  const targetHead = await headObject(
    env,
    targetKey
  );

  if (targetHead.status === 200) {
    throw httpError(
      409,
      `Ya existe ${targetKey}.`,
      'already_exists'
    );
  }

  await copyObject(
    env,
    currentKey,
    targetKey
  );

  await deleteObject(
    env,
    currentKey
  );

  await purgePublicCache(
    env,
    currentKey,
    ctx
  );

  b2CountCache.clear();

  const version = String(Date.now());

  return json(
    {
      ok: true,
      key: targetKey,
      oldKey: currentKey,
      name: stripExtension(
        lastSegment(targetKey)
      ),
      category,
      url: publicUrl(
        env,
        targetKey,
        version
      ),
      version,
      size: Number(
        sourceHead.headers.get(
          'content-length'
        ) || 0
      ),
      contentType:
        mimeFromPath(targetKey) ||
        sourceHead.headers.get(
          'content-type'
        ) ||
        'image/webp'
    },
    200,
    corsHeaders(origin, env, true)
  );
}

async function apiDeleteFile(request, env, ctx, origin) {
  const key = ensureKeyAllowed(
    new URL(request.url).searchParams.get(
      'key'
    ) || ''
  );

  await deleteObject(env, key);
  await purgePublicCache(env, key, ctx);
  b2CountCache.clear();

  return json(
    { ok: true, key },
    200,
    corsHeaders(origin, env, true)
  );
}

async function apiDeleteMany(request, env, ctx, origin) {
  const body = await request.json();

  const keys = Array.isArray(body?.keys)
    ? [
        ...new Set(
          body.keys
            .map(v =>
              normalizeObjectKey(
                String(v || '')
              )
            )
            .filter(Boolean)
        )
      ].slice(0, MAX_BULK_DELETE)
    : [];

  if (!keys.length) {
    throw httpError(
      400,
      'No hay archivos para eliminar.',
      'keys_required'
    );
  }

  keys.forEach(ensureKeyAllowed);

  const results = [];

  for (const key of keys) {
    try {
      await deleteObject(env, key);
      await purgePublicCache(env, key, ctx);
      b2CountCache.clear();

      results.push({
        key,
        ok: true
      });
    } catch (error) {
      results.push({
        key,
        ok: false,
        error: error?.message || 'Error'
      });
    }
  }

  return json(
    {
      ok: results.every(x => x.ok),
      results
    },
    200,
    corsHeaders(origin, env, true)
  );
}

async function apiMigrate(request, env, origin) {
  const body = await request.json();

  const sourceUrl = String(
    body?.sourceUrl || ''
  ).trim();

  const category =
    normalizeCategory(
      body?.category || 'textil'
    ) || 'textil';

  const requestedName = String(
    body?.name || ''
  ).trim();

  if (
    !/^https:\/\/i\.ibb\.co\//i.test(
      sourceUrl
    )
  ) {
    throw httpError(
      400,
      'La migración solo acepta URLs directas de i.ibb.co.',
      'invalid_source'
    );
  }

  if (!ALLOWED_CATEGORIES.has(category)) {
    throw httpError(
      400,
      'Categoría no permitida.',
      'invalid_category'
    );
  }

  const src = new URL(sourceUrl);

  if (
    src.protocol !== 'https:' ||
    src.hostname !== 'i.ibb.co'
  ) {
    throw httpError(
      400,
      'Origen ImgBB no permitido.',
      'invalid_source'
    );
  }

  const upstream = await fetch(
    src.toString(),
    {
      method: 'GET',
      redirect: 'follow'
    }
  );

  if (!upstream.ok) {
    throw httpError(
      502,
      `ImgBB respondió HTTP ${upstream.status}.`,
      'source_fetch_failed'
    );
  }

  try {
    const finalHost = new URL(
      upstream.url
    ).hostname;

    if (finalHost !== 'i.ibb.co') {
      throw httpError(
        502,
        'La fuente ImgBB redirigió a un host no permitido.',
        'source_redirect'
      );
    }
  } catch (error) {
    if (error?.status) {
      throw error;
    }
  }

  const declaredLength = Number(
    upstream.headers.get(
      'content-length'
    ) || 0
  );

  if (declaredLength > MAX_FILE_BYTES) {
    throw httpError(
      413,
      'La imagen supera el límite de 10 MB.',
      'too_large'
    );
  }

  const raw = new Uint8Array(
    await upstream.arrayBuffer()
  );

  if (raw.byteLength > MAX_FILE_BYTES) {
    throw httpError(
      413,
      'La imagen supera el límite de 10 MB.',
      'too_large'
    );
  }

  const sourceMime =
    mimeFromPath(src.pathname) ||
    normalizeImageMime(
      upstream.headers.get(
        'content-type'
      )
    );

  if (!/^image\//i.test(sourceMime || '')) {
    throw httpError(
      415,
      'ImgBB no devolvió un contenido de imagen compatible.',
      'not_image'
    );
  }

  const key = makeKey(
    category,
    requestedName ||
      b2NameFromUrl(src.pathname),
    sourceMime
  );

  const existing = await headObject(
    env,
    key
  );

  if (existing.status === 200) {
    const version = String(Date.now());

    return json(
      {
        ok: true,
        existed: true,
        key,
        name: stripExtension(
          lastSegment(key)
        ),
        category,
        url: publicUrl(
          env,
          key,
          version
        ),
        version,
        size:
          Number(
            existing.headers.get(
              'content-length'
            ) || raw.byteLength
          ),
        contentType: sourceMime,
        sourceUrl
      },
      200,
      corsHeaders(origin, env, true)
    );
  }

  await putObject(
    env,
    key,
    raw,
    {
      'Content-Type': sourceMime,
      'Cache-Control':
        'public, max-age=31536000, immutable',
      'x-amz-meta-name':
        stripExtension(
          lastSegment(key)
        ),
      'x-amz-meta-category':
        category,
      'x-amz-meta-source':
        'imgbb-migration'
    }
  );

  b2CountCache.clear();

  const version = String(Date.now());

  return json(
    {
      ok: true,
      existed: false,
      key,
      name: stripExtension(
        lastSegment(key)
      ),
      category,
      url: publicUrl(
        env,
        key,
        version
      ),
      version,
      size: raw.byteLength,
      contentType: sourceMime,
      sourceUrl
    },
    201,
    corsHeaders(origin, env, true)
  );
}


const EXTERNAL_MIGRATION_MAX_BYTES = 60 * 1024 * 1024;
const GITHUB_MIGRATION_PREFIX = '/kelvinthegamerc1-lab/multiprintt/refs/heads/main/recursos/';
const CLOUDINARY_MIGRATION_HOST = 'res.cloudinary.com';
const CLOUDINARY_MIGRATION_CLOUD = 'lxopsutw';

function externalMigrationSource(sourceUrl) {
  const raw = String(sourceUrl || '').trim();
  if (!/^https:\/\//i.test(raw)) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }

  if (u.hostname === 'raw.githubusercontent.com' && u.pathname.startsWith(GITHUB_MIGRATION_PREFIX)) {
    return { kind: 'github', url: u };
  }
  if (u.hostname === CLOUDINARY_MIGRATION_HOST && u.pathname.startsWith(`/${CLOUDINARY_MIGRATION_CLOUD}/`)) {
    return { kind: 'cloudinary', url: u };
  }
  return null;
}

function externalMigrationKey(sourceUrl, requestedKey = '') {
  const src = externalMigrationSource(sourceUrl);
  if (!src) throw httpError(400, 'Fuente externa no autorizada para migración.', 'invalid_source');

  const supplied = normalizeObjectKey(requestedKey);
  if (supplied) {
    if (!isSafeObjectKey(supplied) || !supplied.startsWith('media/migrated/')) {
      throw httpError(400, 'La ruta destino de migración no es válida.', 'invalid_target');
    }
    return supplied;
  }

  const path = decodeURIComponentSafe(src.url.pathname).replace(/^\/+/, '');
  if (src.kind === 'github') {
    const rest = path.slice(GITHUB_MIGRATION_PREFIX.replace(/^\/+/, '').length).replace(/^\/+/, '');
    const clean = normalizeObjectKey(rest);
    if (!clean) throw httpError(400, 'El archivo GitHub no tiene una ruta válida.', 'invalid_source_path');
    if (clean === 'logo_mejorado.webp' || clean === 'logo_mejorado.png') return `media/migrated/site/${clean}`;
    if (clean === 'favicon.webp' || clean === 'favicon.png') return `media/migrated/site/${clean}`;
    if (/^testimonio\//i.test(clean) && /\.(?:mp4|webm|m4v|mov)$/i.test(clean)) {
      return `media/migrated/testimonios/${lastSegment(clean)}`;
    }
    if (/^productos\//i.test(clean)) return `media/migrated/productos/${clean.slice('productos/'.length)}`;
    if (/\.json$/i.test(clean)) return `media/migrated/manifests/${lastSegment(clean)}`;
    return `media/migrated/github/${clean}`;
  }

  const segments = path.split('/').filter(Boolean);
  const uploadIndex = Math.max(0, segments.findIndex(x => /^upload$/i.test(x)));
  let asset = segments.slice(uploadIndex + 1).filter(part => !/^v\d+$/i.test(part));
  if (!asset.length) asset = [lastSegment(path) || 'cloudinary_asset'];
  const safeParts = asset.map((part,i)=>{
    const decoded=decodeURIComponentSafe(part);
    if(i===asset.length-1){const ext=extensionFromKey(decoded);return `${slug(stripExtension(decoded))}${ext||''}`;}
    return slug(decoded);
  });
  return `media/migrated/cloudinary/${src.url.pathname.split('/').filter(Boolean)[1] || 'asset'}/${safeParts.join('/')}`;
}

async function apiMigrateExternal(request, env, origin) {
  let body;
  try { body = await request.json(); }
  catch { throw httpError(400, 'JSON de migración inválido.', 'invalid_json'); }

  const sourceUrl = String(body?.sourceUrl || '').trim();
  const src = externalMigrationSource(sourceUrl);
  if (!src) {
    throw httpError(400, 'Solo se permiten recursos históricos de GitHub Raw o Cloudinary autorizado.', 'invalid_source');
  }

  const key = externalMigrationKey(sourceUrl, body?.targetKey || '');
  const existing = await headObject(env, key);
  if (existing.status === 200) {
    const contentLength = Number(existing.headers.get('content-length') || 0);
    const version = String(Date.now());
    return json({
      ok: true,
      existed: true,
      skipped: true,
      kind: src.kind,
      sourceUrl,
      key,
      url: publicUrl(env, key, version),
      size: contentLength,
      contentType: mimeFromPath(key) || existing.headers.get('content-type') || 'application/octet-stream'
    }, 200, corsHeaders(origin, env, true));
  }

  const upstream = await fetch(src.url.toString(), {
    method: 'GET',
    redirect: 'follow',
    headers: { 'Accept': '*/*' }
  });

  if (!upstream.ok) {
    throw httpError(502, `${src.kind === 'github' ? 'GitHub' : 'Cloudinary'} respondió HTTP ${upstream.status}.`, 'source_fetch_failed');
  }

  let finalUrl;
  try { finalUrl = new URL(upstream.url); } catch { finalUrl = src.url; }
  const validFinal = src.kind === 'github'
    ? finalUrl.hostname === 'raw.githubusercontent.com' && finalUrl.pathname.startsWith(GITHUB_MIGRATION_PREFIX)
    : finalUrl.hostname === CLOUDINARY_MIGRATION_HOST && finalUrl.pathname.startsWith(`/${CLOUDINARY_MIGRATION_CLOUD}/`);
  if (!validFinal) throw httpError(502, 'La fuente externa redirigió a un host no autorizado.', 'source_redirect');

  const declaredLength = Number(upstream.headers.get('content-length') || 0);
  if (declaredLength > EXTERNAL_MIGRATION_MAX_BYTES) {
    throw httpError(413, 'El archivo externo supera el límite de 60 MB para migración.', 'too_large');
  }

  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength > EXTERNAL_MIGRATION_MAX_BYTES) {
    throw httpError(413, 'El archivo externo supera el límite de 60 MB para migración.', 'too_large');
  }

  const contentType = mimeFromPath(key) || String(upstream.headers.get('content-type') || '').split(';')[0].trim() || 'application/octet-stream';

  await putObject(env, key, bytes, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'x-amz-meta-name': stripExtension(lastSegment(key)),
    'x-amz-meta-category': 'migrated',
    'x-amz-meta-source': src.kind,
    'x-amz-meta-source-url': sourceUrl.slice(0, 1000)
  });

  b2CountCache.clear();
  const version = String(Date.now());
  return json({
    ok: true,
    existed: false,
    skipped: false,
    kind: src.kind,
    sourceUrl,
    key,
    url: publicUrl(env, key, version),
    size: bytes.byteLength,
    contentType
  }, 201, corsHeaders(origin, env, true));
}


// Caché pública: una entrada por objeto (ruta + ?v opcional). Otros parámetros
// de la URL se ignoran: no se reenvían a B2 (evita exponer subrecursos S3 como
// ?versionId / ?versions) ni generan entradas nuevas de caché (cache-busting).
const PUBLIC_CACHE_VERSIONED = 'public, max-age=31536000, immutable';
const PUBLIC_CACHE_DEFAULT = 'public, max-age=86400, stale-while-revalidate=604800';
const PUBLIC_CACHE_MISSING = 'public, max-age=60';
const RANGE_PREFILL_MAX_BYTES = 80 * 1024 * 1024;
const THUMB_PREFIX = 'media/thumbs/';
const STRIP_UPSTREAM_HEADER = /^(x-amz-|x-bz-|server$|set-cookie$)/i;

function publicCacheKey(url, key) {
  const v = url.searchParams.get('v') || '';
  return new Request(
    `${url.origin}/${encodePathForUrl(key)}${v ? `?v=${encodeURIComponent(v)}` : ''}`,
    { method: 'GET' }
  );
}

function publicMissingResponse(status = 404) {
  return new Response(status === 404 ? 'Not Found' : 'Upstream Error', {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': status === 404 ? PUBLIC_CACHE_MISSING : 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin'
    }
  });
}

async function fetchPublicFromB2(env, method, key, range = '') {
  const targetUrl = b2ObjectUrl(env, key);
  const upstreamHeaders = new Headers();
  if (range) upstreamHeaders.set('Range', range);
  const signed = await signedRequest(env, method, targetUrl, {
    headers: upstreamHeaders,
    payloadHash: EMPTY_SHA256
  });
  return fetch(targetUrl, { method, headers: signed.headers });
}

function decoratePublicResponse(upstream, key, versioned) {
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!STRIP_UPSTREAM_HEADER.test(name)) headers.set(name, value);
  }
  headers.set('Content-Type', mimeFromPath(key) || upstream.headers.get('Content-Type') || 'application/octet-stream');
  headers.set('Cache-Control', versioned ? PUBLIC_CACHE_VERSIONED : PUBLIC_CACHE_DEFAULT);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Timing-Allow-Origin', '*');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

async function proxyPublicObject(request, env, ctx, url) {
  const key = normalizeObjectKey(decodeURIComponentSafe(url.pathname).replace(/^\/+/, ''));

  const isTestimonialVideo = key.startsWith(TESTIMONIAL_VIDEO_PREFIX) && /\.(?:webm|mp4)$/i.test(key);
  const isPublicMedia = key.startsWith('media/') && isSafeObjectKey(key);
  if (
    !key ||
    !isSafeObjectKey(key) ||
    (!ALLOWED_CATEGORIES.has(categoryFromKey(key)) && !isTestimonialVideo && !isPublicMedia)
  ) {
    return publicMissingResponse(404);
  }

  const versioned = url.searchParams.has('v');
  const range = request.headers.get('Range') || '';
  const cache = caches.default;
  const cacheKey = publicCacheKey(url, key);

  // 1) Caché del edge. Con Range, Cloudflare responde 206 desde el objeto completo guardado.
  const lookup = range ? new Request(cacheKey.url, { method: 'GET', headers: { Range: range } }) : cacheKey;
  const cached = await cache.match(lookup);
  if (cached) {
    if (request.method === 'HEAD') {
      return new Response(null, { status: cached.status, headers: cached.headers });
    }
    return cached;
  }

  // 2) B2 (bucket privado, petición firmada). Nunca se reenvía url.search.
  let upstream = await fetchPublicFromB2(env, request.method, key, range);

  // Miniaturas (media/thumbs/<original>.webp): si aún no se generó, se sirve el
  // original con caché corta para que la página nunca vea un 404.
  if ((upstream.status === 404 || upstream.status === 403) && key.startsWith(THUMB_PREFIX)) {
    const originalKey = key.slice(THUMB_PREFIX.length).replace(/\.webp$/i, '');
    if (originalKey && isSafeObjectKey(originalKey)) {
      const original = await fetchPublicFromB2(env, request.method, originalKey, range);
      if (original.status === 200 || original.status === 206) {
        const res = decoratePublicResponse(original, originalKey, false);
        res.headers.set('Cache-Control', 'public, max-age=300');
        return res;
      }
    }
  }

  if (upstream.status !== 200 && upstream.status !== 206) {
    // No reenviar el XML/cabeceras de error de B2 al público.
    if (upstream.status === 416) {
      return new Response(null, { status: 416, headers: { 'Content-Range': upstream.headers.get('Content-Range') || '', 'Access-Control-Allow-Origin': '*' } });
    }
    const missing = upstream.status === 404 || upstream.status === 403;
    if (!missing) console.warn('B2 público respondió', upstream.status, key);
    return publicMissingResponse(missing ? 404 : 502);
  }

  const response = decoratePublicResponse(upstream, key, versioned);

  if (request.method === 'GET' && !range && upstream.status === 200) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {}));
  } else if (request.method === 'GET' && range && upstream.status === 206) {
    // Primera petición con Range (vídeos): se guarda el objeto completo en segundo plano
    // para que los siguientes rangos salgan del edge sin tocar B2.
    const total = Number((upstream.headers.get('Content-Range') || '').split('/')[1]) || 0;
    if (total > 0 && total <= RANGE_PREFILL_MAX_BYTES) {
      ctx.waitUntil((async () => {
        const full = await fetchPublicFromB2(env, 'GET', key);
        if (full.status === 200) await cache.put(cacheKey, decoratePublicResponse(full, key, versioned));
      })().catch(() => {}));
    }
  }

  return response;
}


async function listObjectsV2(
  env,
  {
    prefix = '',
    maxKeys = DEFAULT_PAGE_SIZE,
    continuationToken = '',
    startAfter = ''
  } = {}
) {
  const params =
    new URLSearchParams();

  params.set(
    'list-type',
    '2'
  );

  params.set(
    'max-keys',
    String(
      clampInt(
        maxKeys,
        1,
        1000
      )
    )
  );

  if (prefix) {
    params.set(
      'prefix',
      prefix
    );
  }

  if (continuationToken) {
    params.set(
      'continuation-token',
      continuationToken
    );
  }

  if (startAfter && !continuationToken) {
    params.set('start-after', startAfter);
  }

  const targetUrl =
    `${b2BucketUrl(env)}?` +
    canonicalQueryString(params);

  const signed =
    await signedRequest(
      env,
      'GET',
      targetUrl,
      {
        payloadHash:
          EMPTY_SHA256
      }
    );

  const response =
    await fetch(
      targetUrl,
      {
        method: 'GET',
        headers:
          signed.headers
      }
    );

  if (!response.ok) {
    throw await b2Error(
      response,
      'No se pudo listar el bucket B2.'
    );
  }

  return parseListXml(
    await response.text()
  );
}

async function searchObjects(
  env,
  term,
  category,
  maxObjects
) {
  const matches = [];
  let token = '';
  let scanned = 0;

  while (
    scanned < maxObjects
  ) {
    const page =
      await listObjectsV2(
        env,
        {
          prefix: category
            ? `${category}/`
            : '',
          maxKeys:
            Math.min(
              1000,
              maxObjects -
                scanned
            ),
          continuationToken:
            token
        }
      );

    scanned +=
      page.items.length;

    for (
      const item of page.items
    ) {
if (!category && !isCatalogKey(item.key)) continue;
            const haystack =
        `${item.key} ${item.name} ${item.category}`
          .toLowerCase();

      if (
        haystack.includes(term)
      ) {
        matches.push(
          objectToApiItem(env)(
            item
          )
        );
      }

      if (
        matches.length >= 500
      ) {
        return matches;
      }
    }

    if (
      !page.isTruncated ||
      !page.nextContinuationToken
    ) {
      break;
    }

    token =
      page.nextContinuationToken;
  }

  return matches;
}

async function putObject(
  env,
  key,
  bytes,
  extraHeaders = {}
) {
  const body =
    bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes);

  const headers =
    new Headers(extraHeaders);

  const payloadHash =
    await sha256HexBytes(body);

  const targetUrl =
    b2ObjectUrl(
      env,
      key,
      ''
    );

  const signed =
    await signedRequest(
      env,
      'PUT',
      targetUrl,
      {
        headers,
        payloadHash
      }
    );

  const response =
    await fetch(
      targetUrl,
      {
        method: 'PUT',
        headers:
          signed.headers,
        body
      }
    );

  if (!response.ok) {
    throw await b2Error(
      response,
      `No se pudo subir ${key}.`
    );
  }

  return response;
}

async function copyObject(
  env,
  sourceKey,
  targetKey
) {
  const headers =
    new Headers({
      'x-amz-copy-source':
        `/${env.BUCKET_NAME}/${awsEncodePath(sourceKey)}`
    });

  const targetUrl =
    b2ObjectUrl(
      env,
      targetKey,
      ''
    );

  const signed =
    await signedRequest(
      env,
      'PUT',
      targetUrl,
      {
        headers,
        payloadHash:
          EMPTY_SHA256
      }
    );

  const response =
    await fetch(
      targetUrl,
      {
        method: 'PUT',
        headers:
          signed.headers
      }
    );

  if (!response.ok) {
    throw await b2Error(
      response,
      `No se pudo copiar ${sourceKey}.`
    );
  }

  return response;
}

async function deleteObject(
  env,
  key
) {
  const targetUrl =
    b2ObjectUrl(
      env,
      key,
      ''
    );

  const signed =
    await signedRequest(
      env,
      'DELETE',
      targetUrl,
      {
        payloadHash:
          EMPTY_SHA256
      }
    );

  const response =
    await fetch(
      targetUrl,
      {
        method: 'DELETE',
        headers:
          signed.headers
      }
    );

  if (
    !response.ok &&
    response.status !== 404
  ) {
    throw await b2Error(
      response,
      `No se pudo eliminar ${key}.`
    );
  }

  return response;
}

async function headObject(
  env,
  key
) {
  const targetUrl =
    b2ObjectUrl(
      env,
      key,
      ''
    );

  const signed =
    await signedRequest(
      env,
      'HEAD',
      targetUrl,
      {
        payloadHash:
          EMPTY_SHA256
      }
    );

  return fetch(
    targetUrl,
    {
      method: 'HEAD',
      headers:
        signed.headers
    }
  );
}

async function purgePublicCache(env, key, ctx) {
  try {
    // Las entradas de caché se guardan por ruta (+ ?v). Se purga la ruta sin versión;
    // las URLs versionadas cambian de ?v al reemplazar, así que no quedan obsoletas.
    // Nota: caches.default es por centro de datos; otros PoP expiran por max-age.
    const promise = caches.default.delete(new Request(publicUrl(env, key), { method: 'GET' }));
    if (ctx?.waitUntil) ctx.waitUntil(promise);
    else await promise;
  } catch (error) {
    console.warn('No se pudo purgar la caché:', error);
  }
}


function parseListXml(xml) {
  const items = [];

  for (
    const match of String(
      xml || ''
    ).matchAll(
      /<Contents>([\s\S]*?)<\/Contents>/gi
    )
  ) {
    const block =
      match[1];

    const key =
      xmlUnescape(
        textTag(
          block,
          'Key'
        )
      );

    if (!key) {
      continue;
    }

    const size =
      Number(
        textTag(
          block,
          'Size'
        )
      ) || 0;

    const lastModified =
      textTag(
        block,
        'LastModified'
      );

    const etag =
      xmlUnescape(
        textTag(
          block,
          'ETag'
        )
      ).replace(
        /^"|"$/g,
        ''
      );

    items.push({
      key,
      name:
        stripExtension(
          lastSegment(key)
        ),
      category:
        categoryFromKey(key),
      size,
      lastModified,
      etag,
      contentType:
        mimeFromPath(key) ||
        'application/octet-stream'
    });
  }

  return {
    items,
    isTruncated:
      /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(
        xml
      ),
    nextContinuationToken:
      xmlUnescape(
        textTag(
          xml,
          'NextContinuationToken'
        )
      ) || null
  };
}

function objectToApiItem(env) {
  return item => {
    const version =
      item.lastModified ||
      item.etag ||
      '';

    return {
      id: item.key,
      key: item.key,
      name:
        item.name ||
        stripExtension(
          lastSegment(item.key)
        ),
      category:
        item.category ||
        categoryFromKey(item.key),
      url:
        publicUrl(
          env,
          item.key,
          version
        ),
      version,
      size:
        item.size || 0,
      width: 0,
      height: 0,
      contentType:
        item.contentType ||
        mimeFromPath(
          item.key
        ) ||
        'application/octet-stream',
      lastModified:
        item.lastModified ||
        '',
      etag:
        item.etag ||
        '',
      source:
        'b2'
    };
  };
}

async function requireAdmin(
  request,
  env
) {
  const authorization =
    request.headers.get(
      'Authorization'
    ) || '';

  const tokenMatch =
    authorization.match(
      /^Bearer\s+(.+)$/i
    );

  if (!tokenMatch) {
    throw httpError(
      401,
      'Se requiere una sesión administrativa.',
      'auth_required'
    );
  }

  const payload =
    await verifyFirebaseIdToken(
      tokenMatch[1].trim(),
      String(
        env.FIREBASE_PROJECT_ID ||
          ''
      )
    );

  if (
    payload?.firebase
      ?.sign_in_provider !==
    'password'
  ) {
    throw httpError(
      403,
      'Solo la autenticación Email/Password puede administrar medios.',
      'admin_provider_forbidden'
    );
  }

  // Lista blanca de administradores. Sin ella, CUALQUIER cuenta Email/Password del
  // proyecto Firebase podría subir/borrar archivos. Configurar en Cloudflare:
  //   ADMIN_EMAILS = correo1@dominio.com,correo2@dominio.com   (y/o ADMIN_UIDS = uid1,uid2)
  const adminEmails = String(env.ADMIN_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const adminUids = String(env.ADMIN_UIDS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (adminEmails.length || adminUids.length) {
    const email = String(payload.email || '').toLowerCase();
    // No se exige email_verified: el registro público está cerrado y la cuenta admin
    // puede no tener el correo verificado (Firebase envía email_verified=false).
    const emailOk = Boolean(email) && adminEmails.includes(email);
    const uidOk = adminUids.includes(String(payload.sub || payload.user_id || ''));
    if (!emailOk && !uidOk) {
      throw httpError(403, 'Esta cuenta no tiene permisos de administración.', 'admin_not_allowed');
    }
  } else {
    console.warn('ADMIN_EMAILS/ADMIN_UIDS no configurado: cualquier usuario Email/Password puede usar la API.');
  }


  return payload;
}

async function verifyFirebaseIdToken(
  token,
  projectId
) {
  if (!projectId) {
    throw httpError(
      500,
      'Falta FIREBASE_PROJECT_ID en el Worker.',
      'firebase_config'
    );
  }

  const parts =
    String(token).split('.');

  if (
    parts.length !== 3
  ) {
    throw httpError(
      401,
      'Token Firebase inválido.',
      'invalid_token'
    );
  }

  const [
    encodedHeader,
    encodedPayload,
    encodedSignature
  ] = parts;

  const header =
    parseB64Json(
      encodedHeader
    );

  const payload =
    parseB64Json(
      encodedPayload
    );

  if (
    header.alg !== 'RS256' ||
    !header.kid
  ) {
    throw httpError(
      401,
      'Token Firebase no permitido.',
      'invalid_token'
    );
  }

  const now =
    Math.floor(
      Date.now() / 1000
    );

  if (
    payload.aud !== projectId
  ) {
    throw httpError(
      401,
      'Token emitido para otro proyecto.',
      'invalid_token'
    );
  }

  if (
    payload.iss !==
    `https://securetoken.google.com/${projectId}`
  ) {
    throw httpError(
      401,
      'Emisor de token inválido.',
      'invalid_token'
    );
  }

  if (
    !payload.sub ||
    typeof payload.sub !==
      'string'
  ) {
    throw httpError(
      401,
      'Token sin sujeto válido.',
      'invalid_token'
    );
  }

  if (
    !Number.isFinite(
      Number(payload.exp)
    ) ||
    Number(payload.exp) <=
      now
  ) {
    throw httpError(
      401,
      'Token expirado.',
      'token_expired'
    );
  }

  if (
    Number.isFinite(
      Number(payload.iat)
    ) &&
    Number(payload.iat) >
      now + 300
  ) {
    throw httpError(
      401,
      'Token emitido en el futuro.',
      'invalid_token'
    );
  }

  let jwks =
    await getFirebaseJwks(
      false
    );

  let jwk =
    jwks.find(
      k =>
        k.kid ===
        header.kid
    );

  if (!jwk) {
    jwks =
      await getFirebaseJwks(
        true
      );

    jwk =
      jwks.find(
        k =>
          k.kid ===
          header.kid
      );
  }

  if (!jwk) {
    throw httpError(
      401,
      'Clave pública de Firebase no encontrada.',
      'invalid_token'
    );
  }

  const publicKey =
    await crypto.subtle.importKey(
      'jwk',
      jwk,
      {
        name:
          'RSASSA-PKCS1-v1_5',
        hash:
          'SHA-256'
      },
      false,
      ['verify']
    );

  const valid =
    await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      base64UrlToBytes(
        encodedSignature
      ),
      new TextEncoder().encode(
        `${encodedHeader}.${encodedPayload}`
      )
    );

  if (!valid) {
    throw httpError(
      401,
      'Firma de Firebase inválida.',
      'invalid_token'
    );
  }

  return payload;
}

async function getFirebaseJwks(
  force = false
) {
  if (
    !force &&
    firebaseJwksCache &&
    Date.now() <
      firebaseJwksExpiresAt
  ) {
    return firebaseJwksCache;
  }

  const response =
    await fetch(
      FIREBASE_JWKS_URL,
      {
        headers: {
          Accept:
            'application/json'
        }
      }
    );

  if (!response.ok) {
    throw httpError(
      503,
      'No se pudieron obtener las claves públicas de Firebase.',
      'jwks_unavailable'
    );
  }

  const data =
    await response.json();

  firebaseJwksCache =
    Array.isArray(
      data?.keys
    )
      ? data.keys
      : [];

  const maxAge =
    parseMaxAge(
      response.headers.get(
        'cache-control'
      )
    ) || 3600;

  firebaseJwksExpiresAt =
    Date.now() +
    Math.min(
      maxAge,
      21600
    ) *
      1000;

  return firebaseJwksCache;
}

async function signedRequest(
  env,
  method,
  targetUrl,
  {
    headers = {},
    payloadHash =
      EMPTY_SHA256
  } = {}
) {
  const url =
    new URL(targetUrl);

  const host =
    url.host;

  const region =
    regionFromEndpoint(
      env.B2_ENDPOINT
    );

  const now =
    new Date();

  const amzDate =
    now.toISOString().replace(
      /[:-]|\.\d{3}/g,
      ''
    );

  const dateStamp =
    amzDate.slice(
      0,
      8
    );

  const input =
    new Headers(
      headers
    );

  input.delete(
    'authorization'
  );

  input.delete(
    'host'
  );

  input.set(
    'host',
    host
  );

  input.set(
    'x-amz-content-sha256',
    payloadHash
  );

  input.set(
    'x-amz-date',
    amzDate
  );

  const canonicalHeaders =
    [
      ...input.entries()
    ]
      .map(
        ([key, value]) => [
          key
            .toLowerCase()
            .trim(),
          String(value)
            .trim()
            .replace(
              /\s+/g,
              ' '
            )
        ]
      )
      .sort(
        (a, b) =>
          a[0].localeCompare(
            b[0]
          )
      );

  const canonicalHeaderText =
    canonicalHeaders
      .map(
        ([key, value]) =>
          `${key}:${value}\n`
      )
      .join('');

  const signedHeaderText =
    canonicalHeaders
      .map(
        ([key]) =>
          key
      )
      .join(';');

  const canonicalRequest =
    [
      method.toUpperCase(),
      awsEncodePath(
        url.pathname
      ),
      canonicalQueryString(
        url.searchParams
      ),
      canonicalHeaderText,
      signedHeaderText,
      payloadHash
    ].join('\n');

  const scope =
    `${dateStamp}/${region}/s3/aws4_request`;

  const canonicalHash =
    await sha256Hex(
      canonicalRequest
    );

  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${canonicalHash}`;

  const kDate =
    await hmacSha256(
      new TextEncoder().encode(
        `AWS4${env.B2_APPLICATION_KEY}`
      ),
      dateStamp
    );

  const kRegion =
    await hmacSha256(
      kDate,
      region
    );

  const kService =
    await hmacSha256(
      kRegion,
      's3'
    );

  const kSigning =
    await hmacSha256(
      kService,
      'aws4_request'
    );

  const signature =
    bufferToHex(
      await hmacSha256(
        kSigning,
        stringToSign
      )
    );

  input.set(
    'Authorization',
    `AWS4-HMAC-SHA256 Credential=${env.B2_KEY_ID}/${scope}, SignedHeaders=${signedHeaderText}, Signature=${signature}`
  );

  return {
    headers: input
  };
}

function b2BucketUrl(env) {
  return `https://${env.BUCKET_NAME}.${env.B2_ENDPOINT}`;
}

function b2ObjectUrl(
  env,
  key,
  search = ''
) {
  return `${b2BucketUrl(env)}/${awsEncodePath(key)}${search || ''}`;
}

function publicUrl(
  env,
  key,
  version = ''
) {
  const base =
    String(
      env.PUBLIC_BASE_URL ||
        ''
    ).replace(
      /\/$/,
      ''
    );

  return `${base}/${encodePathForUrl(key)}${
    version
      ? `?v=${encodeURIComponent(version)}`
      : ''
  }`;
}

function encodePathForUrl(
  key
) {
  return String(
    key || ''
  )
    .split('/')
    .map(
      encodeURIComponent
    )
    .join('/');
}

function awsEncodePath(
  pathname
) {
  return String(
    pathname || '/'
  )
    .split('/')
    .map(part =>
      awsEncode(
        decodeURIComponentSafe(
          part
        )
      )
    )
    .join('/');
}

function canonicalQueryString(
  params
) {
  return [
    ...params.entries()
  ]
    .sort(
      (a, b) =>
        a[0] === b[0]
          ? a[1].localeCompare(
              b[1]
            )
          : a[0].localeCompare(
              b[0]
            )
    )
    .map(
      ([k, v]) =>
        `${awsEncode(k)}=${awsEncode(v)}`
    )
    .join('&');
}

function awsEncode(value) {
  return encodeURIComponent(
    String(value)
  ).replace(
    /[!'()*]/g,
    c =>
      `%${c
        .charCodeAt(0)
        .toString(16)
        .toUpperCase()}`
  );
}

async function sha256Hex(
  value
) {
  return bufferToHex(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        String(value)
      )
    )
  );
}

async function sha256HexBytes(
  bytes
) {
  return bufferToHex(
    await crypto.subtle.digest(
      'SHA-256',
      bytes
    )
  );
}

async function hmacSha256(
  key,
  data
) {
  const rawKey =
    key instanceof Uint8Array
      ? key
      : key instanceof ArrayBuffer
        ? new Uint8Array(key)
        : new TextEncoder().encode(
            String(key)
          );

  const cryptoKey =
    await crypto.subtle.importKey(
      'raw',
      rawKey,
      {
        name:
          'HMAC',
        hash:
          'SHA-256'
      },
      false,
      ['sign']
    );

  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      new TextEncoder().encode(
        String(data)
      )
    )
  );
}

function bufferToHex(
  buffer
) {
  return Array.from(
    new Uint8Array(
      buffer
    )
  )
    .map(
      b =>
        b
          .toString(16)
          .padStart(
            2,
            '0'
          )
    )
    .join('');
}

function base64UrlToBytes(
  value
) {
  const raw =
    String(value)
      .replace(
        /-/g,
        '+'
      )
      .replace(
        /_/g,
        '/'
      );

  const padded =
    raw +
    '='.repeat(
      (4 -
        (raw.length % 4)) %
        4
    );

  const binary =
    atob(padded);

  return Uint8Array.from(
    binary,
    c =>
      c.charCodeAt(0)
  );
}

function parseB64Json(
  value
) {
  try {
    return JSON.parse(
      new TextDecoder().decode(
        base64UrlToBytes(
          value
        )
      )
    );
  } catch {
    throw httpError(
      401,
      'Token Firebase inválido.',
      'invalid_token'
    );
  }
}

function parseMaxAge(
  value
) {
  const m = String(
    value || ''
  ).match(
    /max-age=(\d+)/i
  );

  return m
    ? Number(m[1])
    : 0;
}

function decodeURIComponentSafe(
  v
) {
  try {
    return decodeURIComponent(
      v
    );
  } catch {
    return v;
  }
}

function normalizeCategory(
  value
) {
  const c =
    String(
      value || ''
    )
      .trim()
      .toLowerCase();

  return ALLOWED_CATEGORIES.has(
    c
  )
    ? c
    : '';
}

function categoryFromKey(
  key
) {
  const c =
    String(
      key || ''
    )
      .split('/')[0]
      .toLowerCase();

  return ALLOWED_CATEGORIES.has(
    c
  )
    ? c
    : 'otros';
}

function ensureKeyAllowed(
  key
) {
  const clean =
    normalizeObjectKey(
      key
    );

  if (
    !clean ||
    !ALLOWED_CATEGORIES.has(
      categoryFromKey(
        clean
      )
    )
  ) {
    throw httpError(
      400,
      'Ruta de archivo no permitida.',
      'invalid_key'
    );
  }

  return clean;
}

function normalizeObjectKey(
  key
) {
  return String(
    key || ''
  )
    .replace(
      /^\/+/,
      ''
    )
    .split('/')
    .filter(Boolean)
    .join('/');
}

function isSafeObjectKey(
  key
) {
  const parts =
    String(
      key || ''
    ).split('/');

  return (
    !!parts.length &&
    !parts.some(
      part =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.includes('\\')
    )
  );
}

function lastSegment(
  key
) {
  const parts =
    String(
      key || ''
    ).split('/');

  return (
    parts[
      parts.length - 1
    ] || ''
  );
}

function extensionFromKey(
  key
) {
  const m =
    lastSegment(
      key
    ).match(
      /\.[a-z0-9]+$/i
    );

  return m
    ? m[0].toLowerCase()
    : '';
}

function stripExtension(
  name
) {
  return String(
    name || ''
  ).replace(
    /\.[a-z0-9]{2,7}$/i,
    ''
  );
}

function slug(
  value
) {
  return String(
    value || ''
  )
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    )
    .toLowerCase()
    .trim()
    .replace(
      /[^a-z0-9_-]+/g,
      '_'
    )
    .replace(
      /^_+|_+$/g,
      ''
    )
    .slice(
      0,
      80
    ) || 'imagen';
}

function ensureProductPrefix(
  name
) {
  const n =
    slug(
      stripExtension(
        name
      )
    );

  return n.startsWith(
    'producto_'
  )
    ? n
    : `producto_${n}`;
}

function makeKey(
  category,
  name,
  mime = 'image/webp',
  extensionOverride = ''
) {
  const ext =
    extensionOverride ||
    extensionFromKey(
      name
    ) ||
    extensionFromMime(
      mime
    ) ||
    '.webp';

  return `${category}/${ensureProductPrefix(name)}${ext}`;
}

function extensionFromMime(
  mime
) {
  return {
    'image/webp':
      '.webp',
    'image/png':
      '.png',
    'image/jpeg':
      '.jpg',
    'image/gif':
      '.gif',
    'image/avif':
      '.avif',
    'image/svg+xml':
      '.svg'
  }[
    String(
      mime || ''
    )
      .split(';')[0]
      .toLowerCase()
  ] || '.webp';
}

function mimeFromPath(
  path
) {
  const e =
    extensionFromKey(
      path
    );

  return {
    '.webp':
      'image/webp',
    '.png':
      'image/png',
    '.jpg':
      'image/jpeg',
    '.jpeg':
      'image/jpeg',
    '.gif':
      'image/gif',
    '.svg':
      'image/svg+xml',
    '.ico':
      'image/x-icon',
    '.avif':
      'image/avif',
    '.webm':
      'video/webm',
    '.mp4':
      'video/mp4',
    '.m4v':
      'video/mp4',
    '.mov':
      'video/quicktime',
    '.mp3':
      'audio/mpeg',
    '.wav':
      'audio/wav',
    '.ogg':
      'audio/ogg',
    '.json':
      'application/json',
    '.woff':
      'font/woff',
    '.woff2':
      'font/woff2',
    '.ttf':
      'font/ttf',
    '.otf':
      'font/otf'
  }[
    e
  ] || '';
}

function normalizeImageMime(
  mime
) {
  const m =
    String(
      mime || ''
    )
      .split(';')[0]
      .trim()
      .toLowerCase();

  return /^image\//.test(
    m
  )
    ? m
    : '';
}

function validateImageFile(
  file,
  strictWebp
) {
  if (
    Number(
      file.size || 0
    ) > MAX_FILE_BYTES
  ) {
    throw httpError(
      413,
      'El archivo supera el límite de 10 MB.',
      'too_large'
    );
  }

  if (
    strictWebp &&
    !/^image\/webp$/i.test(
      file.type || ''
    ) &&
    !/\.webp$/i.test(
      file.name || ''
    )
  ) {
    throw httpError(
      415,
      'Solo se permiten imágenes .webp para nuevas cargas y reemplazos.',
      'webp_required'
    );
  }
}

function b2NameFromUrl(
  pathname
) {
  return (
    stripExtension(
      lastSegment(
        pathname
      )
    ) ||
    'imagen'
  );
}

function textTag(
  text,
  tag
) {
  const m =
    new RegExp(
      `<${tag}>([\\s\\S]*?)<\\/${tag}>`,
      'i'
    ).exec(
      String(
        text || ''
      )
    );

  return m
    ? m[1].trim()
    : '';
}

function xmlUnescape(
  value
) {
  return String(
    value || ''
  )
    .replace(
      /&amp;/g,
      '&'
    )
    .replace(
      /&lt;/g,
      '<'
    )
    .replace(
      /&gt;/g,
      '>'
    )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&apos;/g,
      "'"
    );
}

function clampInt(
  value,
  min,
  max
) {
  const n =
    Number.parseInt(
      value,
      10
    );

  return Number.isFinite(
    n
  )
    ? Math.min(
        max,
        Math.max(
          min,
          n
        )
      )
    : min;
}

function regionFromEndpoint(
  endpoint
) {
  const m =
    String(
      endpoint || ''
    ).match(
      /\.([^.]+)\.backblazeb2\.com$/i
    );

  return m
    ? m[1]
    : 'us-east-005';
}

function isOriginAllowed(
  origin,
  env
) {
  if (!origin) {
    return true;
  }

  const allowed =
    String(
      env.ALLOWED_ORIGINS ||
        ''
    )
      .split(',')
      .map(
        x => x.trim()
      )
      .filter(Boolean);

  return allowed.includes(
    origin
  );
}

function corsHeaders(
  origin,
  env,
  allowMethods
) {
  const value =
    origin &&
    isOriginAllowed(
      origin,
      env
    )
      ? origin
      : '*';

  return {
    'Access-Control-Allow-Origin':
      value,
    'Access-Control-Allow-Methods':
      allowMethods
        ? 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
        : 'GET,OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Accept, Range',
    'Access-Control-Max-Age':
      '600',
    Vary: 'Origin'
  };
}

function json(
  data,
  status,
  extraHeaders = {}
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...JSON_HEADERS,
        ...extraHeaders
      }
    }
  );
}

class HttpError extends Error {
  constructor(
    status,
    message,
    code = ''
  ) {
    super(message);
    this.name =
      'HttpError';
    this.status =
      status;
    this.code =
      code;
    this.publicMessage =
      message;
  }
}

function httpError(
  status,
  message,
  code = ''
) {
  return new HttpError(
    status,
    message,
    code
  );
}

async function b2Error(
  response,
  fallback
) {
  let detail = '';

  try {
    detail =
      (
        await response.text()
      ).slice(
        0,
        600
      );
  } catch {}

  return httpError(
    response.status || 502,
    detail
      ? `${fallback} ${detail}`
      : fallback,
    'b2_error'
  );
}