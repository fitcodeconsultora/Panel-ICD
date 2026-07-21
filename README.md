# Fitcode · Tablero de Indicadores

Webapp de gestión de KPIs para gimnasios clientes de Fitcode. Cada gimnasio carga sus datos
mensuales (a mano o importando un CSV/Excel de otro sistema) y la app calcula automáticamente
todos los indicadores clave (ICV, rotación, LTV, rentabilidad, etc.) usando las mismas fórmulas
del Excel `Proyeccion_STARTUP_26_4.xlsx`. Julián ve todo consolidado desde un rol de administrador.

## Stack

- **Frontend:** HTML + JS vanilla (sin build step, para poder subirlo directo a GitHub Pages,
  igual que tus otras herramientas en `julianrud.github.io`).
- **Backend:** Firebase (Auth + Firestore), mismo patrón que Planificador / Semáforo / Kanbans.
- **Gráficos:** Chart.js (CDN).
- **Import CSV/Excel:** PapaParse (CSV) + SheetJS (XLSX), ambos por CDN.

## Estructura de archivos

```
fitcode-kpi-app/
├── index.html          # UI: login, carga manual, import, dashboard
├── styles.css          # Sistema visual Fitcode (naranja #E05E2A + panel de control)
├── app.js              # Lógica: Firebase, cálculos de KPIs, import, gráficos
├── firebase-config.js  # ⚠️ COMPLETAR con tu proyecto Firebase (no se sube al repo público)
└── README.md
```

## 1. Crear el proyecto Firebase (una sola vez)

1. Andá a [console.firebase.google.com](https://console.firebase.google.com) → **Crear proyecto**
   (ej: `fitcode-kpi`).
2. **Authentication** → Sign-in method → activá **Email/Password**.
3. **Firestore Database** → Crear base de datos → modo producción → elegí región `southamerica-east1`
   (San Pablo, la más cercana a Argentina).
4. **Configuración del proyecto** (ícono de tuerca) → **Tus apps** → **Web (`</>`)** → registrá
   una app → copiá el objeto `firebaseConfig` que te da.
5. Pegá ese objeto en `firebase-config.js` (te dejé la plantilla exacta abajo).

```js
// firebase-config.js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

## 2. Reglas de Firestore (multi-tenant por gimnasio)

En Firestore → **Reglas**, pegá esto (cada gimnasio solo lee/escribe sus propios datos; vos, como
admin, leés todo). Esta versión usa una regla genérica para **cualquier subcolección** dentro de
cada cliente (`datosMensuales`, `comercialDiario`, `comercialMensual`, y cualquier otra que sumemos
en el futuro), así no hay que volver a tocar las reglas cada vez que agregamos una sección nueva:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isAdmin() {
      return request.auth != null &&
             get(/databases/$(database)/documents/usuarios/$(request.auth.uid)).data.rol == 'admin';
    }

    function esMismoGym(gymId) {
      return request.auth != null &&
             get(/databases/$(database)/documents/usuarios/$(request.auth.uid)).data.gymId == gymId;
    }

    match /usuarios/{userId} {
      allow read: if request.auth != null && (request.auth.uid == userId || isAdmin());
      allow write: if isAdmin();
    }

    match /clientes/{gymId} {
      allow read: if isAdmin() || esMismoGym(gymId);
      allow write: if isAdmin();

      match /{coleccion}/{docId} {
        allow read: if isAdmin() || esMismoGym(gymId);
        allow write: if isAdmin() || esMismoGym(gymId);
      }
    }
  }
}
```

**⚠️ Si ya tenías las reglas viejas publicadas:** reemplazalas por estas — las anteriores solo
cubrían `datosMensuales`, por eso `comercialDiario` y `comercialMensual` no cargaban (Firestore
rechaza en silencio cualquier lectura/escritura que no esté explícitamente permitida).

## 3. Crear usuarios (vos y cada gimnasio)

Por ahora se crean a mano desde la consola de Firebase (más simple para arrancar):

1. **Authentication** → **Users** → **Add user** → email + contraseña provisoria para cada gimnasio
   y para vos.
2. **Firestore** → colección `usuarios` → documento con **ID = el UID** que te generó Auth:
   ```
   usuarios/{uid}
     nombre: "Andino CF"
     rol: "gimnasio"        // o "admin" para tu usuario
     gymId: "andino-cf"     // identificador corto, sin espacios
   ```
3. **Firestore** → colección `clientes` → documento `clientes/andino-cf`:
   ```
   nombre: "Andino CF"
   ciudad: "Buenos Aires"
   metaFacturacionMensual: 0
   ```

Cuando quieras, armamos una pantalla de alta de gimnasios/usuarios para no tener que tocar la
consola de Firebase — lo dejé afuera del v1 para no sumar complejidad innecesaria.

## 4. Publicar en GitHub Pages

Igual que tus otros proyectos: subís esta carpeta a un repo (o a una subcarpeta de
`julianrud.github.io`) y activás GitHub Pages en la configuración del repo.

⚠️ **Importante:** `firebase-config.js` con las claves de tu proyecto quedaría público en GitHub.
Para Firebase esto es normal y esperado (la seguridad real la dan las Reglas de Firestore de arriba,
no esconder la config) — es el mismo esquema que ya usás en tus otras apps.

## Modelo de datos por mes (`clientes/{gymId}/datosMensuales/{YYYY-MM}`)

Estos son los campos que se cargan (a mano o por import) — son exactamente las columnas de la
hoja `Progreso` del Excel:

| Campo | Descripción |
|---|---|
| `facturacion` | Facturación del mes |
| `activos` | Clientes activos a fin de mes |
| `ventas` | Ventas (altas) del mes |
| `visitas` | Visitantes/visitas de venta del mes |
| `bajas` | Bajas del mes |
| `aRenovar` | Planes que vencían este mes |
| `renovados` | De esos, cuántos renovaron |
| `leads` | Leads generados |
| `metaFacturacion` | Meta de facturación del mes |
| `sueldos`, `gastos`, `impuestos`, `alquiler` | Estructura de costos |
| `inflacion` | % inflación del mes (opcional, para IPC de servicios) |
| `observaciones` | Texto libre |

## KPIs calculados automáticamente (mismas fórmulas que el Excel)

| KPI | Fórmula |
|---|---|
| Ticket promedio | `facturacion / activos` |
| % Meta Facturación | `facturacion / metaFacturacion` |
| ICV (Índice Conversión Ventas) | `ventas / visitas` |
| % Índice Renovación | `renovados / aRenovar` |
| Rotación (Churn) | `bajas / activos_mes_anterior` |
| Vida Media | `1 / rotación` |
| LTV | `ticketPromedio × vidaMedia` |
| Gastos Total | `sueldos + gastos + impuestos + alquiler` |
| Rentabilidad | `1 − (gastosTotal / facturacion)` |
| Utilidad | `facturacion − gastosTotal` |
| % variación de facturación (m/m) | `(mes_actual − mes_anterior) / mes_anterior` |
| Sueldos % / Gastos % / Impuestos % / Alquiler % | cada uno `/ gastosTotal` |

## Import de CSV/Excel

En la pestaña **Importar**, subís un `.csv` o `.xlsx` con una fila por mes. La primera fila debe
tener los mismos nombres de columna que la tabla de arriba (`facturacion`, `activos`, `ventas`, …).
Te dejé una plantilla descargable desde la propia app (botón "Descargar plantilla") para que se
la pases a cada gimnasio o a quien exporte del otro sistema.

## Estructura de navegación

La app ahora tiene 3 secciones principales en el menú lateral:

- **Dashboard** — resumen general (mezcla indicadores de Comercial y Operaciones): facturación, ICV, % renovación, rotación, rentabilidad, etc.
- **Comercial** — embudo de ventas, con 3 sub-vistas (igual a tu herramienta de carga diaria):
  - **Carga diaria**: una fila por día del mes, con los 7 campos del embudo (Averiguadores, Averig. agendados, Agendados a clase, Asistencia invitación, Visitas, Ventas de visita, Ventas de averiguador). Ventas totales y Efectividad se calculan solas. Guarda automático (con debounce) apenas se edita una celda.
  - **Resumen mensual**: Inversión $ y Ticket promedio (carga manual) + métricas calculadas (Costo por lead, CAC, Facturación estimada, ROI) + gráfico de funnel del mes.
  - **Dashboard (comercial)**: KPIs del mes + evolución diaria de ventas y efectividad.
- **Operaciones** — lo que antes era "Cargar datos" + "Importar CSV/Excel": facturación, activos, costos, rentabilidad, LTV, etc. (cierre mensual).

## Modelo de datos — Comercial

Colecciones nuevas por gimnasio:

- `clientes/{gymId}/comercialDiario/{YYYY-MM-DD}` — un documento por día:
  ```
  averiguadores, averigAgendados, agendadosClase, asistenciaInvitacion,
  visitas, ventasVisita, ventasAveriguador
  ```
  (ventasTotales y efectividad se calculan en el cliente, no se guardan)

- `clientes/{gymId}/comercialMensual/{YYYY-MM}` — un documento por mes:
  ```
  inversion, ticketProm
  ```

**⚠️ Nota sobre las reglas de Firestore:** las reglas del paso 2 (más abajo) ya cubren cualquier subcolección dentro de `clientes/{gymId}/`, así que `comercialDiario` y `comercialMensual` funcionan con las mismas reglas que `datosMensuales` — no hace falta tocar nada ahí.

### Fórmulas del módulo Comercial

| Métrica | Fórmula |
|---|---|
| Ventas totales (por día) | `ventasVisita + ventasAveriguador` |
| Efectividad (por día) | `ventasTotales / averiguadores` |
| Agendados (mes, para el funnel) | `Σaverig.agendados + Σagendados a clase` |
| Costo por lead | `inversión / Σaveriguadores del mes` |
| CAC | `inversión / Σventas totales del mes` |
| Facturación estimada | `Σventas totales del mes × ticket promedio` |
| ROI del mes | `(facturación estimada − inversión) / inversión` |

Si alguna de estas fórmulas no coincide exactamente con la lógica de tu herramienta original, decime cuál y la ajusto — las armé interpretando las columnas de las capturas que me pasaste.



- Alta de gimnasios/usuarios desde la UI (por ahora, consola de Firebase).
- Integración en vivo con APIs de otros sistemas (dijiste que hoy no está integrado — cuando
  definas qué sistema puntual vas a conectar, sumamos esa integración específica).
- Carga diaria (Tablero ICD del Excel) — el v1 se centra en el cierre mensual. Si lo necesitás,
  es un tab más con el mismo patrón.
