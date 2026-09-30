const admin = require('firebase-admin');
const crypto = require('crypto');

function getAdminApp() {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    const err = new Error('Armazenamento nao habilitado neste ambiente de teste.');
    err.statusCode = 503;
    err.code = 'storage-preview-not-configured';
    throw err;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (_) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT invalida.');
  }

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'eadirmen-a6693.firebasestorage.app'
  });
}

function clean(value, max = 180) {
  return String(value ?? '').trim().slice(0, max);
}

async function requireActiveUser(req) {
  const app = getAdminApp();
  const auth = app.auth();
  const db = app.firestore();
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    const err = new Error('Sessao nao informada.');
    err.statusCode = 401;
    throw err;
  }

  let decoded;
  try {
    decoded = await auth.verifyIdToken(match[1], true);
  } catch (_) {
    const err = new Error('Sessao invalida ou expirada.');
    err.statusCode = 401;
    throw err;
  }

  const snap = await db.collection('usuarios').doc(decoded.uid).get();
  const profile = snap.exists ? snap.data() : null;

  if (!profile || profile.ativo !== true || !['admin', 'instructor'].includes(profile.perfil)) {
    const err = new Error('Usuario sem permissao para anexar materiais.');
    err.statusCode = 403;
    throw err;
  }

  return { app, decoded, profile };
}

function validateId(value, label) {
  const text = clean(value, 120);
  if (!text || !/^[a-zA-Z0-9_-]+$/.test(text)) {
    const err = new Error(label + ' invalido.');
    err.statusCode = 400;
    throw err;
  }
  return text;
}

async function removeIfExists(file) {
  try {
    await file.delete({ ignoreNotFound: true });
  } catch (_) {}
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Metodo nao permitido.' });
  }

  try {
    const { app, decoded } = await requireActiveUser(req);
    const bucket = app.storage().bucket();
    const body = req.body || {};
    const action = clean(body.action, 30);

    if (action === 'chunk') {
      const uploadId = validateId(body.uploadId, 'Upload');
      const skillId = validateId(body.skillId, 'Habilidade');
      const chunkIndex = Number(body.chunkIndex);
      const chunkCount = Number(body.chunkCount);
      const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';

      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || !Number.isInteger(chunkCount) || chunkCount < 1 || chunkIndex >= chunkCount || chunkCount > 20) {
        return res.status(400).json({ error: 'Parte do arquivo invalida.' });
      }

      const buffer = Buffer.from(dataBase64, 'base64');
      if (!buffer.length || buffer.length > 2.25 * 1024 * 1024) {
        return res.status(400).json({ error: 'Parte do arquivo vazia ou maior que o limite.' });
      }

      const path = `microaulas/${skillId}/temporarios/${decoded.uid}/${uploadId}/part-${String(chunkIndex).padStart(3, '0')}`;
      await bucket.file(path).save(buffer, {
        resumable: false,
        validation: false,
        metadata: { contentType: 'application/octet-stream' }
      });

      return res.status(200).json({ ok: true, chunkIndex });
    }

    if (action === 'complete') {
      const uploadId = validateId(body.uploadId, 'Upload');
      const skillId = validateId(body.skillId, 'Habilidade');
      const chunkCount = Number(body.chunkCount);
      const fileName = clean(body.fileName, 180).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'arquivo';
      const originalName = clean(body.originalName, 220) || fileName;
      const contentType = clean(body.contentType, 120) || 'application/octet-stream';

      if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 20) {
        return res.status(400).json({ error: 'Quantidade de partes invalida.' });
      }

      const base = `microaulas/${skillId}/temporarios/${decoded.uid}/${uploadId}`;
      const parts = Array.from({ length: chunkCount }, (_, i) => bucket.file(`${base}/part-${String(i).padStart(3, '0')}`));

      for (const part of parts) {
        const [exists] = await part.exists();
        if (!exists) return res.status(400).json({ error: 'O upload esta incompleto. Tente enviar novamente.' });
      }

      const finalPath = `microaulas/${skillId}/resultados/${Date.now()}_${fileName}`;
      const destination = bucket.file(finalPath);

      await bucket.combine(parts, destination);

      const token = crypto.randomUUID();
      await destination.setMetadata({
        contentType,
        metadata: {
          firebaseStorageDownloadTokens: token,
          uploadedBy: decoded.uid,
          originalName
        }
      });

      await Promise.all(parts.map(removeIfExists));

      const url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(finalPath)}?alt=media&token=${token}`;

      return res.status(200).json({
        ok: true,
        url,
        storagePath: finalPath,
        fileName: originalName
      });
    }

    if (action === 'delete') {
      const storagePath = clean(body.storagePath, 500);
      const skillId = validateId(body.skillId, 'Habilidade');

      if (!storagePath || !storagePath.startsWith(`microaulas/${skillId}/resultados/`)) {
        return res.status(400).json({ error: 'Arquivo invalido.' });
      }

      await bucket.file(storagePath).delete({ ignoreNotFound: true });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acao invalida.' });

  } catch (err) {
    console.error('production-files:', err);
    return res.status(err.statusCode || 500).json({
      error: err.statusCode
        ? err.message
        : 'Falha interna ao armazenar o arquivo.',
      code: err.code || 'storage-error'
    });
  }
};
