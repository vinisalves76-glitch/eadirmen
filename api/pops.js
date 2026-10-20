const admin = require('firebase-admin');
const crypto = require('crypto');

function getAdminApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw Object.assign(new Error('FIREBASE_SERVICE_ACCOUNT nao configurada.'), { statusCode: 503 });
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch (_) { throw Object.assign(new Error('Configuracao do Firebase invalida.'), { statusCode: 503 }); }
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'eadirmen-a6693.firebasestorage.app'
  });
}

function col(name) {
  return String(process.env.VERCEL_ENV || '').toLowerCase() !== 'production' ? 'preview_' + name : name;
}
function clean(value, max = 2000) { return String(value ?? '').trim().slice(0, max); }
function nowIso() { return new Date().toISOString(); }
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

async function requireUser(req) {
  const app = getAdminApp(), auth = app.auth(), db = app.firestore();
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) throw fail('Sessao nao informada.', 401);
  let decoded;
  try { decoded = await auth.verifyIdToken(match[1], true); }
  catch (_) { throw fail('Sessao invalida ou expirada.', 401); }
  const snap = await db.collection('usuarios').doc(decoded.uid).get();
  const profile = snap.exists ? { uid: decoded.uid, ...snap.data() } : null;
  if (!profile || profile.ativo !== true || !['admin', 'instructor', 'mechanic'].includes(profile.perfil)) {
    throw fail('Usuario sem permissao para acessar os POPs.', 403);
  }
  return { db, profile };
}
function requireRole(profile, roles) {
  if (!roles.includes(profile.perfil)) throw fail('Seu perfil nao tem permissao para esta operacao.', 403);
}
function jsonDoc(doc) {
  return { id: doc.id, ...(doc.data() || {}) };
}
function trace(profile, action, comment = '') {
  return {
    action,
    actorUid: profile.uid,
    actorName: clean(profile.nome || profile.email || 'Usuario', 160),
    actorRole: profile.perfil,
    comment: clean(comment, 2000),
    at: nowIso()
  };
}
function normalizeSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((step, index) => ({
    number: index + 1,
    title: clean(step && step.title, 180),
    instruction: clean(step && step.instruction, 4000),
    warning: clean(step && step.warning, 1500),
    imageUrl: clean(step && step.imageUrl, 1200),
    videoUrl: clean(step && step.videoUrl, 1200)
  })).filter(step => step.title || step.instruction || step.imageUrl || step.videoUrl);
}
function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(item => ({
    title: clean(item && item.title, 180),
    type: ['PDF', 'Manual', 'Vídeo', 'Diagrama', 'Outro'].includes(item && item.type) ? item.type : 'Outro',
    url: clean(item && item.url, 1200)
  })).filter(item => item.title && /^https:\/\//i.test(item.url));
}
function validatePop(body) {
  const pop = {
    title: clean(body.title, 180),
    equipment: clean(body.equipment, 120),
    model: clean(body.model, 120),
    category: clean(body.category, 100),
    objective: clean(body.objective, 2500),
    scope: clean(body.scope, 2500),
    safety: clean(body.safety, 4000),
    materials: clean(body.materials, 2500),
    steps: normalizeSteps(body.steps),
    attachments: normalizeAttachments(body.attachments),
    revision: clean(body.revision, 40) || '00'
  };
  if (!pop.title || !pop.equipment || !pop.objective) throw fail('Preencha título, equipamento e objetivo.');
  if (!pop.steps.length) throw fail('Adicione pelo menos uma etapa ao procedimento.');
  if (pop.steps.some(step => !step.title || !step.instruction)) throw fail('Cada etapa precisa ter titulo e instrucao.');
  for (const step of pop.steps) {
    for (const url of [step.imageUrl, step.videoUrl]) {
      if (url && !/^https:\/\//i.test(url)) throw fail('Links de imagens e vídeos devem usar HTTPS.');
    }
  }
  return pop;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const { db, profile } = await requireUser(req);
    const ref = db.collection(col('pops'));

    if (req.method === 'GET') {
      const snap = await ref.orderBy('updatedAt', 'desc').limit(500).get();
      const items = snap.docs.map(jsonDoc);
      const visible = profile.perfil === 'mechanic'
        ? items.filter(item => item.status === 'published')
        : items;
      return res.status(200).json({ ok: true, pops: visible, profile: { uid: profile.uid, nome: clean(profile.nome || '', 160), email: clean(profile.email || '', 200), perfil: profile.perfil, ativo: profile.ativo === true } });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Metodo nao permitido.' });
    }

    const body = req.body || {};
    const action = clean(body.action, 40);

    if (action === 'save') {
      requireRole(profile, ['admin', 'instructor']);
      const data = validatePop(body.pop || {});
      const id = clean(body.id, 120) || crypto.randomUUID();
      const docRef = ref.doc(id);
      const currentSnap = await docRef.get();
      const current = currentSnap.exists ? currentSnap.data() : null;
      if (current) {
        if (profile.perfil !== 'admin' && current.ownerUid !== profile.uid) throw fail('Voce so pode editar seus proprios POPs.', 403);
        if (!['draft', 'changes_requested'].includes(current.status)) throw fail('Este POP nao pode ser editado no status atual. Solicite uma revisao ao ADM.', 409);
      }
      const now = nowIso();
      const record = {
        ...data,
        ownerUid: current ? current.ownerUid : profile.uid,
        ownerName: current ? current.ownerName : clean(profile.nome || profile.email, 160),
        status: current ? current.status : 'draft',
        createdAt: current ? current.createdAt : now,
        updatedAt: now,
        history: [...(Array.isArray(current && current.history) ? current.history : []), trace(profile, current ? 'saved_changes' : 'created')],
        audit: current && current.audit ? current.audit : null
      };
      await docRef.set(record);
      return res.status(200).json({ ok: true, pop: { id, ...record } });
    }

    if (action === 'submit') {
      requireRole(profile, ['admin', 'instructor']);
      const id = clean(body.id, 120);
      if (!id) throw fail('POP nao informado.');
      const docRef = ref.doc(id), snap = await docRef.get();
      if (!snap.exists) throw fail('POP nao encontrado.', 404);
      const current = snap.data();
      if (profile.perfil !== 'admin' && current.ownerUid !== profile.uid) throw fail('Voce so pode enviar seus proprios POPs.', 403);
      if (!['draft', 'changes_requested'].includes(current.status)) throw fail('Somente rascunhos ou POPs devolvidos podem ser enviados para auditoria.', 409);
      if (!current.title || !current.equipment || !current.objective || !Array.isArray(current.steps) || !current.steps.length) throw fail('O POP precisa ter titulo, equipamento, objetivo e pelo menos uma etapa.');
      const now = nowIso();
      const next = { ...current, status: 'pending_review', submittedAt: now, updatedAt: now,
        history: [...(Array.isArray(current.history) ? current.history : []), trace(profile, 'submitted_for_audit')] };
      await docRef.set(next);
      return res.status(200).json({ ok: true, pop: { id, ...next } });
    }

    if (action === 'audit') {
      requireRole(profile, ['admin']);
      const id = clean(body.id, 120);
      const decision = clean(body.decision, 30);
      const comment = clean(body.comment, 2000);
      if (!id || !['approve', 'return'].includes(decision)) throw fail('Informe o POP e a decisao da auditoria.');
      if (decision === 'return' && !comment) throw fail('Informe o motivo da devolucao para correcao.');
      const docRef = ref.doc(id), snap = await docRef.get();
      if (!snap.exists) throw fail('POP nao encontrado.', 404);
      const current = snap.data();
      if (current.status !== 'pending_review') throw fail('Somente POPs pendentes de auditoria podem ser auditados.', 409);
      const now = nowIso();
      const approved = decision === 'approve';
      const audit = { decision: approved ? 'approved' : 'returned', auditorUid: profile.uid,
        auditorName: clean(profile.nome || profile.email, 160), comment, auditedAt: now };
      const next = {
        ...current,
        status: approved ? 'published' : 'changes_requested',
        audit,
        publishedAt: approved ? now : null,
        publishedBy: approved ? audit.auditorName : null,
        updatedAt: now,
        history: [...(Array.isArray(current.history) ? current.history : []), trace(profile, approved ? 'approved_and_published' : 'returned_for_correction', comment)]
      };
      await docRef.set(next);
      return res.status(200).json({ ok: true, pop: { id, ...next } });
    }

    return res.status(400).json({ error: 'Acao invalida.' });
  } catch (err) {
    console.error('pops:', err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: status === 500 ? 'Falha interna ao processar o POP.' : err.message });
  }
};
