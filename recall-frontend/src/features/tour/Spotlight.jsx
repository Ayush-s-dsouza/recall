import { useEffect, useState } from "react"

const PADDING = 8
const RADIUS = 10

export function Spotlight({ selector }) {
  const [rect, setRect] = useState(null)

  useEffect(() => {
    let timer = 0
    let cancelled = false

    const measure = () => {
      const el = document.querySelector(selector)
      if (!el) {
        setRect(null)
        return false
      }
      const r = el.getBoundingClientRect()
      setRect({
        x: r.left - PADDING,
        y: r.top - PADDING,
        width: r.width + PADDING * 2,
        height: r.height + PADDING * 2,
      })
      if (r.top < 0 || r.bottom > window.innerHeight) {
        el.scrollIntoView({ behavior: "smooth", block: "center" })
      }
      return true
    }

    let attempts = 0
    const tick = () => {
      if (cancelled) return
      if (!measure() && attempts++ < 40) {
        timer = window.setTimeout(tick, 50)
      }
    }
    tick()

    const onReflow = () => measure()
    window.addEventListener("resize", onReflow)
    window.addEventListener("scroll", onReflow, true)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.removeEventListener("resize", onReflow)
      window.removeEventListener("scroll", onReflow, true)
    }
  }, [selector])

  if (!rect) {
    return <div style={styles.fallback} aria-hidden="true" />
  }

  return (
    <>
      <svg style={styles.svg} aria-hidden="true">
        <defs>
          <mask id="tour-spotlight-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              rx={RADIUS}
              ry={RADIUS}
              fill="black"
            />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.62)" mask="url(#tour-spotlight-mask)" />
      </svg>
      <div
        style={{
          ...styles.ring,
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        }}
        aria-hidden="true"
      />
    </>
  )
}

const styles = {
  fallback: {
    position: "fixed",
    inset: 0,
    zIndex: 60,
    pointerEvents: "none",
    background: "rgba(0,0,0,0.5)",
    animation: "tourFadeIn 160ms ease-out",
  },
  ring: {
    position: "fixed",
    zIndex: 71,
    pointerEvents: "none",
    borderRadius: `${RADIUS}px`,
    boxShadow: "0 0 0 2px #d9ff5f, 0 0 32px 4px rgba(217,255,95,0.32)",
    animation: "tourFadeIn 160ms ease-out",
  },
  svg: {
    position: "fixed",
    inset: 0,
    width: "100%",
    height: "100%",
    zIndex: 60,
    pointerEvents: "none",
    animation: "tourFadeIn 160ms ease-out",
  },
}
