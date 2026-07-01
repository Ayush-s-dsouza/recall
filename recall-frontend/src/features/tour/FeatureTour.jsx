import { useEffect } from "react"
import { TourStep } from "./TourStep"
import { useFeatureTour } from "./useFeatureTour"
import { FEATURE_TOUR_REPLAY_EVENT } from "./tour-events"

export function FeatureTour({ autoOpen = true }) {
  const tour = useFeatureTour({ autoOpen })

  useEffect(() => {
    const handleReplay = () => tour.openFromStart()
    window.addEventListener(FEATURE_TOUR_REPLAY_EVENT, handleReplay)
    return () => window.removeEventListener(FEATURE_TOUR_REPLAY_EVENT, handleReplay)
  }, [tour])

  if (!tour.open || !tour.step) return null

  return (
    <div className="feature-tour-shell" style={styles.shell} aria-live="polite">
      <div style={styles.glow} aria-hidden="true" />
      <TourStep
        canGoBack={!tour.isFirst}
        isLast={tour.isLast}
        onBack={tour.back}
        onNext={tour.next}
        onSkip={() => tour.close(true)}
        progress={tour.progress}
        step={tour.step}
        stepIndex={tour.index}
        totalSteps={tour.steps.length}
      />
    </div>
  )
}

const styles = {
  glow: {
    position: "absolute",
    inset: "-18px",
    borderRadius: "32px",
    background: "radial-gradient(circle at 80% 0%, rgba(217,255,95,0.12), transparent 42%)",
    pointerEvents: "none",
  },
  shell: {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: 80,
    animation: "tourSlideUp 180ms ease-out",
  },
}
