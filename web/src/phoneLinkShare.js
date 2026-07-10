// Phone comment link + QR — auto-wires when #phoneAudioLink is on the page.
// Paste a Cloudflare Quick Tunnel URL → normalized to the /comment page → QR;
// also auto-fills from /api/tunnel-status. (Lifted out of the retired /camera page.)
(function () {
  var input = document.getElementById('phoneAudioLink');
  if (!input) return;
  var resolved = document.getElementById('phoneAudioResolved');
  var qr = document.getElementById('phoneAudioQr');
  var copyBtn = document.getElementById('copyPhoneAudioLinkBtn');
  var clearBtn = document.getElementById('clearPhoneAudioLinkBtn');
  var qrInstance = null, lastAuto = '';
  var KEY = 'phone_audio_link';

  function normalize(raw) {
    var text = String(raw || '').trim();
    if (!text) return '';
    if (!/^https?:\/\//i.test(text)) text = 'https://' + text.replace(/^\/+/, '');
    try {
      var u = new URL(text);
      if (!/\/comment\/?$/i.test(u.pathname || '')) { u.pathname = '/comment'; u.search = ''; u.hash = ''; }
      return u.toString();
    } catch (_e) { return ''; }
  }
  function renderQr(url) {
    if (!qr) return;
    qr.innerHTML = '';
    if (!url) { qr.innerHTML = '<div id="phoneAudioQrEmpty">Paste a tunnel link to generate a QR code.</div>'; qrInstance = null; return; }
    if (typeof window.QRCode !== 'function') {
      qr.innerHTML = '<div id="phoneAudioQrEmpty">QR generator unavailable, but the phone link is ready below.</div>';
      qrInstance = null; return;
    }
    qrInstance = new window.QRCode(qr, { text: url, width: 180, height: 180, correctLevel: window.QRCode.CorrectLevel.M });
  }
  function refresh() {
    var n = normalize(input.value);
    if (resolved) resolved.textContent = n ? n : 'Enter a valid Cloudflare URL.';
    renderQr(n);
  }
  function save() { try { localStorage.setItem(KEY, String(input.value || '').trim()); } catch (_e) {} }
  function load() { try { var s = localStorage.getItem(KEY); if (s) input.value = s; } catch (_e) {} refresh(); }
  function copyText(text) {
    var v = String(text || '');
    if (!v) return Promise.reject(new Error('empty'));
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(v);
    return new Promise(function (res, rej) {
      try {
        var t = document.createElement('input');
        t.value = v; t.style.position = 'fixed'; t.style.opacity = '0';
        document.body.appendChild(t); t.focus(); t.select();
        var ok = document.execCommand('copy'); document.body.removeChild(t);
        ok ? res() : rej(new Error('copy_failed'));
      } catch (e) { rej(e); }
    });
  }
  async function refreshTunnel() {
    try {
      var res = await fetch('/api/tunnel-status', { cache: 'no-store' });
      var data = await res.json();
      if (!res.ok || !data || data.ok !== true || data.status !== 'ready' || !data.url) return;
      var n = normalize(data.url);
      if (!n) return;
      var cur = String(input.value || '').trim();
      if (!cur || cur === lastAuto || /trycloudflare\.com/i.test(cur)) { input.value = n; lastAuto = n; save(); refresh(); }
    } catch (_e) {}
  }

  input.addEventListener('input', function () { save(); refresh(); });
  input.addEventListener('change', function () { save(); refresh(); });
  if (copyBtn) copyBtn.addEventListener('click', function () {
    copyText(normalize(input.value))
      .then(function () { copyBtn.textContent = 'Copied'; setTimeout(function () { copyBtn.textContent = 'Copy Phone Link'; }, 1400); })
      .catch(function () { copyBtn.textContent = 'Invalid Link'; setTimeout(function () { copyBtn.textContent = 'Copy Phone Link'; }, 1400); });
  });
  if (clearBtn) clearBtn.addEventListener('click', function () { input.value = ''; save(); refresh(); });

  load();
  refreshTunnel();
  setInterval(refreshTunnel, 3000);
})();
