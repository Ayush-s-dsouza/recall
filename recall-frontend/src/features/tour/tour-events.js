export const FEATURE_TOUR_REPLAY_EVENT = "recall:feature-tour:replay"
export const FEATURE_TOUR_STEP_EVENT = "recall:feature-tour:step"

export function openFeatureTour() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(FEATURE_TOUR_REPLAY_EVENT))
}

export function emitFeatureTourStep(step, index) {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(FEATURE_TOUR_STEP_EVENT, {
    detail: { index, step },
  }))
}
