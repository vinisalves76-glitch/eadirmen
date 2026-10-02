const admin = require('firebase-admin');

function getAdminApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw Object.assign(new Error('FIREBASE_SERVICE_ACCOUNT nao configurada.'), { statusCode: 503 });
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch (_) { throw Object.assign(new Error('Configuracao do Firebase invalida.'), { statusCode: 503 }); }
  return admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function col(name) {
  const preview = String(process.env.VERCEL_ENV || '').toLowerCase() !== 'production';
  return preview ? 'preview_' + name : name;
}

function clean(value, max = 1200) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeId(value) {
  return clean(value, 120)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || String(Date.now());
}

function nowIso() { return new Date().toISOString(); }

function trace(profile, origin, type, machineCode, client) {
  return {
    actorUid: clean(profile?.uid || '', 160),
    actorName: clean(profile?.nome || profile?.email || 'Usuario', 160),
    actorRole: clean(profile?.perfil || '', 50),
    recordedAt: nowIso(),
    source: clean(origin || 'Consultor', 80),
    machineCode: clean(machineCode || '', 50).toUpperCase(),
    client: clean(client || '', 180),
    recordType: clean(type || '', 80)
  };
}

async function requireUser(req) {
  const app = getAdminApp();
  const auth = app.auth();
  const db = app.firestore();
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error('Sessao nao informada.'), { statusCode: 401 });

  let decoded;
  try { decoded = await auth.verifyIdToken(match[1], true); }
  catch (_) { throw Object.assign(new Error('Sessao invalida ou expirada.'), { statusCode: 401 }); }

  const snap = await db.collection('usuarios').doc(decoded.uid).get();
  const profile = snap.exists ? { uid: decoded.uid, ...snap.data() } : null;
  if (!profile || profile.ativo !== true || !['admin','consultant','instructor'].includes(profile.perfil)) {
    throw Object.assign(new Error('Usuario sem permissao para acessar a frota.'), { statusCode: 403 });
  }
  return { db, profile };
}

function requireEditor(profile) {
  if (!['admin','consultant'].includes(profile?.perfil)) {
    throw Object.assign(new Error('Seu perfil possui acesso somente de leitura.'), { statusCode: 403 });
  }
}

function jsonDoc(doc) {
  const data = doc.data() || {};
  const out = { docId: doc.id, ...data };
  Object.keys(out).forEach(key => {
    const v = out[key];
    if (v && typeof v.toDate === 'function') out[key] = v.toDate().toISOString();
  });
  return out;
}

async function ensureClient(db, name, origin, profile) {
  const client = clean(name, 180);
  if (!client) return null;
  const id = normalizeId(client);
  const ref = db.collection(col('clients')).doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      id,
      name: client,
      active: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      audit: trace(profile, origin, 'Cliente', '', client)
    });
  }
  return id;
}

function machinePayload(body) {
  const code = clean(body.codigo || body.code || body.machineCode, 50).toUpperCase();
  if (!code) throw Object.assign(new Error('Codigo da maquina obrigatorio.'), { statusCode: 400 });
  return {
    id: Number(body.id) || Date.now(),
    codigo: code,
    modelo: clean(body.modelo || body.model, 120),
    serie: clean(body.serie || body.serial, 120),
    familia: clean(body.familia || body.family || 'Outro', 60),
    cliente: clean(body.cliente || body.client, 180),
    local: clean(body.local || body.location, 180),
    horimetro: Math.max(0, Number(body.horimetro) || 0),
    tipoPropulsao: clean(body.tipoPropulsao || body.powerSource || 'Mecânico', 60),
    soc: body.soc === null || body.soc === undefined ? null : Math.max(0, Math.min(100, Number(body.soc) || 0)),
    status: clean(body.status || 'Operação normal', 60),
    consultor: clean(body.consultor, 160),
    ultimaAtualizacao: clean(body.ultimaAtualizacao || new Date().toISOString().slice(0,10), 20),
    classificacaoNecessidade: clean(body.classificacaoNecessidade || 'A definir', 80),
    evidenciaObservada: clean(body.evidenciaObservada, 1800),
    analiseTecnica: clean(body.analiseTecnica, 1800),
    necessidadeTreinamento: clean(body.necessidadeTreinamento, 1200),
    prioridadeTreinamento: clean(body.prioridadeTreinamento || 'Baixa', 40),
    observacoes: clean(body.observacoes, 2400),
    ciclosDisponiveis: body.ciclosDisponiveis === true,
    cargaDisponivel: body.cargaDisponivel === true,
    energiaDisponivel: body.energiaDisponivel === true,
    combustivelDisponivel: body.combustivelDisponivel === true,
    horimetroInicioEconomia: body.horimetroInicioEconomia ?? null,
    consumoEletricoKwhHora: body.consumoEletricoKwhHora ?? null,
    tarifaEnergia: body.tarifaEnergia ?? null,
    consumoDieselReferenciaLHora: body.consumoDieselReferenciaLHora ?? null,
    precoDiesel: body.precoDiesel ?? null,
    historicoCustos: Array.isArray(body.historicoCustos) ? body.historicoCustos.slice(0,100) : []
  };
}

async function listAll(db) {
  const [machinesSnap, eventsSnap, actionsSnap, clientsSnap] = await Promise.all([
    db.collection(col('machines')).orderBy('codigo').limit(1000).get(),
    db.collection(col('fleetEvents')).orderBy('recordedAt','desc').limit(2000).get(),
    db.collection(col('fleetActions')).orderBy('createdAt','desc').limit(1000).get(),
    db.collection(col('clients')).orderBy('name').limit(1000).get()
  ]);

  return {
    machines: machinesSnap.docs.map(jsonDoc),
    events: eventsSnap.docs.map(jsonDoc),
    actions: actionsSnap.docs.map(jsonDoc),
    clients: clientsSnap.docs.map(jsonDoc)
  };
}

module.exports = async function handler(req, res) {
  try {
    const { db, profile } = await requireUser(req);

    if (req.method === 'GET') {
      const data = await listAll(db);
      return res.status(200).json({ ok: true, ...data });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow','GET, POST');
      return res.status(405).json({ error: 'Metodo nao permitido.' });
    }

    requireEditor(profile);
    const body = req.body || {};
    const action = clean(body.action, 60);

    if (action === 'upsert-machine') {
      const machine = machinePayload(body.machine || body);
      const clientId = await ensureClient(db, machine.cliente, 'Consultor', profile);
      const docId = normalizeId(machine.codigo);
      const ref = db.collection(col('machines')).doc(docId);
      const old = await ref.get();
      const createdAt = old.exists ? (old.data().createdAt || nowIso()) : nowIso();

      const stored = {
        ...machine,
        clientId,
        createdAt,
        updatedAt: nowIso(),
        audit: trace(profile, body.origin || (profile.perfil === 'admin' ? 'ADM' : 'Consultor'), 'Máquina', machine.codigo, machine.cliente)
      };
      await ref.set(stored, { merge: true });
      return res.status(200).json({ ok: true, machine: { docId, ...stored } });
    }

    if (action === 'add-event') {
      const machineCode = clean(body.machineCode, 50).toUpperCase();
      const client = clean(body.client, 180);
      if (!machineCode) return res.status(400).json({ error: 'Maquina obrigatoria.' });

      const event = {
        id: Number(body.id) || Date.now(),
        machineCode,
        machineName: clean(body.machineName, 120),
        client,
        date: clean(body.date || new Date().toISOString().slice(0,10), 20),
        type: clean(body.type || 'Acompanhamento', 100),
        classificacaoNecessidade: clean(body.classificacaoNecessidade || 'A definir', 80),
        evidenciaObservada: clean(body.evidenciaObservada, 1800),
        analiseTecnica: clean(body.analiseTecnica, 1800),
        necessidadeTreinamento: clean(body.necessidadeTreinamento, 1200),
        prioridadeTreinamento: clean(body.prioridadeTreinamento || 'Baixa', 40),
        proximaAcao: clean(body.proximaAcao, 1200),
        responsavel: clean(body.responsavel || profile.nome, 160),
        horimetro: body.horimetro ?? null,
        soc: body.soc ?? null,
        recordedAt: nowIso(),
        source: clean(body.origin || (profile.perfil === 'admin' ? 'ADM' : 'Consultor'), 80),
        audit: trace(profile, body.origin || (profile.perfil === 'admin' ? 'ADM' : 'Consultor'), 'Acompanhamento', machineCode, client)
      };
      const ref = await db.collection(col('fleetEvents')).add(event);
      return res.status(201).json({ ok: true, event: { docId: ref.id, ...event } });
    }

    if (action === 'upsert-action') {
      const machineCode = clean(body.machineCode, 50).toUpperCase();
      const text = clean(body.text || body.proximaAcao, 1200);
      const dueDate = clean(body.dueDate || body.prazo, 20);
      const client = clean(body.client, 180);
      if (!machineCode || !text) return res.status(400).json({ error: 'Maquina e proxima acao sao obrigatorias.' });
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'Prazo invalido.' });

      const actionId = clean(body.actionId, 120) || normalizeId(machineCode + '-' + text);
      const ref = db.collection(col('fleetActions')).doc(actionId);
      const snap = await ref.get();
      const createdAt = snap.exists ? (snap.data().createdAt || nowIso()) : nowIso();
      const stored = {
        id: actionId,
        machineCode,
        machineName: clean(body.machineName, 120),
        client,
        text,
        dueDate: dueDate || null,
        status: clean(body.status || 'Aberta', 40),
        responsible: clean(body.responsible || profile.nome, 160),
        createdAt,
        updatedAt: nowIso(),
        source: clean(body.origin || (profile.perfil === 'admin' ? 'ADM' : 'Consultor'), 80),
        audit: trace(profile, body.origin || (profile.perfil === 'admin' ? 'ADM' : 'Consultor'), 'Ação', machineCode, client)
      };
      await ref.set(stored, { merge: true });
      return res.status(200).json({ ok: true, fleetAction: stored });
    }

    if (action === 'complete-action') {
      const actionId = clean(body.actionId, 120);
      if (!actionId) return res.status(400).json({ error: 'Acao invalida.' });
      const ref = db.collection(col('fleetActions')).doc(actionId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: 'Acao nao encontrada.' });
      const current = snap.data() || {};
      await ref.set({
        status: 'Concluída',
        completedAt: nowIso(),
        completedBy: clean(profile.nome,160),
        updatedAt: nowIso(),
        audit: trace(profile, profile.perfil === 'admin' ? 'ADM' : 'Consultor', 'Ação concluída', current.machineCode, current.client)
      }, { merge: true });
      return res.status(200).json({ ok: true });
    }

    if (action === 'migrate-local') {
      const machines = Array.isArray(body.machines) ? body.machines.slice(0,1000) : [];
      let machineCount = 0, eventCount = 0, actionCount = 0;

      for (const raw of machines) {
        const machine = machinePayload(raw || {});
        const clientId = await ensureClient(db, machine.cliente, 'Importação', profile);
        const docId = normalizeId(machine.codigo);
        const ref = db.collection(col('machines')).doc(docId);
        const exists = await ref.get();

        if (!exists.exists) {
          await ref.set({
            ...machine,
            clientId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            audit: trace(profile, 'Importação', 'Máquina', machine.codigo, machine.cliente)
          });
          machineCount += 1;
        }

        const history = Array.isArray(raw.historico) ? raw.historico : [];
        for (const h of history.slice(0,500)) {
          const eventId = normalizeId(machine.codigo + '-' + (h.id || h.data || eventCount));
          const eRef = db.collection(col('fleetEvents')).doc(eventId);
          const eSnap = await eRef.get();
          if (eSnap.exists) continue;
          await eRef.set({
            id: Number(h.id) || Date.now(),
            machineCode: machine.codigo,
            machineName: machine.modelo,
            client: machine.cliente,
            date: clean(h.data || machine.ultimaAtualizacao,20),
            type: clean(h.tipo || 'Acompanhamento',100),
            classificacaoNecessidade: clean(h.classificacaoNecessidade || 'A definir',80),
            evidenciaObservada: clean(h.evidenciaObservada,1800),
            analiseTecnica: clean(h.analiseTecnica || h.descricao,1800),
            necessidadeTreinamento: clean(h.necessidadeTreinamento,1200),
            prioridadeTreinamento: clean(h.prioridadeTreinamento || 'Baixa',40),
            proximaAcao: clean(h.proximaAcao,1200),
            responsavel: clean(h.responsavel,160),
            horimetro: h.horimetro ?? null,
            soc: h.soc ?? null,
            recordedAt: nowIso(),
            source: 'Importação',
            audit: trace(profile, 'Importação', 'Acompanhamento', machine.codigo, machine.cliente)
          });
          eventCount += 1;
        }

        const next = clean(raw.proximaAcao,1200);
        if (next) {
          const actionId = normalizeId(machine.codigo + '-' + next);
          const aRef = db.collection(col('fleetActions')).doc(actionId);
          const aSnap = await aRef.get();
          if (!aSnap.exists) {
            await aRef.set({
              id: actionId,
              machineCode: machine.codigo,
              machineName: machine.modelo,
              client: machine.cliente,
              text: next,
              dueDate: clean(raw.prazoAcao,20) || null,
              status: 'Aberta',
              responsible: clean(machine.consultor,160),
              createdAt: nowIso(),
              updatedAt: nowIso(),
              source: 'Importação',
              audit: trace(profile, 'Importação', 'Ação', machine.codigo, machine.cliente)
            });
            actionCount += 1;
          }
        }
      }

      return res.status(200).json({ ok: true, migrated: { machines: machineCount, events: eventCount, actions: actionCount } });
    }

    return res.status(400).json({ error: 'Acao nao reconhecida.' });
  } catch (err) {
    console.error('fleet-data:', err);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Falha ao acessar dados da frota.' });
  }
};
