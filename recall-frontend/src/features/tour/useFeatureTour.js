import { useCallback, useEffect, useMemo, useState } from "react"
import { hasCompletedTour, markTourCompleted } from "./tour-storage"
import { TOUR_OPEN_DELAY_MS, tourSteps } from "./tour-steps"

export function useFeatureTour({ autoOpen = true, steps = tourSteps } = {}) {
  const [index, setIndex] = useState(0)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!autoOpen || hasCompletedTour()) return undefined
    const id = window.setTimeout(() => setOpen(true), TOUR_OPEN_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [autoOpen])

  const markComplete = useCallback(() => {
    markTourCompleted()
    setOpen(false)
  }, [])

  const openFromStart = useCallback(() => {
    setIndex(0)
    setOpen(true)
  }, [])

  const close = useCallback((complete = false) => {
    if (complete) {
      markComplete()
      return
    }
    setOpen(false)
  }, [markComplete])

  const next = useCallback(() => {
    setIndex(current => {
      if (current >= steps.length - 1) {
        markTourCompleted()
        setOpen(false)
        return current
      }
      return current + 1
    })
  }, [steps.length])

  const back = useCallback(() => {
    setIndex(current => Math.max(0, current - 1))
  }, [])

  return useMemo(() => ({
    back,
    close,
    index,
    isFirst: index === 0,
    isLast: index === steps.length - 1,
    markComplete,
    next,
    open,
    openFromStart,
    progress: `${index + 1}/${steps.length}`,
    setIndex,
    step: steps[index],
    steps,
  }), [back, close, index, markComplete, next, open, openFromStart, steps])
}
