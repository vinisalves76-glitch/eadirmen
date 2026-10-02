const admin = require('firebase-admin');

function getAdminApp() {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    const err = new Error('O servidor ainda nao esta configurado para salvar alteracoes.');
    err.statusCode = 503;
    throw err;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (_) {
    const err = new Error('Configuracao do servidor invalida.');
    err.statusCode = 503;
    throw err;
  }

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function numberId(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const err = new Error('Demanda invalida.');
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function nowIso() {
  return new Date().toISOString();
}

function priorityRank(value) {
  return ({ Baixa: 1, 'Média': 2, Alta: 3, 'Crítica': 4 })[value] || 1;
}

function maxPriority(a, b) {
  return priorityRank(b) > priorityRank(a) ? b : a;
}

function workflowSkill() {
  return {
    materials: [],
    noMaterials: false,
    productionOutputs: [],
    legacyProductionComplete: false,
    workflow: {
      production: 'Não iniciado',
      review: 'Não iniciado',
      finalization: 'Não iniciado'
    }
  };
}

async function requireUser(req) {
  const app = getAdminApp();
  const auth = app.auth();
  const db = app.firestore();

  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) {
    const err = new Error('Sessao nao informada.');
    err.statusCode = 401;
    throw err;
  }

  let decoded;
  try {
    decoded = await auth.verifyIdToken(match[1], true);
  } catch (_) {
    const err = new Error('Sua sessao expirou. Entre novamente.');
    err.statusCode = 401;
    throw err;
  }

  const profileSnap = await db.collection('usuarios').doc(decoded.uid).get();
  const profile = profileSnap.exists ? profileSnap.data() : null;

  if (!profile || profile.ativo !== true || !['admin', 'consultant', 'instructor'].includes(profile.perfil)) {
    const err = new Error('Usuario sem permissao para acessar demandas de treinamento.');
    err.statusCode = 403;
    throw err;
  }

  return { db, decoded, profile };
}

function requireRole(profile, allowed) {
  if (!allowed.includes(profile.perfil)) {
    const err = new Error('Seu perfil nao tem permissao para executar esta acao.');
    err.statusCode = 403;
    throw err;
  }
}

function activeDemand(demand) {
  return ['Pendente ADM', 'Em produção', 'Pronto para aplicação', 'Em acompanhamento'].includes(demand && demand.status);
}

function occurrenceFromBody(body, profile, phase) {
  return {
    id: Date.now(),
    data: clean(body.eventDate, 20) || new Date().toISOString().slice(0, 10),
    evidencia: clean(body.evidence, 1800),
    analiseTecnica: clean(body.analysis, 1800),
    tema: clean(body.trainingNeed, 300),
    prioridade: clean(body.priority, 30) || 'Baixa',
    responsavel: clean(profile.nome, 120) || 'Consultor de Treinamento',
    fase: phase,
    registradoEm: nowIso()
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Metodo nao permitido.' });
  }

  try {
    const { db, profile } = await requireUser(req);
    const body = req.body || {};
    const action = clean(body.action, 60);
    const sharedRef = db.collection('sistema').doc('sharedData');

    if (action === 'register-occurrence') {
      requireRole(profile, ['admin', 'consultant']);

      const machineCode = clean(body.machineCode, 40).toUpperCase();
      const trainingNeed = clean(body.trainingNeed, 300);
      if (!machineCode) return res.status(400).json({ error: 'Codigo da maquina obrigatorio.' });
      if (!trainingNeed) return res.status(400).json({ error: 'Descreva a necessidade de treinamento.' });

      const result = await db.runTransaction(async transaction => {
        const snap = await transaction.get(sharedRef);
        if (!snap.exists) {
          const err = new Error('Dados compartilhados do EAD nao encontrados.');
          err.statusCode = 404;
          throw err;
        }

        const shared = snap.data() || {};
        const demands = Array.isArray(shared.trainingDemands) ? shared.trainingDemands.slice() : [];
        const topicKey = normalize(trainingNeed);

        let index = demands.findIndex(d =>
          activeDemand(d) &&
          clean(d.machineCode, 40).toUpperCase() === machineCode &&
          normalize(d.topic || d.trainingNeed) === topicKey
        );

        if (index < 0) {
          const sameMachineActive = demands
            .map((d, i) => ({ d, i }))
            .filter(x => activeDemand(x.d) && clean(x.d.machineCode, 40).toUpperCase() === machineCode);
          if (sameMachineActive.length === 1) index = sameMachineActive[0].i;
        }

        if (index >= 0) {
          const current = { ...demands[index] };
          const phase = current.status === 'Em acompanhamento' ? 'Após treinamento' : 'Antes do treinamento';
          const occurrence = occurrenceFromBody(body, profile, phase);

          current.preTrainingOccurrences = Array.isArray(current.preTrainingOccurrences) ? current.preTrainingOccurrences.slice() : [];
          current.postTrainingOccurrences = Array.isArray(current.postTrainingOccurrences) ? current.postTrainingOccurrences.slice() : [];

          if (phase === 'Após treinamento') current.postTrainingOccurrences.push(occurrence);
          else current.preTrainingOccurrences.push(occurrence);

          current.evidence = clean(body.evidence, 1800) || current.evidence || '';
          current.analysis = clean(body.analysis, 1800) || current.analysis || '';
          current.topic = trainingNeed || current.topic || '';
          current.priority = maxPriority(current.priority || 'Baixa', clean(body.priority, 30) || 'Baixa');
          current.updatedAt = nowIso();
          current.lastOccurrenceAt = occurrence.data;

          demands[index] = current;
          transaction.update(sharedRef, {
            trainingDemands: demands,
            atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
          });

          return { demand: current, created: false, phase };
        }

        const occurrence = occurrenceFromBody(body, profile, 'Antes do treinamento');
        const demand = {
          id: Date.now(),
          status: 'Pendente ADM',
          machineCode,
          machineName: clean(body.machineName, 120),
          machineFamily: clean(body.machineFamily, 50),
          client: clean(body.client, 160),
          location: clean(body.location, 160),
          topic: trainingNeed,
          evidence: clean(body.evidence, 1800),
          analysis: clean(body.analysis, 1800),
          priority: clean(body.priority, 30) || 'Baixa',
          source: 'fleet',
          sourceLabel: 'Acompanhamento de Frotas',
          createdAt: nowIso(),
          createdBy: clean(profile.nome, 120) || 'Consultor de Treinamento',
          updatedAt: nowIso(),
          preTrainingOccurrences: [occurrence],
          postTrainingOccurrences: [],
          linkedSkillId: null,
          assignedInstructor: '',
          approvedAt: null,
          appliedAt: null,
          closedAt: null
        };

        demands.unshift(demand);
        transaction.update(sharedRef, {
          trainingDemands: demands,
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        });

        return { demand, created: true, phase: 'Antes do treinamento' };
      });

      return res.status(200).json({ ok: true, ...result });
    }

    if (action === 'approve') {
      requireRole(profile, ['admin']);
      const demandId = numberId(body.demandId);
      const title = clean(body.title, 240);
      const owner = clean(body.owner, 120);
      const level = clean(body.level, 40) || 'Básica';
      const duration = clean(body.duration, 60) || '5 min';

      if (!title) return res.status(400).json({ error: 'Informe o titulo da habilidade.' });
      if (!owner) return res.status(400).json({ error: 'Selecione o instrutor responsavel.' });

      const result = await db.runTransaction(async transaction => {
        const snap = await transaction.get(sharedRef);
        if (!snap.exists) {
          const err = new Error('Dados compartilhados do EAD nao encontrados.');
          err.statusCode = 404;
          throw err;
        }

        const shared = snap.data() || {};
        const demands = Array.isArray(shared.trainingDemands) ? shared.trainingDemands.slice() : [];
        const skills = Array.isArray(shared.skills) ? shared.skills.slice() : [];
        const plans = Array.isArray(shared.plans) ? shared.plans.slice() : [];
        const people = Array.isArray(shared.people) ? shared.people.slice() : [];

        const index = demands.findIndex(d => Number(d && d.id) === demandId);
        if (index < 0) {
          const err = new Error('Demanda nao encontrada.');
          err.statusCode = 404;
          throw err;
        }

        const demand = { ...demands[index] };
        if (demand.linkedSkillId) {
          const err = new Error('Esta demanda ja possui uma habilidade vinculada.');
          err.statusCode = 409;
          throw err;
        }
        if (demand.status !== 'Pendente ADM') {
          const err = new Error('Somente demandas pendentes podem ser aprovadas.');
          err.statusCode = 409;
          throw err;
        }

        if (people.length && !people.some(p => normalize(p) === normalize(owner))) {
          const err = new Error('Instrutor selecionado nao esta cadastrado na equipe.');
          err.statusCode = 400;
          throw err;
        }

        const nextSkillId = Math.max(0, ...skills.map(s => Number(s && s.id) || 0), Date.now() - 1) + 1;
        const nextPlanId = Math.max(0, ...plans.map(p => Number(p && p.id) || 0), Date.now() - 1) + 1;
        const base = workflowSkill();

        const skill = {
          id: nextSkillId,
          title,
          level,
          owner,
          status: 'Planejamento',
          progress: 0,
          duration,
          objective: '',
          development: '',
          ...base,
          source: 'fleet-demand',
          demandId: demand.id,
          sourceMachineCode: demand.machineCode || '',
          sourceMachineName: demand.machineName || '',
          sourceClient: demand.client || '',
          sourceEvidence: demand.evidence || '',
          sourceTopic: demand.topic || ''
        };

        skills.push(skill);
        plans.push({
          id: nextPlanId,
          person: owner,
          skillId: nextSkillId,
          week: 'Semana atual',
          source: 'fleet-demand',
          demandId: demand.id
        });

        demand.status = 'Em produção';
        demand.linkedSkillId = nextSkillId;
        demand.assignedInstructor = owner;
        demand.skillTitle = title;
        demand.skillLevel = level;
        demand.approvedAt = nowIso();
        demand.approvedBy = clean(profile.nome, 120) || 'ADM';
        demand.updatedAt = nowIso();
        demands[index] = demand;

        transaction.update(sharedRef, {
          skills,
          plans,
          trainingDemands: demands,
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        });

        return { demand, skill };
      });

      return res.status(200).json({ ok: true, ...result });
    }

    if (action === 'reject') {
      requireRole(profile, ['admin']);
      const demandId = numberId(body.demandId);
      const reason = clean(body.reason, 1200);

      const demand = await db.runTransaction(async transaction => {
        const snap = await transaction.get(sharedRef);
        if (!snap.exists) throw Object.assign(new Error('Dados compartilhados do EAD nao encontrados.'), { statusCode: 404 });
        const shared = snap.data() || {};
        const demands = Array.isArray(shared.trainingDemands) ? shared.trainingDemands.slice() : [];
        const index = demands.findIndex(d => Number(d && d.id) === demandId);
        if (index < 0) throw Object.assign(new Error('Demanda nao encontrada.'), { statusCode: 404 });

        const current = { ...demands[index] };
        if (current.linkedSkillId) throw Object.assign(new Error('A demanda ja possui habilidade vinculada.'), { statusCode: 409 });

        current.status = 'Não aprovada';
        current.rejectionReason = reason;
        current.rejectedAt = nowIso();
        current.rejectedBy = clean(profile.nome, 120) || 'ADM';
        current.updatedAt = nowIso();
        demands[index] = current;

        transaction.update(sharedRef, {
          trainingDemands: demands,
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
        return current;
      });

      return res.status(200).json({ ok: true, demand });
    }

    if (action === 'mark-applied') {
      requireRole(profile, ['admin', 'consultant']);
      const demandId = numberId(body.demandId);
      const notes = clean(body.notes, 1600);

      const demand = await db.runTransaction(async transaction => {
        const snap = await transaction.get(sharedRef);
        if (!snap.exists) throw Object.assign(new Error('Dados compartilhados do EAD nao encontrados.'), { statusCode: 404 });

        const shared = snap.data() || {};
        const demands = Array.isArray(shared.trainingDemands) ? shared.trainingDemands.slice() : [];
        const skills = Array.isArray(shared.skills) ? shared.skills : [];
        const index = demands.findIndex(d => Number(d && d.id) === demandId);
        if (index < 0) throw Object.assign(new Error('Demanda nao encontrada.'), { statusCode: 404 });

        const current = { ...demands[index] };
        const skill = skills.find(s => Number(s && s.id) === Number(current.linkedSkillId));
        const complete = skill && (skill.status === 'Concluída' || (skill.workflow && skill.workflow.finalization === 'Finalizado'));
        if (!complete) {
          const err = new Error('A microaula precisa estar concluida antes de registrar a aplicacao.');
          err.statusCode = 409;
          throw err;
        }

        current.status = 'Em acompanhamento';
        current.appliedAt = nowIso();
        current.appliedBy = clean(profile.nome, 120) || 'Equipe de Treinamento';
        current.applicationNotes = notes;
        current.followUpStartedAt = nowIso();
        current.updatedAt = nowIso();
        current.postTrainingOccurrences = Array.isArray(current.postTrainingOccurrences) ? current.postTrainingOccurrences : [];
        demands[index] = current;

        transaction.update(sharedRef, {
          trainingDemands: demands,
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
        return current;
      });

      return res.status(200).json({ ok: true, demand });
    }

    if (action === 'close') {
      requireRole(profile, ['admin', 'consultant']);
      const demandId = numberId(body.demandId);
      const outcome = clean(body.outcome, 100) || 'Encerrada';
      const notes = clean(body.notes, 1800);

      const demand = await db.runTransaction(async transaction => {
        const snap = await transaction.get(sharedRef);
        if (!snap.exists) throw Object.assign(new Error('Dados compartilhados do EAD nao encontrados.'), { statusCode: 404 });
        const shared = snap.data() || {};
        const demands = Array.isArray(shared.trainingDemands) ? shared.trainingDemands.slice() : [];
        const index = demands.findIndex(d => Number(d && d.id) === demandId);
        if (index < 0) throw Object.assign(new Error('Demanda nao encontrada.'), { statusCode: 404 });

        const current = { ...demands[index] };
        if (current.status !== 'Em acompanhamento') {
          const err = new Error('A demanda precisa estar em acompanhamento para ser encerrada.');
          err.statusCode = 409;
          throw err;
        }

        current.status = 'Concluída';
        current.outcome = outcome;
        current.outcomeNotes = notes;
        current.closedAt = nowIso();
        current.closedBy = clean(profile.nome, 120) || 'Equipe de Treinamento';
        current.updatedAt = nowIso();
        demands[index] = current;

        transaction.update(sharedRef, {
          trainingDemands: demands,
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
        return current;
      });

      return res.status(200).json({ ok: true, demand });
    }

    return res.status(400).json({ error: 'Acao de demanda nao reconhecida.' });
  } catch (err) {
    console.error('training-demands:', err);
    return res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : 'Nao foi possivel atualizar a demanda de treinamento.'
    });
  }
};
