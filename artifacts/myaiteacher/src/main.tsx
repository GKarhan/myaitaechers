import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// Render-ում աշխատող backend
setBaseUrl("https://myaitaechers-api.onrender.com");

createRoot(document.getElementById("root")!).render(<App />);
