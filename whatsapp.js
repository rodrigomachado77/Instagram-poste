const express = require('express');
const crypto = require('crypto');
const { publish } = require('./instagram');

const {
  WA_ACCESS_TOKEN,
  WA_PHONE_NUMBER_ID,
  WA_VERIFY_TOKEN,
  WA_APP_SECRET,
  WA_ALLOWED_NUMBERS = '',
  WA_ALBUM_WAIT_SECONDS = '15',
  WA_GRAPH_BASE = 'https://graph.facebook.com/v23.0',
} = process.env;

const enabled = Boolean(WA_ACCESS_TOKEN && WA_PHONE_NUMBER_ID && WA_VERIFY_TOKEN);

// O WhatsApp às vezes manda números do Brasil sem o 9 do celular; normaliza os dois lados.
const normalize = (n) => {
  const d = String(n).replace(/\D/g, '');
  return d.length === 13 && d.startsWith('55') && d[4] === '9' ? d.slice(0, 4) + d.slice(5) : d;
};
const allowed = new Set(WA_ALLOWED_NUMBERS.split(',').map(normalize).filter(Boolean));

const HELP =
  '📸 *Bot do Instagram*\n\n' +
  'Envie uma foto ou vídeo com o texto da publicação na legenda e eu publico no Instagram.\n\n' +
  '• Um vídeo sozinho vira *Reels*\n' +
  '• Várias fotos/vídeos de uma vez viram um *carrossel* (até 10)\n' +
  '• Esqueceu a legenda? Mande o texto logo em seguida, em até ' + WA_ALBUM_WAIT_SECONDS + 's\n' +
  '• *cancelar* descarta o que ainda não foi publicado';

async function waApi(endpoint, options = {}) {
  const url = /^https?:\/\//.test(endpoint) ? endpoint : `${WA_GRAPH_BASE}/${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, ...options.headers },
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
  return res;
}

async function reply(to, body) {
  try {
    await waApi(`${WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
  } catch (err) {
    console.error('Falha ao responder no WhatsApp:', err.message);
  }
}

async function downloadMedia(mediaId) {
  const { url } = await (await waApi(mediaId)).json();
  return Buffer.from(await (await waApi(url)).arrayBuffer());
}

// Fotos enviadas juntas chegam como mensagens separadas; espera alguns segundos e junta tudo.
const pending = new Map(); // número -> { items: [{ id, mimetype }], caption, timer }

function schedule(from) {
  const p = pending.get(from);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => flush(from), Number(WA_ALBUM_WAIT_SECONDS) * 1000);
}

async function flush(from) {
  const p = pending.get(from);
  pending.delete(from);
  if (!p?.items.length) return;

  const n = p.items.length;
  const what = n > 1 ? `carrossel com ${n} itens` : p.items[0].mimetype.startsWith('video/') ? 'o Reels' : 'a foto';
  await reply(from, `⏳ Publicando ${what}…`);
  try {
    const files = [];
    for (const it of p.items) files.push({ buffer: await downloadMedia(it.id), mimetype: it.mimetype });
    const result = await publish(files, p.caption, 'carousel');
    const link = result.posts[0]?.permalink;
    await reply(from, result.dryRun
      ? `✅ Teste OK: nada foi publicado de verdade (DRY_RUN).\nLegenda: ${p.caption || '(vazia)'}`
      : `✅ Publicado no Instagram!${link ? `\n${link}` : ''}`);
  } catch (err) {
    console.error(err);
    await reply(from, `❌ Não consegui publicar: ${err.message}`);
  }
}

const seen = new Set();

async function handleMessage(msg) {
  if (seen.has(msg.id)) return; // o WhatsApp pode reenviar o mesmo evento
  seen.add(msg.id);
  if (seen.size > 1000) seen.delete(seen.values().next().value);

  const from = msg.from;
  if (allowed.size && !allowed.has(normalize(from))) {
    console.warn(`Mensagem ignorada de número não autorizado: ${from}`);
    return;
  }

  // Foto ou vídeo normal, ou enviado "como documento" (comum no iPhone para manter a qualidade).
  const media = msg.type === 'image' ? msg.image
    : msg.type === 'video' ? msg.video
    : msg.type === 'document' && /^(image|video)\//.test(msg.document.mime_type) ? msg.document
    : null;

  if (media) {
    if (/hei[cf]/i.test(media.mime_type)) {
      return reply(from, '⚠️ Essa foto está em HEIC, formato do iPhone que o Instagram não aceita. Envie como foto normal (não como documento), que o WhatsApp converte sozinho.');
    }
    if (/^video\//.test(media.mime_type) && !/^video\/(mp4|quicktime)$/.test(media.mime_type)) {
      return reply(from, '⚠️ Esse vídeo não está em MP4 ou MOV, formatos que o Instagram aceita. Grave pela câmera do celular e envie de novo.');
    }
    const p = pending.get(from) || { items: [], caption: '' };
    pending.set(from, p);
    if (p.items.length >= 10) {
      if (p.warned) return;
      p.warned = true;
      return reply(from, '⚠️ O Instagram aceita no máximo 10 fotos por carrossel; ignorei as extras.');
    }
    p.items.push({ id: media.id, mimetype: media.mime_type });
    if (media.caption && !p.caption) p.caption = media.caption;
    return schedule(from);
  }

  if (msg.type === 'text') {
    const text = msg.text.body.trim();
    const p = pending.get(from);
    if (/^cancelar$/i.test(text)) {
      if (p) { clearTimeout(p.timer); pending.delete(from); }
      return reply(from, p ? '🗑️ Descartado.' : 'Não há nada pendente.');
    }
    if (p && !p.caption) {
      p.caption = text;
      return schedule(from);
    }
    return reply(from, HELP);
  }

  return reply(from, '⚠️ Só consigo publicar fotos e vídeos.\n\n' + HELP);
}

const router = express.Router();

// Verificação do webhook (feita uma vez pela Meta ao configurar).
router.get('/', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WA_VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

router.post('/', express.raw({ type: '*/*' }), (req, res) => {
  if (WA_APP_SECRET) {
    const expected = 'sha256=' + crypto.createHmac('sha256', WA_APP_SECRET).update(req.body).digest('hex');
    const given = String(req.get('x-hub-signature-256') || '');
    if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      console.warn('Webhook recusado: assinatura inválida. Confira se WA_APP_SECRET é a "Chave secreta do app" (Configurações do app → Básico).');
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200); // responde logo; a Meta reenvia se demorar

  let payload;
  try { payload = JSON.parse(req.body); } catch { return; }
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const msg of change.value?.messages || []) {
        console.log(`Mensagem recebida de ${msg.from} (${msg.type})`);
        handleMessage(msg).catch((err) => console.error(err));
      }
      // Respostas que a Meta aceitou mas não conseguiu entregar chegam aqui.
      for (const st of change.value?.statuses || []) {
        if (st.status === 'failed') {
          const e = st.errors?.[0];
          console.error(`Resposta não entregue para ${st.recipient_id}: ${e?.code} ${e?.title}`);
        }
      }
    }
  }
});

module.exports = { enabled, router };
