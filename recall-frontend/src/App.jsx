import { useState, useEffect } from "react"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

const BACKEND = import.meta.env.VITE_BACKEND_URL

export default function App() {
  const [user, setUser] = useState(null)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState([])
  const [saves, setSaves] = useState([])
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState("search")
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)
  const [clipboardUrl, setClipboardUrl] = useState("")

  const checkClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text.startsWith("http://") || text.startsWith("https://")) {
        setClipboardUrl(text)
      }
    } catch {
      // Clipboard access denied
    }
  }

  useEffect(() => {
    if (window.location.pathname === "/share-target") {
      window.history.replaceState({}, "", "/" + window.location.search)
    }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
    })
    supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    const params = new URLSearchParams(window.location.search)
    const sharedUrl = params.get("url") || params.get("text")
    if (sharedUrl && sharedUrl.startsWith("http")) {
      setView("save")
      setTimeout(() => {
        const input = document.getElementById("urlInput")
        if (input) {
          input.value = sharedUrl
          handleSave(sharedUrl)
        }
      }, 500)
    }
    checkClipboard()
  }, [])

  const signIn = async () => {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin }
    })
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setUser(null)
  }

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token
  }

  const handleSave = async (url) => {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      setMessage("Please enter a valid URL starting with http:// or https://")
      setIsError(true)
      return
    }
    setLoading(true)
    setMessage("")
    setIsError(false)
    try {
      const token = await getToken()
      const res = await fetch(`${BACKEND}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, token })
      })
      const data = await res.json()
      setMessage(`Saved: ${data.title} [${data.tag}]`)
      setIsError(false)
    } catch {
      setMessage("Failed to save. Try again.")
      setIsError(true)
    }
    setLoading(false)
  }

  const handleSearch = async () => {
    if (!query.trim()) return
    setLoading(true)
    try {
      const token = await getToken()
      const res = await fetch(`${BACKEND}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, token })
      })
      const data = await res.json()
      setResults(data.results)
    } catch {
      setResults([])
    }
    setLoading(false)
  }

  if (!user) {
    return (
      <div style={styles.container}>
        <div style={styles.hero}>
          <h1 style={styles.logo}>ReCall</h1>
          <p style={styles.tagline}>Your saved internet, finally searchable.</p>
          <button onClick={signIn} style={styles.button}>
            Sign in with Google
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.logoSmall}>ReCall</h1>
        <button onClick={signOut} style={styles.signOut}>Sign out</button>
      </div>

      <div style={styles.tabs}>
        <button onClick={() => { setView("search") }} style={view === "search" ? styles.tabActive : styles.tab}>Search</button>
        <button onClick={() => { setView("save"); checkClipboard() }} style={view === "save" ? styles.tabActive : styles.tab}>Save</button>
      </div>

      {view === "search" && (
        <div style={styles.section}>
          <input
            style={styles.input}
            placeholder="What are you looking for?"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSearch()}
          />
          <button onClick={handleSearch} style={styles.button} disabled={loading}>
            {loading ? "Searching..." : "Search"}
          </button>
          <div style={styles.results}>
            {results.map(r => (
              <a key={r.id} href={r.url} target="_blank" rel="noreferrer" style={styles.card}>
                <div style={styles.cardTag}>{r.tag}</div>
                <div style={styles.cardTitle}>{r.title || r.url}</div>
                <div style={styles.cardUrl}>{r.url}</div>
                <div style={styles.cardScore}>Match: {Math.round(r.similarity * 100)}%</div>
              </a>
            ))}
          </div>
        </div>
      )}

      {view === "save" && (
        <div style={styles.section}>
          {clipboardUrl && (
            <div style={styles.clipboardBanner}>
              <span style={styles.clipboardText}>Copied: {clipboardUrl.slice(0, 50)}...</span>
              <button
                onClick={() => { handleSave(clipboardUrl); setClipboardUrl("") }}
                style={styles.clipboardButton}
              >
                Save this
              </button>
            </div>
          )}
          <input
            style={styles.input}
            placeholder="Paste a URL to save"
            id="urlInput"
          />
          <button
            onClick={() => handleSave(document.getElementById("urlInput").value)}
            style={styles.button}
            disabled={loading}
          >
            {loading ? "Saving..." : "Save"}
          </button>
          {message && <p style={isError ? styles.error : styles.success}>{message}</p>}
        </div>
      )}
    </div>
  )
}

const styles = {
  container: { minHeight: "100vh", background: "#0f0f0f", color: "#fff", fontFamily: "system-ui, sans-serif", padding: "0 16px" },
  hero: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: "16px" },
  logo: { fontSize: "48px", fontWeight: "700", margin: 0, letterSpacing: "-2px" },
  logoSmall: { fontSize: "24px", fontWeight: "700", margin: 0, letterSpacing: "-1px" },
  tagline: { color: "#888", fontSize: "16px", margin: 0 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 0" },
  tabs: { display: "flex", gap: "8px", marginBottom: "24px" },
  tab: { background: "none", border: "1px solid #333", color: "#888", padding: "8px 20px", borderRadius: "20px", cursor: "pointer", fontSize: "14px" },
  tabActive: { background: "#fff", border: "1px solid #fff", color: "#000", padding: "8px 20px", borderRadius: "20px", cursor: "pointer", fontSize: "14px", fontWeight: "600" },
  section: { display: "flex", flexDirection: "column", gap: "12px" },
  input: { width: "100%", padding: "14px", background: "#1a1a1a", border: "1px solid #333", borderRadius: "12px", color: "#fff", fontSize: "16px", boxSizing: "border-box" },
  button: { width: "100%", padding: "14px", background: "#fff", color: "#000", border: "none", borderRadius: "12px", fontSize: "16px", fontWeight: "600", cursor: "pointer" },
  signOut: { background: "none", border: "1px solid #333", color: "#888", padding: "6px 14px", borderRadius: "8px", cursor: "pointer", fontSize: "13px" },
  results: { display: "flex", flexDirection: "column", gap: "12px", marginTop: "8px" },
  card: { display: "block", background: "#1a1a1a", border: "1px solid #333", borderRadius: "12px", padding: "16px", textDecoration: "none", color: "#fff" },
  cardTag: { fontSize: "11px", color: "#888", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" },
  cardTitle: { fontSize: "15px", fontWeight: "600", marginBottom: "4px" },
  cardUrl: { fontSize: "12px", color: "#555", marginBottom: "6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  cardScore: { fontSize: "12px", color: "#888" },
  success: { color: "#4ade80", fontSize: "14px", margin: 0 },
  error: { color: "#ef4444", fontSize: "14px", margin: 0 },
  clipboardBanner: { background: "#1a1a1a", border: "1px solid #444", borderRadius: "12px", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" },
  clipboardText: { fontSize: "12px", color: "#888", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  clipboardButton: { background: "#fff", color: "#000", border: "none", borderRadius: "8px", padding: "6px 14px", fontSize: "13px", fontWeight: "600", cursor: "pointer", flexShrink: 0 },
}