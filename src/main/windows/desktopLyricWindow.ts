import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'

let desktopLyricWindow: BrowserWindow | undefined

export function getDesktopLyricWindow(): BrowserWindow | undefined {
  return desktopLyricWindow
}

export function createDesktopLyricWindow(): void {
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    desktopLyricWindow.show()
    return
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize
  const windowWidth = 800
  const windowHeight = 150
  const x = Math.round((width - windowWidth) / 2)
  const y = height - windowHeight - 50 // Bottom of screen, slightly above taskbar

  desktopLyricWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false, // Prevent stealing focus
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false // Allow loading local resources if needed
    }
  })

  desktopLyricWindow.setIgnoreMouseEvents(false) // Allow dragging

  desktopLyricWindow.on('ready-to-show', () => {
    desktopLyricWindow?.show()
  })

  desktopLyricWindow.on('closed', () => {
    desktopLyricWindow = undefined
    if (lockTimer) {
      clearInterval(lockTimer)
      lockTimer = null
    }
  })

  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    desktopLyricWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/#/desktop-lyric`)
  } else {
    desktopLyricWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: 'desktop-lyric'
    })
  }
}

export function closeDesktopLyricWindow(): void {
  if (desktopLyricWindow && !desktopLyricWindow.isDestroyed()) {
    desktopLyricWindow.close()
  }
}

let lockTimer: NodeJS.Timeout | null = null

export function setDesktopLyricLocked(locked: boolean): void {
  if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) return

  if (lockTimer) {
    clearInterval(lockTimer)
    lockTimer = null
  }

  if (locked) {
    // When locked, we want the window to be transparent to mouse events by default
    // Only when mouse hovers over it, we might want to capture events (if we implement hover detection via polling)
    
    // BUT, the user requirement is: "Detect locked mode and mouse lost focus for a certain time -> remove hover effect"
    // This implies that the hover effect (which is CSS based) might be getting stuck or we want to force it off.
    // However, the hover effect is purely CSS (:hover). If the mouse is not over the window, :hover should be false.
    // The issue might be that if we set ignoreMouseEvents(true), the window might not receive the mouseleave event properly?
    
    // Actually, `setIgnoreMouseEvents(true, { forward: true })` makes the window transparent to mouse.
    // So the browser inside won't see the mouse anymore, effectively triggering mouseleave (or just not seeing mouse).
    
    // The previous implementation was polling mouse position.
    // If mouse is inside -> setIgnoreMouseEvents(false) -> Window sees mouse -> CSS :hover triggers -> Controls shown.
    // If mouse is outside -> setIgnoreMouseEvents(true) -> Window ignores mouse -> CSS :hover should be false.
    
    // So if the user moves mouse out, `isInside` becomes false.
    // We execute `desktopLyricWindow.setIgnoreMouseEvents(true, { forward: true })`.
    // This should immediately stop the window from seeing the mouse, so :hover should disappear.
    
    // If the user says "remove hover effect after a certain time", maybe they mean:
    // Even if the mouse is INSIDE, if it stops moving (lost focus?) or just stays there?
    // "mouse lost focus" usually means mouse left the window.
    
    // Let's refine the logic to be more robust.
    
    const checkMouse = () => {
      if (!desktopLyricWindow || desktopLyricWindow.isDestroyed()) {
        if (lockTimer) clearInterval(lockTimer)
        lockTimer = null
        return
      }
      
      const point = screen.getCursorScreenPoint()
      const bounds = desktopLyricWindow.getBounds()
      
      const isInside = 
        point.x >= bounds.x && 
        point.x <= bounds.x + bounds.width && 
        point.y >= bounds.y && 
        point.y <= bounds.y + bounds.height
        
      if (isInside) {
        // Mouse is inside.
        // We MUST enable mouse events so the user can interact (click buttons).
        desktopLyricWindow.setIgnoreMouseEvents(false)
        
        // Reset the "mouse left" timer since mouse is inside
        if (unlockTimer) {
          clearTimeout(unlockTimer)
          unlockTimer = null
        }
      } else {
        // Mouse is outside.
        // We want to lock the window (make it transparent to mouse).
        // To support "certain time", we can add a small delay before locking.
        // But for "hover effect removal", immediate locking is actually better because 
        // it forces the browser to lose hover state immediately.
        
        // If we delay locking, the window keeps capturing mouse events (if we were inside previously),
        // so :hover stays active until the delay passes OR the user moves mouse far enough 
        // (but since we are transparent/frameless, sometimes boundary events are tricky).
        
        // Let's stick to the polling interval (200ms).
        // If mouse is out, we lock.
        desktopLyricWindow.setIgnoreMouseEvents(true, { forward: true })
      }
    }

    // Run check immediately
    checkMouse()

    lockTimer = setInterval(checkMouse, 200)
  } else {
    if (unlockTimer) {
      clearTimeout(unlockTimer)
      unlockTimer = null
    }
    // Fully unlock and ensure window captures all mouse events
    desktopLyricWindow.setIgnoreMouseEvents(false)
  }
}

let unlockTimer: NodeJS.Timeout | null = null
