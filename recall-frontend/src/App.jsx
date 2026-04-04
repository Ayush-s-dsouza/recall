import { useState, useEffect } from "react"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

const BACKEND = import.meta.env.VITE_BACKEND_URL

function getSourceLabel(url) {
  if (!url) return "Page"
  if (url.includes("twitter.com") || url.includes("x.com")) return "X (Twitter)"
  if (url.includes("linkedin.com")) return "LinkedIn"
  if (url.includes("reddit.com")) return "Reddit"
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "YouTube"
  if (url.includes("substack.com")) return "Substack"
  try {
    const host = new URL(url).hostname.replace("www.", "")
    return host.charAt(0).toUpperCase() + host.slice(1)
  } catch {
    return "Page"
  }
}

export default function App() {
  const [user, setUser] = useState(null)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState([])
  const [saves, setSaves] = useState([])
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState("search")
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)
  const [selectedSource, setSelectedSource] = useState(null)
  const [urlInput, setUrlInput] = useState("")
  const [saveReceipt, setSaveReceipt] = useState(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState("")
  const [todaySaves, setTodaySaves] = useState([])

  function playSuccessChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = "sine"
      osc.frequency.setValueAtTime(880, ctx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12)
      gain.gain.setValueAtTime(0.25, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45)
      osc.start()
      osc.stop(ctx.currentTime + 0.45)
    } catch {}
  }

  const checkClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text.startsWith("http://") || text.startsWith("https://")) {
        setUrlInput(text)
      }
    } catch {
      // Clipboard access denied or unavailable
    }
  }

  const fetchTodaySaves = async () => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const { data } = await supabase
      .from("saves")
      .select("id, url, title, tag")
      .gte("created_at", today.toISOString())
      .order("created_at", { ascending: false })
      .limit(20)
    if (data) setTodaySaves(data)
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const sharedUrl = params.get("url") || params.get("text")
    const viaShareSheet = !!(sharedUrl && sharedUrl.startsWith("http"))
    if (viaShareSheet) {
      sessionStorage.setItem("pendingUrl", sharedUrl)
      setView("save")
    }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchTodaySaves()
      const pending = sessionStorage.getItem("pendingUrl")
      if (pending && session?.user) {
        sessionStorage.removeItem("pendingUrl")
        handleSave(pending)
      }
    })
    supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchTodaySaves()
      const pending = sessionStorage.getItem("pendingUrl")
      if (pending && session?.user) {
        sessionStorage.removeItem("pendingUrl")
        handleSave(pending)
      }
    })
    if (!viaShareSheet) {
      checkClipboard()
    }
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

  const updateSaveTitle = async (newTitle) => {
    if (!newTitle.trim() || newTitle === saveReceipt.title) {
      setEditingTitle(false)
      return
    }
    const token = await getToken()
    await fetch(`${BACKEND}/save/${saveReceipt.id}/title`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle, token })
    })
    setSaveReceipt(r => ({ ...r, title: newTitle }))
    setTodaySaves(prev => prev.map(s => s.id === saveReceipt.id ? { ...s, title: newTitle } : s))
    setEditingTitle(false)
    playSuccessChime()
    navigator.vibrate?.([50])
  }

  const handleSave = async (url) => {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      setMessage("Links only, please!")
      setIsError(true)
      return
    }
    setLoading(true)
    setMessage("")
    setIsError(false)
    setSaveReceipt(null)
    setEditingTitle(false)
    try {
      const token = await getToken()
      const res = await fetch(`${BACKEND}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, token })
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setUrlInput("")
      setSaveReceipt({ title: data.title, tag: data.tag, id: data.id, url })
      fetchTodaySaves()
      playSuccessChime()
      navigator.vibrate?.([50])
    } catch {
      setMessage(`Failed to save from ${getSourceLabel(url)}. Try again.`)
      setIsError(true)
    }
    setLoading(false)
  }

  const handleSearch = async () => {
    if (!query.trim()) return
    setLoading(true)
    setSelectedSource(null)
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
          {results.length > 0 && (() => {
            const sources = [...new Set(results.map(r => getSourceLabel(r.url)))]
            const filtered = selectedSource ? results.filter(r => getSourceLabel(r.url) === selectedSource) : results
            return (
              <>
                {sources.length > 1 && (
                  <div style={styles.filters}>
                    {sources.map(src => (
                      <button
                        key={src}
                        onClick={() => setSelectedSource(selectedSource === src ? null : src)}
                        style={selectedSource === src ? styles.filterActive : styles.filter}
                      >
                        {src}
                      </button>
                    ))}
                  </div>
                )}
                <div style={styles.results}>
                  {filtered.map(r => (
                    <a key={r.id} href={r.url} target="_blank" rel="noreferrer" style={styles.card}>
                      <div style={styles.cardTag}>{r.tag}</div>
                      <div style={styles.cardTitle}>{r.title || getSourceLabel(r.url)}</div>
                      <div style={styles.cardUrl}>{r.url}</div>
                      <div style={styles.cardScore}>Match: {Math.round(r.similarity * 100)}%</div>
                    </a>
                  ))}
                </div>
              </>
            )
          })()}
        </div>
      )}

      {view === "save" && (
        <div style={styles.section}>
          <input
            style={styles.input}
            placeholder="Paste a URL to save"
            value={urlInput}
            onChange={e => { setUrlInput(e.target.value); setSaveReceipt(null) }}
            onKeyDown={e => e.key === "Enter" && handleSave(urlInput)}
          />
          <button
            onClick={() => handleSave(urlInput)}
            style={styles.button}
            disabled={loading}
          >
            {loading ? "Saving..." : "Save"}
          </button>

          {saveReceipt && (
            <div style={styles.receiptCard}>
              <span style={styles.receiptTag}>{saveReceipt.tag}</span>
              <div style={styles.receiptTitleRow}>
                {editingTitle ? (
                  <>
                    <input
                      style={styles.receiptTitleInput}
                      value={draftTitle}
                      onChange={e => setDraftTitle(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") updateSaveTitle(draftTitle) }}
                      autoFocus
                    />
                    <button
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => updateSaveTitle(draftTitle)}
                      style={styles.confirmButton}
                      title="Save name"
                    >✓</button>
                  </>
                ) : (
                  <>
                    <span style={styles.receiptTitle}>{saveReceipt.title}</span>
                    <button
                      onClick={() => { setEditingTitle(true); setDraftTitle(saveReceipt.title) }}
                      style={styles.editButton}
                      title="Edit name"
                    >✎</button>
                  </>
                )}
              </div>
              <div style={styles.receiptFooter}>
                <span style={styles.receiptUrl}>{saveReceipt.url}</span>
                <span style={styles.receiptSaved}>Saved ✓</span>
              </div>
            </div>
          )}

          {message && <p style={isError ? styles.error : styles.success}>{message}</p>}

          {todaySaves.length > 0 && (
            <div style={styles.todaySection}>
              <p style={styles.todayHeader}>Today</p>
              <div style={styles.todayList}>
                {todaySaves.map(s => (
                  <a key={s.id} href={s.url} target="_blank" rel="noreferrer" style={styles.todayCard}>
                    <span style={styles.todayTag}>{s.tag}</span>
                    <span style={styles.todayTitle}>{s.title}</span>
                    <span style={styles.todaySource}>{getSourceLabel(s.url)}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const styles = {
  container: { minHeight: "100vh", maxWidth: "100vw", overflowX: "hidden", background: "#0f0f0f", color: "#fff", fontFamily: "system-ui, sans-serif", padding: "0 16px", boxSizing: "border-box" },
  hero: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: "16px" },
  logo: { fontSize: "48px", fontWeight: "700", margin: 0, letterSpacing: "-2px" },
  logoSmall: { fontSize: "24px", fontWeight: "700", margin: 0, letterSpacing: "-1px" },
  tagline: { color: "#888", fontSize: "16px", margin: 0 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 0" },
  tabs: { display: "flex", gap: "8px", marginBottom: "24px" },
  tab: { background: "none", border: "1px solid #333", color: "#888", padding: "8px 20px", borderRadius: "20px", cursor: "pointer", fontSize: "14px" },
  tabActive: { background: "#fff", border: "1px solid #fff", color: "#000", padding: "8px 20px", borderRadius: "20px", cursor: "pointer", fontSize: "14px", fontWeight: "600" },
  section: { display: "flex", flexDirection: "column", gap: "12px", width: "100%", boxSizing: "border-box" },
  input: { width: "100%", padding: "14px", background: "#1a1a1a", border: "1px solid #333", borderRadius: "12px", color: "#fff", fontSize: "16px", boxSizing: "border-box" },
  button: { width: "100%", padding: "14px", background: "#fff", color: "#000", border: "none", borderRadius: "12px", fontSize: "16px", fontWeight: "600", cursor: "pointer" },
  signOut: { background: "none", border: "1px solid #333", color: "#888", padding: "6px 14px", borderRadius: "8px", cursor: "pointer", fontSize: "13px" },
  filters: { display: "flex", flexWrap: "wrap", gap: "8px" },
  filter: { background: "none", border: "1px solid #333", color: "#888", padding: "6px 14px", borderRadius: "20px", cursor: "pointer", fontSize: "13px" },
  filterActive: { background: "#fff", border: "1px solid #fff", color: "#000", padding: "6px 14px", borderRadius: "20px", cursor: "pointer", fontSize: "13px", fontWeight: "600" },
  results: { display: "flex", flexDirection: "column", gap: "12px", marginTop: "8px" },
  card: { display: "block", background: "#1a1a1a", border: "1px solid #333", borderRadius: "12px", padding: "16px", textDecoration: "none", color: "#fff", overflow: "hidden" },
  cardTag: { fontSize: "11px", color: "#888", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "6px" },
  cardTitle: { fontSize: "15px", fontWeight: "600", marginBottom: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  cardUrl: { fontSize: "12px", color: "#555", marginBottom: "6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  cardScore: { fontSize: "12px", color: "#888" },
  success: { color: "#4ade80", fontSize: "14px", margin: 0 },
  error: { color: "#ef4444", fontSize: "14px", margin: 0 },
  receiptCard: { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "12px", padding: "16px", display: "flex", flexDirection: "column", gap: "10px" },
  receiptTag: { fontSize: "11px", color: "#888", textTransform: "uppercase", letterSpacing: "1px" },
  receiptTitleRow: { display: "flex", alignItems: "center", gap: "8px" },
  receiptTitle: { fontSize: "15px", fontWeight: "600", flex: 1, lineHeight: 1.4 },
  receiptTitleInput: { flex: 1, background: "#222", border: "1px solid #555", borderRadius: "8px", color: "#fff", fontSize: "15px", fontWeight: "600", padding: "4px 8px", outline: "none" },
  editButton: { background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: "15px", padding: "2px 4px", lineHeight: 1, flexShrink: 0 },
  confirmButton: { background: "#4ade80", border: "none", color: "#000", cursor: "pointer", fontSize: "14px", fontWeight: "700", padding: "4px 10px", borderRadius: "8px", flexShrink: 0 },
  receiptFooter: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" },
  receiptUrl: { fontSize: "12px", color: "#444", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  receiptSaved: { fontSize: "13px", color: "#4ade80", fontWeight: "600", flexShrink: 0 },
  todaySection: { marginTop: "4px", display: "flex", flexDirection: "column", gap: "8px" },
  todayHeader: { fontSize: "11px", color: "#555", textTransform: "uppercase", letterSpacing: "1px", margin: 0 },
  todayList: { display: "flex", flexDirection: "column", gap: "6px", maxHeight: "320px", overflowY: "auto" },
  todayCard: { display: "flex", alignItems: "center", gap: "10px", background: "#1a1a1a", border: "1px solid #222", borderRadius: "10px", padding: "10px 14px", textDecoration: "none", color: "#fff", overflow: "hidden" },
  todayTag: { fontSize: "10px", color: "#555", textTransform: "uppercase", letterSpacing: "0.5px", flexShrink: 0 },
  todayTitle: { fontSize: "13px", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  todaySource: { fontSize: "11px", color: "#444", flexShrink: 0 },
}
