import { useEffect, useState, useMemo } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Placeholder } from '@tiptap/extensions'
import { createFirebaseYWebrtcAdapter, type AdapterHandle } from 'firetap'
import { rtdb } from '../firebase'
import './CollaborativeEditor.css'

type Props = { 
  docId?: string
  userName?: string
  userColor?: string
  className?: string
  workspaceId?: string
}

export default function CollaborativeEditor({ 
  docId = 'demo-doc', 
  userName = 'Anonymous',
  userColor,
  className = ''
  , workspaceId = 'workspace123'
}: Props) {
  const [adapter, setAdapter] = useState<AdapterHandle | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [connectionInfo, setConnectionInfo] = useState<{
    peerCount: number
    clusterId: string
    isCommonClient: boolean
  } | null>(null)

  // Generate stable user color (memoized to prevent regeneration on re-renders)
  const stableUserColor = useMemo(() => 
    userColor || `#${Math.floor(Math.random()*16777215).toString(16)}`,
    [userColor]
  )

  // Create editor - with minimal config if adapter not ready
  const editor = useEditor({
    extensions: adapter ? [
      StarterKit.configure({
        // Disable the History extension (undoRedo) when using collaboration
        // Y.js provides its own collaborative undo/redo
        undoRedo: false,
      }),
      Collaboration.configure({
        document: adapter.ydoc,
      }),
      CollaborationCaret.configure({
        // Tiptap expects a provider object with an awareness property
        provider: { awareness: adapter.awareness },
        user: {
          name: userName,
          color: stableUserColor,
        },
      }),
      Placeholder.configure({
        placeholder: 'Start typing to collaborate with other users...'
      }),
    ] : [
      // Minimal extensions when adapter not ready to prevent schema errors
      StarterKit,
      Placeholder.configure({
        placeholder: 'Loading collaborative editor...'
      }),
    ],
    editable: !!adapter,
    content: adapter ? undefined : '<p>Loading collaborative editor...</p>',
  }, [adapter, userName, stableUserColor])

  useEffect(() => {
    let handle: AdapterHandle | null = null
    let connectionTimer: ReturnType<typeof setInterval> | null = null
    
    ;(async () => {
      try {
        setIsLoading(true)
        setError(null)
        
        console.log(`Initializing collaborative editor for document: ${docId}`)
        
        handle = await createFirebaseYWebrtcAdapter({ 
          docId,
          firebaseDatabase: rtdb, // Add required Firebase database instance
          user: { name: userName },
          syncIntervalMs: 15000, // 15 second sync interval
          maxDirectPeers: 6, // Reasonable cluster size
          databasePaths: {
            structure: 'nested',
            nested: {
              basePath: `/${workspaceId}/documents`,
              subPaths: {
                documents: 'documents',
                rooms: 'rooms',
                snapshots: 'snapshots',
                signaling: 'signaling'
              }
            }
          }
        })
        
        setAdapter(handle)
        setIsLoading(false)
        
        // Update connection info periodically
        connectionTimer = setInterval(() => {
          if (handle) {
            const userInfo = handle.getUserInfo()
            setConnectionInfo({
              peerCount: handle.getPeerCount(),
              clusterId: userInfo.id.slice(-8), // Use user ID as cluster identifier
              isCommonClient: false // y-webrtc manages this internally
            })
          }
        }, 2000)
        
        console.log(`Collaborative editor initialized successfully`)
      } catch (err) {
        console.error('Failed to initialize collaborative editor:', err)
        setError(err instanceof Error ? err.message : 'Failed to initialize editor')
        setIsLoading(false)
      }
    })()

    return () => {
      if (connectionTimer) {
        clearInterval(connectionTimer)
      }
      
      // Force persist before disconnect to prevent data loss
      ;(async () => {
        try {
          if (handle?.forcePersist) {
            await handle.forcePersist()
            console.log('Document persisted before disconnect')
          }
        } catch (e) {
          console.warn('Error during final persistence:', e)
        }
        
        try {
          handle?.disconnect()
          console.log(`Collaborative editor disconnected for document: ${docId}`)
        } catch (e) {
          console.warn('Error during disconnect:', e)
        }
      })()
    }
  }, [docId, userName, userColor, workspaceId])

  // Update awareness state when user info changes
  useEffect(() => {
    if (adapter && editor) {
      // Update the awareness state with current user info
      adapter.awareness.setLocalStateField('user', {
        name: userName,
        color: stableUserColor,
      })
      console.log('Awareness updated with user info:', { userName, color: stableUserColor })
    }
  }, [adapter, editor, userName, stableUserColor])

  if (error) {
    return (
      <div className={`collaborative-editor-error ${className}`} style={{ 
        border: '1px solid #dc3545', 
        borderRadius: '4px',
        padding: '16px',
        backgroundColor: '#f8d7da',
        color: '#721c24'
      }}>
        <h4>Collaboration Error</h4>
        <p>{error}</p>
        <button 
          onClick={() => window.location.reload()} 
          style={{
            padding: '8px 16px',
            backgroundColor: '#dc3545',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          Reload Page
        </button>
      </div>
    )
  }

  return (
    <div className={`collaborative-editor ${className} ${isLoading ? 'loading' : ''}`}>
      {/* Header with connection info */}
      <div className="ce-header">
        <div className="ce-header-left">
          <span className="ce-document"><strong>Document:</strong> {docId}</span>
          {isLoading && <span className="ce-loading">Loading...</span>}
        </div>

        <div className="ce-header-center">
          {connectionInfo && (
            <div className="connection-status">
              <span className={`connection-dot ${adapter?.getConnectionStatus() ?? 'disconnected'}`} />
              <span className="ce-peercount">👥 {connectionInfo.peerCount} peers</span>
              {connectionInfo.isCommonClient && <span className="ce-leader">🌟 Leader</span>}
            </div>
          )}
        </div>

        <div className="ce-header-right">
          <span className="ce-user">{userName}</span>
          <span className="ce-user-color" style={{ backgroundColor: userColor || '#ccc' }} />
        </div>
      </div>

      {/* Editor content */}
      <div className="ce-body">
        {isLoading && (
          <div className="ce-loading-overlay">Connecting to collaboration network...</div>
        )}

        <EditorContent editor={editor} className="ce-editorcontent" />
      </div>

      {/* Footer with status */}
      {adapter && connectionInfo && (
        <div className="ce-footer">
          <span>Session: {connectionInfo.clusterId}</span>
          <span>•</span>
          <span>Status: {adapter.getConnectionStatus() === 'connected' && connectionInfo.peerCount > 0 ? '🟢 Connected' : 
                   adapter.getConnectionStatus() === 'connecting' ? '🟡 Connecting' : '🔴 Offline'}</span>
        </div>
      )}
    </div>
  )
}
