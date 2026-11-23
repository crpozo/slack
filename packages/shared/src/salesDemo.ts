import {
  emptySalesResult,
  roiDeck,
  roiModel,
  type RoiInputs,
  type SalesArtifact,
  type SalesChange,
  type SalesRecord,
} from "./sales";

// ---------------------------------------------------------------------------
// The guided demo's data (Phase 73): fictitious, marked as such on every row
// (`demo: true`, ids that start with `demo_`, "DEMO" in the names), visible
// to the whole team and rebuilt by "Reiniciar demo". One account and one
// opportunity run through the whole tour; dates are relative to `now`.
// ---------------------------------------------------------------------------

export const DEMO_REP_ID = "demo_rep";
export const DEMO_REP_NAME = "Lucía Vera (DEMO)";
export const DEMO_ACCOUNT_ID = "demo_acct_andina";
export const DEMO_OPP_ID = "demo_opp_andina";
export const DEMO_MEETING_ID = "demo_meet_andina_next";
export const DEMO_PAST_MEETING_ID = "demo_meet_andina_past";
export const isDemoId = (id: string) => id.startsWith("demo_");

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const DEMO_ROI: RoiInputs = {
  currency: "USD",
  horizonMonths: 24,
  investment: 84_000,
  recurringMonthly: 2_500,
  currentMonthlyCost: 14_000,
  benefits: [
    { name: "Menos errores en pedidos (reprocesos y devoluciones)", monthly: 6_200 },
    { name: "Horas del equipo de ventas liberadas", monthly: 4_300 },
    { name: "Pedidos adicionales por reposición automática", monthly: 3_500 },
  ],
  rampMonths: 4,
  scenarios: { conservador: 0.6, base: 1, optimista: 1.25 },
};

const TRANSCRIPT = `[00:01:10] Lucía: Gracias por el tiempo. ¿Qué es lo que más les duele hoy del proceso de pedidos?
[00:01:42] Marta Salazar: Los pedidos llegan por WhatsApp y correo, y los digitamos a mano. Tenemos cerca de un 7 por ciento de pedidos con errores.
[00:03:05] Lucía: ¿Qué pasa cuando hay un error?
[00:03:20] Marta Salazar: Se reprocesa y a veces la farmacia se queda sin producto. El año pasado perdimos dos cadenas pequeñas por eso.
[00:06:48] Diego Paredes: Mi preocupación es la integración con el ERP. Ya tuvimos un proyecto que se atrasó ocho meses.
[00:07:30] Lucía: Entiendo. Podemos hacer una prueba de integración de dos semanas antes de firmar.
[00:11:15] Marta Salazar: El presupuesto lo aprueba el gerente financiero. Todavía no le hemos presentado esto.
[00:12:02] Lucía: ¿Quién es y cuándo podríamos reunirnos con él?
[00:12:20] Marta Salazar: Es el ingeniero Robles. Yo podría pedirle un espacio la próxima semana, pero va a preguntar por el retorno.
[00:15:40] Diego Paredes: También estamos viendo a PedidoYa Empresas. Nos ofrecieron un piloto gratis de tres meses.
[00:18:05] Marta Salazar: Si el número cierra, querríamos arrancar antes de la temporada de enero.`;

const CALLS: Array<[string, number, string, string]> = [
  [
    "demo_call_1",
    -75,
    "Descubrimiento · Distribuidora Litoral (DEMO)",
    `[00:00:30] Lucía: Les cuento de nuestra plataforma. Tenemos pedidos en línea, catálogo, precios por cliente, reportes, integración con ERP, aplicación móvil y un módulo de cobranza que además permite conciliar pagos y enviar recordatorios automáticos a cada cliente según su historial y su cupo.
[00:02:40] Cliente: Suena completo. ¿Cuánto cuesta?
[00:02:55] Lucía: Depende de los módulos. Tenemos tres planes y además se puede personalizar todo lo que necesiten, desde el catálogo hasta los flujos de aprobación y los reportes para gerencia.
[00:04:10] Cliente: Lo revisamos y les avisamos.`,
  ],
  [
    "demo_call_2",
    -60,
    "Demo · Agroinsumos del Valle (DEMO)",
    `[00:00:20] Lucía: Voy a mostrarles todas las pantallas. Primero el catálogo, luego los pedidos, después los reportes y al final la administración, para que vean todo lo que hace la plataforma de una sola vez y no quede nada por fuera.
[00:05:30] Cliente: ¿Se integra con nuestro sistema contable?
[00:05:40] Lucía: Sí, con casi todos. ¿Les muestro los reportes?
[00:09:00] Cliente: Mándenos la propuesta por correo.`,
  ],
  [
    "demo_call_3",
    -20,
    "Descubrimiento · Ferretera Central (DEMO)",
    `[00:00:25] Lucía: Antes de mostrar nada, ¿cómo toman pedidos hoy?
[00:00:50] Cliente: Por teléfono y con visitas de los vendedores.
[00:01:20] Lucía: ¿Cuánto tarda un pedido desde que el cliente llama hasta que sale de bodega?
[00:01:45] Cliente: Dos días, a veces tres.
[00:02:10] Lucía: ¿Qué les cuesta ese retraso?
[00:02:40] Cliente: Perdemos ventas de mostrador, calculo unos diez mil dólares al mes.
[00:03:05] Lucía: ¿Quién más participa en la decisión de cambiar ese proceso?
[00:03:30] Cliente: El gerente comercial y sistemas.`,
  ],
  [
    "demo_call_4",
    -8,
    "Descubrimiento · Farmacias Andina (DEMO)",
    `[00:00:20] Lucía: La vez pasada hablamos de los errores en pedidos. ¿Qué cambió desde entonces?
[00:00:45] Cliente: Seguimos igual, y se acerca la temporada alta.
[00:01:10] Lucía: ¿Qué necesitaría ver Finanzas para aprobar el proyecto?
[00:01:35] Cliente: Un retorno claro y que la integración no se atrase.
[00:02:00] Lucía: ¿Quién define ese retorno mínimo y cuándo podríamos hablar con esa persona?
[00:02:25] Cliente: El gerente financiero. Le pido un espacio.`,
  ],
];

/** Every row of the demo, as it starts. */
export function demoSalesSeed(now: number): {
  records: SalesRecord[];
  artifacts: SalesArtifact[];
  changes: SalesChange[];
} {
  const stamp = { createdAt: now - 90 * DAY, updatedAt: now - 2 * DAY, demo: true as const };
  const own = {
    ownerId: DEMO_REP_ID,
    ownerName: DEMO_REP_NAME,
    source: "Datos ficticios de la demo",
    sourceDate: "",
  };
  const account = (
    id: string,
    name: string,
    extra: Partial<Extract<SalesRecord, { kind: "account" }>> = {},
  ): SalesRecord => ({
    ...own,
    ...stamp,
    id,
    kind: "account",
    name,
    domain: "",
    industry: "Distribución",
    size: "",
    country: "Ecuador",
    segment: "",
    status: "prospecto",
    strategic: false,
    watchers: [],
    notes: "",
    ...extra,
  });
  const opp = (
    id: string,
    accountId: string,
    name: string,
    amount: number,
    extra: Partial<Extract<SalesRecord, { kind: "opportunity" }>> = {},
  ): SalesRecord => ({
    ...own,
    ...stamp,
    id,
    kind: "opportunity",
    accountId,
    name,
    type: "nueva",
    amount,
    currency: "USD",
    stage: "propuesta",
    forecastCategory: "pipeline",
    closeDate: day(now + 20 * DAY),
    nextStep: "",
    nextStepDate: "",
    criteria: "",
    process: "",
    risks: "",
    ...extra,
  });
  const contact = (
    id: string,
    accountId: string,
    name: string,
    title: string,
    role: Extract<SalesRecord, { kind: "contact" }>["role"],
  ): SalesRecord => ({
    ...own,
    ...stamp,
    id,
    kind: "contact",
    accountId,
    name,
    title,
    email: name ? `${name.split(" ")[0]!.toLowerCase()}@ejemplo-demo.test` : "",
    phone: "",
    role,
    notes: "",
  });
  const records: SalesRecord[] = [
    account(DEMO_ACCOUNT_ID, "Farmacias Andina (DEMO · ficticia)", {
      domain: "farmacias-andina.ejemplo-demo.test",
      industry: "Distribución farmacéutica",
      size: "180 farmacias",
      segment: "Estratégica",
      strategic: true,
      notes:
        "Cadena ficticia para la demo. Toma pedidos de sus farmacias por WhatsApp y correo; busca una plataforma de pedidos B2B antes de enero.",
    }),
    account("demo_acct_litoral", "Distribuidora Litoral (DEMO · ficticia)", { status: "cliente" }),
    account("demo_acct_ferretera", "Ferretera Central (DEMO · ficticia)", {
      industry: "Ferretería",
    }),
    contact("demo_ct_marta", DEMO_ACCOUNT_ID, "Marta Salazar", "Gerente de Operaciones", "campeon"),
    contact("demo_ct_diego", DEMO_ACCOUNT_ID, "Diego Paredes", "Jefe de Sistemas", "influenciador"),
    // The decision-maker isn't identified in the CRM: the forecast flags it.
    contact("demo_ct_cfo", DEMO_ACCOUNT_ID, "", "Gerente Financiero", "decisor"),
    opp(DEMO_OPP_ID, DEMO_ACCOUNT_ID, "Plataforma de pedidos B2B (DEMO)", 84_000, {
      stage: "propuesta",
      forecastCategory: "commit",
      closeDate: day(now + 9 * DAY),
      nextStep: "",
      criteria: "Reducir errores de pedidos e integrarse con el ERP sin atrasos.",
      risks: "Competidor con piloto gratis; el presupuesto aún no lo ve Finanzas.",
      roi: DEMO_ROI,
    }),
    opp("demo_opp_litoral", "demo_acct_litoral", "Renovación anual (DEMO)", 36_000, {
      type: "renovacion",
      stage: "negociacion",
      forecastCategory: "commit",
      closeDate: day(now + 15 * DAY),
      nextStep: "Enviar contrato firmado",
      nextStepDate: day(now + 3 * DAY),
      criteria: "Continuidad del servicio y soporte en sitio.",
      process: "Aprueba el gerente general con visto bueno de Compras.",
    }),
    opp("demo_opp_ferretera", "demo_acct_ferretera", "Pedidos para mostrador (DEMO)", 52_000, {
      stage: "descubrimiento",
      forecastCategory: "best_case",
      closeDate: day(now + 25 * DAY),
      nextStep: "Demo con el gerente comercial",
      nextStepDate: day(now + 5 * DAY),
    }),
    contact("demo_ct_litoral", "demo_acct_litoral", "Paola Mora", "Gerente General", "decisor"),
    {
      ...own,
      ...stamp,
      id: DEMO_PAST_MEETING_ID,
      kind: "meeting",
      accountId: DEMO_ACCOUNT_ID,
      opportunityId: DEMO_OPP_ID,
      title: "Descubrimiento con Operaciones y Sistemas (DEMO)",
      date: new Date(now - 26 * DAY).toISOString(),
      attendees: "Marta Salazar, Diego Paredes, Lucía Vera",
      goal: "Entender el proceso de pedidos y quién decide.",
      notes: TRANSCRIPT,
    },
    {
      ...own,
      ...stamp,
      id: DEMO_MEETING_ID,
      kind: "meeting",
      accountId: DEMO_ACCOUNT_ID,
      opportunityId: DEMO_OPP_ID,
      title: "Presentación del caso de negocio a Finanzas (DEMO)",
      date: new Date(now + 2 * DAY).toISOString(),
      attendees: "Marta Salazar, Ing. Robles (Gerente Financiero), Lucía Vera",
      goal: "Que Finanzas valide el retorno y defina el proceso de aprobación.",
      notes: "",
    },
    ...CALLS.map(([id, offset, title, transcript]): SalesRecord => ({
      ...own,
      ...stamp,
      id,
      kind: "call",
      accountId: id === "demo_call_4" ? DEMO_ACCOUNT_ID : "",
      title,
      date: new Date(now + offset * DAY).toISOString(),
      repName: "Lucía",
      transcript,
      shareable: true,
    })),
    {
      ...own,
      ...stamp,
      id: "demo_doc_erp",
      kind: "doc",
      title: "Integraciones con ERP (DEMO)",
      body: "La plataforma se integra con SAP Business One y Odoo mediante conectores propios.\nUna integración estándar toma de 3 a 5 semanas.\nResponsable técnico: Andrés Cueva.\nPara otros ERP se requiere una evaluación previa de dos semanas.",
      expertName: "Andrés Cueva (DEMO)",
      tags: "integración, ERP, técnico",
      url: "",
    },
    {
      ...own,
      ...stamp,
      id: "demo_doc_precios",
      kind: "doc",
      title: "Política comercial y descuentos (DEMO)",
      body: "Descuento máximo sin aprobación: 10 por ciento.\nContratos de 24 meses admiten hasta 15 por ciento con aprobación de la gerencia comercial.\nNo se ofrecen pilotos gratuitos; sí una prueba de integración pagada de dos semanas, acreditable al contrato.",
      expertName: "Gerencia Comercial (DEMO)",
      tags: "precios, descuentos",
      url: "",
    },
    {
      ...own,
      ...stamp,
      id: "demo_comp_pedidoya",
      kind: "competitor",
      name: "PedidoYa Empresas (DEMO · ficticio)",
      strengths: "Piloto gratuito de tres meses. Aplicación móvil conocida por las farmacias.",
      weaknesses: "Sin integración nativa con ERP: exporta archivos. Soporte solo por correo.",
      pricing: "Comisión del 1,5 por ciento por pedido tras el piloto.",
      notes: "Ficha ficticia para la demo.",
      url: "",
    },
  ];

  const model = roiModel(DEMO_ROI);
  const acct = records[0] as Extract<SalesRecord, { kind: "account" }>;
  const theOpp = records.find((r) => r.id === DEMO_OPP_ID) as Extract<
    SalesRecord,
    { kind: "opportunity" }
  >;
  const artifact = (
    flow: SalesArtifact["flow"],
    meetingId: string,
    result: SalesArtifact["result"],
  ): SalesArtifact => ({
    id: `demo_art_${flow}`,
    kind: "artifact",
    flow,
    accountId: DEMO_ACCOUNT_ID,
    opportunityId: DEMO_OPP_ID,
    meetingId,
    ownerId: DEMO_REP_ID,
    ownerName: DEMO_REP_NAME,
    result,
    createdAt: now,
    updatedAt: now,
    demo: true,
  });
  const item = (
    text: string,
    kind: SalesArtifact["result"]["sections"][number]["items"][number]["kind"],
    sources: string[],
    extra: { quote?: string; owner?: string; due?: string } = {},
  ) => ({ text, kind, sources, quote: "", owner: "", due: "", ...extra });
  const base = model.scenarios.base;
  const artifacts: SalesArtifact[] = [
    artifact("prep", DEMO_MEETING_ID, {
      ...emptySalesResult("Preparación: presentación del caso de negocio a Finanzas"),
      summary:
        "Primera reunión con el decisor financiero. La oportunidad está comprometida para este mes pero Finanzas aún no ha visto la propuesta: el objetivo es que valide el retorno y diga cómo se aprueba.",
      sections: [
        {
          heading: "Asistentes",
          items: [
            item("Marta Salazar, Gerente de Operaciones: impulsa el proyecto.", "hecho", [
              "demo_ct_marta",
            ]),
            item(
              "Ing. Robles, Gerente Financiero: aprueba el presupuesto; no está identificado como contacto en el CRM.",
              "pendiente",
              ["demo_ct_cfo", DEMO_PAST_MEETING_ID],
            ),
          ],
        },
        {
          heading: "Historial de la cuenta",
          items: [
            item(
              "Cerca del 7 por ciento de los pedidos llega con errores.",
              "cita",
              [DEMO_PAST_MEETING_ID],
              {
                quote: "Tenemos cerca de un 7 por ciento de pedidos con errores.",
              },
            ),
            item(
              "Sistemas teme un atraso en la integración con el ERP.",
              "cita",
              [DEMO_PAST_MEETING_ID],
              {
                quote: "Ya tuvimos un proyecto que se atrasó ocho meses.",
              },
            ),
          ],
        },
        {
          heading: "Bloqueos",
          items: [
            item("Un competidor ofreció un piloto gratis de tres meses.", "hecho", [
              DEMO_PAST_MEETING_ID,
              "demo_comp_pedidoya",
            ]),
            item("El proceso de aprobación de Finanzas no está documentado.", "pendiente", [
              DEMO_OPP_ID,
            ]),
          ],
        },
        {
          heading: "Preguntas sugeridas",
          items: [
            item(
              "¿Qué retorno mínimo y en qué plazo exige Finanzas para aprobar una inversión así?",
              "accion",
              [],
            ),
            item("¿Quién más firma y qué pasos faltan después de esta reunión?", "accion", []),
            item("¿La temporada de enero sigue siendo la fecha objetivo?", "hipotesis", [
              DEMO_PAST_MEETING_ID,
            ]),
          ],
        },
        {
          heading: "Resultado deseado",
          items: [
            item(
              `Acuerdo sobre los supuestos del caso de negocio (recuperación en el ${base.paybackMonth === null ? "horizonte" : `mes ${base.paybackMonth}`}) y un próximo paso con fecha.`,
              "accion",
              [DEMO_OPP_ID],
            ),
          ],
        },
      ],
    }),
    artifact("deck", DEMO_MEETING_ID, {
      ...emptySalesResult("Caso de negocio: Plataforma de pedidos B2B"),
      summary: "Presentación de decisión generada desde el modelo de ROI de la oportunidad.",
      slides: roiDeck(acct, theOpp, model),
    }),
    artifact("followup", DEMO_PAST_MEETING_ID, {
      ...emptySalesResult("Seguimiento: descubrimiento con Operaciones y Sistemas"),
      summary:
        "Hay dolor claro (errores de pedidos) y una fecha deseada (enero), pero el decisor financiero no ha visto la propuesta y hay un competidor con piloto gratis.",
      sections: [
        {
          heading: "Acuerdos",
          items: [
            item(
              "Prueba de integración de dos semanas antes de firmar.",
              "cita",
              [DEMO_PAST_MEETING_ID],
              {
                quote: "Podemos hacer una prueba de integración de dos semanas antes de firmar.",
              },
            ),
          ],
        },
        {
          heading: "Objeciones",
          items: [
            item("Riesgo de atraso en la integración con el ERP.", "cita", [DEMO_PAST_MEETING_ID], {
              quote: "Mi preocupación es la integración con el ERP.",
            }),
            item("Competidor con piloto gratis de tres meses.", "cita", [DEMO_PAST_MEETING_ID], {
              quote: "Nos ofrecieron un piloto gratis de tres meses.",
            }),
          ],
        },
        {
          heading: "Preguntas abiertas",
          items: [
            item("¿Qué retorno exigirá el gerente financiero?", "pendiente", [
              DEMO_PAST_MEETING_ID,
            ]),
          ],
        },
        {
          heading: "Tareas",
          items: [
            item(
              "Pedir a Finanzas un espacio la próxima semana.",
              "accion",
              [DEMO_PAST_MEETING_ID],
              { owner: "Marta Salazar" },
            ),
            item(
              "Preparar el caso de negocio con retorno y recuperación.",
              "accion",
              [DEMO_OPP_ID],
              { owner: DEMO_REP_NAME },
            ),
          ],
        },
      ],
      draft: {
        subject: "Resumen de nuestra reunión y próximos pasos",
        body: "Hola Marta, hola Diego:\n\nGracias por la conversación. Resumo lo que acordamos:\n\n- Haremos una prueba de integración con su ERP de dos semanas antes de firmar.\n- Prepararé el caso de negocio con el retorno esperado para presentarlo al ingeniero Robles.\n- Marta gestionará un espacio con Finanzas la próxima semana.\n\n¿Les parece si fijamos la reunión con Finanzas para el martes?\n\nSaludos,\nLucía",
      },
      crmUpdates: [
        {
          recordId: DEMO_OPP_ID,
          field: "nextStep",
          value: "Presentar el caso de negocio al Gerente Financiero (Ing. Robles)",
          reason: "El presupuesto lo aprueba Finanzas y aún no ha visto la propuesta.",
          sources: [DEMO_PAST_MEETING_ID],
        },
        {
          recordId: DEMO_OPP_ID,
          field: "nextStepDate",
          value: day(now + 2 * DAY),
          reason: "Fecha de la reunión agendada con Finanzas.",
          sources: [DEMO_MEETING_ID],
        },
        {
          recordId: DEMO_OPP_ID,
          field: "process",
          value:
            "Aprueba el Gerente Financiero (Ing. Robles) tras revisar el retorno; Operaciones impulsa.",
          reason: "Lo dijo Operaciones en la reunión.",
          sources: [DEMO_PAST_MEETING_ID],
        },
        {
          recordId: DEMO_OPP_ID,
          field: "forecastCategory",
          value: "best_case",
          reason: "Sin validación de Finanzas no hay evidencia para mantenerla comprometida.",
          sources: [DEMO_PAST_MEETING_ID],
        },
      ],
    }),
  ];
  const changes: SalesChange[] = [
    {
      id: "demo_chg_1",
      recordKind: "opportunity",
      recordId: DEMO_OPP_ID,
      accountId: DEMO_ACCOUNT_ID,
      label: "Plataforma de pedidos B2B (DEMO)",
      field: "forecastCategory",
      from: "best_case",
      to: "commit",
      by: DEMO_REP_ID,
      byName: DEMO_REP_NAME,
      at: now - 12 * DAY,
      demo: true,
    },
    {
      id: "demo_chg_2",
      recordKind: "opportunity",
      recordId: DEMO_OPP_ID,
      accountId: DEMO_ACCOUNT_ID,
      label: "Plataforma de pedidos B2B (DEMO)",
      field: "closeDate",
      from: day(now + 40 * DAY),
      to: day(now + 9 * DAY),
      by: DEMO_REP_ID,
      byName: DEMO_REP_NAME,
      at: now - 12 * DAY,
      demo: true,
    },
    {
      id: "demo_chg_3",
      recordKind: "opportunity",
      recordId: DEMO_OPP_ID,
      accountId: DEMO_ACCOUNT_ID,
      label: "Plataforma de pedidos B2B (DEMO)",
      field: "amount",
      from: "72000",
      to: "84000",
      by: DEMO_REP_ID,
      byName: DEMO_REP_NAME,
      at: now - 5 * DAY,
      demo: true,
    },
  ];
  return { records, artifacts, changes };
}
