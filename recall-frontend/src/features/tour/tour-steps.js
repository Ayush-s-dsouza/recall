export const TOUR_OPEN_DELAY_MS = 600

export const tourSteps = [
  {
    id: "import-x",
    highlight: "import-x",
    targetSelector: '[data-tour="import-x-button"]',
    eyebrow: "Import",
    title: "Import your X bookmarks",
    description: "We'll open Settings -> Import from X. Click Connect X to import bookmarks and ReCall will pull everything in.",
    videoSrc: "/tour/import-x.mp4",
    poster: "",
    primaryLabel: "Next",
  },
  {
    id: "search-saves",
    highlight: "search",
    targetSelector: '[data-tour="search-bar"]',
    eyebrow: "Search",
    title: "Search everything you've saved",
    description: "Ask ReCall in plain English. It searches across every link, tweet, and post you've imported.",
    videoSrc: "/tour/recall-search.mp4",
    poster: "",
    primaryLabel: "Next",
  },
  {
    id: "connect-llm",
    highlight: "connect-llm",
    targetSelector: '[data-tour="mcp-link"]',
    eyebrow: "Connect",
    title: "Connect ReCall to any LLM",
    description: "Copy the MCP link from Connect to an LLM app. Point ChatGPT, Claude, or your own model at ReCall as a knowledge source.",
    videoSrc: "/tour/connect-llm.mp4",
    poster: "",
    primaryLabel: "Got it",
  },
]
