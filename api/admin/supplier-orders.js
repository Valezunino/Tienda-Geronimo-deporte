const {neon}=require('@neondatabase/serverless');
const {identity,allowed}=require('../_auth');
function db(){if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL no está configurada');return neon(process.env.DATABASE_URL)}
async function setup(sql){
  await sql`CREATE TABLE IF NOT EXISTS supplier_orders(
    id BIGSERIAL PRIMARY KEY,
    supplier_email TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    item_count INTEGER NOT NULL DEFAULT 0,
    total NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS supplier_order_items(
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES supplier_orders(id) ON DELETE CASCADE,
    product_code TEXT NOT NULL DEFAULT '',
    product_name TEXT NOT NULL,
    quantity NUMERIC(12,3) NOT NULL,
    unit_cost NUMERIC(14,2) NOT NULL,
    line_total NUMERIC(14,2) NOT NULL
  )`;
}
module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const actor=identity(req);
  if(!actor)return res.status(401).json({error:'Iniciá sesión.'});
  if(!allowed(req,'purchases.view')&&!allowed(req,'purchases.manage'))return res.status(403).json({error:'Tu rol no tiene permiso para acceder a los pedidos a proveedores.'});
  try{
    const sql=db();await setup(sql);
    if(req.method==='GET'){
      const isOwner=actor.role==='owner';
      const rows=isOwner
        ?await sql`SELECT o.id,o.supplier_email,o.reference,o.file_name,o.item_count,o.total,o.created_at,COALESCE(json_agg(json_build_object('product_code',i.product_code,'product_name',i.product_name,'quantity',i.quantity,'unit_cost',i.unit_cost,'line_total',i.line_total)) FILTER(WHERE i.id IS NOT NULL),'[]'::json) AS items FROM supplier_orders o LEFT JOIN supplier_order_items i ON i.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 500`
        :await sql`SELECT o.id,o.supplier_email,o.reference,o.file_name,o.item_count,o.total,o.created_at,COALESCE(json_agg(json_build_object('product_code',i.product_code,'product_name',i.product_name,'quantity',i.quantity,'unit_cost',i.unit_cost,'line_total',i.line_total)) FILTER(WHERE i.id IS NOT NULL),'[]'::json) AS items FROM supplier_orders o LEFT JOIN supplier_order_items i ON i.order_id=o.id WHERE LOWER(o.supplier_email)=LOWER(\${actor.email||''}) GROUP BY o.id ORDER BY o.created_at DESC LIMIT 500`;
      return res.status(200).json({orders:rows,ownerView:isOwner});
    }
    if(req.method!=='POST')return res.status(405).json({error:'Método no permitido'});
    if(!allowed(req,'purchases.manage'))return res.status(403).json({error:'Tu rol no tiene permiso para cargar pedidos.'});
    const body=req.body||{},email=String(actor.email||'').trim().toLowerCase();
    const requestedSupplier=String(body.supplierEmail||'').trim().toLowerCase();
    const supplierEmail=actor.role==='owner'&&requestedSupplier?requestedSupplier:email;
    if(supplierEmail&&!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(supplierEmail))return res.status(400).json({error:'Ingresá un correo válido para el proveedor.'});
    const reference=String(body.reference||'').trim().slice(0,120),fileName=String(body.fileName||'').trim().slice(0,180);
    if(!email||!fileName)return res.status(400).json({error:'No se pudo identificar la cuenta o el archivo.'});
    if(!Array.isArray(body.items)||body.items.length<1||body.items.length>2000)return res.status(400).json({error:'El Excel debe contener entre 1 y 2.000 renglones.'});
    const items=body.items.map((x,index)=>{
      const name=String(x.productName||x.name||'').trim().slice(0,180),code=String(x.productCode||x.code||'').trim().slice(0,80),quantity=Number(x.quantity),unitCost=Number(x.unitCost);
      if(!name||!Number.isFinite(quantity)||quantity<=0||quantity>1000000||!Number.isFinite(unitCost)||unitCost<0||unitCost>1000000000)throw new Error('Revisá el renglón '+(index+2)+': producto, cantidad y costo unitario deben ser válidos.');
      return {productCode:code,productName:name,quantity,unitCost,lineTotal:Math.round(quantity*unitCost*100)/100};
    });
    const total=Math.round(items.reduce((sum,x)=>sum+x.lineTotal,0)*100)/100;
    const payload=JSON.stringify(items);
    const rows=await sql`WITH created AS (
      INSERT INTO supplier_orders(supplier_email,reference,file_name,item_count,total)
      VALUES(\${email},\${reference},\${fileName},\${items.length},\${total}) RETURNING id
    ), inserted_items AS (
      INSERT INTO supplier_order_items(order_id,product_code,product_name,quantity,unit_cost,line_total)
      SELECT created.id,x.product_code,x.product_name,x.quantity,x.unit_cost,x.line_total
      FROM created CROSS JOIN jsonb_to_recordset(\${payload}::jsonb) AS x(product_code TEXT,product_name TEXT,quantity NUMERIC,unit_cost NUMERIC,line_total NUMERIC)
      RETURNING id
    ), logged AS (
      INSERT INTO admin_audit(actor,action,detail)
      SELECT \${email},'supplier.order.upload',\${'Cargó pedido '+reference+' con '+items.length+' renglones por $ '+total}
      RETURNING id
    )
    SELECT created.id FROM created CROSS JOIN (SELECT COUNT(*) FROM inserted_items) AS complete CROSS JOIN logged`;
    return res.status(201).json({ok:true,orderId:rows[0].id,itemCount:items.length,total});
  }catch(error){return res.status(400).json({error:error.message||'No se pudo guardar el pedido del proveedor.'})}
};
