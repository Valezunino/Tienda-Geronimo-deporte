const { neon } = require('@neondatabase/serverless');
const { authorized, allowed } = require('./_auth');
function db() { if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL no está configurada'); return neon(process.env.DATABASE_URL); }
async function ensure(sql) {
  await sql`CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
    price NUMERIC(12,2) NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '',
    sizes TEXT NOT NULL DEFAULT '', colors TEXT NOT NULL DEFAULT '', stock INTEGER NOT NULL DEFAULT 0,
    image TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sql = db(); await ensure(sql);
    if (req.method === 'GET') {
      const rows = await sql`SELECT id, name, category, price, description, sizes, colors, stock, image, tag FROM products ORDER BY updated_at DESC, id DESC`;
      return res.status(200).json({ products: rows });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    if (!authorized(req)) return res.status(401).json({ error: 'Iniciá sesión para importar productos.' });
    if (!allowed(req, 'products.import')) return res.status(403).json({ error: 'Tu rol no tiene permiso para importar productos.' });
    const products = req.body?.products;
    if (!Array.isArray(products) || products.length < 1 || products.length > 500) return res.status(400).json({ error: 'El Excel debe incluir entre 1 y 500 productos.' });
    const clean = products.map((p, i) => {
      const name = String(p.name || '').trim(); const category = String(p.category || '').trim();
      const price = Number(p.price); const stock = Number(p.stock || 0);
      if (!name || !category || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) throw new Error(`Revisá la fila ${i + 2}: nombre, categoría, precio y stock son obligatorios y deben ser válidos.`);
      return { name: name.slice(0,160), category: category.slice(0,80), price, description:String(p.description||'').slice(0,2000), sizes:String(p.sizes||'').slice(0,300), colors:String(p.colors||'').slice(0,300), stock, image:String(p.image||'').slice(0,1500), tag:String(p.tag||'').slice(0,80) };
    });
    const statements = [sql`DELETE FROM products`, ...clean.map(p => sql`INSERT INTO products (name, category, price, description, sizes, colors, stock, image, tag) VALUES (${p.name},${p.category},${p.price},${p.description},${p.sizes},${p.colors},${p.stock},${p.image},${p.tag})`)];
    await sql.transaction(statements);
    return res.status(200).json({ ok:true, count:clean.length });
  } catch (e) { return res.status(400).json({ error:e.message || 'No se pudo procesar el catálogo.' }); }
};
