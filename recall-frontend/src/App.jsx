import { useState, useEffect } from "react"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

const BACKEND = import.meta.env.VITE_BACKEND_URL

const VALID_TAGS = ["Tech", "Product", "Business", "Finance", "Health", "Personal", "Other"]
const LOADING_STEPS = ["Fetching...", "Reading...", "Analyzing...", "Almost there..."]

function getAppScheme(url) {
  if (!url) return null
  if (url.includes("twitter.com") || url.includes("x.com")) return "twitter://timeline"
  if (url.includes("instagram.com")) return "instagram://feed"
  if (url.includes("reddit.com")) return "reddit://front"
  if (url.includes("linkedin.com")) return "linkedin://feed"
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube://"
  if (url.includes("substack.com")) return "substack://"
  return null
}

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
  const [debugInfo, setDebugInfo] = useState(null)

  const [isFreshReceipt, setIsFreshReceipt] = useState(false)
  const [loadingStep, setLoadingStep] = useState(0)
  const [editingTag, setEditingTag] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  useEffect(() => {
    if (!loading) { setLoadingStep(0); return }
    const id = setInterval(() => setLoadingStep(s => Math.min(s + 1, 3)), 800)
    return () => clearInterval(id)
  }, [loading])

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
    function extractSharedUrl(p) {
      const urlParam = p.get("url")
      if (urlParam && urlParam.startsWith("http")) return urlParam
      for (const key of ["text", "title"]) {
        const val = p.get(key)
        if (!val) continue
        if (val.startsWith("http")) return val.split(/\s/)[0]
        const m = val.match(/https?:\/\/\S+/)
        if (m) return m[0]
      }
      return null
    }
    const sharedUrl = extractSharedUrl(params)
    const isViaShareSheet = !!sharedUrl
    if (isViaShareSheet) {
      sessionStorage.setItem("pendingUrl", sharedUrl)
      setView("save")
    }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchTodaySaves()
      const pending = sessionStorage.getItem("pendingUrl")
      if (pending && session?.user) {
        sessionStorage.removeItem("pendingUrl")
        handleSave(pending, isViaShareSheet)
      }
    })
    supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchTodaySaves()
      const pending = sessionStorage.getItem("pendingUrl")
      if (pending && session?.user) {
        sessionStorage.removeItem("pendingUrl")
        handleSave(pending, isViaShareSheet)
      }
    })
    if (!isViaShareSheet) {
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

  const updateSaveTag = async (newTag) => {
    const token = await getToken()
    await fetch(`${BACKEND}/save/${saveReceipt.id}/tag`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: newTag, token })
    })
    setSaveReceipt(r => ({ ...r, tag: newTag }))
    setTodaySaves(prev => prev.map(s => s.id === saveReceipt.id ? { ...s, tag: newTag } : s))
    setEditingTag(false)
  }

  const deleteSave = async (id) => {
    setConfirmDeleteId(null)
    const token = await getToken()
    await fetch(`${BACKEND}/save/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    })
    setTodaySaves(prev => prev.filter(s => s.id !== id))
    if (saveReceipt?.id === id) setSaveReceipt(null)
  }

  const handleSave = async (url, fromShareSheet = false) => {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      setMessage("Links only, please!")
      setIsError(true)
      return
    }
    setLoading(true)
    setMessage("")
    setIsError(false)
    setIsFreshReceipt(false)
    setSaveReceipt({ url, optimistic: true })
    setEditingTitle(false)
    setEditingTag(false)
    try {
      const token = await getToken()
      const res = await fetch(`${BACKEND}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, token })
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      if (data.duplicate) {
        setSaveReceipt({ ...data, url, duplicate: true })
      } else {
        setUrlInput("")
        setSaveReceipt({ title: data.title, tag: data.tag, id: data.id, url, fromShareSheet })
        fetchTodaySaves()
        playSuccessChime()
        navigator.vibrate?.([50])
        setIsFreshReceipt(true)
        setTimeout(() => setIsFreshReceipt(false), 1500)
      }
    } catch {
      setSaveReceipt(null)
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
            {loading ? LOADING_STEPS[loadingStep] : "Save"}
          </button>

          {saveReceipt && (
            <div style={{
              ...styles.receiptCard,
              border: saveReceipt.duplicate ? "1px solid rgba(251, 191, 36, 0.25)" : "1px solid #2a2a2a",
              boxShadow: !saveReceipt.optimistic && !saveReceipt.duplicate && isFreshReceipt
                ? "0 0 0 2px rgba(74, 222, 128, 0.3)"
                : "none"
            }}>
              {saveReceipt.optimistic ? (
                <>
                  <span className="shimmer" style={styles.shimmerPill} />
                  <div style={styles.receiptTitleRow}>
                    <span className="shimmer" style={styles.shimmerTitle} />
                  </div>
                </>
              ) : saveReceipt.duplicate ? (
                <>
                  <span style={styles.duplicateHeader}>Already in ReCall</span>
                  <div style={styles.receiptTitleRow}>
                    <span style={styles.receiptTitle}>{saveReceipt.title}</span>
                  </div>
                  <div style={styles.receiptFooter}>
                    <span style={styles.receiptUrl}>
                      Saved on {new Date(saveReceipt.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric" })}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  {editingTag ? (
                    <div style={styles.tagPicker}>
                      {VALID_TAGS.map(t => (
                        <button
                          key={t}
                          onClick={() => updateSaveTag(t)}
                          style={t === saveReceipt.tag ? styles.tagPillActive : styles.tagPill}
                        >{t}</button>
                      ))}
                    </div>
                  ) : (
                    <button
                      onClick={() => { setEditingTag(true); setEditingTitle(false) }}
                      style={styles.receiptTagButton}
                    >
                      <span style={styles.receiptTag}>{saveReceipt.tag}</span>
                      <span style={{ fontSize: "10px", color: "#555" }}>▾</span>
                    </button>
                  )}
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
                          onClick={() => { setEditingTitle(true); setEditingTag(false); setDraftTitle(saveReceipt.title) }}
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
                </>
              )}
            </div>
          )}

          {saveReceipt?.fromShareSheet && !saveReceipt.optimistic && !saveReceipt.duplicate && (
            <a
              href={getAppScheme(saveReceipt.url) ?? undefined}
              onClick={e => {
                const scheme = getAppScheme(saveReceipt.url)
                const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                const debugMsg = `scheme: ${scheme}\nstandalone: ${isStandalone}\nreferrer: "${document.referrer}"\nhistory.length: ${window.history.length}`
                setDebugInfo(debugMsg)
                if (!scheme) {
                  e.preventDefault()
                  window.history.back()
                }
              }}
              style={styles.returnButton}
            >
              ← Return to {getSourceLabel(saveReceipt.url)}
            </a>
          )}
          {debugInfo && (
            <pre style={{ marginTop: 12, padding: 10, background: '#111', color: '#4ade80', fontSize: 11, borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {debugInfo}
            </pre>
          )}

          {message && <p style={isError ? styles.error : styles.success}>{message}</p>}

          {todaySaves.length > 0 && (
            <div style={styles.todaySection}>
              <p style={styles.todayHeader}>Today</p>
              <div style={styles.todayList}>
                {todaySaves.map(s => (
                  <a key={s.id} href={s.url} target="_blank" rel="noreferrer" style={styles.todayCard}>
                    {confirmDeleteId === s.id ? (
                      <div style={styles.deleteConfirm} onClick={e => e.stopPropagation()}>
                        <span style={styles.deleteConfirmText}>Remove from ReCall?</span>
                        <button
                          onClick={e => { e.preventDefault(); e.stopPropagation(); deleteSave(s.id) }}
                          style={styles.deleteConfirmYes}
                        >Delete</button>
                        <button
                          onClick={e => { e.preventDefault(); e.stopPropagation(); setConfirmDeleteId(null) }}
                          style={styles.deleteConfirmNo}
                        >Cancel</button>
                      </div>
                    ) : (
                      <>
                        <span style={styles.todayTag}>{s.tag}</span>
                        <span style={styles.todayTitle}>{s.title}</span>
                        <span style={styles.todaySource}>{getSourceLabel(s.url)}</span>
                        <button
                          onClick={e => { e.preventDefault(); e.stopPropagation(); setConfirmDeleteId(s.id) }}
                          style={styles.deleteButton}
                        >🗑</button>
                      </>
                    )}
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
  receiptCard: { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "12px", padding: "16px", display: "flex", flexDirection: "column", gap: "10px", transition: "box-shadow 0.8s ease" },
  receiptTagButton: { background: "none", border: "none", color: "#888", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: "4px", alignSelf: "flex-start" },
  receiptTag: { fontSize: "11px", color: "#888", textTransform: "uppercase", letterSpacing: "1px" },
  tagPicker: { display: "flex", flexWrap: "wrap", gap: "6px" },
  tagPill: { background: "none", border: "1px solid #333", color: "#888", borderRadius: "20px", padding: "4px 12px", fontSize: "12px", cursor: "pointer" },
  tagPillActive: { background: "#fff", border: "1px solid #fff", color: "#000", borderRadius: "20px", padding: "4px 12px", fontSize: "12px", cursor: "pointer", fontWeight: "600" },
  receiptTitleRow: { display: "flex", alignItems: "center", gap: "8px" },
  receiptTitle: { fontSize: "15px", fontWeight: "600", flex: 1, lineHeight: 1.4 },
  receiptTitleInput: { flex: 1, background: "#222", border: "1px solid #555", borderRadius: "8px", color: "#fff", fontSize: "15px", fontWeight: "600", padding: "4px 8px", outline: "none" },
  editButton: { background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: "15px", padding: "2px 4px", lineHeight: 1, flexShrink: 0 },
  confirmButton: { background: "#4ade80", border: "none", color: "#000", cursor: "pointer", fontSize: "14px", fontWeight: "700", padding: "4px 10px", borderRadius: "8px", flexShrink: 0 },
  receiptFooter: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" },
  receiptUrl: { fontSize: "12px", color: "#444", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  receiptSaved: { fontSize: "13px", color: "#4ade80", fontWeight: "600", flexShrink: 0 },
  duplicateHeader: { fontSize: "13px", color: "#fbbf24", fontWeight: "600" },
  shimmerPill: { height: "14px", width: "48px", borderRadius: "4px", background: "#2a2a2a", display: "block" },
  shimmerTitle: { height: "18px", width: "70%", borderRadius: "4px", background: "#2a2a2a", display: "block" },
  returnButton: { display: "block", background: "none", border: "1px solid #333", color: "#aaa", borderRadius: "12px", padding: "13px 14px", fontSize: "14px", cursor: "pointer", width: "100%", textAlign: "center", boxSizing: "border-box", textDecoration: "none" },
  todaySection: { marginTop: "4px", display: "flex", flexDirection: "column", gap: "8px" },
  todayHeader: { fontSize: "11px", color: "#555", textTransform: "uppercase", letterSpacing: "1px", margin: 0 },
  todayList: { display: "flex", flexDirection: "column", gap: "6px", maxHeight: "320px", overflowY: "auto" },
  todayCard: { display: "flex", alignItems: "center", gap: "10px", background: "#1a1a1a", border: "1px solid #222", borderRadius: "10px", padding: "10px 14px", textDecoration: "none", color: "#fff", overflow: "hidden" },
  todayTag: { fontSize: "10px", color: "#555", textTransform: "uppercase", letterSpacing: "0.5px", flexShrink: 0 },
  todayTitle: { fontSize: "13px", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  todaySource: { fontSize: "11px", color: "#444", flexShrink: 0 },
  deleteButton: { background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: "14px", padding: "0 0 0 8px", flexShrink: 0 },
  deleteConfirm: { display: "flex", alignItems: "center", gap: "8px", width: "100%" },
  deleteConfirmText: { fontSize: "12px", color: "#888", flex: 1 },
  deleteConfirmYes: { background: "#ef4444", border: "none", color: "#fff", borderRadius: "6px", padding: "4px 10px", fontSize: "12px", fontWeight: "600", cursor: "pointer", flexShrink: 0 },
  deleteConfirmNo: { background: "none", border: "1px solid #333", color: "#888", borderRadius: "6px", padding: "4px 10px", fontSize: "12px", cursor: "pointer", flexShrink: 0 },
}
