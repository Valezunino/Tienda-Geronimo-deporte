const { neon } = require('@neondatabase/serverless');
const { authorized, allowed, identity } = require('./_auth');
function db() { if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL no está configurada'); return neon(process.env.DATABASE_URL); }
async function ensure(sql) {
  await sql`CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
    price NUMERIC(12,2) NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '',
    sizes TEXT NOT NULL DEFAULT '', colors TEXT NOT NULL DEFAULT '', stock INTEGER NOT NULL DEFAULT 0,
    image TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS code TEXT NOT NULL DEFAULT ''`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS products_code_unique ON products(code) WHERE code<>''`;
  await sql`CREATE TABLE IF NOT EXISTS admin_audit(id BIGSERIAL PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ DEFAULT NOW())`;
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sql = db(); await ensure(sql);
    if (req.method === 'GET') {
      const rows = await sql`SELECT id, code, name, category, price, description, sizes, colors, stock, image, tag FROM products ORDER BY updated_at DESC, id DESC`;
      const offers = await sql`SELECT product_name, category, offer_price FROM product_promotions WHERE starts_at <= NOW() AND ends_at >= NOW()`;
      const offerMap = new Map(offers.map(o=>[`${String(o.product_name).toLocaleLowerCase()}|${String(o.category).toLocaleLowerCase()}`,Number(o.offer_price)]));
      return res.status(200).json({ products: rows.map(p=>({...p,offer_price:offerMap.get(`${String(p.name).toLocaleLowerCase()}|${String(p.category).toLocaleLowerCase()}`)||null,image:String(p.image||'').startsWith('data:image/')?`/api/product-image?id=${p.id}`:p.image})) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    if (!authorized(req)) return res.status(401).json({ error: 'Iniciá sesión para gestionar productos.' });
    const createActor=identity(req)?.email||'usuario';
    if (req.body?.mode === 'create' && req.body?.product) {
      if (!allowed(req, 'products.create')) return res.status(403).json({ error: 'Tu rol no tiene permiso para crear productos.' });
      const p=req.body.product;
      const baseCode=String(p.code||'').trim().slice(0,50), name=String(p.name||'').trim(), category=String(p.category||'').trim();
      const price=Number(p.price);
      const rawVariants=Array.isArray(p.variants)&&p.variants.length?p.variants:[{size:p.sizes,stock:p.stock}];
      if (!baseCode || !name || !category || !Number.isFinite(price) || price<0) return res.status(400).json({error:'Completá un código base, nombre, categoría y precio válido.'});
      if (rawVariants.length<1 || rawVariants.length>30) return res.status(400).json({error:'Agregá entre 1 y 30 talles por producto.'});
      const skuPart=value=>String(value||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,20);
      const variants=rawVariants.map((variant,index)=>{
        const size=String(variant.size||variant.sizes||'').trim().slice(0,30),stock=Number(variant.stock);
        const part=skuPart(size);
        if(!size||!part||!Number.isInteger(stock)||stock<0) throw new Error(`Revisá el talle ${index+1}: ingresá un talle y un stock entero mayor o igual a cero.`);
        return {size,stock,code:`${baseCode}-${part}`.slice(0,64)};
      });
      const variantKeys=new Set();
      for(const variant of variants){const key=variant.code.toLocaleLowerCase();if(variantKeys.has(key))return res.status(400).json({error:'No podés cargar el mismo talle dos veces.'});variantKeys.add(key)}
      let image=String(p.image||'').trim();
      if (image.startsWith('data:')) {
        if (image.length>440000) return res.status(413).json({error:'La imagen optimizada supera el límite de 320 KB.'});
        const match=image.match(/^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/);
        if (!match) return res.status(400).json({error:'El archivo debe ser una imagen JPG, PNG o WebP válida.'});
        const bytes=Buffer.from(match[2],'base64');
        if (!bytes.length || bytes.length>320*1024) return res.status(413).json({error:'La imagen optimizada supera el límite de 320 KB.'});
      } else if (image) {
        if (image.length>1500) return res.status(400).json({error:'La URL de imagen es demasiado larga.'});
        let url; try { url=new URL(image); } catch { return res.status(400).json({error:'La imagen debe tener una URL pública válida.'}); }
        if (!['http:','https:'].includes(url.protocol)) return res.status(400).json({error:'La imagen debe usar una URL HTTP o HTTPS.'});
      }
      const duplicates=[];
      for(const variant of variants){const found=await sql`SELECT id FROM products WHERE LOWER(code)=LOWER(${variant.code}) LIMIT 1`;if(found.length)duplicates.push(variant.code)}
      if(duplicates.length) return res.status(409).json({error:`Ya existen estos códigos SKU: ${duplicates.slice(0,5).join(', ')}.`});
      const common={name:name.slice(0,160),category:category.slice(0,80),description:String(p.description||'').slice(0,2000),colors:String(p.colors||'').slice(0,300)};
      const statements=variants.map(variant=>sql`INSERT INTO products (code,name,category,price,description,sizes,colors,stock,image,tag) VALUES (${variant.code},${common.name},${common.category},${price},${common.description},${variant.size},${common.colors},${variant.stock},${image},${''}) RETURNING id,code,name,category,price,description,sizes,colors,stock,image,tag`);
      const inserted=await sql.transaction(statements);
      await sql`INSERT INTO admin_audit(actor,action,detail) VALUES(${createActor},'products.create',${`Agregó el producto ${name} con ${variants.length} talle${variants.length===1?'':'s'} (${baseCode})`})`;
      const products=inserted.flat().map(created=>({...created,image:String(created.image||'').startsWith('data:image/')?`/api/product-image?id=${created.id}`:created.image}));
      return res.status(201).json({ok:true,count:products.length,products,product:products[0]});
    }
    if (!allowed(req, 'products.import')) return res.status(403).json({ error: 'Tu rol no tiene permiso para importar productos.' });
    const products = req.body?.products;
    if (!Array.isArray(products) || products.length < 1 || products.length > 500) return res.status(400).json({ error: 'El Excel debe incluir entre 1 y 500 productos.' });
    const clean = products.map((p, i) => {
      const name = String(p.name || '').trim(); const category = String(p.category || '').trim();
      const price = Number(p.price); const stock = Number(p.stock || 0);
      if (!name || !category || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) throw new Error(`Revisá la fila ${i + 2}: nombre, categoría, precio y stock son obligatorios y deben ser válidos.`);
      return { code:String(p.code||'').trim().slice(0,64), name: name.slice(0,160), category: category.slice(0,80), price, description:String(p.description||'').slice(0,2000), sizes:String(p.sizes||'').slice(0,300), colors:String(p.colors||'').slice(0,300), stock, image:String(p.image||'').slice(0,1500), tag:String(p.tag||'').slice(0,80) };
    });
    const codes=new Set(); for(const p of clean){const key=p.code.toLocaleLowerCase();if(key&&codes.has(key))throw new Error('Hay códigos de producto repetidos en el archivo.');if(key)codes.add(key)}
    const statements = [sql`DELETE FROM products`, ...clean.map(p => sql`INSERT INTO products (code,name, category, price, description, sizes, colors, stock, image, tag) VALUES (${p.code},${p.name},${p.category},${p.price},${p.description},${p.sizes},${p.colors},${p.stock},${p.image},${p.tag})` )];
    await sql.transaction(statements);
    const actor=identity(req)?.email||'usuario';
    await sql`INSERT INTO admin_audit(actor,action,detail) VALUES(${actor},'products.import',${`Importó ${clean.length} productos`})`;
    return res.status(200).json({ ok:true, count:clean.length });
  } catch (e) { return res.status(400).json({ error:e.message || 'No se pudo procesar el catálogo.' }); }
};
