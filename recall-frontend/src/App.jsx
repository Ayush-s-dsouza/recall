import { useState, useEffect, useRef } from "react"
import { createClient } from "@supabase/supabase-js"
import posthog from './posthog-lazy.js'
import { FeatureTour, HelpMenuButton } from "./features/tour"

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
const HAS_SUPABASE_CONFIG = !!(SUPABASE_URL && SUPABASE_ANON_KEY)
const supabase = HAS_SUPABASE_CONFIG
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null

const BACKEND = import.meta.env.VITE_BACKEND_URL
const TWITTER_CLIENT_ID = import.meta.env.VITE_TWITTER_CLIENT_ID
const MCP_TUTORIAL_VIDEO_URL = "/tour/mcp-memory-tutorial.mp4"
const MCP_TUTORIAL_STATUS_KEY = "recall_mcp_tutorial_status"

// Bookmarklet: scrapes tweet IDs from x.com/i/bookmarks (the user's own authenticated
// session, client-side only) and opens a new tab to ReCall with the collected IDs in
// the URL hash. No X API involved — works around the paid-tier requirement for v2 reads.
// Kept as a readable multi-line template, then flattened to one line below — multi-line
// javascript: URIs are unreliable when dragged to a bookmarks bar in some browsers.
const BOOKMARKLET_SCRIPT = `(function(){
  var RECALL_URL='${typeof window !== "undefined" ? window.location.origin : "https://recall-iota-six.vercel.app"}/';
  var win=null;
  try{ win=window.open('about:blank','_blank'); }catch(e){}
  if(win){ try{ win.document.write('<title>ReCall</title><body style="background:#0f0f0f;color:#4ade80;font-family:monospace;padding:40px;text-align:center;font-size:16px">Collecting your X bookmarks…<br>This tab will redirect automatically.</body>'); }catch(e){} }
  try{ window.focus(); }catch(e){}
  var ids=new Set();
  var lastCount=-1, stableRounds=0;
  var overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:10px;right:10px;background:#000;color:#4ade80;padding:10px 16px;border-radius:8px;font-family:monospace;font-size:14px;z-index:999999;border:1px solid #4ade80';
  document.body.appendChild(overlay);
  function update(){ overlay.textContent='ReCall: collected '+ids.size+' bookmarks…'; }
  function addFromHref(href){
    var m=href.match(/status\\/(\\d+)/);
    if(m) ids.add(m[1]);
  }
  function scan(){
    var articles=document.querySelectorAll('article[data-testid="tweet"]');
    if(articles.length===0){
      document.querySelectorAll('a[href*="/status/"]').forEach(function(a){ addFromHref(a.href); });
    } else {
      articles.forEach(function(article){
        var a=article.querySelector('a[href*="/status/"]');
        if(a) addFromHref(a.href);
      });
    }
    update();
  }
  function finish(){
    overlay.textContent='ReCall: found '+ids.size+' bookmarks. Opening…';
    var idList=Array.from(ids).join(',');
    var target=RECALL_URL+'#import_tweets='+idList;
    if(win && !win.closed){ win.location.href=target; } else { window.open(target, '_blank'); }
    setTimeout(function(){ overlay.remove(); }, 3000);
  }
  function step(){
    try{ window.focus(); }catch(e){}
    scan();
    if(ids.size>=500){ finish(); return; }
    var nearBottom=(window.innerHeight+window.scrollY)>=(document.body.scrollHeight-100);
    if(nearBottom){
      if(ids.size===lastCount){ stableRounds++; } else { stableRounds=0; lastCount=ids.size; }
      if(stableRounds>=5){ finish(); return; }
    }
    window.scrollTo(0, document.body.scrollHeight);
    setTimeout(step, 800);
  }
  if(ids.size===0) update();
  step();
})();`
const BOOKMARKLET_CODE = "javascript:" + BOOKMARKLET_SCRIPT.replace(/\s+/g, " ").trim()

// Same technique, applied to LinkedIn's "My items > Saved posts" page. Collects full
// post URLs (not just IDs, since LinkedIn permalinks vary in shape) via #import_urls=.
const LINKEDIN_BOOKMARKLET_SCRIPT = `(function(){
  var RECALL_URL='${typeof window !== "undefined" ? window.location.origin : "https://recall-iota-six.vercel.app"}/';
  var postsById=new Map();
  var lastCount=-1, stableRounds=0, iterations=0;
  var overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:10px;right:10px;background:#000;color:#0a66c2;padding:10px 16px;border-radius:8px;font-family:monospace;font-size:14px;z-index:999999;border:1px solid #0a66c2';
  document.body.appendChild(overlay);
  function update(){
    overlay.textContent='ReCall: collected '+postsById.size+' saved posts… (this tab will redirect to ReCall when done)';
  }
  function clean(href){
    try { var u=new URL(href); return u.origin+u.pathname; } catch(e){ return href; }
  }
  function activityId(str){
    var m=str.match(/activity[:-](\\d+)/);
    return m ? m[1] : null;
  }
  function scan(){
    document.querySelectorAll('a[href]').forEach(function(a){
      try {
        var path=new URL(a.href).pathname;
        if(/^\\/posts\\//.test(path) || /^\\/feed\\/update\\//.test(path) || /^\\/pulse\\//.test(path)){
          var cleaned=clean(a.href);
          var id=activityId(cleaned)||cleaned;
          if(!postsById.has(id)) postsById.set(id, cleaned);
        }
      } catch(e){}
    });
    document.querySelectorAll('[data-chameleon-result-urn], [data-urn]').forEach(function(el){
      var urn=el.getAttribute('data-chameleon-result-urn')||el.getAttribute('data-urn')||'';
      var m=urn.match(/urn:li:activity:(\\d+)/);
      if(m && !postsById.has(m[1])){
        postsById.set(m[1], 'https://www.linkedin.com/feed/update/urn:li:activity:'+m[1]+'/');
      }
    });
    update();
  }
  function clickShowMore(){
    var els=document.querySelectorAll('button');
    for(var i=0;i<els.length;i++){
      var t=(els[i].textContent||'').trim().toLowerCase();
      if(t==='show more results'){
        els[i].click();
        return true;
      }
    }
    return false;
  }
  function finish(){
    overlay.textContent='ReCall: found '+postsById.size+' saved posts. Opening ReCall…';
    var encoded=Array.from(postsById.values()).map(encodeURIComponent).join(',');
    var target=RECALL_URL+'#import_urls='+encoded;
    setTimeout(function(){ window.location.href=target; }, 1200);
  }
  function step(){
    scan();
    iterations++;
    if(postsById.size===lastCount){ stableRounds++; } else { stableRounds=0; lastCount=postsById.size; }
    if((stableRounds>=10 && iterations>=80) || postsById.size>=500 || iterations>=160){ finish(); return; }
    var clicked=clickShowMore();
    window.scrollTo(0, document.body.scrollHeight);
    setTimeout(step, clicked ? 1400 : 900);
  }
  if(postsById.size===0) update();
  step();
})();`
const LINKEDIN_BOOKMARKLET_CODE = "javascript:" + LINKEDIN_BOOKMARKLET_SCRIPT.replace(/\s+/g, " ").trim()

const SHARE_SHEET_VIDEO_URL = null // replace with YouTube URL when ready
const SAVE_TO_RECALL_SHORTCUT_URL = "https://www.icloud.com/shortcuts/fd37dd0550924fafb19a0f984ded9825" // "Save to ReCall" shortcut — regenerate via Shortcuts app → long-press → Share → Copy iCloud Link if ever rebuilt
const EMAIL_INBOUND_ADDRESS = import.meta.env.VITE_EMAIL_INBOUND_ADDRESS || "" // shared CloudMailin inbound address for newsletter forwarding — same address for every user, matched to an account by sender email
const LOADING_STEPS = ["Fetching...", "Reading...", "Analyzing...", "Almost there..."]
const PRE_SIGNUP_TOUR_STEPS = [
  {
    id: "pre-signup-save",
    highlight: "sign-in",
    targetSelector: '[data-tour="sign-in-button"]',
    eyebrow: "Saved",
    title: "Sign in to use this memory",
    description: "Your first save is ready. Sign in with Google to keep it, search across it, and let an LLM use it as context.",
    videoSrc: "/tour/recall-search.mp4",
    poster: "",
    primaryLabel: "Got it",
  },
]

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
      url.includes("notion.so") || url.includes("notion.site") || url.includes("app.notion.com") ? "notion.id" :
      null
    if (!pkg) return null
    return `intent://${host}${pathname}${search}#Intent;scheme=https;package=${pkg};end`
  } catch {
    return null
  }
}

// Standard Web Push boilerplate: PushManager.subscribe() needs the VAPID public key
// as a Uint8Array, not the base64url string it's distributed as.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

function formatDate(isoString) {
  if (!isoString) return ""
  try {
    return new Date(isoString).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  } catch { return "" }
}

function formatRelativeTime(isoString) {
  if (!isoString) return "just now"
  try {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000))
    if (seconds < 60) return "just now"
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d ago`
    return formatDate(isoString)
  } catch {
    return "just now"
  }
}

function getSiteName(url) {
  if (!url) return "page"
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return getSourceLabel(url).toLowerCase()
  }
}

function renderSourceTile(save) {
  // Video/image saves now carry real content (YouTube transcripts, Instagram captions —
  // see CLAUDE.md's video-support round) and can surface anywhere an article could, so the
  // meta-row tile distinguishes them: a real thumbnail + play badge for YouTube (the only
  // source with a fetchable, non-hotlink-blocked thumbnail), a generic play glyph for other
  // video (Instagram Reels — no thumbnail available, see Known Issue), a generic image glyph
  // for Instagram posts, and the plain gradient tile for everything else (unchanged).
  if (save?.content_type === "video" && save?.thumbnail_url) {
    return (
      <span style={styles.savedArticleThumbWrap}>
        <img src={save.thumbnail_url} alt="" style={styles.savedArticleThumbImg} />
        <span style={styles.savedArticlePlayBadge}>▶</span>
      </span>
    )
  }
  if (save?.content_type === "video") {
    return <span style={styles.savedArticleSourceTile}><span style={styles.savedArticleTileGlyph}>▶</span></span>
  }
  if (save?.content_type === "image") {
    return <span style={styles.savedArticleSourceTile}><span style={styles.savedArticleTileGlyph}>◱</span></span>
  }
  return <span style={styles.savedArticleSourceTile} />
}

function getSaveCaption(save) {
  const content = (save?.excerpt || save?.content_text || "").replace(/\s+/g, " ").trim()
  if (content) {
    const clipped = content.length > 170 ? content.slice(0, 170).replace(/\s+\S*$/, "") + "..." : content
    return clipped
  }
  const source = getSourceLabel(save?.url)
  if (save?.status === "pending") return `ReCall is reading this ${source} save and preparing its summary.`
  return `Saved from ${source}. ReCall will use this context when you search your library.`
}

function getSourceLabel(url) {
  if (!url) return "Page"
  if (url.includes("twitter.com") || url.includes("x.com")) return "X (Twitter)"
  if (url.includes("linkedin.com")) return "LinkedIn"
  if (url.includes("reddit.com")) return "Reddit"
  if (url.includes("notion.so") || url.includes("notion.site") || url.includes("app.notion.com")) return "Notion"
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "YouTube"
  if (url.includes("substack.com")) return "Substack"
  try {
    const host = new URL(url).hostname.replace("www.", "")
    return host.charAt(0).toUpperCase() + host.slice(1)
  } catch {
    return "Page"
  }
}

function FolderIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function TrashIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  )
}

function SearchIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function ClearIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function LinkIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.43" />
      <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07l1.33-1.33" />
    </svg>
  )
}

function PlugIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" />
    </svg>
  )
}

function GearIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 16 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.37.45.7.8 1 .32.26.7.4 1.1.4H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.6Z" />
    </svg>
  )
}

function ArrowRightIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function TagIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3H4a1 1 0 0 0-1 1v5.59A2 2 0 0 0 3.59 11l9.59 9.59a2 2 0 0 0 2.82 0L20.59 16a2 2 0 0 0 0-2.59Z" />
      <path d="M7 7h.01" />
    </svg>
  )
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
    if (path === '/mcp/consent') return 'mcp-consent'
    const stored = sessionStorage.getItem("recall_view")
    return (stored === "search" || stored === "save" || stored === "recall") ? stored : "search"
  })
  // Captured once at mount (keyed off pathname, not just presence of params) so it
  // never gets confused with the X/Twitter OAuth callback, which also lands on "/"
  // with its own code/state. Falls back to a sessionStorage copy when the URL has
  // no query string at all — Supabase's redirectTo doesn't reliably round-trip a
  // long, heavily-encoded query string through its redirect-URL allowlist (signInForMcpConsent
  // below stashes the params there before sending the user to Google, and sends Google
  // back to a bare /mcp/consent with no query string instead of relying on that match).
  const [mcpConsentParams] = useState(() => {
    if (window.location.pathname !== '/mcp/consent') return null
    const p = new URLSearchParams(window.location.search)
    if (p.get('client_id')) {
      return {
        client_id: p.get('client_id'),
        client_name: p.get('client_name'),
        state: p.get('state'),
        redirect_uri: p.get('redirect_uri'),
        code_challenge: p.get('code_challenge'),
        code_challenge_method: p.get('code_challenge_method') || 'S256',
        scope: p.get('scope'),
        resource: p.get('resource'),
      }
    }
    try {
      const saved = sessionStorage.getItem('mcp_consent_params')
      return saved ? JSON.parse(saved) : null
    } catch {
      return null
    }
  })
  const [mcpConsenting, setMcpConsenting] = useState(false)
  const [mcpConsentError, setMcpConsentError] = useState("")
  const [mcpConnections, setMcpConnections] = useState(null)
  const [mcpDisconnectingId, setMcpDisconnectingId] = useState(null)
  const [composioConnections, setComposioConnections] = useState(null)
  const [composioConnectingToolkit, setComposioConnectingToolkit] = useState(null)
  const [composioDisconnectingToolkit, setComposioDisconnectingToolkit] = useState(null)
  const [legalSection, setLegalSection] = useState(() =>
    window.location.pathname === '/terms' ? 'terms' : 'privacy'
  )
  const [showSettings, setShowSettings] = useState(false)
  const [activeTourHighlight, setActiveTourHighlight] = useState(null)
  const [deletingAccount, setDeletingAccount] = useState(false)
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false)
  const [tokenCopied, setTokenCopied] = useState(false)
  const [xCodeCopied, setXCodeCopied] = useState(false)
  const [linkedinCodeCopied, setLinkedinCodeCopied] = useState(false)
  const [newsletterAddressCopied, setNewsletterAddressCopied] = useState(false)
  const [xBookmarkletHelpOpen, setXBookmarkletHelpOpen] = useState(false)
  const [linkedinBookmarkletHelpOpen, setLinkedinBookmarkletHelpOpen] = useState(false)
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)
  const [selectedSource, setSelectedSource] = useState(null)
  const [urlInput, setUrlInput] = useState("")
  const [saveReceipt, setSaveReceipt] = useState(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState("")
  const [todaySaves, setTodaySaves] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem("recall_today_saves") || "[]") } catch { return [] }
  })

  const [isFreshReceipt, setIsFreshReceipt] = useState(false)
  const [loadingStep, setLoadingStep] = useState(0)
  const [editingTodayTitleId, setEditingTodayTitleId] = useState(null)
  const [draftTodayTitle, setDraftTodayTitle] = useState("")
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [libraryFilters, setLibraryFilters] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem("recall_library_filters") || '{"sources":[]}') } catch { return { sources: [] } }
  })
  const [hasSearched, setHasSearched] = useState(false)
  const [displayCount, setDisplayCount] = useState(5)
  const [recentSearches, setRecentSearches] = useState(() => {
    try { return JSON.parse(localStorage.getItem("recall_recent_searches") || "[]") }
    catch { return [] }
  })
  const [searchInputFocused, setSearchInputFocused] = useState(false)
  const [selectedFolder, setSelectedFolder] = useState(null)

  // Folders
  const [folders, setFolders] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem("recall_folders") || "[]") } catch { return [] }
  })
  const [folderPickerSaveId, setFolderPickerSaveId] = useState(null)
  const [pickerFolderIds, setPickerFolderIds] = useState(new Set())
  const [removeFolderConfirm, setRemoveFolderConfirm] = useState(null) // { saveId, folderId, folderName }
  const [newFolderName, setNewFolderName] = useState("")
  const [editingFolderId, setEditingFolderId] = useState(null)
  const [draftFolderName, setDraftFolderName] = useState("")
  const [onboardingStep, setOnboardingStep] = useState(null)
  const [first5Count, setFirst5Count] = useState(5)
  const [firstSaveSheetOpen, setFirstSaveSheetOpen] = useState(false)
  const [authLoading, setAuthLoading] = useState(true)
  const [preAuthUrl, setPreAuthUrl] = useState(() => sessionStorage.getItem("recall_pre_auth_url") || "")
  const [landingPreviewError, setLandingPreviewError] = useState("")
  const [preSignupSave, setPreSignupSave] = useState(() => {
    try {
      const saved = sessionStorage.getItem("recall_pre_signup_save")
      return saved ? JSON.parse(saved) : null
    } catch {
      return null
    }
  })
  const [preSignupTourKey, setPreSignupTourKey] = useState(null)
  const [landingSavedArticles] = useState(() => {
    try {
      const saved = sessionStorage.getItem("recall_landing_saved_articles")
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })

  // Ask mode (wiki Q&A)
  const [askMode, setAskMode] = useState(false)
  const [synthesis, setSynthesis] = useState(null)
  const [synthesisSources, setSynthesisSources] = useState([])
  const [askLoading, setAskLoading] = useState(false)


  // Related saves (shown on receipt)
  const [relatedSaves, setRelatedSaves] = useState([])

  // Calendar (Search tab — idle/browse state)
  const [calendarSaves, setCalendarSaves] = useState({})
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d
  })
  const [selectedCalendarDay, setSelectedCalendarDay] = useState(null)
  const [libraryFeedCount, setLibraryFeedCount] = useState(10)
  const libraryFeedSentinelRef = useRef(null)

  // Ask step messaging + insufficient detail
  const [askStep, setAskStep] = useState("")
  const [insufficientData, setInsufficientData] = useState(null)

  // Total save count for multi-stage milestone track
  const [totalSaveCount, setTotalSaveCount] = useState(null)

  // Install prompt (banner + bottom-of-page fallback)
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null)
  const [installBannerDismissed, setInstallBannerDismissed] = useState(() => localStorage.getItem('recall_install_banner_dismissed') === 'true')
  const [justInstalled, setJustInstalled] = useState(() => localStorage.getItem('recall_installed') === 'true')
  const [installStepsOpen, setInstallStepsOpen] = useState(false)
  const [mcpTutorialStatus, setMcpTutorialStatus] = useState(() => localStorage.getItem(MCP_TUTORIAL_STATUS_KEY) || "")
  const [showMcpPrompt, setShowMcpPrompt] = useState(false)
  const [showMcpVideo, setShowMcpVideo] = useState(false)
  const [mcpLearnHighlighted, setMcpLearnHighlighted] = useState(false)

  // Settings panel accordion — which section ('connect' | 'import' | 'shortcuts') is expanded
  const [openSettingsSection, setOpenSettingsSection] = useState(null)

  // iOS Share Sheet Shortcut setup guide (Settings) — nested toggle within the 'shortcuts' accordion section
  const [shortcutGuideOpen, setShortcutGuideOpen] = useState(false)

  // Bookmark import (Settings)
  const [importJob, setImportJob] = useState(null)
  const [importUploading, setImportUploading] = useState(false)
  const [xConnecting, setXConnecting] = useState(false)
  const [xBookmarkletFallback, setXBookmarkletFallback] = useState(false)

  const [pushEnabled, setPushEnabled] = useState(false)
  const finalizeSaveRef = useRef(null)
  const userRef = useRef(null)
  const tokenRef = useRef(null)
  const urlInputRef = useRef(null)
  const searchInputRef = useRef(null)
  const searchSectionRef = useRef(null)
  const importFileInputRef = useRef(null)
  const importPollRef = useRef(null)
  const preSignupTourTimeoutRef = useRef(null)
  const xBookmarkletRef = useRef(null)
  const linkedinBookmarkletRef = useRef(null)
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const isAndroid = /Android/i.test(navigator.userAgent)
  const isDesktop = !isIOS && !isAndroid
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  const showInstallUI = !isStandalone && !justInstalled && (deferredInstallPrompt || isIOS || isAndroid)

  useEffect(() => {
    if (view === 'mcp-consent') return // transient, query-param-driven — never persist as the default view
    sessionStorage.setItem("recall_view", view)
  }, [view])

  useEffect(() => {
    if (!authLoading && !user && preSignupSave && preSignupTourKey === null) {
      if (preSignupSave.status === "pending") return
      setView("save")
      clearTimeout(preSignupTourTimeoutRef.current)
      preSignupTourTimeoutRef.current = window.setTimeout(() => {
        setActiveTourHighlight("sign-in")
        setPreSignupTourKey(Date.now())
      }, 5000)
    }
  }, [authLoading, preSignupSave, preSignupTourKey, user])

  useEffect(() => {
    const handleBeforeInstall = (e) => {
      e.preventDefault()
      setDeferredInstallPrompt(e)
    }
    const handleAppInstalled = () => {
      setDeferredInstallPrompt(null)
      setJustInstalled(true)
      localStorage.setItem('recall_installed', 'true')
      posthog.capture('pwa_installed')
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstall)
    window.addEventListener('appinstalled', handleAppInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall)
      window.removeEventListener('appinstalled', handleAppInstalled)
    }
  }, [])

  useEffect(() => () => {
    clearInterval(importPollRef.current)
    clearTimeout(preSignupTourTimeoutRef.current)
  }, [])

  // React's JSX `href` prop sanitizes/blocks javascript: URLs as an XSS precaution
  // (throws "React has blocked a javascript: URL..." on click). Set these directly
  // via the DOM instead, bypassing that check — these are static, developer-authored
  // bookmarklet scripts, not user-supplied input.
  useEffect(() => {
    if (xBookmarkletRef.current) xBookmarkletRef.current.setAttribute('href', BOOKMARKLET_CODE)
    if (linkedinBookmarkletRef.current) linkedinBookmarkletRef.current.setAttribute('href', LINKEDIN_BOOKMARKLET_CODE)
  }, [showSettings, importJob])

  // Search tab's blank-state browsing modes: idle/calendar vs. focused/filtered-feed vs.
  // query-active ranked results (hasSearched, handled separately below/in JSX).
  const searchIsFiltering = searchInputFocused || askMode || !!selectedSource || !!selectedFolder
  const showCalendar = !hasSearched && !searchIsFiltering
  const showFilteredFeed = !hasSearched && searchIsFiltering

  useEffect(() => {
    if (view === "search" && user && Object.keys(calendarSaves).length === 0 && !calendarLoading) {
      fetchCalendarSaves()
    }
  }, [view, user])

  useEffect(() => {
    if (view === "recall" && user && mcpConnections === null) {
      fetchMcpConnections()
    }
  }, [view, user, mcpConnections])

  useEffect(() => {
    // Unlike mcpConnections (fetched when the separate "recall"/MCP-connector tab is opened),
    // this section lives in the gear-icon Settings overlay, so it fetches when that opens.
    if (showSettings && user && composioConnections === null) {
      fetchComposioConnections()
    }
  }, [showSettings, user, composioConnections])

  useEffect(() => {
    if (view !== "search" || hasSearched || (showCalendar && selectedCalendarDay)) return
    const sentinel = libraryFeedSentinelRef.current
    if (!sentinel) return
    let feedSaves = calendarSaves
    if (showFilteredFeed && (selectedSource || selectedFolder)) {
      feedSaves = {}
      for (const [day, daySaves] of Object.entries(calendarSaves)) {
        const kept = daySaves.filter(s =>
          (!selectedSource || getSourceLabel(s.url) === selectedSource) &&
          (!selectedFolder || getSaveFolders(s.id).some(f => f.name === selectedFolder))
        )
        if (kept.length) feedSaves[day] = kept
      }
    }
    const totalDays = Object.keys(feedSaves).length
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) {
        setLibraryFeedCount(c => Math.min(c + 10, totalDays))
      }
    })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [view, hasSearched, showCalendar, showFilteredFeed, selectedCalendarDay, calendarSaves, libraryFeedCount, selectedSource, selectedFolder, folders])

  useEffect(() => {
    if (!loading) { setLoadingStep(0); return }
    const id = setInterval(() => setLoadingStep(s => Math.min(s + 1, 3)), 1050)
    return () => clearInterval(id)
  }, [loading])

  // Pushes background-enrichment completions (real title/tag) to the active receipt and
  // Today's list the instant a save flips from 'pending' to 'ready' — see finalizeSave.
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel(`saves-${user.id}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'saves', filter: `user_id=eq.${user.id}` },
        payload => {
          if (payload.new.status !== 'ready') return
          finalizeSaveRef.current?.({
            id: payload.new.id, title: payload.new.title,
            tag: payload.new.tag, related_ids: payload.new.related_ids
          })
        })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user?.id])

  // If notification permission was already granted in a prior session, silently re-confirm
  // (and re-POST, in the rare case the subscription itself expired) without re-prompting.
  useEffect(() => {
    if (!user || !pushSupported || typeof Notification === "undefined") return
    if (Notification.permission !== "granted") return
    (async () => {
      const registration = await navigator.serviceWorker.register("/sw.js")
      await navigator.serviceWorker.ready
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY)
        })
        const token = await getToken()
        await fetch(`${BACKEND}/push/subscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, subscription: subscription.toJSON() })
        })
      }
      setPushEnabled(true)
    })().catch(e => console.error("[push] resubscribe check failed", e))
  }, [user?.id])

  useEffect(() => {
    if (!askLoading) { setAskStep(""); return }
    const steps = ["Searching your saves…", "Reading articles…", "Synthesizing your answer…"]
    setAskStep(steps[0])
    const t1 = setTimeout(() => setAskStep(steps[1]), 1400)
    const t2 = setTimeout(() => setAskStep(steps[2]), 3200)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [askLoading])

  // Seed the picker's checked state from folders state (single source of truth).
  useEffect(() => {
    if (!folderPickerSaveId) { setPickerFolderIds(new Set()); return }
    setPickerFolderIds(new Set(getSaveFolders(folderPickerSaveId).map(f => f.id)))
  }, [folderPickerSaveId, folders]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const maybePromptMcpTutorial = () => {
    if (localStorage.getItem(MCP_TUTORIAL_STATUS_KEY)) return
    setShowMcpPrompt(true)
  }

  const openMcpTutorialVideo = () => {
    localStorage.setItem(MCP_TUTORIAL_STATUS_KEY, "watched")
    setMcpTutorialStatus("watched")
    setShowMcpPrompt(false)
    setShowMcpVideo(true)
    setMcpLearnHighlighted(false)
  }

  const deferMcpTutorial = () => {
    localStorage.setItem(MCP_TUTORIAL_STATUS_KEY, "deferred")
    setMcpTutorialStatus("deferred")
    setShowMcpPrompt(false)
    setShowMcpVideo(false)
    setView("recall")
    setMcpLearnHighlighted(true)
    window.setTimeout(() => setMcpLearnHighlighted(false), 7000)
  }

  const openDeferredMcpTutorial = () => {
    setShowMcpVideo(true)
    setMcpLearnHighlighted(false)
  }

  const finishMcpTutorialVideo = () => {
    localStorage.setItem(MCP_TUTORIAL_STATUS_KEY, "watched")
    setMcpTutorialStatus("watched")
    setShowMcpVideo(false)
    setView("recall")
  }

  const fetchSaveCount = async () => {
    const { count } = await supabase
      .from("saves")
      .select("*", { count: "exact", head: true })
    if (count !== null) {
      setTotalSaveCount(count)
      const capped = Math.min(count, 5)
      setFirst5Count(capped)
      if (capped >= 5) {
        setFirstSaveSheetOpen(false)
        setOnboardingStep(prev => prev === 'firstSave' ? 'done' : prev)
        localStorage.setItem('recall_onboarded', 'true')
        maybePromptMcpTutorial()
      }
    }
  }

  const fetchTodaySaves = async () => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const { data } = await supabase
      .from("saves")
      .select("id, url, title, tag, content_type, thumbnail_url, status, created_at, content_text")
      .gte("created_at", today.toISOString())
      .order("created_at", { ascending: false })
      .limit(20)
    if (data) {
      setTodaySaves(data)
      sessionStorage.setItem("recall_today_saves", JSON.stringify(data))
    }
  }

  const fetchFolders = async () => {
    try {
      // Use the backend (service role) — the anon Supabase client can't reliably read
      // save_folders even with SELECT grants (no RLS policy = PostgREST returns empty embeds).
      // Backend returns save_ids per folder; we cache in sessionStorage so page reloads
      // show pills instantly without waiting for this round-trip.
      const token = await getToken()
      const res = await fetch(`${BACKEND}/folders?token=${encodeURIComponent(token)}`)
      if (!res.ok) return []
      const data = await res.json()
      const folderList = data.folders || []
      setFolders(folderList)
      sessionStorage.setItem("recall_folders", JSON.stringify(folderList))
      return folderList
    } catch {
      return []
    }
  }

  // Single source of truth for a save's folder memberships.
  // Reads from folders state (populated by fetchFolders) instead of per-save nested joins.
  const getSaveFolders = (saveId) => folders.filter(f => (f.save_ids || []).includes(saveId))

  const fetchLibraryFilters = async () => {
    const { data } = await supabase.from("saves").select("url")
    if (!data?.length) return
    const sources = [...new Set(data.map(r => getSourceLabel(r.url)).filter(s => s && s !== "Page"))].sort()
    const filters = { sources }
    setLibraryFilters(filters)
    sessionStorage.setItem("recall_library_filters", JSON.stringify(filters))
  }

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false)
      return
    }
    const params = new URLSearchParams(window.location.search)

    // Bookmarklet-scraped tweet IDs, passed via URL hash (never sent over the network)
    if (window.location.hash.startsWith('#import_tweets=')) {
      const idsStr = window.location.hash.slice('#import_tweets='.length)
      const tweetIds = idsStr.split(',').filter(Boolean)
      window.history.replaceState({}, '', '/')
      if (tweetIds.length > 0) {
        sessionStorage.setItem('x_scraped_pending', JSON.stringify(tweetIds))
      }
    }

    // Bookmarklet-scraped full URLs (e.g. LinkedIn saved posts), passed via URL hash
    if (window.location.hash.startsWith('#import_urls=')) {
      const encodedStr = window.location.hash.slice('#import_urls='.length)
      const urls = encodedStr.split(',').filter(Boolean).map(decodeURIComponent)
      window.history.replaceState({}, '', '/')
      if (urls.length > 0) {
        sessionStorage.setItem('urls_scraped_pending', JSON.stringify(urls))
      }
    }

    // Composio Connect Link callback (currently: Notion only) — the OAuth dance itself is
    // hosted entirely by Composio, so unlike the X flow below there's no code/state to
    // validate here; this param is purely "the user finished the flow, go check if it's
    // active now." Stash for the same post-auth-resolution consumption pattern as
    // x_import_pending, since auth may not have resolved yet at this point in the mount effect.
    const composioConnected = params.get('composio_connected')
    if (composioConnected) {
      window.history.replaceState({}, '', '/')
      sessionStorage.setItem('composio_connect_pending', composioConnected)
    }

    // X OAuth callback — must run before share-sheet extraction to avoid misreading ?code= as a URL.
    // Skipped on /mcp/consent: that path uses its own code/state params (see mcpConsentParams)
    // which would otherwise be misread as a stale/invalid X callback here.
    const xCode = window.location.pathname === '/mcp/consent' ? null : params.get('code')
    const xState = window.location.pathname === '/mcp/consent' ? null : params.get('state')
    if (xCode || xState) {
      const storedState = localStorage.getItem('x_import_state')
      const xVerifier = localStorage.getItem('x_import_verifier')
      window.history.replaceState({}, '', '/')
      if (xCode && xState && xState === storedState && xVerifier) {
        localStorage.removeItem('x_import_state')
        localStorage.removeItem('x_import_verifier')
        sessionStorage.setItem('x_import_pending', JSON.stringify({
          code: xCode, verifier: xVerifier,
          redirectUri: window.location.origin + '/'
        }))
      } else {
        console.warn('[ReCall] X OAuth callback could not be validated', {
          hasCode: !!xCode, hasState: !!xState,
          stateMatch: xState === storedState, hasVerifier: !!xVerifier,
        })
        setMessage("X connection session expired or was lost — please try again.")
        setIsError(true)
      }
    }

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
      userRef.current = session?.user ?? null
      tokenRef.current = session?.access_token ?? null
      setUser(session?.user ?? null)
      setAuthLoading(false)
      if (session?.user) {
        posthog.identify(session.user.id, { email: session.user.email, signup_date: session.user.created_at })
        fetchTodaySaves()
        fetchLibraryFilters()
        fetchFolders()
        fetchSaveCount()
        const preAuthSavedUrl = sessionStorage.getItem("recall_pre_auth_url")
        if (preAuthSavedUrl) {
          setView("save")
          setUrlInput(preAuthSavedUrl)
          setMessage("Your link is ready. Save it to start building your library.")
          setIsError(false)
          sessionStorage.removeItem("recall_pre_auth_url")
          sessionStorage.removeItem("recall_landing_preview")
          sessionStorage.removeItem("recall_pre_signup_save")
          setPreSignupSave(null)
          setActiveTourHighlight(null)
        }
        // Bookmarklet import — consume scraped tweet IDs
        const scrapedPending = sessionStorage.getItem('x_scraped_pending')
        if (scrapedPending) {
          sessionStorage.removeItem('x_scraped_pending')
          const tweetIds = JSON.parse(scrapedPending)
          setMessage(`Found ${tweetIds.length} bookmarks — importing now…`)
          setIsError(false)
          getToken().then(token =>
            fetch(`${BACKEND}/import/x-scraped`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token, tweet_ids: tweetIds }),
            })
            .then(r => r.json())
            .then(data => {
              if (data.job_id) {
                localStorage.setItem('recall_import_job_id', data.job_id)
                setMessage(data.capped
                  ? `Found ${data.total_found} bookmarks — importing the most recent ${data.total}.`
                  : `Found ${data.total} bookmarks — importing now.`)
                setIsError(false)
                posthog.capture('x_bookmarks_import_started', { source: 'bookmarklet', total: data.total })
                pollImportStatus(data.job_id)
                setView('save')
                setShowSettings(true)
              } else {
                setMessage(data.detail || 'Import failed — try again')
                setIsError(true)
              }
            })
            .catch(() => { setMessage('Import failed — try again'); setIsError(true) })
          )
        }
        // Bookmarklet import — consume scraped full URLs (e.g. LinkedIn saved posts)
        const urlsPending = sessionStorage.getItem('urls_scraped_pending')
        if (urlsPending) {
          sessionStorage.removeItem('urls_scraped_pending')
          const scrapedUrls = JSON.parse(urlsPending)
          setMessage(`Found ${scrapedUrls.length} saved posts — importing now…`)
          setIsError(false)
          getToken().then(token =>
            fetch(`${BACKEND}/import/urls-scraped`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token, urls: scrapedUrls }),
            })
            .then(r => r.json())
            .then(data => {
              if (data.job_id) {
                localStorage.setItem('recall_import_job_id', data.job_id)
                setMessage(data.capped
                  ? `Found ${data.total_found} saved posts — importing the most recent ${data.total}.`
                  : `Found ${data.total} saved posts — importing now.`)
                setIsError(false)
                posthog.capture('linkedin_import_started', { source: 'bookmarklet', total: data.total })
                pollImportStatus(data.job_id)
                setView('save')
                setShowSettings(true)
              } else {
                setMessage(data.detail || 'Import failed — try again')
                setIsError(true)
              }
            })
            .catch(() => { setMessage('Import failed — try again'); setIsError(true) })
          )
        }
        // X OAuth import — consume pending code from callback
        const xPending = sessionStorage.getItem('x_import_pending')
        if (xPending) {
          sessionStorage.removeItem('x_import_pending')
          const { code, verifier, redirectUri } = JSON.parse(xPending)
          setXConnecting(true)
          setMessage("Connecting to X and fetching your bookmarks… this can take a few seconds.")
          setIsError(false)
          getToken().then(token =>
            fetch(`${BACKEND}/import/x-connect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token, code, code_verifier: verifier, redirect_uri: redirectUri }),
            })
            .then(r => r.json())
            .then(data => {
              setXConnecting(false)
              if (data.job_id) {
                localStorage.setItem('recall_import_job_id', data.job_id)
                setMessage(data.capped
                  ? `Found ${data.total_found} bookmarks — importing the most recent ${data.total}.`
                  : `Found ${data.total} bookmarks — importing now.`)
                setIsError(false)
                posthog.capture('x_bookmarks_import_started', { source: 'oauth', total: data.total })
                pollImportStatus(data.job_id)
                setView('save')
                setShowSettings(true)
              } else {
                setMessage((data.detail || 'X import failed') + ' — try the bookmarklet import below instead.')
                setIsError(true)
                setXBookmarkletFallback(true)
              }
            })
            .catch(() => {
              setXConnecting(false)
              setMessage('X import failed — try the bookmarklet import below instead.')
              setIsError(true)
              setXBookmarkletFallback(true)
            })
          )
        }
        // Composio connect callback — consume pending toolkit from the query-param stash above
        const composioPending = sessionStorage.getItem('composio_connect_pending')
        if (composioPending) {
          sessionStorage.removeItem('composio_connect_pending')
          setComposioConnectingToolkit(composioPending)
          setShowSettings(true)
          setOpenSettingsSection('composio')
          getToken().then(token =>
            fetch(`${BACKEND}/composio/connect/${composioPending}/finalize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token }),
            })
            .then(r => r.json())
            .then(data => {
              setComposioConnectingToolkit(null)
              setComposioConnections(null) // triggers a refetch via the showSettings effect
              if (!data.connected) {
                setMessage("Notion connection didn't complete — please try again.")
                setIsError(true)
              }
            })
            .catch(() => {
              setComposioConnectingToolkit(null)
              setMessage("Notion connection failed — please try again.")
              setIsError(true)
            })
          )
        }
        // Resume any in-progress bookmark import
        const savedJobId = localStorage.getItem("recall_import_job_id")
        if (savedJobId) {
          pollImportStatus(savedJobId)
        } else {
          getToken().then(token => {
            fetch(`${BACKEND}/import/jobs/latest`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token }),
            }).then(r => r.json()).then(({ job }) => {
              if (job?.status === "running") {
                localStorage.setItem("recall_import_job_id", job.id)
                pollImportStatus(job.id)
              } else if (job) {
                setImportJob(job)
              }
            }).catch(() => {})
          })
        }
        // Restore last search session
        const savedQuery = sessionStorage.getItem("recall_last_query")
        const savedResults = sessionStorage.getItem("recall_last_results")
        if (savedQuery && savedResults) {
          setQuery(savedQuery)
          setResults(JSON.parse(savedResults))
          setHasSearched(true)
        }
        // Initialize onboarding for first-time users — skipped on /mcp/consent, where
        // setView('save') would silently override the consent screen right after it
        // was correctly set, since this runs on every SIGNED_IN event (including the
        // one right after the Google redirect completes during the consent flow).
        if (!localStorage.getItem('recall_onboarded') && window.location.pathname !== '/mcp/consent') {
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
      userRef.current = session?.user ?? null
      tokenRef.current = session?.access_token ?? null
      setUser(session?.user ?? null)
      if (session?.user) {
        posthog.identify(session.user.id, { email: session.user.email, signup_date: session.user.created_at })
        if (_event === 'SIGNED_IN') {
          const createdAt = new Date(session.user.created_at).getTime()
          if (Date.now() - createdAt < 30_000) {
            posthog.capture('user_signed_up')
          }
        }
        fetchTodaySaves()
        fetchLibraryFilters()
        fetchFolders()
        fetchSaveCount()
        const preAuthSavedUrl = sessionStorage.getItem("recall_pre_auth_url")
        if (preAuthSavedUrl) {
          setView("save")
          setUrlInput(preAuthSavedUrl)
          setMessage("Your link is ready. Save it to start building your library.")
          setIsError(false)
          sessionStorage.removeItem("recall_pre_auth_url")
          sessionStorage.removeItem("recall_landing_preview")
          sessionStorage.removeItem("recall_pre_signup_save")
          setPreSignupSave(null)
          setActiveTourHighlight(null)
        }
        // Skipped on /mcp/consent — see matching guard above for why.
        if (!localStorage.getItem('recall_onboarded') && window.location.pathname !== '/mcp/consent') {
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

  const signIn = async (pendingUrl = "") => {
    if (!supabase) {
      setMessage("Local auth env is missing. Add recall-frontend/.env to enable Google sign-in.")
      setIsError(true)
      return
    }
    const trimmed = pendingUrl.trim()
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      sessionStorage.setItem("recall_pre_auth_url", trimmed)
    }
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin }
    })
  }

  // Same as signIn, but returns to /mcp/consent instead of "/". Stashes the pending
  // authorization params in sessionStorage first and redirects to a bare (query-string-free)
  // URL — Supabase's redirect-URL allowlist doesn't reliably match a long, heavily-encoded
  // query string via redirectTo, so the params are restored from sessionStorage on return
  // instead of relying on them surviving in the URL (see mcpConsentParams above).
  const signInForMcpConsent = async () => {
    if (!supabase) {
      setMcpConsentError("Local auth env is missing. Add recall-frontend/.env to enable sign-in.")
      return
    }
    sessionStorage.setItem('mcp_consent_params', JSON.stringify(mcpConsentParams))
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/mcp/consent` }
    })
  }

  const approveMcpConsent = async () => {
    setMcpConsenting(true)
    setMcpConsentError("")
    try {
      const token = await getToken()
      const res = await fetch(`${BACKEND}/mcp/authorize/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supabase_access_token: token,
          client_id: mcpConsentParams.client_id,
          redirect_uri: mcpConsentParams.redirect_uri,
          state: mcpConsentParams.state,
          code_challenge: mcpConsentParams.code_challenge,
          code_challenge_method: mcpConsentParams.code_challenge_method,
          scope: mcpConsentParams.scope,
          resource: mcpConsentParams.resource,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || "Could not complete authorization")
      sessionStorage.removeItem('mcp_consent_params')
      posthog.capture('mcp_connected', { client_id: mcpConsentParams.client_id })
      window.location.href = data.redirect_uri
    } catch (e) {
      setMcpConsentError(e.message || "Something went wrong — try connecting again")
      setMcpConsenting(false)
    }
  }

  const denyMcpConsent = () => {
    const url = new URL(mcpConsentParams.redirect_uri)
    url.searchParams.set('error', 'access_denied')
    if (mcpConsentParams.state) url.searchParams.set('state', mcpConsentParams.state)
    sessionStorage.removeItem('mcp_consent_params')
    window.location.href = url.toString()
  }

  const fetchMcpConnections = async () => {
    const token = await getToken()
    try {
      const res = await fetch(`${BACKEND}/mcp/connections?token=${encodeURIComponent(token)}`)
      const data = await res.json()
      setMcpConnections(data.connections || [])
    } catch {
      setMcpConnections([])
    }
  }

  const disconnectMcpClient = async (clientId) => {
    setMcpDisconnectingId(clientId)
    try {
      const token = await getToken()
      await fetch(`${BACKEND}/mcp/connections/${clientId}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
      setMcpConnections(conns => conns.filter(c => c.client_id !== clientId))
    } finally {
      setMcpDisconnectingId(null)
    }
  }

  const fetchComposioConnections = async () => {
    const token = await getToken()
    try {
      const res = await fetch(`${BACKEND}/composio/connections?token=${encodeURIComponent(token)}`)
      const data = await res.json()
      setComposioConnections(data.connections || [])
    } catch {
      setComposioConnections([])
    }
  }

  const connectComposio = async (toolkit) => {
    setComposioConnectingToolkit(toolkit)
    try {
      const token = await getToken()
      const callback_url = `${window.location.origin}/?composio_connected=${toolkit}`
      const res = await fetch(`${BACKEND}/composio/connect/${toolkit}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, callback_url }),
      })
      const data = await res.json()
      if (data.redirect_url) {
        window.location.href = data.redirect_url
      } else {
        setComposioConnectingToolkit(null)
        setMessage("Couldn't start the Notion connection — try again.")
        setIsError(true)
      }
    } catch {
      setComposioConnectingToolkit(null)
      setMessage("Couldn't start the Notion connection — try again.")
      setIsError(true)
    }
  }

  const disconnectComposio = async (toolkit) => {
    setComposioDisconnectingToolkit(toolkit)
    try {
      const token = await getToken()
      await fetch(`${BACKEND}/composio/connections/${toolkit}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
      setComposioConnections(conns => conns.filter(c => c.toolkit !== toolkit))
    } finally {
      setComposioDisconnectingToolkit(null)
    }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    userRef.current = null
    tokenRef.current = null
    setUser(null)
    setOnboardingStep(null)
    localStorage.removeItem("recall_recent_searches")
    sessionStorage.removeItem("recall_last_query")
    sessionStorage.removeItem("recall_last_results")
    sessionStorage.removeItem("recall_today_saves")
    sessionStorage.removeItem("recall_library_filters")
    sessionStorage.removeItem("recall_folders")
    setRecentSearches([])
    setHasSearched(false)
    setResults([])
    setQuery("")
    setCalendarSaves({})
    setSelectedCalendarDay(null)
    posthog.reset()
  }

  const deleteAccount = async () => {
    setDeletingAccount(true)
    try {
      const token = await getToken()
      const res = await fetch(`${BACKEND}/account`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      })
      if (res.ok) posthog.capture('account_deleted')
      posthog.reset()
      await supabase.auth.signOut()
      userRef.current = null
      tokenRef.current = null
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

  const handleInstallClick = async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt()
      await deferredInstallPrompt.userChoice
      setDeferredInstallPrompt(null)
    } else {
      setInstallStepsOpen(open => !open)
    }
  }

  const startLandingSignIn = () => {
    const trimmed = preAuthUrl.trim()
    if (trimmed) {
      if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
        setLandingPreviewError("Paste a full link to start your library.")
        return
      }
    }
    setLandingPreviewError("")
    signIn(trimmed)
  }

  const buildClientPreview = async (url) => {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 15000)
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { "X-Return-Format": "text" },
      signal: controller.signal,
    })
    window.clearTimeout(timeoutId)
    if (!res.ok) throw new Error("preview_failed")
    const text = await res.text()
    if (text.trim().length < 150) throw new Error("thin_content")
    const lines = text.split("\n")
    const titleLine = lines.find(line => line.startsWith("Title:"))
    const firstHeading = lines.find(line => /^#{1,2}\s+\S/.test(line))?.replace(/^#{1,2}\s+/, "").trim()
    const sourceLabel = getSourceLabel(url)
    const rawTitle = titleLine?.replace(/^Title:\s*/, "").trim()
    const title = rawTitle && rawTitle.toLowerCase() !== sourceLabel.toLowerCase()
      ? rawTitle
      : (firstHeading || sourceLabel)
    const contentStart = lines.findIndex(line => line.startsWith("Markdown Content:") || line.startsWith("URL Source:"))
    const contentText = lines.slice(contentStart >= 0 ? contentStart + 1 : 0).join("\n").trim().slice(0, 5000)
    const lower = `${title} ${contentText}`.toLowerCase()
    const tag =
      /artificial intelligence|machine learning|\bai\b|software|data|code|tech|internet|platform/.test(lower) ? "Tech" :
      /design|product|ux|user|onboarding/.test(lower) ? "Product" :
      /stock|market|crypto|fund|finance|bank|econom/.test(lower) ? "Finance" :
      /health|study|doctor|medical|fitness/.test(lower) ? "Health" :
      /business|company|startup|strategy/.test(lower) ? "Business" :
      "Other"
    return { success: true, url, title, content_text: contentText, tag, content_type: "article" }
  }

  const saveBeforeSignup = async (url = preAuthUrl) => {
    const trimmed = url.trim()
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      setLandingPreviewError("Paste a full link to save it.")
      return
    }

    clearTimeout(preSignupTourTimeoutRef.current)
    sessionStorage.setItem("recall_pre_auth_url", trimmed)
    setLandingPreviewError("")
    setLoading(true)
    setMessage("")
    setIsError(false)
    setActiveTourHighlight(null)
    setPreSignupTourKey(null)
    setUrlInput("")
    setSaveReceipt(null)
    setView("save")
    setShowSettings(false)
    const pendingPreview = {
      id: "pre-signup-save",
      url: trimmed,
      title: getSourceLabel(trimmed),
      content_text: "",
      tag: null,
      created_at: new Date().toISOString(),
      status: "pending",
      preview: true,
    }
    setPreSignupSave(pendingPreview)
    window.setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0)

    try {
      let data
      try {
        const controller = new AbortController()
        const timeoutId = window.setTimeout(() => controller.abort(), 20000)
        const res = await fetch(`${BACKEND}/save/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
          signal: controller.signal,
        })
        window.clearTimeout(timeoutId)
        if (!res.ok) throw new Error()
        data = await res.json()
      } catch {
        data = await buildClientPreview(trimmed)
      }
      if (data.thin_content) {
        throw new Error("thin_content")
      }
      const preview = {
        id: "pre-signup-save",
        url: data.url || trimmed,
        title: data.title || getSourceLabel(trimmed),
        content_text: data.content_text || "",
        tag: data.tag || "Auto tagged",
        content_type: data.content_type || "article",
        created_at: new Date().toISOString(),
        preview: true,
      }
      sessionStorage.setItem("recall_pre_signup_save", JSON.stringify(preview))
      setPreSignupSave(preview)
      preSignupTourTimeoutRef.current = window.setTimeout(() => {
        setActiveTourHighlight("sign-in")
        setPreSignupTourKey(Date.now())
      }, 5000)
    } catch {
      setPreSignupSave(null)
      sessionStorage.removeItem("recall_pre_signup_save")
      setLandingPreviewError("Couldn't read that link. Try another article URL.")
      setView("search")
    } finally {
      setLoading(false)
    }
  }

  const getToken = async () => {
    if (tokenRef.current) return tokenRef.current
    if (!supabase) return null
    const { data: { session } } = await supabase.auth.getSession()
    tokenRef.current = session?.access_token ?? null
    return tokenRef.current
  }

  // Web Push only works on iOS 16.4+ when the PWA is installed to the home screen —
  // offering it on a plain iOS Safari tab would prompt for permission and then silently
  // fail to ever deliver anything, so gate it the same way the install banner does.
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && (!isIOS || isStandalone)

  const enableSaveNotifications = async () => {
    if (!pushSupported) return
    setMessage("")
    setIsError(false)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== "granted") {
        let deniedMessage = "Notifications are blocked for ReCall in your browser. Enable them in your browser's site settings, then try again."
        if (permission === "denied" && isStandalone) {
          deniedMessage = isAndroid
            ? "Notifications are still blocked for ReCall — this is separate from the Notifications toggle in your phone's app settings. Open Chrome → tap ⋮ → Settings → Site settings → Notifications → find recall-iota-six.vercel.app under \"Not allowed\" → set it to Allow. Then come back and try again."
            : "Notifications are blocked for ReCall. Open your phone's Settings app → scroll to ReCall → Notifications → Allow Notifications, then come back and try again."
        }
        setMessage(permission === "denied"
          ? deniedMessage
          : "Notification permission wasn't granted — try again if you'd like updates.")
        setIsError(true)
        return
      }
      const registration = await navigator.serviceWorker.register("/sw.js")
      await navigator.serviceWorker.ready
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY)
        })
      }
      const token = await getToken()
      await fetch(`${BACKEND}/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, subscription: subscription.toJSON() })
      })
      setPushEnabled(true)
      posthog.capture('push_notifications_enabled')
    } catch (e) {
      console.error("[push] subscribe failed", e)
      setMessage("Couldn't enable notifications — try again.")
      setIsError(true)
    }
  }

  const pollImportStatus = (jobId) => {
    if (importPollRef.current) clearInterval(importPollRef.current)
    const tick = async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${BACKEND}/import/status/${jobId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        })
        if (!res.ok) { clearInterval(importPollRef.current); return }
        const job = await res.json()
        setImportJob(job)
        if (job.status !== "running") {
          clearInterval(importPollRef.current)
          localStorage.removeItem("recall_import_job_id")
          posthog.capture("import_finished", { source: job.source, status: job.status, succeeded: job.succeeded })
          if (job.succeeded > 0) fetchTodaySaves()
          if (job.status === "completed") {
            if (job.source === "url_scraped") {
              setMessage(`Imported ${job.succeeded} public LinkedIn posts${job.duplicates > 0 ? `, plus ${job.duplicates} already in ReCall` : ""}. The other ${job.skipped} needed a logged-in LinkedIn session to view, so we couldn't pull those in — that's a LinkedIn restriction, not an error.`)
            } else {
              setMessage(`Import finished: ${job.succeeded} added, ${job.duplicates} already saved, ${job.skipped} skipped, ${job.failed} failed.`)
            }
            setIsError(false)
          } else if (job.status === "stalled") {
            setMessage(`Import stalled (${job.processed}/${job.total} done) — try running it again.`)
            setIsError(true)
          }
        }
      } catch {
        clearInterval(importPollRef.current)
      }
    }
    tick()
    importPollRef.current = setInterval(tick, 5000)
  }

  const generatePKCE = async () => {
    const array = new Uint8Array(32)
    crypto.getRandomValues(array)
    const verifier = btoa(String.fromCharCode(...array))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    return { verifier, challenge }
  }

  const connectXForImport = async () => {
    setXConnecting(true)
    const { verifier, challenge } = await generatePKCE()
    const state = crypto.randomUUID()
    localStorage.setItem('x_import_verifier', verifier)
    localStorage.setItem('x_import_state', state)
    const redirectUri = window.location.origin + '/'
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: TWITTER_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'bookmark.read tweet.read users.read',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    window.location.href = `https://twitter.com/i/oauth2/authorize?${params}`
  }

  const handleImportFileChange = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImportUploading(true)
    try {
      const token = await getToken()
      const formData = new FormData()
      formData.append("token", token)
      formData.append("file", file)
      const res = await fetch(`${BACKEND}/import/x-bookmarks`, { method: "POST", body: formData })
      const data = await res.json()
      if (!res.ok) {
        setMessage(data.detail || "Import failed")
        setIsError(true)
        return
      }
      localStorage.setItem("recall_import_job_id", data.job_id)
      posthog.capture("x_bookmarks_import_started", { source: 'file_upload', total: data.total, capped: data.capped })
      if (data.capped) setMessage(`Found ${data.total_found} bookmarks — importing the most recent ${data.total}.`)
      pollImportStatus(data.job_id)
    } catch {
      setMessage("Import failed — try again")
      setIsError(true)
    } finally {
      setImportUploading(false)
      e.target.value = ""
    }
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

  const setSaveFolders = async (saveId, folderIds) => {
    // Compute updated folders synchronously (before any await — closure is current)
    const newFolders = folders.map(f => {
      const inNew = folderIds.includes(f.id)
      const inOld = (f.save_ids || []).includes(saveId)
      if (inNew === inOld) return f
      return inNew
        ? { ...f, save_ids: [...(f.save_ids || []), saveId], save_count: (f.save_count || 0) + 1 }
        : { ...f, save_ids: (f.save_ids || []).filter(id => id !== saveId), save_count: Math.max(0, (f.save_count || 0) - 1) }
    })
    // Optimistic update — also write to sessionStorage so pills survive a page refresh
    setFolders(newFolders)
    sessionStorage.setItem("recall_folders", JSON.stringify(newFolders))
    const token = await getToken()
    const res = await fetch(`${BACKEND}/save/${saveId}/folders`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_ids: folderIds, token })
    })
    if (!res.ok) {
      // Revert by re-fetching authoritative data from backend
      fetchFolders()
    }
    // Success: don't re-fetch — optimistic state and sessionStorage are already correct.
    // fetchFolders would hit Railway (potential cold start) and could overwrite correct state.
  }

  const handleRemoveFromFolder = async (saveId, folderId) => {
    const currentIds = getSaveFolders(saveId).map(f => f.id)
    await setSaveFolders(saveId, currentIds.filter(id => id !== folderId))
    setRemoveFolderConfirm(null)
  }

  const createFolder = async (name) => {
    const token = await getToken()
    const res = await fetch(`${BACKEND}/folders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), token })
    })
    const data = await res.json()
    if (!res.ok) return
    setNewFolderName("")
    posthog.capture('folder_created')
    const newFolders = await fetchFolders()
    // Auto-add the new folder to the save currently in the picker
    if (folderPickerSaveId && data.id) {
      const newIds = [...pickerFolderIds, data.id]
      setPickerFolderIds(new Set(newIds))
      await setSaveFolders(folderPickerSaveId, newIds)
    }
  }

  const renameFolder = async (folderId, name) => {
    if (!name.trim()) return
    const token = await getToken()
    await fetch(`${BACKEND}/folders/${folderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), token })
    })
    setEditingFolderId(null)
    fetchFolders()
  }

  const deleteFolder = async (folderId) => {
    const token = await getToken()
    await fetch(`${BACKEND}/folders/${folderId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    })
    fetchFolders()
    fetchTodaySaves() // refresh folder pills on today's list
  }

  const updateTodayTitle = async (id, newTitle) => {
    const librarySave = Object.values(calendarSaves).flat().find(s => s.id === id)
    const currentTitle = todaySaves.find(s => s.id === id)?.title || librarySave?.title || ""
    if (!newTitle.trim() || newTitle === currentTitle) {
      setEditingTodayTitleId(null)
      return
    }
    const token = await getToken()
    await fetch(`${BACKEND}/save/${id}/title`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle, token })
    })
    setTodaySaves(prev => prev.map(s => s.id === id ? { ...s, title: newTitle } : s))
    setCalendarSaves(prev => Object.fromEntries(
      Object.entries(prev).map(([day, saves]) => [day, saves.map(s => s.id === id ? { ...s, title: newTitle } : s)])
    ))
    if (saveReceipt?.id === id) setSaveReceipt(r => ({ ...r, title: newTitle }))
    setEditingTodayTitleId(null)
    playSuccessChime()
    navigator.vibrate?.([50])
    posthog.capture('title_edited')
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
    setCalendarSaves(prev => Object.fromEntries(
      Object.entries(prev)
        .map(([day, saves]) => [day, saves.filter(s => s.id !== id)])
        .filter(([, saves]) => saves.length > 0)
    ))
    setResults(prev => prev.filter(s => s.id !== id))
    setSynthesisSources(prev => prev.filter(s => s.id !== id))
    setRelatedSaves(prev => prev.filter(s => s.id !== id))
    setTotalSaveCount(prev => Math.max(0, (prev ?? 0) - 1))
    if (saveReceipt?.id === id) setSaveReceipt(null)
    posthog.capture('save_deleted')
    setDeletingId(null)
  }

  const handleSave = async (url, fromShareSheet = false) => {
    url = url.trim()
    // userRef (not the `user` state var) on purpose: the share-sheet mount effect calls
    // handleSave from inside a Promise .then()/onAuthStateChange callback, in the same tick
    // as setUser(...) — React hasn't re-rendered yet at that point, so `user` would still read
    // this render's stale closed-over value. userRef.current is written synchronously
    // alongside every setUser(...) call, so it's always current regardless of render timing.
    if (!userRef.current) {
      setPreAuthUrl(url)
      saveBeforeSignup(url)
      return
    }
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
    try {
      const token = await getToken()
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 8000)
      let res
      try {
        res = await fetch(`${BACKEND}/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, token }),
          signal: controller.signal
        })
      } finally {
        clearTimeout(timeoutId)
      }
      if (res.status === 401) tokenRef.current = null
      if (!res.ok) throw new Error()
      const data = await res.json()
      if (data.duplicate) {
        setSaveReceipt({ ...data, url, duplicate: true })
      } else if (data.pending) {
        posthog.capture('save_confirmed', { content_type: data.content_type || 'article', via_share_sheet: !!fromShareSheet })
        setUrlInput("")
        setRelatedSaves([])
        setTotalSaveCount(prev => (prev ?? 0) + 1)
        const isMedia = data.content_type && data.content_type !== "article"
        setSaveReceipt(isMedia
          ? { media: true, pending: true, content_type: data.content_type, label: data.label, title: data.title, tag: null, id: data.id, url, fromShareSheet }
          : { id: data.id, url, title: data.title, tag: null, pending: true, fromShareSheet, content_type: data.content_type })
        fetchTodaySaves()
        // Realtime (see the saves-<uid> subscription effect) resolves this the instant
        // enrichment finishes. This is just a safety net in case Realtime is misconfigured/off.
        setTimeout(async () => {
          const { data: row } = await supabase.from("saves")
            .select("id, title, tag, related_ids, status").eq("id", data.id).single()
          if (row?.status === "ready") finalizeSaveRef.current(row)
        }, 20000)
      }
    } catch (err) {
      setSaveReceipt(null)
      if (err?.name === "AbortError") {
        setMessage("This is taking longer than usual — it may still finish saving in the background. Check Today's saves before retrying.")
      } else {
        setMessage(`Failed to save from ${getSourceLabel(url)}. Try again.`)
      }
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

  const handleAsk = async (overrideQuery) => {
    const q = (overrideQuery ?? query).trim()
    if (!q) return
    setAskLoading(true)
    setSynthesis(null)
    setSynthesisSources([])
    setInsufficientData(null)
    setRecentSearches(prev => {
      const updated = [q, ...prev.filter(s => s !== q)].slice(0, 5)
      localStorage.setItem("recall_recent_searches", JSON.stringify(updated))
      return updated
    })
    try {
      const token = await getToken()
      const res = await fetch(`${BACKEND}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, token })
      })
      const data = await res.json()
      if (!res.ok) {
        setSynthesis("__error__")
        setInsufficientData({ message: data.detail || "Something went wrong — try again" })
      } else if (data.insufficient) {
        setSynthesis("__insufficient__")
        setInsufficientData({ relevant_count: data.relevant_count ?? 0 })
      } else {
        setSynthesis(data.synthesis)
        setSynthesisSources(data.sources || [])
      }
      posthog.capture('ask_performed', { result: data.insufficient ? 'insufficient' : (res.ok ? 'success' : 'error') })
    } catch {
      setSynthesis("__error__")
      setInsufficientData({ message: "Couldn't reach the server — check your connection" })
    }
    setAskLoading(false)
  }

  const fetchCalendarSaves = async () => {
    if (!user) return
    setCalendarLoading(true)
    const { data } = await supabase
      .from("saves")
      .select("id, url, title, tag, content_type, thumbnail_url, created_at, content_text")
      .eq("status", "ready")
      .order("created_at", { ascending: false })
    if (data) {
      const grouped = {}
      data.forEach(save => {
        const key = new Date(save.created_at).toLocaleDateString("en-CA")
        if (!grouped[key]) grouped[key] = []
        grouped[key].push(save)
      })
      setCalendarSaves(grouped)
      setLibraryFeedCount(10)
    }
    setCalendarLoading(false)
  }

  const fetchRelatedSaves = async (ids) => {
    if (!ids?.length) return
    const { data } = await supabase
      .from("saves")
      .select("id, title, url, tag")
      .in("id", ids)
    if (data) setRelatedSaves(data)
  }

  // Resolves a pending save once background enrichment finishes (real title/tag/embedding
  // are in). Always patches the matching Today's-list row; only fires the celebratory
  // chime/vibrate/milestone/posthog side effects if this is still the receipt on screen.
  const finalizeSave = (row) => {
    setTodaySaves(prev => prev.map(s => s.id === row.id ? { ...s, title: row.title, tag: row.tag, status: "ready" } : s))
    if (!(saveReceipt?.id === row.id && saveReceipt?.pending)) return
    const { fromShareSheet, url, media, content_type, label } = saveReceipt
    const newCount = first5Count < 5 ? first5Count + 1 : first5Count
    if (first5Count < 5) setFirst5Count(newCount)
    setSaveReceipt(media
      ? { media: true, content_type, label, title: row.title, tag: row.tag, id: row.id, url, fromShareSheet }
      : { title: row.title, tag: row.tag, id: row.id, url, fromShareSheet, milestoneCount: first5Count < 5 ? newCount : null })
    if (row.related_ids?.length) fetchRelatedSaves(row.related_ids)
    fetchLibraryFilters()
    posthog.capture('url_saved', { tag: row.tag, type: content_type })
    playSuccessChime()
    if (newCount === 5 && first5Count < 5) {
      setTimeout(() => playSuccessChime(), 200)
      navigator.vibrate?.([50, 80, 50, 80, 100])
      setIsFreshReceipt(true)
      setTimeout(() => setIsFreshReceipt(false), 3000)
      setTimeout(() => maybePromptMcpTutorial(), 900)
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
  // finalizeSave closes over state that changes every render (saveReceipt, first5Count,
  // onboardingStep) — the long-lived Realtime subscription below must always call through
  // this ref so it never acts on a stale closure from when the channel was first opened.
  finalizeSaveRef.current = finalizeSave

  const renderSavedArticleCard = (save) => {
    const isEditing = editingTodayTitleId === save.id

    if (isEditing) {
      return (
        <div key={save.id} style={styles.savedArticleCard}>
          <div style={styles.savedArticleTop}>
            <div style={styles.savedArticleMeta}>
              {renderSourceTile(save)}
              <span>{getSiteName(save.url)}</span>
              <span>saved {formatRelativeTime(save.created_at)}</span>
            </div>
          </div>
          <input
            style={styles.savedArticleTitleInput}
            value={draftTodayTitle}
            onChange={e => setDraftTodayTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") updateTodayTitle(save.id, draftTodayTitle)
              if (e.key === "Escape") setEditingTodayTitleId(null)
            }}
            autoFocus
          />
          <div style={styles.savedArticleEditActions}>
            <button onClick={() => updateTodayTitle(save.id, draftTodayTitle)} style={styles.confirmButton}>✓</button>
            <button onClick={() => setEditingTodayTitleId(null)} style={styles.savedArticleGhostButton}>✕</button>
          </div>
        </div>
      )
    }

    return (
      <a key={save.id} href={save.url} target="_blank" rel="noreferrer" style={styles.savedArticleCard}>
        {deletingId === save.id ? (
          <span style={styles.savedArticleStatus}>Removing...</span>
        ) : confirmDeleteId === save.id ? (
          <div style={styles.deleteConfirm} onClick={e => e.stopPropagation()}>
            <span style={styles.deleteConfirmText}>Remove from ReCall?</span>
            <button
              onClick={e => { e.preventDefault(); e.stopPropagation(); deleteSave(save.id) }}
              style={styles.deleteConfirmYes}
            >Delete</button>
            <button
              onClick={e => { e.preventDefault(); e.stopPropagation(); setConfirmDeleteId(null) }}
              style={styles.deleteConfirmNo}
            >Cancel</button>
          </div>
        ) : save.status === "pending" ? (
          <>
            <div style={styles.savedArticleTop}>
              <div style={styles.savedArticleMeta}>
                {renderSourceTile(save)}
                <span>{getSiteName(save.url)}</span>
                <span>saving now</span>
              </div>
              {!save.preview && (
                <button
                  onClick={e => { e.preventDefault(); e.stopPropagation(); setConfirmDeleteId(save.id) }}
                  style={styles.deleteButton}
                  aria-label="Delete"
                ><TrashIcon /></button>
              )}
            </div>
            <span className="shimmer" style={styles.savedArticleTitleShimmer} />
            <span className="shimmer" style={styles.savedArticleCaptionShimmer} />
            <div style={styles.savedArticleTagRow}>
              <span className="shimmer" style={styles.savedArticleTagShimmer} />
            </div>
          </>
        ) : (
          <>
            <div style={styles.savedArticleTop}>
              <div style={styles.savedArticleMeta}>
                {renderSourceTile(save)}
                <span>{getSiteName(save.url)}</span>
                <span>saved {formatRelativeTime(save.created_at)}</span>
              </div>
              {!save.preview && (
                <div style={styles.savedArticleControls}>
                  <button
                    onClick={e => { e.preventDefault(); e.stopPropagation(); setEditingTodayTitleId(save.id); setDraftTodayTitle(save.title || "") }}
                    style={styles.editButton}
                    title="Edit name"
                  >✎</button>
                  <button
                    onClick={e => { e.preventDefault(); e.stopPropagation(); setConfirmDeleteId(save.id) }}
                    style={styles.deleteButton}
                    aria-label="Delete"
                  ><TrashIcon /></button>
                </div>
              )}
            </div>
            <div style={styles.savedArticleBody}>
              <span style={styles.savedArticleTitle}>{save.title || getSourceLabel(save.url)}</span>
              <span style={styles.savedArticleCaption}>{getSaveCaption(save)}</span>
            </div>
            <div style={styles.savedArticleTagRow}>
              {getSaveFolders(save.id).map(f => (
                removeFolderConfirm?.saveId === save.id && removeFolderConfirm?.folderId === f.id ? (
                  <span key={f.id} style={styles.folderRemoveConfirm}>
                    Remove from "{f.name}"?
                    <button onClick={e => { e.preventDefault(); e.stopPropagation(); handleRemoveFromFolder(save.id, f.id) }} style={styles.folderRemoveYes}>Yes</button>
                    <button onClick={e => { e.preventDefault(); e.stopPropagation(); setRemoveFolderConfirm(null) }} style={styles.folderRemoveNo}>Cancel</button>
                  </span>
                ) : (
                  <button
                    key={f.id}
                    onClick={e => { e.preventDefault(); e.stopPropagation(); setRemoveFolderConfirm({ saveId: save.id, folderId: f.id, folderName: f.name }) }}
                    style={styles.folderDisplayPill}
                  ><FolderIcon />{f.name}</button>
                )
              ))}
              <button
                onClick={e => { e.preventDefault(); e.stopPropagation(); setFolderPickerSaveId(save.id) }}
                style={styles.addFolderButton}
              >+ Folder</button>
            </div>
          </>
        )}
      </a>
    )
  }

  if (authLoading) {
    // Paint something immediately instead of staying blank — Android's native PWA splash
    // (manifest icon + background_color) only goes away on first paint, so returning null
    // here means the user stares at that splash for the full duration of the auth check
    // (cold app boot + a Supabase network round trip), not just the JS bundle's load time.
    return (
      <div style={{ ...styles.container, justifyContent: "center", alignItems: "center" }}>
        <img src="/icon.svg" alt="" style={{ width: 64, height: 64, opacity: 0.9 }} />
      </div>
    )
  }

  if (view === 'legal') {
    return (
      <div style={styles.container}>
        <div style={{ display: "flex", alignItems: "center", width: "100%", maxWidth: "760px", margin: "0 auto", padding: "20px 0 16px", boxSizing: "border-box" }}>
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
              <p style={styles.legalP}>When you save a link, we store the URL, an AI-generated title, a category, and just enough about the page to make search work. We do not store your password — sign-in is handled by Google.</p>
              <h3 style={styles.legalH3}>How we use it</h3>
              <p style={styles.legalP}>Everything we store exists solely to power your saves and search. Nothing is used for advertising, and nothing is sold or shared with third parties. Ever.</p>
              <h3 style={styles.legalH3}>Who can see your data</h3>
              <p style={styles.legalP}>Only you. Your saves are private by design — no other user can access or search your content. We don't share it with anyone.</p>
              <h3 style={styles.legalH3}>Third-party services</h3>
              <p style={styles.legalP}>ReCall uses a small set of trusted services to function: Google for sign-in, cloud infrastructure for secure storage, AI to generate titles and power search, and lightweight analytics and error monitoring to keep the app running well. None of these services receive your saved content for their own purposes.</p>
              <h3 style={styles.legalH3}>Deleting your data</h3>
              <p style={styles.legalP}>You're in control. Delete your account and everything in it at any time from the app settings (⚙ in the header). It's immediate and permanent.</p>
              <h3 style={styles.legalH3}>Contact</h3>
              <p style={styles.legalP}>Questions? <a href="https://github.com/Ayush-s-dsouza" target="_blank" rel="noreferrer" style={{ color: "#d9ff5f" }}>Reach the developer on GitHub.</a></p>
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

  if (view === 'mcp-consent') {
    if (!mcpConsentParams?.client_id || !mcpConsentParams?.redirect_uri || !mcpConsentParams?.code_challenge) {
      return (
        <div style={styles.container}>
          <div style={styles.hero}>
            <h1 style={styles.logo}>ReCall</h1>
            <p style={styles.heroBody}>This connection request is missing required information. Go back to the app you were connecting from and try again.</p>
          </div>
        </div>
      )
    }
    const clientLabel = mcpConsentParams.client_name || "a third-party app"
    let redirectHost = ""
    try {
      redirectHost = new URL(mcpConsentParams.redirect_uri).host
    } catch {
      redirectHost = mcpConsentParams.redirect_uri
    }
    return (
      <div style={styles.container}>
        <div style={styles.hero}>
          <h1 style={styles.logo}>ReCall</h1>
          <p style={styles.heroTagline}>Connect to {clientLabel}</p>
          <p style={styles.heroBody}>{clientLabel} wants to search, save, and manage URLs in your ReCall library on your behalf.</p>
          {/* Anyone can register an OAuth client self-named "Claude" or similar — this
              is the only real signal a user has to catch an impersonating app before
              approving, since the app name itself is never verified. */}
          <p style={{ ...styles.heroBody, fontSize: "13px", color: "#aca79b" }}>
            This app will redirect to: <strong>{redirectHost}</strong>
          </p>
          {!user ? (
            <button onClick={signInForMcpConsent} style={styles.button}>Sign in with Google to continue</button>
          ) : (
            <>
              <p style={{ ...styles.heroBody, fontSize: "13px", color: "#aca79b" }}>Signed in as {user.email}</p>
              {mcpConsentError && <p style={styles.error}>{mcpConsentError}</p>}
              <button onClick={approveMcpConsent} disabled={mcpConsenting} style={styles.button}>
                {mcpConsenting ? "Connecting…" : "Allow"}
              </button>
              <button onClick={denyMcpConsent} style={styles.legalFooterLink}>Deny</button>
            </>
          )}
        </div>
      </div>
    )
  }

  if (!user && !preSignupSave) {
    const howSteps = [
      {
        n: "01",
        title: "Save",
        body: "Start with one link. Paste it here, or use Share via ReCall from your phone later.",
      },
      {
        n: "02",
        title: "Browse",
        body: "Your Library becomes the place to look through everything you meant to come back to.",
      },
      {
        n: "03",
        title: "ReCall",
        body: "Find links semantically, use Ask mode, or let an LLM use your saved context.",
      },
    ]
    const defaultLandingArticles = [
      {
        id: "personal-web",
        source: "nytimes.com",
        title: "The Quiet Return of the Personal Website",
        summary: "A new wave of writers and designers are rebuilding their own corners of the web: part rebellion against algorithmic feeds, part return to slower, more intentional reading.",
        topics: ["personal web", "design", "essays", "internet culture"],
        savedAt: "saved 2m ago",
      },
      {
        id: "trust-defaults",
        source: "alistapart.com",
        title: "Designing for Trust When Defaults Do the Work",
        summary: "A practical look at how defaults shape product behavior, user confidence, and the small moments where onboarding either earns attention or loses it.",
        topics: ["product design", "trust", "onboarding"],
        savedAt: "saved 12m ago",
      },
      {
        id: "attention-reading",
        source: "nautil.us",
        title: "What Attention Feels Like When Reading Gets Slow",
        summary: "Researchers and writers trace why deeper reading feels rarer online, and how deliberate capture systems can turn scattered browsing into durable memory.",
        topics: ["attention", "reading", "memory"],
        savedAt: "saved 21m ago",
      },
    ]
    const landingArticles = landingSavedArticles.length > 0 ? landingSavedArticles : defaultLandingArticles

    return (
      <div style={styles.lovablePage}>
        <header style={styles.lovableNav}>
          <a href="#" style={styles.lovableBrand}>
            <img src="/icon.svg" alt="" style={styles.lovableBrandLogo} />
            <span style={styles.lovableBrandText}>ReCall</span>
          </a>
          <nav className="landing-nav-links" style={styles.lovableNavLinks}>
            <a href="#how" style={styles.lovableNavLink}>How it works</a>
          </nav>
          <div style={styles.lovableNavActions}>
            <button className="landing-sign-in-link" onClick={() => signIn()} style={styles.lovablePlainButton}>Sign in</button>
            <button onClick={() => signIn(preAuthUrl)} style={styles.lovableDarkButton}>Start free</button>
          </div>
        </header>

        <main>
          <section style={styles.lovableHero}>
            <div style={styles.lovableHeroBackdrop} />
            <div style={styles.lovableHeroInner}>
              <div style={styles.lovableHeroCopy}>
                <div style={styles.lovablePill}>
                  <span style={styles.lovablePillDot} />
                  Memory layer for the modern reader
                </div>
                <h1 style={styles.lovableHeroTitle}>
                  Save every link. Remember everything. Hand it to any LLM.
                </h1>
                <p style={styles.lovableHeroText}>
                  ReCall turns the things you read online into a private, searchable library you can browse, ask questions over, and use as context in the AI tools you already trust.
                </p>
              </div>

              <div style={styles.lovableComposerWrap}>
                <p style={styles.lovableComposerPrompt}>Start building your library - paste a link</p>
                <div style={styles.lovableComposer}>
                  <span style={styles.lovableComposerIcon}><LinkIcon /></span>
                  <input
                    type="url"
                    placeholder="Paste any URL"
                    style={styles.lovableComposerInput}
                    value={preAuthUrl}
                    onChange={e => {
                      setPreAuthUrl(e.target.value)
                      setLandingPreviewError("")
                    }}
                    onKeyDown={e => { if (e.key === "Enter") saveBeforeSignup() }}
                  />
                  <button
                    onClick={() => saveBeforeSignup()}
                    disabled={loading}
                    style={{ ...styles.lovableComposerButton, opacity: loading ? 0.72 : 1 }}
                  >
                    {loading ? "Saving..." : "Save"} <ArrowRightIcon />
                  </button>
                </div>
                {landingPreviewError && <p style={styles.lovableError}>{landingPreviewError}</p>}
                <p style={styles.lovableComposerNote}>Bring in one link first. ReCall will show how it looks before you sign in.</p>
              </div>

              <div style={styles.lovablePreviewStack}>
                <div style={styles.lovableFloatBadge}>auto-tagged</div>
                <div style={styles.lovableArticleList}>
                  {landingArticles.map((article, index) => (
                    <article key={article.id} style={index === 0 ? styles.lovablePreviewCard : styles.lovablePreviewCardCompact}>
                      <div style={styles.lovablePreviewMeta}>
                        <span style={styles.lovableSourceTile} />
                        <span>{article.source}</span>
                        <span>{article.savedAt}</span>
                      </div>
                      <h3 style={styles.lovablePreviewTitle}>
                        {article.title}
                      </h3>
                      <p style={styles.lovablePreviewBody}>
                        {article.summary}
                      </p>
                      <div style={styles.lovableTagRow}>
                        {article.topics.map(topic => (
                          <span key={topic} style={styles.lovableTag}><TagIcon />{topic}</span>
                        ))}
                      </div>
                      {index === 0 && (
                        <div style={styles.lovablePreviewFooter}>
                          <span>{landingSavedArticles.length > 0 ? "Saved locally in your preview library" : "3 related saves in your library"}</span>
                          <button onClick={startLandingSignIn} style={styles.lovableTextButton}>Open ↗</button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section id="how" style={styles.lovableSection}>
            <div style={styles.lovableSectionIntro}>
              <p style={styles.lovableKicker}>How it works</p>
              <h2 style={styles.lovableSectionTitle}>Save, browse, and ReCall what mattered.</h2>
            </div>
            <div style={styles.lovableStepsGrid}>
              {howSteps.map(step => (
                <div key={step.n} style={styles.lovableStepCard}>
                  <div style={styles.lovableStepTop}>
                    <span style={styles.lovableStepNumber}>{step.n}</span>
                    <span style={styles.lovableStepIcon}>{step.n === "01" ? "save" : step.n === "02" ? "browse" : "recall"}</span>
                  </div>
                  <h3 style={styles.lovableCardTitle}>{step.title}</h3>
                  <p style={styles.lovableCardBody}>{step.body}</p>
                </div>
              ))}
            </div>
          </section>

          <section id="cta" style={styles.lovableFinalCta}>
            <div style={styles.lovableFinalBackdrop} />
            <h2 style={styles.lovableFinalTitle}>Start your memory.</h2>
            <p style={styles.lovableHeroText}>Free to try. No card. Your saved internet, finally searchable.</p>
            <button onClick={() => signIn(preAuthUrl)} style={styles.lovableFinalButton}>Get started with Google <ArrowRightIcon /></button>
          </section>
        </main>

        <footer style={styles.lovableFooter}>
          <span style={styles.lovableFooterBrand}><img src="/icon.svg" alt="" style={styles.lovableFooterLogo} />ReCall - your saved internet, finally searchable</span>
          <div style={styles.lovableFooterLinks}>
            <button onClick={() => { setLegalSection('privacy'); setView('legal') }} style={styles.lovableFooterLink}>Privacy</button>
            <button onClick={() => { setLegalSection('terms'); setView('legal') }} style={styles.lovableFooterLink}>Terms</button>
          </div>
        </footer>

      </div>
    )
  }

  const installInstructions = isIOS ? (
    <div style={{ ...styles.overlaySteps, marginTop: "8px" }}>
      <p style={styles.overlayStep}>① Tap the <strong>Share</strong> icon in Safari</p>
      <p style={styles.overlayStep}>② Tap <strong>"Add to Home Screen"</strong> → <strong>"Add"</strong></p>
    </div>
  ) : (
    <div style={{ ...styles.overlaySteps, marginTop: "8px" }}>
      <p style={styles.overlayStep}>① Tap <strong>⋮</strong> in Chrome → <strong>"Add to Home Screen"</strong></p>
    </div>
  )
  const tourHighlightStyle = (key, extra = {}) => activeTourHighlight === key
    ? { ...extra, ...styles.tourHighlight }
    : extra
  const handleFeatureTourStep = (step) => {
    const highlight = step?.highlight || null
    setActiveTourHighlight(highlight)
    if (!highlight) return

    if (highlight === "import-x") {
      setView("save")
      setShowSettings(true)
      setOpenSettingsSection("import")
      setXBookmarkletFallback(false)
      return
    }

    if (highlight === "search") {
      setView("search")
      setShowSettings(false)
      setOpenSettingsSection(null)
      window.setTimeout(() => searchInputRef.current?.focus(), 80)
      return
    }

    if (highlight === "connect-llm") {
      setView("recall")
      setShowSettings(false)
      setOpenSettingsSection(null)
      if (mcpConnections === null) fetchMcpConnections()
      return
    }

    if (highlight === "sign-in") {
      setView("save")
      setShowSettings(false)
      setOpenSettingsSection(null)
    }
  }
  const visibleTodaySaves = !user && preSignupSave ? [preSignupSave] : todaySaves
  const clearSearchFocusIfLeft = () => setTimeout(() => {
    if (!searchSectionRef.current?.contains(document.activeElement)) setSearchInputFocused(false)
  }, 150)
  const filterDropdownsJSX = (libraryFilters.sources.length > 1 || folders.length > 0) && (
    <div style={styles.filterRow}>
      {libraryFilters.sources.length > 1 && (
        <div style={styles.filterDropdownWrapper}>
          <select
            style={styles.filterDropdown}
            value={selectedSource || ""}
            onChange={e => { setSelectedSource(e.target.value || null); setDisplayCount(5); setLibraryFeedCount(10) }}
            onBlur={clearSearchFocusIfLeft}
          >
            <option value="">All sources</option>
            {libraryFilters.sources.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      )}
      {folders.length > 0 && (
        <div style={styles.filterDropdownWrapper}>
          <select
            style={styles.filterDropdown}
            value={selectedFolder || ""}
            onChange={e => { setSelectedFolder(e.target.value || null); setDisplayCount(5); setLibraryFeedCount(10) }}
            onBlur={clearSearchFocusIfLeft}
          >
            <option value="">All folders</option>
            {folders.map(f => <option key={f.id} value={f.name}>{f.name}</option>)}
          </select>
        </div>
      )}
    </div>
  )
  const recallConnectorContent = (
    <>
      <div style={styles.tokenSection}>
        <div data-tour="mcp-link" style={{ ...styles.tokenRow, ...tourHighlightStyle("connect-llm", { borderRadius: "14px" }) }}>
          <input readOnly value={`${BACKEND}/mcp`} style={styles.tokenInput} onFocus={e => e.target.select()} />
          <button
            onClick={() => { navigator.clipboard.writeText(`${BACKEND}/mcp`); setTokenCopied(true); setTimeout(() => setTokenCopied(false), 2000) }}
            style={styles.tokenCopyButton}
          >{tokenCopied ? "Copied!" : "Copy"}</button>
        </div>
        <p style={styles.tokenWarning}>
          Paste this URL into ChatGPT, Claude, or any MCP-compatible client's custom connector dialog. You'll sign in with Google and approve access — no token to copy.
        </p>
      </div>

      <div style={styles.settingsDivider} />

      <button
        onClick={openDeferredMcpTutorial}
        style={{ ...styles.mcpLearnPanelButton, ...(mcpLearnHighlighted ? styles.mcpLearnPanelButtonHighlight : {}) }}
      >
        <span style={styles.mcpLearnPanelIcon}><PlugIcon /></span>
        <span style={styles.mcpLearnPanelText}>Learn more here</span>
      </button>
      <div style={styles.settingsDivider} />

      <p style={styles.settingsSectionHeading}>Connected apps</p>
      {mcpConnections === null ? (
        <p style={styles.tokenWarning}>Loading…</p>
      ) : mcpConnections.length === 0 ? (
        <p style={styles.tokenWarning}>No apps connected yet.</p>
      ) : (
        <div style={styles.tokenSection}>
          {mcpConnections.map(c => (
            <div key={c.client_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "13px", color: "#aca79b" }}>
                {c.client_name || "Unnamed app"}
                <span style={{ color: "#666" }}> · connected {new Date(c.connected_at).toLocaleDateString()}</span>
              </span>
              <button
                onClick={() => disconnectMcpClient(c.client_id)}
                disabled={mcpDisconnectingId === c.client_id}
                style={styles.tokenHideButton}
              >{mcpDisconnectingId === c.client_id ? "Disconnecting…" : "Disconnect"}</button>
            </div>
          ))}
        </div>
      )}
    </>
  )

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.logoSmall}>ReCall</h1>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {user ? (
            <>
              <HelpMenuButton style={styles.headerIconButton} />
              <button
                onClick={() => { setShowSettings(s => !s); setConfirmDeleteAccount(false); setTokenCopied(false) }}
                style={{ ...styles.headerRoundButton, ...styles.headerIconButton }}
                title="Settings"
                aria-label="Settings"
              ><GearIcon /></button>
              <button onClick={signOut} style={styles.signOut}>Sign out</button>
            </>
          ) : (
            <button
              data-tour="sign-in-button"
              onClick={() => signIn(preSignupSave?.url || preAuthUrl)}
              style={{ ...styles.signOut, ...tourHighlightStyle("sign-in") }}
            >Sign in</button>
          )}
        </div>
      </div>
      <FeatureTour
        autoOpen={!!user}
        onStepChange={handleFeatureTourStep}
        restartKey={!user && preSignupSave ? preSignupTourKey : null}
        steps={!user && preSignupSave ? PRE_SIGNUP_TOUR_STEPS : undefined}
      />

      {message && <p style={xConnecting ? styles.neutral : (isError ? styles.error : styles.success)}>{message}</p>}

      {showInstallUI && !installBannerDismissed && (
        <div style={styles.installBanner}>
          <div style={styles.installBannerRow}>
            <span style={styles.installBannerText}>
              {isIOS ? "Install ReCall for quick access" : "Install ReCall for one-tap saving"}
            </span>
            <div style={styles.installBannerActions}>
              <button onClick={handleInstallClick} style={styles.installBannerButton}>
                {deferredInstallPrompt ? "Install" : "Show me"}
              </button>
              <button
                onClick={() => { localStorage.setItem('recall_install_banner_dismissed', 'true'); setInstallBannerDismissed(true) }}
                style={styles.installBannerDismiss}
                title="Dismiss"
              >✕</button>
            </div>
          </div>
          {installStepsOpen && installInstructions}
        </div>
      )}

      {showSettings && (
        <div style={styles.settingsPanel}>
          <div style={styles.settingsLinks}>
            <button onClick={() => { setLegalSection('privacy'); setView('legal'); setShowSettings(false) }} style={styles.settingsLink}>Privacy Policy</button>
            <button onClick={() => { setLegalSection('terms'); setView('legal'); setShowSettings(false) }} style={styles.settingsLink}>Terms of Service</button>
          </div>
          <div style={styles.settingsDivider} />

          {/* Notify me when a save finishes enriching — only relevant since saves now
              resolve their title/tag in the background after the initial "Saved ✓" */}
          {pushSupported && (
            <>
              <p style={styles.settingsSectionHeading}>Notifications</p>
              {pushEnabled ? (
                <p style={styles.tokenWarning}>You'll get notified when a save finishes processing — even if you've closed the app.</p>
              ) : (
                <>
                  <button onClick={enableSaveNotifications} style={styles.settingsLink}>
                    Notify me when saves finish →
                  </button>
                  <p style={styles.tokenWarning}>Useful since the title/tag now fill in a moment after you save — close the app and we'll let you know when it's ready.</p>
                </>
              )}
              <div style={styles.settingsDivider} />
            </>
          )}

          {/* Import (X bookmarks + LinkedIn saved posts) — collapsible */}
          <button
            onClick={() => setOpenSettingsSection(s => s === 'import' ? null : 'import')}
            style={styles.settingsAccordionHeader}
          >
            <span>Import</span>
            <span style={styles.settingsAccordionChevron}>{openSettingsSection === 'import' ? "▾" : "▸"}</span>
          </button>
          {openSettingsSection === 'import' && (
            <div style={styles.settingsAccordionBody}>
              <p style={styles.settingsSectionHeading}>Import your X bookmarks</p>
              {!importJob || importJob.status === "completed" || importJob.status === "stalled" ? (
                <>
                  <button
                    data-tour="import-x-button"
                    onClick={connectXForImport}
                    disabled={xConnecting}
                    style={{ ...styles.shortcutAddButton, border: "none", ...tourHighlightStyle("import-x") }}
                  >
                    {xConnecting ? "Connecting…" : "𝕏 Connect X to import bookmarks"}
                  </button>
                  <p style={styles.overlayNote}>
                    One tap — log into X, approve access, and ReCall imports your bookmarks automatically.
                    {importJob?.status === "completed" && (
                      <> Last import: <strong>{importJob.succeeded}</strong> added, {importJob.duplicates} already saved, {importJob.skipped} skipped, {importJob.failed} failed.</>
                    )}
                    {importJob?.status === "stalled" && (
                      <> Last import stalled ({importJob.processed}/{importJob.total} done). Run it again to retry — already-imported bookmarks are skipped.</>
                    )}
                  </p>
                  <input
                    ref={importFileInputRef}
                    type="file"
                    accept=".json,.csv,.txt,.js,.zip"
                    onChange={handleImportFileChange}
                    style={{ display: "none" }}
                  />
                  <button
                    onClick={() => setXBookmarkletFallback(o => !o)}
                    style={{ ...styles.settingsLink, fontSize: 12, color: "#7d786f", alignSelf: "flex-start", marginTop: "4px" }}
                  >
                    {xBookmarkletFallback ? "Hide other import options" : "Can't or won't connect your account?"}
                  </button>
                  {xBookmarkletFallback && (
                    <div style={{ ...styles.overlaySteps, marginTop: "8px" }}>
                      <a
                        ref={xBookmarkletRef}
                        onClick={e => e.preventDefault()}
                        draggable="true"
                        style={{ ...styles.shortcutAddButton, display: "inline-block", cursor: "grab" }}
                      >
                        📑 Import X Bookmarks
                      </a>
                      <p style={styles.overlayNote}>
                        Drag this button to your bookmarks bar (don't click it here). Then open{" "}
                        <strong>x.com/i/bookmarks</strong> in a new tab and click it there — it collects your bookmarks and opens ReCall to import them automatically.
                        Leave the tab alone while it's running — manually scrolling can interfere with how it collects your bookmarks.
                      </p>
                      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "4px" }}>
                        <button
                          onClick={() => importFileInputRef.current?.click()}
                          style={{ ...styles.settingsLink, fontSize: 12, color: "#7d786f" }}
                          disabled={importUploading}
                        >
                          {importUploading ? "Uploading…" : "or upload a file export instead"}
                        </button>
                        <button
                          onClick={() => { navigator.clipboard.writeText(BOOKMARKLET_CODE); setXCodeCopied(true); setTimeout(() => setXCodeCopied(false), 2000) }}
                          style={{ ...styles.settingsLink, fontSize: 12, color: "#7d786f" }}
                        >
                          {xCodeCopied ? "Copied!" : "or copy the bookmarklet code"}
                        </button>
                        <button onClick={() => setXBookmarkletHelpOpen(o => !o)} style={{ ...styles.settingsLink, fontSize: 12, color: "#7d786f" }}>
                          {xBookmarkletHelpOpen ? "Hide Safari/Arc help" : "Drag not working? (Safari/Arc)"}
                        </button>
                      </div>
                      {xBookmarkletHelpOpen && (
                        <div style={{ ...styles.overlaySteps, marginTop: "8px" }}>
                          <p style={styles.overlayStep}><strong>Safari:</strong> make sure your Favorites bar is visible first — View → Show Favorites Bar (⌘⇧B) — then drag the button again. Still stuck? Copy the code above, create any bookmark, and paste the code into its address field.</p>
                          <p style={styles.overlayStep}><strong>Arc:</strong> Arc doesn't support dragging bookmarklets. Copy the code above, open <strong>x.com/i/bookmarks</strong>, click the Boost icon next to the address bar → New Boost → paste the code into the Custom JS box → Save. It'll run automatically on that page from then on.</p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p style={styles.overlayNote}>
                    Importing… {importJob.processed} / {importJob.total}
                    {importJob.duplicates > 0 || importJob.skipped > 0 || importJob.failed > 0
                      ? ` (${[
                          importJob.duplicates > 0 ? `${importJob.duplicates} duplicate${importJob.duplicates !== 1 ? "s" : ""}` : null,
                          importJob.skipped > 0 ? `${importJob.skipped} skipped` : null,
                          importJob.failed > 0 ? `${importJob.failed} failed` : null,
                        ].filter(Boolean).join(", ")})`
                      : ""}
                  </p>
                  <div style={{ height: 4, background: "#171719", borderRadius: 2, margin: "4px 0 8px" }}>
                    <div style={{
                      height: "100%",
                      width: `${importJob.total > 0 ? Math.round((importJob.processed / importJob.total) * 100) : 0}%`,
                      background: "#4ade80",
                      borderRadius: 2,
                      transition: "width 0.4s ease",
                    }} />
                  </div>
                </>
              )}

              <div style={styles.settingsDivider} />

              <p style={styles.settingsSectionHeading}>Import your LinkedIn saved posts</p>
              {(!importJob || importJob.status === "completed" || importJob.status === "stalled") && (
                <>
                  <a
                    ref={linkedinBookmarkletRef}
                    onClick={e => e.preventDefault()}
                    draggable="true"
                    style={{ ...styles.shortcutAddButton, display: "inline-block", cursor: "grab" }}
                  >
                    💼 Import LinkedIn Saved Posts
                  </a>
                  <p style={styles.overlayNote}>
                    Heads up: LinkedIn blocks most saved-post content from browsers that aren't logged in, so this typically recovers <strong>about 60% of your saves, sometimes more</strong> — we bring in everything that's publicly viewable and skip the rest automatically. Still way better than starting from zero.
                  </p>
                  <p style={styles.overlayNote}>
                    Drag this button to your bookmarks bar (don't click it here). Then open{" "}
                    <strong>linkedin.com/my-items/saved-posts/</strong>, scroll down a little so your posts load, and click it there.
                    It can take a couple of minutes (LinkedIn loads this page slowly) and then redirects that tab to ReCall automatically — leave it running in the background, don't close the tab.
                    {importJob?.status === "completed" && importJob.source === "url_scraped" && (
                      <> Last import: <strong>{importJob.succeeded}</strong> public posts imported{importJob.duplicates > 0 ? `, ${importJob.duplicates} already saved` : ""}. The rest needed a LinkedIn login to view.</>
                    )}
                    {importJob?.status === "stalled" && importJob.source === "url_scraped" && (
                      <> Last import stalled ({importJob.processed}/{importJob.total} done). Run it again to retry — already-imported posts are skipped.</>
                    )}
                  </p>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "4px" }}>
                    <button
                      onClick={() => { navigator.clipboard.writeText(LINKEDIN_BOOKMARKLET_CODE); setLinkedinCodeCopied(true); setTimeout(() => setLinkedinCodeCopied(false), 2000) }}
                      style={{ ...styles.settingsLink, fontSize: 12, color: "#7d786f" }}
                    >
                      {linkedinCodeCopied ? "Copied!" : "or copy the bookmarklet code"}
                    </button>
                    <button onClick={() => setLinkedinBookmarkletHelpOpen(o => !o)} style={{ ...styles.settingsLink, fontSize: 12, color: "#7d786f" }}>
                      {linkedinBookmarkletHelpOpen ? "Hide Safari/Arc help" : "Drag not working? (Safari/Arc)"}
                    </button>
                  </div>
                  {linkedinBookmarkletHelpOpen && (
                    <div style={{ ...styles.overlaySteps, marginTop: "8px" }}>
                      <p style={styles.overlayStep}><strong>Safari:</strong> make sure your Favorites bar is visible first — View → Show Favorites Bar (⌘⇧B) — then drag the button again. Still stuck? Copy the code above, create any bookmark, and paste the code into its address field.</p>
                      <p style={styles.overlayStep}><strong>Arc:</strong> Arc doesn't support dragging bookmarklets. Copy the code above, open <strong>linkedin.com/my-items/saved-posts/</strong>, click the Boost icon next to the address bar → New Boost → paste the code into the Custom JS box → Save. It'll run automatically on that page from then on.</p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {isIOS && (
            <>
              <div style={styles.settingsDivider} />

              {/* Save from any app — iOS Share Sheet Shortcut guide — collapsible */}
              <button
                onClick={() => setOpenSettingsSection(s => s === 'shortcuts' ? null : 'shortcuts')}
                style={styles.settingsAccordionHeader}
              >
                <span>Save from any app</span>
                <span style={styles.settingsAccordionChevron}>{openSettingsSection === 'shortcuts' ? "▾" : "▸"}</span>
              </button>
              {openSettingsSection === 'shortcuts' && (
                <div style={styles.settingsAccordionBody}>
                  {SAVE_TO_RECALL_SHORTCUT_URL && (
                    <>
                      <a href={SAVE_TO_RECALL_SHORTCUT_URL} target="_blank" rel="noreferrer" style={styles.shortcutAddButton}>
                        Add "Save to ReCall" Shortcut
                      </a>
                      <p style={styles.overlayNote}>After adding, open the Share Sheet on any link → scroll to the <strong>Shortcuts</strong> row (tap "More" if you don't see it) → tap <strong>Save to ReCall</strong>.</p>
                    </>
                  )}
                  <button onClick={() => setShortcutGuideOpen(o => !o)} style={styles.settingsLink}>
                    {shortcutGuideOpen ? "Hide manual setup" : SAVE_TO_RECALL_SHORTCUT_URL ? "Set it up manually instead →" : "Set up Share Sheet →"}
                  </button>
                  {shortcutGuideOpen && (
                    <div style={styles.overlaySteps}>
                      <p style={styles.overlayStep}>① Open the <strong>Shortcuts</strong> app → tap <strong>+</strong> to create a new shortcut</p>
                      <p style={styles.overlayStep}>② Tap the <strong>ⓘ</strong> info button → enable <strong>"Use with Share Sheet"</strong>, set types to <strong>URLs, Safari Web Pages, Text</strong></p>
                      <p style={styles.overlayStep}>③ Add action <strong>"URL"</strong> → set it to <strong>https://recall-iota-six.vercel.app/?text=</strong> followed by the Shortcut Input variable</p>
                      <p style={styles.overlayStep}>④ Add action <strong>"Open URLs"</strong> → input = the URL from step ③</p>
                      <p style={styles.overlayStep}>⑤ Name it <strong>"Save to ReCall"</strong> and tap Done</p>
                      <p style={styles.overlayStep}>⑥ Share any link → scroll to the <strong>Shortcuts</strong> row → tap <strong>Save to ReCall</strong></p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <div style={styles.settingsDivider} />

          {/* Save newsletters by email — collapsible */}
          <button
            onClick={() => setOpenSettingsSection(s => s === 'newsletters' ? null : 'newsletters')}
            style={styles.settingsAccordionHeader}
          >
            <span>Save newsletters by email</span>
            <span style={styles.settingsAccordionChevron}>{openSettingsSection === 'newsletters' ? "▾" : "▸"}</span>
          </button>
          {openSettingsSection === 'newsletters' && (
            <div style={styles.settingsAccordionBody}>
              {EMAIL_INBOUND_ADDRESS ? (
                <>
                  <p style={styles.overlayNote}>Forward a newsletter to this address (from <strong>{user?.email}</strong>) to save it:</p>
                  <div style={styles.tokenRow}>
                    <input readOnly value={EMAIL_INBOUND_ADDRESS} style={styles.tokenInput} onFocus={e => e.target.select()} />
                    <button
                      onClick={() => { navigator.clipboard.writeText(EMAIL_INBOUND_ADDRESS); setNewsletterAddressCopied(true); setTimeout(() => setNewsletterAddressCopied(false), 2000) }}
                      style={styles.tokenCopyButton}
                    >
                      {newsletterAddressCopied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                  <p style={styles.overlayNote}>Want every future issue from one sender saved automatically? Set up a Gmail filter ("from this sender → forward to this address") once — no need to forward manually again.</p>
                </>
              ) : (
                <p style={styles.overlayNote}>Newsletter forwarding isn't configured on this deployment yet.</p>
              )}
            </div>
          )}

          {composioConnections !== null && (
            <>
              <div style={styles.settingsDivider} />

              {/* Connected accounts — ReCall reading from a third-party account (Notion), not
                  to be confused with "Connected apps" above (other apps connecting TO ReCall
                  via MCP) — opposite direction. */}
              <button
                onClick={() => setOpenSettingsSection(s => s === 'composio' ? null : 'composio')}
                style={styles.settingsAccordionHeader}
              >
                <span>Connected accounts</span>
                <span style={styles.settingsAccordionChevron}>{openSettingsSection === 'composio' ? "▾" : "▸"}</span>
              </button>
              {openSettingsSection === 'composio' && (
                <div style={styles.settingsAccordionBody}>
                  <p style={styles.overlayNote}>Connect your Notion account so ReCall can read private/workspace-restricted pages you save, not just public ones.</p>
                  {(() => {
                    const conn = composioConnections.find(c => c.toolkit === 'notion')
                    return (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                        <span style={{ fontSize: "13px", color: "#aca79b" }}>
                          Notion
                          {conn && <span style={{ color: "#666" }}> · connected {new Date(conn.created_at).toLocaleDateString()}</span>}
                        </span>
                        {conn ? (
                          <button
                            onClick={() => disconnectComposio('notion')}
                            disabled={composioDisconnectingToolkit === 'notion'}
                            style={styles.tokenHideButton}
                          >{composioDisconnectingToolkit === 'notion' ? "Disconnecting…" : "Disconnect"}</button>
                        ) : (
                          <button
                            onClick={() => connectComposio('notion')}
                            disabled={composioConnectingToolkit === 'notion'}
                            style={styles.tokenHideButton}
                          >{composioConnectingToolkit === 'notion' ? "Connecting…" : "Connect"}</button>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )}
            </>
          )}

          <div style={styles.settingsDivider} />
          <button
            onClick={() => setOpenSettingsSection(openSettingsSection !== 'folders' ? 'folders' : null)}
            style={styles.settingsAccordionHeader}
          >
            <span>Folders {folders.length > 0 ? `(${folders.length})` : ""}</span>
            <span style={styles.settingsAccordionChevron}>{openSettingsSection === 'folders' ? "▾" : "▸"}</span>
          </button>
          {openSettingsSection === 'folders' && (
            <div style={styles.settingsAccordionBody}>
              {folders.length === 0 ? (
                <p style={styles.overlayNote}>No folders yet. Save something and tap "+ Folder" to create one.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "100%" }}>
                  {folders.map(f => (
                    <div key={f.id} style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%" }}>
                      {editingFolderId === f.id ? (
                        <>
                          <input
                            style={{ ...styles.savedArticleTitleInput, flex: 1 }}
                            value={draftFolderName}
                            onChange={e => setDraftFolderName(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") renameFolder(f.id, draftFolderName) }}
                            autoFocus
                          />
                          <button onClick={() => renameFolder(f.id, draftFolderName)} style={styles.confirmButton}>✓</button>
                          <button onClick={() => setEditingFolderId(null)} style={styles.savedArticleGhostButton}>✕</button>
                        </>
                      ) : (
                        <>
                          <span style={{ flex: 1, color: "#f6f3ea", fontSize: 14, display: "inline-flex", alignItems: "center", gap: "6px" }}><FolderIcon size={13} />{f.name}</span>
                          <span style={{ color: "#666", fontSize: 12 }}>{f.save_count} saves</span>
                          <button onClick={() => { setEditingFolderId(f.id); setDraftFolderName(f.name) }} style={styles.editButton} title="Rename">✎</button>
                          <button onClick={() => deleteFolder(f.id)} style={styles.deleteButton} aria-label="Delete folder"><TrashIcon /></button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

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

      {/* Folder picker bottom sheet */}
      {folderPickerSaveId && (
        <div style={styles.overlay} onClick={() => { setFolderPickerSaveId(null); setNewFolderName("") }}>
          <div style={{ ...styles.bottomSheet, position: "relative", maxHeight: "70vh", overflowY: "auto", borderRadius: "24px" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontWeight: 600, color: "#f6f3ea", fontSize: 15 }}>Add to folders</span>
              <button onClick={() => { setFolderPickerSaveId(null); setNewFolderName("") }} style={styles.savedArticleGhostButton}>✕</button>
            </div>
            {folders.length === 0 ? (
              <p style={{ ...styles.overlayNote, marginBottom: 12 }}>Create your first folder below.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: 16 }}>
                {folders.map(f => {
                  const isChecked = pickerFolderIds.has(f.id)
                  return (
                    <label key={f.id} style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {
                          const newIds = isChecked
                            ? [...pickerFolderIds].filter(id => id !== f.id)
                            : [...pickerFolderIds, f.id]
                          setPickerFolderIds(new Set(newIds))
                          setSaveFolders(folderPickerSaveId, newIds)
                        }}
                        style={{ width: 16, height: 16, accentColor: "#d9ff5f", flexShrink: 0 }}
                      />
                      <span style={{ color: "#f6f3ea", fontSize: 14, flex: 1, display: "inline-flex", alignItems: "center", gap: "6px" }}><FolderIcon size={13} />{f.name}</span>
                      <span style={{ color: "#555", fontSize: 12 }}>{f.save_count}</span>
                    </label>
                  )
                })}
              </div>
            )}
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                style={{ ...styles.input, flex: 1, fontSize: 13, padding: "8px 12px" }}
                placeholder="New folder name…"
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && newFolderName.trim()) createFolder(newFolderName) }}
              />
              <button
                onClick={() => { if (newFolderName.trim()) createFolder(newFolderName) }}
                style={{ ...styles.confirmButton, opacity: newFolderName.trim() ? 1 : 0.4 }}
              >Add</button>
            </div>
          </div>
        </div>
      )}

      <div style={styles.tabs}>
        <button onClick={() => { setView("save") }} style={view === "save" ? styles.tabActive : styles.tab}>Save</button>
        <button onClick={() => { setView("search") }} style={view === "search" ? styles.tabActive : styles.tab}>Search</button>
        <button onClick={() => { setView("recall"); if (mcpConnections === null) fetchMcpConnections() }} style={view === "recall" ? styles.tabActive : styles.tab}>ReCall</button>
      </div>

      {view === "search" && (
        <div style={styles.section} ref={searchSectionRef}>

          {/* Search bar */}
          <div data-tour="search-bar" style={{ ...styles.searchBarWrapper, ...tourHighlightStyle("search", { borderRadius: "14px" }) }}>
            <input
              ref={searchInputRef}
              style={styles.searchBarInput}
              placeholder={askMode ? "Ask anything about your saves…" : "What are you looking for?"}
              value={query}
              onChange={e => {
                const v = e.target.value
                setQuery(v)
                if (hasSearched && v.trim() === "") { setHasSearched(false); setResults([]) }
              }}
              onKeyDown={e => { if (e.key === "Enter") askMode ? handleAsk() : handleSearch() }}
              onFocus={() => setSearchInputFocused(true)}
              onBlur={() => setTimeout(() => {
                if (!searchSectionRef.current?.contains(document.activeElement)) setSearchInputFocused(false)
              }, 150)}
            />
            <button
              onClick={() => {
                if (!askMode && query.trim() !== "") {
                  setQuery("")
                  setHasSearched(false)
                  setResults([])
                  searchInputRef.current?.focus()
                } else {
                  askMode ? handleAsk() : handleSearch()
                }
              }}
              style={styles.searchBarButton}
              disabled={loading || askLoading}
              aria-label={askMode ? "Ask" : (query.trim() !== "" ? "Clear" : "Search")}
            >{askMode ? "✦" : (query.trim() !== "" ? <ClearIcon /> : <SearchIcon />)}</button>
          </div>
          {/* Ask / Search mode toggle */}
          <div style={styles.modeToggle}>
            <button
              onClick={() => { setAskMode(false); setSynthesis(null) }}
              style={!askMode ? styles.modeToggleActive : styles.modeToggleInactive}
            >Search</button>
            <button
              onClick={() => { setAskMode(true); setResults([]) }}
              style={askMode ? styles.modeToggleActive : styles.modeToggleInactive}
            >✦ Ask</button>
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
          {(loading || askLoading) && (
            <>
              <span className="shimmer" style={styles.searchShimmerBar} />
              {askLoading && askStep && <p style={styles.askStepText}>{askStep}</p>}
            </>
          )}

          {/* Synthesis card (Ask mode) */}
          {askMode && synthesis && synthesis !== "__insufficient__" && (
            <div style={styles.synthesisCard}>
              <div style={styles.synthesisHeader}>
                <span style={styles.synthesisLabel}>✦ Based on your saves</span>
              </div>
              <p style={styles.synthesisText}>{synthesis}</p>
              {synthesisSources.length > 0 && (
                <div style={styles.synthesisSources}>
                  <span style={styles.synthesisSourcesLabel}>Sources</span>
                  <div style={styles.synthesisSourceChips}>
                    {synthesisSources.map(s => (
                      <a key={s.id} href={s.url} target="_blank" rel="noreferrer" style={styles.synthesisSourceChip}>
                        {s.title}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Insufficient sources message */}
          {askMode && synthesis === "__insufficient__" && (
            <div style={styles.synthesisInsufficient}>
              <p style={{ margin: 0, color: "#aca79b", fontSize: 14 }}>
                {insufficientData?.relevant_count === 0
                  ? "Nothing focused on this topic yet."
                  : `Only ${insufficientData?.relevant_count} closely-matched save${insufficientData?.relevant_count === 1 ? "" : "s"} on this — save ${3 - (insufficientData?.relevant_count ?? 0)} more focused articles to unlock synthesis.`}
              </p>
              <button style={styles.zeroResultsCta} onClick={() => setView("save")}>Save a page about this →</button>
            </div>
          )}

          {/* Error message */}
          {askMode && synthesis === "__error__" && (
            <div style={styles.synthesisInsufficient}>
              <p style={{ margin: 0, color: "#aca79b", fontSize: 14 }}>
                {insufficientData?.message || "Something went wrong — try again"}
              </p>
            </div>
          )}

          {/* Zero-results state */}
          {hasSearched && !loading && results.length === 0 && (
            <div style={styles.zeroResults}>
              <p style={styles.zeroResultsMain}>
                {query.trim()
                  ? `Nothing found for "${query}"`
                  : selectedFolder
                    ? `Nothing in "${selectedFolder}" yet`
                    : selectedSource
                      ? `Nothing from ${selectedSource} yet`
                      : "Nothing found"}
              </p>
              <p style={styles.zeroResultsSub}>Try different words, or save more content.</p>
              <button
                style={styles.zeroResultsCta}
                onClick={() => setView("save")}
              >Save a page about this →</button>
            </div>
          )}

          {/* Idle/browse (calendar) + focused/filter (dropdowns + feed) blank-state browsing —
              folded in from the old separate Library tab */}
          {!hasSearched && (() => {
            const TAG_COLORS = {
              Tech: "#c084fc", Product: "#60a5fa", Business: "#34d399",
              Finance: "#fbbf24", Health: "#f87171", Personal: "#a78bfa", Other: "#6b7280"
            }
            const year = calendarMonth.getFullYear()
            const month = calendarMonth.getMonth()
            const firstDay = new Date(year, month, 1).getDay()
            const daysInMonth = new Date(year, month + 1, 0).getDate()
            const todayKey = new Date().toLocaleDateString("en-CA")
            const isCurrentMonth = year === new Date().getFullYear() && month === new Date().getMonth()
            const monthName = calendarMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })
            const DAY_HEADERS = ["S", "M", "T", "W", "T", "F", "S"]

            const cells = []
            for (let i = 0; i < firstDay; i++) cells.push(null)
            for (let d = 1; d <= daysInMonth; d++) cells.push(d)

            const selectedDaySaves = selectedCalendarDay ? (calendarSaves[selectedCalendarDay] || []) : []
            const hasAnySaves = Object.keys(calendarSaves).length > 0

            let feedSource = calendarSaves
            if (showFilteredFeed && (selectedSource || selectedFolder)) {
              feedSource = {}
              for (const [day, daySaves] of Object.entries(calendarSaves)) {
                const kept = daySaves.filter(s =>
                  (!selectedSource || getSourceLabel(s.url) === selectedSource) &&
                  (!selectedFolder || getSaveFolders(s.id).some(f => f.name === selectedFolder))
                )
                if (kept.length) feedSource[day] = kept
              }
            }
            const allDayKeys = Object.keys(feedSource).sort((a, b) => b.localeCompare(a))
            const visibleDayKeys = allDayKeys.slice(0, libraryFeedCount)

            return (
              <>
                {showCalendar && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                    <button
                      style={styles.calNavBtn}
                      onClick={() => { setCalendarMonth(new Date(year, month - 1, 1)); setSelectedCalendarDay(null) }}
                    >←</button>
                    <span style={{ fontWeight: 600, fontSize: 15, color: "#f6f3ea" }}>{monthName}</span>
                    <button
                      style={{ ...styles.calNavBtn, opacity: isCurrentMonth ? 0.25 : 1, pointerEvents: isCurrentMonth ? "none" : "auto" }}
                      onClick={() => { setCalendarMonth(new Date(year, month + 1, 1)); setSelectedCalendarDay(null) }}
                    >→</button>
                  </div>
                )}

                {showFilteredFeed && filterDropdownsJSX}

                {calendarLoading && <span className="shimmer" style={styles.searchShimmerBar} />}

                {!calendarLoading && (
                  <>
                    {showCalendar && (
                      <>
                        {/* Day-of-week headers */}
                        <div style={styles.calGrid}>
                          {DAY_HEADERS.map((h, i) => (
                            <div key={i} style={styles.calDayHeader}>{h}</div>
                          ))}

                          {/* Day cells */}
                          {cells.map((day, i) => {
                            if (!day) return <div key={`e-${i}`} />
                            const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
                            const daySaves = calendarSaves[dateKey] || []
                            const isToday = dateKey === todayKey
                            const isSelected = dateKey === selectedCalendarDay
                            const hasSaves = daySaves.length > 0

                            return (
                              <div
                                key={day}
                                onClick={() => hasSaves && setSelectedCalendarDay(isSelected ? null : dateKey)}
                                style={{
                                  ...styles.calCell,
                                  ...(isToday ? styles.calCellToday : {}),
                                  ...(isSelected ? styles.calCellSelected : {}),
                                  ...(hasSaves ? { cursor: "pointer" } : {}),
                                }}
                              >
                                <span style={{ ...styles.calDayNum, ...(isToday ? { color: "#f6f3ea", fontWeight: 700 } : {}) }}>{day}</span>
                                {hasSaves && (
                                  <div style={styles.calDots}>
                                    {daySaves.slice(0, 3).map((s, idx) => (
                                      <span key={idx} style={{ ...styles.calDot, background: TAG_COLORS[s.tag] || "#6b7280" }} />
                                    ))}
                                    {daySaves.length > 3 && <span style={styles.calDotMore}>+{daySaves.length - 3}</span>}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>

                        {/* Expanded day panel */}
                        {selectedCalendarDay && (
                          <div style={styles.calDayPanel}>
                            <div style={styles.calDayPanelHeader}>
                              <span style={styles.calDayPanelTitle}>
                                {new Date(selectedCalendarDay + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                              </span>
                              <span style={{ fontSize: 12, color: "#7d786f" }}>{selectedDaySaves.length} {selectedDaySaves.length === 1 ? "save" : "saves"}</span>
                            </div>
                            {selectedDaySaves.map(save => renderSavedArticleCard(save))}
                          </div>
                        )}
                      </>
                    )}

                    {/* Empty state */}
                    {!hasAnySaves && (
                      <div style={styles.emptyState}>
                        <p style={styles.emptyStateHint}>Nothing saved yet.</p>
                        <button style={styles.emptyStateCta} onClick={() => setView("save")}>Save your first link →</button>
                      </div>
                    )}

                    {/* Chronological infinite-scroll feed (default/filtered view; hidden while a calendar day is selected) */}
                    {hasAnySaves && !(showCalendar && selectedCalendarDay) && (
                      allDayKeys.length > 0 ? (
                        <div style={styles.libraryFeed}>
                          <span style={styles.libraryFeedLabel}>All saves</span>
                          {visibleDayKeys.map(dateKey => {
                            const daySaves = feedSource[dateKey] || []
                            return (
                              <div key={dateKey} style={styles.libraryFeedDay}>
                                <span style={styles.calDayPanelTitle}>
                                  {new Date(dateKey + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                                </span>
                                {daySaves.map(save => renderSavedArticleCard(save))}
                              </div>
                            )
                          })}
                          {visibleDayKeys.length < allDayKeys.length && (
                            <div ref={libraryFeedSentinelRef} style={{ height: 1 }} />
                          )}
                        </div>
                      ) : (
                        <p style={styles.zeroResultsSub}>Nothing matches this filter yet.</p>
                      )
                    )}
                  </>
                )}
              </>
            )
          })()}

          {/* Filter dropdowns for query-active ranked results */}
          {hasSearched && !loading && filterDropdownsJSX}

          {/* Result cards + show more */}
          {results.length > 0 && !loading && (() => {
            const filtered = results.filter(r =>
              (!selectedSource || getSourceLabel(r.url) === selectedSource) &&
              (!selectedFolder || getSaveFolders(r.id).some(f => f.name === selectedFolder))
            )
            const visible = filtered.slice(0, displayCount)
            return (
              <>
                <div style={styles.results}>
                  {visible.map(r => (
                    <a key={r.id} href={confirmDeleteId === r.id ? undefined : r.url} target="_blank" rel="noreferrer" style={styles.savedArticleCard}>
                      {confirmDeleteId === r.id ? (
                        <div style={styles.deleteConfirm}>
                          <span style={styles.deleteConfirmText}>Remove from ReCall?</span>
                          <button style={styles.deleteConfirmYes} onClick={e => { e.preventDefault(); deleteSave(r.id) }}>
                            {deletingId === r.id ? "Removing…" : "Delete"}
                          </button>
                          <button style={styles.deleteConfirmNo} onClick={e => { e.preventDefault(); setConfirmDeleteId(null) }}>Cancel</button>
                        </div>
                      ) : (
                        <>
                          <div style={styles.savedArticleTop}>
                            <div style={styles.savedArticleMeta}>
                              {renderSourceTile(r)}
                              <span>{getSiteName(r.url)}</span>
                              {r.created_at && <span>{formatDate(r.created_at)}</span>}
                            </div>
                            <button
                              onClick={e => { e.preventDefault(); e.stopPropagation(); setConfirmDeleteId(r.id) }}
                              style={styles.deleteButton}
                              aria-label="Delete"
                            ><TrashIcon /></button>
                          </div>
                          <div style={styles.savedArticleBody}>
                            <span style={styles.savedArticleTitle}>{r.title || getSourceLabel(r.url)}</span>
                            {r.excerpt && <span style={styles.savedArticleCaption}>{r.excerpt}</span>}
                          </div>
                          <div style={styles.savedArticleTagRow}>
                            {getSaveFolders(r.id).map(f => (
                              removeFolderConfirm?.saveId === r.id && removeFolderConfirm?.folderId === f.id ? (
                                <span key={f.id} style={styles.folderRemoveConfirm}>
                                  Remove from "{f.name}"?
                                  <button onClick={e => { e.preventDefault(); handleRemoveFromFolder(r.id, f.id) }} style={styles.folderRemoveYes}>Yes</button>
                                  <button onClick={e => { e.preventDefault(); setRemoveFolderConfirm(null) }} style={styles.folderRemoveNo}>Cancel</button>
                                </span>
                              ) : (
                                <button
                                  key={f.id}
                                  onClick={e => { e.preventDefault(); setRemoveFolderConfirm({ saveId: r.id, folderId: f.id, folderName: f.name }) }}
                                  style={styles.folderDisplayPill}
                                ><FolderIcon />{f.name}</button>
                              )
                            ))}
                            <button
                              onClick={e => { e.preventDefault(); setFolderPickerSaveId(r.id) }}
                              style={styles.addFolderButton}
                            >+ Folder</button>
                          </div>
                        </>
                      )}
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
          {totalSaveCount !== null && totalSaveCount < 30 && (
            <div style={totalSaveCount <= 5 ? styles.progressPill : totalSaveCount <= 15 ? styles.progressPillPurple : styles.progressPillGreen}>
              {totalSaveCount <= 5 ? (
                <>
                  <span style={{ fontSize: "12px", color: "#fbbf24" }}>
                    {isAndroid
                      ? `⚡ ${totalSaveCount} of 5 saves · ReCall is climbing your Share Sheet`
                      : `⚡ ${totalSaveCount} of 5 saves · Building your searchable library`}
                  </span>
                  <div style={styles.progressDotsRow}>
                    {[1,2,3,4,5].map(i => (
                      <span key={i} style={i <= totalSaveCount ? styles.dotFilledSmall : styles.dotEmptySmall} />
                    ))}
                  </div>
                </>
              ) : totalSaveCount <= 15 ? (
                <>
                  <span style={{ fontSize: "12px", color: "#a78bfa" }}>✦ {totalSaveCount} of 15 saves · Ask is learning your interests</span>
                  <div style={styles.progressBar}>
                    <div style={{ ...styles.progressFill, width: `${(totalSaveCount / 15) * 100}%` }} />
                  </div>
                </>
              ) : (
                <>
                  <span style={{ fontSize: "12px", color: "#34d399" }}>◈ {totalSaveCount} of 30 saves · Your Library is taking shape</span>
                  <div style={styles.progressBar}>
                    <div style={{ ...styles.progressFill, width: `${(totalSaveCount / 30) * 100}%`, background: "#34d399" }} />
                  </div>
                </>
              )}
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
            <div style={{ background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 18, padding: "16px 18px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span>{saveReceipt.content_type === "video" ? "🎥" : "📷"}</span>
                <span style={{ color: "#aaa", fontSize: 13, fontWeight: 600 }}>Saved to library</span>
              </div>
              <div style={styles.receiptTitleRow}>
                {saveReceipt.pending ? (
                  <span className="shimmer" style={styles.shimmerTitle} />
                ) : editingTitle ? (
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
              {saveReceipt.pending && (
                <p style={{ color: "#666", fontSize: 12, margin: "8px 0 0" }}>
                  {pushEnabled
                    ? "Finishing the title now. Feel free to close the app, we'll notify you when it's ready."
                    : "Finishing the title now — go on with your day, it'll update here on its own."}
                </p>
              )}
            </div>
          )}

          {saveReceipt?.thin_content && (
            <div style={{ background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 18, padding: "16px 18px" }}>
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
              ) : saveReceipt.pending ? (
                <>
                  <span className="shimmer" style={styles.shimmerPill} />
                  <div style={styles.receiptTitleRow}>
                    <span className="shimmer" style={styles.shimmerTitle} />
                  </div>
                  <div style={styles.receiptFooter}>
                    <span style={styles.receiptUrl}>{saveReceipt.url}</span>
                    <span style={styles.receiptSaved}>Saved ✓</span>
                  </div>
                  <p style={{ color: "#666", fontSize: 12, margin: "8px 0 0" }}>
                    {pushEnabled
                      ? "Finishing the title now. Feel free to close the app, we'll notify you when it's ready."
                      : "Finishing the title now — go on with your day, it'll update here on its own."}
                  </p>
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
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                    {getSaveFolders(saveReceipt.id).map(f => (
                      removeFolderConfirm?.saveId === saveReceipt.id && removeFolderConfirm?.folderId === f.id ? (
                        <span key={f.id} style={styles.folderRemoveConfirm}>
                          Remove from "{f.name}"?
                          <button onClick={() => handleRemoveFromFolder(saveReceipt.id, f.id)} style={styles.folderRemoveYes}>Yes</button>
                          <button onClick={() => setRemoveFolderConfirm(null)} style={styles.folderRemoveNo}>Cancel</button>
                        </span>
                      ) : (
                        <button key={f.id} onClick={() => setRemoveFolderConfirm({ saveId: saveReceipt.id, folderId: f.id, folderName: f.name })} style={styles.folderDisplayPill}><FolderIcon />{f.name}</button>
                      )
                    ))}
                    <button
                      onClick={() => setFolderPickerSaveId(saveReceipt.id)}
                      style={styles.addFolderButton}
                    >+ Folder</button>
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
                  <div style={styles.receiptFooter}>
                    <span style={styles.receiptUrl}>{saveReceipt.url}</span>
                    <span style={styles.receiptSaved}>Saved ✓</span>
                  </div>
                  {relatedSaves.length > 0 && (
                    <div style={styles.relatedSavesSection}>
                      <span style={styles.relatedSavesLabel}>📎 Similar saves</span>
                      {relatedSaves.slice(0, 2).map(r => (
                        <button
                          key={r.id}
                          onClick={() => { setView("search"); setQuery(r.title); handleSearch(r.title) }}
                          style={styles.relatedSaveChip}
                        >{r.title}</button>
                      ))}
                    </div>
                  )}
                  {saveReceipt.milestoneCount && (
                    <div style={styles.milestoneRow}>
                      {saveReceipt.milestoneCount === 5 ? (
                        <>
                          <div style={styles.progressDotsRow}>
                            {[1,2,3,4,5].map(i => <span key={i} style={styles.dotFilled} />)}
                          </div>
                          {isAndroid ? (
                            <>
                              <p style={styles.milestoneHeadline}>ReCall is at the top of your Share Sheet.</p>
                              <p style={styles.milestoneSub}>You'll never have to hunt for it again.</p>
                            </>
                          ) : (
                            <>
                              <p style={styles.milestoneHeadline}>Your library is taking shape.</p>
                              <p style={styles.milestoneSub}>Search is personalizing to your saves.</p>
                            </>
                          )}
                        </>
                      ) : (
                        <p style={styles.milestoneText}>
                          {saveReceipt.milestoneCount === 1 && (isAndroid ? "1/5 — 4 more to unlock the top of your Share Sheet" : "1/5 — 4 more to personalize your search")}
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

          {/* Don't gate this on !optimistic — url + fromShareSheet are already known the
              instant the share sheet hands off, so this shouldn't wait on the /save round trip. */}
          {saveReceipt?.fromShareSheet && !saveReceipt.thin_content && !saveReceipt.duplicate &&
            (getAppScheme(saveReceipt.url) || window.history.length > 1) && (
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

          {visibleTodaySaves.length > 0 && (
            <div style={styles.todaySection}>
              <p style={styles.todayHeader}>Today</p>
              <div style={styles.todayList}>
                {visibleTodaySaves.map(s => renderSavedArticleCard(s))}
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
                5 saves and ReCall moves to the top of your Share Sheet!
              </p>
              {isAndroid && (
                <div style={styles.shareHowTo}>
                  <p style={styles.shareHowToLabel}>How to use Share Sheet</p>
                  <div style={styles.shareHowToStep}>
                    <span style={styles.shareHowToNum}>①</span>
                    <span style={styles.shareHowToText}>Open any link in Chrome, Twitter, Reddit, or any app</span>
                  </div>
                  <div style={styles.shareHowToStep}>
                    <span style={styles.shareHowToNum}>②</span>
                    <span style={styles.shareHowToText}>Tap <strong style={{ color: "#f6f3ea" }}>Share</strong> → choose <strong style={{ color: "#f6f3ea" }}>ReCall</strong> — it saves instantly</span>
                  </div>
                </div>
              )}
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

      {view === "recall" && (
        <div style={styles.section}>
          <div style={styles.recallPanel}>
            <p style={styles.settingsSectionHeading}>LLM connector</p>
            <h2 style={styles.recallTitle}>Connect ReCall to any LLM app</h2>
            <p style={styles.recallBody}>
              Let your AI assistant search, save, rename, tag, and delete from your ReCall library with your approval.
            </p>
            {recallConnectorContent}
          </div>
        </div>
      )}

      {showMcpPrompt && (
        <div style={styles.overlay}>
          <div style={styles.mcpPromptCard}>
            <p style={styles.settingsSectionHeading}>Memory unlocked</p>
            <h2 style={styles.mcpPromptTitle}>
              You are 5 saves in.<br />
              Connect to Claude/GPT to use this memory?
            </h2>
            <p style={styles.mcpPromptBody}>
              ReCall can become searchable context inside your LLM app through MCP.
            </p>
            <div style={styles.mcpPromptActions}>
              <button onClick={openMcpTutorialVideo} style={styles.mcpPromptYes}>Yes, show me</button>
              <button onClick={deferMcpTutorial} style={styles.mcpPromptNo}>Not now</button>
            </div>
          </div>
        </div>
      )}

      {showMcpVideo && (
        <div style={styles.overlay}>
          <div style={styles.mcpVideoCard}>
            <div style={styles.mcpVideoHeader}>
              <div style={styles.mcpVideoHeaderCopy}>
                <p style={{ ...styles.settingsSectionHeading, textAlign: "center" }}>ReCall MCP</p>
                <h2 style={styles.mcpVideoTitle}>Use your saved memory inside an LLM</h2>
              </div>
            </div>
            <video
              src={MCP_TUTORIAL_VIDEO_URL}
              style={styles.mcpVideo}
              controls
              autoPlay
              playsInline
            />
            <div style={styles.mcpVideoActions}>
              <button onClick={finishMcpTutorialVideo} style={styles.mcpPromptYes}>Connect ReCall</button>
              <button onClick={deferMcpTutorial} style={styles.mcpPromptNo}>Skip for now</button>
            </div>
          </div>
        </div>
      )}

      {/* Install onboarding overlay */}
      {onboardingStep === 'install' && (
        <div style={styles.overlay}>
          <div style={styles.overlayCard}>
            {isIOS ? (
              <>
                <div style={{ fontSize: "32px", marginBottom: "4px" }}>📋</div>
                <p style={styles.overlayTitle}>Saving on iPhone</p>
                <p style={styles.overlayBody}>Your quickest option is already built in.</p>
                <div style={styles.overlaySteps}>
                  <p style={styles.overlayStep}>① Copy any link in Safari or any app</p>
                  <p style={styles.overlayStep}>② Open ReCall — your link <strong>auto-fills</strong></p>
                  <p style={styles.overlayStep}>③ Tap Save ✓</p>
                </div>
                <div style={styles.overlayDivider} />
                <p style={{ ...styles.overlayNote, color: "#666", marginBottom: "6px" }}>Add to Home Screen for quick access:</p>
                <div style={{ ...styles.overlaySteps, background: "transparent", padding: "0 4px" }}>
                  <p style={styles.overlayStep}>① Tap the <strong>Share</strong> icon in Safari</p>
                  <p style={styles.overlayStep}>② Tap <strong>"Add to Home Screen"</strong> → <strong>"Add"</strong></p>
                </div>
                <p style={styles.overlayNote}>Want 1-tap save from any app? Add the Share Sheet Shortcut anytime in ⚙ Settings — just one tap.</p>
                <button style={styles.button} onClick={() => advanceOnboarding('install')}>Got it</button>
                <button style={styles.overlaySkip} onClick={() => advanceOnboarding('install')}>Skip for now</button>
              </>
            ) : isDesktop ? (
              <>
                <div style={{ fontSize: "32px", marginBottom: "4px" }}>✓</div>
                <p style={styles.overlayTitle}>You're all set</p>
                <p style={styles.overlayBody}>ReCall works right in your browser — no install needed.</p>
                <div style={styles.overlaySteps}>
                  <p style={styles.overlayStep}>📋 Paste any URL into the Save tab</p>
                  <p style={styles.overlayStep}>🔍 Search your saves in plain English</p>
                </div>
                <p style={styles.overlayNote}>On Android, install the app to save from any app via Share Sheet.</p>
                <button style={styles.button} onClick={() => advanceOnboarding('install')}>Got it</button>
              </>
            ) : (
              <>
                <div style={{ fontSize: "32px", marginBottom: "4px" }}>📱</div>
                <p style={styles.overlayTitle}>Get the full experience</p>
                <p style={styles.overlayBody}>Install once, then save from any app with one tap.</p>
                <div style={styles.overlaySteps}>
                  <p style={styles.overlayStep}>① Tap <strong>⋮</strong> in Chrome → <strong>"Add to Home Screen"</strong></p>
                  <p style={styles.overlayStep}>② Open any link → tap <strong>Share</strong> → choose <strong>ReCall</strong></p>
                  {SHARE_SHEET_VIDEO_URL && (
                    <a href={SHARE_SHEET_VIDEO_URL} target="_blank" rel="noreferrer" style={styles.overlayVideoLink}>Watch how →</a>
                  )}
                </div>
                <button style={styles.button} onClick={() => advanceOnboarding('install')}>Done, I've installed it</button>
                <button style={styles.overlaySkip} onClick={() => advanceOnboarding('install')}>Skip for now</button>
              </>
            )}
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

      {showInstallUI && installBannerDismissed && (
        <div style={styles.installFooterWrap}>
          <button onClick={handleInstallClick} style={styles.installFooterButton}>
            {deferredInstallPrompt ? "Install ReCall" : installStepsOpen ? "Hide install steps" : "Install ReCall"}
          </button>
          {installStepsOpen && installInstructions}
        </div>
      )}

      <div style={styles.legalFooter}>
        <button onClick={() => { setLegalSection('privacy'); setView('legal') }} style={styles.legalFooterLink}>Privacy Policy</button>
        <span style={{ color: "#3a3935" }}>·</span>
        <button onClick={() => { setLegalSection('terms'); setView('legal') }} style={styles.legalFooterLink}>Terms</button>
      </div>
    </div>
  )
}

const styles = {
  container: { minHeight: "100vh", maxWidth: "100vw", overflowX: "hidden", background: "#171719", color: "#f6f3ea", fontFamily: "Inter, system-ui, sans-serif", padding: "0 16px", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center" },
  hero: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: "16px" },
  heroLanding: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: "18px", padding: "48px 0 24px" },
  heroCopy: { display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", width: "100%" },
  heroEyebrow: { fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.12em", color: "#7f8ea3" },
  logo: { fontSize: "48px", fontWeight: "400", margin: 0, color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: "-0.02em" },
  logoSmall: { fontSize: "24px", fontWeight: "400", margin: 0, color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: "-0.02em" },
  tagline: { color: "#aca79b", fontSize: "16px", margin: 0 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 0", width: "100%", maxWidth: "760px", boxSizing: "border-box" },
  headerIconButton: { width: "42px", height: "42px", padding: 0 },
  headerRoundButton: { display: "inline-flex", alignItems: "center", justifyContent: "center", background: "#202024", border: "1px solid rgba(255,255,255,0.1)", color: "#aca79b", borderRadius: "999px", cursor: "pointer", lineHeight: 1 },
  tourHighlight: { position: "relative", zIndex: 70, boxShadow: "0 0 0 2px rgba(217,255,95,0.95), 0 0 0 9999px rgba(0,0,0,0.02), 0 18px 52px -18px rgba(217,255,95,0.85)", filter: "none" },
  tabs: { display: "flex", gap: "8px", marginBottom: "24px", justifyContent: "center", width: "100%", maxWidth: "760px", flexWrap: "wrap" },
  tab: { background: "#202024", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", padding: "8px 20px", borderRadius: "999px", cursor: "pointer", fontSize: "14px" },
  tabActive: { background: "#d9ff5f", border: "1px solid #d9ff5f", color: "#1f2b08", padding: "8px 20px", borderRadius: "999px", cursor: "pointer", fontSize: "14px", fontWeight: "700" },
  section: { display: "flex", flexDirection: "column", gap: "12px", width: "100%", maxWidth: "760px", margin: "0 auto", boxSizing: "border-box" },
  input: { width: "100%", padding: "14px", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "14px", color: "#f6f3ea", fontSize: "16px", boxSizing: "border-box", outline: "none" },
  button: { width: "100%", padding: "14px", background: "#d9ff5f", color: "#1f2b08", border: "none", borderRadius: "14px", fontSize: "16px", fontWeight: "700", cursor: "pointer" },
  signOut: { background: "#202024", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", padding: "6px 14px", borderRadius: "999px", cursor: "pointer", fontSize: "13px" },
  results: { display: "flex", flexDirection: "column", gap: "12px", marginTop: "8px" },
  card: { display: "block", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "24px", padding: "22px", textDecoration: "none", color: "#f6f3ea", overflow: "hidden", boxShadow: "0 30px 90px -56px rgba(0,0,0,0.95)" },
  cardTag: { fontSize: "11px", color: "#d9ff5f", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: "6px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  success: { color: "#4ade80", fontSize: "14px", margin: 0 },
  error: { color: "#ef4444", fontSize: "14px", margin: 0 },
  neutral: { color: "#aca79b", fontSize: "14px", margin: 0 },
  receiptCard: { background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "24px", padding: "22px", display: "flex", flexDirection: "column", gap: "12px", transition: "box-shadow 0.8s ease", color: "#f6f3ea", boxShadow: "0 30px 90px -56px rgba(0,0,0,0.95)" },
  folderDisplayPill: { display: "inline-flex", alignItems: "center", gap: "5px", background: "#25252a", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", borderRadius: "999px", padding: "3px 10px", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
  addFolderButton: { display: "inline-flex", alignItems: "center", background: "none", border: "1px dashed rgba(255,255,255,0.18)", color: "#666", borderRadius: "999px", padding: "3px 10px", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
  folderRemoveConfirm: { display: "inline-flex", alignItems: "center", gap: "6px", background: "#1e1a14", border: "1px solid rgba(251,191,36,0.3)", color: "#aca79b", borderRadius: "999px", padding: "3px 10px", fontSize: "12px", whiteSpace: "nowrap", flexShrink: 0 },
  folderRemoveYes: { background: "none", border: "none", color: "#ef4444", fontSize: "12px", cursor: "pointer", padding: "0", fontWeight: 500 },
  folderRemoveNo: { background: "none", border: "none", color: "#666", fontSize: "12px", cursor: "pointer", padding: "0" },
  receiptTitleRow: { display: "flex", alignItems: "center", gap: "8px" },
  receiptTitle: { fontSize: "22px", fontWeight: "400", flex: 1, lineHeight: 1.25, color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: "-0.02em" },
  receiptTitleInput: { flex: 1, background: "#171719", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "10px", color: "#f6f3ea", fontSize: "15px", fontWeight: "600", padding: "6px 10px", outline: "none" },
  editButton: { background: "none", border: "none", color: "#7d786f", cursor: "pointer", fontSize: "15px", padding: "2px 4px", lineHeight: 1, flexShrink: 0 },
  confirmButton: { background: "#d9ff5f", border: "none", color: "#1f2b08", cursor: "pointer", fontSize: "14px", fontWeight: "700", padding: "4px 10px", borderRadius: "8px", flexShrink: 0 },
  receiptFooter: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" },
  receiptUrl: { fontSize: "12px", color: "#7d786f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  receiptSaved: { fontSize: "13px", color: "#4ade80", fontWeight: "600", flexShrink: 0 },
  duplicateHeader: { fontSize: "13px", color: "#fbbf24", fontWeight: "600" },
  shimmerPill: { height: "14px", width: "48px", borderRadius: "4px", background: "#2a2a2a", display: "block" },
  shimmerTitle: { height: "18px", width: "70%", borderRadius: "4px", background: "#2a2a2a", display: "block" },
  returnButton: { display: "block", background: "none", border: "1px solid rgba(255,255,255,0.25)", color: "#fff", borderRadius: "12px", padding: "13px 14px", fontSize: "14px", fontWeight: "500", cursor: "pointer", width: "100%", textAlign: "center", boxSizing: "border-box", textDecoration: "none" },
  todaySection: { marginTop: "4px", display: "flex", flexDirection: "column", gap: "12px" },
  todayHeader: { fontSize: "11px", color: "#7d786f", textTransform: "uppercase", letterSpacing: "0.12em", margin: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  todayList: { display: "flex", flexDirection: "column", gap: "14px", maxHeight: "none", overflowY: "visible" },
  todayCard: { display: "flex", alignItems: "center", gap: "10px", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "18px", padding: "13px 16px", textDecoration: "none", color: "#f6f3ea", overflow: "hidden" },
  todayTag: { fontSize: "10px", color: "#d9ff5f", textTransform: "uppercase", letterSpacing: "0.08em", flexShrink: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  todayTitle: { fontSize: "14px", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif" },
  todayTagShimmer: { height: "10px", width: "32px", borderRadius: "3px", background: "#2a2a2a", display: "block", flexShrink: 0 },
  todayTitleShimmer: { height: "13px", width: "60%", borderRadius: "3px", background: "#2a2a2a", display: "block", flex: 1 },
  todaySource: { fontSize: "11px", color: "#7d786f", flexShrink: 0 },
  deleteButton: { background: "none", border: "none", color: "#7d786f", cursor: "pointer", padding: "0 0 0 8px", flexShrink: 0, display: "flex", alignItems: "center" },
  deleteConfirm: { display: "flex", alignItems: "center", gap: "8px", width: "100%" },
  deleteConfirmText: { fontSize: "12px", color: "#aca79b", flex: 1 },
  deleteConfirmYes: { background: "#ef4444", border: "none", color: "#fff", borderRadius: "6px", padding: "4px 10px", fontSize: "12px", fontWeight: "600", cursor: "pointer", flexShrink: 0 },
  deleteConfirmNo: { background: "#25252a", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", borderRadius: "6px", padding: "4px 10px", fontSize: "12px", cursor: "pointer", flexShrink: 0 },
  savedArticleCard: { display: "flex", flexDirection: "column", gap: "20px", background: "#202024", border: "1px solid rgba(255,255,255,0.10)", borderRadius: "24px", padding: "22px", textDecoration: "none", color: "#f6f3ea", overflow: "hidden", boxShadow: "0 30px 90px -56px rgba(0,0,0,0.95)", boxSizing: "border-box" },
  savedArticleTop: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "14px" },
  savedArticleMeta: { display: "inline-flex", alignItems: "center", gap: "10px", minWidth: 0, color: "#7d786f", fontSize: "13px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", letterSpacing: "0.04em" },
  savedArticleSourceTile: { width: "20px", height: "20px", borderRadius: "6px", background: "linear-gradient(135deg, #a06eff 0%, rgba(217,255,95,0.72) 100%)", flexShrink: 0, boxShadow: "0 0 20px -10px rgba(217,255,95,0.9)", display: "flex", alignItems: "center", justifyContent: "center" },
  savedArticleTileGlyph: { fontSize: "9px", color: "rgba(0,0,0,0.55)", lineHeight: 1 },
  savedArticleThumbWrap: { position: "relative", width: "20px", height: "20px", borderRadius: "6px", overflow: "hidden", flexShrink: 0 },
  savedArticleThumbImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  savedArticlePlayBadge: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "8px", color: "#fff", textShadow: "0 0 3px rgba(0,0,0,0.9)" },
  savedArticleControls: { display: "inline-flex", alignItems: "center", gap: "8px", flexShrink: 0 },
  savedArticleBody: { display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", textAlign: "center" },
  savedArticleTitle: { color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "24px", lineHeight: 1.15, letterSpacing: "-0.02em", fontWeight: 400, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" },
  savedArticleCaption: { color: "#aca79b", fontSize: "15px", lineHeight: 1.55, maxWidth: "680px", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" },
  savedArticleTagRow: { display: "flex", justifyContent: "flex-start", flexWrap: "wrap", gap: "8px" },
  savedArticleTag: { display: "inline-flex", alignItems: "center", gap: "6px", borderRadius: "999px", background: "#25252a", border: "1px solid rgba(255,255,255,0.10)", color: "#aca79b", padding: "4px 10px", fontSize: "12px" },
  savedArticleStatus: { color: "#aca79b", fontSize: "13px", padding: "4px 0" },
  savedArticleTitleInput: { width: "100%", background: "#171719", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "14px", color: "#f6f3ea", fontSize: "20px", fontFamily: "Georgia, 'Times New Roman', serif", padding: "12px 14px", outline: "none", boxSizing: "border-box" },
  savedArticleEditActions: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px" },
  savedArticleGhostButton: { background: "none", border: "none", color: "#7d786f", cursor: "pointer", fontSize: "16px", padding: "0 2px" },
  savedArticleTitleShimmer: { height: "32px", width: "70%", borderRadius: "6px", background: "#2a2a2f", display: "block", alignSelf: "center" },
  savedArticleCaptionShimmer: { height: "18px", width: "82%", borderRadius: "5px", background: "#2a2a2f", display: "block", alignSelf: "center" },
  savedArticleTagShimmer: { height: "30px", width: "110px", borderRadius: "999px", background: "#2a2a2f", display: "block" },

  // Unified search bar
  searchBarWrapper: { position: "relative", display: "flex", alignItems: "center", width: "100%", boxSizing: "border-box" },
  searchBarInput: { width: "100%", padding: "14px 52px 14px 16px", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "14px", color: "#f6f3ea", fontSize: "16px", boxSizing: "border-box", outline: "none" },
  searchBarButton: { position: "absolute", right: "10px", background: "none", border: "none", cursor: "pointer", fontSize: "18px", padding: "4px", lineHeight: 1, color: "#aca79b", display: "flex", alignItems: "center" },

  // Recent searches
  recentSearchesBox: { background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "14px", padding: "12px 16px", display: "flex", flexDirection: "column", gap: "8px" },
  recentSearchesLabel: { fontSize: "11px", color: "#7d786f", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  recentChips: { display: "flex", flexDirection: "column", gap: "4px" },
  recentChipRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
  recentChip: { background: "none", border: "none", color: "#f6f3ea", cursor: "pointer", fontSize: "14px", padding: "4px 0", textAlign: "left", flex: 1 },
  recentChipDismiss: { background: "none", border: "none", color: "#7d786f", cursor: "pointer", fontSize: "16px", padding: "0 4px", lineHeight: 1, flexShrink: 0 },

  // Shimmer loading bar
  searchShimmerBar: { display: "block", width: "100%", height: "4px", borderRadius: "4px", background: "linear-gradient(90deg, #2a2a2a 0%, #444 50%, #2a2a2a 100%)" },

  // Empty state
  emptyState: { display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", marginTop: "16px" },
  emptyStateHint: { fontSize: "13px", color: "#7d786f", margin: 0 },
  exampleChips: { display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center" },
  exampleChip: { background: "#202024", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", padding: "8px 16px", borderRadius: "999px", cursor: "pointer", fontSize: "13px" },

  // Zero results
  zeroResults: { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", marginTop: "24px" },
  zeroResultsMain: { fontSize: "15px", color: "#f6f3ea", fontWeight: "600", margin: 0, textAlign: "center" },
  zeroResultsSub: { fontSize: "13px", color: "#7d786f", margin: 0, textAlign: "center" },

  cardMeta: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px", gap: "8px", width: "100%" },
  cardDate: { fontSize: "11px", color: "#7d786f", marginLeft: "auto" },
  cardTitle: { fontSize: "24px", fontWeight: "400", marginBottom: "8px", color: "#f6f3ea", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: "-0.02em", lineHeight: 1.15 },
  cardSource: { fontSize: "12px", color: "#7d786f" },

  // Show more
  showMoreButton: { background: "#202024", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", padding: "10px 20px", borderRadius: "999px", cursor: "pointer", fontSize: "14px", alignSelf: "center" },

  // Empty state CTA (new-user nudge)
  emptyStateCta: { background: "none", border: "none", color: "#d9ff5f", fontSize: "14px", cursor: "pointer", padding: 0, textDecoration: "underline", textDecorationColor: "rgba(217,255,95,0.42)" },

  // Zero results CTA
  zeroResultsCta: { background: "#202024", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", padding: "10px 20px", borderRadius: "999px", cursor: "pointer", fontSize: "14px", marginTop: "8px" },

  // Filter dropdowns
  filterRow: { display: "flex", gap: "8px", flexWrap: "wrap" },
  filterDropdownWrapper: { position: "relative", flexShrink: 0 },
  filterDropdown: { appearance: "none", WebkitAppearance: "none", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", padding: "7px 32px 7px 12px", borderRadius: "999px", fontSize: "13px", cursor: "pointer", backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%237d786f'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center" },

  // Card excerpt
  cardExcerpt: { fontSize: "14px", color: "#aca79b", lineHeight: 1.6, marginBottom: "10px", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" },

  // Hero redesign
  heroTagline: { fontSize: "28px", fontWeight: "400", textAlign: "center", lineHeight: 1.25, margin: 0, letterSpacing: "-0.02em", color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif" },
  heroBody: { fontSize: "15px", color: "#aca79b", textAlign: "center", margin: 0, maxWidth: "280px" },
  heroBodyWide: { fontSize: "15px", color: "#9098a7", textAlign: "center", margin: 0, maxWidth: "620px", lineHeight: 1.6 },
  heroMicrocopy: { fontSize: "12px", color: "#586273", textAlign: "center" },
  landingShell: { width: "100%", maxWidth: "760px", display: "flex", flexDirection: "column", gap: "14px", padding: "18px", borderRadius: "24px", background: "linear-gradient(180deg, rgba(20,29,43,0.95) 0%, rgba(14,16,21,0.98) 100%)", border: "1px solid rgba(148,163,184,0.18)", boxShadow: "0 24px 80px rgba(0,0,0,0.35)" },
  landingComposer: { display: "flex", flexDirection: "column", gap: "10px", padding: "4px 2px" },
  landingLabel: { fontSize: "12px", color: "#8d98aa", textTransform: "uppercase", letterSpacing: "0.08em", margin: 0 },
  landingInputRow: { display: "flex", gap: "10px", alignItems: "stretch", flexWrap: "wrap" },
  landingInput: { flex: "1 1 320px", minWidth: 0, padding: "15px 16px", background: "rgba(8,10,14,0.9)", border: "1px solid #273244", borderRadius: "14px", color: "#fff", fontSize: "15px", boxSizing: "border-box" },
  landingPreviewButton: { background: "#d9f99d", border: "none", color: "#18210b", borderRadius: "14px", padding: "0 18px", minHeight: "52px", fontSize: "14px", fontWeight: "700", cursor: "pointer" },
  landingHint: { fontSize: "13px", color: "#6d7788", margin: 0, lineHeight: 1.5 },
  landingProgressRail: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "8px" },
  landingProgressStep: { display: "flex", alignItems: "center", gap: "8px", padding: "12px 14px", borderRadius: "14px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" },
  landingProgressDot: { width: "22px", height: "22px", borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "11px", color: "#7c8798", background: "#1b2330", flexShrink: 0 },
  landingProgressDotActive: { width: "22px", height: "22px", borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "11px", color: "#17210c", background: "#d9f99d", flexShrink: 0, fontWeight: "700" },
  landingProgressText: { fontSize: "13px", color: "#c5cfdd", lineHeight: 1.4 },
  mockCards: { display: "flex", flexDirection: "column", gap: "8px", width: "100%", maxWidth: "340px", opacity: 0.55, pointerEvents: "none" },
  mockCard: { background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "4px", textAlign: "left" },
  mockCardTag: { fontSize: "10px", color: "#7d786f", textTransform: "uppercase", letterSpacing: "1px" },
  mockCardTitle: { fontSize: "14px", fontWeight: "600", color: "#f6f3ea", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  previewPanel: { display: "flex", flexDirection: "column", gap: "14px", padding: "18px", borderRadius: "20px", background: "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%)", border: "1px solid rgba(170,184,204,0.16)" },
  previewHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" },
  previewLabel: { fontSize: "11px", color: "#7f8ea3", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 6px" },
  previewTitle: { fontSize: "20px", fontWeight: "700", color: "#f8fafc", margin: 0, lineHeight: 1.2 },
  previewTag: { borderRadius: "999px", background: "#dbeafe", color: "#172554", padding: "6px 10px", fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 },
  previewSummary: { fontSize: "15px", color: "#d3d9e3", lineHeight: 1.65, margin: 0 },
  previewMetaRow: { display: "flex", gap: "10px", flexWrap: "wrap" },
  previewSource: { fontSize: "12px", color: "#7f8ea3" },
  previewTopics: { display: "flex", gap: "8px", flexWrap: "wrap" },
  previewTopic: { fontSize: "12px", color: "#d3d9e3", background: "#1b2330", border: "1px solid #2f3a4d", borderRadius: "999px", padding: "7px 10px" },

  // Lovable landing page port
  lovablePage: { minHeight: "100vh", width: "100%", background: "#171719", color: "#f6f3ea", fontFamily: "Inter, system-ui, sans-serif", overflowX: "hidden" },
  lovableNav: { position: "sticky", top: 0, zIndex: 40, minHeight: "64px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", padding: "10px clamp(18px, 4vw, 56px)", background: "rgba(23,23,25,0.72)", borderBottom: "1px solid rgba(255,255,255,0.08)", backdropFilter: "blur(18px)", flexWrap: "wrap" },
  lovableBrand: { display: "flex", alignItems: "center", gap: "10px", color: "#f6f3ea", textDecoration: "none", flexShrink: 0 },
  lovableBrandLogo: { width: "30px", height: "30px", borderRadius: "9px", display: "block", boxShadow: "0 0 0 1px rgba(255,255,255,0.08)" },
  lovableBrandText: { fontSize: "14px", letterSpacing: "0.2em", textTransform: "uppercase", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  lovableNavLinks: { display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap" },
  lovableNavLink: { color: "#aca79b", textDecoration: "none", fontSize: "14px", fontFamily: "system-ui, sans-serif" },
  lovableNavActions: { display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 },
  lovablePlainButton: { background: "transparent", border: "none", color: "#aca79b", cursor: "pointer", fontSize: "14px", fontFamily: "system-ui, sans-serif" },
  lovableDarkButton: { background: "#d9ff5f", border: "none", color: "#1f2b08", borderRadius: "999px", padding: "9px 16px", cursor: "pointer", fontSize: "14px", fontWeight: 700, fontFamily: "system-ui, sans-serif" },
  lovableHero: { position: "relative", overflow: "hidden", minHeight: "calc(100vh - 64px)" },
  lovableHeroBackdrop: { position: "absolute", inset: 0, pointerEvents: "none", background: "linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px), radial-gradient(circle at 50% -10%, rgba(217,255,95,0.12), transparent 34%), radial-gradient(circle at 94% 18%, rgba(160,110,255,0.15), transparent 28%), radial-gradient(circle at 6% 80%, rgba(255,198,92,0.1), transparent 30%)", backgroundSize: "56px 56px, 56px 56px, auto, auto, auto" },
  lovableHeroInner: { position: "relative", maxWidth: "1180px", margin: "0 auto", padding: "clamp(52px, 8vw, 96px) clamp(18px, 4vw, 56px) 110px", display: "flex", flexDirection: "column", alignItems: "center" },
  lovableHeroCopy: { maxWidth: "860px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" },
  lovablePill: { display: "inline-flex", alignItems: "center", gap: "8px", padding: "7px 12px", borderRadius: "999px", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", fontSize: "12px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: "24px" },
  lovablePillDot: { width: "6px", height: "6px", borderRadius: "50%", background: "#d9ff5f", flexShrink: 0, boxShadow: "0 0 18px rgba(217,255,95,0.8)" },
  lovableHeroTitle: { fontSize: "clamp(48px, 8vw, 92px)", lineHeight: 1.02, letterSpacing: "-0.02em", margin: 0, maxWidth: "940px", fontWeight: 400, color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif" },
  lovableHeroText: { margin: "22px auto 0", color: "#aca79b", fontSize: "18px", lineHeight: 1.65, maxWidth: "620px", fontFamily: "system-ui, sans-serif", textAlign: "center" },
  lovableComposerWrap: { marginTop: "40px", maxWidth: "700px", width: "100%" },
  lovableComposerPrompt: { margin: "0 0 12px", color: "#7d786f", fontSize: "12px", fontWeight: 700, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", textAlign: "center", textTransform: "uppercase", letterSpacing: "0.14em" },
  lovableComposer: { display: "flex", alignItems: "center", gap: "10px", padding: "8px", borderRadius: "22px", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 0 0 1px rgba(255,255,255,0.02), 0 28px 90px -30px rgba(0,0,0,0.9)" },
  lovableComposerIcon: { display: "inline-flex", color: "#7d786f", paddingLeft: "10px", flexShrink: 0 },
  lovableComposerInput: { flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", color: "#f6f3ea", fontSize: "15px", padding: "13px 4px", fontFamily: "system-ui, sans-serif" },
  lovableComposerButton: { border: "none", borderRadius: "14px", background: "#d9ff5f", color: "#1f2b08", padding: "12px 16px", fontSize: "14px", fontWeight: 700, fontFamily: "system-ui, sans-serif", cursor: "pointer", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: "8px" },
  lovableComposerNote: { margin: "12px 0 0", color: "#7d786f", fontSize: "12px", fontFamily: "system-ui, sans-serif", textAlign: "center" },
  lovableError: { margin: "10px 0 0", color: "#fbbf24", fontSize: "13px", fontFamily: "system-ui, sans-serif", textAlign: "center" },
  lovablePreviewStack: { position: "relative", maxWidth: "760px", margin: "62px auto 0", width: "100%" },
  lovableFloatBadge: { position: "absolute", top: "-22px", left: "-12px", transform: "rotate(-2deg)", borderRadius: "10px", background: "#d9ff5f", border: "1px solid rgba(217,255,95,0.42)", padding: "8px 12px", fontSize: "12px", color: "#1f2b08", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", textTransform: "uppercase", letterSpacing: "0.08em", boxShadow: "0 14px 36px -20px rgba(217,255,95,0.9)" },
  lovablePreviewCard: { borderRadius: "24px", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", padding: "28px", boxShadow: "0 30px 90px -48px rgba(0,0,0,0.95)" },
  lovableArticleList: { display: "flex", flexDirection: "column", gap: "14px" },
  lovablePreviewCardCompact: { borderRadius: "24px", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", padding: "22px", boxShadow: "0 22px 64px -54px rgba(0,0,0,0.95)", opacity: 0.95 },
  lovablePreviewMeta: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", color: "#7d786f", fontSize: "12px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  lovableSourceTile: { width: "20px", height: "20px", borderRadius: "6px", background: "linear-gradient(135deg, #a06eff 0%, rgba(217,255,95,0.65) 100%)", flexShrink: 0 },
  lovablePreviewTitle: { margin: "14px 0 0", fontSize: "30px", lineHeight: 1.15, letterSpacing: "-0.02em", fontWeight: 400, color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif" },
  lovablePreviewBody: { margin: "14px 0 0", color: "#aca79b", fontSize: "15px", lineHeight: 1.65, fontFamily: "system-ui, sans-serif" },
  lovableTagRow: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "20px" },
  lovableTag: { display: "inline-flex", alignItems: "center", gap: "5px", borderRadius: "999px", background: "#25252a", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", padding: "6px 10px", fontSize: "12px", fontFamily: "system-ui, sans-serif" },
  lovablePreviewFooter: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", marginTop: "22px", paddingTop: "20px", borderTop: "1px solid rgba(255,255,255,0.08)", color: "#7d786f", fontSize: "12px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", textTransform: "uppercase", letterSpacing: "0.08em" },
  lovableTextButton: { background: "transparent", border: "none", color: "#d9ff5f", cursor: "pointer", fontWeight: 700, fontSize: "12px" },
  lovableSection: { maxWidth: "1180px", margin: "0 auto", padding: "110px clamp(18px, 4vw, 56px)", borderTop: "1px solid rgba(255,255,255,0.08)" },
  lovableSectionIntro: { maxWidth: "720px", margin: "0 auto 54px", textAlign: "center" },
  lovableKicker: { margin: 0, color: "#d9ff5f", textTransform: "uppercase", letterSpacing: "0.18em", fontSize: "12px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  lovableSectionTitle: { margin: "12px 0 0", fontSize: "clamp(38px, 5vw, 64px)", lineHeight: 1.05, letterSpacing: "-0.02em", fontWeight: 400, color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif" },
  lovableStepsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "1px", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "28px", overflow: "hidden" },
  lovableStepCard: { background: "#202024", padding: "32px", minHeight: "240px", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "28px" },
  lovableStepTop: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  lovableStepNumber: { color: "#7d786f", fontSize: "12px", lineHeight: 1, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", letterSpacing: "0.16em" },
  lovableStepIcon: { minWidth: "64px", height: "34px", borderRadius: "999px", color: "#d9ff5f", display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 10px", fontSize: "10px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", textTransform: "uppercase", letterSpacing: "0.12em", boxSizing: "border-box" },
  lovableCardTitle: { margin: 0, fontSize: "30px", lineHeight: 1.15, letterSpacing: "-0.02em", fontWeight: 400, color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif" },
  lovableCardBody: { margin: "12px 0 0", color: "#aca79b", fontSize: "15px", lineHeight: 1.65, fontFamily: "system-ui, sans-serif" },
  lovableMilestone: { position: "relative", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "48px", alignItems: "start", borderRadius: "34px", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", padding: "clamp(26px, 5vw, 52px)", overflow: "hidden" },
  lovableMilestoneList: { listStyle: "none", margin: "34px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "16px" },
  lovableMilestoneItem: { display: "flex", alignItems: "center", gap: "14px" },
  lovableMilestoneDot: { width: "40px", height: "40px", borderRadius: "50%", background: "#25252a", color: "#aca79b", border: "1px solid rgba(255,255,255,0.08)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: "13px", fontFamily: "system-ui, sans-serif" },
  lovableMilestoneDotDone: { width: "40px", height: "40px", borderRadius: "50%", background: "#d9ff5f", color: "#1f2b08", border: "1px solid #d9ff5f", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: "11px", fontFamily: "system-ui, sans-serif" },
  lovableMilestoneDotActive: { width: "40px", height: "40px", borderRadius: "50%", background: "#171719", color: "#d9ff5f", border: "1px solid rgba(217,255,95,0.42)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: "13px", fontFamily: "system-ui, sans-serif" },
  lovableMilestoneLabel: { margin: 0, color: "#f6f3ea", fontSize: "15px", fontFamily: "system-ui, sans-serif", fontWeight: 700 },
  lovableMilestoneCaption: { margin: "2px 0 0", color: "#aca79b", fontSize: "12px", fontFamily: "system-ui, sans-serif" },
  lovableClaudeMock: { borderRadius: "24px", background: "#171719", border: "1px solid rgba(255,255,255,0.08)", overflow: "hidden", boxShadow: "0 30px 90px -60px rgba(0,0,0,0.95)" },
  lovableClaudeTop: { display: "flex", alignItems: "center", gap: "8px", padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", background: "#202024" },
  lovableWindowDotPeach: { width: "8px", height: "8px", borderRadius: "50%", background: "#f7cfc0" },
  lovableWindowDotMint: { width: "8px", height: "8px", borderRadius: "50%", background: "#cde9d9" },
  lovableWindowDotLavender: { width: "8px", height: "8px", borderRadius: "50%", background: "#e0d2f5" },
  lovableClaudeLabel: { marginLeft: "8px", color: "#7d786f", fontSize: "12px", fontFamily: "system-ui, sans-serif" },
  lovableClaudeBody: { padding: "22px", display: "flex", flexDirection: "column", gap: "16px", fontFamily: "system-ui, sans-serif", fontSize: "14px" },
  lovableUserBubble: { alignSelf: "flex-end", maxWidth: "82%", borderRadius: "18px 18px 4px 18px", background: "#d9ff5f", color: "#1f2b08", padding: "12px 14px", lineHeight: 1.45 },
  lovableAssistantBubble: { maxWidth: "88%", borderRadius: "18px 18px 18px 4px", background: "#25252a", color: "#f6f3ea", padding: "14px", lineHeight: 1.55 },
  lovableCitation: { display: "block", marginTop: "10px", color: "#7d786f", fontSize: "12px" },
  lovableFinalCta: { position: "relative", overflow: "hidden", maxWidth: "none", margin: "0 auto", padding: "132px 24px", textAlign: "center", borderTop: "1px solid rgba(255,255,255,0.08)" },
  lovableFinalBackdrop: { position: "absolute", inset: 0, pointerEvents: "none", background: "linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px), radial-gradient(circle at 50% 110%, rgba(217,255,95,0.16), transparent 36%)", backgroundSize: "56px 56px, 56px 56px, auto" },
  lovableFinalTitle: { position: "relative", margin: 0, fontSize: "clamp(58px, 9vw, 104px)", lineHeight: 1.02, letterSpacing: "-0.02em", fontWeight: 400, color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif" },
  lovableFinalButton: { position: "relative", marginTop: "34px", border: "none", borderRadius: "999px", background: "#d9ff5f", color: "#1f2b08", padding: "14px 22px", fontSize: "15px", fontWeight: 700, fontFamily: "system-ui, sans-serif", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "8px", boxShadow: "0 0 44px -16px rgba(217,255,95,0.85)" },
  lovableFooter: { borderTop: "1px solid rgba(255,255,255,0.08)", padding: "32px clamp(18px, 4vw, 56px)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px", maxWidth: "1180px", margin: "0 auto", color: "#7d786f", fontSize: "12px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", textTransform: "uppercase", letterSpacing: "0.12em" },
  lovableFooterBrand: { display: "inline-flex", alignItems: "center", gap: "10px" },
  lovableFooterLogo: { width: "22px", height: "22px", borderRadius: "7px" },
  lovableFooterLinks: { display: "flex", gap: "18px" },
  lovableFooterLink: { background: "transparent", border: "none", color: "#7d786f", cursor: "pointer", fontSize: "12px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", textTransform: "uppercase", letterSpacing: "0.12em" },

  // Install overlay
  overlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.88)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: "24px", boxSizing: "border-box" },
  overlayCard: { background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "24px", padding: "28px 24px", display: "flex", flexDirection: "column", gap: "14px", width: "100%", maxWidth: "360px", textAlign: "center", color: "#f6f3ea" },
  overlayTitle: { fontSize: "24px", fontWeight: "400", margin: 0, color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: "-0.02em" },
  overlayBody: { fontSize: "14px", color: "#aca79b", margin: 0, lineHeight: 1.5 },
  overlaySteps: { display: "flex", flexDirection: "column", gap: "6px", textAlign: "left", background: "#171719", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "14px", padding: "14px 16px" },
  overlayStep: { fontSize: "14px", color: "#aca79b", margin: 0, lineHeight: 1.6 },
  overlayNote: { fontSize: "12px", color: "#7d786f", margin: "4px 0 0", lineHeight: 1.5 },
  overlaySkip: { background: "none", border: "none", color: "#7d786f", fontSize: "13px", cursor: "pointer", padding: "4px" },
  overlayDivider: { height: "1px", background: "rgba(255,255,255,0.08)", margin: "4px 0 10px" },
  overlayVideoLink: { color: "#d9ff5f", fontSize: "13px", textDecoration: "none", display: "block", textAlign: "center", marginTop: "8px" },

  // Progress pill (Save tab, multi-stage milestone track)
  progressPill: { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", padding: "10px 14px", background: "rgba(251,191,36,0.07)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: "12px" },
  progressPillPurple: { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", padding: "10px 14px", background: "rgba(167,139,250,0.07)", border: "1px solid rgba(167,139,250,0.2)", borderRadius: "12px" },
  progressPillGreen: { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", padding: "10px 14px", background: "rgba(52,211,153,0.07)", border: "1px solid rgba(52,211,153,0.2)", borderRadius: "12px" },
  progressBar: { width: "100%", height: "3px", background: "#171719", borderRadius: "2px", overflow: "hidden" },
  progressFill: { height: "100%", background: "#a78bfa", borderRadius: "2px", transition: "width 0.4s ease" },
  progressDotsRow: { display: "flex", alignItems: "center", gap: "6px" },
  dotFilled: { display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", background: "#fbbf24", flexShrink: 0 },
  dotEmpty: { display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", background: "#2a2a2a", border: "1px solid #444", flexShrink: 0 },
  dotFilledSmall: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: "#fbbf24", flexShrink: 0 },
  dotEmptySmall: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: "#2a2a2a", border: "1px solid #444", flexShrink: 0 },
  progressLabel: { fontSize: "12px", color: "#aca79b", marginLeft: "2px" },

  // First-save bottom sheet
  bottomSheet: { position: "fixed", bottom: 0, left: 0, right: 0, background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderTopLeftRadius: "24px", borderTopRightRadius: "24px", padding: "16px 24px 36px", display: "flex", flexDirection: "column", gap: "12px", zIndex: 50, animation: "slideUp 0.3s ease-out" },
  bottomSheetHandle: { width: "36px", height: "4px", background: "#7d786f", borderRadius: "2px", alignSelf: "center", marginBottom: "4px" },
  bottomSheetTitle: { fontSize: "22px", fontWeight: "400", margin: 0, color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: "-0.02em" },
  bottomSheetBody: { fontSize: "14px", color: "#aca79b", margin: 0, lineHeight: 1.5 },
  shareHowTo: { background: "#171719", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "14px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "8px" },
  shareHowToLabel: { fontSize: "11px", color: "#7d786f", textTransform: "uppercase", letterSpacing: "0.12em", margin: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  shareHowToStep: { display: "flex", alignItems: "flex-start", gap: "10px" },
  shareHowToNum: { fontSize: "16px", color: "#d9ff5f", flexShrink: 0, lineHeight: 1.4 },
  shareHowToText: { fontSize: "13px", color: "#aca79b", lineHeight: 1.5 },

  // Search nudge toast
  nudgeToast: { position: "fixed", top: "16px", left: "16px", right: "16px", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "16px", padding: "12px 14px", display: "flex", alignItems: "center", gap: "10px", zIndex: 50, animation: "slideDown 0.3s ease-out", boxShadow: "0 24px 70px -42px rgba(0,0,0,0.9)" },
  nudgeText: { fontSize: "14px", color: "#f6f3ea", flex: 1 },
  nudgeCta: { background: "#d9ff5f", border: "none", color: "#1f2b08", borderRadius: "999px", padding: "6px 12px", fontSize: "13px", fontWeight: "700", cursor: "pointer", flexShrink: 0 },
  nudgeDismiss: { background: "none", border: "none", color: "#7d786f", fontSize: "18px", cursor: "pointer", padding: "0 4px", lineHeight: 1, flexShrink: 0 },

  // Milestone receipt row
  milestoneRow: { display: "flex", flexDirection: "column", gap: "6px", paddingTop: "10px", borderTop: "1px solid rgba(255,255,255,0.08)" },
  milestoneText: { fontSize: "12px", color: "#d9ff5f", margin: 0 },
  milestoneHeadline: { fontSize: "14px", fontWeight: "700", color: "#f6f3ea", margin: 0 },
  milestoneSub: { fontSize: "12px", color: "#aca79b", margin: 0 },

  // Settings panel
  settingsPanel: { width: "100%", maxWidth: "760px", boxSizing: "border-box", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "18px", padding: "16px", display: "flex", flexDirection: "column", gap: "10px", margin: "0 auto 4px", color: "#f6f3ea" },
  settingsLinks: { display: "flex", gap: "8px", flexWrap: "wrap", width: "100%" },
  settingsLink: { background: "#25252a", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", padding: "6px 14px", borderRadius: "999px", cursor: "pointer", fontSize: "13px" },
  settingsDivider: { height: "1px", background: "rgba(255,255,255,0.08)" },
  settingsSectionHeading: { fontSize: "11px", fontWeight: "700", color: "#d9ff5f", textTransform: "uppercase", letterSpacing: "0.12em", margin: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  settingsAccordionHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: "11px", fontWeight: "700", color: "#d9ff5f", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  settingsAccordionChevron: { fontSize: "13px", color: "#7d786f", textTransform: "none", letterSpacing: 0 },
  settingsAccordionBody: { display: "flex", flexDirection: "column", gap: "10px", marginTop: "10px", width: "100%", boxSizing: "border-box" },
  shortcutAddButton: { display: "inline-block", textAlign: "center", background: "#d9ff5f", border: "none", color: "#1f2b08", borderRadius: "999px", padding: "10px 16px", fontSize: "14px", fontWeight: "700", cursor: "pointer", textDecoration: "none" },
  tokenSection: { display: "flex", flexDirection: "column", gap: "8px" },
  tokenRow: { display: "flex", gap: "6px", alignItems: "center" },
  tokenInput: { flex: 1, background: "#171719", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "10px", color: "#f6f3ea", fontSize: "13px", padding: "7px 10px", fontFamily: "ui-monospace, Consolas, monospace", minWidth: 0 },
  tokenCopyButton: { background: "#d9ff5f", border: "none", color: "#1f2b08", borderRadius: "10px", padding: "7px 14px", fontSize: "13px", fontWeight: "700", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
  tokenWarning: { fontSize: "12px", color: "#7d786f", lineHeight: 1.5, margin: 0 },
  tokenHideButton: { background: "none", border: "none", color: "#7d786f", fontSize: "12px", cursor: "pointer", padding: 0, alignSelf: "flex-start" },
  recallPanel: { width: "100%", boxSizing: "border-box", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "24px", padding: "22px", display: "flex", flexDirection: "column", gap: "12px", color: "#f6f3ea", boxShadow: "0 30px 90px -56px rgba(0,0,0,0.95)" },
  recallTitle: { fontSize: "24px", fontWeight: "400", color: "#f6f3ea", margin: 0, lineHeight: 1.15, letterSpacing: "-0.02em", fontFamily: "Georgia, 'Times New Roman', serif", textAlign: "center" },
  recallBody: { fontSize: "14px", color: "#aca79b", lineHeight: 1.6, margin: 0, textAlign: "center" },
  mcpLearnPanelButton: { alignSelf: "center", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "8px", background: "#25252a", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", borderRadius: "999px", padding: "8px 14px", cursor: "pointer", textAlign: "center" },
  mcpLearnPanelButtonHighlight: { color: "#d9ff5f", borderColor: "rgba(217,255,95,0.55)", boxShadow: "0 0 0 2px rgba(217,255,95,0.14), 0 22px 52px -36px rgba(217,255,95,0.9)" },
  mcpLearnPanelIcon: { width: "26px", height: "26px", borderRadius: "999px", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 },
  mcpLearnPanelText: { fontSize: "13px", fontWeight: "700" },
  mcpPromptCard: { width: "100%", maxWidth: "440px", boxSizing: "border-box", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "24px", padding: "24px", display: "flex", flexDirection: "column", gap: "14px", color: "#f6f3ea", textAlign: "center", boxShadow: "0 30px 90px -46px rgba(0,0,0,0.95)" },
  mcpPromptTitle: { fontSize: "30px", fontWeight: "400", color: "#f6f3ea", margin: 0, lineHeight: 1.12, letterSpacing: "-0.02em", fontFamily: "Georgia, 'Times New Roman', serif" },
  mcpPromptBody: { fontSize: "14px", color: "#aca79b", lineHeight: 1.55, margin: 0 },
  mcpPromptActions: { display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap", marginTop: "4px" },
  mcpPromptYes: { background: "#d9ff5f", border: "none", color: "#1f2b08", borderRadius: "999px", padding: "10px 16px", fontSize: "14px", fontWeight: "700", cursor: "pointer" },
  mcpPromptNo: { background: "#25252a", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", borderRadius: "999px", padding: "10px 16px", fontSize: "14px", cursor: "pointer" },
  mcpVideoCard: { width: "clamp(320px, 70vw, 960px)", maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 48px)", boxSizing: "border-box", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "24px", padding: "18px", display: "flex", flexDirection: "column", gap: "14px", color: "#f6f3ea", boxShadow: "0 30px 90px -40px rgba(0,0,0,0.95)" },
  mcpVideoHeader: { display: "flex", justifyContent: "center", alignItems: "center", gap: "14px", textAlign: "center" },
  mcpVideoHeaderCopy: { display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" },
  mcpVideoTitle: { fontSize: "24px", fontWeight: "400", color: "#f6f3ea", margin: 0, lineHeight: 1.15, letterSpacing: "-0.02em", fontFamily: "Georgia, 'Times New Roman', serif", textAlign: "center" },
  mcpVideo: { width: "100%", maxHeight: "70vh", borderRadius: "18px", background: "#171719", border: "1px solid rgba(255,255,255,0.08)", objectFit: "contain" },
  mcpVideoActions: { display: "flex", justifyContent: "flex-end", gap: "10px", flexWrap: "wrap" },
  deleteAccountButton: { background: "none", border: "1px solid #ef4444", color: "#ef4444", padding: "7px 16px", borderRadius: "8px", cursor: "pointer", fontSize: "13px", alignSelf: "flex-start" },
  deleteAccountConfirm: { display: "flex", flexDirection: "column", gap: "10px" },
  deleteAccountWarning: { fontSize: "13px", color: "#aca79b", margin: 0, lineHeight: 1.4 },
  deleteAccountYes: { background: "#ef4444", border: "none", color: "#fff", borderRadius: "8px", padding: "7px 16px", fontSize: "13px", fontWeight: "600", cursor: "pointer", flexShrink: 0 },
  deleteAccountNo: { background: "#25252a", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", borderRadius: "8px", padding: "7px 14px", fontSize: "13px", cursor: "pointer", flexShrink: 0 },

  // Legal view
  legalContent: { display: "flex", flexDirection: "column", gap: "0", paddingBottom: "40px", width: "100%", maxWidth: "760px", margin: "0 auto", textAlign: "left" },
  legalTitle: { fontSize: "clamp(36px, 6vw, 56px)", fontWeight: "400", color: "#f6f3ea", margin: "12px 0 8px", letterSpacing: "-0.02em", fontFamily: "Georgia, 'Times New Roman', serif", textAlign: "center" },
  legalMeta: { fontSize: "12px", color: "#7d786f", margin: "0 0 24px", textAlign: "left" },
  legalH3: { fontSize: "22px", fontWeight: "400", color: "#f6f3ea", margin: "24px 0 8px", fontFamily: "Georgia, 'Times New Roman', serif", letterSpacing: "-0.02em", textAlign: "center" },
  legalP: { fontSize: "14px", color: "#aca79b", lineHeight: 1.7, margin: 0, textAlign: "left" },
  backButton: { background: "none", border: "none", color: "#aca79b", cursor: "pointer", fontSize: "14px", padding: "4px 0" },

  // Legal footer
  legalFooter: { display: "flex", justifyContent: "center", alignItems: "center", gap: "8px", padding: "24px 0 16px", marginTop: "8px", width: "100%", maxWidth: "760px" },
  legalFooterLink: { background: "none", border: "none", color: "#7d786f", cursor: "pointer", fontSize: "12px", padding: 0 },

  // Install banner + bottom-of-page fallback button
  installBanner: { display: "flex", flexDirection: "column", gap: "8px", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "16px", padding: "10px 14px", marginBottom: "16px", width: "100%", maxWidth: "760px", boxSizing: "border-box" },
  installBannerRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" },
  installBannerText: { fontSize: "13px", color: "#aca79b", flex: 1, lineHeight: 1.4 },
  installBannerActions: { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 },
  installBannerButton: { background: "#d9ff5f", border: "none", color: "#1f2b08", borderRadius: "999px", padding: "7px 14px", fontSize: "13px", fontWeight: "700", cursor: "pointer", whiteSpace: "nowrap" },
  installBannerDismiss: { background: "none", border: "none", color: "#7d786f", fontSize: "16px", cursor: "pointer", padding: "0 2px", lineHeight: 1, flexShrink: 0 },
  installFooterWrap: { display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", padding: "8px 0 0", width: "100%", maxWidth: "760px" },
  installFooterButton: { background: "#202024", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", padding: "8px 18px", borderRadius: "999px", cursor: "pointer", fontSize: "13px" },

  // Ask / Search mode toggle
  modeToggle: { display: "flex", gap: "4px", background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "999px", padding: "3px", alignSelf: "flex-start" },
  modeToggleActive: { background: "#d9ff5f", color: "#1f2b08", border: "none", borderRadius: "999px", padding: "5px 14px", fontSize: "13px", fontWeight: "700", cursor: "pointer" },
  modeToggleInactive: { background: "none", color: "#7d786f", border: "none", borderRadius: "999px", padding: "5px 14px", fontSize: "13px", cursor: "pointer" },

  // Synthesis card
  synthesisCard: { background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "18px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" },
  synthesisHeader: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  synthesisLabel: { fontSize: "11px", color: "#d9ff5f", textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: "700", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  synthesisText: { fontSize: "14px", color: "#aca79b", lineHeight: 1.65, margin: 0, whiteSpace: "pre-wrap" },
  synthesisSources: { display: "flex", flexDirection: "column", gap: "6px", paddingTop: "8px", borderTop: "1px solid rgba(255,255,255,0.08)" },
  synthesisSourcesLabel: { fontSize: "10px", color: "#7d786f", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  synthesisSourceChips: { display: "flex", flexWrap: "wrap", gap: "6px" },
  synthesisSourceChip: { background: "#25252a", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", borderRadius: "999px", padding: "3px 8px", fontSize: "12px", textDecoration: "none", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "180px" },
  synthesisInsufficient: { background: "#202024", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "18px", padding: "16px", display: "flex", flexDirection: "column", gap: "10px" },

  // Related saves on receipt
  relatedSavesSection: { display: "flex", flexDirection: "column", gap: "6px", paddingTop: "10px", borderTop: "1px solid rgba(255,255,255,0.08)" },
  relatedSavesLabel: { fontSize: "11px", color: "#7d786f" },
  relatedSaveChip: { background: "#25252a", border: "1px solid rgba(255,255,255,0.08)", color: "#aca79b", borderRadius: "10px", padding: "6px 10px", fontSize: "12px", cursor: "pointer", textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },

  // Calendar (Search tab — idle/browse state)
  calNavBtn: { background: "none", border: "none", color: "#d9ff5f", fontSize: 20, cursor: "pointer", padding: "4px 12px", borderRadius: 6 },
  calGrid: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, marginBottom: 12 },
  calDayHeader: { textAlign: "center", fontSize: 11, color: "#7d786f", fontWeight: 600, padding: "4px 0 8px" },
  calCell: { borderRadius: 8, padding: "6px 4px 8px", minHeight: 54, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, transition: "background 0.12s" },
  calCellToday: { boxShadow: "inset 0 0 0 1.5px #d9ff5f" },
  calCellSelected: { background: "#202024" },
  calDayNum: { fontSize: 13, color: "#7d786f" },
  calDots: { display: "flex", gap: 2, flexWrap: "wrap", justifyContent: "center", alignItems: "center" },
  calDot: { width: 5, height: 5, borderRadius: "50%", flexShrink: 0 },
  calDotMore: { fontSize: 9, color: "#7d786f", lineHeight: 1 },
  calDayPanel: { background: "#202024", borderRadius: 18, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 0, marginTop: 4, border: "1px solid rgba(255,255,255,0.08)" },
  calDayPanelHeader: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 },
  calDayPanelTitle: { fontSize: 14, fontWeight: 600, color: "#f6f3ea", textAlign: "left" },
  calSaveCard: { display: "flex", flexDirection: "column", gap: 6, padding: "14px 16px", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 18, background: "#202024", textDecoration: "none", color: "#f6f3ea", textAlign: "left", marginTop: 8 },
  calSaveTitle: { fontSize: 15, fontWeight: 400, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", fontFamily: "Georgia, 'Times New Roman', serif", color: "#f6f3ea" },
  calSaveSource: { fontSize: 11, color: "#7d786f" },
  libraryFeed: { display: "flex", flexDirection: "column", gap: 20, marginTop: 24, paddingTop: 20, borderTop: "1px solid rgba(255,255,255,0.08)" },
  libraryFeedLabel: { fontSize: 11, color: "#7d786f", textTransform: "uppercase", letterSpacing: "0.12em", textAlign: "left", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  libraryFeedDay: { display: "flex", flexDirection: "column", gap: 0 },
  // Ask step text
  askStepText: { color: "#7d786f", fontSize: "13px", textAlign: "center", margin: "2px 0 0" },
  // Search card trash button + title link
  cardTrashBtn: { background: "none", border: "none", cursor: "pointer", color: "#7d786f", padding: "2px 4px", marginLeft: "auto", flexShrink: 0, display: "flex", alignItems: "center" },
  cardTitleLink: { display: "block", textDecoration: "none", color: "inherit" },

}
