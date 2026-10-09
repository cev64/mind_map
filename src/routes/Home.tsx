import { supabaseConfigured } from '../lib/supabase'

export function Home() {
  return (
    <>
      <header className="mb-6">
        <p className="text-micro font-semibold uppercase text-ink-3">Phase 0</p>
        <h1 className="font-display text-display font-semibold uppercase text-ink">Mind Map</h1>
      </header>

      <section className="glass rounded-card p-5">
        <h2 className="text-card-title font-semibold text-ink">Setup</h2>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-body">
          <dt className="text-ink-2">App</dt>
          <dd className="text-ink">Running</dd>
          <dt className="text-ink-2">Supabase</dt>
          <dd className={supabaseConfigured ? 'text-good' : 'text-warn'}>
            {supabaseConfigured ? 'Configured' : 'Not configured'}
          </dd>
        </dl>
      </section>
    </>
  )
}
