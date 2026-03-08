function readCookie(name) {
  const prefix = `${name}=`;
  const parts = document.cookie.split(";").map((part) => part.trim());
  for (const part of parts) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return "";
}

export async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrfToken = readCookie("eoks_csrf");
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  }
  return fetch(url, {
    ...options,
    headers,
    credentials: "include",
  });
}

export function clearClientSession() {
  sessionStorage.removeItem("current_user");
  sessionStorage.removeItem("home_route");
  localStorage.removeItem("auth_token");
  localStorage.removeItem("home_route");
}

export function cacheCurrentUser(user) {
  if (!user) {
    clearClientSession();
    return "/login";
  }

  sessionStorage.setItem("current_user", JSON.stringify(user));
  const homeRoute = user.role === "Admin" ? "/app" : "/chat";
  sessionStorage.setItem("home_route", homeRoute);
  localStorage.removeItem("auth_token");
  localStorage.removeItem("home_route");
  return homeRoute;
}

export function getCachedUser() {
  try {
    const raw = sessionStorage.getItem("current_user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function logoutSession() {
  try {
    await apiFetch("/api/logout", { method: "POST" });
  } catch {
    // Clear client state even if the server is already gone.
  }
  clearClientSession();
}
