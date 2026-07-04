import { useEffect, useRef } from "react"

const TOUR_PLAYBACK_RATE = 0.6

export function TourStep({
  canGoBack,
  isLast,
  onBack,
  onNext,
  onSkip,
  progress,
  step,
  stepIndex,
  totalSteps,
}) {
  const videoRef = useRef(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.playbackRate = TOUR_PLAYBACK_RATE
    video.currentTime = 0
    const play = () => {
      video.playbackRate = TOUR_PLAYBACK_RATE
      video.play().catch(() => {})
    }
    if (video.readyState >= 2) play()
    else video.addEventListener("loadeddata", play, { once: true })
  }, [step.id, step.videoSrc, step.videoUrl])

  return (
    <article role="dialog" style={styles.card} aria-label={`Feature tour step ${progress}`}>
      <div style={styles.videoWrap}>
        <video
          key={step.videoSrc || step.videoUrl}
          ref={videoRef}
          src={step.videoSrc || step.videoUrl}
          poster={step.poster || undefined}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          style={styles.video}
        />
        <div style={styles.newBadge}>New</div>
      </div>

      <div style={styles.copy}>
        <div style={styles.progressRow}>
          <div style={styles.dots} aria-hidden="true">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <span key={i} style={i === stepIndex ? styles.dotActive : styles.dot} />
            ))}
          </div>
          <span style={styles.progress}>{stepIndex + 1} / {totalSteps}</span>
        </div>
        <p style={styles.eyebrow}>{step.eyebrow}</p>
        <h2 style={styles.title}>{step.title}</h2>
        <p style={styles.description}>{step.description}</p>
      </div>

      <footer style={styles.footer}>
        <button type="button" onClick={onSkip} style={styles.ghostButton}>
          Skip tour
        </button>
        <div style={styles.actions}>
          {canGoBack && (
            <button type="button" onClick={onBack} style={styles.secondaryButton}>
              Back
            </button>
          )}
          <button type="button" onClick={onNext} style={styles.primaryButton}>
            {isLast ? "Got it" : step.primaryLabel || "Next"}
          </button>
        </div>
      </footer>
    </article>
  )
}

const styles = {
  actions: { display: "flex", alignItems: "center", gap: "8px" },
  card: {
    width: "min(380px, calc(100vw - 32px))",
    background: "#202024",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "18px",
    boxShadow: "0 30px 90px -48px rgba(0,0,0,0.95)",
    color: "#f6f3ea",
    overflow: "hidden",
  },
  copy: { padding: "16px 16px 4px", textAlign: "left" },
  description: { margin: "8px 0 0", color: "#aca79b", fontSize: "14px", lineHeight: 1.55 },
  dot: { width: "6px", height: "6px", borderRadius: "50%", background: "#3a3935", display: "inline-block" },
  dotActive: { width: "24px", height: "6px", borderRadius: "999px", background: "#d9ff5f", display: "inline-block", transition: "width 160ms ease" },
  dots: { display: "flex", alignItems: "center", gap: "5px" },
  eyebrow: {
    margin: "12px 0 6px",
    color: "#d9ff5f",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "11px",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
  },
  footer: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", padding: "16px 18px 18px" },
  ghostButton: { background: "transparent", border: "none", color: "#7d786f", cursor: "pointer", fontSize: "13px", padding: 0 },
  newBadge: {
    position: "absolute",
    left: "12px",
    top: "12px",
    borderRadius: "999px",
    background: "rgba(23,23,25,0.78)",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "#f6f3ea",
    fontSize: "12px",
    fontWeight: 700,
    padding: "2px 8px",
    backdropFilter: "blur(10px)",
  },
  primaryButton: {
    background: "#d9ff5f",
    border: "none",
    borderRadius: "999px",
    color: "#1f2b08",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 700,
    padding: "9px 14px",
  },
  progress: { color: "#7d786f", fontSize: "12px" },
  progressRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "2px" },
  secondaryButton: {
    background: "#25252a",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "999px",
    color: "#aca79b",
    cursor: "pointer",
    fontSize: "13px",
    padding: "8px 13px",
  },
  title: { margin: 0, color: "#f6f3ea", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "23px", fontWeight: 400, lineHeight: 1.15 },
  video: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  videoWrap: { position: "relative", aspectRatio: "16 / 9", background: "#171719", borderBottom: "1px solid rgba(255,255,255,0.08)", overflow: "hidden" },
}
