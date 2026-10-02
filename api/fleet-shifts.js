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

function shiftsCollection() {
  const preview = String(process.env.VERCEL_ENV || '').toLowerCase() !== 'production';
  return preview ? 'preview_shiftRecords' : 'shiftRecords';
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

function optionalNumberValue(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return numberValue(value, field);
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'sim', 'yes'].includes(String(value).trim().toLowerCase());
}

function validateShift(body) {
  const machineCode = clean(body.machineCode, 40).toUpperCase();
  const machineName = clean(body.machineName, 120);
  const client = clean(body.client, 180);
  const location = clean(body.location, 180);
  const machineFamily = clean(body.machineFamily || 'Caminhão', 40);
  const powerSource = clean(body.powerSource || 'Mecânico', 30);
  const operator = clean(body.operator, 100);
  const shift = clean(body.shift, 50);
  const date = clean(body.date, 20);
  const team = clean(body.team, 80);
  const application = clean(body.application, 160);
  const operationalCondition = clean(body.operationalCondition, 160);
  const notes = clean(body.notes, 800);

  const allowedFamilies = ['Caminhão', 'Escavadeira', 'Carregadeira', 'Outro'];
  const allowedPowerSources = ['Mecânico', 'Híbrido', 'Elétrico'];

  if (!machineCode || !/^[A-Z0-9_-]+$/.test(machineCode)) {
    const err = new Error('Codigo da maquina invalido.');
    err.statusCode = 400;
    throw err;
  }
  if (!allowedFamilies.includes(machineFamily)) {
    const err = new Error('Familia de equipamento invalida.');
    err.statusCode = 400;
    throw err;
  }
  if (!allowedPowerSources.includes(powerSource)) {
    const err = new Error('Fonte de energia invalida.');
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

  const hasKm = machineFamily === 'Caminhão';
  const hasApplication = machineFamily === 'Escavadeira' || machineFamily === 'Carregadeira';
  const hasOperationalCondition = machineFamily === 'Escavadeira' || machineFamily === 'Carregadeira';
  const hasSoc = powerSource === 'Elétrico' || powerSource === 'Híbrido';
  const cyclesAvailable = booleanValue(body.cyclesAvailable, machineFamily === 'Caminhão' || machineFamily === 'Carregadeira');
  const loadAvailable = booleanValue(body.loadAvailable, machineFamily === 'Caminhão');
  const energyDataAvailable = booleanValue(body.energyDataAvailable, false);
  const fuelDataAvailable = booleanValue(body.fuelDataAvailable, false);

  const hourmeterStart = numberValue(body.hourmeterStart, 'Horimetro inicial');
  const hourmeterEnd = numberValue(body.hourmeterEnd, 'Horimetro final');
  if (hourmeterStart < 0 || hourmeterEnd < hourmeterStart) {
    const err = new Error('Horimetro invalido.');
    err.statusCode = 400;
    throw err;
  }

  let kmStart = null;
  let kmEnd = null;
  let distanceKm = null;
  if (hasKm) {
    kmStart = numberValue(body.kmStart, 'Km inicial');
    kmEnd = numberValue(body.kmEnd, 'Km final');
    if (kmStart < 0 || kmEnd < kmStart) {
      const err = new Error('Quilometragem invalida.');
      err.statusCode = 400;
      throw err;
    }
    distanceKm = Number((kmEnd - kmStart).toFixed(2));
  }

  let socStart = null;
  let socEnd = null;
  let socVariation = null;
  if (hasSoc) {
    socStart = numberValue(body.socStart, 'SOC inicial');
    socEnd = numberValue(body.socEnd, 'SOC final');
    if (socStart < 0 || socStart > 100 || socEnd < 0 || socEnd > 100) {
      const err = new Error('SOC deve estar entre 0 e 100.');
      err.statusCode = 400;
      throw err;
    }
    socVariation = Number((socStart - socEnd).toFixed(2));
  }

  let loadedCycles = null;
  if (cyclesAvailable) {
    loadedCycles = numberValue(body.loadedCycles, 'Ciclos');
    if (loadedCycles < 0 || !Number.isInteger(loadedCycles)) {
      const err = new Error('Ciclos devem ser um numero inteiro.');
      err.statusCode = 400;
      throw err;
    }
  }

  if (hasApplication && !application) {
    const err = new Error('Informe a aplicacao da maquina neste turno.');
    err.statusCode = 400;
    throw err;
  }
  if (hasOperationalCondition && !operationalCondition) {
    const err = new Error('Informe a condicao operacional da maquina.');
    err.statusCode = 400;
    throw err;
  }

  const payloadTons = loadAvailable ? optionalNumberValue(body.payloadTons, 'Carga transportada') : null;
  if (payloadTons !== null && payloadTons < 0) {
    const err = new Error('Carga transportada invalida.');
    err.statusCode = 400;
    throw err;
  }

  const energyConsumedKwh = energyDataAvailable ? optionalNumberValue(body.energyConsumedKwh, 'Energia consumida') : null;
  if (energyConsumedKwh !== null && energyConsumedKwh < 0) {
    const err = new Error('Energia consumida invalida.');
    err.statusCode = 400;
    throw err;
  }

  const fuelConsumedLiters = fuelDataAvailable ? optionalNumberValue(body.fuelConsumedLiters, 'Combustivel consumido') : null;
  if (fuelConsumedLiters !== null && fuelConsumedLiters < 0) {
    const err = new Error('Combustivel consumido invalido.');
    err.statusCode = 400;
    throw err;
  }

  const chargeTimeMinutes = hasSoc && energyDataAvailable ? optionalNumberValue(body.chargeTimeMinutes, 'Tempo de carga') : null;
  if (chargeTimeMinutes !== null && chargeTimeMinutes < 0) {
    const err = new Error('Tempo de carga invalido.');
    err.statusCode = 400;
    throw err;
  }

  const hourmeterDelta = Number((hourmeterEnd - hourmeterStart).toFixed(2));
  const kmPerCycle = distanceKm !== null && loadedCycles > 0
    ? Number((distanceKm / loadedCycles).toFixed(3))
    : null;

  return {
    machineCode,
    machineName,
    client,
    location,
    machineFamily,
    powerSource,
    operator,
    shift,
    date,
    team,
    hourmeterStart,
    hourmeterEnd,
    hourmeterDelta,
    hasKm,
    kmStart,
    kmEnd,
    distanceKm,
    hasSoc,
    socStart,
    socEnd,
    socVariation,
    cyclesAvailable,
    loadedCycles,
    loadAvailable,
    payloadTons,
    application: hasApplication ? application : '',
    operationalCondition: hasOperationalCondition ? operationalCondition : '',
    energyDataAvailable,
    energyConsumedKwh,
    chargeTimeMinutes,
    fuelDataAvailable,
    fuelConsumedLiters,
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
      const receivedAt = new Date().toISOString();
      const ref = await db.collection(shiftsCollection()).add({
        ...data,
        origem: 'App do operador',
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
        recebidoEm: receivedAt,
        audit: {
          actorUid: null,
          actorName: data.operator,
          actorRole: 'Operador',
          recordedAt: receivedAt,
          source: 'App do operador',
          machineCode: data.machineCode,
          client: data.client || '',
          recordType: 'Registro de turno'
        }
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
      const snap = await db.collection(shiftsCollection())
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

      if (String(process.env.VERCEL_ENV || '').toLowerCase() === 'production') {
        try {
          const legacySnap = await db.collection('registrosTurnoFrota')
            .orderBy('criadoEm', 'desc')
            .limit(500)
            .get();
          const legacy = legacySnap.docs.map(doc => {
            const data = doc.data() || {};
            const criadoEm = data.criadoEm && typeof data.criadoEm.toDate === 'function'
              ? data.criadoEm.toDate().toISOString()
              : data.recebidoEm || null;
            return { id: doc.id, ...data, criadoEm, legacySource: true };
          });
          const seen = new Set(records.map(r => String(r.id)));
          records = records.concat(legacy.filter(r => !seen.has(String(r.id))));
          records.sort((a,b)=>String(b.criadoEm||b.recebidoEm||'').localeCompare(String(a.criadoEm||a.recebidoEm||'')));
        } catch (legacyErr) {
          console.warn('Nao foi possivel carregar turnos legados:', legacyErr);
        }
      }

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
