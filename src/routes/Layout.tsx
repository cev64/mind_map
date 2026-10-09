import { Outlet } from 'react-router'

export function Layout() {
  return (
    <>
      <div className="backdrop" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <main className="mx-auto max-w-[1240px] px-4 pt-[calc(24px+env(safe-area-inset-top))] pb-[calc(24px+env(safe-area-inset-bottom))] sm:px-6">
        <Outlet />
      </main>
    </>
  )
}
