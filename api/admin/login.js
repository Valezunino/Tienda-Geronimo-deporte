const { issue, clearCookie } = require('../_auth');
module.exports = async function handler(req, res) {
  if (req.method === 'DELETE') { clearCookie(res); return res.status(200).json({ ok: true }); }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  const { email, password } = req.body || {};
  const expectedEmail = process.env.ADMIN_EMAIL || 'geronimodeporte@gmail.com';
  if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_SESSION_SECRET) return res.status(503).json({ error: 'El acceso administrativo todavía no está configurado en Vercel.' });
  if (String(email || '').toLowerCase() !== expectedEmail.toLowerCase() || password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  try { issue(res); return res.status(200).json({ ok: true }); }
  catch { return res.status(503).json({ error: 'Falta configurar la sesión segura en Vercel.' }); }
};
