// ══════════════════════════════════════════════════
//  AMBAR Couture · Bold Webhook
//  POST /api/bold-webhook
//  Bold llama este endpoint cuando el pago es confirmado
// ══════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Colaboradores para notificación
const COLABS_INFO = {
  nicolay_bog:  { nombre: 'Hector Nicolay Davila',  email: 'nicolay@ambarcouture.com', tel: '3206747611' },
  catalina:     { nombre: 'Catalina Jiménez',        email: 'catalina@ambarcouture.com', tel: '3222598072' },
  samy:         { nombre: 'Laura Samanta Arroyo',    email: 'samy@ambarcouture.com', tel: '3015131878' },
  carlos:       { nombre: 'Joel Enrique Sanchez',    email: 'joel@ambarcouture.com', tel: '3022836725' },
  paola:        { nombre: 'Camila Gutierrez',        email: 'camila@ambarcouture.com', tel: '3042058335' },
  anyelo_vll:   { nombre: 'Anyelo Cardona Valencia', email: 'anyelo@ambarcouture.com', tel: '3204728629' },
  nicolay_vll:  { nombre: 'Hector Nicolay Davila',  email: 'nicolay@ambarcouture.com', tel: '3206747611' },
  laura:        { nombre: 'Laura Merad Ortega',      email: 'laura.m@ambarcouture.com', tel: '3232284496' },
  luisa:        { nombre: 'Laura Camila Loaiza',     email: 'luisa@ambarcouture.com', tel: '3146054649' },
};

const SEDES_LABEL = {
  bogota: '🏙️ Bogotá D.C.',
  barranquilla: '🌴 Barranquilla',
  villavicencio: '🌿 Villavicencio',
};

function cop(n) {
  return '$' + Number(n).toLocaleString('es-CO') + ' COP';
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = req.body;

    // 1. Verificar firma Bold (seguridad)
    const signature = req.headers['bold-signature'];
    if (signature && process.env.BOLD_WEBHOOK_SECRET) {
      const hash = crypto
        .createHmac('sha256', process.env.BOLD_WEBHOOK_SECRET)
        .update(JSON.stringify(body))
        .digest('hex');
      if (hash !== signature) {
        return res.status(401).json({ error: 'Firma inválida' });
      }
    }

    // 2. Verificar que el pago fue aprobado
    const { status, metadata, amount } = body;
    if (status !== 'APPROVED') {
      // Actualizar a pago_fallido si fue rechazado
      if (status === 'DECLINED' && metadata?.sesion_id) {
        await sb.from('sesiones')
          .update({ status: 'pago_fallido' })
          .eq('id', metadata.sesion_id);
      }
      return res.status(200).json({ received: true });
    }

    const sesionId = metadata?.sesion_id || body.order_id;
    if (!sesionId) return res.status(400).json({ error: 'No sesion_id' });

    // 3. Obtener sesión de Supabase
    const { data: sesion, error } = await sb
      .from('sesiones')
      .select('*')
      .eq('id', sesionId)
      .single();

    if (error || !sesion) return res.status(404).json({ error: 'Sesión no encontrada' });

    // 4. Actualizar estado a confirmada
    await sb.from('sesiones')
      .update({
        status: 'confirmada',
        anticipo_pagado: amount?.total_amount || sesion.anticipo,
        bold_transaction_id: body.transaction_id || body.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sesionId);

    // 5. Enviar correos via Resend
    await sendEmails(sesion, amount);

    // 6. Notificación WhatsApp al admin
    await notifyWhatsApp(sesion);

    return res.status(200).json({ received: true, sesion_id: sesionId });

  } catch (e) {
    console.error('Webhook error:', e);
    return res.status(500).json({ error: e.message });
  }
}

async function sendEmails(s, amount) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return;

  const fecha = new Date(s.fecha + 'T12:00:00').toLocaleDateString('es-CO', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const sedeLbl = SEDES_LABEL[s.sede] || s.sede;
  const anticipo = cop(amount?.total_amount || s.anticipo || 0);
  const restante = cop((s.precio_cliente || 0) - (amount?.total_amount || s.anticipo || 0));

  // Email al cliente
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({
      from: 'AMBAR Couture <reservas@ambarcouture.com>',
      to: [s.q_mail],
      subject: `✨ Tu sesión Pre-XV está confirmada · ${fecha}`,
      html: emailClienteHTML(s, fecha, sedeLbl, anticipo, restante),
    }),
  });

  // Email al fotógrafo
  if (s.pg_id && COLABS_INFO[s.pg_id]?.email) {
    const pg = COLABS_INFO[s.pg_id];
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'AMBAR Couture <admin@ambarcouture.com>',
        to: [pg.email],
        subject: `📸 Nueva sesión confirmada · ${s.q_nombre} · ${fecha}`,
        html: emailColabHTML(s, fecha, sedeLbl, pg, 'Fotógrafo'),
      }),
    });
  }

  // Email a maquilladora
  if (s.incluye_mkup && s.mk_id && COLABS_INFO[s.mk_id]?.email) {
    const mk = COLABS_INFO[s.mk_id];
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'AMBAR Couture <admin@ambarcouture.com>',
        to: [mk.email],
        subject: `💄 Nueva sesión confirmada · ${s.q_nombre} · ${fecha}`,
        html: emailColabHTML(s, fecha, sedeLbl, mk, 'Maquilladora'),
      }),
    });
  }
}

async function notifyWhatsApp(s) {
  // WhatsApp al admin via Twilio (o enlace directo)
  const TWILIO_SID = process.env.TWILIO_SID;
  const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
  const ADMIN_WA = process.env.ADMIN_WHATSAPP; // ej: +573001234567

  if (!TWILIO_SID || !ADMIN_WA) return;

  const msg = `✅ *Nueva reserva AMBAR*\n\n👧 ${s.q_nombre} ${s.q_apellido || ''}\n📅 ${s.fecha} · ${s.hora?.slice(0,5)}\n📍 ${SEDES_LABEL[s.sede] || s.sede}\n💰 Anticipo pagado: ${cop(s.anticipo)}\n\nRevisa el panel admin para más detalles.`;

  const params = new URLSearchParams({
    From: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
    To: `whatsapp:${ADMIN_WA}`,
    Body: msg,
  });

  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
    },
    body: params.toString(),
  });
}

function emailClienteHTML(s, fecha, sede, anticipo, restante) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAF7F2;font-family:'Outfit',sans-serif">
<div style="max-width:560px;margin:0 auto;padding:2rem">
  <div style="background:#0E0C0A;padding:2rem;text-align:center;margin-bottom:1.5rem">
    <div style="font-family:Georgia,serif;font-size:1.8rem;letter-spacing:0.25em;color:#DCBA6A">AMBAR</div>
    <div style="font-size:0.6rem;letter-spacing:0.4em;text-transform:uppercase;color:rgba(220,186,106,0.5);margin-top:4px">Couture</div>
  </div>
  <div style="background:white;padding:2rem;border:1px solid #F0E8D8">
    <div style="font-size:0.55rem;letter-spacing:0.3em;text-transform:uppercase;color:#C49A3C;margin-bottom:0.5rem">¡Reserva confirmada!</div>
    <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#0E0C0A;margin:0 0 1.5rem">Hola ${s.q_nombre},<br>tu sesión Pre-XV está lista ✨</h1>
    <div style="background:#FAF7F2;padding:1rem;margin-bottom:1.5rem">
      <table style="width:100%;font-size:0.82rem;color:#3A3530">
        <tr><td style="padding:0.35rem 0;color:#867A69;font-size:0.72rem">FECHA</td><td style="text-align:right;font-weight:500">${fecha}</td></tr>
        <tr><td style="padding:0.35rem 0;color:#867A69;font-size:0.72rem">HORA SESIÓN</td><td style="text-align:right;font-weight:500">${s.hora?.slice(0,5)}</td></tr>
        ${s.hora_mk ? `<tr><td style="padding:0.35rem 0;color:#867A69;font-size:0.72rem">HORA MAQUILLAJE</td><td style="text-align:right;font-weight:500">${s.hora_mk?.slice(0,5)}</td></tr>` : ''}
        <tr><td style="padding:0.35rem 0;color:#867A69;font-size:0.72rem">SEDE</td><td style="text-align:right;font-weight:500">${sede}</td></tr>
        ${s.lugar ? `<tr><td style="padding:0.35rem 0;color:#867A69;font-size:0.72rem">UBICACIÓN</td><td style="text-align:right;font-weight:500">${s.lugar}</td></tr>` : ''}
      </table>
    </div>
    <div style="border:1px solid #C49A3C;padding:1rem;margin-bottom:1.5rem;background:rgba(196,154,60,0.04)">
      <div style="font-size:0.55rem;letter-spacing:0.2em;text-transform:uppercase;color:#867A69;margin-bottom:0.5rem">Resumen de pago</div>
      <div style="display:flex;justify-content:space-between;margin-bottom:0.3rem"><span style="font-size:0.8rem;color:#867A69">Anticipo pagado</span><span style="color:#7D9E7F;font-weight:500">${anticipo}</span></div>
      <div style="display:flex;justify-content:space-between"><span style="font-size:0.8rem;color:#867A69">Saldo el día de la sesión</span><span style="color:#0E0C0A;font-weight:500">${restante}</span></div>
    </div>
    <p style="font-size:0.78rem;color:#867A69;line-height:1.8">Si tienes alguna pregunta escríbenos por WhatsApp. ¡Nos vemos pronto para crear recuerdos que duran para siempre!</p>
  </div>
  <div style="text-align:center;padding:1.5rem;font-size:0.6rem;color:#867A69;letter-spacing:0.1em">
    AMBAR Couture · Colombia · ambarcouture.com
  </div>
</div></body></html>`;
}

function emailColabHTML(s, fecha, sede, colab, rol) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FAF7F2;font-family:'Outfit',sans-serif">
<div style="max-width:560px;margin:0 auto;padding:2rem">
  <div style="background:#0E0C0A;padding:2rem;text-align:center;margin-bottom:1.5rem">
    <div style="font-family:Georgia,serif;font-size:1.8rem;letter-spacing:0.25em;color:#DCBA6A">AMBAR</div>
    <div style="font-size:0.6rem;letter-spacing:0.4em;text-transform:uppercase;color:rgba(220,186,106,0.5);margin-top:4px">Couture · Admin</div>
  </div>
  <div style="background:white;padding:2rem;border:1px solid #F0E8D8">
    <div style="font-size:0.55rem;letter-spacing:0.3em;text-transform:uppercase;color:#C49A3C;margin-bottom:0.5rem">Nueva sesión confirmada</div>
    <h1 style="font-family:Georgia,serif;font-size:1.4rem;font-weight:400;color:#0E0C0A;margin:0 0 1.5rem">Hola ${colab.nombre},<br>tienes una sesión agendada como <em>${rol}</em></h1>
    <div style="background:#FAF7F2;padding:1rem;margin-bottom:1.5rem">
      <table style="width:100%;font-size:0.82rem;color:#3A3530">
        <tr><td style="padding:0.35rem 0;color:#867A69;font-size:0.72rem">QUINCEAÑERA</td><td style="text-align:right;font-weight:500">${s.q_nombre} ${s.q_apellido || ''}</td></tr>
        <tr><td style="padding:0.35rem 0;color:#867A69;font-size:0.72rem">TELÉFONO CLIENTE</td><td style="text-align:right;font-weight:500">${s.q_tel}</td></tr>
        <tr><td style="padding:0.35rem 0;color:#867A69;font-size:0.72rem">FECHA</td><td style="text-align:right;font-weight:500">${fecha}</td></tr>
        <tr><td style="padding:0.35rem 0;color:#867A69;font-size:0.72rem">HORA ${rol === 'Maquilladora' ? 'LLEGADA' : 'SESIÓN'}</td><td style="text-align:right;font-weight:500">${rol === 'Maquilladora' ? (s.hora_mk?.slice(0,5)||'—') : s.hora?.slice(0,5)}</td></tr>
        <tr><td style="padding:0.35rem 0;color:#867A69;font-size:0.72rem">SEDE</td><td style="text-align:right;font-weight:500">${sede}</td></tr>
        <tr><td style="padding:0.35rem 0;color:#867A69;font-size:0.72rem">UBICACIÓN</td><td style="text-align:right;font-weight:500">${rol === 'Maquilladora' ? (s.mk_addr || s.lugar || '—') : (s.lugar || '—')}</td></tr>
      </table>
    </div>
    <p style="font-size:0.78rem;color:#867A69;line-height:1.8">Por favor confirma tu disponibilidad respondiendo este correo o contactando al equipo AMBAR. Se enviará un recordatorio 2 días antes de la sesión.</p>
  </div>
</div></body></html>`;
}
