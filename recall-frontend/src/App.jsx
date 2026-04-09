import { useState, useEffect, useRef } from "react"
import { createClient } from "@supabase/supabase-js"
import posthog from 'posthog-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

const BACKEND = import.meta.env.VITE_BACKEND_URL

const VALID_TAGS = ["Tech", "Product", "Business", "Finance", "Health", "Personal", "Other"]
const LOADING_STEPS = ["Fetching...", "Reading...", "Analyzing...", "Almost there..."]

function getAppScheme(url) {
  if (!url) return null
  try {
    const { host, pathname, search } = new URL(url)
    const pkg =
      url.includes("twitter.com") || url.includes("x.com") ? "com.twitter.android" :
      url.includes("instagram.com") ? "com.instagram.android" :
      url.includes("reddit.com") ? "com.reddit.frontpage" :
      url.includes("linkedin.com") ? "com.linkedin.android" :
      url.includes("youtube.com") || url.includes("youtu.be") ? "com.google.android.youtube" :
      url.includes("substack.com") ? "com.substack.app" :
      null
    if (!pkg) return null
    return `intent://${host}${pathname}${search}#Intent;scheme=https;package=${pkg};end`
  } catch {
    return null
  }
}

function formatDate(isoString) {
  if (!isoString) return ""
  try {
    return new Date(isoString).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  } catch { return "" }
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
  const [view, setView] = useState(() => {
    const path = window.location.pathname
    if (path === '/privacy' || path === '/terms') return 'legal'
    return sessionStorage.getItem("recall_view") || "search"
  })
  const [legalSection, setLegalSection] = useState(() =>
    window.location.pathname === '/terms' ? 'terms' : 'privacy'
  )
  const [showSettings, setShowSettings] = useState(false)
  const [deletingAccount, setDeletingAccount] = useState(false)
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false)
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)
  const [selectedSource, setSelectedSource] = useState(null)
  const [urlInput, setUrlInput] = useState("")
  const [saveReceipt, setSaveReceipt] = useState(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState("")
  const [todaySaves, setTodaySaves] = useState([])

  const [isFreshReceipt, setIsFreshReceipt] = useState(false)
  const [loadingStep, setLoadingStep] = useState(0)
  const [editingTag, setEditingTag] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [libraryFilters, setLibraryFilters] = useState({ tags: [], sources: [] })
  const [hasSearched, setHasSearched] = useState(false)
  const [displayCount, setDisplayCount] = useState(5)
  const [recentSearches, setRecentSearches] = useState(() => {
    try { return JSON.parse(localStorage.getItem("recall_recent_searches") || "[]") }
    catch { return [] }
  })
  const [searchInputFocused, setSearchInputFocused] = useState(false)
  const [selectedTag, setSelectedTag] = useState(null)
  const [suggestedChips, setSuggestedChips] = useState(null)
  const [onboardingStep, setOnboardingStep] = useState(null)
  const [first5Count, setFirst5Count] = useState(5)
  const [firstSaveSheetOpen, setFirstSaveSheetOpen] = useState(false)
  const [authLoading, setAuthLoading] = useState(true)
  const urlInputRef = useRef(null)
  const searchInputRef = useRef(null)
  const isIOS = /iPhone|iPad/i.test(navigator.userAgent)

  useEffect(() => { sessionStorage.setItem("recall_view", view) }, [view])

  useEffect(() => {
    if (!loading) { setLoadingStep(0); return }
    const id = setInterval(() => setLoadingStep(s => Math.min(s + 1, 3)), 1050)
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

  const fetchSuggestions = async () => {
    try {
      const cached = sessionStorage.getItem("recall_suggestions")
      if (cached) { setSuggestedChips(JSON.parse(cached)); return }
      const token = await getToken()
      const res = await fetch(`${BACKEND}/suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      })
      const data = await res.json()
      setSuggestedChips(data.chips)
      sessionStorage.setItem("recall_suggestions", JSON.stringify(data.chips))
    } catch {
      setSuggestedChips([])
    }
  }

  const fetchSaveCount = async () => {
    const { count } = await supabase
      .from("saves")
      .select("*", { count: "exact", head: true })
    if (count !== null) {
      const capped = Math.min(count, 5)
      setFirst5Count(capped)
      if (capped >= 5) {
        setFirstSaveSheetOpen(false)
        setOnboardingStep(prev => prev === 'firstSave' ? 'done' : prev)
        localStorage.setItem('recall_onboarded', 'true')
      }
    }
  }

  const fetchTodaySaves = async () => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const { data } = await supabase
      .from("saves")
      .select("id, url, title, tag, content_type")
      .gte("created_at", today.toISOString())
      .order("created_at", { ascending: false })
      .limit(20)
    if (data) setTodaySaves(data)
  }

  const fetchLibraryFilters = async () => {
    const { data } = await supabase.from("saves").select("tag, url")
    if (!data?.length) return
    const tags = [...new Set(data.map(r => r.tag).filter(Boolean))].sort()
    const sources = [...new Set(data.map(r => getSourceLabel(r.url)).filter(s => s && s !== "Page"))].sort()
    setLibraryFilters({ tags, sources })
  }

  const browseByFilter = async (tag, source) => {
    setLoading(true)
    setHasSearched(true)
    let q = supabase
      .from("saves")
      .select("id, url, title, tag, created_at, content_text")
      .order("created_at", { ascending: false })
      .limit(100)
    if (tag) q = q.eq("tag", tag)
    const { data } = await q
    let rows = data || []
    if (source) rows = rows.filter(r => getSourceLabel(r.url) === source)
    setResults(rows.map(r => {
      const content = (r.content_text || "").trim()
      const excerpt = content.length > 220 ? content.slice(0, 220).replace(/\s\S*$/, "") + "…" : content
      const { content_text, ...rest } = r
      return { ...rest, excerpt }
    }))
    setLoading(false)
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
      window.history.replaceState({}, '', '/')
      posthog.capture('share_sheet_triggered')
    }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setAuthLoading(false)
      if (session?.user) {
        posthog.identify(session.user.id)
        fetchTodaySaves()
        fetchLibraryFilters()
        fetchSuggestions()
        fetchSaveCount()
        // Restore last search session
        const savedQuery = sessionStorage.getItem("recall_last_query")
        const savedResults = sessionStorage.getItem("recall_last_results")
        if (savedQuery && savedResults) {
          setQuery(savedQuery)
          setResults(JSON.parse(savedResults))
          setHasSearched(true)
        }
        // Initialize onboarding for first-time users
        if (!localStorage.getItem('recall_onboarded')) {
          const isStandalone = window.matchMedia('(display-mode: standalone)').matches
          if (isStandalone || localStorage.getItem('recall_onboarding_install')) {
            setOnboardingStep('firstSave')
            setFirstSaveSheetOpen(true)
            setView('save')
          } else {
            setOnboardingStep('install')
          }
        }
      }
      const pending = sessionStorage.getItem("pendingUrl")
      if (pending && session?.user) {
        sessionStorage.removeItem("pendingUrl")
        handleSave(pending, isViaShareSheet)
      }
    })
    supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        posthog.identify(session.user.id)
        fetchTodaySaves()
        fetchLibraryFilters()
        fetchSuggestions()
        fetchSaveCount()
        if (!localStorage.getItem('recall_onboarded')) {
          const isStandalone = window.matchMedia('(display-mode: standalone)').matches
          if (isStandalone || localStorage.getItem('recall_onboarding_install')) {
            setOnboardingStep('firstSave')
            setFirstSaveSheetOpen(true)
            setView('save')
          } else {
            setOnboardingStep('install')
          }
        }
      }
      const pending = sessionStorage.getItem("pendingUrl")
      if (pending && session?.user) {
        sessionStorage.removeItem("pendingUrl")
        handleSave(pending, isViaShareSheet)
      }
    })
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
    setOnboardingStep(null)
    localStorage.removeItem("recall_recent_searches")
    sessionStorage.removeItem("recall_last_query")
    sessionStorage.removeItem("recall_last_results")
    sessionStorage.removeItem("recall_suggestions")
    setRecentSearches([])
    setSuggestedChips(null)
    setHasSearched(false)
    setResults([])
    setQuery("")
    setSelectedTag(null)
    posthog.reset()
  }

  const deleteAccount = async () => {
    setDeletingAccount(true)
    try {
      const token = await getToken()
      await fetch(`${BACKEND}/account`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      })
      posthog.capture('account_deleted')
      posthog.reset()
      await supabase.auth.signOut()
      setUser(null)
      setShowSettings(false)
      setConfirmDeleteAccount(false)
      localStorage.clear()
      sessionStorage.clear()
    } catch {
      setDeletingAccount(false)
      setConfirmDeleteAccount(false)
    }
    setDeletingAccount(false)
  }

  const advanceOnboarding = (step) => {
    if (step === 'install') {
      localStorage.setItem('recall_onboarding_install', 'true')
      setOnboardingStep('firstSave')
      setFirstSaveSheetOpen(true)
      setView('save')
    } else if (step === 'firstSave') {
      localStorage.setItem('recall_onboarding_save', 'true')
      setFirstSaveSheetOpen(false)
      setOnboardingStep('firstSearch')
    } else if (step === 'firstSearch') {
      localStorage.setItem('recall_onboarding_search', 'true')
      localStorage.setItem('recall_onboarded', 'true')
      setOnboardingStep('done')
    }
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
    posthog.capture('title_edited')
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
    posthog.capture('tag_edited')
  }

  const deleteSave = async (id) => {
    setConfirmDeleteId(null)
    setDeletingId(id)
    const token = await getToken()
    await fetch(`${BACKEND}/save/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    })
    setTodaySaves(prev => prev.filter(s => s.id !== id))
    if (saveReceipt?.id === id) setSaveReceipt(null)
    posthog.capture('save_deleted')
    setDeletingId(null)
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
      if (data.media) {
        setSaveReceipt({ media: true, content_type: data.content_type, label: data.label, title: data.title, tag: data.tag, id: data.id, url, fromShareSheet })
        fetchTodaySaves()
        fetchLibraryFilters()
        posthog.capture('url_saved', { tag: data.tag, type: data.content_type })
        setLoading(false)
        return
      }
      if (data.thin_content) {
        setSaveReceipt({ thin_content: true, url })
        setLoading(false)
        return
      }
      if (data.duplicate) {
        setSaveReceipt({ ...data, url, duplicate: true })
      } else {
        setUrlInput("")
        const newCount = first5Count < 5 ? first5Count + 1 : first5Count
        if (first5Count < 5) setFirst5Count(newCount)
        setSaveReceipt({ title: data.title, tag: data.tag, id: data.id, url, fromShareSheet, milestoneCount: first5Count < 5 ? newCount : null })
        fetchTodaySaves()
        fetchLibraryFilters()
        posthog.capture('url_saved', { tag: data.tag })
        playSuccessChime()
        if (newCount === 5 && first5Count < 5) {
          setTimeout(() => playSuccessChime(), 200)
          navigator.vibrate?.([50, 80, 50, 80, 100])
          setIsFreshReceipt(true)
          setTimeout(() => setIsFreshReceipt(false), 3000)
        } else {
          navigator.vibrate?.([50])
          setIsFreshReceipt(true)
          setTimeout(() => setIsFreshReceipt(false), first5Count >= 2 ? 2000 : 1500)
        }
        if (onboardingStep === 'firstSave') {
          setFirstSaveSheetOpen(false)
          setTimeout(() => advanceOnboarding('firstSave'), 600)
        }
      }
    } catch {
      setSaveReceipt(null)
      setMessage(`Failed to save from ${getSourceLabel(url)}. Try again.`)
      setIsError(true)
    }
    setLoading(false)
  }

  const handleSearch = async (overrideQuery) => {
    const q = (overrideQuery ?? query).trim()
    if (!q) return
    if (onboardingStep === 'firstSearch') advanceOnboarding('firstSearch')
    setLoading(true)
    setSelectedSource(null)
    setSelectedTag(null)
    setHasSearched(true)
    setDisplayCount(5)
    setRecentSearches(prev => {
      const updated = [q, ...prev.filter(s => s !== q)].slice(0, 5)
      localStorage.setItem("recall_recent_searches", JSON.stringify(updated))
      return updated
    })
    try {
      const token = await getToken()
      const res = await fetch(`${BACKEND}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, token })
      })
      const data = await res.json()
      setResults(data.results)
      posthog.capture('search_performed', { result_count: data.results.length })
      sessionStorage.setItem("recall_last_query", q)
      sessionStorage.setItem("recall_last_results", JSON.stringify(data.results))
    } catch {
      setResults([])
    }
    setLoading(false)
  }

  if (authLoading) return null

  if (view === 'legal') {
    return (
      <div style={styles.container}>
        <div style={{ display: "flex", alignItems: "center", padding: "20px 0 16px" }}>
          <button
            onClick={() => { setView('search'); window.history.pushState({}, '', '/') }}
            style={styles.backButton}
          >← Back</button>
          <div style={{ display: "flex", gap: "12px", marginLeft: "auto" }}>
            <button
              onClick={() => setLegalSection('privacy')}
              style={legalSection === 'privacy' ? styles.tabActive : styles.tab}
            >Privacy</button>
            <button
              onClick={() => setLegalSection('terms')}
              style={legalSection === 'terms' ? styles.tabActive : styles.tab}
            >Terms</button>
          </div>
        </div>
        <div style={styles.legalContent}>
          {legalSection === 'privacy' ? (
            <>
              <h2 style={styles.legalTitle}>Privacy Policy</h2>
              <p style={styles.legalMeta}>Last updated: April 2026</p>
              <h3 style={styles.legalH3}>What we collect</h3>
              <p style={styles.legalP}>When you save a URL, we store: the URL itself, the text content extracted from the page (up to 5,000 characters), an AI-generated title, a category tag, and a mathematical embedding (a 768-number vector) used to enable semantic search. We do not store passwords — authentication is handled by Google via Supabase Auth.</p>
              <h3 style={styles.legalH3}>Why we collect it</h3>
              <p style={styles.legalP}>All data is used exclusively to power ReCall's save and search features. Embeddings are used to find semantically similar content when you search. No data is used for advertising or sold to third parties.</p>
              <h3 style={styles.legalH3}>Who can see your data</h3>
              <p style={styles.legalP}>Only you. Your saves are protected by Supabase Row Level Security — database policies enforce that each user can only read and write their own rows. We do not share your saved content with other users or third parties.</p>
              <h3 style={styles.legalH3}>Third-party services</h3>
              <p style={styles.legalP}>We use Google (OAuth sign-in), Supabase (database and auth), Google Gemini (AI title generation and embeddings), PostHog (anonymous product analytics), and Sentry (error monitoring). PostHog receives your Supabase user ID (not your name or email) and event names only. Sentry receives anonymised error traces.</p>
              <h3 style={styles.legalH3}>Deleting your data</h3>
              <p style={styles.legalP}>You can delete your account and all associated data at any time from the app settings (⚙ icon in the header). This permanently removes all your saves and your account record.</p>
              <h3 style={styles.legalH3}>Contact</h3>
              <p style={styles.legalP}>Questions? Email the developer at the address on the GitHub profile linked from this project.</p>
            </>
          ) : (
            <>
              <h2 style={styles.legalTitle}>Terms of Service</h2>
              <p style={styles.legalMeta}>Last updated: April 2026</p>
              <h3 style={styles.legalH3}>Use of the service</h3>
              <p style={styles.legalP}>ReCall is a personal bookmark and search tool. You may use it to save and search public web content for your own personal, non-commercial use. You are responsible for the URLs you save and for ensuring you have the right to access the content at those URLs.</p>
              <h3 style={styles.legalH3}>Acceptable use</h3>
              <p style={styles.legalP}>Do not use ReCall to scrape, harvest, or systematically archive content in violation of a site's terms of service. Do not attempt to circumvent rate limits or access other users' data. Do not use the service to store illegal content.</p>
              <h3 style={styles.legalH3}>Availability</h3>
              <p style={styles.legalP}>ReCall is provided as-is, as a portfolio project. We make no guarantees of uptime, data retention, or continued availability. We reserve the right to shut down or modify the service at any time.</p>
              <h3 style={styles.legalH3}>Liability</h3>
              <p style={styles.legalP}>ReCall is not liable for any loss of data, service interruptions, or damages arising from your use of the service. Use it at your own risk.</p>
              <h3 style={styles.legalH3}>Changes</h3>
              <p style={styles.legalP}>These terms may be updated at any time. Continued use of the service constitutes acceptance of the updated terms.</p>
            </>
          )}
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div style={styles.container}>
        <div style={styles.hero}>
          <h1 style={styles.logo}>ReCall</h1>
          <p style={styles.heroTagline}>Your saved internet,<br />on recall.</p>
          <p style={styles.heroBody}>Save links from any app. Search them later in plain English.</p>
          <div style={styles.mockCards}>
            {[
              { tag: "TECH", title: "The science of deep work · Cal Newport" },
              { tag: "PRODUCT", title: "Why Apple is betting on spatial computing" },
              { tag: "BUSINESS", title: "How to raise a seed round in 2024" },
            ].map(c => (
              <div key={c.tag} style={styles.mockCard}>
                <span style={styles.mockCardTag}>{c.tag}</span>
                <span style={styles.mockCardTitle}>{c.title}</span>
              </div>
            ))}
          </div>
          <button onClick={signIn} style={styles.button}>
            Sign in with Google
          </button>
          <div style={styles.legalFooter}>
            <button onClick={() => { setLegalSection('privacy'); setView('legal') }} style={styles.legalFooterLink}>Privacy Policy</button>
            <span style={{ color: "#333" }}>·</span>
            <button onClick={() => { setLegalSection('terms'); setView('legal') }} style={styles.legalFooterLink}>Terms</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.logoSmall}>ReCall</h1>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button onClick={() => { setShowSettings(s => !s); setConfirmDeleteAccount(false) }} style={styles.signOut} title="Settings">⚙</button>
          <button onClick={signOut} style={styles.signOut}>Sign out</button>
        </div>
      </div>

      {showSettings && (
        <div style={styles.settingsPanel}>
          <div style={styles.settingsLinks}>
            <button onClick={() => { setLegalSection('privacy'); setView('legal'); setShowSettings(false) }} style={styles.settingsLink}>Privacy Policy</button>
            <button onClick={() => { setLegalSection('terms'); setView('legal'); setShowSettings(false) }} style={styles.settingsLink}>Terms of Service</button>
          </div>
          <div style={styles.settingsDivider} />
          {!confirmDeleteAccount ? (
            <button onClick={() => setConfirmDeleteAccount(true)} style={styles.deleteAccountButton}>Delete account</button>
          ) : (
            <div style={styles.deleteAccountConfirm}>
              <p style={styles.deleteAccountWarning}>This permanently deletes all your saves. Cannot be undone.</p>
              <div style={{ display: "flex", gap: "8px" }}>
                <button onClick={deleteAccount} disabled={deletingAccount} style={styles.deleteAccountYes}>
                  {deletingAccount ? "Deleting…" : "Yes, delete"}
                </button>
                <button onClick={() => setConfirmDeleteAccount(false)} style={styles.deleteAccountNo}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      <div style={styles.tabs}>
        <button onClick={() => { setView("search") }} style={view === "search" ? styles.tabActive : styles.tab}>Search</button>
        <button onClick={() => { setView("save") }} style={view === "save" ? styles.tabActive : styles.tab}>Save</button>
      </div>

      {view === "search" && (
        <div style={styles.section}>

          {/* Search bar */}
          <div style={styles.searchBarWrapper}>
            <input
              ref={searchInputRef}
              style={styles.searchBarInput}
              placeholder="What are you looking for?"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSearch()}
              onFocus={() => setSearchInputFocused(true)}
              onBlur={() => setTimeout(() => setSearchInputFocused(false), 150)}
            />
            <button
              onClick={() => handleSearch()}
              style={styles.searchBarButton}
              disabled={loading}
              aria-label="Search"
            >🔍</button>
          </div>

          {/* Recent searches — shown when input focused + query empty */}
          {searchInputFocused && !loading && recentSearches.length > 0 && query.trim() === "" && (
            <div style={styles.recentSearchesBox}>
              <span style={styles.recentSearchesLabel}>Recent</span>
              <div style={styles.recentChips}>
                {recentSearches.map(s => (
                  <div key={s} style={styles.recentChipRow}>
                    <button
                      style={styles.recentChip}
                      onMouseDown={e => { e.preventDefault(); setQuery(s); handleSearch(s) }}
                    >{s}</button>
                    <button
                      style={styles.recentChipDismiss}
                      onMouseDown={e => {
                        e.preventDefault()
                        setRecentSearches(prev => {
                          const updated = prev.filter(r => r !== s)
                          localStorage.setItem("recall_recent_searches", JSON.stringify(updated))
                          return updated
                        })
                      }}
                    >×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Shimmer loading bar */}
          {loading && (
            <span className="shimmer" style={styles.searchShimmerBar} />
          )}

          {/* Empty state — personalised chips or new-user nudge */}
          {!hasSearched && !loading && (
            suggestedChips === null ? null : suggestedChips.length === 0 ? (
              <div style={styles.emptyState}>
                <p style={styles.emptyStateHint}>Nothing saved yet.</p>
                <button
                  style={styles.emptyStateCta}
                  onClick={() => setView("save")}
                >Save your first link →</button>
              </div>
            ) : (
              <div style={styles.emptyState}>
                <p style={styles.emptyStateHint}>Try searching for…</p>
                <div style={styles.exampleChips}>
                  {suggestedChips.map(chip => (
                    <button
                      key={chip}
                      style={styles.exampleChip}
                      onClick={() => { setQuery(chip); handleSearch(chip) }}
                    >{chip}</button>
                  ))}
                </div>
              </div>
            )
          )}

          {/* Zero-results state */}
          {hasSearched && !loading && results.length === 0 && (
            <div style={styles.zeroResults}>
              <p style={styles.zeroResultsMain}>Nothing found for "{query}"</p>
              <p style={styles.zeroResultsSub}>Try different words, or save more content.</p>
              <button
                style={styles.zeroResultsCta}
                onClick={() => setView("save")}
              >Save a page about this →</button>
            </div>
          )}

          {/* Filter dropdowns — always visible when library has variety */}
          {!loading && (libraryFilters.sources.length > 1 || libraryFilters.tags.length > 1) && (
            <div style={styles.filterRow}>
              {libraryFilters.sources.length > 1 && (
                <div style={styles.filterDropdownWrapper}>
                  <select
                    style={styles.filterDropdown}
                    value={selectedSource || ""}
                    onChange={e => {
                      const newSource = e.target.value || null
                      setSelectedSource(newSource)
                      setDisplayCount(5)
                      if (!query.trim()) browseByFilter(selectedTag, newSource)
                    }}
                  >
                    <option value="">All sources</option>
                    {libraryFilters.sources.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )}
              {libraryFilters.tags.length > 1 && (
                <div style={styles.filterDropdownWrapper}>
                  <select
                    style={styles.filterDropdown}
                    value={selectedTag || ""}
                    onChange={e => {
                      const newTag = e.target.value || null
                      setSelectedTag(newTag)
                      setDisplayCount(5)
                      if (!query.trim()) browseByFilter(newTag, selectedSource)
                    }}
                  >
                    <option value="">All tags</option>
                    {libraryFilters.tags.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Result cards + show more */}
          {results.length > 0 && !loading && (() => {
            const filtered = results.filter(r =>
              (!selectedSource || getSourceLabel(r.url) === selectedSource) &&
              (!selectedTag || r.tag === selectedTag)
            )
            const visible = filtered.slice(0, displayCount)
            return (
              <>
                <div style={styles.results}>
                  {visible.map(r => (
                    <a key={r.id} href={r.url} target="_blank" rel="noreferrer" style={styles.card}>
                      <div style={styles.cardMeta}>
                        <span style={styles.cardTag}>{r.tag}</span>
                        {r.created_at && <span style={styles.cardDate}>{formatDate(r.created_at)}</span>}
                      </div>
                      <div style={styles.cardTitle}>{r.title || getSourceLabel(r.url)}</div>
                      {r.excerpt && <div style={styles.cardExcerpt}>{r.excerpt}</div>}
                      <div style={styles.cardSource}>{getSourceLabel(r.url)}</div>
                    </a>
                  ))}
                </div>

                {filtered.length > displayCount && (
                  <button
                    style={styles.showMoreButton}
                    onClick={() => setDisplayCount(c => c + 5)}
                  >
                    Show {Math.min(5, filtered.length - displayCount)} more
                  </button>
                )}
              </>
            )
          })()}

        </div>
      )}

      {view === "save" && (
        <div style={styles.section}>
          {first5Count > 0 && first5Count < 5 && (
            <div style={styles.progressPill}>
              <span style={{ fontSize: "12px", color: "#fbbf24" }}>⚡ {first5Count} of 5 saves · ReCall is climbing your Share Sheet</span>
              <div style={styles.progressDotsRow}>
                {[1,2,3,4,5].map(i => (
                  <span key={i} style={i <= first5Count ? styles.dotFilledSmall : styles.dotEmptySmall} />
                ))}
              </div>
            </div>
          )}

          <input
            ref={urlInputRef}
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

          {saveReceipt?.media && (
            <div style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 12, padding: "16px 18px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span>{saveReceipt.content_type === "video" ? "🎥" : "📷"}</span>
                <span style={{ color: "#aaa", fontSize: 13, fontWeight: 600 }}>Saved to library</span>
              </div>
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
            </div>
          )}

          {saveReceipt?.thin_content && (
            <div style={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 12, padding: "16px 18px" }}>
              <p style={{ color: "#aaa", fontSize: 14, margin: 0 }}>
                Couldn't extract enough content from this link — it may require a login, or be mostly video or images.
              </p>
            </div>
          )}

          {saveReceipt && !saveReceipt.media && !saveReceipt.thin_content && (
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
                  {saveReceipt.milestoneCount && (
                    <div style={styles.milestoneRow}>
                      {saveReceipt.milestoneCount === 5 ? (
                        <>
                          <div style={styles.progressDotsRow}>
                            {[1,2,3,4,5].map(i => <span key={i} style={styles.dotFilled} />)}
                          </div>
                          <p style={styles.milestoneHeadline}>ReCall is at the top of your Share Sheet.</p>
                          <p style={styles.milestoneSub}>You'll never have to hunt for it again.</p>
                        </>
                      ) : (
                        <p style={styles.milestoneText}>
                          {saveReceipt.milestoneCount === 1 && "1/5 — 4 more to unlock the top of your Share Sheet"}
                          {saveReceipt.milestoneCount === 2 && "2/5 — building momentum ⚡"}
                          {saveReceipt.milestoneCount === 3 && "Halfway! 3/5 — ReCall is climbing 🔥"}
                          {saveReceipt.milestoneCount === 4 && "4/5 — one more and you're set"}
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {saveReceipt?.fromShareSheet && !saveReceipt.thin_content && !saveReceipt.optimistic && !saveReceipt.duplicate && (
            <a
              href={getAppScheme(saveReceipt.url) ?? undefined}
              onClick={e => {
                if (!getAppScheme(saveReceipt.url)) {
                  e.preventDefault()
                  window.history.back()
                }
              }}
              className="return-button-pulse"
              style={styles.returnButton}
            >
              ← Return to {getSourceLabel(saveReceipt.url)}
            </a>
          )}


          {message && <p style={isError ? styles.error : styles.success}>{message}</p>}

          {todaySaves.length > 0 && (
            <div style={styles.todaySection}>
              <p style={styles.todayHeader}>Today</p>
              <div style={styles.todayList}>
                {todaySaves.map(s => (
                  <a key={s.id} href={s.url} target="_blank" rel="noreferrer" style={styles.todayCard}>
                    {deletingId === s.id ? (
                      <span style={{ color: "#888", fontSize: 13, padding: "4px 0" }}>Removing…</span>
                    ) : confirmDeleteId === s.id ? (
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
                        {s.content_type === "video" ? (
                          <span style={{ ...styles.todayTag, color: "#666" }}>🎥 Video</span>
                        ) : s.content_type === "image" ? (
                          <span style={{ ...styles.todayTag, color: "#666" }}>📷 Image</span>
                        ) : (
                          <span style={styles.todayTag}>{s.tag}</span>
                        )}
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

          {onboardingStep === 'firstSave' && firstSaveSheetOpen && first5Count < 5 && (
            <div style={styles.bottomSheet}>
              <div style={styles.bottomSheetHandle} />
              <p style={styles.bottomSheetTitle}>
                {first5Count === 0 ? "Save your first link" : `${5 - first5Count} more to go`}
              </p>
              <p style={styles.bottomSheetBody}>
                5 saves and ReCall moves to the top of your Share Sheet — permanently.
              </p>
              <div style={styles.progressDotsRow}>
                {[1,2,3,4,5].map(i => (
                  <span key={i} style={i <= first5Count ? styles.dotFilled : styles.dotEmpty} />
                ))}
                <span style={styles.progressLabel}>{first5Count} of 5</span>
              </div>
              <button
                style={{ ...styles.button, marginTop: "4px" }}
                onClick={() => { setFirstSaveSheetOpen(false); setTimeout(() => urlInputRef.current?.focus(), 100) }}
              >I'll paste a link</button>
            </div>
          )}
        </div>
      )}

      {/* Install onboarding overlay */}
      {onboardingStep === 'install' && (
        <div style={styles.overlay}>
          <div style={styles.overlayCard}>
            <div style={{ fontSize: "36px", marginBottom: "4px" }}>📱</div>
            <p style={styles.overlayTitle}>Get the full experience</p>
            <p style={styles.overlayBody}>
              ReCall's Share Sheet feature — saving from any app — needs the installed version.
            </p>
            <div style={styles.overlaySteps}>
              {isIOS ? (
                <>
                  <p style={styles.overlayStep}>① Tap the <strong>Share</strong> icon in Safari</p>
                  <p style={styles.overlayStep}>② Tap <strong>"Add to Home Screen"</strong></p>
                  <p style={styles.overlayStep}>③ Tap <strong>"Add"</strong></p>
                  <p style={styles.overlayNote}>Share Sheet isn't available on iOS — you can still paste links directly.</p>
                </>
              ) : (
                <>
                  <p style={styles.overlayStep}>① Tap <strong>⋮</strong> in Chrome</p>
                  <p style={styles.overlayStep}>② Tap <strong>"Add to Home Screen"</strong></p>
                  <p style={styles.overlayStep}>③ Tap <strong>"Add"</strong></p>
                </>
              )}
            </div>
            <button style={styles.button} onClick={() => advanceOnboarding('install')}>
              Done, I've installed it
            </button>
            <button style={styles.overlaySkip} onClick={() => advanceOnboarding('install')}>
              Skip for now
            </button>
          </div>
        </div>
      )}

      {/* Search nudge toast */}
      {onboardingStep === 'firstSearch' && (
        <div style={styles.nudgeToast}>
          <span style={styles.nudgeText}>Your link is saved. Try searching.</span>
          <button
            style={styles.nudgeCta}
            onClick={() => { advanceOnboarding('firstSearch'); setView('search'); setTimeout(() => searchInputRef.current?.focus(), 100) }}
          >Search now →</button>
          <button style={styles.nudgeDismiss} onClick={() => advanceOnboarding('firstSearch')}>✕</button>
        </div>
      )}

      <div style={styles.legalFooter}>
        <button onClick={() => { setLegalSection('privacy'); setView('legal') }} style={styles.legalFooterLink}>Privacy Policy</button>
        <span style={{ color: "#333" }}>·</span>
        <button onClick={() => { setLegalSection('terms'); setView('legal') }} style={styles.legalFooterLink}>Terms</button>
      </div>
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
  returnButton: { display: "block", background: "none", border: "1px solid rgba(255,255,255,0.25)", color: "#fff", borderRadius: "12px", padding: "13px 14px", fontSize: "14px", fontWeight: "500", cursor: "pointer", width: "100%", textAlign: "center", boxSizing: "border-box", textDecoration: "none" },
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

  // Unified search bar
  searchBarWrapper: { position: "relative", display: "flex", alignItems: "center", width: "100%", boxSizing: "border-box" },
  searchBarInput: { width: "100%", padding: "14px 52px 14px 16px", background: "#1a1a1a", border: "1px solid #333", borderRadius: "12px", color: "#fff", fontSize: "16px", boxSizing: "border-box", outline: "none" },
  searchBarButton: { position: "absolute", right: "10px", background: "none", border: "none", cursor: "pointer", fontSize: "18px", padding: "4px", lineHeight: 1, color: "#888" },

  // Recent searches
  recentSearchesBox: { background: "#1a1a1a", border: "1px solid #333", borderRadius: "12px", padding: "12px 16px", display: "flex", flexDirection: "column", gap: "8px" },
  recentSearchesLabel: { fontSize: "11px", color: "#555", textTransform: "uppercase", letterSpacing: "1px" },
  recentChips: { display: "flex", flexDirection: "column", gap: "4px" },
  recentChipRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
  recentChip: { background: "none", border: "none", color: "#ccc", cursor: "pointer", fontSize: "14px", padding: "4px 0", textAlign: "left", flex: 1 },
  recentChipDismiss: { background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: "16px", padding: "0 4px", lineHeight: 1, flexShrink: 0 },

  // Shimmer loading bar
  searchShimmerBar: { display: "block", width: "100%", height: "4px", borderRadius: "4px", background: "linear-gradient(90deg, #2a2a2a 0%, #444 50%, #2a2a2a 100%)" },

  // Empty state
  emptyState: { display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", marginTop: "16px" },
  emptyStateHint: { fontSize: "13px", color: "#555", margin: 0 },
  exampleChips: { display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center" },
  exampleChip: { background: "none", border: "1px solid #333", color: "#888", padding: "8px 16px", borderRadius: "20px", cursor: "pointer", fontSize: "13px" },

  // Zero results
  zeroResults: { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", marginTop: "24px" },
  zeroResultsMain: { fontSize: "15px", color: "#aaa", fontWeight: "600", margin: 0, textAlign: "center" },
  zeroResultsSub: { fontSize: "13px", color: "#555", margin: 0, textAlign: "center" },

  // Updated card (cardTitle overrides the earlier definition; cardUrl/cardScore are now dead)
  cardMeta: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" },
  cardDate: { fontSize: "11px", color: "#555" },
  cardTitle: { fontSize: "15px", fontWeight: "600", marginBottom: "4px", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" },
  cardSource: { fontSize: "12px", color: "#555" },

  // Show more
  showMoreButton: { background: "none", border: "1px solid #333", color: "#888", padding: "10px 20px", borderRadius: "20px", cursor: "pointer", fontSize: "14px", alignSelf: "center" },

  // Empty state CTA (new-user nudge)
  emptyStateCta: { background: "none", border: "none", color: "#888", fontSize: "14px", cursor: "pointer", padding: 0, textDecoration: "underline", textDecorationColor: "#444" },

  // Zero results CTA
  zeroResultsCta: { background: "none", border: "1px solid #333", color: "#888", padding: "10px 20px", borderRadius: "20px", cursor: "pointer", fontSize: "14px", marginTop: "8px" },

  // Filter dropdowns
  filterRow: { display: "flex", gap: "8px", flexWrap: "wrap" },
  filterDropdownWrapper: { position: "relative", flexShrink: 0 },
  filterDropdown: { appearance: "none", WebkitAppearance: "none", background: "#1a1a1a", border: "1px solid #333", color: "#888", padding: "7px 32px 7px 12px", borderRadius: "20px", fontSize: "13px", cursor: "pointer", backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23555'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center" },

  // Card excerpt
  cardExcerpt: { fontSize: "13px", color: "#666", lineHeight: 1.5, marginBottom: "6px", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" },

  // Hero redesign
  heroTagline: { fontSize: "28px", fontWeight: "700", textAlign: "center", lineHeight: 1.25, margin: 0, letterSpacing: "-0.5px", color: "#fff" },
  heroBody: { fontSize: "15px", color: "#888", textAlign: "center", margin: 0, maxWidth: "280px" },
  mockCards: { display: "flex", flexDirection: "column", gap: "8px", width: "100%", maxWidth: "340px", opacity: 0.55, pointerEvents: "none" },
  mockCard: { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "10px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "4px", textAlign: "left" },
  mockCardTag: { fontSize: "10px", color: "#555", textTransform: "uppercase", letterSpacing: "1px" },
  mockCardTitle: { fontSize: "14px", fontWeight: "600", color: "#ccc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },

  // Install overlay
  overlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.88)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: "24px", boxSizing: "border-box" },
  overlayCard: { background: "#1a1a1a", border: "1px solid #333", borderRadius: "20px", padding: "28px 24px", display: "flex", flexDirection: "column", gap: "14px", width: "100%", maxWidth: "360px", textAlign: "center" },
  overlayTitle: { fontSize: "22px", fontWeight: "700", margin: 0, color: "#fff" },
  overlayBody: { fontSize: "14px", color: "#888", margin: 0, lineHeight: 1.5 },
  overlaySteps: { display: "flex", flexDirection: "column", gap: "6px", textAlign: "left", background: "#111", borderRadius: "12px", padding: "14px 16px" },
  overlayStep: { fontSize: "14px", color: "#ccc", margin: 0, lineHeight: 1.6 },
  overlayNote: { fontSize: "12px", color: "#555", margin: "4px 0 0", lineHeight: 1.5 },
  overlaySkip: { background: "none", border: "none", color: "#555", fontSize: "13px", cursor: "pointer", padding: "4px" },

  // Progress pill (Save tab, saves 1–4)
  progressPill: { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", padding: "10px 14px", background: "rgba(251,191,36,0.07)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: "12px" },
  progressDotsRow: { display: "flex", alignItems: "center", gap: "6px" },
  dotFilled: { display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", background: "#fbbf24", flexShrink: 0 },
  dotEmpty: { display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", background: "#2a2a2a", border: "1px solid #444", flexShrink: 0 },
  dotFilledSmall: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: "#fbbf24", flexShrink: 0 },
  dotEmptySmall: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: "#2a2a2a", border: "1px solid #444", flexShrink: 0 },
  progressLabel: { fontSize: "12px", color: "#888", marginLeft: "2px" },

  // First-save bottom sheet
  bottomSheet: { position: "fixed", bottom: 0, left: 0, right: 0, background: "#1a1a1a", border: "1px solid #333", borderTopLeftRadius: "20px", borderTopRightRadius: "20px", padding: "16px 24px 36px", display: "flex", flexDirection: "column", gap: "12px", zIndex: 50, animation: "slideUp 0.3s ease-out" },
  bottomSheetHandle: { width: "36px", height: "4px", background: "#444", borderRadius: "2px", alignSelf: "center", marginBottom: "4px" },
  bottomSheetTitle: { fontSize: "20px", fontWeight: "700", margin: 0, color: "#fff" },
  bottomSheetBody: { fontSize: "14px", color: "#888", margin: 0, lineHeight: 1.5 },

  // Search nudge toast
  nudgeToast: { position: "fixed", top: "16px", left: "16px", right: "16px", background: "#1e1e1e", border: "1px solid #333", borderRadius: "14px", padding: "12px 14px", display: "flex", alignItems: "center", gap: "10px", zIndex: 50, animation: "slideDown 0.3s ease-out", boxShadow: "0 4px 24px rgba(0,0,0,0.6)" },
  nudgeText: { fontSize: "14px", color: "#ccc", flex: 1 },
  nudgeCta: { background: "#fff", border: "none", color: "#000", borderRadius: "8px", padding: "6px 12px", fontSize: "13px", fontWeight: "600", cursor: "pointer", flexShrink: 0 },
  nudgeDismiss: { background: "none", border: "none", color: "#555", fontSize: "18px", cursor: "pointer", padding: "0 4px", lineHeight: 1, flexShrink: 0 },

  // Milestone receipt row
  milestoneRow: { display: "flex", flexDirection: "column", gap: "6px", paddingTop: "10px", borderTop: "1px solid #2a2a2a" },
  milestoneText: { fontSize: "12px", color: "#fbbf24", margin: 0 },
  milestoneHeadline: { fontSize: "14px", fontWeight: "700", color: "#fff", margin: 0 },
  milestoneSub: { fontSize: "12px", color: "#888", margin: 0 },

  // Settings panel
  settingsPanel: { background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "12px", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px", marginBottom: "4px" },
  settingsLinks: { display: "flex", gap: "8px", flexWrap: "wrap" },
  settingsLink: { background: "none", border: "1px solid #333", color: "#888", padding: "6px 14px", borderRadius: "20px", cursor: "pointer", fontSize: "13px" },
  settingsDivider: { height: "1px", background: "#2a2a2a" },
  deleteAccountButton: { background: "none", border: "1px solid #ef4444", color: "#ef4444", padding: "7px 16px", borderRadius: "8px", cursor: "pointer", fontSize: "13px", alignSelf: "flex-start" },
  deleteAccountConfirm: { display: "flex", flexDirection: "column", gap: "10px" },
  deleteAccountWarning: { fontSize: "13px", color: "#aaa", margin: 0, lineHeight: 1.4 },
  deleteAccountYes: { background: "#ef4444", border: "none", color: "#fff", borderRadius: "8px", padding: "7px 16px", fontSize: "13px", fontWeight: "600", cursor: "pointer", flexShrink: 0 },
  deleteAccountNo: { background: "none", border: "1px solid #333", color: "#888", borderRadius: "8px", padding: "7px 14px", fontSize: "13px", cursor: "pointer", flexShrink: 0 },

  // Legal view
  legalContent: { display: "flex", flexDirection: "column", gap: "0", paddingBottom: "40px" },
  legalTitle: { fontSize: "24px", fontWeight: "700", color: "#fff", margin: "0 0 4px", letterSpacing: "-0.5px" },
  legalMeta: { fontSize: "12px", color: "#555", margin: "0 0 20px" },
  legalH3: { fontSize: "14px", fontWeight: "600", color: "#ccc", margin: "20px 0 6px" },
  legalP: { fontSize: "14px", color: "#888", lineHeight: 1.6, margin: 0 },
  backButton: { background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: "14px", padding: "4px 0" },

  // Legal footer
  legalFooter: { display: "flex", justifyContent: "center", alignItems: "center", gap: "8px", padding: "24px 0 16px", marginTop: "8px" },
  legalFooterLink: { background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: "12px", padding: 0 },
}
