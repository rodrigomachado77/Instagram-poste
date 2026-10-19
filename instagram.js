const sharp = require('sharp');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  PORT = 3000,
  IG_ACCESS_TOKEN,
  IG_USER_ID = 'me',
  PUBLIC_BASE_URL,
  GRAPH_HOST = 'graph.instagram.com',
  GRAPH_API_VERSION = 'v23.0',
  DEFAULT_CAPTION = '',
  DRY_RUN = 'false',
} = process.env;

const dryRun = DRY_RUN === 'true';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// O Instagram só aceita JPEG com proporção entre 4:5 (retrato) e 1.91:1 (paisagem).
// forceRatio: no carrossel, todas as fotos usam a proporção da primeira (senão o Instagram corta pelo centro).
async function prepareImage(buffer, forceRatio) {
  const img = sharp(buffer, { failOn: 'none' }).rotate(); // aplica a orientação EXIF
  const { width, height } = await img.metadata().then(
    (m) => (m.orientation >= 5 ? { width: m.height, height: m.width } : m),
    () => { throw new Error('Formato de imagem não suportado. Se for HEIC do iPhone, envie como JPEG.'); }
  );
  const ratio = forceRatio || Math.min(Math.max(width / height, 0.8), 1.91);
  const outW = Math.min(1440, width, Math.round(height * ratio));
  const outH = Math.round(outW / ratio);

  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
  await img
    .resize(outW, outH, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(path.join(UPLOAD_DIR, name));
  const base = (PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  return { url: `${base}/uploads/${name}`, ratio };
}

// O token do Instagram vence em ~60 dias; renovar estende a validade. Roda ao iniciar e uma vez por dia.
let accessToken = IG_ACCESS_TOKEN;
async function refreshToken() {
  if (dryRun || !accessToken || GRAPH_HOST !== 'graph.instagram.com') return;
  try {
    const url = new URL('https://graph.instagram.com/refresh_access_token');
    url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: accessToken });
    const data = await (await fetch(url)).json();
    if (data.error) throw new Error(data.error.message);
    accessToken = data.access_token;
    console.log(`Token do Instagram renovado; vale por mais ${Math.round(data.expires_in / 86400)} dias.`);
  } catch (err) {
    console.error('Não consegui renovar o token do Instagram:', err.message);
  }
}
refreshToken();
setInterval(refreshToken, 24 * 60 * 60 * 1000).unref();

async function graph(method, endpoint, params = {}) {
  const url = new URL(`https://${GRAPH_HOST}/${GRAPH_API_VERSION}/${endpoint}`);
  const body = new URLSearchParams({ ...params, access_token: accessToken });
  let res;
  if (method === 'GET') {
    url.search = body.toString();
    res = await fetch(url);
  } else {
    res = await fetch(url, { method, body });
  }
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.error_user_msg || data.error?.message || `Erro HTTP ${res.status}`);
  }
  return data;
}

async function waitUntilReady(containerId) {
  for (let i = 0; i < 30; i++) {
    const { status_code } = await graph('GET', containerId, { fields: 'status_code' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') {
      throw new Error(`O Instagram não conseguiu processar a mídia (${status_code})`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Tempo esgotado esperando o Instagram processar a mídia');
}

async function publishContainer(containerId) {
  await waitUntilReady(containerId);
  const { id } = await graph('POST', `${IG_USER_ID}/media_publish`, { creation_id: containerId });
  const { permalink } = await graph('GET', id, { fields: 'permalink' }).catch(() => ({}));
  return { id, permalink };
}

async function postSingle(imageUrl, caption) {
  const { id } = await graph('POST', `${IG_USER_ID}/media`, { image_url: imageUrl, caption });
  return publishContainer(id);
}

async function postCarousel(imageUrls, caption) {
  const children = [];
  for (const image_url of imageUrls) {
    const { id } = await graph('POST', `${IG_USER_ID}/media`, { image_url, is_carousel_item: 'true' });
    children.push(id);
  }
  for (const child of children) await waitUntilReady(child);
  const { id } = await graph('POST', `${IG_USER_ID}/media`, {
    media_type: 'CAROUSEL',
    children: children.join(','),
    caption,
  });
  return publishContainer(id);
}

// Recebe as fotos (buffers) e publica. mode: 'carousel' ou 'separate'.
async function publish(buffers, caption, mode = 'carousel') {
  caption = (caption || DEFAULT_CAPTION).slice(0, 2200);
  if (buffers.length === 1) mode = 'separate';

  const urls = [];
  let ratio;
  for (const b of buffers) {
    const img = await prepareImage(b, mode === 'carousel' ? ratio : undefined);
    ratio = img.ratio;
    urls.push(img.url);
  }

  if (dryRun) {
    console.log('[DRY_RUN] publicaria:', { mode, caption, urls });
    return { dryRun: true, posts: urls.map((u) => ({ permalink: u })) };
  }

  const posts = [];
  if (mode === 'carousel') posts.push(await postCarousel(urls, caption));
  else for (const u of urls) posts.push(await postSingle(u, caption));
  return { posts };
}

// Apaga fotos com mais de 24h (o Instagram já terá copiado).
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const p = path.join(UPLOAD_DIR, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
  }
}, 60 * 60 * 1000).unref();

module.exports = { publish, dryRun, UPLOAD_DIR };
