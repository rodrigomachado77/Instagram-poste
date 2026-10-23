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
  WATERMARK_POSITION = 'bottom-right',
  WATERMARK_SIZE = '0.2',
  WATERMARK_OPACITY = '0.8',
} = process.env;

const dryRun = DRY_RUN === 'true';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const UNSUPPORTED_IMAGE = 'Formato de imagem não suportado. Se for HEIC do iPhone, envie como JPEG.';

// Marca d'água: se existir watermark.png na raiz do projeto, ela vai num canto de toda foto.
let watermark = null;
try { watermark = fs.readFileSync(path.join(__dirname, 'watermark.png')); } catch {}

// Monta a camada da logo para uma foto de w x h: largura = WATERMARK_SIZE da foto, margem de 3%.
async function watermarkLayer(w, h) {
  const { data, info } = await sharp(watermark)
    .resize(Math.round(w * Number(WATERMARK_SIZE)), Math.round(h * 0.3), { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const opacity = Number(WATERMARK_OPACITY);
  for (let i = info.channels - 1; i < data.length; i += info.channels) data[i] = Math.round(data[i] * opacity);

  const m = Math.round(Math.min(w, h) * 0.03);
  const pos = WATERMARK_POSITION;
  const left = pos.includes('left') ? m : pos.includes('right') ? w - info.width - m : Math.round((w - info.width) / 2);
  const top = pos.includes('top') ? m : pos.includes('bottom') ? h - info.height - m : Math.round((h - info.height) / 2);
  return { input: data, raw: { width: info.width, height: info.height, channels: info.channels }, left, top };
}

const withWatermark = async (img, w, h) => (watermark ? img.composite([await watermarkLayer(w, h)]) : img);

// Tamanho da foto já na orientação certa (fotos do celular vêm "deitadas" com uma marcação EXIF).
const orientedSize = (img) => img.metadata().then(
  (m) => (m.orientation >= 5 ? { width: m.height, height: m.width } : m),
  () => { throw new Error(UNSUPPORTED_IMAGE); }
);

// O Instagram só aceita JPEG com proporção entre 4:5 (retrato) e 1.91:1 (paisagem).
// forceRatio: no carrossel, todas as fotos usam a proporção da primeira (senão o Instagram corta pelo centro).
async function prepareImage(buffer, forceRatio) {
  const img = sharp(buffer, { failOn: 'none' }).rotate(); // aplica a orientação EXIF
  const { width, height } = await orientedSize(img);
  const ratio = forceRatio || Math.min(Math.max(width / height, 0.8), 1.91);
  const outW = Math.min(1440, width, Math.round(height * ratio));
  const outH = Math.round(outW / ratio);

  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
  const resized = img.resize(outW, outH, { fit: 'cover', position: 'attention' });
  await (await withWatermark(resized, outW, outH))
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(path.join(UPLOAD_DIR, name));
  return { url: publicUrl(name), ratio };
}

// No Story a foto não é cortada: só reduzimos para caber em 1080x1920, e o Instagram ajusta à tela.
async function prepareStoryImage(buffer) {
  const img = sharp(buffer, { failOn: 'none' }).rotate();
  const { width, height } = await orientedSize(img);
  const scale = Math.min(1080 / width, 1920 / height, 1);
  const outW = Math.round(width * scale);
  const outH = Math.round(height * scale);

  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`;
  await (await withWatermark(img.resize(outW, outH), outW, outH))
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(path.join(UPLOAD_DIR, name))
    .catch(() => { throw new Error(UNSUPPORTED_IMAGE); });
  return { url: publicUrl(name) };
}

const publicUrl = (name) => `${(PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '')}/uploads/${name}`;
const isVideo = (mimetype) => /^video\//.test(mimetype || '');

// O Instagram aceita vídeo MP4 ou MOV; salvamos como veio, sem converter.
async function prepareVideo(buffer, mimetype) {
  const ext = { 'video/mp4': 'mp4', 'video/quicktime': 'mov' }[mimetype];
  if (!ext) throw new Error(`Formato de vídeo não suportado (${mimetype}). Envie em MP4 ou MOV.`);
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, name), buffer);
  return { url: publicUrl(name) };
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

// Vídeos podem levar alguns minutos para o Instagram processar; espera até 5 min.
async function waitUntilReady(containerId) {
  for (let i = 0; i < 100; i++) {
    const { status_code } = await graph('GET', containerId, { fields: 'status_code' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') {
      throw new Error(`O Instagram não conseguiu processar a mídia (${status_code})`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Tempo esgotado esperando o Instagram processar a mídia');
}

async function publishContainer(containerId) {
  await waitUntilReady(containerId);
  const { id } = await graph('POST', `${IG_USER_ID}/media_publish`, { creation_id: containerId });
  const { permalink } = await graph('GET', id, { fields: 'permalink' }).catch(() => ({}));
  return { id, permalink };
}

// Um vídeo sozinho vira Reels; num carrossel, entra como VIDEO.
const mediaParams = (m, inCarousel) => m.video
  ? { media_type: inCarousel ? 'VIDEO' : 'REELS', video_url: m.url }
  : { image_url: m.url };

async function postStory(media) {
  const { id } = await graph('POST', `${IG_USER_ID}/media`, {
    media_type: 'STORIES',
    [media.video ? 'video_url' : 'image_url']: media.url,
  });
  return { ...(await publishContainer(id)), story: true };
}

// Legenda "story" publica só no Story; "story + texto" publica no feed (com o texto) e no Story.
function parseStory(caption = '') {
  const m = String(caption).trim().match(/^story\s*(\+\s*([\s\S]*))?$/i);
  if (!m) return { story: false, caption };
  return m[1] ? { story: 'also', caption: m[2].trim() } : { story: 'only', caption: '' };
}

async function postSingle(media, caption) {
  const { id } = await graph('POST', `${IG_USER_ID}/media`, { ...mediaParams(media, false), caption });
  return publishContainer(id);
}

async function postCarousel(medias, caption) {
  const children = [];
  for (const m of medias) {
    const { id } = await graph('POST', `${IG_USER_ID}/media`, { ...mediaParams(m, true), is_carousel_item: 'true' });
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

// Recebe fotos e vídeos ({ buffer, mimetype }) e publica.
// mode: 'carousel', 'separate' ou 'story' (só Story). alsoStory: publica no feed e também no Story.
async function publish(files, caption, mode = 'carousel', alsoStory = false) {
  caption = (caption || DEFAULT_CAPTION).slice(0, 2200);
  const toFeed = mode !== 'story';
  const toStory = mode === 'story' || alsoStory;
  if (files.length === 1 && toFeed) mode = 'separate';

  const medias = [];
  const stories = [];
  let ratio;
  for (const f of files) {
    if (isVideo(f.mimetype)) {
      const video = { video: true, ...(await prepareVideo(f.buffer, f.mimetype)) };
      if (toFeed) medias.push(video);
      if (toStory) stories.push(video);
      continue;
    }
    if (toFeed) {
      const img = await prepareImage(f.buffer, mode === 'carousel' ? ratio : undefined);
      ratio = img.ratio;
      medias.push({ video: false, url: img.url });
    }
    if (toStory) stories.push({ video: false, ...(await prepareStoryImage(f.buffer)) });
  }

  if (dryRun) {
    console.log('[DRY_RUN] publicaria:', { mode, caption, medias, stories });
    return {
      dryRun: true,
      posts: [...medias.map((m) => ({ permalink: m.url })), ...stories.map((m) => ({ permalink: m.url, story: true }))],
    };
  }

  const posts = [];
  if (toFeed) {
    if (mode === 'carousel') posts.push(await postCarousel(medias, caption));
    else for (const m of medias) posts.push(await postSingle(m, caption));
  }
  for (const s of stories) posts.push(await postStory(s));
  return { posts };
}

// Apaga arquivos com mais de 24h (o Instagram já terá copiado).
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const p = path.join(UPLOAD_DIR, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
  }
}, 60 * 60 * 1000).unref();

module.exports = { publish, parseStory, dryRun, UPLOAD_DIR };
