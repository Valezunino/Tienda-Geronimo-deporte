const {neon}=require('@neondatabase/serverless');
const {identity,allowed}=require('../_auth');
function database(){if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL no está configurada');return neon(process.env.DATABASE_URL)}
async function setup(sql){
 await sql`CREATE TABLE IF NOT EXISTS product_promotions(
  id BIGSERIAL PRIMARY KEY,
  product_name TEXT NOT NULL,
  category TEXT NOT NULL,
  offer_price NUMERIC(12,2) NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`;
 await sql`CREATE UNIQUE INDEX IF NOT EXISTS product_promotions_product_unique ON product_promotions(LOWER(product_name),LOWER(category))`;
}
module.exports=async function(req,res){
 res.setHeader('Cache-Control','no-store');
 try{
  const user=identity(req);
  if(!user)return res.status(401).json({error:'Iniciá sesión para gestionar promociones.'});
  const sql=database();await setup(sql);
  if(req.method==='GET'){
   if(!allowed(req,'promotions.view')&&!allowed(req,'promotions.manage'))return res.status(403).json({error:'Tu rol no tiene permiso para ver promociones.'});
   const promotions=await sql`SELECT id,product_name,category,offer_price,starts_at,ends_at,actor,updated_at FROM product_promotions ORDER BY updated_at DESC`;
   return res.status(200).json({promotions});
  }
  if(req.method==='POST'){
   if(!allowed(req,'promotions.manage'))return res.status(403).json({error:'Tu rol no puede administrar promociones.'});
   const b=req.body||{},productName=String(b.productName||'').trim(),category=String(b.category||'').trim(),offerPrice=Number(b.offerPrice),startsAt=new Date(b.startsAt),endsAt=new Date(b.endsAt);
   if(!productName||!category||!Number.isFinite(offerPrice)||offerPrice<=0||Number.isNaN(startsAt.valueOf())||Number.isNaN(endsAt.valueOf())||startsAt>=endsAt)return res.status(400).json({error:'Completá producto, precio y un período válido.'});
   const product=await sql`SELECT MAX(price) AS price FROM products WHERE LOWER(name)=LOWER(${productName}) AND LOWER(category)=LOWER(${category})`;
   if(!product.length||Number(product[0].price)<=0)return res.status(404).json({error:'No encontramos el producto o no tiene un precio oficial válido.'});
   if(offerPrice>=Number(product[0].price))return res.status(400).json({error:'El precio de oferta debe ser menor que el precio oficial ('+Number(product[0].price).toLocaleString('es-AR')+').' });
   const actor=user.email||'usuario';
   const saved=await sql`INSERT INTO product_promotions(product_name,category,offer_price,starts_at,ends_at,actor) VALUES(${productName},${category},${offerPrice},${startsAt.toISOString()},${endsAt.toISOString()},${actor}) ON CONFLICT (LOWER(product_name),LOWER(category)) DO UPDATE SET offer_price=EXCLUDED.offer_price,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,actor=EXCLUDED.actor,updated_at=NOW() RETURNING id,product_name,category,offer_price,starts_at,ends_at,actor,updated_at`;
   await sql`INSERT INTO admin_audit(actor,action,detail) VALUES(${actor},'promotion.save',${productName+' · '+category+' · $'+offerPrice})`;
   return res.status(200).json({promotion:saved[0]});
  }
  if(req.method==='DELETE'){
   if(!allowed(req,'promotions.manage'))return res.status(403).json({error:'Tu rol no puede administrar promociones.'});
   const id=Number(req.query?.id||req.body?.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Elegí una promoción válida.'});
   const removed=await sql`DELETE FROM product_promotions WHERE id=${id} RETURNING product_name,category`;
   if(!removed.length)return res.status(404).json({error:'No encontramos esa promoción.'});
   await sql`INSERT INTO admin_audit(actor,action,detail) VALUES(${user.email||'usuario'},'promotion.delete',${removed[0].product_name+' · '+removed[0].category})`;
   return res.status(200).json({ok:true});
  }
  return res.status(405).json({error:'Método no permitido'});
 }catch(e){return res.status(400).json({error:e.message||'No se pudieron procesar las promociones.'})}
};
