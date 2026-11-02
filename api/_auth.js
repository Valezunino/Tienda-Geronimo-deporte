const crypto=require('node:crypto');
function secret(){if(!process.env.ADMIN_SESSION_SECRET)throw new Error('Falta ADMIN_SESSION_SECRET');return process.env.ADMIN_SESSION_SECRET}
function sign(v){return crypto.createHmac('sha256',secret()).update(v).digest('base64url')}
function issue(res,user={}){const data=Buffer.from(JSON.stringify({exp:Date.now()+8*3600000,...user})).toString('base64url');res.setHeader('Set-Cookie',`gd_admin=${data}.${sign(data)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`)}
function clearCookie(res){res.setHeader('Set-Cookie','gd_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0')}
function identity(req){try{const t=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('gd_admin='))?.slice(9);if(!t)return null;const[d,s]=t.split('.'),a=Buffer.from(s||''),b=Buffer.from(sign(d||''));if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return null;const u=JSON.parse(Buffer.from(d,'base64url').toString());return u.exp>Date.now()?u:null}catch{return null}}
function authorized(req){return !!identity(req)}
function allowed(req,p){const u=identity(req);return !!u&&(u.role==='owner'||u.permissions?.includes('*')||u.permissions?.includes(p))}
module.exports={issue,clearCookie,authorized,allowed,identity};