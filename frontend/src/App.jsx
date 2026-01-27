import React from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";

function Router() {
  const { user } = useAuth();
  return user ? <Dashboard /> : <Login />;
}

export default function App() {
  React.useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.getLogPath().then((path) => {
        console.log("📂 BACKEND LOGS ARE HERE:", path);
      });
    }
  }, []);

  return (
    <AuthProvider>
      <Router />
    </AuthProvider>
  );
}
