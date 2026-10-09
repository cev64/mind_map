import { Link } from 'react-router'

export function NotFound() {
  return (
    <section className="glass rounded-card p-5">
      <h1 className="text-title font-semibold text-ink">Not found</h1>
      <Link to="/" className="mt-3 inline-block text-ink-2 underline underline-offset-4">
        Home
      </Link>
    </section>
  )
}
