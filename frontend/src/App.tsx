import { Routes, Route } from 'react-router-dom'
import Header from './components/Header'
import Transfer from './pages/Transfer'
import Status from './pages/Status'
import History from './pages/History'
import Lookup from './pages/Lookup'
import Footer from './components/Footer'
import type { Mode } from './config/chains'

export default function App({ mode }: { mode: Mode }) {
  const prefix = mode === 'mainnet' ? '/mainnet' : ''

  return (
    <div className="flex min-h-screen flex-col bg-gray-950 text-white">
      <Header mode={mode} />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        <Routes>
          <Route path={`${prefix}/`} element={<Transfer />} />
          <Route path={`${prefix}/tx/:id`} element={<Status />} />
          <Route path={`${prefix}/history`} element={<History />} />
          <Route path={`${prefix}/lookup`} element={<Lookup />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}
