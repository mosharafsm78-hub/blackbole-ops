/* BlackBole COD form → BlackBole Ops lead.
   As soon as a valid mobile number is typed in the cash-on-delivery popup, send it (with name, address and the
   shoes in the form) to BlackBole Ops, so customers who leave without pressing "Confirm order" can be called.
   Separate from bb26-cod.js on purpose: it only reads the form, never changes it, and fails silently. */
(function () {
  var URL_LEAD = 'https://basic-crane-965.convex.site/cod-lead';
  var root = document.getElementById('bbCod');
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var lastSent = '', timer = 0;

  function phoneOk(v) {
    var d = String(v || '').replace(/\D/g, ''); if (d.indexOf('880') === 0) d = d.slice(2); if (d.length === 10 && d[0] === '1') d = '0' + d;
    return /^01[3-9]\d{8}$/.test(d) ? d : '';
  }
  function num(t) { var n = String(t || '').replace(/[^\d.]/g, ''); return n ? Math.round(parseFloat(n)) : 0; }
  function items() {
    return [].map.call(root.querySelectorAll('#codItems .cod-it'), function (el) {
      var q = el.querySelector('.cod-q i'), qty = q ? +q.textContent || 1 : 1;
      var total = num((el.querySelector(':scope > span') || {}).textContent);
      return {
        title: ((el.querySelector('b') || {}).textContent || '').trim(),
        variant: ((el.querySelector('small') || {}).textContent || '').trim(),
        qty: qty, price: qty ? Math.round(total / qty) : total
      };
    });
  }
  function ordered() { var d = $('codDone'); return d && !d.hidden; }
  function send() {
    try {
      if (ordered()) return;
      var p = phoneOk(($('codPhone') || {}).value); if (!p) return;
      var z = root.querySelector('input[name=codZone]:checked');
      var body = JSON.stringify({
        phone: p,
        name: (($('codName') || {}).value || '').trim(),
        email: (($('codEmail') || {}).value || '').trim(),
        address: (($('codAddr') || {}).value || '').trim(),
        zone: z ? z.value : '',
        items: items(),
        url: location.href.slice(0, 300)
      });
      if (body === lastSent) return;
      lastSent = body;
      // text/plain = no CORS preflight; keepalive = still sent if the page is closing
      fetch(URL_LEAD, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) {}
  }
  function soon() { clearTimeout(timer); timer = setTimeout(send, 1500); }

  ['codPhone', 'codName', 'codAddr', 'codEmail'].forEach(function (id) {
    var el = $(id); if (!el) return;
    el.addEventListener('input', soon);
    el.addEventListener('change', send);
    el.addEventListener('blur', send);
  });
  [].forEach.call(root.querySelectorAll('input[name=codZone]'), function (r) { r.addEventListener('change', soon); });
  // popup closed without ordering, or the tab is being hidden/closed: send what we have
  try {
    new MutationObserver(function () { if (!root.classList.contains('on')) { clearTimeout(timer); send(); } })
      .observe(root, { attributes: true, attributeFilter: ['class'] });
  } catch (e) {}
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && root.classList.contains('on')) send(); });
})();
