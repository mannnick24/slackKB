import React from "react";
import { Link, useLocation } from "react-router-dom";

export function Nav() {
  const loc = useLocation();
  const chatActive = loc.pathname === "/" || loc.pathname === "/chat";

  const item = (to: string, label: string, active: boolean) => (
    <div style={{ marginBottom: 10 }}>
      <Link style={{ fontWeight: active ? 700 : 400 }} to={to}>
        {label}
      </Link>
    </div>
  );

  return (
    <aside style={{ padding: 16, borderRight: "1px solid #ddd" }}>
      <div style={{ fontWeight: 800, marginBottom: 16 }}>slackKB</div>
      {item("/", "Chat", chatActive)}
      {item("/config", "Config", loc.pathname === "/config")}
      {item("/status", "Status", loc.pathname === "/status")}
    </aside>
  );
}
