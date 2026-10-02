const admin = require('firebase-admin');

function getAdminApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw Object.assign(new Error('O servidor ainda nao esta configurado.'), { statusCode: 503 });
  let serviceAccount;
  try { serviceAccount = JSON.parse(raw); }
  catch (_) { throw Object.assign(new Error('Configuracao do servidor invalida.'), { statusCode: 503 }); }
  return admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function col(name) {
  const preview = String(process.env.VERCEL_ENV || '').toLowerCase() !== 'production';
  return preview ? 'preview_' + name : name;
}

function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function nowIso() { return new Date().toISOString(); }
function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
}
function numberId(value) {
  const n=Number(value);
  if(!Number.isFinite(n)) throw Object.assign(new Error('Demanda invalida.'),{statusCode:400});
  return n;
}
function priorityRank(value){return ({Baixa:1,'Média':2,Alta:3,'Crítica':4})[value]||1;}
function maxPriority(a,b){return priorityRank(b)>priorityRank(a)?b:a;}
function workflowSkill(){
  return {materials:[],noMaterials:false,productionOutputs:[],legacyProductionComplete:false,workflow:{production:'Não iniciado',review:'Não iniciado',finalization:'Não iniciado'}};
}
function trace(profile,type,machineCode,client,source){
  return {
    actorUid:profile.uid,
    actorName:clean(profile.nome||profile.email||'',160),
    actorRole:profile.perfil,
    recordedAt:nowIso(),
    source:source||'Consultor',
    machineCode:clean(machineCode,50),
    client:clean(client,180),
    recordType:type
  };
}

async function requireUser(req){
  const app=getAdminApp(),auth=app.auth(),db=app.firestore();
  const match=String(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i);
  if(!match) throw Object.assign(new Error('Sessao nao informada.'),{statusCode:401});
  let decoded;
  try{decoded=await auth.verifyIdToken(match[1],true);}
  catch(_){throw Object.assign(new Error('Sua sessao expirou. Entre novamente.'),{statusCode:401});}
  const snap=await db.collection('usuarios').doc(decoded.uid).get();
  const profile=snap.exists?{uid:decoded.uid,...snap.data()}:null;
  if(!profile||profile.ativo!==true||!['admin','consultant','instructor'].includes(profile.perfil)){
    throw Object.assign(new Error('Usuario sem permissao para acessar demandas de treinamento.'),{statusCode:403});
  }
  return {db,profile};
}
function requireRole(profile,allowed){
  if(!allowed.includes(profile.perfil))throw Object.assign(new Error('Seu perfil nao tem permissao para executar esta acao.'),{statusCode:403});
}
function activeDemand(d){return ['Pendente ADM','Em produção','Pronto para aplicação','Em acompanhamento'].includes(d&&d.status);}
function occurrenceFromBody(body,profile,phase){
  return {
    id:Date.now(),
    data:clean(body.eventDate,20)||new Date().toISOString().slice(0,10),
    evidencia:clean(body.evidence,1800),
    analiseTecnica:clean(body.analysis,1800),
    tema:clean(body.trainingNeed,300),
    prioridade:clean(body.priority,30)||'Baixa',
    responsavel:clean(profile.nome,120)||'Consultor de Treinamento',
    fase:phase,
    registradoEm:nowIso(),
    audit:trace(profile,'Ocorrência de treinamento',body.machineCode,body.client,profile.perfil==='admin'?'ADM':'Consultor')
  };
}
function jsonDoc(doc){return {docId:doc.id,...(doc.data()||{})};}

module.exports=async function handler(req,res){
  try{
    const {db,profile}=await requireUser(req);
    const needsRef=db.collection(col('trainingNeeds'));

    if(req.method==='GET'){
      const snap=await needsRef.orderBy('updatedAt','desc').limit(1000).get();
      return res.status(200).json({ok:true,demands:snap.docs.map(jsonDoc)});
    }
    if(req.method!=='POST'){
      res.setHeader('Allow','GET, POST');
      return res.status(405).json({error:'Metodo nao permitido.'});
    }

    const body=req.body||{};
    const action=clean(body.action,60);

    if(action==='register-occurrence'){
      requireRole(profile,['admin','consultant']);
      const machineCode=clean(body.machineCode,40).toUpperCase();
      const trainingNeed=clean(body.trainingNeed,300);
      if(!machineCode)return res.status(400).json({error:'Codigo da maquina obrigatorio.'});
      if(!trainingNeed)return res.status(400).json({error:'Descreva a necessidade de treinamento.'});

      const snap=await needsRef.limit(1000).get();
      const demands=snap.docs.map(jsonDoc);
      const topicKey=normalize(trainingNeed);
      let current=demands.find(d=>activeDemand(d)&&clean(d.machineCode,40).toUpperCase()===machineCode&&normalize(d.topic||d.trainingNeed)===topicKey);
      if(!current){
        const same=demands.filter(d=>activeDemand(d)&&clean(d.machineCode,40).toUpperCase()===machineCode);
        if(same.length===1)current=same[0];
      }

      if(current){
        const phase=current.status==='Em acompanhamento'?'Após treinamento':'Antes do treinamento';
        const occurrence=occurrenceFromBody(body,profile,phase);
        const pre=Array.isArray(current.preTrainingOccurrences)?current.preTrainingOccurrences.slice():[];
        const post=Array.isArray(current.postTrainingOccurrences)?current.postTrainingOccurrences.slice():[];
        if(phase==='Após treinamento')post.push(occurrence);else pre.push(occurrence);

        const next={
          ...current,
          evidence:clean(body.evidence,1800)||current.evidence||'',
          analysis:clean(body.analysis,1800)||current.analysis||'',
          topic:trainingNeed||current.topic||'',
          priority:maxPriority(current.priority||'Baixa',clean(body.priority,30)||'Baixa'),
          preTrainingOccurrences:pre,
          postTrainingOccurrences:post,
          updatedAt:nowIso(),
          lastOccurrenceAt:occurrence.data,
          audit:trace(profile,'Necessidade de treinamento',machineCode,current.client||body.client,profile.perfil==='admin'?'ADM':'Consultor')
        };
        await needsRef.doc(String(current.id)).set(next,{merge:true});
        return res.status(200).json({ok:true,demand:next,created:false,phase});
      }

      const id=Date.now();
      const occurrence=occurrenceFromBody(body,profile,'Antes do treinamento');
      const demand={
        id,status:'Pendente ADM',machineCode,
        machineName:clean(body.machineName,120),
        machineFamily:clean(body.machineFamily,50),
        client:clean(body.client,160),
        location:clean(body.location,160),
        topic:trainingNeed,
        evidence:clean(body.evidence,1800),
        analysis:clean(body.analysis,1800),
        priority:clean(body.priority,30)||'Baixa',
        source:'Frota',
        sourceLabel:'Acompanhamento de Frotas',
        createdAt:nowIso(),
        createdBy:clean(profile.nome,120)||'Consultor de Treinamento',
        updatedAt:nowIso(),
        preTrainingOccurrences:[occurrence],
        postTrainingOccurrences:[],
        linkedSkillId:null,assignedInstructor:'',
        approvedAt:null,appliedAt:null,closedAt:null,
        audit:trace(profile,'Necessidade de treinamento',machineCode,body.client,profile.perfil==='admin'?'ADM':'Consultor')
      };
      await needsRef.doc(String(id)).set(demand);
      return res.status(200).json({ok:true,demand,created:true,phase:'Antes do treinamento'});
    }

    if(action==='approve'){
      requireRole(profile,['admin']);
      const demandId=numberId(body.demandId);
      const ref=needsRef.doc(String(demandId));
      const snap=await ref.get();
      if(!snap.exists)return res.status(404).json({error:'Demanda nao encontrada.'});
      const demand={...snap.data()};
      if(demand.linkedSkillId)return res.status(409).json({error:'Esta demanda ja possui uma habilidade vinculada.'});
      if(demand.status!=='Pendente ADM')return res.status(409).json({error:'Somente demandas pendentes podem ser aprovadas.'});

      const title=clean(body.title,240),owner=clean(body.owner,120),level=clean(body.level,40)||'Básica',duration=clean(body.duration,60)||'5 min';
      if(!title||!owner)return res.status(400).json({error:'Titulo e instrutor sao obrigatorios.'});

      const skillId=Date.now();
      const planId=skillId+1;
      const createdAt=nowIso();
      const skill={
        id:skillId,title,level,owner,status:'Planejamento',progress:0,duration,
        objective:'',development:'',...workflowSkill(),
        createdAt,
        analytics:{trackingStartedAt:createdAt,createdAt,legacyBaseline:false,startedAt:null,completedAt:null,currentStage:0,currentStageLabel:'Planejamento',currentStageEnteredAt:createdAt,stageHistory:[],reworkCount:0,updatedAt:createdAt},
        source:'fleet-demand',demandId:demand.id,
        sourceMachineCode:demand.machineCode||'',sourceMachineName:demand.machineName||'',
        sourceClient:demand.client||'',sourceEvidence:demand.evidence||'',sourceTopic:demand.topic||'',
        audit:trace(profile,'Habilidade',demand.machineCode,demand.client,'ADM')
      };
      const plan={id:planId,person:owner,skillId,week:'Semana atual',source:'fleet-demand',demandId:demand.id,createdAt,audit:trace(profile,'Planejamento',demand.machineCode,demand.client,'ADM')};

      const batch=db.batch();
      batch.set(db.collection(col('skills')).doc(String(skillId)),skill);
      batch.set(db.collection(col('plans')).doc(String(planId)),plan);
      const updatedDemand={...demand,status:'Em produção',linkedSkillId:skillId,assignedInstructor:owner,skillTitle:title,skillLevel:level,approvedAt:createdAt,approvedBy:clean(profile.nome,120)||'ADM',updatedAt:createdAt,audit:trace(profile,'Aprovação de treinamento',demand.machineCode,demand.client,'ADM')};
      batch.set(ref,updatedDemand,{merge:true});
      await batch.commit();
      return res.status(200).json({ok:true,demand:updatedDemand,skill,plan});
    }

    if(action==='reject'){
      requireRole(profile,['admin']);
      const demandId=numberId(body.demandId),ref=needsRef.doc(String(demandId)),snap=await ref.get();
      if(!snap.exists)return res.status(404).json({error:'Demanda nao encontrada.'});
      const current=snap.data()||{};
      if(current.linkedSkillId)return res.status(409).json({error:'A demanda ja possui habilidade vinculada.'});
      const demand={...current,status:'Não aprovada',rejectionReason:clean(body.reason,1200),rejectedAt:nowIso(),rejectedBy:clean(profile.nome,120)||'ADM',updatedAt:nowIso(),audit:trace(profile,'Demanda não aprovada',current.machineCode,current.client,'ADM')};
      await ref.set(demand,{merge:true});
      return res.status(200).json({ok:true,demand});
    }

    if(action==='mark-applied'){
      requireRole(profile,['admin','consultant']);
      const demandId=numberId(body.demandId),ref=needsRef.doc(String(demandId)),snap=await ref.get();
      if(!snap.exists)return res.status(404).json({error:'Demanda nao encontrada.'});
      const current=snap.data()||{};
      const skillSnap=current.linkedSkillId?await db.collection(col('skills')).doc(String(current.linkedSkillId)).get():null;
      const skill=skillSnap&&skillSnap.exists?skillSnap.data():null;
      const complete=skill&&(skill.status==='Concluída'||skill.workflow?.finalization==='Finalizado');
      if(!complete)return res.status(409).json({error:'A microaula precisa estar concluida antes de registrar a aplicacao.'});
      const demand={...current,status:'Em acompanhamento',appliedAt:nowIso(),appliedBy:clean(profile.nome,120)||'Equipe de Treinamento',applicationNotes:clean(body.notes,1600),followUpStartedAt:nowIso(),updatedAt:nowIso(),postTrainingOccurrences:Array.isArray(current.postTrainingOccurrences)?current.postTrainingOccurrences:[],audit:trace(profile,'Treinamento aplicado',current.machineCode,current.client,profile.perfil==='admin'?'ADM':'Consultor')};
      await ref.set(demand,{merge:true});
      return res.status(200).json({ok:true,demand});
    }

    if(action==='close'){
      requireRole(profile,['admin','consultant']);
      const demandId=numberId(body.demandId),ref=needsRef.doc(String(demandId)),snap=await ref.get();
      if(!snap.exists)return res.status(404).json({error:'Demanda nao encontrada.'});
      const current=snap.data()||{};
      if(current.status!=='Em acompanhamento')return res.status(409).json({error:'A demanda precisa estar em acompanhamento para ser encerrada.'});
      const demand={...current,status:'Concluída',outcome:clean(body.outcome,100)||'Encerrada',outcomeNotes:clean(body.notes,1800),closedAt:nowIso(),closedBy:clean(profile.nome,120)||'Equipe de Treinamento',updatedAt:nowIso(),audit:trace(profile,'Necessidade encerrada',current.machineCode,current.client,profile.perfil==='admin'?'ADM':'Consultor')};
      await ref.set(demand,{merge:true});
      return res.status(200).json({ok:true,demand});
    }

    return res.status(400).json({error:'Acao de demanda nao reconhecida.'});
  }catch(err){
    console.error('training-demands:',err);
    return res.status(err.statusCode||500).json({error:err.statusCode?err.message:'Nao foi possivel atualizar a demanda de treinamento.'});
  }
};
