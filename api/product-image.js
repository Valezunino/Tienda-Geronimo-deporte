const { neon } = require('@neondatabase/serverless');
function db() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL no está configurada');
  return neon(process.env.DATABASE_URL);
}
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
  const id=Number(req.query?.id),model=String(req.query?.model||'').slice(0,50),color=String(req.query?.color||'').slice(0,300),index=Number(req.query?.index||0);
  const galleryRequest=Boolean(model);
  if ((!galleryRequest&&(!Number.isSafeInteger(id)||id<1))||(galleryRequest&&(!Number.isSafeInteger(index)||index<0||index>5))) return res.status(400).json({ error: 'Imagen no válida.' });
  try {
    const sql=db();
    const rows=galleryRequest?await sql`SELECT image FROM product_gallery WHERE LOWER(model_code)=LOWER(${model}) AND LOWER(color)=LOWER(${color}) ORDER BY sort_order,id LIMIT 1 OFFSET ${index}`:await sql`SELECT image FROM products WHERE id=${id} LIMIT 1`;
    const image=String(rows[0]?.image||'');
    const match=image.match(/^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) return res.status(404).json({ error: 'No se encontró la imagen.' });
    const bytes=Buffer.from(match[2],'base64');
    if (!bytes.length || bytes.length>320*1024) return res.status(404).json({ error: 'No se encontró la imagen.' });
    res.setHeader('Content-Type',match[1]);
    res.setHeader('Content-Length',String(bytes.length));
    res.setHeader('Cache-Control','public, max-age=60, s-maxage=300, stale-while-revalidate=3600');
    res.setHeader('X-Content-Type-Options','nosniff');
    return res.status(200).send(bytes);
  } catch (error) {
    return res.status(500).json({ error: 'No se pudo cargar la imagen.' });
  }
};
