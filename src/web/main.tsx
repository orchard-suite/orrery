import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { NewRelease } from './components/NewRelease.tsx'
import './styles.css'

// The page loaded, so a reload that a missing built file asked for has done its work (index.html).
try {
  sessionStorage.removeItem('orrery.reloaded')
} catch {}

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
      <NewRelease />
    </QueryClientProvider>
  </StrictMode>,
)
