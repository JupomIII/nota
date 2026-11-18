import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Database, Fingerprint, HardDrive, Info, ShieldCheck } from 'lucide-react';
import { db } from '../storage/db';
import type { AppSettings } from '../storage/types';
import { getDeviceId, getSettings, saveSettings } from '../storage/repo';
import { loadSyncConfig, refreshCounters } from '../sync/engine';
import { thisDevice } from '../lib/device';
import { formatBytes } from '../lib/download';
import { navigate } from '../app/router';
import { Button, ScreenHeader, Segmented, TextInput, Toggle, cx } from './ui';
import { applyTheme, type ThemeName } from '../lib/theme';

const GRID_MIN = 8;
const GRID_MAX = 200;

/**
 * A saved number cannot be edited directly: typing "1" on the way to "12" fails
 * the range check and the field snaps back, so the draft lives here and only
 * reaches storage on Enter or blur. Anything outside the range reverts.
 */
function GridSpacingField({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit(): void {
    const parsed = Math.round(Number(draft));
    if (!draft.trim() || !Number.isFinite(parsed) || parsed < GRID_MIN || parsed > GRID_MAX) {
      setDraft(String(value));
      return;
    }
    setDraft(String(parsed));
    if (parsed !== value) onCommit(parsed);
  }

  return (
    <TextInput
      value={draft}
      inputMode="numeric"
      aria-label="Grid spacing in pixels"
      className="h-9 text-[13px]"
      onChange={(event) => setDraft(event.target.value.replace(/\D/g, '').slice(0, 3))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(String(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function SettingsScreen() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [autoSync, setAutoSync] = useState(true);
  const [serverUrl, setServerUrl] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const counts = useLiveQuery(
    async () => ({
      notebooks: await db.notebooks.count(),
      pages: await db.pages.count(),
      strokes: await db.strokes.count(),
    }),
    [],
  );

  useEffect(() => {
    void (async () => {
      setSettings(await getSettings());
      setDeviceId(await getDeviceId());
      const config = await loadSyncConfig();
      setAutoSync(config.autoSync);
      setServerUrl(config.serverUrl);
      if (navigator.storage) {
        setPersisted(await navigator.storage.persisted());
        const estimate = await navigator.storage.estimate();
        setUsage({ used: estimate.usage ?? 0, quota: estimate.quota ?? 0 });
      }
      await refreshCounters();
    })();
  }, []);

  async function update(patch: Partial<AppSettings>): Promise<void> {
    const next = await saveSettings(patch);
    setSettings(next);
    if (patch.theme) applyTheme(patch.theme as ThemeName);
  }

  async function requestPersistence(): Promise<void> {
    if (!navigator.storage?.persist) {
      setMessage('This browser does not expose persistent storage.');
      return;
    }
    const granted = await navigator.storage.persist();
    setPersisted(granted);
    setMessage(
      granted
        ? 'Storage is persistent. Safari will not evict your notebooks under storage pressure.'
        : 'Safari did not grant persistence. Keep regular backups from the backup screen.',
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScreenHeader title="Settings" onBack={() => navigate('/')} />

      <div className="scroll-pane thin-scroll safe-px mx-auto w-full max-w-3xl min-h-0 flex-1 space-y-4 pb-[max(2rem,var(--safe-bottom))] pt-5">
        {message && (
          <div className="rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-[12.5px] text-accent-strong">
            {message}
          </div>
        )}

        <section className="rounded-xl border border-line bg-paper-raised p-4">
          <h2 className="font-serif text-[17px] text-ink">Appearance</h2>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Segmented
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              value={settings?.theme ?? 'system'}
              onChange={(value) => void update({ theme: value })}
            />
            <span className="text-[12px] text-ink-muted">
              Paper stays white so exported pages print as written.
            </span>
          </div>
        </section>

        <section className="rounded-xl border border-line bg-paper-raised p-4">
          <h2 className="font-serif text-[17px] text-ink">Writing</h2>
          <div className="mt-1 divide-y divide-line">
            <Toggle
              checked={settings?.oneFingerPan ?? true}
              onChange={(value) => void update({ oneFingerPan: value })}
              label="Pan with one finger"
              description="A single finger scrolls the page; only Apple Pencil draws."
            />
            <Toggle
              checked={settings?.twoFingerErase ?? true}
              onChange={(value) => void update({ twoFingerErase: value })}
              label="Rub to erase"
              description="Two fingers rubbed over ink erase what they cross, one undo step per rub. A two-finger sweep that touches no ink still scrolls the page."
            />
            <Toggle
              checked={settings?.palmRejection ?? true}
              onChange={(value) => void update({ palmRejection: value })}
              label="Palm rejection"
              description="Ignores touch while the Apple Pencil is down and for a moment after it lifts, so a resting hand cannot scroll or zoom the page."
            />
            <Toggle
              checked={settings?.scribbleToErase ?? true}
              onChange={(value) => void update({ scribbleToErase: value })}
              label="Scribble to erase"
              description="Scribble back and forth over ink with a pen and it disappears, without switching to the eraser."
            />
            <Toggle
              checked={settings?.holdToSnap ?? false}
              onChange={(value) => void update({ holdToSnap: value })}
              label="Hold to straighten"
              description="Rest the pencil at the end of a stroke and it straightens into a line. Leave it off and the line you draw is the line you keep."
            />
            <Toggle
              checked={settings?.showPageBoundary ?? true}
              onChange={(value) => void update({ showPageBoundary: value })}
              label="Show page boundary"
              description="Draws a hairline around the sheet; turn off for a borderless page."
            />
            <Toggle
              checked={settings?.snapEnabled ?? false}
              onChange={(value) => void update({ snapEnabled: value })}
              label="Snap geometry tools"
              description="Shapes snap to the grid and lines snap to 15° steps."
            />
            <Toggle
              checked={settings?.recognizeShapes ?? true}
              onChange={(value) => void update({ recognizeShapes: value })}
              label="Suggest clean shapes"
              description="After a freehand circle, line or rectangle the page offers to replace it. Ink is never changed without your tap."
            />
            <div className="flex flex-wrap items-end justify-between gap-3 py-3">
              <div>
                <div className="text-[15px] text-ink">Grid spacing</div>
                <div className="mt-0.5 text-[12.5px] text-ink-muted">
                  Default spacing for new grid, graph and engineering pages.
                </div>
              </div>
              <div className="w-24">
                <GridSpacingField
                  value={settings?.gridSpacing ?? 36}
                  onCommit={(value) => void update({ gridSpacing: value })}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-line bg-paper-raised p-4">
          <h2 className="font-serif text-[17px] text-ink">Performance</h2>
          <div className="mt-1 divide-y divide-line">
            <Toggle
              checked={settings?.showPerformanceHud ?? false}
              onChange={(value) => void update({ showPerformanceHud: value })}
              label="Show frame readout"
              description="Draws a small readout on the page: frames per second, the worst frame of the last second, the cost of the last repaint and how many strokes it drew. Measured from real frame callbacks; leave it on for a session to see how the page actually behaves."
            />
          </div>
        </section>

        <section className="rounded-xl border border-line bg-paper-raised p-4">
          <h2 className="font-serif text-[17px] text-ink">Gestures on iPad</h2>
          <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-ink-soft">
            <li>
              <span className="text-ink">Two-finger tap</span> undoes; keep two fingers down and it keeps undoing.
            </li>
            <li>
              <span className="text-ink">Three-finger tap</span> redoes; keep three fingers down and it keeps redoing.
            </li>
            <li>
              <span className="text-ink">Pinch</span> zooms, one finger pans, the Apple Pencil always draws and is
              never mistaken for a finger.
            </li>
            <li>
              <span className="text-ink">Scribble</span> back and forth over ink with a pen to erase what it crosses.
            </li>
            <li>
              <span className="text-ink">Rest the pen</span> at the end of a stroke to straighten it into a line.
            </li>
          </ul>
        </section>

        <section className="rounded-xl border border-line bg-paper-raised p-4">
          <h2 className="font-serif text-[17px] text-ink">Storage</h2>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-paper-sunken p-3">
              <div className="flex items-center gap-2 text-[12px] uppercase tracking-wide text-ink-muted">
                <HardDrive size={14} strokeWidth={1.8} /> Used
              </div>
              <div className="mt-1 font-serif text-[19px] text-ink">{usage ? formatBytes(usage.used) : '…'}</div>
              <div className="text-[11.5px] text-ink-muted">
                of {usage ? formatBytes(usage.quota) : '…'} available
              </div>
            </div>
            <div className="rounded-lg bg-paper-sunken p-3">
              <div className="flex items-center gap-2 text-[12px] uppercase tracking-wide text-ink-muted">
                <Database size={14} strokeWidth={1.8} /> Content
              </div>
              <div className="mt-1 font-serif text-[19px] text-ink">{counts?.strokes ?? 0} strokes</div>
              <div className="text-[11.5px] text-ink-muted">
                {counts?.notebooks ?? 0} notebooks · {counts?.pages ?? 0} pages
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant={persisted ? 'secondary' : 'primary'}
              icon={<ShieldCheck size={16} strokeWidth={1.8} />}
              onClick={() => void requestPersistence()}
            >
              {persisted ? 'Persistent storage granted' : 'Request persistent storage'}
            </Button>
            <Button variant="ghost" onClick={() => navigate('/backup')}>
              Backups
            </Button>
          </div>
          {persisted === false && (
            <p className="mt-2 text-[12px] text-ink-muted">
              Without persistence, iPadOS may clear the site's data if storage runs low. Export a backup weekly.
            </p>
          )}
        </section>

        <section className="rounded-xl border border-line bg-paper-raised p-4">
          <h2 className="font-serif text-[17px] text-ink">Sync</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
            {serverUrl && autoSync
              ? `Paired with ${serverUrl}. Open Sync for the destination, automatic sync and conflicts.`
              : `Not paired yet. Open Sync to pair once with your laptop; the token stays in this ${thisDevice()}\u2019s own database and never appears in the site.`}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => navigate('/sync')}>
              Pairing and destination
            </Button>
          </div>
        </section>

        <section className="rounded-xl border border-line bg-paper-raised p-4">
          <h2 className="font-serif text-[17px] text-ink">This device</h2>
          <div className="mt-2 space-y-2 text-[12.5px] text-ink-muted">
            <div className="flex items-center gap-2">
              <Fingerprint size={15} strokeWidth={1.8} />
              <span className="font-mono text-[11.5px] break-all">{deviceId || '…'}</span>
            </div>
            <p>
              Device id is used for deterministic conflict tie-breaks. It is generated once and never shared outside
              your own devices.
            </p>
          </div>
        </section>

        <section className={cx('rounded-xl border border-line bg-paper-sunken p-4 text-[12.5px] leading-relaxed text-ink-soft')}>
          <h2 className="flex items-center gap-2 font-serif text-[16px] text-ink">
            <Info size={16} strokeWidth={1.8} /> Known limits on iPadOS
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>
              Safari exposes <code>pointerType</code>, pressure and tilt to web apps, but not the pencil's azimuth or
              hover distance. Tilt is mapped to nib width; azimuth-based shading is not possible.
            </li>
            <li>
              Pinch-zoom pauses for a moment after the Apple Pencil lifts, so a resting hand cannot zoom the page
              mid-word. Turn palm rejection off in Writing if you would rather have touch respond immediately.
            </li>
            <li>
              Two-finger rotation is not enabled — it conflicts with pinch zoom during fast writing. Use pinch to zoom
              and one-finger drag to pan.
            </li>
            <li>
              An installed web app cannot call a plain <code>http://</code> address, so the Windows server keeps its
              HTTPS certificate. The iPad setup instructions cover the one-time profile install.
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
