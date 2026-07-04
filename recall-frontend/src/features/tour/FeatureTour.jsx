import { useEffect, useRef } from "react"
import { Spotlight } from "./Spotlight"
import { TourStep } from "./TourStep"
import { useFeatureTour } from "./useFeatureTour"
import { emitFeatureTourStep, FEATURE_TOUR_REPLAY_EVENT } from "./tour-events"

export function FeatureTour({ autoOpen = true, onStepChange, restartKey = null, steps }) {
  const tour = useFeatureTour({ autoOpen, steps })
  const onStepChangeRef = useRef(onStepChange)

  useEffect(() => {
    onStepChangeRef.current = onStepChange
  }, [onStepChange])

  useEffect(() => {
    const handleReplay = () => tour.openFromStart()
    window.addEventListener(FEATURE_TOUR_REPLAY_EVENT, handleReplay)
    return () => window.removeEventListener(FEATURE_TOUR_REPLAY_EVENT, handleReplay)
  }, [tour.openFromStart])

  useEffect(() => {
    if (restartKey === null || restartKey === undefined) return
    tour.openFromStart()
  }, [restartKey, tour.openFromStart])

  useEffect(() => {
    if (!tour.open || !tour.step) {
      onStepChangeRef.current?.(null, -1)
      emitFeatureTourStep(null, -1)
      return
    }
    onStepChangeRef.current?.(tour.step, tour.index)
    emitFeatureTourStep(tour.step, tour.index)
  }, [tour.index, tour.open, tour.step])

  if (!tour.open || !tour.step) return null

  return (
    <>
      {tour.step.targetSelector && <Spotlight selector={tour.step.targetSelector} />}
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
    </>
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
    zIndex: 90,
    animation: "tourSlideUp 180ms ease-out",
  },
}
