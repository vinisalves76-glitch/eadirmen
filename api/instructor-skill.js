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

function clean(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function instructorOwnsSkill(profileName, ownerName) {
  const profile = normalizeName(profileName);
  const owner = normalizeName(ownerName);
  if (!profile || !owner) return false;
  if (profile === owner) return true;

  // Current legacy data stores some owners using only the first name
  // (ex.: "Vinicius"), while the authenticated profile contains the full name.
  const ownerParts = owner.split(' ').filter(Boolean);
  const profileParts = profile.split(' ').filter(Boolean);
  return ownerParts.length === 1 && profileParts[0] === ownerParts[0];
}

function normalizeMaterials(value) {
  if (!Array.isArray(value)) return [];
  const allowedStatus = new Set(['Pendente', 'Em produção', 'Finalizado']);
  return value.slice(0, 30).map((item, index) => ({
    id: Number(item && item.id) || Date.now() + index,
    type: clean(item && item.type, 80) || 'Outro',
    description: clean(item && item.description, 500),
    status: allowedStatus.has(item && item.status) ? item.status : 'Pendente'
  }));
}

function normalizeWorkflow(value) {
  const source = value && typeof value === 'object' ? value : {};
  const productionAllowed = new Set(['Não iniciado', 'Em produção', 'Finalizado']);
  const reviewAllowed = new Set(['Não iniciado', 'Em revisão', 'Aprovado']);
  const finalAllowed = new Set(['Não iniciado', 'Em finalização', 'Finalizado']);

  return {
    production: productionAllowed.has(source.production) ? source.production : 'Não iniciado',
    review: reviewAllowed.has(source.review) ? source.review : 'Não iniciado',
    finalization: finalAllowed.has(source.finalization) ? source.finalization : 'Não iniciado'
  };
}

function calculateWorkflow(skill) {
  const objectiveOk = clean(skill.objective).length > 0;
  const developmentOk = clean(skill.development).length > 0;
  const durationOk = clean(skill.duration, 120).length > 0;
  const planningScore = [objectiveOk, developmentOk, durationOk].filter(Boolean).length / 3;
  const planningDone = objectiveOk && developmentOk && durationOk;

  let materialScore = 0;
  let materialsDone = false;
  if (skill.noMaterials === true) {
    materialScore = 1;
    materialsDone = true;
  } else if (skill.materials.length) {
    materialScore = skill.materials.reduce((sum, material) => {
      if (material.status === 'Finalizado') return sum + 1;
      if (material.status === 'Em produção') return sum + 0.5;
      return sum;
    }, 0) / skill.materials.length;
    materialsDone = skill.materials.every(material => material.status === 'Finalizado');
  }

  if (!(planningDone && materialsDone)) {
    skill.workflow.production = 'Não iniciado';
    skill.workflow.review = 'Não iniciado';
    skill.workflow.finalization = 'Não iniciado';
  } else if (skill.workflow.production !== 'Finalizado') {
    skill.workflow.review = 'Não iniciado';
    skill.workflow.finalization = 'Não iniciado';
  } else if (skill.workflow.review !== 'Aprovado') {
    skill.workflow.finalization = 'Não iniciado';
  }

  const productionScore = skill.workflow.production === 'Finalizado' ? 1 : skill.workflow.production === 'Em produção' ? 0.5 : 0;
  const productionDone = skill.workflow.production === 'Finalizado';
  const reviewScore = skill.workflow.review === 'Aprovado' ? 1 : skill.workflow.review === 'Em revisão' ? 0.5 : 0;
  const reviewDone = skill.workflow.review === 'Aprovado';
  const finalScore = skill.workflow.finalization === 'Finalizado' ? 1 : skill.workflow.finalization === 'Em finalização' ? 0.5 : 0;
  const finalDone = skill.workflow.finalization === 'Finalizado';

  const progress = Math.round((planningScore + materialScore + productionScore + reviewScore + finalScore) * 20);

  let status = 'Planejamento';
  if (finalDone) status = 'Concluída';
  else if (productionDone || skill.workflow.review !== 'Não iniciado' || skill.workflow.finalization !== 'Não iniciado') status = 'Em revisão';
  else if (planningDone || skill.materials.length || skill.noMaterials || skill.workflow.production === 'Em produção') status = 'Em produção';

  skill.progress = progress;
  skill.status = status;
  return skill;
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

  if (!profile || profile.ativo !== true || !['admin', 'instructor'].includes(profile.perfil)) {
    const err = new Error('Usuario sem permissao para salvar esta habilidade.');
    err.statusCode = 403;
    throw err;
  }

  return { app, db, decoded, profile };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Metodo nao permitido.' });
  }

  try {
    const { db, profile } = await requireUser(req);
    const body = req.body || {};
    const skillId = Number(body.skillId);

    if (!Number.isFinite(skillId)) {
      return res.status(400).json({ error: 'Habilidade invalida.' });
    }

    const sharedRef = db.collection('sistema').doc('sharedData');

    const updatedSkill = await db.runTransaction(async transaction => {
      const snap = await transaction.get(sharedRef);
      if (!snap.exists) {
        const err = new Error('Dados do treinamento nao encontrados.');
        err.statusCode = 404;
        throw err;
      }

      const shared = snap.data() || {};
      const skills = Array.isArray(shared.skills) ? shared.skills.slice() : [];
      const index = skills.findIndex(skill => Number(skill && skill.id) === skillId);

      if (index < 0) {
        const err = new Error('Habilidade nao encontrada.');
        err.statusCode = 404;
        throw err;
      }

      const current = { ...skills[index] };

      if (profile.perfil === 'instructor' && !instructorOwnsSkill(profile.nome, current.owner)) {
        const err = new Error('Esta habilidade nao esta atribuida a voce.');
        err.statusCode = 403;
        throw err;
      }

      const next = {
        ...current,
        objective: clean(body.objective, 4000),
        development: clean(body.development, 8000),
        duration: clean(body.duration, 120),
        materials: normalizeMaterials(body.materials),
        noMaterials: body.noMaterials === true,
        workflow: normalizeWorkflow(body.workflow)
      };

      calculateWorkflow(next);
      skills[index] = next;

      transaction.update(sharedRef, {
        skills,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      });

      return next;
    });

    return res.status(200).json({ ok: true, skill: updatedSkill });
  } catch (err) {
    console.error('instructor-skill:', err);
    return res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : 'Nao foi possivel salvar as alteracoes.'
    });
  }
};
