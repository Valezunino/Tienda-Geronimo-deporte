const crypto = require('node:crypto');

function secret() {
  if (!process.env.ADMIN_SESSION_SECRET) throw new Error('Falta configurar ADMIN_SESSION_SECRET');
  return process.env.ADMIN_SESSION_SECRET;
}
function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}
function setCookie(res, value) {
  res.setHeader('Set-Cookie', `gd_admin=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', 'gd_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
}
function issue(res) {
  const data = Buffer.from(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
  setCookie(res, `${data}.${sign(data)}`);
}
function authorized(req) {
  try {
    const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('gd_admin='))?.slice(9);
    if (!token) return false;
    const [data, sig] = token.split('.');
    const a = Buffer.from(sig || '');
    const b = Buffer.from(sign(data || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return JSON.parse(Buffer.from(data, 'base64url').toString()).exp > Date.now();
  } catch { return false; }
}
module.exports = { issue, clearCookie, authorized };
