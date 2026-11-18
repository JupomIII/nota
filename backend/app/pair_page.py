"""The pairing page the laptop browser opens.

It answers one question — what do I do on the iPad next — with the two addresses
the iPad needs, in order: the setup page (trust this laptop) and the pairing QR
code. It is served to the laptop itself only, so the code never travels further
than this screen.
"""

from __future__ import annotations

from string import Template

from . import pair_session, pairing


def _steps(cfg) -> str:
    if cfg.tunneled:
        return """
    <li><strong>Open NŌTA → Synchronisation</strong> on the iPad, put this laptop's
      address in, then tap <strong>Find this laptop</strong>.</li>
    <li><strong>Press Allow above</strong> when the iPad appears. There is no certificate
      to install and no code to type: this server uses a trusted address.</li>"""
    return f"""
    <li><strong>On the iPad, open the setup page</strong>
      <a href="{cfg.setup_url}">{cfg.setup_url}</a> in Safari. It downloads the trust
      profile straight from this laptop — nothing is emailed, AirDropped or copied.</li>
    <li><strong>Install the profile</strong>: Settings → General → VPN &amp; Device
      Management → <em>NŌTA Local CA</em> → Install, then enable it under
      Settings → General → About → <em>Certificate Trust Settings</em>. Both taps
      matter.</li>
          <li><strong>Come back here and press Allow</strong> when the iPad appears above.
      The iPad asks for itself, so there is no code to type. If you prefer, scan the QR
      code below with the iPad camera instead.</li>"""


_PAGE = Template(
    """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair your iPad · NŌTA</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: #faf8f4; color: #1f1d1a; }
  main { max-width: 720px; margin: 0 auto; padding: 40px 20px 64px; }
  h1 { font-family: Georgia, 'Times New Roman', serif; font-weight: 400; font-size: 30px; margin: 0 0 6px; }
  .lede { margin: 0 0 24px; color: #6d665c; line-height: 1.55; font-size: 15px; }
  .card { background: #fffdfa; border: 1px solid #e5ded1; border-radius: 16px; padding: 24px;
          box-shadow: 0 1px 2px rgba(31, 29, 26, 0.06); }
  .qr { display: block; margin: 4px auto 14px; width: 260px; height: 260px; }
  .code { text-align: center; font-size: 14px; color: #6d665c; margin: 0; }
  .code strong { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 26px;
                 letter-spacing: 0.3em; color: #1f1d1a; }
  .addr { text-align: center; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12.5px; color: #6d665c; margin: 8px 0 0; word-break: break-all; }
  .hint { text-align: center; color: #8a8378; font-size: 12.5px; margin: 12px 0 0; }
  h2 { font-family: Georgia, serif; font-weight: 400; font-size: 17px; margin: 30px 0 8px; }
  ol { margin: 0; padding-left: 20px; color: #3d3830; line-height: 1.65; font-size: 14px; }
  ol li { margin-bottom: 8px; }
  ol a { color: #4a6156; word-break: break-all; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
  .btn { display: inline-flex; align-items: center; height: 42px; padding: 0 16px; border-radius: 10px;
         border: 1px solid #e5ded1; background: #fffdfa; color: #1f1d1a; font-size: 14px;
         text-decoration: none; cursor: pointer; font-family: inherit; }
  .primary { background: #4a6156; border-color: #4a6156; color: #fffdfa; }
  .why { margin-top: 22px; border-radius: 12px; background: #f2eee7; padding: 12px 14px;
         font-size: 12.5px; line-height: 1.6; color: #4a463f; }
  footer { margin-top: 28px; color: #8a8378; font-size: 12.5px; text-align: center; line-height: 1.5; }
  .idle { margin: 0; color: #6d665c; font-size: 13.5px; line-height: 1.6; text-align: center; }
  ul.asks { list-style: none; margin: 0; padding: 0; }
  ul.asks li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 0;
               border-bottom: 1px solid #eee7db; }
  ul.asks li:last-child { border-bottom: 0; padding-bottom: 0; }
  .who { flex: 1 1 190px; min-width: 0; }
  .who strong { font-weight: 600; }
  .who span { display: block; color: #8a8378; font-size: 12px;
              font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  ul.asks .btn { height: 34px; padding: 0 12px; font-size: 13px; }
  .done { color: #4a6156; font-size: 13px; }
  details.fallback { margin-top: 26px; }
  details.fallback summary { cursor: pointer; color: #4a6156; font-size: 14px; }
  details.fallback .card { margin-top: 14px; }
  .askhint { text-align: center; color: #8a8378; font-size: 12px; margin: 12px 0 0; }
</style>
</head>
<body>
<main>
  <h1>Pair your iPad</h1>
  <p class="lede">$lede</p>

  <h2>Waiting for your iPad</h2>
  <div class="card">
    <p class="idle" id="idle">Nothing waiting. On the iPad, open NŌTA → Synchronisation and tap
      <strong>Find this laptop</strong>. It appears here, with one button to press.</p>
    <ul class="asks" id="asklist"></ul>
    <p class="askhint" id="askhint" hidden>Requests disappear by themselves after five minutes.</p>
  </div>

  <h2>Write on this laptop</h2>
  <p class="lede" style="margin-bottom:14px">
    The laptop has its own copy of the app, served by this server with no
    certificate to install. The QR code below is only for the iPad.
  </p>
  <a class="btn primary" href="$laptop_url/" target="_blank" rel="noreferrer">
    Open the app on this laptop
  </a>

  <h2>What to do on the iPad</h2>
  <ol>$steps
    <li>In Safari, Share → <strong>Add to Home Screen</strong> once the app opens.</li>
  </ol>

  <div class="actions">
    <a class="btn primary" href="$setup_url" target="_blank" rel="noreferrer">Open the iPad setup page</a>
  </div>

  <details class="fallback">
    <summary>Show the QR code</summary>
    <div class="card">
      <img class="qr" id="qr" src="/api/pair/qr" alt="Pairing QR code">
      <p class="code">Confirmation <strong id="confirm">$confirm_code</strong></p>
      <p class="hint" style="margin-top:6px">The iPad shows the same five characters.
        They must match, or the QR code was not the one on this screen.</p>
      <p class="code" style="margin-top:14px;font-size:13px">Older copy of the app? Its six-character code
        <strong id="code" style="font-size:18px">$code</strong></p>
      <p class="addr" id="addr">$server_url</p>
      <p class="hint" id="left">New QR code in $session_minutes min</p>
    </div>
    <div class="actions">
      <button class="btn" id="copy" type="button">Copy pairing link</button>
    </div>
  </details>

  <div class="why">$why</div>

  <footer>Codes change every $minutes minutes and never contain the pairing token.
  This page only opens on the laptop itself.</footer>
</main>
<script>
(function () {
  var link = '$link';
  var remaining = $expires;
  var left = document.getElementById('left');

  function paint() {
    if (remaining <= 0) { left.textContent = 'Refreshing…'; return; }
    var minutes = Math.max(1, Math.round(remaining / 60));
    left.textContent = 'New code in ' + minutes + ' min';
  }
  setInterval(function () { remaining = Math.max(0, remaining - 1); paint(); }, 1000);
  paint();

  async function refresh() {
    try {
      var response = await fetch('/api/pair/link', { cache: 'no-store' });
      if (!response.ok) { return; }
      var data = await response.json();
      document.getElementById('code').textContent = data.code;
      document.getElementById('confirm').textContent = data.confirmCode || '';
      document.getElementById('addr').textContent = data.serverUrl;
      document.getElementById('qr').src = '/api/pair/qr?t=' + Date.now();
      link = data.link;
      remaining = data.expiresIn;
      paint();
    } catch (error) { /* the laptop is restarting; the next tick retries */ }
  }
  setInterval(refresh, 60000);

  document.getElementById('copy').addEventListener('click', function () {
    var button = document.getElementById('copy');
    navigator.clipboard.writeText(link).then(function () {
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy pairing link'; }, 1600);
    });
  });

  // The waiting list: the iPad asks to pair, the laptop answers here. Polling
  // keeps this page a plain file with no framework and no websocket.
  var list = document.getElementById('asklist');
  var idle = document.getElementById('idle');
  var hint = document.getElementById('askhint');
  var current = [];
  var answered = {};

  function relAge(seconds) {
    if (seconds < 45) { return 'asked just now'; }
    var minutes = Math.max(1, Math.round(seconds / 60));
    return 'asked ' + minutes + ' min ago';
  }

  function rowFor(id, device, address, note) {
    var item = document.createElement('li');
    var who = document.createElement('div');
    who.className = 'who';
    var name = document.createElement('strong');
    name.textContent = device || 'A device';
    var where = document.createElement('span');
    where.textContent = (address || '') + (note ? ' · ' + note : '');
    who.appendChild(name);
    who.appendChild(where);
    item.appendChild(who);
    return item;
  }

  function answer(id, allow) {
    var ask = null;
    for (var index = 0; index < current.length; index += 1) {
      if (current[index].id === id) { ask = current[index]; }
    }
    answered[id] = {
      device: ask ? ask.device : '',
      address: ask ? ask.address : '',
      state: allow ? 'allowed' : 'denied',
    };
    draw();
    fetch('/api/pair/requests/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allow: allow }),
    }).catch(function () { delete answered[id]; draw(); });
  }

  function draw() {
    list.textContent = '';
    var shown = 0;
    Object.keys(answered).forEach(function (id) {
      var entry = answered[id];
      var item = rowFor(id, entry.device, entry.address, '');
      var done = document.createElement('span');
      done.className = 'done';
      done.textContent = entry.state === 'allowed' ? 'Allowed — it pairs itself now' : 'Refused';
      item.appendChild(done);
      list.appendChild(item);
      shown += 1;
    });
    current.forEach(function (ask) {
      if (answered[ask.id]) { return; }
      var item = rowFor(ask.id, ask.device, ask.address, relAge(ask.ageSeconds));
      var deny = document.createElement('button');
      deny.className = 'btn';
      deny.type = 'button';
      deny.textContent = 'Not now';
      deny.addEventListener('click', function () { answer(ask.id, false); });
      var allow = document.createElement('button');
      allow.className = 'btn primary';
      allow.type = 'button';
      allow.textContent = 'Allow';
      allow.addEventListener('click', function () { answer(ask.id, true); });
      item.appendChild(deny);
      item.appendChild(allow);
      list.appendChild(item);
      shown += 1;
    });
    idle.hidden = shown > 0;
    hint.hidden = shown === 0;
  }

  async function refreshAsks() {
    try {
      var response = await fetch('/api/pair/requests', { cache: 'no-store' });
      if (!response.ok) { return; }
      var data = await response.json();
      current = data.requests || [];
      draw();
    } catch (error) { /* the laptop is restarting; the next tick retries */ }
  }
  refreshAsks();
  setInterval(refreshAsks, 2000);
})();
</script>
</body>
</html>
"""
)


def render_pair_page(cfg) -> str:
    if cfg.tunneled:
        lede = (
            "This laptop is published behind a trusted address, so the iPad needs no "
            "certificate: open the app, tap Find this laptop, and press Allow here."
        )
        why = (
            "Because the address is signed by a public certificate authority, Safari "
            "accepts it as-is. Nothing is installed on the iPad."
        )
    else:
        lede = (
            "Two things happen on the iPad: it trusts this laptop once, then it pairs. "
            "The laptop finds the iPad by itself — you only press Allow."
        )
        why = (
            "Why the profile: iOS will not let an installed web app talk to a plain "
            "<code>http://</code> address, so this server uses HTTPS with a certificate "
            "it signs itself. The profile tells the iPad to trust this one machine — the "
            "private key never leaves it, and the profile is downloaded from the setup "
            "page rather than sent through email or AirDrop."
        )
    session = pair_session.start()
    return _PAGE.substitute(
        lede=lede,
        steps=_steps(cfg),
        why=why,
        laptop_url=cfg.laptop_app_url,
        code=pairing.current_code(cfg),
        confirm_code=session.code,
        session_minutes=max(1, int(pair_session.SESSION_TTL // 60)),
        server_url=cfg.base_url,
        setup_url=cfg.setup_url,
        minutes=cfg.pair_code_minutes,
        expires=pair_session.seconds_left(session),
        link=pair_session.link(cfg, session),
    )
