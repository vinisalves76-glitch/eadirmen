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

    if (action === 'seed-demo') {
      requireRole(profile, ['admin']);
      const demos = [
        {id:'demo-pop-001',title:'DEMO 01 | Inspeção visual pré-operacional',equipment:'Equipamentos móveis SANY',model:'Aplicação geral — confirmar modelo',category:'Inspeção',status:'published',objective:'Treinar a inspeção visual inicial e o registro de anomalias antes de operar. Material demonstrativo; validar a rotina no manual específico da máquina.',scope:'Exemplo didático para treinamento. Aplicação real depende do modelo, configuração e manual vigente.',safety:'Estacione em local seguro, implemente os procedimentos de isolamento aplicáveis e utilize os EPIs definidos pela empresa. Não toque em partes quentes ou móveis. Este exemplo não substitui o manual SANY.',materials:'Checklist de inspeção aplicável, lanterna e EPI conforme atividade.',steps:[['Preparar a inspeção','Estacione em área segura e confirme que a máquina está em condição adequada para inspeção conforme o manual.'],['Inspecionar visualmente','Observe vazamentos, danos, pneus ou esteiras, implementos, proteções, acessos e itens visivelmente soltos. Não desmonte componentes.'],['Registrar e comunicar','Registre as anomalias no checklist e comunique a liderança. Não opere se houver condição insegura.']]},
        {id:'demo-pop-002',title:'DEMO 02 | Verificação de vazamentos hidráulicos',equipment:'Equipamentos hidráulicos SANY',model:'Aplicação geral — confirmar modelo',category:'Inspeção',status:'published',objective:'Reconhecer sinais externos de vazamento e encaminhar a anomalia para diagnóstico seguro.',scope:'Inspeção visual externa; não inclui teste de pressão nem desmontagem.',safety:'Nunca procure vazamento hidráulico com as mãos. Jatos de alta pressão podem penetrar a pele. Desligue, isole e alivie a pressão conforme manual antes de qualquer intervenção.',materials:'Lanterna, barreira de segurança e formulário de inspeção.',steps:[['Posicionar o equipamento','Estacione em superfície adequada, abaixe implementos conforme procedimento do modelo e desligue a máquina.'],['Observar sem contato','Procure umidade, gotejamento e acúmulo de óleo ao redor de mangueiras, conexões e cilindros, mantendo distância segura.'],['Isolar e reportar','Se houver vazamento, impeça o uso quando houver risco e encaminhe para técnico qualificado. Não reapertar conexões pressurizadas.']]},
        {id:'demo-pop-003',title:'DEMO 03 | Limpeza externa do radiador e pacote de arrefecimento',equipment:'Equipamentos SANY com radiador',model:'Confirmar arranjo no manual',category:'Manutenção preventiva',status:'published',objective:'Demonstrar a preparação segura para inspeção e limpeza externa do pacote de arrefecimento.',scope:'Método, sentido e pressão de limpeza devem ser confirmados no manual específico.',safety:'Aguarde o resfriamento. Isole o equipamento. Evite contato com ventoinhas e aletas cortantes; não direcione jato de alta pressão de modo que danifique as aletas.',materials:'EPI, lanterna e ferramentas de limpeza autorizadas pelo fabricante.',steps:[['Desligar e aguardar','Desligue o equipamento, retire a chave quando aplicável e aguarde o sistema esfriar.'],['Inspecionar o pacote','Verifique visualmente obstruções, danos e acúmulo de detritos sem introduzir mãos em áreas de risco.'],['Limpar conforme manual','Use apenas método, sentido e pressão aprovados para o modelo. Se houver dano ou acesso difícil, encaminhe a profissional habilitado.']]},
        {id:'demo-pop-004',title:'DEMO 04 | Verificação do nível de óleo do motor',equipment:'Equipamentos SANY com motor diesel',model:'Confirmar motor e modelo',category:'Manutenção preventiva',status:'published',objective:'Demonstrar a consulta segura do nível de óleo do motor sem definir valores universais.',scope:'Ponto de medição, tempo de espera e faixa correta variam por motor; consultar manual aplicável.',safety:'Estacione e desligue conforme manual. Evite superfícies quentes e partes móveis. Não complete com óleo sem confirmar a especificação correta.',materials:'Pano limpo e lubrificante especificado no manual, se necessário.',steps:[['Preparar a máquina','Posicione o equipamento conforme orientação do manual e aguarde o tempo especificado para estabilização do óleo.'],['Conferir o nível','Use o indicador e a faixa de leitura definidos pelo fabricante para aquele motor. Não aplique valores de outro modelo.'],['Corrigir e registrar','Se necessário, complete somente com óleo aprovado e em pequenas quantidades, seguindo o manual. Registre o serviço e investigue consumo anormal.']]},
        {id:'demo-pop-005',title:'DEMO 05 | Inspeção de mangueiras e conexões',equipment:'Equipamentos SANY',model:'Aplicação geral — confirmar modelo',category:'Inspeção',status:'published',objective:'Identificar sinais visuais de desgaste em mangueiras, conexões e proteções.',scope:'Inspeção visual sem desmontagem; critérios de substituição dependem da especificação do fabricante.',safety:'Não toque em linhas pressurizadas nem tente localizar vazamentos com a mão. Despressurize conforme manual antes de qualquer serviço.',materials:'Lanterna, checklist e EPI aplicável.',steps:[['Garantir condição segura','Estacione, desligue e aplique o isolamento e alívio de pressão definidos no manual.'],['Examinar componentes','Observe abrasão, trincas, bolhas, deformação, corrosão, atrito e sinais de vazamento sem manipular linhas.'],['Registrar anomalias','Fotografe quando permitido e encaminhe para avaliação técnica. Não improvise reparos ou conexões.']]},
        {id:'demo-pop-006',title:'DEMO 06 | Inspeção de dentes, adaptadores e implemento',equipment:'Escavadeiras SANY',model:'Confirmar modelo e implemento',category:'Manutenção preventiva',status:'published',objective:'Criar uma rotina visual de inspeção do desgaste e da fixação do implemento.',scope:'Critérios de desgaste, folgas e torque devem ser obtidos no manual do implemento/modelo.',safety:'Apoie o implemento em condição estável, desligue e bloqueie a máquina. Mantenha pessoas afastadas de pontos de esmagamento e nunca trabalhe sob implemento suspenso.',materials:'EPI, lanterna e checklist específico.',steps:[['Estabilizar o implemento','Posicione-o no solo e confirme a condição segura antes de aproximar-se.'],['Verificar visualmente','Procure peças ausentes, trincas, desgaste irregular e danos visíveis em dentes, adaptadores e pontos de fixação.'],['Tomar providências','Não use valores genéricos de desgaste ou torque. Compare com a documentação aplicável e substitua somente conforme procedimento aprovado.']]},
        {id:'demo-pop-007',title:'DEMO 07 | Preparação segura para manutenção',equipment:'Equipamentos móveis SANY',model:'Aplicação geral — confirmar modelo',category:'Segurança',status:'pending_review',objective:'Reforçar a preparação da área e o controle de energias antes de iniciar manutenção.',scope:'Aplicar os procedimentos de bloqueio, etiquetagem e isolamento vigentes na IRMEN e as instruções do modelo.',safety:'Identifique energias hidráulica, elétrica, térmica, mecânica e gravitacional. Bloqueio e teste de energia zero devem seguir procedimento aprovado; não confie apenas no motor desligado.',materials:'Dispositivos de bloqueio e etiquetagem, EPI e checklist de segurança.',steps:[['Planejar o serviço','Consulte o manual, identifique os riscos e comunique as pessoas envolvidas.'],['Isolar as energias','Aplique o procedimento autorizado de bloqueio, etiquetagem e dissipação de energia acumulada.'],['Verificar condição segura','Confirme o estado seguro pelo método definido no procedimento local antes de iniciar o trabalho.']]},
        {id:'demo-pop-008',title:'DEMO 08 | Registro e triagem de código de falha',equipment:'Equipamentos SANY com monitor eletrônico',model:'Confirmar controlador e modelo',category:'Diagnóstico',status:'pending_review',objective:'Padronizar a coleta inicial de dados quando surgir um alerta ou código de falha.',scope:'Não define significado de códigos nem testes específicos; consultar manual de serviço e ferramenta compatível.',safety:'Se houver alerta crítico, comportamento anormal ou risco à segurança, pare o equipamento em condição segura e siga as instruções do fabricante.',materials:'Registro de atendimento, fotos permitidas e ferramenta de diagnóstico aprovada quando aplicável.',steps:[['Registrar o sintoma','Anote código exato, mensagem, condições de operação e momento em que a falha aparece.'],['Preservar evidências','Não apague códigos nem desconecte módulos antes de registrar dados e consultar o procedimento correto.'],['Consultar documentação','Use a tabela de falhas do modelo/versão e execute somente testes previstos, registrando medições e resultados.']]},
        {id:'demo-pop-009',title:'DEMO 09 | Inspeção de bateria e terminais',equipment:'Equipamentos SANY com sistema elétrico de baixa tensão',model:'Confirmar tensão e configuração no manual',category:'Manutenção preventiva',status:'draft',objective:'Orientar a inspeção visual da bateria, cabos e terminais sem assumir especificações elétricas universais.',scope:'Desconexão, sequência de terminais e valores de teste variam conforme o equipamento.',safety:'Use proteção ocular e EPI adequado. Evite curto-circuito com ferramentas, faíscas e chamas. Siga o procedimento do fabricante antes de desconectar a bateria.',materials:'Lanterna, ferramentas isoladas aprovadas e multímetro adequado quando previsto.',steps:[['Desenergizar conforme manual','Estacione e siga o procedimento específico para isolar o sistema antes de intervir.'],['Inspecionar visualmente','Procure fixação inadequada, cabos danificados, corrosão, vazamento ou sinais de aquecimento.'],['Registrar e encaminhar','Não presumir tensão ou sequência de desconexão. Consulte o manual e encaminhe qualquer dano para profissional habilitado.']]},
        {id:'demo-pop-010',title:'DEMO 10 | Checklist de entrega após manutenção',equipment:'Equipamentos móveis SANY',model:'Aplicação geral — confirmar modelo',category:'Inspeção',status:'draft',objective:'Padronizar a conferência final e o registro do equipamento após uma intervenção.',scope:'Complementar ao checklist oficial de manutenção e ao procedimento de liberação da IRMEN.',safety:'Confirme que ferramentas e pessoas estão fora das zonas de risco e que todas as proteções foram reinstaladas antes de qualquer teste.',materials:'Ordem de serviço, checklist de liberação e documentação do serviço executado.',steps:[['Conferir o serviço','Compare o trabalho realizado com a ordem de serviço e verifique se os itens previstos foram tratados.'],['Verificar montagem e limpeza','Confirme visualmente fixações, proteções, conexões acessíveis e remoção de ferramentas, conforme o escopo autorizado.'],['Documentar a liberação','Registre peças utilizadas, testes realmente executados, resultados e pendências. Faça teste funcional apenas pelo procedimento aprovado.']]}
      ];
      const batch = db.batch();
      const now = nowIso();
      let created = 0, skipped = 0;
      for (const demo of demos) {
        const docRef = ref.doc(demo.id);
        const existing = await docRef.get();
        if (existing.exists) { skipped++; continue; }
        const { id, status, steps, ...fields } = demo;
        const record = {
          ...fields,
          steps: steps.map((step, index) => ({ number:index+1, title:step[0], instruction:step[1], warning:'Exemplo demonstrativo. Validar no manual específico antes de uso em campo.', imageUrl:'', videoUrl:'' })),
          attachments: [],
          revision: '00',
          ownerUid: profile.uid,
          ownerName: clean(profile.nome || profile.email || 'Administrador',160),
          status,
          createdAt: now,
          updatedAt: now,
          history: [trace(profile, 'demo_seeded', 'Conteúdo demonstrativo para testar o fluxo; validar antes de uso operacional.')],
          audit: status === 'published' ? { decision:'approve', actorUid:profile.uid, actorName:clean(profile.nome || profile.email || 'Administrador',160), actorRole:'admin', comment:'Publicação de demonstração para teste do sistema. Conteúdo requer validação técnica antes de uso em campo.', at:now } : null,
          demo: true
        };
        batch.set(docRef, record);
        created++;
      }
      if (created) await batch.commit();
      return res.status(200).json({ ok:true, created, skipped, total:demos.length, message:'POPs demonstrativos criados. Validar todo conteúdo no manual específico antes de uso em campo.' });
    }

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
