import React from "react";
import { Nav } from "./Nav";

export function Layout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", minHeight: "100vh" }}>
      <Nav />
      <main style={{ padding: 20 }}>
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        {children}
      </main>
    </div>
  );
}
