# Gerónimo Deportes

Tienda web de Gerónimo Deportes desplegada en Vercel y conectada a Neon.

## Catálogo y panel

- La tienda consulta los productos publicados en Neon mediante `/api/products`.
- El panel privado está en `/admin.html`.
- Para cargar productos, descargá la plantilla CSV, completá los datos, guardala como `.xlsx` o `.csv`, subila al panel y confirmá luego de revisar la vista previa.
- Las columnas disponibles son `nombre`, `categoria`, `precio`, `descripcion`, `talles`, `colores`, `stock`, `imagen` y `etiqueta`. `nombre`, `categoria`, `precio` y `stock` son obligatorios. La imagen debe ser una URL pública.
- La importación reemplaza el catálogo completo actual.

## Variables privadas necesarias en Vercel

`DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` y `ADMIN_SESSION_SECRET`. No guardar estos valores en GitHub.
