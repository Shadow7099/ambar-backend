// ══════════════════════════════════════════════════
//  AMBAR Couture · Check Availability
//  GET /api/check-availability?sede=bogota&fecha=2026-04-15
// ══════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service key para backend
);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { sede, fecha, pg_id, mk_id } = req.query;

  if (!sede || !fecha) {
    return res.status(400).json({ error: 'sede y fecha son requeridos' });
  }

  try {
    // Buscar sesiones en esa sede y fecha que NO estén canceladas
    const { data, error } = await sb
      .from('sesiones')
      .select('id, hora, pg_id, mk_id, status')
      .eq('sede', sede)
      .eq('fecha', fecha)
      .neq('status', 'cancelada');

    if (error) throw error;

    // Horas ya ocupadas
    const horasOcupadas = data.map(s => s.hora?.slice(0, 5));

    // Fotógrafos ocupados ese día
    const pgOcupados = data.map(s => s.pg_id).filter(Boolean);

    // Maquilladoras ocupadas ese día
    const mkOcupadas = data.map(s => s.mk_id).filter(Boolean);

    // Si se pasa pg_id específico, verificar disponibilidad
    const pgDisponible = pg_id ? !pgOcupados.includes(pg_id) : true;
    const mkDisponible = mk_id ? !mkOcupadas.includes(mk_id) : true;

    return res.status(200).json({
      disponible: pgDisponible && mkDisponible,
      horasOcupadas,
      pgOcupados,
      mkOcupadas,
      sesionesCount: data.length,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
