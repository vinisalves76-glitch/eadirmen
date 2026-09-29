const admin = require('firebase-admin');

function getAdminApp() {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT nao configurada na Vercel.');

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (_) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT invalida.');
  }

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

function clean(value, max = 180) {
  return String(value ?? '').trim().slice(0, max);
}

function numberValue(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const err = new Error(field + ' invalido.');
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function validateShift(body) {
  const machineCode = clean(body.machineCode, 40).toUpperCase();
  const machineName = clean(body.machineName, 120);
  const operator = clean(body.operator, 100);
  const shift = clean(body.shift, 50);
  const date = clean(body.date, 20);
  const team = clean(body.team, 80);
  const notes = clean(body.notes, 800);

  if (!machineCode || !/^[A-Z0-9_-]+$/.test(machineCode)) {
    const err = new Error('Codigo da maquina invalido.');
    err.statusCode = 400;
    throw err;
  }
  if (!operator) {
    const err = new Error('Operador obrigatorio.');
    err.statusCode = 400;
    throw err;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const err = new Error('Data invalida.');
    err.statusCode = 400;
    throw err;
  }

  const kmStart = numberValue(body.kmStart, 'Km inicial');
  const kmEnd = numberValue(body.kmEnd, 'Km final');
  const socStart = numberValue(body.socStart, 'SOC inicial');
  const socEnd = numberValue(body.socEnd, 'SOC final');
  const loadedCycles = numberValue(body.loadedCycles, 'Ciclos carregados');

  if (kmStart < 0 || kmEnd < kmStart) {
    const err = new Error('Quilometragem invalida.');
    err.statusCode = 400;
    throw err;
  }
  if (socStart < 0 || socStart > 100 || socEnd < 0 || socEnd > 100) {
    const err = new Error('SOC deve estar entre 0 e 100.');
    err.statusCode = 400;
    throw err;
  }
  if (loadedCycles < 0 || !Number.isInteger(loadedCycles)) {
    const err = new Error('Ciclos carregados devem ser um numero inteiro.');
    err.statusCode = 400;
    throw err;
  }

  const distanceKm = Number((kmEnd - kmStart).toFixed(2));
  const socVariation = Number((socStart - socEnd).toFixed(2));
  const kmPerCycle = loadedCycles > 0 ? Number((distanceKm / loadedCycles).toFixed(3)) : 0;

  return {
    machineCode,
    machineName,
    operator,
    shift,
    date,
    team,
    kmStart,
    kmEnd,
    distanceKm,
    socStart,
    socEnd,
    socVariation,
    loadedCycles,
    kmPerCycle,
    notes
  };
}

async function requireActiveViewer(req) {
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
  const allowed = ['admin', 'consultant', 'instructor'];

  if (!profile || profile.ativo !== true || !allowed.includes(profile.perfil)) {
    const err = new Error('Usuario sem permissao para consultar os registros.');
    err.statusCode = 403;
    throw err;
  }

  return { app, db, decoded, profile };
}

function clientPreviewAuthorized(req) {
  const received = String(req.headers['x-fleet-client-key'] || '');
  const expected = process.env.FLEET_CLIENT_ACCESS_KEY || 'IRMEN-FLEET-PREVIEW-2026';
  return received === expected;
}

module.exports = async function handler(req, res) {
  try {
    const app = getAdminApp();
    const db = app.firestore();

    if (req.method === 'POST') {
      if (!clientPreviewAuthorized(req)) {
        return res.status(401).json({ error: 'App do cliente nao autorizado.' });
      }

      const data = validateShift(req.body || {});
      const ref = await db.collection('registrosTurnoFrota').add({
        ...data,
        origem: 'app-cliente',
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
        recebidoEm: new Date().toISOString()
      });

      return res.status(201).json({
        ok: true,
        id: ref.id,
        record: { ...data, id: ref.id }
      });
    }

    if (req.method === 'GET') {
      await requireActiveViewer(req);

      const requestedMachine = clean(req.query?.machineCode, 40).toUpperCase();
      const snap = await db.collection('registrosTurnoFrota')
        .orderBy('criadoEm', 'desc')
        .limit(500)
        .get();

      let records = snap.docs.map(doc => {
        const data = doc.data() || {};
        const criadoEm = data.criadoEm && typeof data.criadoEm.toDate === 'function'
          ? data.criadoEm.toDate().toISOString()
          : data.recebidoEm || null;
        return { id: doc.id, ...data, criadoEm };
      });

      if (requestedMachine) {
        records = records.filter(r => String(r.machineCode || '').toUpperCase() === requestedMachine);
      }

      return res.status(200).json({ ok: true, records });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Metodo nao permitido.' });
  } catch (err) {
    console.error('fleet-shifts error', err);
    return res.status(err.statusCode || 500).json({
      error: err.message || 'Erro interno ao sincronizar dados da frota.'
    });
  }
};
