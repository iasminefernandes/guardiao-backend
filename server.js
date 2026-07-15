const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
const MAX_BACKUPS = 30; // mantém os últimos 30 dias

// ═══════════════════════════════════════════════
// BANCO DE DADOS SIMPLES EM ARQUIVO JSON
// ═══════════════════════════════════════════════
function garantirDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({
      membros: [],
      fila: [],
      eventos: [],
      memberData: {} // { [user]: { plano, quiz, dia_ciclo, historico, dia_atual_atos } }
    }, null, 2));
  }
}

function lerDB() {
  garantirDB();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function salvarDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ═══════════════════════════════════════════════
// BACKUP AUTOMÁTICO DIÁRIO
// ═══════════════════════════════════════════════
function garantirPastaBackup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function fazerBackup() {
  try {
    garantirPastaBackup();
    const db = lerDB();
    const dataHoje = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const arquivoBackup = path.join(BACKUP_DIR, `backup-${dataHoje}.json`);

    // Só faz backup se ainda não existe um de hoje (evita sobrescrever com dados vazios em restarts múltiplos)
    if (fs.existsSync(arquivoBackup)) {
      console.log(`Backup de hoje já existe: ${dataHoje}`);
      return;
    }

    fs.writeFileSync(arquivoBackup, JSON.stringify({
      dataBackup: new Date().toISOString(),
      totalMembros: db.membros.length,
      db
    }, null, 2));
    console.log(`✓ Backup criado: backup-${dataHoje}.json (${db.membros.length} membros)`);

    limparBackupsAntigos();
  } catch (err) {
    console.error('Erro ao criar backup:', err.message);
  }
}

function limparBackupsAntigos() {
  try {
    garantirPastaBackup();
    const arquivos = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
      .sort(); // ordem alfabética = ordem cronológica (formato YYYY-MM-DD)

    if (arquivos.length > MAX_BACKUPS) {
      const paraRemover = arquivos.slice(0, arquivos.length - MAX_BACKUPS);
      paraRemover.forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
      console.log(`Removidos ${paraRemover.length} backups antigos`);
    }
  } catch (err) {
    console.error('Erro ao limpar backups antigos:', err.message);
  }
}

function listarBackups() {
  garantirPastaBackup();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup-') && f.endsWith('.json'))
    .sort()
    .reverse() // mais recente primeiro
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { arquivo: f, tamanho: stat.size, data: f.replace('backup-','').replace('.json','') };
    });
}

function lerBackup(nomeArquivo) {
  garantirPastaBackup();
  const caminho = path.join(BACKUP_DIR, nomeArquivo);
  if (!fs.existsSync(caminho)) throw new Error('Backup não encontrado');
  return JSON.parse(fs.readFileSync(caminho, 'utf-8'));
}

// Agenda o backup: roda a cada 6 horas, mas só grava 1x por dia (ver fazerBackup)
function agendarBackups() {
  fazerBackup(); // backup imediato ao iniciar o servidor
  setInterval(fazerBackup, 6 * 60 * 60 * 1000); // verifica a cada 6h
}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
function enviarJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function lerBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════════
// SERVIDOR
// ═══════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    // ─── STATUS ───
    if (req.method === 'GET' && pathname === '/') {
      return enviarJSON(res, 200, { status: 'Guardião da Coragem — backend online ✓' });
    }

    // ─── CLAUDE (IA) ───
    if (req.method === 'POST' && pathname === '/claude') {
      if (!API_KEY) return enviarJSON(res, 500, { error: 'ANTHROPIC_API_KEY não configurada.' });
      const { messages } = await lerBody(req);

      const payload = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 8000, messages });
      const data = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) }
        };
        const apiReq = https.request(options, (apiRes) => {
          let raw = '';
          apiRes.on('data', c => raw += c);
          apiRes.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error('Resposta inválida: ' + raw.slice(0,300))); } });
        });
        apiReq.on('error', reject);
        apiReq.write(payload);
        apiReq.end();
      });
      return enviarJSON(res, 200, data);
    }

    // ─── DB: LER TUDO ───
    if (req.method === 'GET' && pathname === '/db') {
      return enviarJSON(res, 200, lerDB());
    }

    // ─── MEMBROS ───
    if (req.method === 'GET' && pathname === '/membros') {
      return enviarJSON(res, 200, lerDB().membros);
    }
    if (req.method === 'POST' && pathname === '/membros') {
      const novo = await lerBody(req);
      const db = lerDB();
      if (db.membros.some(m => m.user === novo.user)) return enviarJSON(res, 409, { error: 'Usuário já existe' });
      db.membros.push(novo);
      salvarDB(db);
      return enviarJSON(res, 200, novo);
    }
    if (req.method === 'PUT' && pathname.startsWith('/membros/')) {
      const user = decodeURIComponent(pathname.split('/')[2]);
      const updates = await lerBody(req);
      const db = lerDB();
      const idx = db.membros.findIndex(m => m.user === user);
      if (idx === -1) return enviarJSON(res, 404, { error: 'Membro não encontrado' });
      db.membros[idx] = { ...db.membros[idx], ...updates };
      salvarDB(db);
      return enviarJSON(res, 200, db.membros[idx]);
    }
    if (req.method === 'DELETE' && pathname.startsWith('/membros/')) {
      const user = decodeURIComponent(pathname.split('/')[2]);
      const db = lerDB();
      db.membros = db.membros.filter(m => m.user !== user);
      delete db.memberData[user];
      salvarDB(db);
      return enviarJSON(res, 200, { deleted: true });
    }

    // ─── DADOS DO MEMBRO (plano, quiz, histórico, etc) ───
    if (req.method === 'GET' && pathname.startsWith('/memberdata/')) {
      const user = decodeURIComponent(pathname.split('/')[2]);
      const db = lerDB();
      return enviarJSON(res, 200, db.memberData[user] || {});
    }
    if (req.method === 'PUT' && pathname.startsWith('/memberdata/')) {
      const user = decodeURIComponent(pathname.split('/')[2]);
      const updates = await lerBody(req);
      const db = lerDB();
      db.memberData[user] = { ...(db.memberData[user] || {}), ...updates };
      salvarDB(db);
      return enviarJSON(res, 200, db.memberData[user]);
    }

    // ─── FILA DE SOLICITAÇÕES ───
    if (req.method === 'GET' && pathname === '/fila') {
      return enviarJSON(res, 200, lerDB().fila);
    }
    if (req.method === 'POST' && pathname === '/fila') {
      const solicitacao = await lerBody(req);
      const db = lerDB();
      db.fila.push(solicitacao);
      salvarDB(db);
      return enviarJSON(res, 200, solicitacao);
    }
    if (req.method === 'PUT' && pathname.startsWith('/fila/')) {
      const id = pathname.split('/')[2];
      const updates = await lerBody(req);
      const db = lerDB();
      const idx = db.fila.findIndex(s => String(s.id) === id);
      if (idx === -1) return enviarJSON(res, 404, { error: 'Solicitação não encontrada' });
      db.fila[idx] = { ...db.fila[idx], ...updates };
      salvarDB(db);
      return enviarJSON(res, 200, db.fila[idx]);
    }
    if (req.method === 'DELETE' && pathname.startsWith('/fila/')) {
      const id = pathname.split('/')[2];
      const db = lerDB();
      db.fila = db.fila.filter(s => String(s.id) !== id);
      salvarDB(db);
      return enviarJSON(res, 200, { deleted: true });
    }

    // ─── EVENTOS (MURAL) ───
    if (req.method === 'GET' && pathname === '/eventos') {
      return enviarJSON(res, 200, lerDB().eventos);
    }
    if (req.method === 'POST' && pathname === '/eventos') {
      const evento = await lerBody(req);
      const db = lerDB();
      db.eventos.push(evento);
      salvarDB(db);
      return enviarJSON(res, 200, evento);
    }
    if (req.method === 'DELETE' && pathname.startsWith('/eventos/')) {
      const id = pathname.split('/')[2];
      const db = lerDB();
      db.eventos = db.eventos.filter(e => String(e.id) !== id);
      salvarDB(db);
      return enviarJSON(res, 200, { deleted: true });
    }

    // ─── BACKUPS ───
    if (req.method === 'GET' && pathname === '/backups') {
      return enviarJSON(res, 200, listarBackups());
    }
    if (req.method === 'GET' && pathname.startsWith('/backups/')) {
      const arquivo = decodeURIComponent(pathname.split('/')[2]);
      try {
        const backup = lerBackup(arquivo);
        return enviarJSON(res, 200, backup);
      } catch (e) {
        return enviarJSON(res, 404, { error: e.message });
      }
    }
    if (req.method === 'POST' && pathname === '/backups/criar-agora') {
      const dataHoje = new Date().toISOString().split('T')[0];
      const arquivoBackup = path.join(BACKUP_DIR, `backup-${dataHoje}.json`);
      // Força novo backup mesmo se já existir um de hoje
      if (fs.existsSync(arquivoBackup)) fs.unlinkSync(arquivoBackup);
      fazerBackup();
      return enviarJSON(res, 200, { status: 'Backup criado com sucesso', data: dataHoje });
    }
    if (req.method === 'POST' && pathname === '/backups/restaurar') {
      const { arquivo } = await lerBody(req);
      try {
        const backup = lerBackup(arquivo);
        salvarDB(backup.db);
        return enviarJSON(res, 200, { status: 'Restaurado com sucesso', totalMembros: backup.db.membros.length });
      } catch (e) {
        return enviarJSON(res, 500, { error: e.message });
      }
    }

    enviarJSON(res, 404, { error: 'Rota não encontrada' });

  } catch (err) {
    enviarJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  garantirDB();
  garantirPastaBackup();
  agendarBackups();
  console.log(`Guardião backend v2 rodando na porta ${PORT} — backup automático ativo`);
});
