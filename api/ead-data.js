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

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

function docId(value) {
  return clean(value, 120)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || String(Date.now());
}

function nowIso() { return new Date().toISOString(); }

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
  if (!profile || profile.ativo !== true || !['admin','instructor'].includes(profile.perfil)) {
    throw Object.assign(new Error('Usuario sem permissao para acessar dados do EAD.'), { statusCode: 403 });
  }
  return { db, profile };
}

function requireAdmin(profile) {
  if (profile.perfil !== 'admin') {
    throw Object.assign(new Error('Somente ADM pode executar esta operacao.'), { statusCode: 403 });
  }
}

function trace(profile, type) {
  return {
    actorUid: profile.uid,
    actorName: clean(profile.nome || profile.email || 'ADM',160),
    actorRole: profile.perfil,
    recordedAt: nowIso(),
    source: profile.perfil === 'admin' ? 'ADM' : 'Instrutor',
    recordType: type
  };
}

function jsonDoc(doc) {
  const data = doc.data() || {};
  const out = { docId: doc.id, ...data };
  Object.keys(out).forEach(k => {
    const v = out[k];
    if (v && typeof v.toDate === 'function') out[k] = v.toDate().toISOString();
  });
  return out;
}

async function listStructured(db) {
  const [skillsSnap, plansSnap, peopleSnap, needsSnap] = await Promise.all([
    db.collection(col('skills')).orderBy('id').limit(2000).get(),
    db.collection(col('plans')).orderBy('id').limit(5000).get(),
    db.collection(col('people')).orderBy('name').limit(1000).get(),
    db.collection(col('trainingNeeds')).orderBy('updatedAt','desc').limit(1000).get()
  ]);
  return {
    skills: skillsSnap.docs.map(jsonDoc),
    plans: plansSnap.docs.map(jsonDoc),
    people: peopleSnap.docs.map(d => (d.data() || {}).name).filter(Boolean),
    trainingDemands: needsSnap.docs.map(jsonDoc)
  };
}

async function reconcileCollection(db, collectionName, items, idGetter, profile, type) {
  const ref = db.collection(col(collectionName));
  const snap = await ref.get();
  const incoming = new Map();
  (items || []).forEach(item => incoming.set(String(idGetter(item)), item));

  const batch = db.batch();
  snap.docs.forEach(doc => {
    if (!incoming.has(doc.id)) batch.delete(doc.ref);
  });

  incoming.forEach((item, id) => {
    const refDoc = ref.doc(id);
    batch.set(refDoc, {
      ...item,
      updatedAt: nowIso(),
      audit: trace(profile, type)
    }, { merge: true });
  });

  await batch.commit();
}

module.exports = async function handler(req, res) {
  try {
    const { db, profile } = await requireUser(req);

    if (req.method === 'GET') {
      const structured = await listStructured(db);
      const shared = await db.collection('sistema').doc('sharedData').get();
      const legacy = shared.exists ? shared.data() || {} : {};
      return res.status(200).json({
        ok: true,
        ...structured,
        needsMigration: structured.skills.length === 0 && Array.isArray(legacy.skills) && legacy.skills.length > 0,
        legacyCounts: {
          skills: Array.isArray(legacy.skills) ? legacy.skills.length : 0,
          plans: Array.isArray(legacy.plans) ? legacy.plans.length : 0,
          people: Array.isArray(legacy.people) ? legacy.people.length : 0
        }
      });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow','GET, POST');
      return res.status(405).json({ error: 'Metodo nao permitido.' });
    }

    const body = req.body || {};
    const action = clean(body.action,80);

    if (action === 'migrate-shared') {
      requireAdmin(profile);
      const shared = await db.collection('sistema').doc('sharedData').get();
      if (!shared.exists) return res.status(404).json({ error: 'Documento legado nao encontrado.' });
      const legacy = shared.data() || {};
      await reconcileCollection(db,'skills',Array.isArray(legacy.skills)?legacy.skills:[],s=>String(s.id),profile,'Habilidade importada');
      await reconcileCollection(db,'plans',Array.isArray(legacy.plans)?legacy.plans:[],p=>String(p.id),profile,'Planejamento importado');

      const people = Array.isArray(legacy.people) ? legacy.people : [];
      const peopleRef = db.collection(col('people'));
      const batch = db.batch();
      people.forEach(name => {
        const id = docId(name);
        batch.set(peopleRef.doc(id), {
          id,
          name: clean(name,160),
          active: true,
          updatedAt: nowIso(),
          audit: trace(profile,'Pessoa importada')
        }, { merge: true });
      });
      await batch.commit();

      const structured = await listStructured(db);
      return res.status(200).json({ ok: true, ...structured });
    }

    if (action === 'sync-state') {
      requireAdmin(profile);
      const skills = Array.isArray(body.skills) ? body.skills.slice(0,2000) : [];
      const plans = Array.isArray(body.plans) ? body.plans.slice(0,5000) : [];
      const people = Array.isArray(body.people) ? body.people.slice(0,1000) : [];

      await reconcileCollection(db,'skills',skills,s=>String(s.id),profile,'Habilidade');
      await reconcileCollection(db,'plans',plans,p=>String(p.id),profile,'Planejamento');

      const peopleRef = db.collection(col('people'));
      const existing = await peopleRef.get();
      const wanted = new Set(people.map(name=>docId(name)));
      const batch = db.batch();
      existing.docs.forEach(doc=>{if(!wanted.has(doc.id))batch.delete(doc.ref);});
      people.forEach(name=>{
        const id=docId(name);
        batch.set(peopleRef.doc(id),{
          id,name:clean(name,160),active:true,updatedAt:nowIso(),audit:trace(profile,'Pessoa')
        },{merge:true});
      });
      await batch.commit();

      return res.status(200).json({ ok: true });
    }

    if (action === 'upsert-skill') {
      const skill = body.skill && typeof body.skill === 'object' ? body.skill : null;
      if (!skill || !Number.isFinite(Number(skill.id))) return res.status(400).json({ error: 'Habilidade invalida.' });
      if (profile.perfil === 'instructor' && String(skill.owner || '') !== String(profile.nome || '')) {
        return res.status(403).json({ error: 'Instrutor so pode alterar habilidade atribuida a ele.' });
      }
      const ref = db.collection(col('skills')).doc(String(skill.id));
      await ref.set({ ...skill, updatedAt: nowIso(), audit: trace(profile,'Habilidade') }, { merge: true });
      return res.status(200).json({ ok: true, skill });
    }

    return res.status(400).json({ error: 'Acao nao reconhecida.' });
  } catch (err) {
    console.error('ead-data:', err);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Falha ao acessar dados estruturados do EAD.' });
  }
};
