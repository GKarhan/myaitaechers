import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useLocation } from "wouter";
import { setAuthTokenGetter, getGetProfileQueryKey } from "@workspace/api-client-react";
import { useGetProfile, UserProfile } from "@workspace/api-client-react";

interface AuthContextType {
  token: string | null;
  user: UserProfile | null;
  login: (token: string) => void;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    return localStorage.getItem("myaiteacher_token");
  });
  const [, setLocation] = useLocation();

  useEffect(() => {
    setAuthTokenGetter(() => localStorage.getItem("myaiteacher_token"));
  }, []);

  const { data: user, isLoading: isUserLoading } = useGetProfile({
    query: {
      queryKey: getGetProfileQueryKey(),
      enabled: !!token,
      retry: false,
    },
  });

  const login = (newToken: string) => {
    localStorage.setItem("myaiteacher_token", newToken);
    setToken(newToken);
  };

  const logout = () => {
    localStorage.removeItem("myaiteacher_token");
    setToken(null);
    setLocation("/");
  };

  return (
    <AuthContext.Provider
      value={{
        token,
        user: user || null,
        login,
        logout,
        isLoading: isUserLoading && !!token,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
