const themeButtons = document.querySelectorAll("[data-theme-toggle]");
const storageKey = "easyshare-theme";

function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try {
    localStorage.setItem(storageKey, theme);
  } catch (_error) {
    // Theme persistence is optional; the UI can still switch for this session.
  }

  const nextTheme = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${nextTheme} mode`;
  themeButtons.forEach((button) => {
    button.setAttribute("aria-label", label);
    button.title = label;
  });
}

themeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  });
});

applyTheme(currentTheme());
