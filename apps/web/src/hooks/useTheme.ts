/**
 * Theme hook with system preference detection
 *
 * Automatically detects system dark mode preference and applies it.
 * Persists user preference to localStorage if manually changed.
 */

import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'pixel-forge-theme'

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: 'light' | 'dark') {
  const root = document.documentElement
  const body = document.body

  if (theme === 'dark') {
    root.classList.add('dark')
    body.classList.add('dark')
  } else {
    root.classList.remove('dark')
    body.classList.remove('dark')
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'system'
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null
    return stored || 'system'
  })

  // Apply theme on mount and when changed
  useEffect(() => {
    const effectiveTheme = theme === 'system' ? getSystemTheme() : theme
    applyTheme(effectiveTheme)
  }, [theme])

  // Listen for system preference changes
  useEffect(() => {
    if (theme !== 'system') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const handleChange = (e: MediaQueryListEvent) => {
      applyTheme(e.matches ? 'dark' : 'light')
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme)
    if (newTheme === 'system') {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, newTheme)
    }
  }

  const effectiveTheme = theme === 'system' ? getSystemTheme() : theme

  return {
    theme,
    effectiveTheme,
    setTheme,
    isDark: effectiveTheme === 'dark',
  }
}

// Initialize theme immediately (before React hydrates) to prevent flash
export function initializeTheme() {
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null
  const theme = stored || 'system'
  const effectiveTheme = theme === 'system' ? getSystemTheme() : theme
  applyTheme(effectiveTheme)
}
