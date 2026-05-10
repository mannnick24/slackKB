import React from "react";
import { Route, Routes, Navigate } from "react-router-dom";
import { ChatPage } from "./pages/ChatPage";
import { ConfigPage } from "./pages/ConfigPage";
import { StatusPage } from "./pages/StatusPage";

export function RoutesRoot() {
  return (
    <Routes>
      <Route path="/" element={<ChatPage />} />
      <Route path="/chat" element={<ChatPage />} />
      <Route path="/config" element={<ConfigPage />} />
      <Route path="/status" element={<StatusPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
