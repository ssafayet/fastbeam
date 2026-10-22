import { useState } from 'preact/hooks'
import { bdixDiscovery } from '../../state/settings'
import { Switch } from './Controls'
import { InfoIcon } from './Icons'

/** Opt-in switch for BDIX discovery, with an inline explanation behind the info icon. */
export function BdixToggle() {
  const [open, setOpen] = useState(false)
  return (
    <section class="card card--pad bdix">
      <div class="row" style={{ minHeight: 44, borderBottom: 0 }}>
        <span class="row-text">
          <span class="row-title">Try advanced BDIX discovery</span>
          <span class="row-sub">For devices that don’t find each other</span>
        </span>
        <button
          type="button"
          class="iconbtn bdix-info"
          aria-label="What does this do?"
          aria-expanded={open}
          aria-controls="bdix-explain"
          onClick={() => setOpen(!open)}
        >
          <InfoIcon />
        </button>
        <Switch checked={bdixDiscovery.value} onChange={(v) => (bdixDiscovery.value = v)} label="Try advanced BDIX discovery" />
      </div>
      {open && (
        <p id="bdix-explain" class="row-sub bdix-explain">
          Some Bangladeshi networks show your devices under a different public IP address depending on where they are
          reaching. fastbeam normally finds nearby devices by that address. With this on, it also asks one small page on a
          BDIX-hosted server which address it sees you from, and uses that as another way to find nearby devices. The
          page receives your IP address (as any website does), stores and logs nothing, and no files or names are sent.
          Both devices need it on. Off by default; while off, nothing is requested.
        </p>
      )}
    </section>
  )
}
