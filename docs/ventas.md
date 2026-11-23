# Ventas: asistente comercial (Phase 73)

Módulo en español dentro de la app (`/app/sales`, entrada **Ventas** en el menú lateral y en
las Apps del teléfono; desde el chat con `/ventas`). Solo para el equipo (miembros y admins);
los externos no entran.

## Cómo está hecho

| Capa     | Dónde                                              | Qué hace                                                                                                                                              |
| -------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Núcleo   | `packages/shared/src/sales.ts`, `salesDemo.ts`     | Modelo de datos, permisos (`visibleSales`, `canEditSales`), ROI, pronóstico, prioridades, citas textuales, métricas de llamadas, duplicados, datos demo |
| Servidor | `backend/src/handlers/sales.ts`, `lib/salesAi.ts`  | API `/sales/*`, flujos de IA en Bedrock (el mismo modelo de AI Notes), verificación de fuentes y citas, CRM con confirmación e idempotencia           |
| Datos    | tabla DynamoDB `slack-<stage>-sales`               | Una partición por organización: `rec#` registros, `art#` resultados generados, `chg#` historial de cambios, `applied#` cambios de CRM confirmados       |
| Interfaz | `apps/web/src/components/sales/`                   | Pestañas: Mi panel, Cuentas, Pronóstico, Liderazgo, Prospección, Respuestas, Coaching, Demo guiada                                                     |

Reglas que valen para todo el módulo:

- **Permisos.** Un vendedor ve sus cuentas y lo que cuelga de ellas, sus registros, el
  conocimiento compartido (documentos, competidores) y la demo. Un admin ve todo. El servidor
  parte siempre de ese conjunto: listas, contexto del modelo, citas, exportaciones y cambios
  propuestos salen de ahí.
- **Cifras en código.** ROI, totales de pronóstico, prioridades y métricas de llamadas los
  calcula `@mindfultech/shared`; el modelo solo redacta alrededor.
- **Fuentes.** Cada punto generado lleva los ids de los registros que lo respaldan (enlaces en
  la interfaz). Una fuente que el modelo no recibió se descarta; un «hecho» sin fuente pasa a
  «hipótesis»; una «cita» que no está palabra por palabra en su fuente pasa a «paráfrasis».
- **Nada se envía ni se escribe solo.** Los borradores se editan en pantalla; el CRM se
  actualiza solo al confirmar los cambios exactos (antes → después), y un reintento con la
  misma clave no aplica nada dos veces.
- **Contenido de referencia.** Notas, transcripciones, documentos y texto pegado se pasan al
  modelo como contenido, nunca como instrucciones.

## Las 17 capacidades

Estado: **Completa** (funciona con los datos del módulo), **Con datos pegados** (no hay
integración externa; se pega o se carga el contenido), **Pendiente** (no hecho).

| #   | Capacidad                       | Estado                                                                                                    | Dónde probarla                                                                                 |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Descubrimiento y enriquecimiento | Con datos pegados: perfil ideal + fuentes pegadas; duplicados, segmentos, exportar CSV, importar a Cuentas | Prospección                                                                                    |
| 2   | Investigación y primer contacto | Completa sobre los registros de la cuenta; sin búsqueda web                                               | Cuenta → «Investigar y primer contacto»                                                        |
| 3   | Inteligencia competitiva        | Con datos pegados: fichas de competidores con su fuente                                                   | Oportunidad → «Inteligencia competitiva»; Respuestas → «Comparar»                              |
| 4   | Respuestas internas             | Con datos pegados: documentos autorizados cargados en el módulo                                           | Respuestas                                                                                     |
| 5   | Preparación de reuniones        | Completa (una reunión y agenda de varias)                                                                 | Reunión → «Preparar»; Mi panel → «Agenda con preparación»                                      |
| 6   | Seguimiento posterior           | Con datos pegados: notas o transcripción pegadas en la reunión                                            | Reunión → «Seguimiento»                                                                        |
| 7   | Citas textuales                 | Completa: búsqueda exacta en código (funciona sin el modelo) + verificación                               | Cuenta → «Buscar citas textuales»                                                              |
| 8   | Coaching individual             | Con datos pegados: transcripciones de llamadas                                                            | Coaching → «Coaching individual»                                                               |
| 9   | Tendencias de coaching          | Completa: comparación calculada entre períodos + explicación                                              | Coaching → tabla de tendencia y «Explicar la tendencia»                                        |
| 10  | Señales de cuenta               | Completa: historial de cambios rastreable, lista de seguimiento, resumen                                  | Cuenta → «Señales: qué cambió»; Cuentas → filtro «Mi lista de seguimiento»                     |
| 11  | Estrategia de oportunidad       | Completa                                                                                                  | Oportunidad → «Estrategia»                                                                     |
| 12  | Caso de negocio y ROI           | Completa: supuestos editables, fórmulas, 3 escenarios, recuperación, presentación de 10 diapositivas      | Oportunidad → «Caso de negocio y ROI»                                                          |
| 13  | Presentaciones comerciales      | Completa con exportación a PowerPoint; **Google Slides pendiente** (no hay integración: se importa el .pptx) | Oportunidad → «Presentación comercial»                                                         |
| 14  | Panel del vendedor              | Completa                                                                                                  | Mi panel                                                                                       |
| 15  | Revisión del pronóstico         | Completa: por período y responsable, por moneda, cada total abre sus oportunidades                        | Pronóstico                                                                                     |
| 16  | Panel de liderazgo              | Completa (solo admins)                                                                                    | Liderazgo                                                                                      |
| 17  | Demo guiada                     | Completa: datos ficticios marcados DEMO, sin credenciales externas, con reinicio                          | Demo guiada → «Cargar la demo»                                                                 |

Integraciones externas: **ninguna probada**. No hay CRM externo, proveedor de datos de
empresas, calendario/correo ni Google Slides conectados; el CRM es el del propio módulo.
El modelo es Claude en Amazon Bedrock con el rol de la Lambda (sin credenciales nuevas).

## Desde el chat

`/ventas` abre el módulo. `/ventas pronóstico | demo | coaching | liderazgo | prospección |
respuestas` abre esa sección. `/ventas cuenta <nombre>` abre la cuenta; `/ventas preparar
<nombre>`, `/ventas seguimiento <nombre>`, `/ventas estrategia <nombre>` y `/ventas senales
<nombre>` inician ese flujo sobre la cuenta.

## Comandos

```sh
pnpm install --frozen-lockfile
pnpm dev                                   # la app web en local
pnpm test                                  # todas las pruebas
pnpm --filter @mindfultech/shared test -- sales     # ROI, pronóstico, permisos, citas
pnpm --filter backend test -- sales                 # API: permisos, citas, CRM, demo de extremo a extremo
pnpm --filter web test -- sales pptx                # interfaz y archivo .pptx
pnpm --filter infra test -- sales                   # tabla, rutas y permisos de la Lambda
pnpm lint
```

La demo no necesita comando: Ventas → **Demo guiada** → **Cargar la demo** (o **Reiniciar
demo**). El despliegue es el de siempre (push a `main`).
