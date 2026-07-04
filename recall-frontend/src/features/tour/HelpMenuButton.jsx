import { openFeatureTour } from "./tour-events"

export function HelpMenuButton({ style }) {
  return (
    <button
      type="button"
      aria-label="Replay feature tour"
      title="Replay feature tour"
      onClick={openFeatureTour}
      style={{ ...styles.button, ...style }}
    >
      ?
    </button>
  )
}

const styles = {
  button: {
    width: "42px",
    height: "42px",
    borderRadius: "999px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "#202024",
    color: "#aca79b",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "16px",
    fontWeight: 700,
    lineHeight: 1,
  },
}
