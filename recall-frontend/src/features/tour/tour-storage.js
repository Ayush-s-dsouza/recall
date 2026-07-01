export const TOUR_COMPLETED_KEY = "recall.tour.completed"

export function hasCompletedTour(storage = window.localStorage) {
  try {
    return storage.getItem(TOUR_COMPLETED_KEY) === "1"
  } catch {
    return false
  }
}

export function markTourCompleted(storage = window.localStorage) {
  try {
    storage.setItem(TOUR_COMPLETED_KEY, "1")
  } catch {
    // Storage can be unavailable in private browsing; the tour still works in-memory.
  }
}

export function resetTourCompletion(storage = window.localStorage) {
  try {
    storage.removeItem(TOUR_COMPLETED_KEY)
  } catch {
    // Ignore storage failures.
  }
}

export async function syncToSupabase(userId, supabase, completed = true) {
  if (!userId || !supabase) return { error: null }
  return supabase
    .from("profiles")
    .update({ onboarding_completed: completed })
    .eq("id", userId)
}
