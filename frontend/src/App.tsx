import { Routes, Route } from 'react-router-dom'
import Header from './components/Header'
import Transfer from './pages/Transfer'
import Status from './pages/Status'
import History from './pages/History'
import Lookup from './pages/Lookup'
import type { Mode } from './config/chains'

export default function App({ mode }: { mode: Mode }) {
  const prefix = mode === 'testnet' ? '/testnet' : ''

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <Header mode={mode} />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Routes>
          <Route path={`${prefix}/`} element={<Transfer />} />
          <Route path={`${prefix}/tx/:id`} element={<Status />} />
          <Route path={`${prefix}/history`} element={<History />} />
          <Route path={`${prefix}/lookup`} element={<Lookup />} />
        </Routes>
      </main>
    </div>
  )
}
