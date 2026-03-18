// ══════════════════════════════════════════════════
//  AMBAR Couture · Create Reservation + Bold Payment
//  POST /api/create-reservation
// ══════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Tarifas AMBAR (anticipo = 30% del valor total)
const TARIFAS = {
  bogota: {
    pg:  { nicolay_bog: { cliente: 900000,  colab: 450000 } },
    mk:  { catalina:    { cliente: 500000,  colab: 280000 },
           samy:        { cliente: 500000,  colab: 250000 } },
    paquete_pg_mk: 1300000,
  },
  barranquilla: {
    pg:  { carlos: { cliente: 700000, colab: 450000 } },
    mk:  { paola:  { cliente: 260000, colab: 250000 } },
    paquete_pg_mk: 960000,
  },
  villavicencio: {
    pg:  { anyelo_vll:  { cliente: 630000, colab: 250000 },
           nicolay_vll: { cliente: 330000, colab: 200000 } },
    mk:  { laura: { cliente: 220000, colab: 120000 },
           luisa: { cliente: 220000, colab: 120000 } },
    paquete_pg_mk: null,
    horse: { rey:    { cliente: 300000, colab: 0 },
             paloma: { cliente: 420000, colab: 0 } },
  },
};

const RETABLOS = {
  pequeño:  { label: 'Retablo pequeño',  precio: 150000 },
  mediano:  { label: 'Retablo mediano',  precio: 250000 },
  grande:   { label: 'Retablo grande',   precio: 400000 },
};

function calcTotal(body) {
  const t = TARIFAS[body.sede];
  if (!t) return { cliente: 0, colab: 0 };

  const pgT = body.pg_id ? t.pg?.[body.pg_id] : null;
  const mkT = body.incluye_mkup && body.mk_id ? t.mk?.[body.mk_id] : null;
  const hrT = body.horse ? t.horse?.[body.horse] : null;
  const rtT = body.retablo ? RETABLOS[body.retablo] : null;

  let cliente = 0;
  if (pgT && mkT && t.paquete_pg_mk) {
    cliente = t.paquete_pg_mk;
  } else {
    if (pgT) cliente += pgT.cliente;
    if (mkT) cliente += mkT.cliente;
  }
  if (hrT) cliente += hrT.cliente;
  if (rtT) cliente += rtT.precio;

  let colab = 0;
  if (pgT) colab += pgT.colab;
  if (mkT) colab += mkT.colab;

  return { cliente, colab };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;

  // Validaciones básicas
  const required = ['sede', 'fecha', 'hora', 'q_nombre', 'q_tel', 'q_mail'];
  for (const field of required) {
    if (!body[field]) return res.status(400).json({ error: `Campo requerido: ${field}` });
  }

  try {
    // 1. Verificar disponibilidad
    const { data: existing } = await sb
      .from('sesiones')
      .select('id')
      .eq('sede', body.sede)
      .eq('fecha', body.fecha)
      .eq('pg_id', body.pg_id)
      .neq('status', 'cancelada');

    if (existing && existing.length > 0) {
      return res.status(409).json({
        error: 'El fotógrafo no está disponible en esa fecha. Por favor elige otra fecha.'
      });
    }

    // 2. Calcular precios
    const { cliente: totalCliente, colab: totalColab } = calcTotal(body);
    const anticipo = Math.round(totalCliente * 0.3); // 30% anticipo

    // 3. Calcular hora maquillaje
    let hora_mk = null;
    if (body.incluye_mkup && body.hora) {
      const [hh, mm] = body.hora.split(':').map(Number);
      let mh = hh - 2, mn = mm - 30;
      if (mn < 0) { mn += 60; mh--; }
      hora_mk = `${String(mh).padStart(2,'0')}:${String(mn).padStart(2,'0')}:00`;
    }

    // 4. Guardar reserva en Supabase con status "pendiente_pago"
    const { data: sesion, error: dbError } = await sb.from('sesiones').insert([{
      sede:         body.sede,
      fecha:        body.fecha,
      hora:         body.hora + ':00',
      hora_mk,
      incluye_mkup: body.incluye_mkup || false,
      q_nombre:     body.q_nombre,
      q_apellido:   body.q_apellido || '',
      q_tel:        body.q_tel,
      q_mail:       body.q_mail,
      r_nombre:     body.r_nombre || '',
      r_tel:        body.r_tel || '',
      pg_id:        body.pg_id || null,
      mk_id:        body.mk_id || null,
      lugar:        body.lugar || '',
      mk_addr:      body.mk_addr || '',
      horse:        body.horse || null,
      retablo:      body.retablo || null,
      notas:        body.notas || '',
      status:       'pendiente_pago',
      precio_cliente: totalCliente,
      precio_colab:   totalColab,
      anticipo:       anticipo,
    }]).select().single();

    if (dbError) throw dbError;

    // 5. Crear enlace de pago Bold
    const boldPayload = {
      amount: {
        currency: 'COP',
        total_amount: anticipo,
        tip_amount: 0,
      },
      payment_methods: ['CARD', 'PSE', 'NEQUI'],
      description: `AMBAR Couture · Anticipo sesión Pre-XV · ${body.q_nombre} · ${body.fecha}`,
      order_id: sesion.id,
      redirect_url: `${process.env.APP_URL}/reserva-confirmada.html?id=${sesion.id}`,
      metadata: {
        sesion_id: sesion.id,
        cliente:   body.q_nombre,
        fecha:     body.fecha,
        sede:      body.sede,
      }
    };

    const boldRes = await fetch('https://integrations.api.bold.co/online/link/v1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `x-api-key ${process.env.BOLD_API_KEY}`,
      },
      body: JSON.stringify(boldPayload),
    });

    const boldData = await boldRes.json();

    if (!boldRes.ok) {
      // Si Bold falla, igual guardamos la reserva pero retornamos el error de pago
      console.error('Bold error:', boldData);
      return res.status(200).json({
        success: true,
        sesion_id: sesion.id,
        bold_error: true,
        message: 'Reserva guardada. Contacta a AMBAR para completar el pago.',
        total: totalCliente,
        anticipo,
      });
    }

    return res.status(200).json({
      success: true,
      sesion_id: sesion.id,
      payment_url: boldData.payload?.payment_link,
      total: totalCliente,
      anticipo,
      deuda_restante: totalCliente - anticipo,
    });

  } catch (e) {
    console.error('Error create-reservation:', e);
    return res.status(500).json({ error: e.message });
  }
}
