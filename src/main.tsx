import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createHashRouter } from 'react-router'
import './index.css'
import { Layout } from './routes/Layout'
import { Home } from './routes/Home'
import { NotFound } from './routes/NotFound'

// Hash routing: GitHub Pages has no server rewrites, so deep links live after #.
const router = createHashRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
