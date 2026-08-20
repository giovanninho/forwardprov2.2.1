import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
const {Pool}=pg;
const email=String(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
const password=String(process.env.ADMIN_PASSWORD||'');
const name=String(process.env.ADMIN_NAME||'Administrador').trim();
if(!email || !password){console.error('Defina ADMIN_EMAIL e ADMIN_PASSWORD no ambiente.');process.exit(1)}
if(password.length<12){console.error('ADMIN_PASSWORD deve ter pelo menos 12 caracteres.');process.exit(1)}
if(!process.env.DATABASE_URL){console.error('DATABASE_URL não configurada.');process.exit(1)}
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:undefined});
try{
 await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'");
 await pool.query("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','admin'))").catch(()=>{});
 const hash=await bcrypt.hash(password,12);
 const existing=await pool.query('SELECT id FROM users WHERE email=$1',[email]);
 if(existing.rowCount){await pool.query("UPDATE users SET name=$1,password_hash=$2,role='admin' WHERE email=$3",[name,hash,email]);console.log(`Admin atualizado: ${email}`)}
 else {await pool.query("INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'admin')",[name,email,hash]);console.log(`Admin criado: ${email}`)}
}finally{await pool.end()}
