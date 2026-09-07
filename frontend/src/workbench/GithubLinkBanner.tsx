import { useState } from 'react';
import { useGithubLink, startDeviceFlow, pollForToken, DeviceStart } from './sync';
import styles from './Workbench.module.scss';

export function GithubLinkBanner() {
  const linked = useGithubLink();
  const [hidden, setHidden] = useState(false);
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  if (linked || hidden) return null;

  return (
    <div className={styles.linkBanner} role="status">
      {device ? (
        <span>
          enter <strong>{device.user_code}</strong> at{' '}
          <a href={device.verification_uri} target="_blank" rel="noopener noreferrer">
            {device.verification_uri}
          </a>{' '}
          - waiting…
        </span>
      ) : (
        <span>
          Want to share reviews or save your data to GitHub?{' '}
          <button
            type="button"
            className={styles.linkNow}
            onClick={async () => {
              try {
                setStatus(null);
                const d = await startDeviceFlow();
                setDevice(d);
                pollForToken(d).catch((e) => {
                  setDevice(null);
                  setStatus(`✗ ${(e as Error).message}`);
                });
              } catch (e) {
                setStatus(`✗ ${(e as Error).message}`);
              }
            }}
          >
            Link now
          </button>
          {status && <span className={styles.linkStatus}> {status}</span>}
        </span>
      )}
      <button type="button" className={styles.linkDismiss} aria-label="dismiss" onClick={() => setHidden(true)}>
        ✕
      </button>
    </div>
  );
}
