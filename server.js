import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

if (JWT_SECRET === 'change-this-secret-in-production') {
  console.warn('⚠ JWT_SECRET ainda está usando o valor padrão. Troque no .env.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));

function code(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function moneyToNumber(value) {
  if (value === null || value === undefined) return 0;
  let s=String(value).replace(/[^0-9,.-]/g,'').trim();
  if(s.includes(',') && s.includes('.')) s=s.replace(/\./g,'').replace(',', '.');
  else if(s.includes(',')) s=s.replace(',', '.');
  const n=Number(s);
  return Number.isFinite(n)?n:0;
}

function sign(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role || 'user' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado.' });

    const token = jwt.verify(header.slice(7), JWT_SECRET);
    const r = await pool.query(
      'SELECT id,name,email,role,created_at FROM users WHERE id=$1',
      [token.sub]
    );

    if (!r.rowCount) return res.status(401).json({ error: 'Usuário não encontrado.' });
    req.user = r.rows[0];
    next();
  } catch {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  next();
}

async function init() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada no .env.');

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);

  // Migração segura para instalações que já tinham a versão anterior.
  await pool.query(`
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS total_numeric NUMERIC(14,2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_id UUID;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_id UUID;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS products JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS freight JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fx NUMERIC(14,6) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_text TEXT NOT NULL DEFAULT 'R$ 0,00';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Pedido';
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS weight_grams NUMERIC(14,3) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_numeric NUMERIC(14,2) NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS quote_history (
      id BIGSERIAL PRIMARY KEY,
      quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS order_history (
      id BIGSERIAL PRIMARY KEY,
      order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      default_profit NUMERIC(8,3) NOT NULL DEFAULT 15,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS freights (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, code TEXT, country TEXT NOT NULL DEFAULT 'Brasil',
      min_weight NUMERIC(14,3) NOT NULL DEFAULT 0, max_weight NUMERIC(14,3) NOT NULL DEFAULT 0,
      first_weight NUMERIC(14,3) NOT NULL DEFAULT 0, first_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      continue_weight NUMERIC(14,3) NOT NULL DEFAULT 0, continue_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      travel_time TEXT, insurance_fee NUMERIC(14,2) NOT NULL DEFAULT 0, description TEXT,
      is_favorite BOOLEAN NOT NULL DEFAULT false, active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS freights_user_idx ON freights(user_id,is_favorite DESC,name);
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS cpf_cnpj TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS address TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS city TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS state TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS zip TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS extras JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  // Preenche o total numérico para dados antigos.
  await pool.query(`UPDATE quotes SET total_numeric = COALESCE(total_numeric, 0) WHERE total_numeric IS NULL`);
  await pool.query(`UPDATE orders SET total_numeric = COALESCE(total_numeric, 0) WHERE total_numeric IS NULL`);
}

// Local freight catalog: no CSSBuy credentials or personal session are required.
function freightCostFromWeight(f, weight) {
  const w = Math.max(0, Number(weight) || 0);
  const firstWeight = Math.max(1, Number(f.first_weight) || 1);
  const nextWeight = Math.max(1, Number(f.continue_weight) || firstWeight);
  const firstFee = Number(f.first_fee) || 0;
  const nextFee = Number(f.continue_fee) || 0;
  if (!w) return 0;
  if (w <= firstWeight) return firstFee;
  const extra = Math.ceil((w - firstWeight) / nextWeight);
  return firstFee + extra * nextFee;
}

app.get('/api/freights', auth, async (req,res)=>{
  const r=await pool.query(`SELECT id,name,code,country,min_weight,max_weight,first_weight,first_fee,continue_weight,continue_fee,travel_time,insurance_fee,description,is_favorite,active,created_at AS created,updated_at AS updated FROM freights WHERE user_id=$1 AND active=true ORDER BY is_favorite DESC,name ASC`,[req.user.id]);
  res.json(r.rows);
});
app.get('/api/freights/all', auth, async (req,res)=>{
  const r=await pool.query(`SELECT id,name,code,country,min_weight,max_weight,first_weight,first_fee,continue_weight,continue_fee,travel_time,insurance_fee,description,is_favorite,active,created_at AS created,updated_at AS updated FROM freights WHERE user_id=$1 ORDER BY is_favorite DESC,active DESC,name ASC`,[req.user.id]);
  res.json(r.rows);
});
app.post('/api/freights', auth, async (req,res)=>{
  try{
    const x=req.body||{}; if(!String(x.name||'').trim()) return res.status(400).json({error:'Nome do frete é obrigatório.'});
    const r=await pool.query(`INSERT INTO freights(user_id,name,code,country,min_weight,max_weight,first_weight,first_fee,continue_weight,continue_fee,travel_time,insurance_fee,description,is_favorite,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id,name,code,country,min_weight,max_weight,first_weight,first_fee,continue_weight,continue_fee,travel_time,insurance_fee,description,is_favorite,active,created_at AS created,updated_at AS updated`,[req.user.id,String(x.name).trim(),x.code||'',x.country||'Brasil',Number(x.minWeight||0),Number(x.maxWeight||0),Number(x.firstWeight||0),Number(x.firstFee||0),Number(x.continueWeight||0),Number(x.continueFee||0),x.travelTime||'',Number(x.insuranceFee||0),x.description||'',!!x.isFavorite,x.active!==false]);
    res.status(201).json(r.rows[0]);
  }catch(e){console.error('FREIGHT CREATE',e);res.status(500).json({error:'Não foi possível criar o frete.'})}
});
app.patch('/api/freights/:id', auth, async (req,res)=>{
  try{
    const x=req.body||{}; if(!String(x.name||'').trim()) return res.status(400).json({error:'Nome do frete é obrigatório.'});
    const r=await pool.query(`UPDATE freights SET name=$1,code=$2,country=$3,min_weight=$4,max_weight=$5,first_weight=$6,first_fee=$7,continue_weight=$8,continue_fee=$9,travel_time=$10,insurance_fee=$11,description=$12,is_favorite=$13,active=$14,updated_at=NOW() WHERE id=$15 AND user_id=$16 RETURNING id,name,code,country,min_weight,max_weight,first_weight,first_fee,continue_weight,continue_fee,travel_time,insurance_fee,description,is_favorite,active,created_at AS created,updated_at AS updated`,[String(x.name).trim(),x.code||'',x.country||'Brasil',Number(x.minWeight||0),Number(x.maxWeight||0),Number(x.firstWeight||0),Number(x.firstFee||0),Number(x.continueWeight||0),Number(x.continueFee||0),x.travelTime||'',Number(x.insuranceFee||0),x.description||'',!!x.isFavorite,x.active!==false,req.params.id,req.user.id]);
    if(!r.rowCount)return res.status(404).json({error:'Frete não encontrado.'});res.json(r.rows[0]);
  }catch(e){console.error('FREIGHT PATCH',e);res.status(500).json({error:'Não foi possível atualizar o frete.'})}
});
app.delete('/api/freights/:id', auth, async (req,res)=>{const r=await pool.query('DELETE FROM freights WHERE id=$1 AND user_id=$2 RETURNING id',[req.params.id,req.user.id]);if(!r.rowCount)return res.status(404).json({error:'Frete não encontrado.'});res.status(204).end()});
app.post('/api/freights/calculate', auth, async (req,res)=>{
  const weight=Math.max(0,Number(req.body?.weight)||0); if(!weight)return res.status(400).json({error:'Informe o peso.'});
  const r=await pool.query(`SELECT id,name,code,country,min_weight,max_weight,first_weight,first_fee,continue_weight,continue_fee,travel_time,insurance_fee,description,is_favorite,active,created_at AS created,updated_at AS updated FROM freights WHERE user_id=$1 AND active=true ORDER BY is_favorite DESC,name ASC`,[req.user.id]);
  const freights=r.rows.filter(f=>(!Number(f.min_weight)||weight>=Number(f.min_weight))&&(!Number(f.max_weight)||weight<=Number(f.max_weight))).map(f=>({...f,totalCny:freightCostFromWeight(f,weight),weight}));
  res.json({weight,freights});
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: true, service: 'ForwardPro Cloud' });
  } catch (e) {
    res.status(503).json({ ok: false, database: false, error: e.message });
  }
});

// AUTH
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password || password.length < 8) {
      return res.status(400).json({ error: 'Nome, e-mail e senha (mínimo 8 caracteres) são obrigatórios.' });
    }

    const normalized = email.toLowerCase().trim();
    const exists = await pool.query('SELECT id FROM users WHERE email=$1', [normalized]);
    if (exists.rowCount) return res.status(409).json({ error: 'E-mail já cadastrado.' });

    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      'INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,role,created_at',
      [name.trim(), normalized, hash]
    );

    await pool.query('INSERT INTO user_settings(user_id) VALUES($1) ON CONFLICT DO NOTHING', [r.rows[0].id]);
    res.status(201).json({ user: r.rows[0], token: sign(r.rows[0]) });
  } catch (e) {
    console.error('REGISTER:', e);
    res.status(500).json({ error: 'Falha ao criar conta.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const r = await pool.query(
      'SELECT id,name,email,password_hash,role,created_at FROM users WHERE email=$1',
      [String(email || '').toLowerCase().trim()]
    );

    if (!r.rowCount) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    const u = r.rows[0];
    if (!(await bcrypt.compare(password || '', u.password_hash))) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    await pool.query('INSERT INTO user_settings(user_id) VALUES($1) ON CONFLICT DO NOTHING', [u.id]);
    res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role }, token: sign(u) });
  } catch (e) {
    console.error('LOGIN:', e);
    res.status(500).json({ error: 'Falha no login.' });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  res.json({ user: req.user });
});

// CLIENTS
app.get('/api/clients', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT id,name,phone,email,cpf_cnpj AS "cpfCnpj",note,address,city,state,zip,created_at AS created FROM clients WHERE user_id=$1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json(r.rows);
});

app.post('/api/clients', auth, async (req, res) => {
  try {
    const { name, phone, email, cpfCnpj, note, address, city, state, zip } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nome do cliente é obrigatório.' });

    const result = await pool.query(
      'INSERT INTO clients (user_id,name,phone,email,cpf_cnpj,note,address,city,state,zip) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,name,phone,email,cpf_cnpj AS "cpfCnpj",note,address,city,state,zip,created_at AS created',
      [req.user.id, name.trim(), phone || '', email || '', cpfCnpj || '', note || '', address || '', city || '', state || '', zip || '']
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('CLIENT CREATE:', error);
    res.status(500).json({ error: 'Não foi possível criar o cliente.' });
  }
});

app.patch('/api/clients/:id', auth, async (req, res) => {
  const { name, phone, email, cpfCnpj, note, address, city, state, zip } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Nome do cliente é obrigatório.' });
  const r = await pool.query(
    `UPDATE clients SET name=$1,phone=$2,email=$3,cpf_cnpj=$4,note=$5,address=$6,city=$7,state=$8,zip=$9
     WHERE id=$10 AND user_id=$11
     RETURNING id,name,phone,email,cpf_cnpj AS "cpfCnpj",note,address,city,state,zip,created_at AS created`,
    [name.trim(), phone || '', email || '', cpfCnpj || '', note || '', address || '', city || '', state || '', zip || '', req.params.id, req.user.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.json(r.rows[0]);
});

app.delete('/api/clients/:id', auth, async (req, res) => {
  const r = await pool.query('DELETE FROM clients WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.status(204).end();
});

app.get('/api/clients/:id/summary', auth, async (req, res) => {
  const [client, quotes, orders] = await Promise.all([
    pool.query('SELECT id,name,phone,email,cpf_cnpj AS "cpfCnpj",note,address,city,state,zip,created_at AS created FROM clients WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]),
    pool.query('SELECT COUNT(*)::int AS n FROM quotes WHERE client_id=$1 AND user_id=$2', [req.params.id, req.user.id]),
    pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(total_numeric),0) AS total FROM orders WHERE client_id=$1 AND user_id=$2', [req.params.id, req.user.id])
  ]);
  if (!client.rowCount) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.json({ client: client.rows[0], quotes: quotes.rows[0].n, orders: orders.rows[0].n, total: orders.rows[0].total });
});

// QUOTES
app.get('/api/quotes', auth, async (req, res) => {
  const r = await pool.query(`
    SELECT q.id,q.code,q.status,q.products,q.freight,q.fx,q.profit,q.service,
      q.import_tax AS "importTax",q.icms,q.notes,q.extras,q.total_text AS "totalText",q.total_numeric AS "totalNumeric",
      q.weight_grams AS "weightGrams",q.created_at AS created,q.client_id AS "clientId",c.name AS "clientName"
    FROM quotes q
    LEFT JOIN clients c ON c.id=q.client_id
    WHERE q.user_id=$1 ORDER BY q.created_at DESC`,
    [req.user.id]
  );
  res.json(r.rows);
});

app.get('/api/quotes/:id', auth, async (req, res) => {
  const r = await pool.query(`SELECT q.*, c.name AS client_name FROM quotes q LEFT JOIN clients c ON c.id=q.client_id WHERE q.id=$1 AND q.user_id=$2`, [req.params.id, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Cotação não encontrada.' });
  const history = await pool.query('SELECT action,details,created_at FROM quote_history WHERE quote_id=$1 ORDER BY created_at DESC', [req.params.id]);
  res.json({ ...r.rows[0], history: history.rows });
});

app.post('/api/quotes', auth, async (req, res) => {
  try {
    const s = req.body || {};
    const products = Array.isArray(s.products) ? s.products : [];
    if (!products.length) return res.status(400).json({ error: 'Adicione pelo menos um produto.' });

    const totalNumeric = moneyToNumber(s.totalText);
    const weight = Number(s.weight || products.reduce((sum, p) => sum + Number(p.weight || 0) * Number(p.qty || 1), 0));
    const r = await pool.query(`
      INSERT INTO quotes
        (code,user_id,client_id,products,freight,fx,profit,service,import_tax,icms,notes,extras,total_text,total_numeric,weight_grams,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Cotação')
      RETURNING *`,
      [code('ORC'), req.user.id, s.clientId || null, JSON.stringify(products), JSON.stringify(s.freight || null),
       Number(s.fx || 0), Number(s.profit || 0), Number(s.service || 0), Number(s.importTax || 0), Number(s.icms || 0), String(s.notes || ''), JSON.stringify(Array.isArray(s.extras)?s.extras:[]),
       String(s.totalText || 'R$ 0,00'), totalNumeric, weight]
    );

    await pool.query(
      'INSERT INTO quote_history(quote_id,user_id,action,details) VALUES($1,$2,$3,$4)',
      [r.rows[0].id, req.user.id, 'created', JSON.stringify({ total: totalNumeric })]
    );

    res.status(201).json(r.rows[0]);
  } catch (error) {
    console.error('QUOTE CREATE:', error);
    res.status(500).json({ error: 'Não foi possível salvar a cotação.' });
  }
});

app.patch('/api/quotes/:id', auth, async (req,res)=>{
  try{
    const s=req.body||{}; const products=Array.isArray(s.products)?s.products:[]; if(!products.length)return res.status(400).json({error:'A cotação precisa ter produtos.'});
    const totalNumeric=moneyToNumber(s.totalText); const weight=Number(s.weight||products.reduce((sum,p)=>sum+Number(p.weight||0)*Number(p.qty||1),0));
    const r=await pool.query(`UPDATE quotes SET client_id=$1,products=$2,freight=$3,fx=$4,profit=$5,service=$6,import_tax=$7,icms=$8,notes=$9,extras=$10,total_text=$11,total_numeric=$12,weight_grams=$13 WHERE id=$14 AND user_id=$15 RETURNING *`,[s.clientId||null,JSON.stringify(products),JSON.stringify(s.freight||null),Number(s.fx||0),Number(s.profit||0),Number(s.service||0),Number(s.importTax||0),Number(s.icms||0),String(s.notes||''),JSON.stringify(Array.isArray(s.extras)?s.extras:[]),String(s.totalText||'R$ 0,00'),totalNumeric,weight,req.params.id,req.user.id]);
    if(!r.rowCount)return res.status(404).json({error:'Cotação não encontrada.'});
    await pool.query('INSERT INTO quote_history(quote_id,user_id,action,details) VALUES($1,$2,$3,$4)',[req.params.id,req.user.id,'updated',JSON.stringify({total:totalNumeric})]);
    res.json(r.rows[0]);
  }catch(e){console.error('QUOTE PATCH',e);res.status(500).json({error:'Não foi possível atualizar a cotação.'})}
});

app.post('/api/quotes/:id/convert', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query('SELECT * FROM quotes WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, req.user.id]);
    if (!q.rowCount) throw Object.assign(new Error('Cotação não encontrada.'), { status: 404 });

    const row = q.rows[0];
    if (row.status === 'Convertida') throw Object.assign(new Error('Cotação já convertida.'), { status: 409 });

    const o = await client.query(`
      INSERT INTO orders(code,user_id,quote_id,client_id,products,freight,fx,total_text,total_numeric,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'Pedido')
      RETURNING id,code,status,quote_id AS "quoteId",client_id AS "clientId",total_text AS "totalText",total_numeric AS "totalNumeric",created_at AS created`,
      [code('PD'), req.user.id, row.id, row.client_id, row.products, row.freight, row.fx, row.total_text, row.total_numeric]
    );

    await client.query("UPDATE quotes SET status='Convertida' WHERE id=$1", [row.id]);
    await client.query('INSERT INTO quote_history(quote_id,user_id,action,details) VALUES($1,$2,$3,$4)', [row.id, req.user.id, 'converted_to_order', JSON.stringify({ orderId: o.rows[0].id })]);
    await client.query('INSERT INTO order_history(order_id,user_id,action,details) VALUES($1,$2,$3,$4)', [o.rows[0].id, req.user.id, 'created_from_quote', JSON.stringify({ quoteId: row.id })]);
    await client.query('COMMIT');
    res.status(201).json(o.rows[0]);
  } catch (e) {
  await client.query('ROLLBACK');

  console.error('CONVERT QUOTE ERROR:', {
    message: e.message,
    code: e.code,
    detail: e.detail,
    hint: e.hint,
    constraint: e.constraint,
    table: e.table,
    column: e.column
  });

  res.status(e.status || 500).json({
    error: e.status
      ? e.message
      : `Falha ao converter cotação: ${e.message}`
  });
}
});

function pdfEscape(s){
  return String(s??'')
    .replace(/\\/g,'\\\\')
    .replace(/\(/g,'\\(')
    .replace(/\)/g,'\\)')
    .replace(/\r?\n/g,' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g,'?');
}
function pdfNum(n){ return Number(n).toFixed(2); }
function pdfText(x,y,text,size=9,font='F1'){
  return `BT /${font} ${size} Tf 1 0 0 1 ${pdfNum(x)} ${pdfNum(y)} Tm (${pdfEscape(text)}) Tj ET`;
}
function pdfLine(x1,y1,x2,y2){ return `${pdfNum(x1)} ${pdfNum(y1)} m ${pdfNum(x2)} ${pdfNum(y2)} l S`; }
function pdfRect(x,y,w,h,fill=false){ return `${fill?'f':'S'} ${pdfNum(x)} ${pdfNum(y)} ${pdfNum(w)} ${pdfNum(h)} re`; }
function pdfFillRect(x,y,w,h){ return `${pdfNum(x)} ${pdfNum(y)} ${pdfNum(w)} ${pdfNum(h)} re f`; }
function pdfSetGray(g){ return `${g} g`; }
function pdfSetStroke(g){ return `${g} G`; }
function pdfPageStream(draw){ return draw.join('\n'); }
function makeProfessionalPdf(pages){
  const objs=[];
  // 1 catalog, 2 pages, 3 fonts, 4 bold font, then page/content pairs
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids=[];
  objs.push('PLACEHOLDER_PAGES');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  for(let i=0;i<pages.length;i++){
    const pageObj=objs.length+1, contentObj=objs.length+2;
    kids.push(`${pageObj} 0 R`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj} 0 R >>`);
    const content=pdfPageStream(pages[i]);
    objs.push(`<< /Length ${Buffer.byteLength(content,'latin1')} >>\nstream\n${content}\nendstream`);
  }
  objs[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let pdf='%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets=[0];
  for(let i=0;i<objs.length;i++){
    offsets.push(Buffer.byteLength(pdf,'latin1'));
    pdf+=`${i+1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref=Buffer.byteLength(pdf,'latin1');
  pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`;
  for(let i=1;i<offsets.length;i++) pdf+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';
  pdf+=`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf,'latin1');
}
function moneyBRL(v){ return `R$ ${Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}`; }
function moneyCNY(v){ return `CNY ${Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}`; }
function wrapPdf(text,max=82){
  const words=String(text??'').split(/\s+/); const out=[]; let line='';
  for(const w of words){ if((line+' '+w).trim().length>max && line){out.push(line);line=w;} else line=(line+' '+w).trim(); }
  if(line) out.push(line); return out;
}
app.get('/api/quotes/:id/pdf',auth,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT q.*,c.name AS client_name,c.phone,c.email,c.address,c.city,c.state,c.zip FROM quotes q LEFT JOIN clients c ON c.id=q.client_id WHERE q.id=$1 AND q.user_id=$2`,[req.params.id,req.user.id]);
    if(!r.rowCount)return res.status(404).json({error:'Cotação não encontrada.'});
    const q=r.rows[0], products=Array.isArray(q.products)?q.products:[], extras=Array.isArray(q.extras)?q.extras:[], freight=q.freight||{};
    const fx=Number(q.fx||0);
    const productCny=products.reduce((sum,p)=>sum+(Number(p.price)||0)*(Number(p.qty)||1),0);
    const productBrl=productCny*fx;
    const freightCny=Number(freight.totalCny||freight.total_fee||0), freightBrl=freightCny*fx;
    const extraTotal=extras.reduce((sum,x)=>sum+Number(x.value||0),0);
    const base=productBrl+freightBrl+extraTotal;
    const importRate=Number(q.import_tax||0), icmsRate=Number(q.icms||0), serviceRate=Number(q.service||0), profitRate=Number(q.profit||0);
    const importValue=base*importRate/100, icmsValue=(base+importValue)*icmsRate/100, taxes=importValue+icmsValue;
    const subtotal=base+taxes, serviceValue=subtotal*serviceRate/100, afterService=subtotal+serviceValue, profitValue=afterService*profitRate/100;
    const totalText=String(q.total_text||moneyBRL(afterService+profitValue));
    const pageW=595,pageH=842,left=42,right=553,contentW=511;
    const pages=[]; let d=[]; let y=800;
    const navy='0.10 0.12 0.18'; const gray='0.93 0.94 0.96'; const mid='0.42 0.45 0.50';
    function header(){
     // ===============================
// CABEÇALHO DO PDF
// ===============================

// Fundo do cabeçalho
d.push('0.04 0.10 0.20 rg');
d.push(pdfFillRect(0, 770, pageW, 72));

// Quadrado da logo
d.push('0.10 0.45 0.75 rg');
d.push(pdfFillRect(42, 786, 34, 34));

// Textos do cabeçalho em branco
d.push('1 1 1 rg');

d.push(pdfText(50, 798, 'F', 17, 'F2'));

d.push(pdfText(
  86,
  802,
  'FORWARDPRO',
  20,
  'F2'
));

d.push(pdfText(
  86,
  785,
  'COTACAO DE IMPORTACAO',
  8,
  'F1'
));

d.push(pdfText(
  455,
  807,
  String(q.code || 'COTACAO'),
  9,
  'F2'
));

d.push(pdfText(
  455,
  792,
  new Date(q.created_at).toLocaleDateString('pt-BR'),
  8,
  'F1'
));

// Voltar para preto para o restante do PDF
d.push('0 0 0 rg');

y = 748;
    }
    function section(title){
      d.push('0.93 0.94 0.96 rg'); d.push(pdfFillRect(left,y-20,contentW,20)); d.push(pdfSetGray(0.10)); d.push(pdfText(left+9,y-14,title.toUpperCase(),9,'F2')); d.push(pdfSetGray(0)); y-=34;
    }
    function row(label,value,bold=false){ d.push(pdfText(left,y,label,8.5,bold?'F2':'F1')); d.push(pdfText(350,y,value,8.5,bold?'F2':'F1')); y-=17; }
    function ensure(h=30){ if(y<h){ pages.push(d); d=[]; header(); } }
    header();
    // Client card
    section('Cliente');
    const clientLines=[q.client_name||'Nao informado',q.phone?`WhatsApp: ${q.phone}`:'',q.email?`E-mail: ${q.email}`:'',q.address||'', [q.city,q.state,q.zip].filter(Boolean).join(' - ')].filter(Boolean);
    for(const line of clientLines){ensure(40); d.push(pdfText(left,y,line,9)); y-=16;}
    y-=5;
    section('Produtos');
    d.push('0.96 0.96 0.97 rg'); d.push(pdfFillRect(left,y-15,contentW,18)); d.push(pdfSetGray(0.2));
    d.push(pdfText(left+6,y-10,'Produto',8,'F2')); d.push(pdfText(345,y-10,'Qtd.',8,'F2')); d.push(pdfText(392,y-10,'Peso',8,'F2')); d.push(pdfText(470,y-10,'Valor',8,'F2')); y-=29;
    for(const p of products){
      ensure(35); const qty=Number(p.qty||1), pw=Number(p.weight||0)*qty, val=(Number(p.price)||0)*qty;
      d.push(pdfText(left+6,y,String(p.name||'Produto'),8.5)); d.push(pdfText(345,y,`${qty}`,8.5)); d.push(pdfText(392,y,`${pw.toFixed(2)} g`,8.5)); d.push(pdfText(470,y,moneyCNY(val),8.5));
      d.push(pdfSetGray(0.88)); d.push(pdfLine(left,y-6,left+contentW,y-6)); d.push(pdfSetGray(0)); y-=20;
    }
    y-=4;
    section('Frete e envio');
    row('Frete selecionado',String(freight.name||'Nao selecionado'),true);
    row('Peso total',`${Number(q.weight_grams||0).toFixed(2)} g`);
    if(freight.travel_time) row('Prazo estimado',String(freight.travel_time));
    row('Custo do frete',`${moneyCNY(freightCny)}  |  ${moneyBRL(freightBrl)}`);
    if(freight.insuranceRate!=null) row('Seguro',`${Number(freight.insuranceRate).toFixed(2)}%`);
    if(freight.description) for(const line of wrapPdf(freight.description,100)){ensure(35); d.push(pdfText(left,y,line,7.5)); y-=13;}
    if(extras.length){ y-=5; section('Adicionais'); for(const x of extras){ensure(35); row(String(x.description||'Adicional'),moneyBRL(x.value||0));}}
    y-=5; section('Resumo financeiro');
    row('Produtos',moneyBRL(productBrl)); row('Frete',moneyBRL(freightBrl)); row('Adicionais',moneyBRL(extraTotal)); row('Base de custos',moneyBRL(base),true);
    row(`Imposto de importacao (${importRate.toFixed(2)}%)`,moneyBRL(importValue)); row(`ICMS (${icmsRate.toFixed(2)}%)`,moneyBRL(icmsValue)); row('Subtotal com impostos',moneyBRL(subtotal),true);
    row(`Taxa operacional (${serviceRate.toFixed(2)}%)`,moneyBRL(serviceValue));
    ensure(100); y-=8; d.push('0.10 0.45 0.75 rg'); d.push(pdfFillRect(left,y-58,contentW,58)); d.push(pdfSetGray(1)); d.push(pdfText(left+14,y-20,'PRECO FINAL PARA O CLIENTE',9,'F2')); d.push(pdfText(left+14,y-45,totalText,20,'F2')); d.push(pdfSetGray(0)); y-=78;
    if(q.notes){ section('Observacoes'); for(const line of wrapPdf(q.notes,100)){ensure(35); d.push(pdfText(left,y,line,8)); y-=14;} }
    ensure(50); d.push(pdfSetGray(0.45)); d.push(pdfLine(left,48,left+contentW,48)); d.push(pdfText(left,32,'ForwardPro - Documento gerado para fins de apresentação comercial.',7)); d.push(pdfText(445,32,`Pagina ${pages.length+1}`,7));
    pages.push(d);
    // Add page footer numbers to every page where missing.
    for(let i=0;i<pages.length;i++){
      const pg=pages[i]; pg.push(pdfSetGray(0.45)); pg.push(pdfLine(left,28,left+contentW,28)); pg.push(pdfText(left,14,'FORWARDPRO',7,'F2')); pg.push(pdfText(505,14,`Pagina ${i+1}/${pages.length}`,7));
    }
    const pdf=makeProfessionalPdf(pages);
    res.setHeader('Content-Type','application/pdf'); res.setHeader('Content-Length',String(pdf.length)); res.setHeader('Content-Disposition',`attachment; filename="${q.code||'cotacao'}.pdf"`); res.send(pdf);
  }catch(e){console.error('QUOTE PDF',e);res.status(500).json({error:'Nao foi possivel gerar o PDF: '+e.message});}
});

app.delete('/api/quotes/:id', auth, async (req, res) => {
  const r = await pool.query("DELETE FROM quotes WHERE id=$1 AND user_id=$2 AND status<>'Convertida' RETURNING id", [req.params.id, req.user.id]);
  if (!r.rowCount) return res.status(409).json({ error: 'Cotação não encontrada ou já convertida em pedido.' });
  res.status(204).end();
});

// ORDERS
app.get('/api/orders', auth, async (req, res) => {
  const r = await pool.query(`
    SELECT o.id,o.code,o.quote_id AS "quoteId",o.client_id AS "clientId",c.name AS "clientName",
      o.status,o.products,o.freight,o.fx,o.total_text AS "totalText",o.total_numeric AS "totalNumeric",o.created_at AS created
    FROM orders o LEFT JOIN clients c ON c.id=o.client_id
    WHERE o.user_id=$1 ORDER BY o.created_at DESC`, [req.user.id]);
  res.json(r.rows);
});

app.get('/api/orders/:id', auth, async (req, res) => {
  const r = await pool.query(`SELECT o.*,c.name AS client_name FROM orders o LEFT JOIN clients c ON c.id=o.client_id WHERE o.id=$1 AND o.user_id=$2`, [req.params.id, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const history = await pool.query('SELECT action,details,created_at FROM order_history WHERE order_id=$1 ORDER BY created_at DESC', [req.params.id]);
  res.json({ ...r.rows[0], history: history.rows });
});

app.patch('/api/orders/:id/status', auth, async (req, res) => {
  const allowed = ['Pedido','Pago','Compra realizada','Em preparação','Enviado','Em trânsito','Chegou ao Brasil','Finalizado','Cancelado'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Status inválido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = await client.query('SELECT status FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, req.user.id]);
    if (!old.rowCount) throw Object.assign(new Error('Pedido não encontrado.'), { status: 404 });
    const r = await client.query('UPDATE orders SET status=$1 WHERE id=$2 AND user_id=$3 RETURNING id,code,status', [req.body.status, req.params.id, req.user.id]);
    await client.query('INSERT INTO order_history(order_id,user_id,action,details) VALUES($1,$2,$3,$4)', [req.params.id, req.user.id, 'status_changed', JSON.stringify({ from: old.rows[0].status, to: req.body.status })]);
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Não foi possível atualizar o pedido.' });
  } finally { client.release(); }
});

// DASHBOARD / SETTINGS
app.get('/api/dashboard', auth, async (req, res) => {
  const [q,o,c,rev,paid,month] = await Promise.all([
    pool.query('SELECT COUNT(*)::int n FROM quotes WHERE user_id=$1',[req.user.id]),
    pool.query('SELECT COUNT(*)::int n FROM orders WHERE user_id=$1',[req.user.id]),
    pool.query('SELECT COUNT(*)::int n FROM clients WHERE user_id=$1',[req.user.id]),
    pool.query('SELECT COALESCE(SUM(total_numeric),0) total FROM orders WHERE user_id=$1 AND status<>\'Cancelado\'',[req.user.id]),
    pool.query("SELECT COUNT(*)::int n FROM orders WHERE user_id=$1 AND status='Pago'",[req.user.id]),
    pool.query("SELECT COALESCE(SUM(total_numeric),0) total FROM orders WHERE user_id=$1 AND created_at >= date_trunc('month',CURRENT_DATE) AND status<>'Cancelado'",[req.user.id])
  ]);
  res.json({quotes:q.rows[0].n,orders:o.rows[0].n,clients:c.rows[0].n,revenue:Number(rev.rows[0].total),paid:paid.rows[0].n,monthRevenue:Number(month.rows[0].total)});
});

app.get('/api/settings', auth, async (req,res)=>{
  const r=await pool.query('SELECT default_profit AS "defaultProfit" FROM user_settings WHERE user_id=$1',[req.user.id]);
  res.json(r.rows[0]||{defaultProfit:15});
});
app.put('/api/settings', auth, async (req,res)=>{
  const profit=Number(req.body.defaultProfit);
  if(!Number.isFinite(profit)||profit<0||profit>500)return res.status(400).json({error:'Margem inválida.'});
  const r=await pool.query(`INSERT INTO user_settings(user_id,default_profit,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET default_profit=EXCLUDED.default_profit,updated_at=NOW() RETURNING default_profit AS "defaultProfit"`,[req.user.id,profit]);
  res.json(r.rows[0]);
});

app.post('/api/reset', auth, async (req,res)=>{
  await pool.query('DELETE FROM orders WHERE user_id=$1',[req.user.id]);
  await pool.query('DELETE FROM quotes WHERE user_id=$1',[req.user.id]);
  await pool.query('DELETE FROM clients WHERE user_id=$1',[req.user.id]);
  res.status(204).end();
});

// ADMIN
app.get('/api/admin/dashboard', auth, adminOnly, async (_req,res)=>{
  const [u,q,o,c,rev]=await Promise.all([
    pool.query('SELECT COUNT(*)::int n FROM users'),
    pool.query('SELECT COUNT(*)::int n FROM quotes'),
    pool.query('SELECT COUNT(*)::int n FROM orders'),
    pool.query('SELECT COUNT(*)::int n FROM clients'),
    pool.query("SELECT COALESCE(SUM(total_numeric),0) total FROM orders WHERE status<>'Cancelado'")
  ]);
  res.json({users:u.rows[0].n,quotes:q.rows[0].n,orders:o.rows[0].n,clients:c.rows[0].n,revenue:Number(rev.rows[0].total)});
});

app.get('/api/admin/users', auth, adminOnly, async (_req,res)=>{
  const r=await pool.query('SELECT id,name,email,role,created_at AS created FROM users ORDER BY created_at DESC');
  res.json(r.rows);
});
app.patch('/api/admin/users/:id/role', auth, adminOnly, async (req,res)=>{
  const role=req.body.role;
  if(!['user','admin'].includes(role))return res.status(400).json({error:'Perfil inválido.'});
  if(String(req.params.id)===String(req.user.id)&&role!=='admin')return res.status(400).json({error:'Você não pode remover seu próprio acesso de administrador.'});
  const r=await pool.query('UPDATE users SET role=$1 WHERE id=$2 RETURNING id,name,email,role',[role,req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Usuário não encontrado.'});
  res.json(r.rows[0]);
});
app.delete('/api/admin/users/:id', auth, adminOnly, async (req,res)=>{
  if(String(req.params.id)===String(req.user.id))return res.status(400).json({error:'Você não pode excluir sua própria conta por este painel.'});
  const r=await pool.query('DELETE FROM users WHERE id=$1 RETURNING id',[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:'Usuário não encontrado.'});
  res.status(204).end();
});
app.get('/api/admin/quotes', auth, adminOnly, async (_req,res)=>{
  const r=await pool.query(`SELECT q.id,q.code,q.status,q.total_text AS "totalText",q.created_at AS created,u.name AS "userName",u.email AS "userEmail",c.name AS "clientName" FROM quotes q JOIN users u ON u.id=q.user_id LEFT JOIN clients c ON c.id=q.client_id ORDER BY q.created_at DESC LIMIT 500`);
  res.json(r.rows);
});
app.get('/api/admin/orders', auth, adminOnly, async (_req,res)=>{
  const r=await pool.query(`SELECT o.id,o.code,o.status,o.total_text AS "totalText",o.created_at AS created,u.name AS "userName",u.email AS "userEmail",c.name AS "clientName" FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN clients c ON c.id=o.client_id ORDER BY o.created_at DESC LIMIT 500`);
  res.json(r.rows);
});

// Static frontend. Express 5: no app.get('*') wildcard.
app.use(express.static(path.join(__dirname,'public')));
app.use((req,res)=>{
  if(req.path.startsWith('/api/'))return res.status(404).json({error:'Endpoint não encontrado.'});
  res.sendFile(path.join(__dirname,'public','index.html'));
});

init()
  .then(()=>app.listen(port,()=>console.log(`✓ ForwardPro Cloud rodando em http://localhost:${port}`)))
  .catch(e=>{console.error('ERRO AO INICIAR:',e);process.exit(1)});
