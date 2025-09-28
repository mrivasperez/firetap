import type { FC } from 'react'
import './App.css'
import Count from './components/Count'

const App: FC = () => {
  return (
    <div id="app-root">
      <header>
        <h1>Realtime Tiptap — Editor</h1>
      </header>
      <main>
        <p>Your realtime editor will mount here.</p>
        <Count />
      </main>
    </div>
  )
}

export default App
