import { Routes, Route } from 'react-router-dom'
import Header from './components/Header'
import WalletSync from './components/WalletSync'
import Transfer from './pages/Transfer'
import Status from './pages/Status'
import History from './pages/History'

export default function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <WalletSync />
      <Header />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Routes>
          <Route path="/" element={<Transfer />} />
          <Route path="/tx/:id" element={<Status />} />
          <Route path="/history" element={<History />} />
        </Routes>
      </main>
    </div>
  )
}
