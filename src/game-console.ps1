param([Parameter(Mandatory=$true)][string]$CommandBase64)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class DemoDeskInput {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public MOUSEINPUT mouse; }
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk;public ushort scan;public uint flags;public uint time;public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {public int x,y; public uint data,flags,time;public UIntPtr extra;}
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint n,INPUT[] i,int size);
 public static void Key(ushort vk,bool up) { var i=new INPUT(); i.type=1;i.data.keyboard.vk=vk;i.data.keyboard.flags=up?2u:0u;if(SendInput(1,new[]{i},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("Cannot send game input"); }
 public static void Tap(ushort vk){try{Key(vk,false);}finally{Key(vk,true);}}
}
'@
$game=Get-Process -Name cs2 -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1
if(-not $game){throw 'CS2 window is not available'}
$text=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CommandBase64))
if([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 2048 -or $text.Contains("`n") -or $text.Contains("`r") -or $text.Contains([char]0)){throw 'Invalid game command'}
# Close the console in the submitted command itself. A second toggle after Enter
# can reopen it when another command hides it, and records the console over POV.
$submitted=$text+'; hideconsole'
function Use-Clipboard([scriptblock]$Action) {
 for($attempt=0;$attempt -lt 5;$attempt++) {
  try { return (& $Action) } catch {
   if($attempt -eq 4){throw}
   Start-Sleep -Milliseconds 80
  }
 }
}
$original=Use-Clipboard { [System.Windows.Forms.Clipboard]::GetDataObject() }
$clipboardOwned=$false
try {
 [DemoDeskInput]::ShowWindow($game.MainWindowHandle,9)|Out-Null
 [DemoDeskInput]::SetForegroundWindow($game.MainWindowHandle)|Out-Null
 Start-Sleep -Milliseconds 300
 if([DemoDeskInput]::GetForegroundWindow() -ne $game.MainWindowHandle){throw 'Cannot focus CS2; run OBS and Demo Desk at matching privileges'}
 Use-Clipboard { [System.Windows.Forms.Clipboard]::SetText($submitted) } | Out-Null
 $clipboardOwned=$true
 [DemoDeskInput]::Tap(0xC0)
 Start-Sleep -Milliseconds 250
 [DemoDeskInput]::Key(0x11,$false);[DemoDeskInput]::Tap(0x41);[DemoDeskInput]::Key(0x11,$true)
 [DemoDeskInput]::Key(0x11,$false);[DemoDeskInput]::Tap(0x56);[DemoDeskInput]::Key(0x11,$true)
 Start-Sleep -Milliseconds 100
 [DemoDeskInput]::Tap(0x0D)
 Start-Sleep -Milliseconds 100
} finally {
 # Never leave Ctrl held if a paste fails halfway through.
 try { [DemoDeskInput]::Key(0x11,$true) } catch {}
 if($clipboardOwned) {
  try {
   $stillOwned=Use-Clipboard { [System.Windows.Forms.Clipboard]::ContainsText() -and [System.Windows.Forms.Clipboard]::GetText() -eq $submitted }
   if($stillOwned) {
    if($original){Use-Clipboard { [System.Windows.Forms.Clipboard]::SetDataObject($original,$true) } | Out-Null}
    else {Use-Clipboard { [System.Windows.Forms.Clipboard]::Clear() } | Out-Null}
   }
  } catch {}
 }
}
