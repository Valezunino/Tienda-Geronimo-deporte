const {neon}=require('@neondatabase/serverless');
const {identity,allowed}=require('../_auth');

async function setup(sql){
  await sql`CREATE TABLE IF NOT EXISTS products (id BIGSERIAL PRIMARY KEY,code TEXT NOT NULL DEFAULT '',name TEXT NOT NULL,category TEXT NOT NULL,price NUMERIC(12,2) NOT NULL DEFAULT 0,description TEXT NOT NULL DEFAULT '',sizes TEXT NOT NULL DEFAULT '',colors TEXT NOT NULL DEFAULT '',stock INTEGER NOT NULL DEFAULT 0,image TEXT NOT NULL DEFAULT '',tag TEXT NOT NULL DEFAULT '',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS code TEXT NOT NULL DEFAULT ''`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS products_code_unique ON products(code) WHERE code<>''`;
  await sql`CREATE TABLE IF NOT EXISTS admin_audit(id BIGSERIAL PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS inventory_movements(id BIGSERIAL PRIMARY KEY,product_id BIGINT NOT NULL,product_name TEXT NOT NULL,actor TEXT NOT NULL,movement TEXT NOT NULL CHECK(movement IN ('entrada','salida')),quantity INTEGER NOT NULL CHECK(quantity>0),reason TEXT NOT NULL DEFAULT '',sale_id BIGINT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS admin_sales(id BIGSERIAL PRIMARY KEY,actor TEXT NOT NULL,customer_name TEXT NOT NULL DEFAULT '',payment_method TEXT NOT NULL,total NUMERIC(12,2) NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS admin_sale_items(id BIGSERIAL PRIMARY KEY,sale_id BIGINT NOT NULL,product_id BIGINT NOT NULL,product_name TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price NUMERIC(12,2) NOT NULL,line_total NUMERIC(12,2) NOT NULL)`;
}
function db(){if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL no está configurada');return neon(process.env.DATABASE_URL)}
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  const actor=identity(req);
  if(!actor)return res.status(401).json({error:'Iniciá sesión.'});
  try{
    const sql=db();
    await setup(sql);
    if(req.method==='GET'){
      const section=String(req.query?.module||'');
      const permission=section==='stock'?'stock.view':section==='sales'?'sales.view':null;
      const manage=section==='stock'?'stock.manage':section==='sales'?'sales.manage':null;
      if(!permission)return res.status(400).json({error:'Sección no válida.'});
      if(!allowed(req,permission)&&!allowed(req,manage))return res.status(403).json({error:'Tu rol no tiene permiso para ver esta sección.'});
      const products=await sql`SELECT id,code,name,category,price,stock FROM products ORDER BY name`;
      if(section==='stock'){
        const movements=await sql`SELECT id,product_id,product_name,actor,movement,quantity,reason,created_at FROM inventory_movements ORDER BY created_at DESC LIMIT 200`;
        const lowStock=products.filter(p=>Number(p.stock)<=5);
        return res.status(200).json({products,movements,lowStock,threshold:5});
      }
      const sales=await sql`SELECT s.id,s.actor,s.customer_name,s.payment_method,s.total,s.created_at,COALESCE(json_agg(json_build_object('product_name',i.product_name,'quantity',i.quantity,'unit_price',i.unit_price,'line_total',i.line_total)) FILTER(WHERE i.id IS NOT NULL),'[]'::json) AS items FROM admin_sales s LEFT JOIN admin_sale_items i ON i.sale_id=s.id GROUP BY s.id ORDER BY s.created_at DESC LIMIT 100`;
      return res.status(200).json({products,sales});
    }
    if(req.method!=='POST')return res.status(405).json({error:'Método no permitido'});
    const body=req.body||{};
    if(body.action==='stock.adjust'){
      if(!allowed(req,'stock.manage'))return res.status(403).json({error:'Tu rol no puede gestionar el stock.'});
      const productId=Number(body.productId),quantity=Number(body.quantity),movement=String(body.movement||''),reason=String(body.reason||'').trim();
      if(!Number.isSafeInteger(productId)||productId<1||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000||!['entrada','salida'].includes(movement)||!reason||reason.length>300)return res.status(400).json({error:'Completá el producto, una cantidad válida y el motivo del movimiento.'});
      const delta=movement==='entrada'?quantity:-quantity;
      const rows=await sql`WITH updated AS (UPDATE products SET stock=stock+${delta},updated_at=NOW() WHERE id=${productId} AND stock+${delta}>=0 RETURNING id,name,stock),logged AS (INSERT INTO inventory_movements(product_id,product_name,actor,movement,quantity,reason) SELECT id,name,${actor.email||'usuario'},${movement},${quantity},${reason} FROM updated RETURNING id),audit AS (INSERT INTO admin_audit(actor,action,detail) SELECT ${actor.email||'usuario'},'stock.adjust',${movement||'Movimiento'}||' de '||${quantity}||' unidades · '||${reason} FROM logged RETURNING id) SELECT updated.stock FROM updated CROSS JOIN audit`;
      if(!rows.length)return res.status(409).json({error:'No se pudo actualizar. Revisá el producto y que haya stock suficiente para la salida.'});
      return res.status(200).json({ok:true,stock:Number(rows[0].stock)});
    }
    if(body.action==='sales.create'){
      if(!allowed(req,'sales.manage'))return res.status(403).json({error:'Tu rol no puede registrar ventas.'});
      const customer=String(body.customer||'').trim().slice(0,160),payment=String(body.payment||'');
      const allowedPayments=['efectivo','transferencia','debito','credito','mercado_pago'];
      if(!allowedPayments.includes(payment))return res.status(400).json({error:'Seleccioná un medio de pago válido.'});
      if(!Array.isArray(body.items)||body.items.length<1||body.items.length>50)return res.status(400).json({error:'La venta debe tener entre 1 y 50 productos.'});
      const quantities=new Map();
      for(const item of body.items){const id=Number(item.productId),quantity=Number(item.quantity);if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000)return res.status(400).json({error:'Revisá los productos y cantidades de la venta.'});quantities.set(id,(quantities.get(id)||0)+quantity)}
      const items=JSON.stringify([...quantities].map(([id,quantity])=>({id,quantity})));
      const rows=await sql`WITH input AS (SELECT id,quantity FROM jsonb_to_recordset(${items}::jsonb) AS x(id BIGINT,quantity INTEGER)),locked AS MATERIALIZED (SELECT p.id,p.name,p.price,p.stock,i.quantity FROM products p JOIN input i ON i.id=p.id ORDER BY p.id FOR UPDATE OF p),valid AS (SELECT COUNT(*)=(SELECT COUNT(*) FROM input) AND COALESCE(BOOL_AND(stock>=quantity),FALSE) AS ok FROM locked),new_sale AS (INSERT INTO admin_sales(actor,customer_name,payment_method,total) SELECT ${actor.email||'usuario'},${customer},${payment},COALESCE(SUM(price*quantity),0) FROM locked CROSS JOIN valid WHERE valid.ok RETURNING id,total),updated AS (UPDATE products p SET stock=p.stock-l.quantity,updated_at=NOW() FROM locked l CROSS JOIN new_sale s WHERE p.id=l.id RETURNING p.id),items AS (INSERT INTO admin_sale_items(sale_id,product_id,product_name,quantity,unit_price,line_total) SELECT s.id,l.id,l.name,l.quantity,l.price,l.price*l.quantity FROM locked l CROSS JOIN new_sale s JOIN updated u ON u.id=l.id RETURNING product_id,product_name,quantity),moves AS (INSERT INTO inventory_movements(product_id,product_name,actor,movement,quantity,reason,sale_id) SELECT i.product_id,i.product_name,${actor.email||'usuario'},'salida',i.quantity,'Venta #'||s.id,s.id FROM items i CROSS JOIN new_sale s RETURNING id),audit AS (INSERT INTO admin_audit(actor,action,detail) SELECT ${actor.email||'usuario'},'sales.create','Venta #'||s.id||' · '||s.total||' · '||${payment} FROM new_sale s RETURNING id) SELECT s.id,s.total,(SELECT ok FROM valid) AS valid FROM new_sale s CROSS JOIN audit`;
      if(!rows.length)return res.status(409).json({error:'No se registró la venta: algún producto no existe o no tiene stock suficiente.'});
      return res.status(201).json({ok:true,saleId:Number(rows[0].id),total:Number(rows[0].total)});
    }
    return res.status(400).json({error:'Acción no reconocida.'});
  }catch(error){return res.status(400).json({error:error.message||'No se pudo completar la operación.'})}
};
