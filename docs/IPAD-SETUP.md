# Getting NŌTA onto the iPad

Three things happen here: the app goes on the Home Screen, the iPad learns to
trust your laptop, and the two pair. Nothing is emailed, AirDropped or copied by
hand — the app and the trust profile are both downloaded by the iPad from the
laptop itself.

## 1. Install the app

The laptop serves the app: `/` on the same address as `/api`, `/setup` and
`/profile`. There is nothing to publish, and the iPad never loads an older
build than the one on this machine.

1. Build it once (the installer does this when Node.js is installed):
   `cd frontend && npm install && npm run build`.
2. Open `https://<laptop-address>:8443/setup` in **Safari** on the iPad and
   follow that page; it ends with **Open NŌTA**.
3. Share → **Add to Home Screen**. That icon points at the laptop, so every
   launch uses the current build.
4. Launch it from the icon and check it opens offline: Airplane Mode, close the
   app from the switcher, reopen it. The library must still be there — the
   service worker caches the bundle, notes stay in the iPad's storage.

`frontend/vite.config.ts` uses `base: './'`, so the same build also works at a
custom domain root. `.github/workflows/deploy.yml` still publishes the app to
GitHub Pages if you ever want a copy that does not need the laptop running; the
pairing QR does not use it.

## 2. Run the laptop server

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1
```

Or just double-click **`run.bat`**, which installs on first run, starts the server
in its own window and opens the pairing page in your browser.

The server window prints, in this order:

```
  iPad address   : https://192.168.1.20:8443/
  Pairing code   : K7QM4P          (changes every 30 min)
  Pairing page   : http://localhost:8080/pair   (open on the laptop)

  First time on the iPad - nothing to send or copy:
    1. Open https://192.168.1.20:8443/setup in Safari on the iPad
    2. Tap 'Download the profile', install it in Settings, then enable it
       under Certificate Trust Settings
    3. Tap 'Open NOTA' on that page: the laptop serves the app itself,
       then 'Find this laptop', and press Allow on the pairing page
  Certificate    : 3F:9A:...:B1
```

If the iPad cannot reach the laptop, run `scripts\allow-firewall.ps1` from an
**Administrator** PowerShell window. It opens TCP 8443 for `LocalSubnet` on both
the Private and Public profiles — Windows classifies a home Wi-Fi as *Public* by
default, so a private-only rule lets nothing in — and it removes any inbound
Block rule that matches the Python running the server, because a block rule wins
over every allow rule. The server itself also rejects any client outside private
address ranges, so nothing is exposed to the Internet.

## 3. Trust the laptop, on the iPad

Open the **setup page** printed above (`https://<address>:8443/setup`) in Safari
on the iPad. It is served by your laptop and it walks through the four taps:

1. **Accept the warning once.** Safari warns because the laptop signs its own
   certificate: *Show Details → Visit this Website*.
2. **Download the profile.** The button on that page serves a `.mobileconfig`
   carrying the CA, straight from the laptop, so Safari says *Profile
   Downloaded*. If Safari only saves a file to Downloads, the profile was not
   installed and the iPad will keep refusing the certificate: tap the button
   again in Safari (not in Files) and let Settings open.
3. **Install it.** Settings → General → VPN & Device Management → *NŌTA
   Local CA* → Install. Then Settings → General → About → **Certificate Trust
   Settings** → switch *Thoth Notes Local CA* on. Both taps are required; iOS
   installs profiles without trusting them by default.
4. **Open the app and pair.** Tap **Open NŌTA** on the setup page: the laptop
   serves the app itself, so it runs on the same address as the API with no
   cross-origin request and no second copy. Then press **Find this laptop** in
   *Synchronisation*, or scan the QR code shown on the laptop.

The page shows the certificate fingerprint and expiry so you can confirm you are
looking at the right laptop.

### Is there a way to sync without installing a certificate?

Not over the LAN, and this is measured rather than assumed:

- An installed web app runs a service worker, and a service worker is only
  allowed in a secure context. `http://192.168.x.y` is not one; only
  `http://localhost` is, and that is the laptop itself, not the iPad.
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API))
- Safari rejects a `.local` name whose certificate is self-signed, and no
  publicly trusted authority can validate a private `192.168.x.y` address.
- Safari 18.2 and later go further: a home-screen web app may not even navigate
  to a plain `http://` address.

So a LAN-only sync always needs a certificate the iPad trusts, which is exactly
what the profile above provides. The certificate-free path that does exist is a
**publicly trusted name**, and the server already supports it: set `public_url`
to such an address (Tailscale `tailscale serve` gives `https://<machine>.<tailnet>.ts.net`
with a real Let's Encrypt certificate; a Cloudflare tunnel works too) and the
server switches to that address, drops TLS and the profile entirely — see
`python -m app.cli public-url`. It costs an extra app on the iPad and a third
party in the path, which is why it stays optional.

### Why a certificate exists at all

GitHub Pages is an HTTPS origin and Safari refuses `http://` requests from it as
mixed content; there is no override, not even for an installed web app. Measured
on this stack, such a request fails in about 6 ms with `TypeError: Load failed`
and never reaches the laptop, and Safari has no exemption for private addresses.
So the laptop must speak HTTPS with a certificate the iPad accepts. Apple does not let a
web page install a certificate silently, which is why the last two taps in
Settings are unavoidable **for a purely local server**.

What changed from earlier versions:

* The profile is **downloaded from the laptop**, never sent as a file.
* The CA key now stays in `backend\storage\certs\ca-key.pem`, so the server can
  re-issue its own certificate when the LAN address changes — the profile on the
  iPad keeps working. Reinstalling never produces a second profile.
* Keys are ECDSA P-256, the CA may only sign server certificates, and the server
  certificate is valid for 397 days and renewed automatically in the last week.

## 4. Pair

**Find.** Leave the pairing page open on the laptop — the address the server
prints, `http://localhost:8080/pair`, is plain HTTP on purpose: the laptop has no
certificate to install or trust. On the iPad, App → **Synchronisation** →
*Set up this iPad*, then press **Find this laptop** in step 2. The laptop lists
this iPad under *Waiting for your iPad* with its address and one **Allow**
button; press it and the iPad pairs by itself. Nothing to scan, nothing to type.
Requests die after five minutes, and the token only leaves the laptop once you
press Allow.

**Scan.** If you would rather use the camera, the pairing page keeps a QR code
under *Or pair with a QR code instead*. Point the iPad camera at it and tap the
banner: the app opens on the sync screen with the address and code already
filled in and pairs itself. The link carries only the short-lived code, never
the token.

**Type.** Step 1 has a **Check again** button that calls the laptop and tells
you whether the certificate is trusted yet; step 2 also takes the six characters
from the server window or pairing page. Codes change every thirty minutes and
the previous one is accepted for one window.

The token is stored only in the iPad's IndexedDB, is never shown in full (dots
only), never appears in a URL and is never logged. **Forget this laptop** removes
it. The sync screen also shows the destination: laptop name, notes folder and how
much is stored there.

## 5. If you would rather not install a certificate

A trusted public address removes the need for a profile completely. Any of these
works because Safari already trusts the address:

**Tailscale (free for personal use).** Install Tailscale on the laptop and the
iPad, sign both into the same tailnet, then on the laptop:

```powershell
tailscale serve --bg 8443
```

Tailscale prints an address such as `https://jps-laptop.tailnet-name.ts.net`.
Give it to the server once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1 -PublicUrl https://jps-laptop.tailnet-name.ts.net
```

The server then speaks plain HTTP behind the tunnel, no certificate is generated,
`/setup` says there is nothing to install, and the pairing link points at the
trusted address. Nothing needs to be installed on the iPad.

The address must be `https://host` with no path and no query. A plain `http://`
address, a missing scheme or a trailing path is refused where it is set — the
installer and `start-server.ps1` stop with a readable message instead of
starting a server that would fail later on the iPad. In this mode the plain-HTTP
port listens on `127.0.0.1` only (the tunnel's own client is the sole way in,
so the Wi-Fi cannot reach it) and `nota.local` is no longer announced.

**Cloudflare Tunnel** works the same way: point the tunnel at
`http://localhost:8443` and pass its `https://…` hostname with `-PublicUrl`.

Store or clear the address at any time:

```powershell
cd backend
.\.venv\Scripts\python.exe -m app.cli public-url https://your-address.ts.net
.\.venv\Scripts\python.exe -m app.cli public-url            # back to the local certificate
```

Keep the server on the private network either way: it rejects clients outside
private address ranges, and every `/api` route except health and pairing needs
the token.

## 6. Updating

* **Frontend**: push to `main`; the new service worker downloads in the
  background and the app offers *Reload*. Notes are untouched.
* **Backend**: `git pull`, then re-run `scripts\install-windows.ps1` — the virtual
  environment and `backend\storage` are preserved. The certificate is re-issued
  only if the machine's addresses changed, and it keeps the same CA.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Setup page will not open at all | Laptop asleep, wrong network, or firewall | Wake the laptop, check both are on the same Wi-Fi, run `scripts\allow-firewall.ps1` |
| Server window warns that the iPad cannot reach it | Windows Firewall has a Block rule for `python.exe` on a public network | Run `scripts\allow-firewall.ps1` in an Administrator window; it removes that rule and opens 8443 |
| Works on the laptop, never on the iPad | iOS Local Network permission refused for Safari | Settings → Privacy & Security → Local Network → enable Safari |
| Warning returns after trusting | Profile installed but not enabled | Settings → General → About → Certificate Trust Settings |
| "Profile Downloaded" never appears | The file was opened from Files instead of Safari | Open `https://<laptop>:8443/setup` in Safari and tap *Download the profile*; the `.mobileconfig` must open Settings |
| "Check again" says no answer | Certificate not trusted yet, or server stopped | Finish step 3, then start the server window |
| Paired, then *offline* | DHCP gave the laptop a new address | The certificate is re-issued on the next start; re-open the setup page and pair again with the new address |
| New laptop, same iPad | Fingerprint changed | Install the new profile; the old one can be removed under VPN & Device Management |
