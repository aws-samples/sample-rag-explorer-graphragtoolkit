import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App'

export default function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/*" element={<App />} />
      </Routes>
    </BrowserRouter>
  )
}
