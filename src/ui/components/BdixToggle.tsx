import { useState } from 'preact/hooks'
import { bdixDiscovery } from '../../state/settings'
import { Switch } from './Controls'
import { InfoIcon } from './Icons'

/** Opt-in switch for BDIX discovery, with an inline explanation behind the info icon. `flat` drops the card for use inside a panel. */
export function BdixToggle({ flat = false }: { flat?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <section class={flat ? 'bdix bdix--flat' : 'card card--pad bdix'}>
      <div class="bdix-row">
        <span class="row-text">
          <span class="bdix-title">
            <span class="row-title">BDIX discovery</span>
            <button
              type="button"
              class="bdix-info"
              aria-label="What does this do?"
              aria-expanded={open}
              aria-controls="bdix-explain"
              onClick={() => setOpen(!open)}
            >
              <InfoIcon size={16} />
            </button>
          </span>
          <span class="row-sub">Can’t see a device? Try this.</span>
        </span>
        <Switch checked={bdixDiscovery.value} onChange={(v) => (bdixDiscovery.value = v)} label="BDIX discovery" />
      </div>
      {open && (
        <p id="bdix-explain" class="bdix-explain">
          Some Bangladeshi networks show your devices under a different public IP address depending on where they are
          reaching. With this on, fastbeam also asks one small page on a BDIX-hosted server which address it sees you
          from, and uses that to find nearby devices.
          <br />
          <br />
          The page receives your IP address (as any website does) and stores nothing. No files or names are sent. Turn it
          on for both devices. While it is off, nothing is requested.
        </p>
      )}
    </section>
  )
}
