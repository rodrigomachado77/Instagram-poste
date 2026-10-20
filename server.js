require('dotenv').config();
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { publish, dryRun, UPLOAD_DIR } = require('./instagram');
const whatsapp = require('./whatsapp');

const { PORT = 3000, APP_PASSWORD, IG_ACCESS_TOKEN, PUBLIC_BASE_URL } = process.env;

if (!dryRun && (!IG_ACCESS_TOKEN || !PUBLIC_BASE_URL)) {
  console.error('Defina IG_ACCESS_TOKEN e PUBLIC_BASE_URL no .env (ou use DRY_RUN=true para testar).');
  process.exit(1);
}
if (!APP_PASSWORD && !whatsapp.enabled) {
  console.error('Defina APP_PASSWORD (site) e/ou as variáveis WA_* (bot do WhatsApp) no .env');
  process.exit(1);
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype)),
});

// Usado pela hospedagem (ex.: Render) para saber se o app está no ar.
app.get('/health', (_req, res) => res.json({ ok: true }));

// O Instagram baixa as fotos e vídeos daqui, por isso esta pasta precisa ser pública.
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));

if (whatsapp.enabled) app.use('/webhook', whatsapp.router);

if (APP_PASSWORD) {
  app.use(express.static(path.join(__dirname, 'public')));

  const requirePassword = (req, res, next) => {
    const given = Buffer.from(String(req.get('x-app-password') || ''));
    const expected = Buffer.from(APP_PASSWORD);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }
    next();
  };

  app.post('/api/check', requirePassword, (_req, res) => res.json({ ok: true, dryRun }));

  app.post('/api/post', requirePassword, upload.array('photos', 10), async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Envie pelo menos uma foto ou vídeo' });
    try {
      const mode = req.body.mode === 'separate' ? 'separate' : 'carousel';
      const result = await publish(files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })), req.body.caption, mode);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });
}

app.listen(PORT, () => {
  console.log(`App rodando em http://localhost:${PORT}${dryRun ? ' (modo teste: DRY_RUN)' : ''}`);
  console.log(`Site: ${APP_PASSWORD ? 'ligado' : 'desligado'} · Bot do WhatsApp: ${whatsapp.enabled ? 'ligado (/webhook)' : 'desligado'}`);
});
