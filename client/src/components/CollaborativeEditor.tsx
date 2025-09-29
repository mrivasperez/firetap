import { useEffect, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Placeholder } from '@tiptap/extensions'
import { createFirebaseYWebrtcAdapter, type AdapterHandle } from '../lib/collab-adapter'
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

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Disable undoRedo when using collaboration (official pattern)
        undoRedo: adapter ? false : {},
      }),
      // Only add collaboration extensions when adapter is ready
      ...(adapter ? [
        Collaboration.configure({
          document: adapter.ydoc,
        }),
        CollaborationCaret.configure({
          provider: { awareness: adapter.awareness },
          user: {
            name: userName,
            color: userColor || adapter.getUserInfo().color,
          },
        }),
      ] : []),
      Placeholder.configure({
        placeholder: adapter 
          ? 'Start typing to collaborate with other users...'
          : 'Loading collaborative editor...'
      }),
    ],
    content: '<p>Loading collaborative editor...</p>',
    editable: !!adapter,
  }, [adapter, userName, userColor])

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
          user: { name: userName, color: userColor },
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
      
      try {
        handle?.disconnect()
        console.log(`Collaborative editor disconnected for document: ${docId}`)
      } catch (e) {
        console.warn('Error during disconnect:', e)
      }
    }
  }, [docId, userName, userColor, workspaceId])

  // Update editor when adapter changes
  useEffect(() => {
    if (adapter && editor) {
      // Editor will be recreated with collaboration extensions
      console.log('Editor updated with collaboration extensions')
    }
  }, [adapter, editor])

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
