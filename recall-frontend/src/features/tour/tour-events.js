export const FEATURE_TOUR_REPLAY_EVENT = "recall:feature-tour:replay"

export function openFeatureTour() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(FEATURE_TOUR_REPLAY_EVENT))
}
