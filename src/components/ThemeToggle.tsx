import { useState, useEffect } from "react";
import styles from "./ThemeToggle.module.scss";

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getStoredTheme(): "light" | "dark" | null {
  try {
    const v = localStorage.getItem("theme");
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    setTheme(getStoredTheme() ?? getSystemTheme());
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // localStorage unavailable
    }
  };

  return (
    <a
      href="#"
      className={`contrast ${styles.toggle} ${theme === "dark" ? styles.sun : styles.moon}`}
      onClick={(e) => {
        e.preventDefault();
        toggle();
      }}
      aria-label="Toggle theme"
    />
  );
}
