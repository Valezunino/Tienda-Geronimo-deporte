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
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS model_code TEXT NOT NULL DEFAULT ''`;
  await sql`CREATE TABLE IF NOT EXISTS product_gallery (id BIGSERIAL PRIMARY KEY, model_code TEXT NOT NULL, color TEXT NOT NULL DEFAULT '', image TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`CREATE INDEX IF NOT EXISTS product_gallery_model_color_idx ON product_gallery(LOWER(model_code),LOWER(color),sort_order)`;
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;
  await sql`UPDATE products SET active=FALSE,updated_at=NOW() WHERE active=TRUE AND BTRIM(image)=''`;
  await sql`DROP INDEX IF EXISTS products_code_unique`;
  await sql`CREATE TABLE IF NOT EXISTS admin_audit(id BIGSERIAL PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS product_promotions(id BIGSERIAL PRIMARY KEY,product_name TEXT NOT NULL,category TEXT NOT NULL,offer_price NUMERIC(12,2) NOT NULL,starts_at TIMESTAMPTZ NOT NULL,ends_at TIMESTAMPTZ NOT NULL,actor TEXT NOT NULL DEFAULT '',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS product_promotions_product_unique ON product_promotions(LOWER(product_name),LOWER(category))`;
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sql = db(); await ensure(sql);
    if (req.method === 'GET') {
      const includeDrafts=req.query?.includeDrafts==='1' && authorized(req) && allowed(req,'products.view');
      const rows = includeDrafts
        ? await sql`SELECT id, code, model_code, name, category, price, description, sizes, colors, stock, image, tag, active FROM products WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC`
        : await sql`SELECT id, code, model_code, name, category, price, description, sizes, colors, stock, image, tag, active FROM products WHERE active=TRUE AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC`;
      const galleries=await sql`SELECT model_code,color,sort_order FROM product_gallery ORDER BY sort_order,id`;
      const galleryMap=new Map();for(const g of galleries){const key=`${String(g.model_code).toLocaleLowerCase()}|${String(g.color).toLocaleLowerCase()}`;if(!galleryMap.has(key))galleryMap.set(key,[]);galleryMap.get(key).push(`/api/product-image?model=${encodeURIComponent(g.model_code)}&color=${encodeURIComponent(g.color)}&index=${galleryMap.get(key).length}`)}
      const offers = await sql`SELECT product_name, category, offer_price FROM product_promotions WHERE starts_at <= NOW() AND ends_at >= NOW()`;
      const offerMap = new Map(offers.map(o=>[`${String(o.product_name).toLocaleLowerCase()}|${String(o.category).toLocaleLowerCase()}`,Number(o.offer_price)]));
      return res.status(200).json({ products: rows.map(p=>{const key=`${String(p.model_code||'').toLocaleLowerCase()}|${String(p.colors||'').toLocaleLowerCase()}`,images=galleryMap.get(key)||[];const fallback=String(p.image||'').startsWith('data:image/')?`/api/product-image?id=${p.id}`:p.image;return {...p,images:images.length?images:(fallback?[fallback]:[]),offer_price:offerMap.get(`${String(p.name).toLocaleLowerCase()}|${String(p.category).toLocaleLowerCase()}`)||null,image:fallback}}) });
    }
    if (req.method === 'DELETE') {
      if (!authorized(req)) return res.status(401).json({ error: 'Iniciá sesión para gestionar productos.' });
      if (!allowed(req, 'products.delete')) return res.status(403).json({ error: 'Tu rol no tiene permiso para eliminar productos.' });
      const id=Number(req.query?.id||req.body?.id),variantOnly=String(req.query?.variantOnly||'')==='1',modelWide=String(req.query?.model||req.body?.model||'')==='1';
      if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Elegí un producto válido.'});
      const target=await sql`SELECT code,model_code,name,category,price,description,sizes,colors,tag FROM products WHERE id=${id} AND deleted_at IS NULL LIMIT 1`;
      if(!target.length)return res.status(404).json({error:'No encontramos ese producto en el catálogo.'});
      const p=target[0];
      const removed=variantOnly
        ? await sql`UPDATE products SET active=FALSE,deleted_at=NOW(),updated_at=NOW() WHERE id=${id} AND deleted_at IS NULL RETURNING id`
        : modelWide&&p.model_code
          ? await sql`UPDATE products SET active=FALSE,deleted_at=NOW(),updated_at=NOW() WHERE LOWER(model_code)=LOWER(${p.model_code}) AND deleted_at IS NULL RETURNING id`
          : await sql`UPDATE products SET active=FALSE,deleted_at=NOW(),updated_at=NOW() WHERE LOWER(name)=LOWER(${p.name}) AND LOWER(category)=LOWER(${p.category}) AND price=${p.price} AND description=${p.description} AND colors=${p.colors} AND tag=${p.tag} AND deleted_at IS NULL RETURNING id`;
      if(!variantOnly)await sql`DELETE FROM product_promotions WHERE LOWER(product_name)=LOWER(${p.name}) AND LOWER(category)=LOWER(${p.category})`;
      const actor=identity(req)?.email||'usuario';
      const detail=variantOnly?p.name+' · '+p.category+' · Talle '+(p.sizes||'único')+' · '+(p.colors||'sin color'):p.name+' · '+p.category+' · '+removed.length+' variante(s)';
      await sql`INSERT INTO admin_audit(actor,action,detail) VALUES(${actor},'products.delete',${detail})`;
      return res.status(200).json({ok:true,count:removed.length,variantOnly,modelWide});
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    if (!authorized(req)) return res.status(401).json({ error: 'Iniciá sesión para gestionar productos.' });
    const createActor=identity(req)?.email||'usuario';
    if (req.body?.mode === 'update') {
      if (!allowed(req, 'products.edit')) return res.status(403).json({ error: 'Tu rol no tiene permiso para editar productos.' });
      const id=Number(req.body?.id), image=String(req.body?.image||'').trim();
      if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Elegí un producto válido.'});
      if(!image)return res.status(400).json({error:'Seleccioná una imagen antes de guardar.'});
      if(image.startsWith('data:')){
        if(image.length>440000)return res.status(413).json({error:'La imagen optimizada supera el límite de 320 KB.'});
        const match=image.match(/^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/);
        if(!match)return res.status(400).json({error:'El archivo debe ser una imagen JPG, PNG o WebP válida.'});
        const bytes=Buffer.from(match[2],'base64');
        if(!bytes.length||bytes.length>320*1024)return res.status(413).json({error:'La imagen optimizada supera el límite de 320 KB.'});
      } else {
        let url;try{url=new URL(image)}catch{return res.status(400).json({error:'La imagen debe tener una URL pública válida.'})}
        if(!['http:','https:'].includes(url.protocol))return res.status(400).json({error:'La imagen debe usar una URL HTTP o HTTPS.'});
      }
      const target=await sql`SELECT name,category,price,description,colors,tag FROM products WHERE id=${id} LIMIT 1`;
      if(!target.length)return res.status(404).json({error:'No encontramos ese producto.'});
      const p=target[0];
      const changed=await sql`UPDATE products SET image=${image},active=TRUE,updated_at=NOW() WHERE LOWER(name)=LOWER(${p.name}) AND LOWER(category)=LOWER(${p.category}) AND price=${p.price} AND description=${p.description} AND colors=${p.colors} AND tag=${p.tag} AND deleted_at IS NULL RETURNING id`;
      await sql`INSERT INTO admin_audit(actor,action,detail) VALUES(${createActor},'products.update',${'Agregó o actualizó la imagen de '+p.name+' y publicó '+changed.length+' variante(s)'})`;
      return res.status(200).json({ok:true,count:changed.length});
    }
    if (req.body?.mode === 'create' && req.body?.product) {
      if (!allowed(req, 'products.create')) return res.status(403).json({ error: 'Tu rol no tiene permiso para crear productos.' });
      const p=req.body.product;
      const baseCode=String(p.code||'').trim().slice(0,50), name=String(p.name||'').trim(), category=String(p.category||'').trim();
      const price=Number(p.price);
      const rawVariants=Array.isArray(p.variants)&&p.variants.length?p.variants:[{size:p.sizes,stock:p.stock}];
      if (!baseCode || !name || !category || !Number.isFinite(price) || price<0) return res.status(400).json({error:'Completá un código base, nombre, categoría y precio válido.'});
      if (rawVariants.length<1 || rawVariants.length>30) return res.status(400).json({error:'Agregá entre 1 y 30 talles por producto.'});
      const skuPart=value=>String(value||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,20);
      const colorPart=skuPart(p.colors).slice(0,15),codePrefix=baseCode.slice(0,colorPart?31:48);
      const variants=rawVariants.map((variant,index)=>{
        const size=String(variant.size||variant.sizes||'').trim().slice(0,30),stock=Number(variant.stock);
        const part=skuPart(size).slice(0,15);
        if(!size||!part||!Number.isInteger(stock)||stock<0) throw new Error(`Revisá el talle ${index+1}: ingresá un talle y un stock entero mayor o igual a cero.`);
        const code=colorPart?`${codePrefix}-${colorPart}-${part}`:`${codePrefix}-${part}`;
        return {size,stock,code};
      });
      const variantKeys=new Set();
      for(const variant of variants){const key=variant.code.toLocaleLowerCase();if(variantKeys.has(key))return res.status(400).json({error:'No podés cargar el mismo talle dos veces.'});variantKeys.add(key)}
      const rawImages=Array.isArray(p.images)?p.images:[];if(rawImages.length>6)return res.status(400).json({error:'Podés cargar hasta 6 fotos por color.'});
      let image=String(p.image||rawImages[0]||'').trim();
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
      for(const candidate of rawImages){if(typeof candidate!=='string'||!candidate.startsWith('data:'))return res.status(400).json({error:'Las fotos deben ser archivos JPG, PNG o WebP.'});const match=candidate.match(/^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/);if(!match)return res.status(400).json({error:'Una de las fotos no es válida.'});const bytes=Buffer.from(match[2],'base64');if(!bytes.length||bytes.length>320*1024)return res.status(413).json({error:'Cada foto optimizada debe pesar hasta 320 KB.'})}
      const common={name:name.slice(0,160),category:category.slice(0,80),description:String(p.description||'').slice(0,2000),colors:String(p.colors||'').slice(0,300)};
      const statements=variants.map(variant=>sql`INSERT INTO products (code,model_code,name,category,price,description,sizes,colors,stock,image,tag,active) VALUES (${variant.code},${baseCode},${common.name},${common.category},${price},${common.description},${variant.size},${common.colors},${variant.stock},${image},${''},${Boolean(image)}) RETURNING id,code,model_code,name,category,price,description,sizes,colors,stock,image,tag`);
      const inserted=await sql.transaction(statements);
      if(rawImages.length){await sql`DELETE FROM product_gallery WHERE LOWER(model_code)=LOWER(${baseCode}) AND LOWER(color)=LOWER(${common.colors})`;await sql.transaction(rawImages.map((photo,index)=>sql`INSERT INTO product_gallery(model_code,color,image,sort_order) VALUES(${baseCode},${common.colors},${photo},${index})`))}
      await sql`INSERT INTO admin_audit(actor,action,detail) VALUES(${createActor},'products.create',${`Agregó el producto ${name} con ${variants.length} talle${variants.length===1?'':'s'} (${baseCode})`})`;
      const galleryUrls=rawImages.map((_,index)=>`/api/product-image?model=${encodeURIComponent(baseCode)}&color=${encodeURIComponent(common.colors)}&index=${index}`);const products=inserted.flat().map(created=>({...created,images:galleryUrls.length?galleryUrls:(created.image?[String(created.image).startsWith('data:image/')?`/api/product-image?id=${created.id}`:created.image]:[]),image:galleryUrls[0]||(String(created.image||'').startsWith('data:image/')?`/api/product-image?id=${created.id}`:created.image)}));
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
    const statements = [sql`DELETE FROM products`,sql`DELETE FROM product_gallery`, ...clean.map(p => sql`INSERT INTO products (code,name, category, price, description, sizes, colors, stock, image, tag, active) VALUES (${p.code},${p.name},${p.category},${p.price},${p.description},${p.sizes},${p.colors},${p.stock},${p.image},${p.tag},${Boolean(p.image)})` )];
    await sql.transaction(statements);
    const actor=identity(req)?.email||'usuario';
    await sql`INSERT INTO admin_audit(actor,action,detail) VALUES(${actor},'products.import',${`Importó ${clean.length} productos`})`;
    return res.status(200).json({ ok:true, count:clean.length });
  } catch (e) { return res.status(400).json({ error:e.message || 'No se pudo procesar el catálogo.' }); }
};
