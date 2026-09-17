const crypto = require('crypto');
const { canonicalUrl } = require('./posting');
const usage = require('./usage');

module.exports = function billing(db, costs, authenticate) {
  return action => async (req, res, next) => {
    try {
      const auth = authenticate(req);
      if (!auth?.email) return res.status(401).json({ error: 'Sign in required' });
      req.userEmail = auth.email;
      if (action === 'generate') {
        req.body.url = canonicalUrl(req.body.url);
        if (!req.body.force) {
          const kit = await db.findKit(req.body.url, auth.email);
          if (kit) return res.json(kit);
        }
      }
      const key = req.get('Idempotency-Key') || crypto.randomUUID();
      if (key.length > 200) return res.status(400).json({ error: 'Invalid idempotency key' });
      const resource = req.body.url || req.body.appId || req.body.kitId || key;
      const op = await db.reserveOperation({ userEmail:auth.email,action,key,resource,cost:costs[action] || 0,payload:req.body });
      if (op.replay) {
        if (op.status === 'succeeded') return res.json(op.result);
        return res.status(409).json({ error: op.error || 'This request is already running', operation_id:op.id });
      }
      res.setHeader('X-Operation-Id', op.id);
      req.operationId = op.id;
      const heartbeat = setInterval(() => db.renewOperation(op.id,auth.email).catch(e=>console.error('[billing heartbeat]',e.message)),30000);
      heartbeat.unref();
      const json = res.json.bind(res);
      let completing = false;
      res.noCharge = () => { res.locals.noCharge = true; };
      res.json = body => {
        if (completing) return res;
        completing = true;
        const refund = res.statusCode >= 400 || !!res.locals.noCharge;
        db.finishOperation(op.id,auth.email,{ result:body,refund,message:refund ? body?.error || 'No billable work' : null,providerUsage:requestUsage.snapshot() })
          .then(finished => {
            if (finished.status === 'refunded' && !refund) { res.statusCode=409; body={error:finished.error || 'Operation expired; credits returned'}; }
            if (!res.destroyed) json(body);
          })
          .catch(e => {
            console.error('[billing completion]',e.message);
            if (!res.destroyed) { res.statusCode=503; json({ error:'Completion could not be confirmed. Check this operation before retrying.',operation_id:op.id }); }
          })
          .finally(()=>clearInterval(heartbeat));
        return res;
      };
      const requestUsage = usage.begin();
      requestUsage.run(() => next());
    } catch (error) { next(error); }
  };
};
