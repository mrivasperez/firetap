import { useState } from 'react'
import './App.css'
import CollaborativeEditor from './components/CollaborativeEditor'
import { generateRandomColor } from './lib/collaboration/config'

const App = () => {
  const [userName] = useState(() => 
    `User-${Math.random().toString(36).substr(2, 5)}`
  )
  const [userColor] = useState(() => generateRandomColor())
  const [docId, setDocId] = useState('demo-doc')
  const [showMultipleEditors, setShowMultipleEditors] = useState(true)

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-controls controls-single-line">
          <div className="controls-left">
            <div className="control-group">
              <label htmlFor="docId">Document:</label>
              <input
                id="docId"
                type="text"
                value={docId}
                onChange={(e) => setDocId(e.target.value)}
                placeholder="Enter document ID"
              />
            </div>
          </div>

          <div className="controls-right">
            <div className="user-info">
              <span 
                className="user-color-indicator"
                title={userName}
                style={{ backgroundColor: userColor }}
              />
            </div>

            <button
              className={`toggle-button ${showMultipleEditors ? 'active' : ''}`}
              onClick={() => setShowMultipleEditors(!showMultipleEditors)}
            >
              {showMultipleEditors ? 'Single Editor' : 'Demo Collaboration'}
            </button>
          </div>
        </div>
      </header>

      <main className={`app-main ${showMultipleEditors ? 'dual-editor' : 'single-editor'}`}>
        <div className="editor-container">
          <CollaborativeEditor 
            docId={docId} 
            userName={userName}
            userColor={userColor}
          />
        </div>
        
        {showMultipleEditors && (
          <div className="editor-container">
            <CollaborativeEditor 
              docId={docId} 
              userName={`${userName}-2`}
              userColor={generateRandomColor()}
            />
          </div>
        )}
      </main>

      {showMultipleEditors && (
        <footer className="app-footer">
          <p>
            👆 Both editors are connected to the same document. 
            Type in either editor to see real-time collaboration in action!
          </p>
        </footer>
      )}
    </div>
  )
}

export default App
