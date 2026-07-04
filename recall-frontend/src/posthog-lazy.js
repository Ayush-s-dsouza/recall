// posthog-js is ~63KB gzip on its own — a large chunk of the critical-path bundle for a
// library that's only used for fire-and-forget analytics calls, never for anything the user
// is waiting on. This proxy lets every existing `posthog.capture(...)` call site stay
// unchanged, while the real SDK loads as its own parallel chunk instead of blocking the
// app's initial parse/render. Calls made before it's ready are queued and replayed once
// the real SDK has loaded.
let real = null
const queue = []

function relay(method) {
  return (...args) => {
    if (real) real[method](...args)
    else queue.push([method, args])
  }
}

const posthog = {
  capture: relay('capture'),
  identify: relay('identify'),
  reset: relay('reset'),
}

if (import.meta.env.VITE_POSTHOG_KEY) {
  import('posthog-js').then(({ default: realPosthog }) => {
    realPosthog.init(import.meta.env.VITE_POSTHOG_KEY, {
      api_host: 'https://us.i.posthog.com',
      person_profiles: 'identified_only',
    })
    const isLocal = typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname)
    realPosthog.register({ environment: isLocal ? 'local' : (import.meta.env.VITE_APP_ENV ?? 'production') })
    real = realPosthog
    queue.forEach(([method, args]) => real[method](...args))
    queue.length = 0
  })
}

export default posthog
