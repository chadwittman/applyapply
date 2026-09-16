const crypto = require('crypto');
const { requireOwner } = require('./posting');

module.exports = pool => ({
  async createPurchase(email, price) {
    requireOwner(email);
    if (price.currency !== 'usd' || price.unit_amount !== 1000 || !price.active || price.recurring) {
      throw new Error('Expected an active one-time USD 10 credit pack');
    }
    return (await pool.query(`INSERT INTO purchases(id,user_email,price_id,currency,amount,credits)
      VALUES($1,$2,$3,'usd',1000,1000) RETURNING *`, [crypto.randomUUID(),email,price.id])).rows[0];
  },
  async bindPurchase(id, sessionId) {
    await pool.query('UPDATE purchases SET session_id=$1 WHERE id=$2 AND session_id IS NULL', [sessionId,id]);
  },
  async fulfillPurchase(eventId, session) {
    if (session.payment_status !== 'paid') return false;
    if (!eventId || !session.id || session.mode !== 'payment' || !session.metadata?.purchase_id) throw new Error('Unrecognized checkout; reconcile payment before retrying');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const p = (await c.query('SELECT * FROM purchases WHERE id=$1 FOR UPDATE', [session.metadata.purchase_id])).rows[0];
      const email = (session.customer_email || session.customer_details?.email || '').trim().toLowerCase();
      if (!p || (p.session_id && p.session_id !== session.id) || p.user_email !== email || p.currency !== session.currency || p.amount !== session.amount_total) throw new Error('Checkout does not match the recorded purchase');
      if (p.fulfilled_at) { await c.query('COMMIT'); return false; }
      const claimed = await c.query('INSERT INTO stripe_events(event_id,email,credits) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id', [eventId,p.user_email,p.credits]);
      if (!claimed.rowCount) throw new Error('Event already belongs to another fulfillment');
      await c.query('INSERT INTO users(email,credits,created_at) VALUES($1,0,$2) ON CONFLICT DO NOTHING', [p.user_email,new Date().toISOString()]);
      await c.query('UPDATE users SET credits=credits+$1 WHERE email=$2', [p.credits,p.user_email]);
      await c.query("INSERT INTO credit_ledger(user_email,operation_id,kind,amount) VALUES($1,$2,'purchase',$3)", [p.user_email,session.id,p.credits]);
      await c.query('UPDATE purchases SET session_id=$1,fulfilled_at=NOW() WHERE id=$2', [session.id,p.id]);
      await c.query('COMMIT');
      return true;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  },
});
