import { useEffect, useState } from "react";
import { wsClient } from "../../services/wsClient.js";

const GRACE_MS = 1500;

export default function ConnectionOverlay() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsub = wsClient.onConnectionChange((connected) => {
      if (connected) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        setShow(false);
      } else {
        timer = setTimeout(() => {
          setShow(true);
          timer = null;
        }, GRACE_MS);
      }
    });

    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!show) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        style={{
          background: "#1a1a1a",
          border: "1px solid #333",
          borderRadius: 12,
          padding: "32px 48px",
          textAlign: "center",
          color: "#e8e8e8",
          maxWidth: 400,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            border: "3px solid #333",
            borderTopColor: "#6c63ff",
            borderRadius: "50%",
            animation: "conn-spin 0.8s linear infinite",
            margin: "0 auto 16px",
          }}
        />
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
          Connection lost
        </div>
        <div style={{ fontSize: 14, color: "#888" }}>
          Reconnecting to server...
        </div>
        <style>{`@keyframes conn-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}
