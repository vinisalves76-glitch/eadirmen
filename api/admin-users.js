const admin = require('firebase-admin');

function getAdminApp() {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT nao configurada na Vercel.');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT invalida. Use o JSON completo da conta de servico.');
  }

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function requireAdmin(req) {
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
  } catch (e) {
    const err = new Error('Sessao invalida ou expirada.');
    err.statusCode = 401;
    throw err;
  }

  const snap = await db.collection('usuarios').doc(decoded.uid).get();
  const profile = snap.exists ? snap.data() : null;

  if (!profile || profile.ativo !== true || profile.perfil !== 'admin') {
    const err = new Error('Somente administradores ativos podem executar esta acao.');
    err.statusCode = 403;
    throw err;
  }

  return { app, auth, db, decoded, profile };
}

async function syncRenamedPerson(db, oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;

  const ref = db.collection('sistema').doc('sharedData');
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;

    const data = snap.data() || {};
    const people = Array.isArray(data.people) ? data.people.slice() : [];
    const skills = Array.isArray(data.skills) ? data.skills.map(x => ({ ...x })) : [];
    const plans = Array.isArray(data.plans) ? data.plans.map(x => ({ ...x })) : [];

    const nextPeople = [...new Set(
      people.map(name => name === oldName ? newName : name).filter(Boolean)
    )];

    skills.forEach(skill => {
      if (skill.owner === oldName) skill.owner = newName;
    });

    plans.forEach(plan => {
      if (plan.person === oldName) plan.person = newName;
    });

    tx.set(ref, {
      people: nextPeople,
      skills,
      plans,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

async function removePersonFromSharedData(db, name) {
  if (!name) return;

  const ref = db.collection('sistema').doc('sharedData');
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;

    const data = snap.data() || {};
    const people = Array.isArray(data.people)
      ? data.people.filter(person => person !== name)
      : [];

    tx.set(ref, {
      people,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Metodo nao permitido.' });
  }

  try {
    const { auth, db, decoded } = await requireAdmin(req);
    const body = req.body || {};
    const action = clean(body.action);
    const uid = clean(body.uid);

    if (!uid) {
      return res.status(400).json({ error: 'Usuario nao informado.' });
    }

    const targetRef = db.collection('usuarios').doc(uid);
    const targetSnap = await targetRef.get();
    const targetProfile = targetSnap.exists ? targetSnap.data() : {};
    const isSelf = decoded.uid === uid;

    if (action === 'update') {
      const nome = clean(body.nome);
      const email = clean(body.email).toLowerCase();
      const perfil = clean(body.perfil);
      const senha = typeof body.senha === 'string' ? body.senha : '';

      if (!nome) return res.status(400).json({ error: 'Informe o nome.' });
      if (!email || !email.includes('@')) return res.status(400).json({ error: 'Informe um e-mail valido.' });
      if (!['admin', 'instructor'].includes(perfil)) {
        return res.status(400).json({ error: 'Perfil invalido.' });
      }
      if (senha && senha.length < 6) {
        return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
      }
      if (isSelf && perfil !== 'admin') {
        return res.status(400).json({ error: 'Voce nao pode remover seu proprio perfil de administrador.' });
      }

      const authChanges = { email };
      if (senha) authChanges.password = senha;

      await auth.updateUser(uid, authChanges);

      const oldName = clean(targetProfile.nome);
      await targetRef.set({
        nome,
        email,
        perfil,
        cargo: perfil === 'admin' ? 'ADM' : 'Instrutor',
        ativo: targetProfile.ativo !== false,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await syncRenamedPerson(db, oldName, nome);

      return res.status(200).json({
        ok: true,
        message: 'Usuario atualizado com sucesso.'
      });
    }

    if (action === 'deactivate') {
      if (isSelf) {
        return res.status(400).json({ error: 'Voce nao pode desativar seu proprio usuario administrador.' });
      }

      await auth.updateUser(uid, { disabled: true });
      await targetRef.set({
        ativo: false,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return res.status(200).json({
        ok: true,
        message: 'Login desativado com sucesso.'
      });
    }

    if (action === 'activate') {
      await auth.updateUser(uid, { disabled: false });
      await targetRef.set({
        ativo: true,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return res.status(200).json({
        ok: true,
        message: 'Login ativado com sucesso.'
      });
    }

    if (action === 'delete') {
      if (isSelf) {
        return res.status(400).json({ error: 'Voce nao pode excluir seu proprio usuario administrador.' });
      }

      const name = clean(targetProfile.nome);

      try {
        await auth.deleteUser(uid);
      } catch (err) {
        if (err.code !== 'auth/user-not-found') throw err;
      }

      await targetRef.delete();
      await removePersonFromSharedData(db, name);

      return res.status(200).json({
        ok: true,
        message: 'Usuario excluido do Firebase Authentication e do Firestore.'
      });
    }

    return res.status(400).json({ error: 'Acao invalida.' });
  } catch (err) {
    console.error('admin-users:', err);
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: status === 500
        ? 'Falha interna ao gerenciar o usuario. Verifique a configuracao segura do Firebase Admin.'
        : err.message
    });
  }
};
