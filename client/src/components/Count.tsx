import { useEffect, useState } from 'react'
import { ref, onValue, runTransaction, set } from 'firebase/database'
import { rtdb } from '../firebase'

export default function Count() {
  const [count, setCountLocal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const countRef = ref(rtdb, 'count')
    const unsub = onValue(countRef, (snapshot) => {
      const val = snapshot.val()
      setCountLocal(typeof val === 'number' ? val : 0)
      setLoading(false)
    })

    return () => unsub()
  }, [])

  const increment = async () => {
    const countRef = ref(rtdb, 'count')
    await runTransaction(countRef, (current) => (typeof current === 'number' ? current + 1 : 1))
  }

  const decrement = async () => {
    const countRef = ref(rtdb, 'count')
    await runTransaction(countRef, (current) => (typeof current === 'number' ? current - 1 : 0))
  }

  const reset = async () => {
    const countRef = ref(rtdb, 'count')
    await set(countRef, 0)
  }

  return (
    <section>
      <h2>Count</h2>
      {loading ? (
        <p>Loading…</p>
      ) : (
        <div>
          <p>Value: {count}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={decrement}>-</button>
            <button onClick={increment}>+</button>
            <button onClick={reset}>Reset</button>
          </div>
        </div>
      )}
    </section>
  )
}
