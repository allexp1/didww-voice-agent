// trunk-register.js — keeps a SIP REGISTER alive with the carrier.
//
// Registration-based trunks only deliver inbound calls to the address the SIP
// account is currently registered from, so this must be running for any inbound
// call to arrive. drachtio-server answers the carrier's digest challenge itself
// from the `auth` option — same mechanism as outbound INVITEs.
//
// DIDWW two-way trunks are IP-authenticated and do NOT need registration —
// leave SIP_USER unset and this module no-ops. See docs/DIDWW-SETUP.md.
//
// Usage:
//   const reg = startTrunkRegistration(srf, {
//     domain: SIP_DOMAIN, user: SIP_USER, pass: SIP_PASSWORD,
//     publicIp: PUBLIC_IP, sipPort: 5060,
//   });
//   // …later, on shutdown: reg.stop();

export function startTrunkRegistration(srf, {
  domain, user, pass, publicIp, sipPort = 5060, expires = 3600,
}) {
  if (!domain || !user) {
    console.warn('[register] trunk not configured (SIP_DOMAIN/SIP_USER unset) — skipping registration');
    return { stop() {} };
  }

  const aor = `<sip:${user}@${domain}>`;
  const contact = `<sip:${user}@${publicIp}:${sipPort}>`;
  let timer = null;
  let stopped = false;

  function schedule(sec) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(register, Math.max(10, sec) * 1000);
    timer.unref?.();
  }

  async function register() {
    if (stopped) return;
    try {
      const req = await srf.request(`sip:${domain}`, {
        method: 'REGISTER',
        headers: { To: aor, From: aor, Contact: contact, Expires: String(expires) },
        auth: { username: user, password: pass },
      });
      req.on('response', (res) => {
        if (res.status === 401 || res.status === 407) return; // digest in progress
        if (res.status === 200) {
          // Honour the expiry the registrar actually granted.
          let granted = expires;
          const cexp = (res.get('Contact') || '').match(/expires=(\d+)/i);
          const hexp = (res.get('Expires') || '').trim();
          if (cexp) granted = parseInt(cexp[1], 10);
          else if (/^\d+$/.test(hexp)) granted = parseInt(hexp, 10);
          console.log(`[register] ${user}@${domain}: 200 OK — registered (expires ${granted}s)`);
          schedule(Math.floor(granted / 2));
        } else {
          console.error(`[register] ${user}@${domain}: REGISTER failed — ${res.status} ${res.reason || ''} — retrying in 60s`);
          schedule(60);
        }
      });
    } catch (e) {
      console.error(`[register] REGISTER send error: ${e?.message || e} — retrying in 60s`);
      schedule(60);
    }
  }

  console.log(`[register] registering ${user}@${domain} — contact ${contact}`);
  register();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      // Best-effort de-register (Expires: 0) so the carrier stops sending calls.
      srf.request(`sip:${domain}`, {
        method: 'REGISTER',
        headers: { To: aor, From: aor, Contact: contact, Expires: '0' },
        auth: { username: user, password: pass },
      }).then((r) => r.on('response', () => {})).catch(() => {});
    },
  };
}
