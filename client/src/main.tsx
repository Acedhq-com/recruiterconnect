import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import App from "./CareerApp.js";
import { queryClient } from "./lib/queryClient.js";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Router hook={useHashLocation}><App /></Router>
  </QueryClientProvider>
);
