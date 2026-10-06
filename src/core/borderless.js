const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Borderless windowed play (Settings > Game), without a mod: works for every version and loader.
// The game starts windowed, and a small helper next to it takes the title bar and frame off the game's window and
// stretches it over its monitor. Clicking another monitor then doesn't minimize the game like real fullscreen does.
// The game's fullscreen key (F11 unless rebound) switches between that and a normal window that can be resized: the
// helper catches the key while the game is in front, so the game never goes into its own fullscreen with it.
// The helper is PowerShell running a bit of C# against the Windows API; it checks twice a second, so the game
// remaking or resizing its window (loading screens) is caught too, and it ends with the game.
// Fullscreen switched on in Video Settings is the game's own, and left alone (GLFW keeps that window topmost; ours
// isn't). Win+Shift+Left/Right moves the game to another monitor, and the helper fits it to that one.
const HELPER = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class HojichaBorderless {
  delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int Size; public RECT Monitor, Work; public uint Flags; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr Hwnd; public uint Message; public IntPtr WParam, LParam; public uint Time; public int X, Y, Private; }

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr SetTimer(IntPtr hwnd, IntPtr id, uint ms, IntPtr proc);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

  const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
  const int WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000, WS_MAXIMIZEBOX = 0x00010000;
  const int FRAME = WS_CAPTION | WS_THICKFRAME | WS_MAXIMIZEBOX;
  const int WS_EX_TOPMOST = 0x8;
  const uint SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_NOOWNERZORDER = 0x200;
  const uint WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105, WM_TIMER = 0x113, WM_APP = 0x8000;

  static uint pid, key, thread;
  static bool borderless = true; // what the fullscreen key switches; new game windows get it too
  static bool held;
  static HookProc hookProc; // kept here so the hook isn't garbage collected
  static Dictionary<IntPtr, RECT> windowed = new Dictionary<IntPtr, RECT>(); // where each window was before

  public static void Run(int gamePid, int fullscreenKey) {
    // Window positions in real pixels on every monitor, like the game's own (GLFW is per-monitor DPI aware).
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
    Process game;
    try { game = Process.GetProcessById(gamePid); } catch { return; }
    pid = (uint)gamePid;
    key = (uint)fullscreenKey;
    thread = GetCurrentThreadId();
    hookProc = OnKey;
    SetWindowsHookEx(13, hookProc, GetModuleHandle(null), 0); // WH_KEYBOARD_LL; without it, borderless still works
    SetTimer(IntPtr.Zero, IntPtr.Zero, 500, IntPtr.Zero);
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
      if (msg.Message == WM_APP) {
        borderless = !borderless;
        Apply(GameWindows(), true);
      } else if (msg.Message == WM_TIMER) {
        if (game.HasExited) return;
        Apply(GameWindows(), false);
      }
    }
  }

  // The fullscreen key, while the game is in front: switch here, and keep it from the game.
  static IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0 && (uint)Marshal.ReadInt32(lParam) == key) {
      var message = (uint)wParam;
      var down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
      var up = message == WM_KEYUP || message == WM_SYSKEYUP;
      if (down && IsGameWindow(GetForegroundWindow())) {
        if (!held) PostThreadMessage(thread, WM_APP, IntPtr.Zero, IntPtr.Zero); // not here: hooks must be quick
        held = true;
        return new IntPtr(1);
      }
      if (up && held) {
        held = false;
        return new IntPtr(1);
      }
    }
    return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
  }

  static bool IsGameWindow(IntPtr hwnd) {
    uint owner;
    GetWindowThreadProcessId(hwnd, out owner);
    if (owner != pid || !IsWindowVisible(hwnd)) return false;
    var name = new StringBuilder(64);
    GetClassName(hwnd, name, name.Capacity);
    var cls = name.ToString();
    return cls.StartsWith("GLFW") || cls.StartsWith("LWJGL"); // the game window (1.13+ and older)
  }

  static List<IntPtr> GameWindows() {
    var found = new List<IntPtr>();
    EnumWindows((hwnd, param) => { if (IsGameWindow(hwnd)) found.Add(hwnd); return true; }, IntPtr.Zero);
    foreach (var gone in new List<IntPtr>(windowed.Keys)) if (!IsWindow(gone)) windowed.Remove(gone);
    return found;
  }

  // switched: the player just pressed the key, so a normal window goes back to where it was.
  static void Apply(List<IntPtr> windows, bool switched) {
    foreach (var hwnd in windows) {
      if (IsIconic(hwnd)) continue;
      if ((GetWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0) continue; // the game's own fullscreen
      if (borderless) Fill(hwnd);
      else if (switched) Restore(hwnd);
    }
  }

  static void Fill(IntPtr hwnd) {
    var style = GetWindowLong(hwnd, GWL_STYLE);
    var m = MonitorOf(hwnd);
    RECT r;
    GetWindowRect(hwnd, out r);
    var framed = (style & (WS_CAPTION | WS_THICKFRAME)) != 0;
    if (!framed && Same(r, m)) return;
    if (IsZoomed(hwnd)) { ShowWindow(hwnd, 9); GetWindowRect(hwnd, out r); } // restore: keep its normal size
    if (framed) windowed[hwnd] = r;
    SetWindowLong(hwnd, GWL_STYLE, style & ~FRAME);
    SetWindowPos(hwnd, IntPtr.Zero, m.Left, m.Top, m.Right - m.Left, m.Bottom - m.Top,
      SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_NOOWNERZORDER);
  }

  static void Restore(IntPtr hwnd) {
    var m = MonitorOf(hwnd);
    RECT r;
    // Never seen framed (or as big as the screen): a window of about two thirds of the monitor, in the middle.
    if (!windowed.TryGetValue(hwnd, out r) || r.Right - r.Left >= m.Right - m.Left) {
      int w = (m.Right - m.Left) * 2 / 3, h = (m.Bottom - m.Top) * 2 / 3;
      r = new RECT { Left = m.Left + (m.Right - m.Left - w) / 2, Top = m.Top + (m.Bottom - m.Top - h) / 2 };
      r.Right = r.Left + w;
      r.Bottom = r.Top + h;
    }
    SetWindowLong(hwnd, GWL_STYLE, GetWindowLong(hwnd, GWL_STYLE) | FRAME);
    SetWindowPos(hwnd, IntPtr.Zero, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top,
      SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_NOOWNERZORDER);
  }

  static RECT MonitorOf(IntPtr hwnd) {
    var info = new MONITORINFO { Size = Marshal.SizeOf(typeof(MONITORINFO)) };
    GetMonitorInfo(MonitorFromWindow(hwnd, 2), ref info);
    return info.Monitor;
  }

  static bool Same(RECT a, RECT b) {
    return a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom;
  }
}
`;

const script = (pid, key) => `Add-Type -TypeDefinition @'\n${HELPER}\n'@\n[HojichaBorderless]::Run(${Number(pid)}, ${Number(key)})`;

// Starts the helper for a running game. key is the Windows key code that switches it (see prepare).
// onError gets a line to log if it fails; the game plays on either way.
function watch(pid, key, onError) {
  if (process.platform !== 'win32' || !pid) return null;
  const encoded = Buffer.from(script(pid, key), 'utf16le').toString('base64');
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  helper.stderr.on('data', (chunk) => { errors += chunk; });
  helper.on('error', (err) => onError(err.message));
  helper.on('exit', (code) => {
    if (code) onError(errors.trim().split(/\r?\n/)[0] || `exit code ${code}`);
  });
  return helper;
}

const VK_F1 = 0x70;
const VK_F11 = 0x7a;

// The game's fullscreen key from options.txt, as a Windows key code: key.keyboard.f11 since 1.13, and before that
// an LWJGL 2 key number (87 is F11). Anything unusual, or unbound, stays F11.
function fullscreenKey(text) {
  const bound = /^key_key\.fullscreen:(\S+)/m.exec(text)?.[1];
  if (!bound) return VK_F11;
  let match = /^key\.keyboard\.f(\d+)$/.exec(bound);
  if (match && match[1] >= 1 && match[1] <= 24) return VK_F1 + Number(match[1]) - 1;
  match = /^key\.keyboard\.([a-z0-9])$/.exec(bound);
  if (match) return match[1].toUpperCase().charCodeAt(0);
  const lwjgl = Number(bound);
  if (lwjgl >= 59 && lwjgl <= 68) return VK_F1 + lwjgl - 59; // F1-F10
  if (lwjgl === 88) return VK_F1 + 11; // F12
  return VK_F11;
}

// Before launch, after options.txt is copied in. The game has to start windowed for the helper to have a window to
// work with: its own fullscreen would be kept. Returns the fullscreen key for watch.
function prepare(gameDir) {
  const file = path.join(gameDir, 'options.txt');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return VK_F11; // a first start: the game starts windowed anyway
  }
  const fullscreen = /^fullscreen:true(?=\r?$)/m;
  if (fullscreen.test(text)) fs.writeFileSync(file, text.replace(fullscreen, 'fullscreen:false'));
  return fullscreenKey(text);
}

module.exports = { watch, prepare };
