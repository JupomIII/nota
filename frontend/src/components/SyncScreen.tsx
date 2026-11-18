import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  Check,
  CloudOff,
  Eye,
  EyeOff,
  ExternalLink,
  Laptop,
  RefreshCw,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react';
import { db } from '../storage/db';
import { getDeviceId, pendingByKind } from '../storage/repo';
import {
  adoptServedServer,
  loadSyncConfig,
  recheckServedServer,
  refreshCounters,
  resolveConflict,
  saveSyncConfig,
  syncNow,
  testConnection,
} from '../sync/engine';
import { SyncClient, SyncError, pairWithCode, pairWithSession, pollPairing, startPairing } from '../sync/client';
import type { PairedDevice } from '../sync/client';
import { isServedByThoth } from '../sync/discovery';
import { CONNECTION_LABELS, MDNS_HOST, MDNS_PORT, connectionState } from '../sync/resolve';
import type { PairResponse, ServerStatus } from '../sync/protocol';
import { syncStatus } from '../sync/store';
import { describePending, relativeTime } from '../lib/format';
import { thisDevice } from '../lib/device';
import { navigate } from '../app/router';
import { Button, Field, ScreenHeader, Spinner, TextInput, Toggle, cx } from './ui';

type Config = Awaited<ReturnType<typeof loadSyncConfig>>;

function cleanCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function withScheme(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withoutSlash = trimmed.replace(/\/+$/, '');
  return /^https?:\/\//i.test(withoutSlash) ? withoutSlash : `https://${withoutSlash}`;
}

function stepBadge(done: boolean): string {
  return done
    ? 'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] text-paper-raised'
    : 'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-paper-sunken text-[12px] text-ink-muted';
}

function diagRow(label: string, value: string, mono = false) {
  return (
    <div key={label} className="flex items-start gap-2">
      <dt className="w-[150px] shrink-0 text-ink-muted">{label}</dt>
      <dd className={cx('min-w-0 flex-1 break-all', mono && 'font-mono text-[11.5px]')}>{value}</dd>
    </div>
  );
}

/** Which copy is newer, in the words the screen already uses for time. */
function editedWhen(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'at an unknown time';
  const value = (payload as { updatedAt?: unknown }).updatedAt;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 'at an unknown time';
  return relativeTime(value);
}

/** The day a device was let in, in words rather than a timestamp. */
function pairedOn(moment: number): string {
  if (!Number.isFinite(moment) || moment <= 0) return 'at an unknown date';
  return new Date(moment).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function maskToken(token: string): string {
  // Never echo any character of the token: only its length is visible.
  return token ? '•'.repeat(Math.min(20, Math.max(8, token.length))) : '';
}

export function SyncScreen() {
  const [serverUrl, setServerUrl] = useState('');
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [autoSync, setAutoSync] = useState(true);
  const [paired, setPaired] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [destination, setDestination] = useState<ServerStatus | null>(null);
  const [pairing, setPairing] = useState(false);
  // Waiting for the laptop to allow this device: no code, no QR.
  // The five characters the laptop shows too: proof that both screens used one secret.
  const [confirmCode, setConfirmCode] = useState('');
  const [finding, setFinding] = useState(false);
  // Why the last attempt did not finish: "unreachable" is the case where the
  // certificate or the laptop's own state is the cause, and the setup page is
  // the fix, so it is offered right there instead of only as an error line.
  const [findFailure, setFindFailure] = useState<'unreachable' | 'refused' | null>(null);
  const cancelFind = useRef(false);
  const [syncing, setSyncing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ ok: boolean; message: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [servedBy, setServedBy] = useState<string | null>(null);
  const [probed, setProbed] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [manual, setManual] = useState(false);
  // Laptop only: who has been allowed in, and what withdrawing that looks like.
  const [deviceRows, setDeviceRows] = useState<PairedDevice[] | null>(null);
  // "Could not read" is not "still reading": a spinning sentence with no end
  // is worse than a plain one that admits the laptop did not answer.
  const [deviceError, setDeviceError] = useState(false);
  const [readingDevices, setReadingDevices] = useState(false);
  const [revokeNote, setRevokeNote] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const started = useRef(false);

  const status = useSyncExternalStore(syncStatus.subscribe, syncStatus.getSnapshot);
  const conflicts = useLiveQuery(() => db.conflicts.orderBy('createdAt').reverse().toArray(), []);
  // What is queued, not just how much: "12 strokes · 3 pages" tells whether the
  // last few minutes of writing actually made it across.
  const pendingCounts = useLiveQuery(() => pendingByKind(), []);
  const pendingSummary = pendingCounts ? describePending(pendingCounts) : '';
  // The same screen runs on both machines; name the one in the reader's hand.
  const device = thisDevice();
  // The server reports where the laptop opens the app; older servers do not.
  const laptopAppUrl = destination?.laptopUrl || 'http://localhost:8080';
  const canUseLaptopApp = device === 'laptop' && !servedBy;
  // A laptop page that cannot reach its own server is not a device waiting to
  // be paired: it is a server that is not running, and the reader needs to hear
  // that instead of a pairing code they have nowhere to read.
  const laptopServerMissing = canUseLaptopApp && probed && !destination && !paired;
  const showPairForm = (!paired || editing) && (!laptopServerMissing || manual);
  // One plain sentence instead of ports, addresses and error codes.
  const connection = connectionState({
    phase: status.phase,
    online: status.online,
    pending: status.pending,
    paired,
    needsAttention: status.needsAttention,
  });

  async function refreshDestination(config?: Config): Promise<void> {
    const cfg = config ?? (await loadSyncConfig());
    if (!cfg.serverUrl || !cfg.token) {
      setDestination(null);
      return;
    }
    try {
      const deviceId = await getDeviceId();
      setDestination(await new SyncClient(cfg.serverUrl, cfg.token, deviceId).status());
      // A 200 from /api/status is proof this token is accepted right now: a
      // refusal recorded before it no longer describes the device in hand.
      if (syncStatus.getSnapshot().revoked) {
        syncStatus.update({ revoked: false, needsAttention: false });
      }
    } catch (error) {
      setDestination(null);
      // The probe is often the first place a removed device shows up. Without
      // this the screen would call a refusing laptop "offline" and leave the
      // reader with nothing to do until the next sync attempt.
      if (error instanceof SyncError && error.code === 'revoked') {
        syncStatus.update({
          phase: 'error',
          message: error.message,
          needsAttention: true,
          revoked: true,
        });
      }
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const hash = window.location.hash;
      const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
      const params = new URLSearchParams(query);
      const linkServer = params.get('server') ?? '';
      const linkCode = cleanCode(params.get('code') ?? '');
      // A scanned QR code carries a session and its secret, never a typed code.
      const linkSession = params.get('i') ?? '';
      const linkSecret = params.get('s') ?? '';
      if (query) {
        // The code is short-lived, but keep it out of the address bar and history.
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/sync`);
      }

      let config = await loadSyncConfig();
      // Cheap after the first call: the answer is cached for this page.
      const adoption = await adoptServedServer();
      setProbed(true);
      if (adoption) {
        config = await loadSyncConfig();
        setServedBy(adoption.detected.deviceName);
        if (adoption.state === 'paired') {
          setNotice('This laptop is serving the app, so it paired automatically. Nothing to type.');
        }
      }
      // The iPad already knows the name the laptop advertises on this network,
      // so the first pairing needs no typed address and no QR code.
      setServerUrl(
        linkServer || config.serverUrl || (device === 'iPad' ? `https://${MDNS_HOST}:${MDNS_PORT}` : ''),
      );
      setCode(linkCode);
      setToken(config.token);
      setAutoSync(config.autoSync);
      setPaired(Boolean(config.serverUrl && config.token));
      await refreshDestination(config);
      await refreshCounters();

      if (linkServer && linkSession && linkSecret) {
        await pairWithScannedCode(linkServer, linkSession, linkSecret);
      } else if (linkServer && linkCode) {
        await pairWith(linkServer, linkCode, { silent: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the screen stops the waiting loop instead of polling a page nobody
  // is looking at.
  useEffect(() => () => {
    cancelFind.current = true;
  }, []);

  /** Opens the laptop's own setup page: the profile is downloaded from there. */
  const trustUrl = withScheme(serverUrl);

  function openSetup(): void {
    if (!trustUrl) {
      setError('Enter the laptop address first.');
      return;
    }
    const url = `${trustUrl}/setup`;
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) window.location.assign(url);
  }

  /** Probes /api/health: the same call the app makes when it syncs. */
  async function checkLaptop(): Promise<void> {
    if (!trustUrl) {
      setProbe({ ok: false, message: 'Enter the laptop address first.' });
      return;
    }
    setChecking(true);
    setProbe(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${trustUrl}/api/health`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`The laptop answered ${response.status}.`);
      const health = (await response.json()) as { deviceName?: string; version?: number };
      setProbe({
        ok: true,
        message: `${health.deviceName ?? 'The laptop'} answered · protocol v${health.version ?? 1}. The certificate is trusted on this iPad.`,
      });
    } catch {
      setProbe({
        ok: false,
        message:
          'No answer. Either the laptop is asleep or off this network, or its certificate is not trusted yet: open the setup page, install the profile, then check again.',
      });
    } finally {
      window.clearTimeout(timer);
      setChecking(false);
    }
  }

  async function pairWith(
    rawUrl: string,
    rawCode: string,
    options: { silent?: boolean } = {},
  ): Promise<void> {
    if (!rawUrl.trim()) {
      setError("Enter the laptop's address from the server window, for example https://192.168.1.20:8443");
      return;
    }
    if (cleanCode(rawCode).length !== 6) {
      setError('The pairing code has six characters.');
      return;
    }
    setPairing(true);
    setError(null);
    setNotice(null);
    try {
      const deviceId = await getDeviceId();
      const result = await pairWithCode(rawUrl, cleanCode(rawCode), `${device} ${deviceId.slice(0, 4)}`);
      await adoptPairing(result, rawUrl, options);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Pairing failed');
    } finally {
      setPairing(false);
    }
  }

  /** Keeps the destination, the notice and the first sync in one place. */
  async function adoptPairing(
    result: PairResponse,
    rawUrl: string,
    options: { silent?: boolean } = {},
  ): Promise<void> {
    const config = await saveSyncConfig({
      serverUrl: result.serverUrl || rawUrl,
      token: result.token,
      // The laptop says whether it answers under nota.local; a trusted address
      // means it does not, and the app then stops asking.
      mdns: result.mdns,
    });
    setServerUrl(config.serverUrl);
    setToken(config.token);
    setPaired(true);
    setEditing(false);
    setCode('');
    setNotice(`Paired with ${result.deviceName || 'your laptop'}. Notes now sync there.`);
    await refreshDestination(config);
    await refreshCounters();
    if (!options.silent) {
      const outcome = await syncNow();
      if (!outcome.ok) setError(outcome.message);
    }
  }

  async function handlePair(): Promise<void> {
    await pairWith(serverUrl, code);
  }

  /**
   * The QR path: the secret proves itself to the laptop, the laptop answers with
   * the five characters its own screen shows, and both are put side by side.
   */
  async function pairWithScannedCode(rawUrl: string, sessionId: string, secret: string): Promise<void> {
    setPairing(true);
    setError(null);
    setNotice(null);
    try {
      const deviceId = await getDeviceId();
      const result = await pairWithSession(
        rawUrl,
        sessionId,
        secret,
        `${device} ${deviceId.slice(0, 4)}`,
        deviceId,
      );
      setConfirmCode(result.code ?? '');
      await adoptPairing(result, rawUrl, { silent: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Pairing failed');
    } finally {
      setPairing(false);
    }
  }

  /**
   * The laptop finds this device instead of the other way round: the request is
   * posted, the laptop lists it on its own page, and the token comes back here
   * once Allow is pressed. Nothing is typed and no camera is involved.
   */
  async function handleFind(): Promise<void> {
    const rawUrl = withScheme(serverUrl);
    if (!rawUrl) {
      setError('Enter the laptop address first.');
      return;
    }
    if (finding) return;
    setFinding(true);
    cancelFind.current = false;
    setError(null);
    setNotice(null);
    setFindFailure(null);
    try {
      const deviceId = await getDeviceId();
      const ask = await startPairing(rawUrl, `${device} ${deviceId.slice(0, 4)}`, deviceId);
      const deadline = Date.now() + Math.min(ask.expiresIn, 300) * 1000;
      while (!cancelFind.current && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        if (cancelFind.current) return;
        const answer = await pollPairing(rawUrl, ask.id);
        if (answer.state === 'allowed') {
          await adoptPairing(answer.result, rawUrl);
          return;
        }
        if (answer.state === 'denied') {
          setFindFailure('refused');
          setError('The laptop refused this request. You can still type the pairing code.');
          return;
        }
        if (answer.state === 'claimed') {
          setFindFailure('refused');
          setError('That request was already answered. Press Connect to my laptop again.');
          return;
        }
      }
      if (!cancelFind.current) {
        setFindFailure('unreachable');
        setError('No answer from the laptop. Press Connect to my laptop again, or type the code.');
      }
    } catch (failure) {
      setFindFailure('unreachable');
      setError(failure instanceof Error ? failure.message : 'Could not reach the laptop');
    } finally {
      setFinding(false);
    }
  }

  async function handleTokenPair(): Promise<void> {
    if (!serverUrl.trim() || !token.trim()) {
      setError('Enter the laptop address and the pairing token.');
      return;
    }
    const config = await saveSyncConfig({ serverUrl, token });
    setServerUrl(config.serverUrl);
    setToken(config.token);
    setPaired(true);
    setEditing(false);
    setNotice(`Token saved on this ${device}.`);
    await refreshDestination(config);
    await refreshCounters();
  }

  async function handleForget(): Promise<void> {
    await saveSyncConfig({ serverUrl, token: '' });
    setToken('');
    setPaired(false);
    setEditing(false);
    setConfirmCode('');
    setDestination(null);
    setNotice(`This ${device} no longer stores the pairing token. Your notes stay on the device.`);
    await refreshCounters();
  }

  /** The laptop's server may have been started since this page opened. */
  async function recheckServer(): Promise<void> {
    setRechecking(true);
    setError(null);
    setNotice(null);
    try {
      const adoption = await recheckServedServer();
      const config = await loadSyncConfig();
      if (adoption) {
        setServedBy(adoption.detected.deviceName);
        // Pull straight away: the reader just asked for their notes back.
        const outcome = await syncNow();
        setNotice(
          adoption.state === 'paired'
            ? 'Found the laptop server and paired with it. Your notes are on their way.'
            : 'Found the laptop server.',
        );
        if (!outcome.ok) setError(outcome.message);
      } else {
        setError(`Still no answer at ${laptopAppUrl}. Is the “NŌTA server” window open on the laptop?`);
      }
      setServerUrl(config.serverUrl);
      setToken(config.token);
      setPaired(Boolean(config.serverUrl && config.token));
      await refreshDestination(config);
      await refreshCounters();
    } finally {
      setRechecking(false);
    }
  }

  async function handleSync(): Promise<void> {
    setSyncing(true);
    setError(null);
    try {
      const result = await syncNow();
      // A removed device is explained by the block below, which also carries the
      // way out; a second red line would only repeat it.
      if (!result.ok && !syncStatus.getSnapshot().revoked) setError(result.message);
      await refreshDestination();
    } finally {
      setSyncing(false);
    }
  }

  async function handleTest(): Promise<void> {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testConnection(serverUrl, token));
    } finally {
      setTesting(false);
    }
  }

  // Only offered once the page proved it is served by a Thoth backend.
  const sameOrigin = servedBy !== null && isServedByThoth();

  // The list of paired devices belongs to the machine that granted the tokens.
  // On the iPad this component is the same code, so the card stays away.
  const showsPairedDevices = device === 'laptop' && sameOrigin && paired;
  // A revoked device has no place in this list: it is not paired any more.
  const activeDevices = (deviceRows ?? []).filter((entry) => !entry.revoked);

  useEffect(() => {
    if (!showsPairedDevices || !trustUrl) {
      setDeviceRows(null);
      setDeviceError(false);
      return;
    }
    let alive = true;
    setDeviceError(false);
    void (async () => {
      try {
        const rows = await new SyncClient(trustUrl, token, 'laptop').pairedDevices();
        if (alive) setDeviceRows(rows);
      } catch {
        // A laptop that went to sleep, or its server that just stopped: say so
        // instead of leaving "Reading the list…" up for the rest of the day.
        if (alive) {
          setDeviceRows(null);
          setDeviceError(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [showsPairedDevices, trustUrl, token]);

  /** The button under the failure message. */
  async function rereadDevices(): Promise<void> {
    if (!trustUrl) return;
    setReadingDevices(true);
    try {
      // The message stays up while the retry runs: swapping it for "Reading the
      // list…" would look like progress the laptop is not making.
      setDeviceRows(await new SyncClient(trustUrl, token, 'laptop').pairedDevices());
      setDeviceError(false);
    } catch {
      setDeviceRows(null);
      setDeviceError(true);
    } finally {
      setReadingDevices(false);
    }
  }

  async function revokePairedDevice(id: string, label: string): Promise<void> {
    if (!trustUrl) return;
    setRevoking(id);
    setRevokeNote(null);
    const client = new SyncClient(trustUrl, token, 'laptop');
    try {
      await client.revokeDevice(id);
      setDeviceRows(await client.pairedDevices());
      setRevokeNote(
        `${label} can no longer sync. Its notes stay on it, and everything it already sent stays here; pair it again to let it back in.`,
      );
    } catch (error) {
      setRevokeNote(error instanceof Error ? error.message : 'The laptop did not answer.');
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScreenHeader
        title="Sync"
        subtitle={CONNECTION_LABELS[connection]}
        onBack={() => navigate('/')}
        actions={
          paired ? (
            <Button variant="secondary" onClick={() => void handleSync()} disabled={syncing}>
              {syncing ? <Spinner /> : <RefreshCw size={15} strokeWidth={1.9} />}
              Sync now
            </Button>
          ) : undefined
        }
      />

      <div className="scroll-pane thin-scroll safe-px mx-auto w-full max-w-3xl min-h-0 flex-1 space-y-4 pb-[max(2rem,var(--safe-bottom))] pt-5">
        {laptopServerMissing && (
          <section className="rounded-xl border border-danger/30 bg-danger/5 p-4">
            <div className="flex items-center gap-1.5 text-[11.5px] uppercase tracking-wide text-danger">
              <CloudOff size={13} strokeWidth={1.9} /> Searching for your laptop…
            </div>
            <h2 className="mt-1 font-serif text-[19px] text-ink">Your notes are on the laptop, and it is switched off</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
              This page is the published copy of the app, so it keeps no notes of its own: it reads them from your
              laptop at <span className="break-all font-mono text-[11.5px]">{laptopAppUrl}</span>, which is not
              running right now.
            </p>
            <ol className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-ink-soft">
              <li className="flex gap-2">
                <span className={stepBadge(false)}>1</span>
                <div className="min-w-0 flex-1">
                  On the laptop, open the NŌTA folder and double-click{' '}
                  <span className="text-ink">run.bat</span>. It starts the server and opens the pairing page.
                </div>
              </li>
              <li className="flex gap-2">
                <span className={stepBadge(false)}>2</span>
                <div className="min-w-0 flex-1">
                  Keep the minimised <span className="text-ink">“NŌTA server”</span> window open: closing it
                  stops the server.
                </div>
              </li>
              <li className="flex gap-2">
                <span className={stepBadge(false)}>3</span>
                <div className="min-w-0 flex-1">
                  Come back here and press <span className="text-ink">Check again</span>: this page connects by itself
                  and pulls your notes.
                </div>
              </li>
            </ol>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void recheckServer()} disabled={rechecking}>
                {rechecking ? <Spinner /> : <RefreshCw size={15} strokeWidth={1.9} />}
                Check again
              </Button>
              <Button
                variant="secondary"
                onClick={() => window.open(`${laptopAppUrl}/`, '_blank', 'noopener')}
              >
                <ExternalLink size={14} strokeWidth={1.9} /> Open the laptop app
              </Button>
              <Button variant="ghost" onClick={() => setManual(true)}>
                Pair with a code instead
              </Button>
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-muted">
              Nothing is lost: your notes stay in the laptop's notes folder, and this page copies them back as soon as
              Nota answers again.
            </p>
          </section>
        )}

        {canUseLaptopApp && !laptopServerMissing && (
          <section className="rounded-xl border border-accent/30 bg-accent-soft p-4">
            <div className="flex items-center gap-1.5 text-[11.5px] uppercase tracking-wide text-accent-strong">
              <Laptop size={13} strokeWidth={1.9} /> You are on the laptop
            </div>
            <h2 className="mt-1 font-serif text-[19px] text-ink">Edit here, or open the laptop app</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
              This page is the published copy. The laptop app runs from your own server at{' '}
              <span className="break-all font-mono text-[11.5px]">{laptopAppUrl}/</span>, writes straight into the
              laptop storage and needs no certificate.
            </p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
              {!paired
                ? `Server not reached yet: start the server window on the laptop, then reload this page. It connects to ${laptopAppUrl} by itself and pulls your notes.`
                : destination
                  ? `Paired with ${destination.deviceName} and reachable — this page syncs in both directions.`
                  : `Paired with ${serverUrl}, but the server is not answering right now: start the server window on the laptop, then press Sync now.`}
            </p>
            <div className="mt-3">
              <Button variant="primary" onClick={() => window.open(`${laptopAppUrl}/`, '_blank', 'noopener')}>
                <ExternalLink size={14} strokeWidth={1.9} /> Open the laptop app
              </Button>
            </div>
          </section>
        )}

        {confirmCode && (
          <div className="rounded-xl border border-accent/30 bg-accent-soft p-4">
            <div className="text-[11.5px] uppercase tracking-wide text-accent-strong">Confirmation code</div>
            <p className="mt-1 font-mono text-[26px] tracking-[0.35em] text-ink">{confirmCode}</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
              The laptop shows these five characters next to its QR code. If they differ, the two did not share one
              secret: stop and scan a fresh code on the laptop.
            </p>
          </div>
        )}
        {notice && (
          <div className="flex items-start gap-2 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-[12.5px] leading-relaxed text-accent-strong">
            <Check size={15} strokeWidth={2} className="mt-0.5 shrink-0" />
            <span>{notice}</span>
          </div>
        )}
        {/* The recovery box below the button says the same thing and adds the two
            actions, so it replaces the plain error line instead of stacking on it. */}
        {error && findFailure !== 'unreachable' && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12.5px] leading-relaxed text-danger">
            {error}
          </div>
        )}

        {paired && !editing ? (
          <section className="rounded-xl border border-line bg-paper-raised p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[11.5px] uppercase tracking-wide text-ink-muted">
                  <Laptop size={13} strokeWidth={1.9} /> Destination
                </div>
                <h2 className="mt-1 truncate font-serif text-[20px] text-ink">
                  {destination?.deviceName ?? 'Your laptop'}
                </h2>
                <p className="truncate text-[12.5px] text-ink-muted">{serverUrl}</p>
              </div>
              <span
                className={cx(
                  'mt-1 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px]',
                  destination ? 'bg-accent-soft text-accent-strong' : 'bg-danger/10 text-danger',
                )}
              >
                {destination ? <Check size={12} strokeWidth={2.2} /> : <CloudOff size={12} strokeWidth={2.2} />}
                {destination ? 'reachable' : status.revoked ? 'refusing this device' : 'offline'}
              </span>
            </div>

            <dl className="mt-4 space-y-2.5 border-t border-line pt-3 text-[12.5px]">
              <div className="flex items-start gap-2">
                <dt className="w-[104px] shrink-0 text-ink-muted">Notes folder</dt>
                <dd className="min-w-0 flex-1 break-all font-mono text-[11.5px] text-ink-soft">
                  {destination?.dataDir ??
                    (status.revoked
                      ? 'Still there: the laptop is answering, it just no longer accepts this device.'
                      : 'Start the server on the laptop to read it')}
                </dd>
              </div>
              <div className="flex items-start gap-2">
                <dt className="w-[104px] shrink-0 text-ink-muted">Stored there</dt>
                <dd className="min-w-0 flex-1 text-ink-soft">
                  {destination
                    ? `${destination.counts.notebook ?? 0} notebooks · ${destination.counts.page ?? 0} pages · ${destination.counts.stroke ?? 0} strokes`
                    : '—'}
                </dd>
              </div>
              <div className="flex items-start gap-2">
                <dt className="w-[104px] shrink-0 text-ink-muted">Conflicts there</dt>
                <dd className="min-w-0 flex-1 text-ink-soft">
                  {destination
                    ? destination.conflicts > 0
                      ? `${destination.conflicts} kept on the laptop — both copies are stored there`
                      : 'none'
                    : '—'}
                </dd>
              </div>
              <div className="flex items-start gap-2">
                <dt className="w-[104px] shrink-0 text-ink-muted">Credentials</dt>
                <dd className="min-w-0 flex-1">
                  <span className="break-all font-mono text-[11.5px] text-ink-soft">
                    {showToken ? token : maskToken(token)}
                  </span>
                  <button
                    type="button"
                    className="ml-2 inline-flex items-center gap-1 text-[11.5px] text-accent"
                    onClick={() => setShowToken((value) => !value)}
                  >
                    {showToken ? <EyeOff size={13} strokeWidth={1.9} /> : <Eye size={13} strokeWidth={1.9} />}
                    {showToken ? 'Hide' : 'Show'}
                  </button>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                    Saved in this {device}'s own browser database only: never in the site, the repository or the URL.
                    {canUseLaptopApp && ' The laptop app writes straight to the laptop storage.'}
                  </p>
                </dd>
              </div>
            </dl>

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <Button variant="primary" onClick={() => void handleSync()} disabled={syncing}>
                {syncing ? <Spinner /> : <RefreshCw size={15} strokeWidth={1.9} />}
                Sync now
              </Button>
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {status.revoked ? 'Pair again' : 'Change laptop'}
              </Button>
              <Button variant="ghost" className="text-danger" onClick={() => void handleForget()}>
                Forget this laptop
              </Button>
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[11.5px] text-ink-muted">
              <span
                className={cx(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
                  connection === 'attention'
                    ? 'bg-danger/10 text-danger'
                    : connection === 'connected'
                      ? 'bg-accent-soft text-accent-strong'
                      : 'bg-paper-sunken text-ink-soft',
                )}
              >
                {connection === 'connected' ? (
                  <Check size={11} strokeWidth={2.4} />
                ) : connection === 'attention' ? (
                  <AlertTriangle size={11} strokeWidth={2.2} />
                ) : (
                  <CloudOff size={11} strokeWidth={2.2} />
                )}
                {CONNECTION_LABELS[connection]}
              </span>
              <span>· {status.pending} change{status.pending === 1 ? '' : 's'} saved</span>
            </p>
            {pendingSummary && (
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">Waiting to send: {pendingSummary}</p>
            )}
            {status.stuck > 0 && (
              <p className="mt-1 text-[11.5px] leading-relaxed text-danger">
                Held back ({status.stuck}) — {status.stuckNote} The rest still syncs; editing it again sends
                the new version.
              </p>
            )}
            {status.revoked && (
              <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3">
                <p className="flex items-center gap-1.5 text-[12.5px] text-danger">
                  <AlertTriangle size={13} strokeWidth={2.2} /> This {device} was removed on the laptop
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                  Nothing was deleted: its notes are here, and everything it already sent is on the laptop. To let it
                  back in, pair it again — the laptop lists it as waiting, press{' '}
                  <span className="text-ink">Allow</span> once.
                </p>
                <Button
                  variant="primary"
                  className="mt-2 h-9 text-[12.5px]"
                  onClick={() => {
                    setError(null);
                    setEditing(true);
                  }}
                >
                  Pair again
                </Button>
              </div>
            )}
            {!error && !status.revoked && status.phase === 'error' && status.message && (
              <p className="mt-1 text-[11.5px] leading-relaxed text-danger">{status.message}</p>
            )}
            <Toggle
              checked={autoSync}
              onChange={async (value) => {
                setAutoSync(value);
                await saveSyncConfig({ autoSync: value });
              }}
              label="Sync automatically"
              description="Checks every 45 seconds, and waits longer between attempts while the laptop stays away."
            />
          </section>
        ) : null}

        {showsPairedDevices && (
          <section className="rounded-xl border border-line bg-paper-raised p-4">
            <h2 className="font-serif text-[17px] text-ink">Paired devices</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
              Every device that has been allowed in. Revoking one stops it syncing straight away; its notes stay on
              it, and everything it already sent stays here.
            </p>
            {deviceError ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-[13px] text-ink-faint">The laptop did not answer.</p>
                <Button
                  variant="secondary"
                  className="h-8 px-2.5 text-[12px]"
                  onClick={() => void rereadDevices()}
                  disabled={readingDevices}
                >
                  {readingDevices ? <Spinner /> : <RefreshCw size={13} strokeWidth={2} />}
                  Try again
                </Button>
              </div>
            ) : activeDevices.length === 0 ? (
              <p className="mt-3 text-[13px] text-ink-faint">
                {deviceRows === null ? 'Reading the list…' : 'No device is paired yet.'}
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {activeDevices.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] text-ink">{entry.label || 'A device'}</div>
                      <div className="text-[11.5px] text-ink-muted">
                        {entry.address || 'address unknown'} · paired {pairedOn(entry.createdAt)}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      className="h-8 px-2.5 text-[12px] text-danger"
                      disabled={revoking === entry.id}
                      onClick={() => void revokePairedDevice(entry.id, entry.label || 'That device')}
                    >
                      {revoking === entry.id ? <Spinner /> : <X size={13} strokeWidth={2.2} />}
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {revokeNote && (
              <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">{revokeNote}</p>
            )}
          </section>
        )}

        {showPairForm && (
          <section className="rounded-xl border border-line bg-paper-raised p-4">
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-serif text-[19px] text-ink">
                {sameOrigin ? 'Connect to your laptop' : `Set up this ${device}`}
              </h2>
              {manual && laptopServerMissing && (
                <Button
                  variant="ghost"
                  className="-mr-1 -mt-1 h-8 px-2 text-[12.5px]"
                  aria-label="Close the pairing form"
                  onClick={() => {
                    setManual(false);
                    setProbe(null);
                    setTestResult(null);
                    setError(null);
                  }}
                >
                  <X size={14} strokeWidth={2} /> Close
                </Button>
              )}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
              {sameOrigin
                ? 'Press the button, then press Allow once on the laptop. Nothing to type, nothing to scan.'
                : 'The laptop approves this device once. After that the two keep each other in step on their own.'}
            </p>

            {/* The one action that finishes the job, at the size it deserves.
                Only when the app came from the laptop: on an older published copy
                the profile has to be trusted first, so the numbered list below is
                the honest path and it opens by itself. */}
            {sameOrigin && (
            <div className="mt-4">
              <Button
                variant="primary"
                className="h-12 w-full text-[15px]"
                onClick={() => void handleFind()}
                disabled={finding || pairing || !trustUrl}
              >
                {finding ? <Spinner /> : <Laptop size={17} strokeWidth={1.9} />}
                {finding ? 'Waiting for your laptop…' : 'Connect to my laptop'}
              </Button>
              <p className="mt-2 text-center text-[12.5px] leading-relaxed text-ink-muted">
                {finding ? (
                  <>
                    The laptop now lists this {device === 'iPad' ? 'iPad' : 'computer'} as waiting: press{' '}
                    <span className="text-ink">Allow</span> there and this screen finishes by itself.
                  </>
                ) : (
                  <>
                    The laptop asks you to confirm once — it shows this{' '}
                    {device === 'iPad' ? 'iPad' : 'computer'}, you press{' '}
                    <span className="text-ink">Allow</span>.
                  </>
                )}
              </p>
              {finding && (
                <div className="mt-1 text-center">
                  <Button
                    variant="ghost"
                    className="h-8 text-[12.5px]"
                    onClick={() => {
                      cancelFind.current = true;
                      setFinding(false);
                    }}
                  >
                    Stop waiting
                  </Button>
                </div>
              )}
              {findFailure === 'unreachable' && (
                <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-3">
                  <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-danger">
                    <AlertTriangle size={14} strokeWidth={2} /> The laptop did not answer
                  </p>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
                    Two causes, in this order: the NŌTA server is not running on the laptop, or this iPad has not
                    installed the certificate yet — Safari then stops the request before it leaves the iPad. The
                    setup page takes care of the second one.
                  </p>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
                    On the laptop: double-click <span className="text-ink">run.bat</span> and keep the “NŌTA server”
                    window open.
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      className="h-9 text-[12.5px]"
                      onClick={() => openSetup()}
                      disabled={!trustUrl}
                    >
                      <ExternalLink size={14} strokeWidth={1.9} /> Open the setup page
                    </Button>
                    <Button
                      variant="secondary"
                      className="h-9 text-[12.5px]"
                      onClick={() => void handleFind()}
                      disabled={finding}
                    >
                      <RefreshCw size={14} strokeWidth={1.9} /> Try again
                    </Button>
                  </div>
                  {trustUrl && <p className="mt-2 break-all text-[11.5px] text-ink-muted">{trustUrl}/setup</p>}
                </div>
              )}
            </div>
            )}

            <details
              className="mt-4 rounded-lg bg-paper-sunken px-3 py-2 text-[12.5px] text-ink-soft"
              open={!sameOrigin}
            >
              <summary className="cursor-pointer select-none">Other ways to connect</summary>

            <div className="mt-3 space-y-3">
              <Field
                label="Laptop address"
                hint="Filled in with the name the laptop advertises on your network. Replace it with the address in the server window if your network blocks names like that."
              >
                <TextInput
                  value={serverUrl}
                  onChange={(event) => {
                    setServerUrl(event.target.value);
                    setProbe(null);
                  }}
                  placeholder="https://192.168.1.20:8443"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </Field>
              {sameOrigin && (
                <Button
                  variant="secondary"
                  className="h-9 text-[12.5px]"
                  onClick={() => {
                    setServerUrl(window.location.origin);
                    setProbe(null);
                  }}
                >
                  Use this laptop ({window.location.host})
                </Button>
              )}
            </div>

            <ol className="mt-5 space-y-4">
              {/* The certificate only exists for the iPad; the laptop needs none. */}
              {device === 'iPad' && !sameOrigin && (
              <li className="flex gap-3">
                <span className={stepBadge(Boolean(probe?.ok))}>1</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[14px] text-ink">Trust your laptop</h3>
                    {probe?.ok && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent-strong">
                        <Check size={11} strokeWidth={2.4} /> trusted
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">
                    Open the setup page on this iPad and tap <span className="text-ink">Download the profile</span>.
                    Install it under Settings → General → VPN &amp; Device Management, then switch it on under
                    Settings → General → About → Certificate Trust Settings.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      className="h-9 text-[12.5px]"
                      onClick={() => openSetup()}
                      disabled={!trustUrl}
                    >
                      <ExternalLink size={14} strokeWidth={1.9} /> Open setup page
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-9 text-[12.5px]"
                      onClick={() => void checkLaptop()}
                      disabled={checking}
                    >
                      {checking ? <Spinner /> : null} Check again
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-9 text-[12.5px]"
                      onClick={() => void handleTest()}
                      disabled={testing}
                    >
                      {testing ? <Spinner /> : null} Test connection
                    </Button>
                  </div>
                  {probe && (
                    <p
                      className={cx(
                        'mt-2 text-[12px] leading-relaxed',
                        probe.ok ? 'text-accent-strong' : 'text-ink-muted',
                      )}
                    >
                      {probe.message}
                    </p>
                  )}
                  {testResult && (
                    <p className={cx('mt-1 text-[12px]', testResult.ok ? 'text-accent-strong' : 'text-danger')}>
                      {testResult.message}
                    </p>
                  )}
                </div>
              </li>

              )}
              <li className="flex gap-3">
                <span className={stepBadge(paired)}>{device === 'iPad' && !sameOrigin ? 2 : 1}</span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14px] text-ink">Or scan the code on the laptop</h3>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">
                    On the laptop's pairing page, open <span className="text-ink">Show the QR code</span> and point
                    the iPad camera at it. That link opens this app, pairs by itself, then shows five characters to
                    compare with the laptop's screen. This is the way in when the app came from somewhere other than
                    this laptop.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className={stepBadge(paired)}>{device === 'iPad' && !sameOrigin ? 3 : 2}</span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14px] text-ink">Only for an older copy of the app</h3>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">
                    A copy installed before the QR code existed asks for six characters. They still work: they are on
                    the laptop's pairing page and change every thirty minutes. Nothing else needs them.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <div className="w-[168px]">
                      <TextInput
                        value={code}
                        onChange={(event) => setCode(cleanCode(event.target.value))}
                        placeholder="AB12CD"
                        inputMode="text"
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                        className="text-center font-mono text-[18px] tracking-[0.35em]"
                      />
                    </div>
                    <Button
                      variant="primary"
                      onClick={() => void handlePair()}
                      disabled={pairing || code.length !== 6 || !serverUrl.trim()}
                    >
                      {pairing ? <Spinner /> : null} Pair
                    </Button>
                    {editing && (
                      <Button variant="ghost" onClick={() => setEditing(false)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                  <p className="mt-1 text-[11.5px] text-ink-faint">
                    The previous six characters stay valid for one window after they rotate.
                  </p>
                </div>
              </li>
            </ol>

            <details className="mt-4 rounded-lg bg-paper-sunken px-3 py-2 text-[12.5px] text-ink-soft">
              <summary className="cursor-pointer select-none">Use a pairing token instead</summary>
              <div className="mt-2 space-y-2">
                <TextInput
                  value={token}
                  onChange={(event) => setToken(event.target.value.trim())}
                  placeholder="Token from backend\storage\pairing-token.txt"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono text-[13px]"
                />
                <Button variant="secondary" className="h-9 text-[12.5px]" onClick={() => void handleTokenPair()}>
                  Save token
                </Button>
              </div>
            </details>
            </details>
          </section>
        )}

        <section className="rounded-xl border border-line bg-paper-raised p-4">
          <h2 className="font-serif text-[17px] text-ink">Conflicts</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
            When the same object changed on both devices, both versions are preserved. Choose which one becomes the
            canonical copy.
          </p>
          {(conflicts ?? []).length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-faint">No conflicts recorded.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {(conflicts ?? []).map((conflict) => (
                <li key={conflict.seq} className="flex flex-wrap items-center gap-3 py-3">
                  <AlertTriangle size={16} strokeWidth={1.8} className="text-danger" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] text-ink">{conflict.label}</div>
                    <div className="text-[11.5px] text-ink-muted">
                      {conflict.kind} · recorded {relativeTime(conflict.createdAt)} · this {device} edited{' '}
                      {editedWhen(conflict.local)} · the laptop {editedWhen(conflict.server)}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      variant="secondary"
                      className="h-8 px-2.5 text-[12px]"
                      onClick={() => void resolveConflict(conflict.seq!, 'keep-local').then(refreshCounters)}
                    >
                      Keep this {device}
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-8 px-2.5 text-[12px]"
                      onClick={() => void resolveConflict(conflict.seq!, 'keep-server').then(refreshCounters)}
                    >
                      Keep laptop
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <details className="rounded-xl border border-line bg-paper-sunken p-4 text-[12.5px] leading-relaxed text-ink-soft">
          <summary className="flex cursor-pointer select-none items-center gap-2 font-serif text-[16px] text-ink">
            <Wrench size={16} strokeWidth={1.8} /> Advanced diagnostics
          </summary>
          <dl className="mt-3 space-y-2">
            {diagRow('Status', CONNECTION_LABELS[connection])}
            {diagRow('Server identity', destination?.serverId ? destination.serverId.slice(0, 16) : 'not known yet', true)}
            {diagRow('Current address', serverUrl || '—', true)}
            {diagRow(
              'Advertised name',
              destination?.hostname || (destination?.mdns === false ? 'none · trusted address' : MDNS_HOST),
              true,
            )}
            {diagRow(
              'Advertised port',
              destination?.mdnsUrl || (destination?.mdns === false ? 'none' : 'not known yet'),
              true,
            )}
            {diagRow('Network address', destination?.baseUrl ?? '—', true)}
            {diagRow(
              'Discovery',
              destination?.discovery
                ? `${destination.discovery.state}${destination.discovery.addresses?.length ? ` · ${destination.discovery.addresses.join(', ')}` : ''}`
                : 'no answer yet',
            )}
            {diagRow('Queued changes', pendingSummary || 'none')}
            {diagRow('Last sync', relativeTime(status.lastSyncAt))}
          </dl>
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-muted">
            {destination?.mdns === false
              ? 'This laptop is published on a trusted address, so it advertises no local name: the iPad goes straight to the last address that answered, then the address saved at pairing.'
              : `The iPad asks for ${MDNS_HOST} first, then the last address that answered, then the address saved at pairing.`}{' '}
            Nothing here needs editing; it is only shown so a problem can be described precisely.
          </p>
        </details>

        <details className="rounded-xl border border-line bg-paper-sunken p-4 text-[12.5px] leading-relaxed text-ink-soft">
          <summary className="flex cursor-pointer select-none items-center gap-2 font-serif text-[16px] text-ink">
            <ShieldCheck size={16} strokeWidth={1.8} /> Why only the iPad needs a certificate
          </summary>
          <p className="mt-2">
            The iPad loads this app from the laptop itself, over HTTPS, so the page and the API share one origin:
            no stale published copy, no cross-origin request, no mixed content. Because the laptop signs its own
            certificate, Safari warns once until the profile vouches for it.
          </p>
          <p className="mt-2">
            On the laptop nothing is installed at all: the app opens at <code>http://localhost:8080</code> and talks to
            the server over the machine's own loopback, where no certificate is involved and the browser never warns.
          </p>
          <p className="mt-2">
            The profile does only that — it vouches for your own laptop. It never leaves the two devices, the
            signing key stays on the laptop, and a new network address renews the certificate without a second profile.
            You only reinstall it if you change laptops.
          </p>
        </details>

        <p className="text-center text-[11.5px] text-ink-faint">
          Notes stay in {destination?.dataDir ?? 'the laptop folder you paired with'} · nothing is uploaded to GitHub.
        </p>
      </div>
    </div>
  );
}
