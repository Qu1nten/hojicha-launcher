const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const instances = require('./instances');

// The sandbox (Settings > Game): the game runs in a Windows AppContainer, the same kind of box Windows uses for Store
// apps. Mods run inside the game, so what they can reach is what the box lets the game reach:
// - the game's own folder, its sandbox folder (temp files, unpacked DLLs) and the synced folders, to change;
// - the game versions, libraries, assets, Java runtimes and stored mod files, to read only;
// - the internet and the local network.
// Everything else on the PC is out of reach: the launcher's accounts and settings, other instances, the user's files,
// browser and Discord data, the Startup folder. The game can't start other programs either (a job object), so a mod
// can't hand its work to PowerShell. That also stops the game opening links and folders for the player.
//
// All instances share one AppContainer; each also gets a capability of its own, and only that one opens the
// instance's folder. Stored mod files (store.js) are hard links shared by every instance, so each gets an explicit
// "deny writing" for the container: a mod can't change them for the other instances.
//
// Two things need an administrator, once (Windows asks): letting the box connect to this PC (core/authProxy.js and
// servers run here), and letting it list the folders above the launcher folder starting at the drive's root.
// Java resolves real paths (every jar and zip it opens as a file system) by listing each folder on the way down.
// It can still never see the names of what is in the folders above, only that the next one exists.
//
// Windows only. The helper is PowerShell running C# against the Windows API, like borderless.js; it's sent over stdin
// as it's longer than a command line may be.

const CONTAINER = 'Hojicha.Game';

const HELPER = `
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class HojichaSandbox {
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr caps, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount, out IntPtr caps, out uint capCount);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string sid, out IntPtr psid);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetFileSecurity(string file, int what, byte[] descriptor);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("FirewallAPI.dll")] static extern uint NetworkIsolationGetAppContainerConfig(out uint count, out IntPtr sids);

  const FileSystemRights LIST = FileSystemRights.ListDirectory | FileSystemRights.ReadAttributes | FileSystemRights.ReadExtendedAttributes | FileSystemRights.Traverse | FileSystemRights.Synchronize;
  const FileSystemRights NO_WRITES = FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
  const InheritanceFlags ALL = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;

  static Exception Fail(string what) { return new Win32Exception(Marshal.GetLastWin32Error(), what + ": " + new Win32Exception(Marshal.GetLastWin32Error()).Message); }

  public static string ContainerSid(string name) {
    IntPtr sid;
    int hr = CreateAppContainerProfile(name, name, name, IntPtr.Zero, 0, out sid);
    if (hr == unchecked((int)0x800700B7)) hr = DeriveAppContainerSidFromAppContainerName(name, out sid); // already exists
    if (hr != 0) throw new Win32Exception(hr);
    return new SecurityIdentifier(sid).Value;
  }

  public static string CapabilitySid(string name) {
    IntPtr groups, caps; uint groupCount, capCount;
    if (!DeriveCapabilitySidsFromName(name, out groups, out groupCount, out caps, out capCount)) throw Fail("DeriveCapabilitySidsFromName");
    return new SecurityIdentifier(Marshal.ReadIntPtr(caps)).Value;
  }

  public static bool LoopbackExempt(string sid) {
    uint count; IntPtr list;
    uint err = NetworkIsolationGetAppContainerConfig(out count, out list);
    if (err != 0) throw new Win32Exception((int)err);
    int stride = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
    for (int i = 0; i < count; i++) if (new SecurityIdentifier(Marshal.ReadIntPtr(list, i * stride)).Value == sid) return true;
    return false;
  }

  static bool Has(FileSystemSecurity acl, SecurityIdentifier who, FileSystemRights rights, AccessControlType type, InheritanceFlags inheritance) {
    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, false, typeof(SecurityIdentifier)))
      if (rule.IdentityReference.Equals(who) && rule.AccessControlType == type && (rule.FileSystemRights & rights) == rights && rule.InheritanceFlags == inheritance) return true;
    return false;
  }

  // Lets sid read (or change) a folder and everything in it, now and later. True when it had to change something:
  // Windows then passes the rule down to what's already inside, which takes a while for a big folder.
  public static bool Grant(string folder, string sid, bool write) {
    var who = new SecurityIdentifier(sid);
    var rights = write ? FileSystemRights.Modify : FileSystemRights.ReadAndExecute;
    var dir = new DirectoryInfo(folder);
    var acl = dir.GetAccessControl(AccessControlSections.Access);
    if (Has(acl, who, rights, AccessControlType.Allow, ALL)) return false;
    acl.AddAccessRule(new FileSystemAccessRule(who, rights, ALL, PropagationFlags.None, AccessControlType.Allow));
    dir.SetAccessControl(acl);
    return true;
  }

  public static bool CanList(string folder, string sid) {
    return Has(new DirectoryInfo(folder).GetAccessControl(AccessControlSections.Access), new SecurityIdentifier(sid), LIST, AccessControlType.Allow, InheritanceFlags.None);
  }

  // Lets sid list this one folder, not what's in it. SetFileSecurity leaves everything below alone (the usual way,
  // SetNamedSecurityInfo, would revisit every file in the folder, for a drive's root every file on the drive).
  public static void GrantList(string folder, string sid) {
    if (CanList(folder, sid)) return;
    var acl = new DirectoryInfo(folder).GetAccessControl(AccessControlSections.Access);
    acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), LIST, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
    if (!SetFileSecurity(folder, 4 /* DACL_SECURITY_INFORMATION */, acl.GetSecurityDescriptorBinaryForm())) throw Fail("SetFileSecurity " + folder);
  }

  // Makes every file below folder read-only for sid, whatever the folders it's linked into allow. Returns how many changed.
  public static int DenyWrites(string folder, string sid) {
    var who = new SecurityIdentifier(sid);
    int changed = 0;
    foreach (string file in Directory.GetFiles(folder, "*", SearchOption.AllDirectories)) {
      var info = new FileInfo(file);
      var acl = info.GetAccessControl(AccessControlSections.Access);
      if (Has(acl, who, NO_WRITES, AccessControlType.Deny, InheritanceFlags.None)) continue;
      acl.AddAccessRule(new FileSystemAccessRule(who, NO_WRITES, AccessControlType.Deny));
      info.SetAccessControl(acl);
      changed++;
    }
    return changed;
  }

  // Quotes one argument the way the C runtime reads it back.
  static string Quote(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\\t', '"' }) < 0) return arg;
    var sb = new StringBuilder("\\"");
    int slashes = 0;
    foreach (char c in arg) {
      if (c == '\\\\') { slashes++; continue; }
      if (c == '"') { sb.Append('\\\\', slashes * 2 + 1); sb.Append('"'); }
      else { sb.Append('\\\\', slashes); sb.Append(c); }
      slashes = 0;
    }
    sb.Append('\\\\', slashes * 2);
    return sb.Append('"').ToString();
  }

  // Runs exe in the container with these capabilities, writing to this process's stdout and stderr, and returns its
  // exit code. It's in a job: it can't start other programs, and it ends when this process ends.
  public static int Run(string containerSid, string[] capabilitySids, string exe, string[] args, string cwd, string[] env) {
    int stride = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
    IntPtr caps = Marshal.AllocHGlobal(stride * Math.Max(1, capabilitySids.Length));
    for (int i = 0; i < capabilitySids.Length; i++) {
      IntPtr sid; if (!ConvertStringSidToSid(capabilitySids[i], out sid)) throw Fail("ConvertStringSidToSid");
      Marshal.StructureToPtr(new SID_AND_ATTRIBUTES { Sid = sid, Attributes = 4 /* SE_GROUP_ENABLED */ }, caps + i * stride, false);
    }
    IntPtr container; if (!ConvertStringSidToSid(containerSid, out container)) throw Fail("ConvertStringSidToSid");
    var security = new SECURITY_CAPABILITIES { AppContainerSid = container, Capabilities = caps, CapabilityCount = (uint)capabilitySids.Length };
    IntPtr securityMem = Marshal.AllocHGlobal(Marshal.SizeOf(security));
    Marshal.StructureToPtr(security, securityMem, false);

    // Only stdout and stderr go to the game; stdin carried this script.
    IntPtr output = GetStdHandle(-11), errors = GetStdHandle(-12);
    var handles = new List<IntPtr> { output };
    if (errors != output) handles.Add(errors);
    IntPtr handleMem = Marshal.AllocHGlobal(IntPtr.Size * handles.Count);
    for (int i = 0; i < handles.Count; i++) {
      SetHandleInformation(handles[i], 1, 1); // HANDLE_FLAG_INHERIT
      Marshal.WriteIntPtr(handleMem, i * IntPtr.Size, handles[i]);
    }

    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
    IntPtr attributes = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw Fail("InitializeProcThreadAttributeList");
    if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20009 /* SECURITY_CAPABILITIES */, securityMem, (IntPtr)Marshal.SizeOf(security), IntPtr.Zero, IntPtr.Zero)) throw Fail("UpdateProcThreadAttribute");
    if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20002 /* HANDLE_LIST */, handleMem, (IntPtr)(IntPtr.Size * handles.Count), IntPtr.Zero, IntPtr.Zero)) throw Fail("UpdateProcThreadAttribute");

    var si = new STARTUPINFOEX();
    si.StartupInfo.cb = Marshal.SizeOf(si);
    si.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES
    si.StartupInfo.hStdOutput = output;
    si.StartupInfo.hStdError = errors;
    si.lpAttributeList = attributes;

    var cmd = new StringBuilder(Quote(exe));
    foreach (string a in args) cmd.Append(' ').Append(Quote(a));
    // An AppContainer process needs LOCALAPPDATA among its variables, or CreateProcess fails.
    IntPtr block = Marshal.StringToHGlobalUni(string.Join("\\0", env) + "\\0\\0");

    var job = CreateJobObject(IntPtr.Zero, null);
    var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    limits.Basic.LimitFlags = 0x2000 /* KILL_ON_JOB_CLOSE */ | 0x8 /* ACTIVE_PROCESS */;
    limits.Basic.ActiveProcessLimit = 1;
    if (!SetInformationJobObject(job, 9 /* ExtendedLimitInformation */, ref limits, Marshal.SizeOf(limits))) throw Fail("SetInformationJobObject");

    PROCESS_INFORMATION pi;
    const uint flags = 0x80000 /* EXTENDED_STARTUPINFO_PRESENT */ | 0x4 /* SUSPENDED */ | 0x400 /* UNICODE_ENVIRONMENT */ | 0x08000000 /* NO_WINDOW */;
    if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, block, cwd, ref si, out pi)) throw Fail("CreateProcess");
    if (!AssignProcessToJobObject(job, pi.hProcess)) { TerminateProcess(pi.hProcess, 1); throw Fail("AssignProcessToJobObject"); }
    Console.Error.WriteLine("HOJICHA-SANDBOX-PID " + pi.dwProcessId);
    Console.Error.Flush();
    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(pi.hProcess, out code);
    return (int)code;
  }
}
`;

const POWERSHELL = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
// Reads the whole script from stdin and runs it as one block (-Command - would run it line by line).
const FROM_STDIN = [...POWERSHELL, '-Command', '& ([scriptblock]::Create([Console]::In.ReadToEnd()))'];

const psString = (s) => `'${String(s).replace(/'/g, "''")}'`;
const psArray = (list) => `@(${list.map(psString).join(', ')})`;
const withHelper = (body) => `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${HELPER}\n'@\n${body}`;

// Runs a helper script and resolves to its stdout; rejects with the error it printed.
function runScript(script) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', FROM_STDIN, { windowsHide: true });
    let out = '';
    let err = '';
    ps.stdout.on('data', (chunk) => { out += chunk; });
    ps.stderr.on('data', (chunk) => { err += chunk; });
    ps.on('error', reject);
    ps.on('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.match(/HOJICHA-SANDBOX-ERROR (.*)/)?.[1] || err.trim().split(/\r?\n/)[0] || `exit code ${code}`));
    });
    ps.stdin.end(script);
  });
}

const fail = (body) => `try {\n${body}\n} catch {\n  [Console]::Error.WriteLine('HOJICHA-SANDBOX-ERROR ' + $_.Exception.Message)\n  [Environment]::Exit(1)\n}`;

// The instance's own folder for what the game would otherwise put in the user's temp and home folders.
const sandboxDir = (id) => path.join(instances.dir(id), 'sandbox');

// Java options for a sandboxed game: temp files, unpacked DLLs and the home folder go to the instance's sandbox
// folder. The version's own launch options put unpacked DLLs next to the game version's, which the game may only
// read (one instance mustn't leave a DLL there that another loads); these come later, so they win.
function jvmArgs(id) {
  const dir = sandboxDir(id);
  const temp = path.join(dir, 'temp');
  return [
    `-Djava.io.tmpdir=${temp}`,
    `-Duser.home=${dir}`,
    `-Djna.tmpdir=${temp}`,
    `-Dorg.lwjgl.system.SharedLibraryExtractPath=${temp}`,
    `-Dio.netty.native.workdir=${temp}`,
  ];
}

// The folders from the drive's root down to (not including) dir.
function foldersAbove(dir) {
  const above = [];
  for (let current = path.dirname(dir); ; current = path.dirname(current)) {
    above.unshift(current);
    if (path.dirname(current) === current) return above;
  }
}

// Gets the box ready for an instance: creates it the first time, gives it the folders above, and tells which of the
// administrator's parts are missing. java is the java.exe the game starts with.
// Resolves to { container, capability, missing: { loopback, folders } }.
async function prepare(instance, java) {
  const gameDir = instances.gameDir(instance.id);
  const dir = sandboxDir(instance.id);
  fs.mkdirSync(path.join(dir, 'temp'), { recursive: true });
  const read = [paths.runtimes, paths.libraries, paths.assets, paths.versions, paths.files];
  // A Java picked in Settings: its whole runtime folder (the one with bin\ in it).
  const runtime = path.dirname(path.dirname(java));
  if (!path.resolve(runtime).toLowerCase().startsWith(path.resolve(paths.root).toLowerCase())) read.push(runtime);
  const libraries = instances.librariesDir(instance.id);
  const shared = fs.existsSync(paths.synced) ? [paths.synced] : [];

  const out = await runScript(withHelper(fail(`
$sid = [HojichaSandbox]::ContainerSid(${psString(CONTAINER)})
$cap = [HojichaSandbox]::CapabilitySid(${psString(`hojicha.instance.${instance.id}`)})
foreach ($d in ${psArray(read.filter((d) => fs.existsSync(d)))}) {
  try { [void][HojichaSandbox]::Grant($d, $sid, $false) } catch { if ($d -ne ${psString(runtime)}) { throw } }
}
foreach ($d in ${psArray(shared)}) { [void][HojichaSandbox]::Grant($d, $sid, $true) }
foreach ($d in ${psArray([gameDir, dir])}) { [void][HojichaSandbox]::Grant($d, $cap, $true) }
${fs.existsSync(libraries) ? `[void][HojichaSandbox]::Grant(${psString(libraries)}, $cap, $false)` : ''}
foreach ($d in ${psArray([paths.root, path.join(paths.root, 'meta'), paths.instances, instances.dir(instance.id)])}) { [HojichaSandbox]::GrantList($d, $sid) }
$missing = @()
foreach ($d in ${psArray(foldersAbove(paths.root))}) {
  if ([HojichaSandbox]::CanList($d, $sid)) { continue }
  try { [HojichaSandbox]::GrantList($d, $sid) } catch { $missing += $d }
}
$denied = [HojichaSandbox]::DenyWrites(${psString(paths.files)}, $sid)
@{ container = $sid; capability = $cap; denied = $denied; missing = @{ loopback = -not [HojichaSandbox]::LoopbackExempt($sid); folders = @($missing) } } | ConvertTo-Json -Compress -Depth 4
`)));
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

// Asks Windows (an administrator prompt) for what prepare found missing. Resolves to false if the player said no.
async function grantMissing(container, missing) {
  const elevated = `$ErrorActionPreference = 'Stop'
Add-Type -Namespace Hojicha -Name Acl -MemberDefinition '[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetFileSecurity(string file, int what, byte[] sd);'
$sid = New-Object System.Security.Principal.SecurityIdentifier(${psString(container)})
${missing.loopback ? `& CheckNetIsolation.exe LoopbackExempt -a ${psString(`-p=${container}`)} | Out-Null` : ''}
foreach ($d in ${psArray(missing.folders)}) {
  $acl = Get-Acl -LiteralPath $d
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'ListDirectory, ReadAttributes, ReadExtendedAttributes, Traverse, Synchronize', 'None', 'None', 'Allow')))
  if (-not [Hojicha.Acl]::SetFileSecurity($d, 4, $acl.GetSecurityDescriptorBinaryForm())) { exit 1 }
}`;
  const encoded = Buffer.from(elevated, 'utf16le').toString('base64');
  const out = await runScript(`try {
  $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList ${psString([...POWERSHELL, '-EncodedCommand', encoded].join(' '))}
  'exit ' + $p.ExitCode
} catch { 'declined' }`);
  return out.trim() !== 'declined';
}

// Everything the game needs set up, asking Windows for the administrator's part when it's missing.
// log(text) gets lines for the Log tab. Resolves to what start() needs.
async function ready(instance, java, log) {
  let state = await prepare(instance, java);
  if (state.denied) log(`> Sandbox: made ${state.denied} stored mod file${state.denied === 1 ? '' : 's'} read-only for the game`);
  const needsAdmin = (s) => s.missing.loopback || s.missing.folders.length > 0;
  if (needsAdmin(state)) {
    log('> Sandbox: Windows asks once to let the sandboxed game reach this PC and list the folders above the launcher folder');
    if (!(await grantMissing(state.container, state.missing))) {
      throw new Error("The sandbox needs Windows' permission once. Play again and choose Yes, or turn the sandbox off in Settings.");
    }
    state = await prepare(instance, java);
    if (needsAdmin(state)) throw new Error("The sandbox couldn't get what it needs from Windows. Turn the sandbox off in Settings to play.");
  }
  return state;
}

// The environment the game gets: just what Windows and Java need, with temp and app data in the instance's sandbox
// folder. (The launcher's own environment may hold things like tokens of other programs.)
function environment(id) {
  const dir = sandboxDir(id);
  const temp = path.join(dir, 'temp');
  const keep = ['SystemRoot', 'SystemDrive', 'windir', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'OS', 'PATHEXT', 'USERNAME'];
  const vars = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const root = process.env.SystemRoot || 'C:\\Windows';
  Object.assign(vars, { TEMP: temp, TMP: temp, APPDATA: dir, PATH: `${root}\\System32;${root}` });
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`);
}

// Starts the game in the box. Returns the helper process: its stdout and stderr are the game's, its exit code the
// game's, and stopping it stops the game. Its stderr starts with "HOJICHA-SANDBOX-PID <pid>", the game's process id.
function start(state, instance, java, args) {
  const ps = spawn('powershell.exe', FROM_STDIN, { cwd: instances.gameDir(instance.id), windowsHide: true });
  ps.stdin.end(withHelper(fail(`
[Environment]::Exit([HojichaSandbox]::Run(${psString(state.container)}, ${psArray(['S-1-15-3-1', 'S-1-15-3-2', 'S-1-15-3-3', state.capability])}, ${psString(java)}, ${psArray(args)}, ${psString(instances.gameDir(instance.id))}, ${psArray(environment(instance.id))}))
`)));
  return ps;
}

const supported = process.platform === 'win32';

module.exports = { supported, jvmArgs, ready, start };
